/**
 * MAX Bot API HTTP client.
 * https://platform-api2.max.ru
 *
 * The MAX Bot API moved off platform-api.max.ru (decommissioned 2026-07-19) to
 * platform-api2.max.ru, whose TLS chain is anchored on the Russian Trusted Root
 * CA (Минцифры) — absent from Node's bundled CA store. We therefore route every
 * request through a dedicated undici dispatcher that trusts that CA in addition
 * to the platform defaults, and optionally through an HTTP(S) proxy.
 */

import tls from "node:tls";
// Import fetch from undici too (not Node's global): the global fetch uses Node's
// built-in undici copy, which rejects a dispatcher built by this (possibly
// different) undici version with UND_ERR_INVALID_ARG. Same-package fetch+Agent
// are guaranteed compatible.
import { fetch, FormData, Agent, ProxyAgent, type Dispatcher } from "undici";
import type { MaxUpdatesResponse } from "./types.js";
import { RUSSIAN_TRUSTED_CA } from "./max-ca.js";

const MAX_API = "https://platform-api2.max.ru";
const REQUEST_TIMEOUT_MS = 30_000;
const LONG_POLL_TIMEOUT_SEC = 30;

// ─── TLS / proxy transport ────────────────────────────────────────────────────

// Trust the Минцифры CA on top of the default root store.
const MAX_CA: string[] = [RUSSIAN_TRUSTED_CA, ...tls.rootCertificates];

let dispatcher: Dispatcher = new Agent({ connect: { ca: MAX_CA } });

/**
 * (Re)configure the HTTP transport for MAX API calls.
 * Call once at channel startup. When `httpProxy` is set, requests are tunnelled
 * through it (fixes GitHub issue #1); the Минцифры CA is trusted either way.
 */
export function configureMaxTransport(opts?: { httpProxy?: string }): void {
  const proxy = opts?.httpProxy?.trim();
  dispatcher = proxy
    ? new ProxyAgent({ uri: proxy, connect: { ca: MAX_CA } })
    : new Agent({ connect: { ca: MAX_CA } });
}

// ─── Low-level fetch helper ───────────────────────────────────────────────────

async function maxRequest<T>(
  token: string,
  method: "GET" | "POST" | "DELETE" | "PUT" | "PATCH",
  path: string,
  params?: Record<string, string | number>,
  body?: unknown,
): Promise<T> {
  const url = new URL(`${MAX_API}${path}`);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, String(v));
    }
  }

  const headers: Record<string, string> = {
    Authorization: token,
  };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(url.toString(), {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
      dispatcher,
    });

    const text = await res.text();
    if (!res.ok) {
      throw new Error(`MAX API ${method} ${path} → ${res.status}: ${text}`);
    }
    return JSON.parse(text) as T;
  } finally {
    clearTimeout(timer);
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Send a text message to a MAX user (DM).
 * Returns the message_id for later editing (streaming), or null on failure.
 */
export async function sendDm(token: string, userId: number, text: string): Promise<string | null> {
  try {
    const res = await maxRequest<{ message?: { body?: { mid?: string } } }>(
      token, "POST", "/messages", { user_id: userId }, { text, format: "markdown" }
    );
    return res?.message?.body?.mid ?? null;
  } catch (err) {
    console.warn(`[openclaw-max] sendDm error: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

/**
 * Send a text message to a MAX chat.
 * Returns the message_id for later editing (streaming), or null on failure.
 */
export async function sendToChat(token: string, chatId: number, text: string): Promise<string | null> {
  try {
    const res = await maxRequest<{ message?: { body?: { mid?: string } } }>(
      token, "POST", "/messages", { chat_id: chatId }, { text, format: "markdown" }
    );
    return res?.message?.body?.mid ?? null;
  } catch (err) {
    console.warn(`[openclaw-max] sendToChat error: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

/**
 * Edit an existing message (for streaming updates).
 * PUT /messages?message_id={id}
 */
export async function editMessage(
  token: string,
  messageId: string,
  text: string,
  attachments?: any[],
): Promise<boolean> {
  try {
    const body: Record<string, unknown> = { text, format: "markdown" };
    if (attachments && attachments.length > 0) {
      body.attachments = attachments;
    }
    await maxRequest(token, "PUT", "/messages", { message_id: messageId }, body);
    return true;
  } catch (err) {
    console.warn(`[openclaw-max] editMessage error: ${err instanceof Error ? err.message : err}`);
    return false;
  }
}

/**
 * Send typing indicator to a chat.
 * action: "typing_on" | "typing_off" | "sending_photo" | "sending_video" | "sending_audio"
 */
export async function sendTypingAction(
  token: string,
  chatId: number,
  action: "typing_on" | "typing_off" = "typing_on",
): Promise<void> {
  try {
    await maxRequest(token, "POST", `/chats/${chatId}/actions`, {}, { action });
  } catch {
    // Typing is best-effort, never throw
  }
}

/**
 * Long-poll for new updates.
 * Returns updates + next marker.
 */
export async function getUpdates(
  token: string,
  marker?: number | null,
  timeoutSec = LONG_POLL_TIMEOUT_SEC,
  signal?: AbortSignal,
): Promise<MaxUpdatesResponse> {
  const params: Record<string, string | number> = { timeout: timeoutSec, limit: 100 };
  if (marker != null) params.marker = marker;

  const url = new URL(`${MAX_API}/updates`);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, String(v));
  }

  // Combine external abort signal with our timeout
  const combinedSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout((timeoutSec + 10) * 1000)])
    : AbortSignal.timeout((timeoutSec + 10) * 1000);

  try {
    const res = await fetch(url.toString(), {
      method: "GET",
      headers: { Authorization: token },
      signal: combinedSignal,
      dispatcher,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`GET /updates → ${res.status}: ${text}`);
    }
    return (await res.json()) as MaxUpdatesResponse;
  } catch (err) {
    if ((err as Error)?.name === "AbortError" || (err as Error)?.name === "TimeoutError") {
      return { updates: [], marker };
    }
    throw err;
  }
}

/**
 * Register a webhook URL with MAX.
 */
export async function subscribeWebhook(
  token: string,
  webhookUrl: string,
  secret?: string,
): Promise<void> {
  const body: Record<string, unknown> = {
    url: webhookUrl,
    update_types: ["message_created", "bot_started", "message_callback"],
  };
  if (secret) body.secret = secret;

  await maxRequest(token, "POST", "/subscriptions", undefined, body);
}

/**
 * Remove active webhook subscription (switches back to long polling).
 */
export async function deleteWebhook(token: string): Promise<void> {
  await maxRequest(token, "DELETE", "/subscriptions", undefined, {});
}

/**
 * Get bot info (used to verify token on startup).
 */
export async function getBotInfo(token: string): Promise<{ name: string; username: string }> {
  return maxRequest(token, "GET", "/me");
}

/**
 * Скачать файл по URL.
 * Защищено от утечки токена (Authorization отправляется только на *.max.ru)
 * и от SSRF-атак на локальную сеть.
 */
export async function downloadFile(token: string, url: string): Promise<Buffer | null> {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();

    // Prevent SSRF: block loopback and private LAN addresses
    if (
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "::1" ||
      host.startsWith("192.168.") ||
      host.startsWith("10.") ||
      host.endsWith(".local") ||
      host.endsWith(".internal")
    ) {
      return null;
    }
    if (host.startsWith("172.")) {
      const parts = host.split(".");
      const second = parseInt(parts[1], 10);
      if (!isNaN(second) && second >= 16 && second <= 31) return null;
    }

    // Send Bot Token ONLY to official MAX domains to prevent exfiltration
    const isMax = host === "max.ru" || host.endsWith(".max.ru");
    const headers: Record<string, string> = {};
    if (isMax) {
      headers["Authorization"] = token;
    }

    const res = await fetch(url, {
      headers,
      dispatcher,
    });
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch {
    return null;
  }
}

/**
 * Получить URL для загрузки медиафайла.
 * type передаётся как query param.
 */
export async function getUploadUrl(token: string, type: "image" | "video" | "audio" | "file"): Promise<string | null> {
  try {
    const res = await maxRequest<{ url: string }>(token, "POST", "/uploads", { type });
    return res?.url ?? null;
  } catch {
    return null;
  }
}

/**
 * Загрузить файл по upload URL (multipart/form-data).
 * Возвращает { token } из ответа или null.
 */
export async function uploadFile(uploadUrl: string, buffer: Buffer, mimeType: string, filename: string): Promise<{ token: string } | null> {
  try {
    const form = new FormData();
    form.append("data", new Blob([new Uint8Array(buffer)], { type: mimeType }), filename);
    const res = await fetch(uploadUrl, {
      method: "POST",
      body: form,
      dispatcher,
    });
    if (!res.ok) return null;
    const json = await res.json() as Record<string, unknown>;
    // Direct token at top level
    if (typeof json.token === "string") return { token: json.token };
    // Photos response: { photos: { <key>: { token: string } } }
    if (json.photos && typeof json.photos === "object") {
      const firstVal = Object.values(json.photos as Record<string, unknown>)[0] as Record<string, unknown> | undefined;
      if (firstVal && typeof firstVal.token === "string") return { token: firstVal.token };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Отправить сообщение с вложением (image, video, audio, file) в DM или чат.
 */
export async function sendMessageWithAttachment(
  token: string,
  target: { user_id?: number; chat_id?: number },
  text: string,
  attachmentType: "image" | "video" | "audio" | "file",
  attachmentToken: string
): Promise<string | null> {
  try {
    const body: Record<string, unknown> = {
      attachments: [{ type: attachmentType, payload: { token: attachmentToken } }],
    };
    if (text) body.text = text;
    const query: Record<string, string | number> = {};
    if (target.user_id != null) query.user_id = target.user_id;
    if (target.chat_id != null) query.chat_id = target.chat_id;
    const res = await maxRequest<{ message?: { body?: { mid?: string } } }>(
      token, "POST", "/messages", Object.keys(query).length > 0 ? query : undefined, body
    );
    return res?.message?.body?.mid ?? null;
  } catch (err) {
    console.warn(`[openclaw-max] sendMessageWithAttachment (${attachmentType}) error: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

/**
 * Отправить сообщение с изображением в DM.
 */
export async function sendDmWithImage(token: string, userId: number, text: string, imageToken: string): Promise<string | null> {
  return sendMessageWithAttachment(token, { user_id: userId }, text, "image", imageToken);
}

/**
 * Отправить сообщение с изображением в чат.
 */
export async function sendToChatWithImage(token: string, chatId: number, text: string, imageToken: string): Promise<string | null> {
  return sendMessageWithAttachment(token, { chat_id: chatId }, text, "image", imageToken);
}

/**
 * Send an answer to a callback query from an inline keyboard button.
 */
export async function answerOnCallback(
  token: string,
  callbackId: string,
  notification?: string,
): Promise<boolean> {
  try {
    await maxRequest(
      token,
      "POST",
      "/answers",
      { callback_id: callbackId },
      notification ? { notification } : {},
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Send a message with an inline keyboard attached.
 */
export async function sendMessageWithKeyboard(
  token: string,
  to: { user_id?: number; chat_id?: number },
  text: string,
  keyboardButtons: any[][],
): Promise<string | null> {
  const body: Record<string, unknown> = {
    text,
    attachments: [
      {
        type: "inline_keyboard",
        payload: {
          buttons: keyboardButtons,
        },
      },
    ],
  };

  const query: Record<string, string | number> = {};
  if (to.chat_id) query.chat_id = to.chat_id;
  if (to.user_id) query.user_id = to.user_id;

  try {
    const data = await maxRequest<{ message?: { body?: { mid?: string } } }>(
      token,
      "POST",
      "/messages",
      query,
      body,
    );
    return data?.message?.body?.mid ?? null;
  } catch {
    return null;
  }
}

/**
 * Register bot commands menu in MAX Bot API.
 * PATCH /me/commands
 */
export async function setMyCommands(
  token: string,
  commands: Array<{ name: string; description: string }>,
): Promise<boolean> {
  try {
    await maxRequest(
      token,
      "PATCH",
      "/me/commands",
      {},
      { commands },
    );
    return true;
  } catch (err) {
    console.warn(`[openclaw-max] setMyCommands error: ${err instanceof Error ? err.message : err}`);
    return false;
  }
}
