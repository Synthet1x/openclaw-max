/**
 * Lane dispatcher for MAX inbound updates.
 *
 * Problem it solves: the long-polling loop used to `await handleUpdate(...)`
 * inside `for (const update of ...)`. One slow agent turn blocked the whole
 * intake loop, so a second message could not even reach the core while the
 * first was still running — no steering, just a growing backlog.
 *
 * Fixed behaviour:
 *  - intake never awaits a turn; it hands work to this dispatcher and returns
 *  - work is grouped by lane key (`accountId:chatId`), the identity core uses
 *    to decide "steer the active run" vs "queue a new one"
 *  - a single global concurrency cap keeps a burst from spawning many turns
 *
 * The dispatcher intentionally does NOT serialise per lane: two messages from
 * the same chat must both reach the core promptly, otherwise steering can never
 * happen. Core's turnAdoptionLifecycle (admission "exclusive") arbitrates.
 */

export type LaneDispatcherOptions = {
  /** Max turns running at the same time across all lanes. */
  maxConcurrent?: number;
  /** Called when a queued task throws. */
  onError?: (error: unknown, laneKey: string) => void;
};

export type LaneDispatcher = {
  /** Enqueue work for a lane. Returns immediately. */
  dispatch: (laneKey: string, task: () => Promise<void>) => void;
  /** Stop accepting new work; running tasks are not aborted. */
  stop: () => void;
  /** Resolves when the queue is empty and nothing is running. */
  drain: () => Promise<void>;
  /** Currently running + waiting tasks. */
  size: () => { running: number; waiting: number };
};

type PendingItem = { laneKey: string; task: () => Promise<void> };

export function createLaneDispatcher(options: LaneDispatcherOptions = {}): LaneDispatcher {
  const maxConcurrent = Math.max(1, Math.floor(options.maxConcurrent ?? 4));
  const waiting: PendingItem[] = [];
  const running = new Set<Promise<void>>();
  let stopped = false;
  let idleWaiters: Array<() => void> = [];

  const notifyIfIdle = () => {
    if (stopped || (waiting.length === 0 && running.size === 0)) {
      const waiters = idleWaiters;
      idleWaiters = [];
      for (const w of waiters) w();
    }
  };

  const pump = () => {
    while (!stopped && running.size < maxConcurrent && waiting.length > 0) {
      const item = waiting.shift()!;
      const promise: Promise<void> = (async () => {
        try {
          await item.task();
        } catch (error) {
          options.onError?.(error, item.laneKey);
        }
      })();
      running.add(promise);
      void promise.finally(() => {
        running.delete(promise);
        pump();
        notifyIfIdle();
      });
    }
    notifyIfIdle();
  };

  return {
    dispatch(laneKey, task) {
      if (stopped) return;
      waiting.push({ laneKey, task });
      pump();
    },
    stop() {
      stopped = true;
      waiting.length = 0;
      notifyIfIdle();
    },
    drain() {
      if (stopped || (waiting.length === 0 && running.size === 0)) return Promise.resolve();
      return new Promise<void>((resolve) => {
        idleWaiters.push(resolve);
      });
    },
    size() {
      return { running: running.size, waiting: waiting.length };
    },
  };
}

/** Derive the core lane key for an account-scoped chat. */
export function makeLaneKey(accountId: string, chatId: string | number | null | undefined): string {
  return `${accountId}:${chatId == null ? "unknown" : String(chatId)}`;
}

/** Best-effort chat id for an inbound MAX update, used to build the lane key. */
export function updateLaneChatId(update: {
  chat_id?: number | null;
  message?: { recipient?: { chat_id?: number | null } | null } | null;
  callback?: { message?: { recipient?: { chat_id?: number | null } | null } | null } | null;
}): string | null {
  const direct =
    update.message?.recipient?.chat_id ??
    update.chat_id ??
    update.callback?.message?.recipient?.chat_id ??
    null;
  return direct == null ? null : String(direct);
}
