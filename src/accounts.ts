/**
 * Account config resolution for the MAX channel plugin.
 */

import type { MaxConfig, ResolvedMaxAccount } from "./types.js";

export const DEFAULT_ACCOUNT_ID = "default";
export const DEFAULT_WEBHOOK_PATH = "/max/webhook";

/**
 * List all configured account IDs for a config object.
 */
export function listAccountIds(cfg: { channels?: { max?: MaxConfig } }): string[] {
  const maxCfg = cfg?.channels?.max;
  if (!maxCfg) return [];
  const extra = Object.keys(maxCfg.accounts ?? {});
  // Always include 'default' if the root-level config has a token
  if (maxCfg.token) return [DEFAULT_ACCOUNT_ID, ...extra];
  return extra.length > 0 ? extra : [];
}

/**
 * Resolve a single account's full config.
 */
export function resolveAccount(
  cfg: { channels?: { max?: MaxConfig } },
  accountId?: string | null,
): ResolvedMaxAccount {
  const id = accountId ?? DEFAULT_ACCOUNT_ID;
  const maxCfg = cfg?.channels?.max ?? {};

  // Per-account overrides (if not default)
  const perAccount = id !== DEFAULT_ACCOUNT_ID ? (maxCfg.accounts?.[id] ?? {}) : {};

  // Merge: per-account overrides root-level
  const merged = { ...maxCfg, ...perAccount };

  return {
    accountId: id,
    token: (merged.token ?? "").trim(),
    enabled: merged.enabled !== false,
    webhookUrl: merged.webhookUrl,
    webhookSecret: merged.webhookSecret,
    webhookPath: resolveWebhookPath(merged, id),
    dmPolicy: merged.dmPolicy ?? "pairing",
    allowFrom: normalizeAllowFrom(merged.allowFrom),
    httpProxy: merged.httpProxy?.trim() || undefined,
  };
}

function resolveWebhookPath(merged: Record<string, any>, accountId: string): string {
  if (merged.webhookPath && typeof merged.webhookPath === "string") {
    return merged.webhookPath.startsWith("/") ? merged.webhookPath : `/${merged.webhookPath}`;
  }
  if (merged.webhookUrl && typeof merged.webhookUrl === "string") {
    try {
      const url = new URL(merged.webhookUrl);
      if (url.pathname && url.pathname !== "/") {
        return url.pathname;
      }
    } catch {}
  }
  return accountId === DEFAULT_ACCOUNT_ID ? DEFAULT_WEBHOOK_PATH : `/max/webhook/${accountId}`;
}

function normalizeAllowFrom(raw?: string[]): string[] {
  if (!raw) return [];
  return raw
    .map((s) => String(s).trim())
    .filter(Boolean)
    .map((s) => s.replace(/^max:(?:user:)?/i, ""));
}
