/**
 * Inbound webhook and long-polling update handler for MAX Bot API events.
 * Handles messages, forwards, replies, and downloads all media types (files, audio, voice, images).
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type {
  MaxUpdate,
  MaxMessage,
  MaxAttachment,
  MaxUser,
  ResolvedMaxAccount,
  InboundImage,
  InboundFile,
  WebhookDeliverMsg,
} from "./types.js";
import { downloadFile } from "./client.js";

const MAX_BODY_BYTES = 10 * 1024 * 1024; // 10 MB

// In-memory deduplication cache: messageId -> timestamp (5 min TTL)
const seenMessages = new Map<string, number>();
const DEDUP_TTL_MS = 5 * 60 * 1000;

function isDuplicate(messageId: string): boolean {
  const now = Date.now();
  // Cleanup expired entries periodically
  if (seenMessages.size > 1000) {
    for (const [id, ts] of seenMessages.entries()) {
      if (now - ts > DEDUP_TTL_MS) seenMessages.delete(id);
    }
  }
  if (seenMessages.has(messageId)) {
    return true;
  }
  seenMessages.set(messageId, now);
  return false;
}

function getInboxDir(account: ResolvedMaxAccount): string {
  const custom = account.inboxDir || process.env.MAX_INBOX_DIR;
  if (custom) return custom;
  return join(process.cwd(), "inbox", "max");
}

function ensureDir(dir: string) {
  try {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  } catch {
    /* ignore */
  }
}

/** Sanitize filename for filesystem */
function safeFilename(name?: string): string | null {
  if (!name || typeof name !== "string") return null;
  return name.replace(/[\/\\:*?"<>|\x00-\x1f]/g, "_").slice(0, 200) || null;
}

/** Guess file extension from MIME type when filename is missing */
function extFromMime(mime?: string | null): string {
  if (!mime) return "";
  const map: Record<string, string> = {
    "application/pdf": ".pdf",
    "application/msword": ".doc",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
    "application/vnd.ms-excel": ".xls",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
    "application/zip": ".zip",
    "application/x-rar-compressed": ".rar",
    "application/x-7z-compressed": ".7z",
    "text/plain": ".txt",
    "text/csv": ".csv",
    "text/html": ".html",
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "video/mp4": ".mp4",
    "video/quicktime": ".mov",
    "audio/mpeg": ".mp3",
    "audio/ogg": ".ogg",
    "audio/ogg; codecs=opus": ".ogg",
    "audio/opus": ".ogg",
    "audio/wav": ".wav",
    "audio/x-wav": ".wav",
    "audio/mp4": ".m4a",
    "audio/aac": ".aac",
  };
  return map[mime.toLowerCase()] || "";
}

function respondJson(res: ServerResponse, code: number, body: Record<string, unknown>) {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function respondOk(res: ServerResponse) {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true }));
}

async function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve) => {
    let data = "";
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        req.destroy();
        resolve(null);
        return;
      }
      data += chunk.toString("utf8");
    });
    req.on("end", () => resolve(data));
    req.on("error", () => resolve(null));
  });
}

function validateSecret(req: IncomingMessage, secret?: string): boolean {
  if (!secret) return true;
  const header = req.headers["x-max-bot-api-secret"];
  return header === secret;
}

/** Detect image MIME type from magic bytes */
function detectMimeType(buf: Buffer): string {
  // PNG: 89 50 4E 47
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return "image/png";
  // JPEG: FF D8 FF
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return "image/jpeg";
  // WebP: RIFF....WEBP
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
      buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return "image/webp";
  // GIF: GIF8
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return "image/gif";
  // OGG: OggS
  if (buf[0] === 0x4F && buf[1] === 0x67 && buf[2] === 0x67 && buf[3] === 0x53) return "audio/ogg";
  return "image/jpeg";
}

export interface WebhookHandlerDeps {
  account: ResolvedMaxAccount;
  deliver: (msg: WebhookDeliverMsg) => Promise<string | null>;
  log?: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
}

function extractMessage(update: MaxUpdate): MaxMessage | null {
  if (update.update_type === "message_created") {
    return update.message ?? null;
  }
  return null;
}

function resolveChatType(msg: MaxMessage): "direct" | "chat" | "channel" | "group" {
  const t = msg.recipient?.chat_type;
  if (t === "dialog") return "direct";
  if (t === "channel") return "channel";
  if (t === "chat" || t === "group") return "group";
  return "chat";
}

function userDisplayName(user?: MaxUser): string | null {
  if (!user || typeof user !== "object") return null;
  return (
    user.name ||
    [user.first_name, user.last_name].filter(Boolean).join(" ").trim() ||
    user.username ||
    (user.user_id != null ? String(user.user_id) : null)
  );
}

/**
 * Unwrap MAX msg.link (forward/reply).
 * Pure forwards arrive with empty body.text/attachments — content lives in link.message.
 */
function unwrapLink(msg: MaxMessage) {
  const link = msg?.link;
  if (!link || typeof link !== "object") {
    return {
      linkType: null,
      isForwarded: false,
      isReply: false,
      originalSenderName: null,
      originalSenderId: null,
      linkedText: "",
      linkedAttachments: [] as MaxAttachment[],
      prefix: "",
    };
  }

  const linkType = String(link.type || "").toLowerCase() || null;
  const isForwarded = linkType === "forward";
  const isReply = linkType === "reply";
  const originalSenderName = userDisplayName(link.sender);
  const originalSenderId = link.sender?.user_id != null ? String(link.sender.user_id) : null;
  const linkedBody = link.message && typeof link.message === "object" ? link.message : null;
  const linkedText = (linkedBody?.text ?? "").toString().trim();
  const linkedAttachments = Array.isArray(linkedBody?.attachments)
    ? (linkedBody.attachments.filter((a) => a && a.type) as MaxAttachment[])
    : [];

  let prefix = "";
  if (isForwarded) {
    const who = originalSenderName || originalSenderId || "неизвестный";
    const idPart = originalSenderId ? ` (id ${originalSenderId})` : "";
    prefix = `[↪ Переслано от ${who}${idPart}]`;
    if (linkedText) {
      prefix += `\n${linkedText}`;
    }
  } else if (isReply) {
    const who = originalSenderName || originalSenderId || "сообщение";
    const quote = linkedText
      ? linkedText.length > 500
        ? linkedText.slice(0, 500) + "…"
        : linkedText
      : linkedAttachments.length > 0
        ? `(вложение: ${linkedAttachments.map((a) => a.type).join(", ")})`
        : "";
    if (quote) {
      prefix = `[↩ Ответ на ${who}: ${quote}]`;
    } else {
      prefix = `[↩ Ответ на ${who}]`;
    }
  }

  return {
    linkType,
    isForwarded,
    isReply,
    originalSenderName,
    originalSenderId,
    linkedText,
    linkedAttachments,
    prefix,
  };
}

async function processAttachments({
  attachments,
  account,
  messageId,
  isForwarded,
  log,
  images,
  files,
}: {
  attachments: MaxAttachment[];
  account: ResolvedMaxAccount;
  messageId: string;
  isForwarded?: boolean;
  log?: WebhookHandlerDeps["log"];
  images: InboundImage[];
  files: InboundFile[];
}) {
  const inboxDir = getInboxDir(account);
  ensureDir(inboxDir);

  const imageAttachments = attachments.filter((a) => a.type === "image");
  const fileAttachments = attachments.filter(
    (a) => a.type !== "image" && a.type !== "inline_keyboard" && a.type !== "share",
  );

  // 1. Process images for inline base64 vision
  for (const att of imageAttachments) {
    const url = att.payload?.url;
    if (!url) continue;
    const buf = await downloadFile(account.token, url);
    if (!buf) continue;
    const mimeType = detectMimeType(buf);
    images.push({ data: buf.toString("base64"), mimeType });
  }

  // 2. Process documents, audio, voice, video to inbox
  for (let i = 0; i < fileAttachments.length; i++) {
    const att = fileAttachments[i];
    const url = att.payload?.url;
    const token = att.payload?.token;
    if (!url && !token) {
      log?.warn(`[openclaw-max] Attachment type=${att.type} has no url/token — skipping`);
      continue;
    }

    let buf: Buffer | null = null;
    if (url) {
      buf = await downloadFile(account.token, url);
    }
    if (!buf && token) {
      const endpoints = [
        `https://platform-api2.max.ru/attachments/${token}`,
        `https://platform-api2.max.ru/files/${token}`,
      ];
      for (const ep of endpoints) {
        buf = await downloadFile(account.token, ep);
        if (buf) break;
      }
    }

    if (!buf) {
      log?.warn(`[openclaw-max] Failed to download attachment type=${att.type}`);
      continue;
    }

    const declaredName =
      safeFilename(att.filename) ||
      safeFilename(att.payload?.filename) ||
      safeFilename(att.payload?.name);
    const mime = att.mime_type || att.payload?.mime_type || att.payload?.mime || null;
    const ext =
      declaredName && /\.[a-zA-Z0-9]{1,8}$/.test(declaredName)
        ? ""
        : extFromMime(mime) ||
          (att.type === "audio" ? ".ogg" : att.type === "video" ? ".mp4" : "");

    const fwdPrefix = isForwarded ? "fwd_" : "";
    const filename = fwdPrefix + (declaredName || `max_${messageId}_${i}${ext}`);
    const filePath = join(inboxDir, filename);

    let finalPath = filePath;
    let n = 1;
    while (existsSync(finalPath)) {
      const dot = filename.lastIndexOf(".");
      const stem = dot >= 0 ? filename.slice(0, dot) : filename;
      const ext2 = dot >= 0 ? filename.slice(dot) : "";
      finalPath = join(inboxDir, `${stem}_${n}${ext2}`);
      n++;
    }

    try {
      writeFileSync(finalPath, buf);
      files.push({
        path: finalPath,
        filename: finalPath.split(/[/\\]/).pop() || filename,
        mimeType: mime || (att.type === "audio" ? "audio/ogg" : "application/octet-stream"),
        size: buf.length,
        attachmentType: att.type,
        isForwarded: !!isForwarded,
      });
      log?.info?.(
        `[openclaw-max] Saved attachment: ${finalPath} (${buf.length} bytes, ${mime || att.type})`,
      );
    } catch (err) {
      log?.error?.(
        `[openclaw-max] Failed to save attachment to ${finalPath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

export function createWebhookHandler(deps: WebhookHandlerDeps) {
  const { account, deliver, log } = deps;

  return async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== "POST") {
      respondJson(res, 405, { error: "Method not allowed" });
      return;
    }

    if (!validateSecret(req, account.webhookSecret)) {
      log?.warn?.("[openclaw-max] Webhook secret mismatch — rejecting request");
      respondJson(res, 401, { error: "Invalid secret" });
      return;
    }

    const body = await readBody(req);
    if (body === null) {
      respondJson(res, 400, { error: "Invalid body" });
      return;
    }

    let update: MaxUpdate;
    try {
      update = JSON.parse(body) as MaxUpdate;
    } catch {
      respondJson(res, 400, { error: "Invalid JSON" });
      return;
    }

    // ACK immediately — MAX requires HTTP 200 within 30 seconds
    respondOk(res);

    await handleUpdate(update, account, deliver, log);
  };
}

export async function handleUpdate(
  update: MaxUpdate,
  account: ResolvedMaxAccount,
  deliver: WebhookHandlerDeps["deliver"],
  log?: WebhookHandlerDeps["log"],
) {
  const msg = extractMessage(update);
  if (!msg) return;

  const messageId = msg.body?.mid ?? `max-${msg.timestamp}`;
  if (isDuplicate(messageId)) {
    log?.info?.(`[openclaw-max] Skipping duplicate message ${messageId}`);
    return;
  }

  const linkInfo = unwrapLink(msg);
  const bodyText = (msg.body?.text ?? "").toString().trim();
  const bodyAttachments = (msg.body?.attachments ?? []).filter((a) => a && a.type) as MaxAttachment[];

  // Merge body attachments + linked attachments (dedupe by token/url)
  const seen = new Set<string>();
  const allAttachments: MaxAttachment[] = [];
  for (const a of [...bodyAttachments, ...linkInfo.linkedAttachments]) {
    const key =
      a.payload?.token ||
      a.payload?.url ||
      a.filename ||
      JSON.stringify(a).slice(0, 80);
    if (seen.has(key)) continue;
    seen.add(key);
    allAttachments.push(a);
  }

  let text = bodyText;
  if (linkInfo.prefix) {
    text = text ? `${linkInfo.prefix}\n${text}` : linkInfo.prefix;
  }

  // Handle share attachments: extract URL/title into text
  for (const a of allAttachments.filter((x) => x.type === "share")) {
    const title = a.payload?.title || a.title || "";
    const url = a.payload?.url || "";
    const desc = a.payload?.description || "";
    const shareLine = [title, url, desc].filter(Boolean).join(" — ");
    if (shareLine) {
      text = text ? `${text}\n[🔗 ${shareLine}]` : `[🔗 ${shareLine}]`;
    }
  }

  if (!text && allAttachments.length === 0) return;

  const sender = msg.sender;
  if (!sender) return;
  if (sender.is_bot) return;

  const chatType = resolveChatType(msg);
  const dialogChatId = String(msg.recipient?.chat_id ?? sender.user_id);
  const chatId = chatType === "direct" ? String(sender.user_id) : dialogChatId;

  const senderId = String(sender.user_id);
  const senderName = sender.name || sender.username || senderId;

  // DM Policy
  if (chatType === "direct") {
    const allowed = checkDmPolicy(senderId, account);
    if (!allowed) {
      log?.warn?.(`[openclaw-max] DM from ${senderName} (${senderId}) rejected by policy`);
      return;
    }
  }

  const linkNote = linkInfo.isForwarded
    ? ` [FORWARD from ${linkInfo.originalSenderName || linkInfo.originalSenderId || "?"}]`
    : linkInfo.isReply
      ? ` [REPLY to ${linkInfo.originalSenderName || linkInfo.originalSenderId || "?"}]`
      : "";
  log?.info?.(
    `[openclaw-max] Message from ${senderName} (${senderId})${linkNote}: ${text.slice(0, 120)}`,
  );

  const images: InboundImage[] = [];
  const files: InboundFile[] = [];

  await processAttachments({
    attachments: allAttachments,
    account,
    messageId,
    isForwarded: linkInfo.isForwarded,
    log,
    images,
    files,
  });

  try {
    await deliver({
      text,
      senderId,
      senderName,
      chatId,
      dialogChatId,
      chatType,
      messageId,
      accountId: account.accountId,
      images: images.length > 0 ? images : undefined,
      files: files.length > 0 ? files : undefined,
      isForwarded: linkInfo.isForwarded,
      isReply: linkInfo.isReply,
      linkType: linkInfo.linkType,
      originalSenderName: linkInfo.originalSenderName,
      originalSenderId: linkInfo.originalSenderId,
    });
  } catch (err) {
    log?.error?.(
      `[openclaw-max] Deliver error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function checkDmPolicy(userId: string, account: ResolvedMaxAccount): boolean {
  const policy = account.dmPolicy;
  if (policy === "disabled") return false;
  if (policy === "open") return true;
  if (policy === "allowlist" || policy === "pairing") {
    return account.allowFrom.includes(userId) || account.allowFrom.includes(`max:${userId}`);
  }
  return false;
}
