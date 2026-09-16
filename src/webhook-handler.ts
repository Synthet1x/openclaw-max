import { DatabaseSync } from "node:sqlite";
import { homedir } from "node:os";
/**
 * Inbound webhook and long-polling update handler for MAX Bot API events.
 * Handles messages, forwards, replies, and downloads all media types (files, audio, voice, images).
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
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
import { downloadFile, sendMessageWithKeyboard } from "./client.js";

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
  return join(homedir(), ".openclaw", "media", "inbound");
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

  const imageAttachments = attachments.filter((a) => a.type === "image" || a.type === "photo");
  const fileAttachments = attachments.filter(
    (a) => a.type !== "image" && a.type !== "photo" && a.type !== "inline_keyboard" && a.type !== "share",
  );

  // 1. Process images for inline base64 vision AND save to inbox
  for (let i = 0; i < imageAttachments.length; i++) {
    const att = imageAttachments[i];
    const url = att.payload?.url;
    const token = att.payload?.token;
    if (!url && !token) continue;

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
    if (!buf) continue;
    const mimeType = detectMimeType(buf);
    images.push({ data: buf.toString("base64"), mimeType });

    // Also save image to inbox so it is accessible as a local file and surfaced in message attachments
    const declaredName =
      safeFilename(att.filename) ||
      safeFilename(att.payload?.filename) ||
      safeFilename(att.payload?.name);
    const ext =
      declaredName && /\.[a-zA-Z0-9]{1,8}$/.test(declaredName)
        ? ""
        : extFromMime(mimeType) || ".jpg";

    const fwdPrefix = isForwarded ? "fwd_" : "";
    const filename = fwdPrefix + (declaredName || `max_image_${messageId}_${i}${ext}`);
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
        mimeType: mimeType || "image/jpeg",
        size: buf.length,
        attachmentType: "image",
        isForwarded: !!isForwarded,
      });
      log?.info?.(
        `[openclaw-max] Saved image attachment: ${finalPath} (${buf.length} bytes, ${mimeType})`,
      );
    } catch (err) {
      log?.error?.(
        `[openclaw-max] Failed to save image to ${finalPath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
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
    let mime = att.mime_type || att.payload?.mime_type || att.payload?.mime || null;
    const isAudioType = att.type === "audio" || att.type === "voice";
    if (isAudioType && (!mime || mime === "application/octet-stream")) {
      mime = "audio/ogg";
    }

    const ext =
      declaredName && /\.[a-zA-Z0-9]{1,8}$/.test(declaredName)
        ? ""
        : extFromMime(mime) ||
          (isAudioType ? ".ogg" : att.type === "video" ? ".mp4" : "");

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
        mimeType: mime || (isAudioType ? "audio/ogg" : "application/octet-stream"),
        size: buf.length,
        attachmentType: isAudioType ? "audio" : att.type,
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


// Interactive menu definitions for commands without arguments (analogous to Telegram native menus)

/**
 * Returns supported thinking levels based on provider and model name.
 * Exactly mirrors OpenClaw thinking profiles:
 * - Gemini / Google: default, off, minimal, low, medium, high, adaptive
 * - Grok (xAI 4.6): default, off, low, medium, high, xhigh
 * - Grok 4.3 / 4.5: default, off, minimal, low, medium, high
 * - Claude / Anthropic: default, off, low, medium, high
 * - DeepSeek / Qwen / others: default, off, low, medium, high, max
 */
function resolveModelThinkingLevels(provider?: string | null, model?: string | null): string[] {
  const p = (provider || "").toLowerCase();
  const m = (model || "").toLowerCase();

  // Gemini / Google Antigravity
  if (p.includes("google") || p.includes("gemini") || m.includes("gemini")) {
    return ["default", "off", "minimal", "low", "medium", "high", "adaptive"];
  }

  // xAI Grok
  if (p.includes("xai") || m.includes("grok")) {
    if (m.includes("4.6") || m.includes("latest")) {
      return ["default", "off", "low", "medium", "high", "xhigh"];
    }
    return ["default", "off", "minimal", "low", "medium", "high"];
  }

  // Claude / Anthropic
  if (p.includes("anthropic") || m.includes("claude")) {
    return ["default", "off", "low", "medium", "high"];
  }

  // Default fallback for reasoning models
  return ["default", "off", "low", "medium", "high", "max"];
}

/**
 * Resolves the currently active model and thinking level for a chat session from OpenClaw sqlite store.
 */
function getSessionModelInfo(agentId: string, peerId: string): { provider: string; model: string; thinkingLevel?: string } {
  const home = homedir();
  let defaultProvider = "google-antigravity";
  let defaultModel = "gemini-3.8-flash-tiered";
  let defaultThinking = "high";

  // 1. Read default config
  try {
    const cfgPath = join(home, ".openclaw", "openclaw.json");
    if (existsSync(cfgPath)) {
      const cfg = JSON.parse(readFileSync(cfgPath, "utf-8"));
      const agentEntry = cfg?.agents?.entries?.[agentId];
      const primary = agentEntry?.model?.primary || cfg?.agents?.defaults?.model?.primary;
      if (primary && primary.includes("/")) {
        const parts = primary.split("/");
        defaultProvider = parts[0];
        defaultModel = parts.slice(1).join("/");
      }
      defaultThinking = agentEntry?.thinkingDefault || cfg?.agents?.defaults?.thinkingDefault || "high";
    }
  } catch {}

  // 2. Read session entry from sqlite
  try {
    const dbPath = join(home, ".openclaw", "agents", agentId, "agent", "openclaw-agent.sqlite");
    if (existsSync(dbPath)) {
      const db = new DatabaseSync(dbPath, { readOnly: true });
      const stmt = db.prepare(
        "SELECT entry_json FROM session_nodes WHERE session_key LIKE ? OR session_key LIKE ? ORDER BY updated_at DESC LIMIT 1"
      );
      const row = stmt.get(`%max%${peerId}%`, `%${peerId}%`) as { entry_json?: string } | undefined;
      db.close();

      if (row?.entry_json) {
        const data = JSON.parse(row.entry_json);
        const model = data.modelOverride || data.model || defaultModel;
        const provider = data.providerOverride || data.modelProvider || defaultProvider;
        const thinkingLevel = data.thinkingLevel || defaultThinking;
        return { provider, model, thinkingLevel };
      }
    }
  } catch {}

  return { provider: defaultProvider, model: defaultModel, thinkingLevel: defaultThinking };
}

const INTERACTIVE_COMMAND_MENUS: Record<string, { title: string; buttons: Array<Array<{ type: "callback"; text: string; payload: string }>> }> = {
  "/reasoning": {
    title: "Настройка показа хода мыслей (reasoning):",
    buttons: [
      [
        { type: "callback", text: "Вкл (on)", payload: "/reasoning on" },
        { type: "callback", text: "Выкл (off)", payload: "/reasoning off" },
      ],
      [
        { type: "callback", text: "Потоково (stream)", payload: "/reasoning stream" },
      ]
    ],
  },
  "/fast": {
    title: "Режим Fast Mode:",
    buttons: [
      [
        { type: "callback", text: "Вкл (on)", payload: "/fast on" },
        { type: "callback", text: "Выкл (off)", payload: "/fast off" },
      ],
      [
        { type: "callback", text: "Авто (auto)", payload: "/fast auto" },
        { type: "callback", text: "По умолчанию", payload: "/fast default" },
      ],
      [
        { type: "callback", text: "Статус", payload: "/fast status" },
      ]
    ],
  },
  "/verbose": {
    title: "Подробный режим вывода (verbose):",
    buttons: [
      [
        { type: "callback", text: "Off", payload: "/verbose off" },
        { type: "callback", text: "On", payload: "/verbose on" },
        { type: "callback", text: "Full", payload: "/verbose full" },
      ]
    ],
  },
  "/usage": {
    title: "Отображение расхода токенов (usage footer):",
    buttons: [
      [
        { type: "callback", text: "Off", payload: "/usage off" },
        { type: "callback", text: "Tokens", payload: "/usage tokens" },
      ],
      [
        { type: "callback", text: "Full", payload: "/usage full" },
        { type: "callback", text: "Cost", payload: "/usage cost" },
      ]
    ],
  },
  "/tts": {
    title: "Управление озвучкой (TTS):",
    buttons: [
      [
        { type: "callback", text: "Вкл (on)", payload: "/tts on" },
        { type: "callback", text: "Выкл (off)", payload: "/tts off" },
      ],
      [
        { type: "callback", text: "Статус", payload: "/tts status" },
      ]
    ],
  },
  "/elevated": {
    title: "Режим повышенных привилегий (elevated):",
    buttons: [
      [
        { type: "callback", text: "Off", payload: "/elevated off" },
        { type: "callback", text: "On", payload: "/elevated on" },
      ],
      [
        { type: "callback", text: "Ask", payload: "/elevated ask" },
        { type: "callback", text: "Full", payload: "/elevated full" },
      ]
    ],
  },
  "/tools": {
    title: "Режим отображения списка инструментов:",
    buttons: [
      [
        { type: "callback", text: "Компактный (compact)", payload: "/tools compact" },
        { type: "callback", text: "Подробный (verbose)", payload: "/tools verbose" },
      ]
    ],
  },
};

export async function handleUpdate(
  update: MaxUpdate,
  account: ResolvedMaxAccount,
  deliver: WebhookHandlerDeps["deliver"],
  log?: WebhookHandlerDeps["log"],
) {
  // Handle interactive inline keyboard button clicks (callback query)
  if (update.update_type === "message_callback" || (update as any).callback) {
    const cb = (update as any).callback || (update as any);
    const callbackId = cb.callback_id || cb.id;
    const payload = cb.payload || "";
    const sender = cb.user;
    if (!sender) return;

    log?.info?.(`[openclaw-max] Button clicked by ${sender.name || sender.user_id}: ${payload}`);

    // Acknowledge the callback immediately so the button stops loading spinner
    if (callbackId) {
      import("./client.js").then(({ answerOnCallback }) => {
        answerOnCallback(account.token, callbackId).catch(() => {});
      });
    }

    if (!payload) return;

    // Dispatch the payload as a command / user message from that user
    const senderId = String(sender.user_id);
    const senderName = sender.name || sender.username || senderId;
    const dialogChatId = String(cb.message?.recipient?.chat_id ?? sender.user_id);
    const chatType = cb.message?.recipient?.chat_type === "chat" ? "group" : "direct";
    const chatId = chatType === "direct" ? senderId : dialogChatId;

    try {
      await deliver({
        text: payload,
        senderId,
        senderName,
        chatId,
        dialogChatId,
        chatType,
        messageId: `cb-${callbackId || Date.now()}`,
        accountId: account.accountId,
      });
    } catch (err) {
      log?.error?.(`[openclaw-max] Error delivering callback payload: ${err instanceof Error ? err.message : String(err)}`);
    }
    return;
  }

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

  // Interactive command menus (like in Telegram for /reasoning, /think, /fast, /verbose, /usage, /tts, etc.)
  const cleanCmd = text.trim().toLowerCase();

  // Dynamic /think menu based on current session model
  if (cleanCmd === "/think" && allAttachments.length === 0) {
    try {
      const info = getSessionModelInfo((account as any).agentId || "orli", senderId);
      const levels = resolveModelThinkingLevels(info.provider, info.model);
      const cur = info.thinkingLevel || "default";

      const rows: Array<Array<{ type: "callback"; text: string; payload: string }>> = [];
      let row: Array<{ type: "callback"; text: string; payload: string }> = [];

      for (const lvl of levels) {
        const isCurrent = cur.toLowerCase() === lvl.toLowerCase();
        const label = lvl.charAt(0).toUpperCase() + lvl.slice(1);
        row.push({
          type: "callback",
          text: isCurrent ? `${label} ✓` : label,
          payload: `/think ${lvl}`,
        });
        if (row.length === 2) {
          rows.push(row);
          row = [];
        }
      }
      if (row.length > 0) rows.push(row);

      const title = `Current thinking level: ${cur}.\nМодель: ${info.model} (${info.provider})\nВыберите уровень размышлений:`;
      const recipient = chatType === "direct" ? { user_id: Number(senderId) } : { chat_id: Number(dialogChatId) };
      await sendMessageWithKeyboard(account.token, recipient, title, rows);
      return;
    } catch (err) {
      log?.error?.(`[openclaw-max] Failed to send dynamic think menu: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const menuConfig = INTERACTIVE_COMMAND_MENUS[cleanCmd];
  if (menuConfig && allAttachments.length === 0) {
    log?.info?.(`[openclaw-max] Showing interactive menu for ${cleanCmd} to chat ${chatId}`);
    try {
      const recipient = chatType === "direct" ? { user_id: Number(senderId) } : { chat_id: Number(dialogChatId) };
      await sendMessageWithKeyboard(account.token, recipient, menuConfig.title, menuConfig.buttons);
      return;
    } catch (err) {
      log?.error?.(`[openclaw-max] Failed to send interactive menu: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

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
