import { resolvePayloadKeyboardButtons, toInlineKeyboardAttachment } from "./keyboards.js";
/**
 * MAX channel plugin for OpenClaw.
 *
 * Supports two delivery modes:
 *  - Webhook (recommended for production): configure `channels.max.webhookUrl`
 *  - Long polling (default, works everywhere)
 *
 * MAX Bot API: https://dev.max.ru/docs-api
 */

import {
  buildChannelConfigSchema,
  DEFAULT_ACCOUNT_ID,
  setAccountEnabledInConfigSection,
} from "openclaw/plugin-sdk/core";
import { registerPluginHttpRoute } from "openclaw/plugin-sdk/webhook-ingress";
import { z } from "zod";
import { listAccountIds, resolveAccount } from "./accounts.js";
import {
  sendMessageWithKeyboard,
  setMyCommands,
  sendDm,
  sendToChat,
  sendMessageWithAttachment,
  editMessage,
  sendTypingAction,
  getUpdates,
  subscribeWebhook,
  deleteWebhook,
  getBotInfo,
  getUploadUrl,
  uploadFile,
  configureMaxTransport,
} from "./client.js";
import { getMaxRuntime } from "./runtime.js";
import { createWebhookHandler, handleUpdate } from "./webhook-handler.js";
import { renderTaskList } from "./tasklist.js";
import type { ResolvedMaxAccount, WebhookDeliverMsg } from "./types.js";

const CHANNEL_ID = "max";

/** Active typing-stop callbacks keyed by unique instance id — lets sendMedia stop all typing */
const activeTypingStops = new Map<string, () => void>();
let typingStopSeq = 0;

const MaxAccountSchema = z
  .object({
    token: z.string().optional().describe("MAX Bot API token (from business.max.ru)"),
    enabled: z.boolean().optional().default(true).describe("Enable or disable this channel"),
    dmPolicy: z
      .enum(["open", "allowlist", "closed"])
      .optional()
      .default("allowlist")
      .describe("Who can send DMs"),
    allowFrom: z
      .array(z.string())
      .optional()
      .describe("Allowed MAX user IDs (when dmPolicy=allowlist)"),
    groupPolicy: z
      .enum(["open", "allowlist", "closed"])
      .optional()
      .default("allowlist")
      .describe("Group chat access policy"),
    groupAllowFrom: z
      .array(z.string())
      .optional()
      .describe("Allowed MAX user IDs in group chats"),
    webhookUrl: z
      .string()
      .optional()
      .describe("Webhook URL for production mode (optional, uses long polling if not set)"),
    webhookSecret: z
      .string()
      .optional()
      .describe("Webhook secret for verifying MAX requests"),
    inboxDir: z
      .string()
      .optional()
      .describe("Custom inbox directory for downloaded files"),
    httpProxy: z
      .string()
      .optional()
      .describe("HTTP(S) proxy URL for MAX API traffic"),
    progress: z
      .boolean()
      .optional()
      .default(true)
      .describe("Show a live 'working' draft with tool activity (like Telegram)"),
  })
  .passthrough();

const MaxConfigSchema = buildChannelConfigSchema(
  MaxAccountSchema.extend({
    accounts: z.record(z.string(), MaxAccountSchema.optional()).optional(),
    defaultAccount: z.string().optional(),
  }).passthrough(),
);

// Track active webhook route unregisters per account
const activeRouteUnregisters = new Map<string, () => void>();

function waitUntilAbort(signal?: AbortSignal, onAbort?: () => void): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      onAbort?.();
      resolve();
    };
    if (!signal) return;
    if (signal.aborted) {
      done();
      return;
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Minimum interval between streaming edits (ms) to avoid rate limits */
const STREAM_EDIT_INTERVAL_MS = 800;

/**
 * Send a reply to the user based on chat type.
 * Returns the message_id (for streaming edits).
 */
async function sendReply(
  account: ResolvedMaxAccount,
  chatId: string,
  chatType: string,
  text: string,
): Promise<string | null> {
  const numericId = parseInt(chatId, 10);
  if (isNaN(numericId)) return null;

  const body = renderTaskList(text);
  if (chatType === "direct") {
    return sendDm(account.token, numericId, body);
  } else {
    return sendToChat(account.token, numericId, body);
  }
}

/**
 * Create a streaming deliverer:
 * - onPartialToken(text): called per streaming token → sends/edits message with ▌ cursor
 * - deliver(payload): called once at end with full text → final clean edit (no cursor)
 */
function createStreamingDeliver(
  account: ResolvedMaxAccount,
  chatId: string,
  dialogChatId: string,
  chatType: string,
  log?: any,
  progressEnabled = true,
): {
  onPartialToken: (text: string, isReplace?: boolean) => Promise<void>;
  onToolProgress: (text: string) => Promise<void>;
  startDraft: () => Promise<void>;
  deliver: (payload: { text?: string; body?: string }) => Promise<void>;
} {
  let messageId: string | null = null;
  /** Guards the start draft so repeated onReplyStart keepalives create it once. */
  let startDraftDone = false;
  let accumulated = "";
  let lastEditAt = 0;
  let pendingEdit: ReturnType<typeof setTimeout> | null = null;
  /** Once real answer text starts streaming, the draft belongs to the answer. */
  let answerStarted = false;
  /** True once a tool result arrived in the current assistant segment. */
  let segmentHadTool = false;
  /** Set once a final answer is delivered; the next work segment opens a new draft. */
  let answerDelivered = false;
  /** Rolling tool-activity lines shown in the "working" draft. */
  let progressLines: string[] = [];

  const numericDialogChatId = parseInt(dialogChatId, 10);
  let typingInterval: ReturnType<typeof setInterval> | null = null;
  if (!isNaN(numericDialogChatId)) {
    sendTypingAction(account.token, numericDialogChatId).catch(() => {});
    typingInterval = setInterval(() => {
      sendTypingAction(account.token, numericDialogChatId).catch(() => {});
    }, 4000);
  }

  const instanceKey = String(++typingStopSeq);

  const safetyTimer = setTimeout(() => stopTyping(), 90_000);

  function stopTyping() {
    clearTimeout(safetyTimer);
    if (typingInterval) {
      clearInterval(typingInterval);
      typingInterval = null;
    }
    activeTypingStops.delete(instanceKey);
  }

  activeTypingStops.set(instanceKey, stopTyping);

  async function throttledEdit(text: string) {
    if (!messageId) return;
    const elapsed = Date.now() - lastEditAt;
    if (pendingEdit) clearTimeout(pendingEdit);
    if (elapsed >= STREAM_EDIT_INTERVAL_MS) {
      await editMessage(account.token, messageId, renderTaskList(text));
      lastEditAt = Date.now();
      if (typingInterval !== null) {
        sendTypingAction(account.token, numericDialogChatId).catch(() => {});
      }
    } else {
      pendingEdit = setTimeout(async () => {
        if (messageId) {
          await editMessage(account.token, messageId, renderTaskList(text)).catch(() => {});
          lastEditAt = Date.now();
          if (typingInterval !== null) {
            sendTypingAction(account.token, numericDialogChatId).catch(() => {});
          }
        }
      }, STREAM_EDIT_INTERVAL_MS - elapsed) as unknown as ReturnType<typeof setTimeout>;
    }
  }

  let creationPromise: Promise<void> | null = null;

  /**
   * Turn one raw tool-activity line into a short, plain-text line.
   * MAX auto-generates link previews for anything that looks like a path or URL,
   * which produced a huge card in the progress draft. Collapse whitespace, drop
   * filesystem paths down to their basename, and cap the length.
   */
  function sanitizeProgressLine(raw: string): string {
    let line = (raw || "").replace(/\s+/g, " ").trim();
    if (!line) return "";
    // Strip protocol URLs down to their host first (before path collapsing).
    line = line.replace(/https?:\/\/([^\s/]+)\S*/g, "$1");
    // Replace long filesystem paths (~/..., /home/..., ./...) with the last segment.
    line = line.replace(/(?:~|\/|\.\/)[\w.@-]*\/([\w.@-]+)/g, "$1");
    // Remove characters MAX may treat as link anchors.
    line = line.replace(/[<>]/g, "");
    if (line.length > 120) line = line.slice(0, 117) + "…";
    return line;
  }

  /** Render the current "working" draft body from collected tool lines. */
  function renderProgress(): string {
    const lines = progressLines.slice(-6);
    if (lines.length === 0) return "⏳ Работаю…";
    return ["⏳ Работаю…", "", ...lines].join("\n");
  }

  /**
   * Open the "⏳ Работаю…" draft as soon as the turn starts, not only on the
   * first tool result. Without this the user stares at an empty chat while the
   * model thinks (a long silent first token), which reads as a hung bot.
   * The first tool result or answer token then edits this same message.
   */
  async function startDraft() {
    if (!progressEnabled || startDraftDone) return;
    if (messageId || creationPromise) return;
    startDraftDone = true;
    const attempt = (async () => {
      const mid = await sendReply(account, chatId, chatType, renderProgress());
      if (mid) {
        messageId = mid;
        lastEditAt = Date.now();
        log?.info?.(`[openclaw-max] Start draft created mid=${mid}`);
      } else {
        // Send failed: allow a later tool/answer event to retry the draft.
        creationPromise = null;
        startDraftDone = false;
      }
    })();
    creationPromise = attempt;
    await attempt;
  }

  /**
   * Called on each tool result. Keeps one editable status message alive so the
   * user can see the agent is actually working (tool name + detail), mirroring
   * Telegram's "progress" streaming mode.
   */
  async function onToolProgress(text: string) {
    const line = sanitizeProgressLine((text || "").split("\n")[0] ?? "");
    if (!line) return;
    // A new work segment after a delivered answer: open a fresh draft so the
    // user sees "⏳ Работаю…" again instead of silence while tools run.
    if (answerDelivered) await finalizeCurrentDraft();
    if (progressLines[progressLines.length - 1] !== line) progressLines.push(line);
    if (progressLines.length > 20) progressLines = progressLines.slice(-20);
    // Pre-tool narration: some models (Grok) stream a sentence before their
    // first tool call. That text is commentary, not the answer — roll it back
    // into the "⏳ Работаю…" draft instead of leaving it in the chat as a reply.
    if (answerStarted && !answerDelivered && !segmentHadTool) {
      await demoteAnswerToDraft();
    }
    segmentHadTool = true;
    // The answer preview owns the message once it starts streaming.
    if (answerStarted) return;

    if (!messageId) {
      if (!creationPromise) {
        creationPromise = (async () => {
          messageId = await sendReply(account, chatId, chatType, renderProgress());
          lastEditAt = Date.now();
          log?.info?.(`[openclaw-max] Progress draft started mid=${messageId}`);
        })();
      }
      await creationPromise;
      return;
    }

    await throttledEdit(renderProgress());
  }

  /**
   * True when `next` is a brand-new answer block rather than a growth of the
   * one currently shown in the draft. With steering, a follow-up message can be
   * injected mid-turn, so a single run may emit several final answers; without
   * this check the second answer edits over the first inside the same message.
   */
  function isNewAnswerBlock(next: string, isReplace = false): boolean {
    if (!answerStarted || !messageId || !accumulated) return false;
    // A re-projection of the current answer is never a new block.
    if (isReplace) return false;
    const prev = accumulated.trim();
    const cand = (next || "").trim();
    if (!cand || !prev) return false;
    // A growth of the current answer, or a shorter re-projection of it.
    if (cand.startsWith(prev) || prev.startsWith(cand)) return false;
    return true;
  }

  /**
   * The streamed text turned out to be pre-tool narration. Reuse its message
   * as the progress draft instead of leaving commentary in the chat as if it
   * were the reply.
   */
  async function demoteAnswerToDraft(): Promise<void> {
    accumulated = "";
    answerStarted = false;
    if (messageId) {
      await editMessage(account.token, messageId, renderTaskList(renderProgress())).catch(() => {});
      lastEditAt = Date.now();
    }
  }

  /** Close the current draft message and forget it, so the next answer opens a new one. */
  async function finalizeCurrentDraft(): Promise<void> {
    // When the message already holds a delivered answer, leave it as-is.
    if (messageId && accumulated && !answerDelivered) {
      await editMessage(account.token, messageId, renderTaskList(accumulated)).catch(() => {});
    }
    messageId = null;
    accumulated = "";
    answerStarted = false;
    answerDelivered = false;
    segmentHadTool = false;
    progressLines = [];
    // Let the next work segment open its own "⏳ Работаю…" draft.
    startDraftDone = false;
    creationPromise = null;
  }

  async function onPartialToken(text: string, isReplace = false) {
    if (!text) return;
    // A steered follow-up starts a fresh answer block: give it its own message
    // instead of overwriting the previous answer in the same draft.
    if (answerDelivered || isNewAnswerBlock(text, isReplace)) {
      await finalizeCurrentDraft();
    }
    if (!answerStarted) segmentHadTool = false;
    answerStarted = true;
    accumulated = text;

    if (!messageId) {
      if (!creationPromise) {
        creationPromise = (async () => {
          messageId = await sendReply(account, chatId, chatType, accumulated + " …");
          lastEditAt = Date.now();
          log?.info?.(`[openclaw-max] Streaming started mid=${messageId}`);
        })();
      }
      await creationPromise;
      return;
    }

    await throttledEdit(accumulated + " …");
  }

  async function deliver(payload: any) {
    stopTyping();
    if (pendingEdit) {
      clearTimeout(pendingEdit);
      pendingEdit = null;
    }
    const finalText = payload?.text ?? payload?.body ?? accumulated;
    if (!finalText) return;

    // Steering can make one run emit several final blocks; each gets its own
    // message instead of editing over the previous answer.
    if (isNewAnswerBlock(finalText)) {
      await finalizeCurrentDraft();
    }

    const keyboardButtons = resolvePayloadKeyboardButtons(payload);

    if (messageId) {
      // If we have inline buttons, edit with buttons
      await editMessage(account.token, messageId, renderTaskList(finalText), keyboardButtons ? [toInlineKeyboardAttachment(keyboardButtons)] : undefined);
    } else {
      if (keyboardButtons && keyboardButtons.length > 0) {
        const numericId = parseInt(chatId, 10);
        const target = chatType === "direct" ? { user_id: numericId } : { chat_id: numericId };
        await sendMessageWithKeyboard(account.token, target, renderTaskList(finalText), keyboardButtons);
      } else {
        await sendReply(account, chatId, chatType, finalText);
      }
    }

    // Remember what this message now shows, so a following block is detected as
    // new (and opens its own message) instead of overwriting this answer.
    accumulated = finalText;
    answerStarted = true;
    // Mark the segment done: the next tool activity opens a fresh "работает" draft.
    answerDelivered = true;
  }

  return { onPartialToken, onToolProgress, startDraft, deliver };
}

/**
 * Dispatch an inbound message to the OpenClaw agent and send reply back.
 */
async function deliverMessage(
  msg: WebhookDeliverMsg,
  account: ResolvedMaxAccount,
  cfg: unknown,
  log?: any,
): Promise<void> {
  const {
    text,
    senderId,
    senderName,
    chatId,
    dialogChatId,
    chatType,
    accountId,
    images,
    files,
  } = msg;
  const rt = getMaxRuntime();
  const targetAddress = chatType === "direct" ? `max:${senderId}` : `max:group:${chatId}`;
  let agentId = accountId;
  const configObj = cfg as any;
  if (Array.isArray(configObj?.bindings)) {
    const match = configObj.bindings.find((b: any) => b.match?.channel === "max" && b.match?.accountId === accountId)
      ?? configObj.bindings.find((b: any) => b.match?.channel === "max" && b.match?.accountId === "*");
    if (match?.agentId) agentId = match.agentId;
  }
  if (!agentId || agentId === "default") agentId = (accountId === "orli") ? "orli" : "iri";
  const sessionKey = `agent:${agentId}:${targetAddress}`;

  const fileLines = (files ?? []).map((f) => {
    const fwd = f.isForwarded ? "переслано, " : "";
    return `[📎 Файл: ${f.filename} (${fwd}${f.attachmentType || "?"}, ${formatBytes(f.size)}, ${f.mimeType}) — путь: ${f.path}]`;
  });

  const fullText = [...fileLines, text].filter(Boolean).join("\n");

  const msgCtx = rt.channel.reply.finalizeInboundContext({
    Body: fullText,
    RawBody: fullText,
    CommandBody: fullText,
    From: targetAddress,
    To: targetAddress,
    SessionKey: sessionKey,
    AgentId: agentId,
    AccountId: accountId,
    OriginatingChannel: CHANNEL_ID,
    OriginatingTo: targetAddress,
    ChatType: chatType === "direct" ? "direct" : "group",
    SenderName: senderName,
    SenderId: senderId,
    Provider: CHANNEL_ID,
    Surface: CHANNEL_ID,
    ConversationLabel: senderName || senderId,
    Timestamp: Date.now(),
    CommandAuthorized: true,
    MediaPath: files && files.length === 1 ? files[0].path : undefined,
    MediaPaths: files && files.length > 1 ? files.map((f) => f.path) : undefined,
    MediaType: files && files.length === 1 ? files[0].mimeType : undefined,
    MediaTypes: files && files.length > 1 ? files.map((f) => f.mimeType) : undefined,
  });

  // Live "working" draft with tool activity, like Telegram's progress mode.
  // Disable per account with `progress: false`.
  const progressEnabled = (account as any).progress !== false;

  const { onPartialToken, onToolProgress, startDraft, deliver } = createStreamingDeliver(
    account,
    chatId,
    dialogChatId,
    chatType,
    log,
    progressEnabled,
  );

  // Minimal turn-adoption lifecycle.
  // The core only treats an inbound turn as steerable when `turnAdoptionLifecycle`
  // is present in replyOptions: its presence opens the `allowActiveResolution`
  // gate in dispatch-from-config, so a second message arriving mid-run can be
  // injected into the active turn instead of waiting behind it (steering).
  // Without a durable ingress drain we keep the callbacks side-effect free;
  // they exist to satisfy the adoption contract, not to own a claim.
  const adoptionAbort = new AbortController();
  const turnAdoptionLifecycle = {
    admission: "exclusive" as const,
    abortSignal: adoptionAbort.signal,
    onAdopted: () => {
      log?.info?.(`[openclaw-max] Turn adopted for ${senderName}`);
    },
    onDeferred: () => {
      log?.info?.(`[openclaw-max] Turn deferred (queued behind active run) for ${senderName}`);
    },
    onDeferredHeartbeat: () => {},
    onAbandoned: () => {
      log?.info?.(`[openclaw-max] Turn abandoned for ${senderName}`);
    },
    onSettled: () => {
      log?.info?.(`[openclaw-max] Turn settled for ${senderName}`);
    },
  };

  await rt.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: msgCtx,
    cfg,
    dispatcherOptions: {
      deliver,
      onReplyStart: async () => {
        // Fires at turn start (and on typing keepalives); startDraft() is
        // idempotent, so the "working" draft is opened exactly once per turn.
        await startDraft();
      },
    },
    replyOptions: {
      turnAdoptionLifecycle,
      onPartialReply: async (payload: { text?: string; replace?: boolean }) => {
        if (payload?.text) await onPartialToken(payload.text, payload.replace === true);
      },
      ...(progressEnabled
        ? {
            // Force tool-progress callbacks even without /verbose, and keep the
            // tool results inside the draft instead of separate chat messages.
            forceToolResultProgress: true,
            onToolResult: async (payload: { text?: string }) => {
              if (payload?.text) await onToolProgress(payload.text);
            },
          }
        : {}),
      images: images?.map((img) => ({
        type: "image" as const,
        mimeType: img.mimeType,
        data: img.data,
      })),
    },
  });
}

// eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
export function createMaxPlugin(): any {
  return {
    id: CHANNEL_ID,

    meta: {
      id: CHANNEL_ID,
      label: "MAX",
      selectionLabel: "MAX (Bot API)",
      detailLabel: "MAX Bot",
      docsPath: "/channels/max",
      docsLabel: "max",
      blurb: "Connect OpenClaw to MAX messenger (max.ru) via Bot API. Supports DMs, group chats, documents, and voice/audio.",
      order: 80,
    },

    commands: {
      nativeCommandsAutoEnabled: true,
      nativeSkillsAutoEnabled: true,
      buildCommandsListChannelData: (params: { currentPage: number; totalPages: number; agentId?: string }) => {
        if (params.totalPages <= 1) return null;
        const buttons: any[] = [];
        if (params.currentPage > 1) {
          buttons.push({
            type: "callback",
            text: "◀ Пред",
            payload: `/commands ${params.currentPage - 1}`,
          });
        }
        buttons.push({
          type: "callback",
          text: `${params.currentPage}/${params.totalPages}`,
          payload: `/commands ${params.currentPage}`,
        });
        if (params.currentPage < params.totalPages) {
          buttons.push({
            type: "callback",
            text: "След ▶",
            payload: `/commands ${params.currentPage + 1}`,
          });
        }
        return {
          max: {
            buttons: [buttons],
          },
        };
      },
      buildModelsProviderChannelData: ({ providers }: { providers: Array<{ id: string; count: number }> }) => {
        if (!providers || providers.length === 0) return null;
        const rows: any[][] = [];
        let row: any[] = [];
        for (const p of providers) {
          row.push({
            type: "callback",
            text: `${p.id} (${p.count})`,
            payload: `/models ${p.id}`,
          });
          if (row.length === 2) {
            rows.push(row);
            row = [];
          }
        }
        if (row.length > 0) rows.push(row);
        return {
          max: {
            buttons: rows,
          },
        };
      },
      buildModelsMenuChannelData: ({ providers }: { providers: Array<{ id: string; count: number }> }) => {
        if (!providers || providers.length === 0) return null;
        const rows: any[][] = [];
        let row: any[] = [];
        for (const p of providers) {
          row.push({
            type: "callback",
            text: `${p.id} (${p.count})`,
            payload: `/models ${p.id}`,
          });
          if (row.length === 2) {
            rows.push(row);
            row = [];
          }
        }
        if (row.length > 0) rows.push(row);
        return {
          max: {
            buttons: rows,
          },
        };
      },
      buildModelsListChannelData: (params: {
        provider: string;
        models: string[];
        currentModel?: string;
        currentPage: number;
        totalPages: number;
        pageSize: number;
        modelNames?: Map<string, string>;
      }) => {
        const { provider, models, currentModel, currentPage, totalPages, modelNames, pageSize = 8 } = params;
        const rows: any[][] = [];
        if (!models || models.length === 0) {
          return {
            max: {
              buttons: [
                [{ type: "callback", text: "« Назад к провайдерам", payload: "/models" }]
              ]
            }
          };
        }

        const startIndex = (currentPage - 1) * pageSize;
        const endIndex = Math.min(startIndex + pageSize, models.length);
        const pageModels = models.slice(startIndex, endIndex);

        for (const model of pageModels) {
          const fullModel = model.includes("/") ? model : `${provider}/${model}`;
          const isCurrent = currentModel && (currentModel === fullModel || currentModel.endsWith(`/${model}`));
          const label = modelNames?.get(fullModel) || model;
          const displayText = isCurrent ? `${label} ✓` : label;

          rows.push([
            {
              type: "callback",
              text: displayText,
              payload: `/model ${fullModel}`,
            }
          ]);
        }

        // Pagination row
        if (totalPages > 1) {
          const paginationRow: any[] = [];
          if (currentPage > 1) {
            paginationRow.push({
              type: "callback",
              text: "◀ Пред",
              payload: `/models ${provider} ${currentPage - 1}`,
            });
          }
          paginationRow.push({
            type: "callback",
            text: `${currentPage}/${totalPages}`,
            payload: `/models ${provider} ${currentPage}`,
          });
          if (currentPage < totalPages) {
            paginationRow.push({
              type: "callback",
              text: "След ▶",
              payload: `/models ${provider} ${currentPage + 1}`,
            });
          }
          rows.push(paginationRow);
        }

        // Back button
        rows.push([
          {
            type: "callback",
            text: "« Назад к провайдерам",
            payload: "/models",
          }
        ]);

        return {
          max: {
            buttons: rows,
          },
        };
      },
      buildModelBrowseChannelData: () => {
        return {
          max: {
            buttons: [
              [{ type: "callback", text: "Выбрать модель", payload: "/models" }]
            ]
          }
        };
      },
    },
    capabilities: {
      chatTypes: ["direct" as const, "group" as const],
      media: true,
      threads: false,
      interactiveReplies: true,
      inlineKeyboards: true,
      reactions: false,
      edit: false,
      unsend: false,
      reply: false,
      effects: false,
      blockStreaming: false,
    },

    reload: { configPrefixes: [`channels.${CHANNEL_ID}`] },

    configSchema: MaxConfigSchema,

    config: {
      listAccountIds: (cfg: any) => listAccountIds(cfg),
      resolveAccount: (cfg: any, accountId?: string | null) => resolveAccount(cfg, accountId),
      defaultAccountId: (_cfg: any) => DEFAULT_ACCOUNT_ID,

      setAccountEnabled: ({ cfg, accountId, enabled }: any) => {
        const channelConfig = cfg?.channels?.[CHANNEL_ID] ?? {};
        if (accountId === DEFAULT_ACCOUNT_ID) {
          return {
            ...cfg,
            channels: { ...cfg.channels, [CHANNEL_ID]: { ...channelConfig, enabled } },
          };
        }
        return setAccountEnabledInConfigSection({
          cfg,
          sectionKey: `channels.${CHANNEL_ID}`,
          accountId,
          enabled,
        });
      },
    },

    pairing: {
      idLabel: "maxUserId",
      normalizeAllowEntry: (entry: string) => entry.replace(/^max:(?:user:)?/i, "").trim(),
      notifyApproval: async ({ cfg, id }: { cfg: any; id: string }) => {
        const account = resolveAccount(cfg);
        if (!account.token) return;
        const numericId = parseInt(id, 10);
        if (!isNaN(numericId)) {
          await sendDm(account.token, numericId, "✅ OpenClaw: доступ разрешён.");
        }
      },
    },

    security: {
      resolveDmPolicy: ({ cfg, accountId, account: resolvedAccount }: any) => {
        const account: ResolvedMaxAccount = resolvedAccount ?? resolveAccount(cfg, accountId);
        return {
          policy: account.dmPolicy,
          allowFrom: account.allowFrom,
          policyPath: `channels.max.dmPolicy`,
          allowFromPath: `channels.max.allowFrom`,
          approveHint: "openclaw pairing approve max <code>",
        };
      },
    },

    directory: {
      self: async () => null,
      listPeers: async () => [],
      listGroups: async () => [],
    },

    outbound: {
      deliveryMode: "gateway" as const,
      textChunkLimit: 4000,

      sendText: async ({ to, text, accountId, cfg }: any) => {
        const account = resolveAccount(cfg ?? {}, accountId);
        if (!account.token) throw new Error("MAX token not configured");

        const numericId = parseInt(to.replace(/^max:(?:user:|group:)?/i, ""), 10);
        if (isNaN(numericId)) throw new Error(`Invalid MAX recipient ID: ${to}`);

        const ok = await sendDm(account.token, numericId, text);
        if (!ok) throw new Error("Failed to send MAX message");
        return { channel: CHANNEL_ID, messageId: `max-${Date.now()}`, chatId: to };
      },

      sendMedia: async ({
        to,
        buffer,
        mimeType,
        filename,
        caption,
        accountId,
        cfg,
        chatType,
      }: any) => {
        const account = resolveAccount(cfg ?? {}, accountId);
        if (!account.token) throw new Error("MAX token not configured");

        const numericId = parseInt(to.replace(/^max:(?:user:|group:)?/i, ""), 10);
        if (isNaN(numericId)) throw new Error(`Invalid MAX recipient ID: ${to}`);

        // Determine media type: image, video, audio, or general file
        const mediaType = mimeType?.startsWith("image/")
          ? "image"
          : mimeType?.startsWith("video/")
            ? "video"
            : mimeType?.startsWith("audio/")
              ? "audio"
              : "file";

        const text = caption ?? "";
        const target =
          chatType === "direct" || !chatType ? { user_id: numericId } : { chat_id: numericId };
        const isDirect = chatType === "direct" || !chatType;

        // Media delivery is best-effort: a failed upload or attachment send must
        // not kill the whole turn — the caption text still has to reach the chat.
        let uploaded: { token: string } | null = null;
        try {
          const uploadUrl = await getUploadUrl(
            account.token,
            mediaType as "image" | "video" | "audio" | "file",
          );
          if (uploadUrl) {
            uploaded = await uploadFile(
              uploadUrl,
              buffer,
              mimeType ?? "application/octet-stream",
              filename ?? "file",
            );
          }
        } catch (err) {
          console.warn(
            `[openclaw-max] media upload failed: ${err instanceof Error ? err.message : err}`,
          );
        }

        let mid: string | null = null;
        if (uploaded) {
          try {
            mid = await sendMessageWithAttachment(
              account.token,
              target,
              text,
              mediaType as "image" | "video" | "audio" | "file",
              uploaded.token,
            );
          } catch (err) {
            console.warn(
              `[openclaw-max] attachment send failed: ${err instanceof Error ? err.message : err}`,
            );
          }
        }

        if (!mid) {
          // Text-only fallback so the turn still delivers something.
          const fallbackText = text || `[вложение: ${filename ?? mediaType}]`;
          mid = isDirect
            ? await sendDm(account.token, numericId, fallbackText)
            : await sendToChat(account.token, numericId, fallbackText);
        }

        // Stop active typing indicators
        for (const stopFn of activeTypingStops.values()) stopFn();
        activeTypingStops.clear();

        return { channel: CHANNEL_ID, messageId: mid ?? `max-${Date.now()}`, chatId: to };
      },
    },

    gateway: {
      startAccount: async (ctx: any) => {
        const { cfg, accountId, log } = ctx;
        const account = resolveAccount(cfg, accountId);

        if (!account.enabled) {
          log?.info?.(`[openclaw-max] Account ${accountId} disabled, skipping`);
          return waitUntilAbort(ctx.abortSignal);
        }

        if (!account.token) {
          log?.warn?.(`[openclaw-max] Account ${accountId} missing token, skipping`);
          return waitUntilAbort(ctx.abortSignal);
        }

        configureMaxTransport({ httpProxy: account.httpProxy });
        if (account.httpProxy) {
          log?.info?.(`[openclaw-max] Using HTTP proxy for MAX API traffic`);
        }

        try {
          const info = await getBotInfo(account.token);
          log?.info?.(`[openclaw-max] Connected as bot: ${info.name} (@${info.username})`);

          // Register bot commands menu in MAX Bot API so users see popup menu when typing /
          const defaultCommands = [
            { name: "models", description: "Выбор и переключение моделей" },
            { name: "model", description: "Текущая модель или смена (/model provider/model)" },
            { name: "new", description: "Начать новую сессию" },
            { name: "status", description: "Статус бота, агента и контекста" },
            { name: "help", description: "Справка по всем командам" },
            { name: "commands", description: "Полный список команд" },
            { name: "tools", description: "Список доступных инструментов" },
            { name: "compact", description: "Сжать контекст диалога" },
            { name: "think", description: "Глубина размышлений (off/low/medium/high)" },
            { name: "reset", description: "Сбросить текущую сессию" },
            { name: "stop", description: "Остановить текущую генерацию" },
            { name: "restart", description: "Перезапустить OpenClaw" },
            { name: "usage", description: "Расход токенов и статистика" },
            { name: "tts", description: "Управление озвучкой (TTS)" },
            { name: "voice", description: "Выбор голоса для озвучки" },
            { name: "fast", description: "Режим Fast mode (вкл/выкл)" },
            { name: "reasoning", description: "Показ хода мыслей (вкл/выкл)" },
            { name: "verbose", description: "Подробный режим вывода" },
            { name: "whoami", description: "Показать мой ID в мессенджере" },
            { name: "context", description: "Информация о текущем контексте" },
            { name: "tasks", description: "Список фоновых задач" },
            { name: "subagents", description: "Запущенные субагенты" },
            { name: "skills", description: "Список доступных навыков" },
            { name: "weather", description: "Погода и прогноз" },
            { name: "humanizer", description: "Очеловечивание текстов" },
            { name: "notion", description: "Интеграция с Notion" },
            { name: "gog", description: "Google Workspace (диск, почта, календари)" },
          ];
          await setMyCommands(account.token, defaultCommands).catch(() => {});
        } catch (err) {
          log?.error?.(
            `[openclaw-max] Token verification failed: ${err instanceof Error ? err.message : err}`,
          );
          return waitUntilAbort(ctx.abortSignal);
        }

        if (account.webhookUrl) {
          return startWebhookMode(ctx, account, cfg, log);
        } else {
          return startLongPollingMode(ctx, account, cfg, log);
        }
      },

      stopAccount: async (ctx: any) => {
        ctx.log?.info?.(`[openclaw-max] Account ${ctx.accountId} stopped`);
      },
    },

    agentPrompt: {
      messageToolHints: () => [
        "",
        "### MAX Messenger Formatting",
        "MAX supports Markdown formatting:",
        "",
        "- **bold**: `**text**` or `__text__`",
        "- *italic*: `*text*` or `_text_`",
        "- ~~strikethrough~~: `~~text~~`",
        "- `inline code`: backtick",
        "- [links](url): `[display text](https://url)`",
        "",
        "Keep messages under 4000 characters.",
        "No emoji reactions, no message editing after send.",
      ],
    },
  };
}

// ─── Webhook mode ─────────────────────────────────────────────────────────────

async function startWebhookMode(ctx: any, account: ResolvedMaxAccount, _cfg: unknown, log: any) {
  log?.info?.(`[openclaw-max] Starting in webhook mode → ${account.webhookUrl}`);

  try {
    await subscribeWebhook(account.token, account.webhookUrl!, account.webhookSecret);
    log?.info?.(`[openclaw-max] Webhook registered: ${account.webhookUrl}`);
  } catch (err) {
    log?.error?.(
      `[openclaw-max] Failed to register webhook: ${err instanceof Error ? err.message : err}`,
    );
    return waitUntilAbort(ctx.abortSignal);
  }

  const handler = createWebhookHandler({
    account,
    deliver: async (msg) => {
      const rt = getMaxRuntime(); const currentCfg = (typeof rt.config?.current === 'function' ? rt.config.current() : (typeof rt.config?.loadConfig === 'function' ? await rt.config.loadConfig() : _cfg)) ?? _cfg;
      await deliverMessage(msg, account, currentCfg, log);
      return null;
    },
    log,
  });

  const routeKey = `${account.accountId}:${account.webhookPath}`;
  const prev = activeRouteUnregisters.get(routeKey);
  if (prev) {
    log?.info?.(`[openclaw-max] Deregistering stale webhook route`);
    prev();
    activeRouteUnregisters.delete(routeKey);
  }

  const unregister = registerPluginHttpRoute({
    path: account.webhookPath,
    auth: "plugin",
    replaceExisting: true,
    pluginId: CHANNEL_ID,
    accountId: account.accountId,
    log: (msg: string) => log?.info?.(msg),
    handler,
  });
  activeRouteUnregisters.set(routeKey, unregister);
  log?.info?.(`[openclaw-max] Webhook route registered: ${account.webhookPath}`);

  return waitUntilAbort(ctx.abortSignal, async () => {
    log?.info?.(`[openclaw-max] Stopping webhook mode for account ${account.accountId}`);
    unregister?.();
    activeRouteUnregisters.delete(routeKey);
    try {
      await deleteWebhook(account.token);
    } catch {
      // best-effort cleanup
    }
  });
}

// ─── Long polling mode ──────────────────────────��─────────────────────────────

async function startLongPollingMode(
  ctx: any,
  account: ResolvedMaxAccount,
  _cfg: unknown,
  log: any,
) {
  log?.info?.(`[openclaw-max] Starting in long polling mode for account ${account.accountId}`);

  const signal: AbortSignal = ctx.abortSignal;
  let marker: number | null | undefined = undefined;
  let consecutiveErrors = 0;

  while (!signal?.aborted) {
    try {
      const result = await getUpdates(account.token, marker, 30, signal);
      consecutiveErrors = 0;

      // Immediately advance marker to prevent reprocessing loops
      if (result.marker != null) {
        marker = result.marker;
      }

      if (result.updates.length > 0) {
        log?.info?.(`[openclaw-max] Received ${result.updates.length} update(s) for ${account.accountId}`);
        const rt = getMaxRuntime();
        const currentCfg =
          (typeof rt.config?.current === "function"
            ? rt.config.current()
            : typeof rt.config?.loadConfig === "function"
              ? await rt.config.loadConfig()
              : _cfg) ?? _cfg;

        for (const update of result.updates) {
          if (signal?.aborted) break;
          try {
            await handleUpdate(
              update,
              account,
              async (msg) => {
                await deliverMessage(msg, account, currentCfg, log);
                return null;
              },
              log,
            );
          } catch (itemErr) {
            log?.error?.(
              `[openclaw-max] Error processing update for ${account.accountId}: ${itemErr instanceof Error ? itemErr.message : String(itemErr)}`,
            );
          }
        }
      }
    } catch (err) {
      if (signal?.aborted) break;
      consecutiveErrors++;
      const errMsg = err instanceof Error ? err.message : String(err);
      log?.warn?.(
        `[openclaw-max] Long polling error (${consecutiveErrors}) for ${account.accountId}: ${errMsg}`,
      );

      // Never give up — exponential backoff up to 15 seconds
      const delay = Math.min(1000 * Math.pow(1.5, Math.min(consecutiveErrors - 1, 8)), 15_000);
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  log?.info?.(`[openclaw-max] Long polling loop ended for account ${account.accountId}`);
}
