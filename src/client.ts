/**
 * MAX Bot API HTTP client.
 * https://platform-api2.max.ru
 *
 * The MAX Bot API moved off platform-api.max.ru (decommissioned 2026-07-19) to
 * platform-api2.max.ru, whose TLS chain is anchored on the Russian Trusted Root
 * CA (Минцифры) — absent from Node's bundled CA store. We therefore trust that
 * CA in addition to the platform defaults, but ONLY for MAX infrastructure
 * hosts (see MAX_INFRA_DOMAINS). Every other destination uses a standard
 * dispatcher with the default root store, and redirects are followed manually
 * so the extended trust can never leak to an arbitrary host via a redirect.
 * An optional HTTP(S) proxy applies to both dispatchers.
 */

import tls from "node:tls";
// Import fetch from undici too (not Node's global): the global fetch uses Node's
// built-in undici copy, which rejects a dispatcher built by this (possibly
// different) undici version with UND_ERR_INVALID_ARG. Same-package fetch+Agent
// are guaranteed compatible.
import { fetch, FormData, Agent, ProxyAgent, type Dispatcher } from "undici";
import type { MaxUpdatesResponse, MaxMessage } from "./types.js";
import { RUSSIAN_TRUSTED_CA } from "./max-ca.js";

const MAX_API = "https://platform-api2.max.ru";
const REQUEST_TIMEOUT_MS = 30_000;
const LONG_POLL_TIMEOUT_SEC = 30;

// ─── TLS / proxy transport (scoped CA trust) ─────────────────────────────────

// Trust the Минцифры CA on top of the default root store — but only on the
// MAX-scoped dispatcher below, never on the default one.
const MAX_CA: string[] = [RUSSIAN_TRUSTED_CA, ...tls.rootCertificates];

/**
 * Allowlist of MAX infrastructure domains (apex + any subdomain).
 *
 * - max.ru   — the MAX platform itself: platform-api2.max.ru (current Bot API),
 *              botapi.max.ru (legacy), and any other platform subdomain.
 * - oneme.ru — MAX media upload endpoints returned by POST /uploads:
 *              fu.oneme.ru (type=file), iu.oneme.ru (type=image).
 * - okcdn.ru — MAX audio/video upload endpoints returned by POST /uploads:
 *              omu.okcdn.ru (type=audio), omub.okcdn.ru (type=video).
 *
 * Attachment download URLs are served from the same MAX media infrastructure.
 * Hosts outside this list get the standard dispatcher (default root store only).
 */
export const MAX_INFRA_DOMAINS: readonly string[] = ["max.ru", "oneme.ru", "okcdn.ru"];

/**
 * True when `hostname` is a MAX infrastructure host (allowlist above).
 * Matching is exact-apex or dot-boundary suffix, so `evilmax.ru` or
 * `max.ru.attacker.com` never match. Exported for tests.
 */
export function isMaxInfraHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.+$/, "");
  if (!host) return false;
  return MAX_INFRA_DOMAINS.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

// MAX-scoped dispatcher: default roots + Минцифры CA.
let maxDispatcher: Dispatcher = new Agent({ connect: { ca: MAX_CA } });
// Standard dispatcher for every non-MAX destination: default roots only.
let defaultDispatcher: Dispatcher = new Agent();

/**
 * (Re)configure the HTTP transport for MAX API calls.
 * Call once at channel startup. When `httpProxy` is set, requests are tunnelled
 * through it (fixes GitHub issue #1). The proxy applies to both dispatchers,
 * but the extended CA trust stays scoped to MAX hosts either way.
 */
export function configureMaxTransport(opts?: { httpProxy?: string }): void {
  const proxy = opts?.httpProxy?.trim();
  if (proxy) {
    maxDispatcher = new ProxyAgent({ uri: proxy, connect: { ca: MAX_CA } });
    defaultDispatcher = new ProxyAgent({ uri: proxy });
  } else {
    maxDispatcher = new Agent({ connect: { ca: MAX_CA } });
    defaultDispatcher = new Agent();
  }
}

/**
 * Pick the dispatcher for a URL: extended CA trust only for allowlisted MAX
 * hosts, standard trust for everything else. Exported for tests.
 */
export function dispatcherForUrl(url: string | URL): Dispatcher {
  const parsed = typeof url === "string" ? new URL(url) : url;
  return isMaxInfraHost(parsed.hostname) ? maxDispatcher : defaultDispatcher;
}

// ─── Redirect-safe fetch ──────────────────────────────────────────────────────

const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * fetch() with automatic redirects disabled and a manual redirect loop that
 * re-selects the dispatcher for EVERY hop. A redirect from a MAX host to a
 * non-MAX host therefore switches to the standard dispatcher — the extended
 * CA trust cannot leak to an arbitrary destination. Authorization is dropped
 * on any cross-origin redirect. Only http/https locations are followed.
 * Exported for tests.
 */
export async function fetchWithScopedTrust(
  url: string | URL,
  init: Parameters<typeof fetch>[1] = {},
): Promise<Awaited<ReturnType<typeof fetch>>> {
  let current = new URL(url);
  const originalOrigin = current.origin;
  let method = (init.method ?? "GET").toUpperCase();
  let body = init.body;
  const headers = new Headers(init.headers);

  for (let hop = 0; ; hop++) {
    if (current.protocol !== "http:" && current.protocol !== "https:") {
      throw new Error(`MAX client: refusing non-HTTP(S) URL ${current.protocol}//`);
    }
    const res = await fetch(current.toString(), {
      ...init,
      method,
      body,
      headers,
      redirect: "manual",
      dispatcher: dispatcherForUrl(current),
    });
    if (!REDIRECT_STATUSES.has(res.status)) return res;

    const location = res.headers.get("location");
    if (!location) return res;
    if (hop >= MAX_REDIRECTS) {
      throw new Error(`MAX client: too many redirects (>${MAX_REDIRECTS})`);
    }
    const next = new URL(location, current);
    // Never carry credentials to a different origin.
    if (next.origin !== originalOrigin) headers.delete("authorization");
    // 303, and 301/302 on non-GET/HEAD, become bodyless GET (browser semantics).
    if (res.status === 303 || ((res.status === 301 || res.status === 302) && method !== "GET" && method !== "HEAD")) {
      method = "GET";
      body = undefined;
      headers.delete("content-type");
      headers.delete("content-length");
    }
    // Drain the redirect body so the socket can be reused.
    await res.arrayBuffer().catch(() => undefined);
    current = next;
  }
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
    const res = await fetchWithScopedTrust(url.toString(), {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
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
      token, "POST", "/messages", { user_id: userId }, { text, format: "markdown", disable_link_preview: true }
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
      token, "POST", "/messages", { chat_id: chatId }, { text, format: "markdown", disable_link_preview: true }
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
  const buildBody = (withPreviewFlag: boolean): Record<string, unknown> => {
    const body: Record<string, unknown> = { text, format: "markdown" };
    if (withPreviewFlag) body.disable_link_preview = true;
    if (attachments && attachments.length > 0) {
      body.attachments = attachments;
    }
    return body;
  };
  try {
    await maxRequest(token, "PUT", "/messages", { message_id: messageId }, buildBody(true));
    return true;
  } catch (err) {
    // If the server rejects the preview flag on edit, retry without it so the
    // edit itself still lands (graceful degradation, not a hard failure).
    try {
      await maxRequest(token, "PUT", "/messages", { message_id: messageId }, buildBody(false));
      return true;
    } catch (err2) {
      console.warn(`[openclaw-max] editMessage error: ${err2 instanceof Error ? err2.message : err2}`);
      return false;
    }
  }
}

/**
 * Delete a message.
 * DELETE /messages?message_id={id}
 *
 * Used to retire a "working" draft when the user wrote while it was alive:
 * the final answer is then re-sent as a new message at the bottom of the chat
 * instead of editing the buried draft in place. Returns false on any failure
 * (including deleting an already-deleted message) so the caller can fall back
 * to an in-place edit — the answer must never be lost or duplicated.
 */
export async function deleteMessage(token: string, messageId: string): Promise<boolean> {
  try {
    const res = await maxRequest<{ success?: boolean }>(
      token, "DELETE", "/messages", { message_id: messageId },
    );
    return res?.success !== false;
  } catch (err) {
    console.warn(`[openclaw-max] deleteMessage error: ${err instanceof Error ? err.message : err}`);
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
    const res = await fetchWithScopedTrust(url.toString(), {
      method: "GET",
      headers: { Authorization: token },
      signal: combinedSignal,
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
/**
 * Дотянуть сообщение по mid.
 * Нужно для «чистых» форвардов: MAX иногда присылает вебхук без текста и вложений,
 * содержимое оригинала доступно только через GET /messages/{mid}.
 */
export async function getMessage(token: string, messageId: string): Promise<MaxMessage | null> {
  try {
    const res = await maxRequest<any>(token, "GET", `/messages/${encodeURIComponent(messageId)}`);
    return ((res && (res.message ?? res)) ?? null) as MaxMessage | null;
  } catch {
    return null;
  }
}

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

    const res = await fetchWithScopedTrust(url, { headers });
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
    const res = await fetchWithScopedTrust(uploadUrl, {
      method: "POST",
      body: form,
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
