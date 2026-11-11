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
import {
  StageAnimator,
  extractPlan,
  extractPlanHeader,
  hasAnimatablePlan,
  substitutePlan,
  isAnimatableCorePlan,
  renderCorePlan,
  type CorePlanStep,
} from "./plan.js";
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
  onPlanUpdate: (payload: { steps?: CorePlanStep[]; title?: string }) => Promise<void>;
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
  /** Live stage animation captured from the plan the model narrated. */
  let animator: StageAnimator | null = null;
  /** Latest step list emitted by the core plan stream (authoritative when present). */
  let corePlanSteps: CorePlanStep[] | null = null;
  /** Title accompanying the core plan stream. */
  let corePlanTitle = "";
  /** Title line belonging to the captured plan (empty when absent). */
  let planHeader = "";
  /**
   * True once the plan can no longer change.
   *
   * The model streams a plan line by line, so an early capture sees only the
   * first couple of stages. Until real work advances the plan we keep accepting
   * a longer version, otherwise a 4-step plan would animate as 2 steps.
   */
  let planSealed = false;
  /** Consecutive edit failures, used to surface a stuck draft instead of silence. */
  let editFailures = 0;

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

  /**
   * Apply one edit, tolerating network failure.
   *
   * A failed edit used to be swallowed by `.catch(() => {})`, which left the
   * draft frozen on a stale frame while the turn kept running — the exact
   * "бот подвис" symptom. Counting consecutive failures lets the draft say so
   * instead of silently lying about progress.
   */
  async function applyEdit(text: string): Promise<void> {
    if (!messageId) return;
    const ok = await editMessage(account.token, messageId, renderTaskList(text)).catch(() => false);
    if (ok) {
      if (editFailures >= 3) {
        log?.info?.(`[openclaw-max] Draft edits recovered after ${editFailures} failures`);
      }
      editFailures = 0;
    } else {
      editFailures += 1;
      if (editFailures === 3) {
        log?.warn?.(`[openclaw-max] Draft edits failing (${editFailures}x); draft may be stale`);
      }
    }
    lastEditAt = Date.now();
  }

  async function throttledEdit(text: string) {
    if (!messageId) return;
    const elapsed = Date.now() - lastEditAt;
    if (pendingEdit) clearTimeout(pendingEdit);
    if (elapsed >= STREAM_EDIT_INTERVAL_MS) {
      await applyEdit(text);
      if (typingInterval !== null) {
        sendTypingAction(account.token, numericDialogChatId).catch(() => {});
      }
    } else {
      pendingEdit = setTimeout(async () => {
        if (messageId) {
          await applyEdit(text);
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
    // A core-emitted plan is authoritative: it carries real statuses, so it can
    // never disagree with what the agent actually did.
    if (corePlanSteps && corePlanSteps.length >= 2) {
      return renderCorePlan(corePlanSteps, corePlanTitle);
    }
    // A plan captured from the model's narration owns the draft otherwise:
    // showing the animated checklist makes the work legible stage by stage
    // instead of a wall of tool names.
    if (animator) return animator.render(planHeader);
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

    // Each new tool result is one unit of work: retire the current stage and
    // promote the next so the checklist visibly advances while the turn runs.
    if (animator && !animator.finished) {
      // Real work starting freezes the plan: a later stream cannot add stages.
      planSealed = true;
      animator.advance();
    }

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
    // A new work segment gets a new plan; never animate the previous one.
    animator = null;
    corePlanSteps = null;
    corePlanTitle = "";
    planHeader = "";
    planSealed = false;
    editFailures = 0;
    // Let the next work segment open its own "⏳ Работаю…" draft.
    startDraftDone = false;
    creationPromise = null;
  }

  /**
   * Capture the checklist the model narrates into an animator, once per turn.
   *
   * MAX renders a markdown task list as static glyphs, so the only way to make
   * stages visibly progress is to own the list and rewrite it as work happens.
   * Capture is idempotent: the first plan seen wins, and a later re-wording of
   * the same list does not restart the animation.
   */
  function capturePlan(text: string, isReplace: boolean): void {
    if (planSealed) return;
    if (isReplace) return;
    if (!hasAnimatablePlan(text)) return;
    const stages = extractPlan(text);
    if (stages.length < 2) return;
    // While the plan is still streaming in, labels can be truncated mid-line and
    // later stages can be missing. Adopt any changed version until real work
    // seals it, otherwise a half-written stage would freeze under the wrong text.
    if (animator && animator.matches(stages)) return;
    animator = new StageAnimator(stages);
    planHeader = extractPlanHeader(text);
    log?.info?.(`[openclaw-max] Plan captured: ${stages.length} stages`);
  }

  /**
   * Handle a structured plan emitted by the core (`onPlanUpdate`).
   *
   * This is the reliable path: the core sends the agent's own step list with
   * real statuses, so there is no text parsing, no wording drift, and no
   * dependency on block streaming being enabled for the channel. The draft is
   * redrawn on every update, which is what produces the visible stage movement.
   */
  async function onPlanUpdate(payload: { steps?: CorePlanStep[]; title?: string }): Promise<void> {
    const steps = payload?.steps;
    if (!isAnimatableCorePlan(steps)) return;
    corePlanSteps = steps as CorePlanStep[];
    if (payload?.title) corePlanTitle = payload.title;
    log?.info?.(`[openclaw-max] Plan update: ${steps?.length} steps`);

    // A plan arriving after an answer is a new work segment.
    if (answerDelivered) await finalizeCurrentDraft();

    if (!messageId) {
      if (!creationPromise) {
        creationPromise = (async () => {
          messageId = await sendReply(account, chatId, chatType, renderProgress());
          lastEditAt = Date.now();
          log?.info?.(`[openclaw-max] Plan draft created mid=${messageId}`);
        })();
      }
      await creationPromise;
      return;
    }

    await throttledEdit(renderProgress());
  }

  /**
   * Body for one streaming frame.
   *
   * While a plan is being animated the checklist inside the streamed text is
   * replaced by the animator's marks, so the stages move even though the model
   * only ever emitted a static list. Everything outside the checklist streams
   * verbatim.
   */
  function streamBody(text: string): string {
    if (animator && animator.size >= 2) return `${substitutePlan(text, animator)} …`;
    return `${text} …`;
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

    // Capture the plan the first time the model narrates one, so every later
    // frame can animate the same checklist instead of showing raw tool noise.
    capturePlan(text, isReplace);

    if (!messageId) {
      if (!creationPromise) {
        creationPromise = (async () => {
          messageId = await sendReply(account, chatId, chatType, streamBody(accumulated));
          lastEditAt = Date.now();
          log?.info?.(`[openclaw-max] Streaming started mid=${messageId}`);
        })();
      }
      await creationPromise;
      return;
    }

    await throttledEdit(streamBody(accumulated));
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

    // The turn is finished, so every stage of the captured plan is complete.
    // Without this the last stage would sit on 🔄 forever, which reads as a
    // checklist that never finished.
    let finalBody = finalText;
    if (animator) {
      animator.complete();
      const answerPlan = extractPlan(finalText);
      if (answerPlan.length >= 2 && animator.matches(answerPlan)) {
        finalBody = substitutePlan(finalText, animator);
      }
    }

    if (messageId) {
      // If we have inline buttons, edit with buttons
      await editMessage(account.token, messageId, renderTaskList(finalBody), keyboardButtons ? [toInlineKeyboardAttachment(keyboardButtons)] : undefined);
    } else {
      if (keyboardButtons && keyboardButtons.length > 0) {
        const numericId = parseInt(chatId, 10);
        const target = chatType === "direct" ? { user_id: numericId } : { chat_id: numericId };
        await sendMessageWithKeyboard(account.token, target, renderTaskList(finalBody), keyboardButtons);
      } else {
        await sendReply(account, chatId, chatType, finalBody);
      }
    }

    // Remember what this message now shows, so a following block is detected as
    // new (and opens its own message) instead of overwriting this answer.
    accumulated = finalText;
    answerStarted = true;
    // Mark the segment done: the next tool activity opens a fresh "работает" draft.
    answerDelivered = true;
  }

  return { onPartialToken, onToolProgress, onPlanUpdate, startDraft, deliver };
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

  const { onPartialToken, onToolProgress, onPlanUpdate, startDraft, deliver } = createStreamingDeliver(
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
      // Block streaming must be ON for this channel, even though
      // `agents.defaults.blockStreamingDefault` defaults to "off".
      //
      // Without it the core never invokes `onPartialReply`, so the whole answer
      // (including any checklist the model narrates) arrives only at the end
      // via `deliver()`. That leaves the stage animator with no intermediate
      // frames to render — the checkboxes would appear once, already final.
      // Setting the flag here scopes streaming to MAX instead of flipping it
      // globally for every channel on the gateway.
      disableBlockStreaming: false,
      onPartialReply: async (payload: { text?: string; replace?: boolean }) => {
        if (payload?.text) await onPartialToken(payload.text, payload.replace === true);
      },
      // Structured plan stream from the core. This is the reliable animation
      // source: real step statuses, no text parsing, and it fires even when
      // answer streaming is unavailable for the account.
      //
      // `suppressDefaultToolProgressMessages` is required alongside it: the core
      // gates plan/approval callbacks behind `requiresToolSummaryVisibility`, so
      // when tool summaries are hidden (verbose off, the default) the plan event
      // is dropped before it ever reaches this channel. Declaring that this
      // channel owns its own progress UI is what lets the plan through.
      suppressDefaultToolProgressMessages: true,
      onPlanUpdate: async (payload: { steps?: CorePlanStep[]; title?: string }) => {
        await onPlanUpdate(payload);
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

        const ok = await sendDm(account.token, numericId, renderTaskList(text));
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
          const renderedFallback = renderTaskList(fallbackText);
          mid = isDirect
            ? await sendDm(account.token, numericId, renderedFallback)
            : await sendToChat(account.token, numericId, renderedFallback);
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
        "- lists: `- item` or `1. item`",
        "- checklists: `- [ ] todo`, `- [x] done`, `- [~] in progress`, `- [-] skipped`",
        "  (they render as ⬜ / ✅ / 🔄 / ⏭️ — use these for step-by-step plans)",
        "",
        "No tables and no fenced code blocks: use aligned plain lines instead.",
        "`progress_card` does NOT reach a MAX chat — never use it to show a checklist or status here; post a checklist message instead.",
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
