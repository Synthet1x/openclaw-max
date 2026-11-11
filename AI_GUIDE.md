# MAX Messenger Plugin for OpenClaw — AI Agent & Operator Guide

> **For AI Assistants & Human Administrators:**  
> This guide contains everything you need to install, configure, verify, and troubleshoot the `@synthet1x/openclaw-max` channel plugin without getting stuck.

---

## 1. Fast Installation

### Official ClawHub Catalog (Recommended)
```bash
openclaw plugins install clawhub:@synthet1x/openclaw-max
```

### Direct NPM
```bash
openclaw plugins install @synthet1x/openclaw-max
```

---

## 2. Minimal Working Configuration

Add to `~/.openclaw/openclaw.json`:

```json5
{
  channels: {
    max: {
      enabled: true,
      token: "YOUR_MAX_BOT_TOKEN", // From https://business.max.ru
      dmPolicy: "allowlist",       // "open" | "allowlist" | "disabled"
      allowFrom: ["6163830"]       // CRITICAL: Must be string IDs, NOT numbers!
    }
  },
  bindings: [
    {
      agentId: "main",             // Target agent ID in your OpenClaw setup
      match: { channel: "max", accountId: "default" }
    }
  ]
}
```

After updating configuration:
```bash
openclaw gateway restart
# Check channel health:
openclaw channels status
```

---

## 3. Critical Gotchas (Why bots fail or stay silent)

### 🔴 Gotcha 1: User IDs MUST be strings
- ❌ **Wrong:** `"allowFrom": [6163830]`
- ✅ **Correct:** `"allowFrom": ["6163830"]`
- *Consequence:* Passing numbers breaks JSON schema validation on startup.

### 🔴 Gotcha 2: Missing `bindings` makes the bot completely silent
- OpenClaw routes incoming messages via the `bindings` array.
- If you configure `channels.max` without a matching `bindings` rule, OpenClaw accepts the message from MAX but drops it because no agent is bound to handle it.
- Always ensure:
  ```json5
  bindings: [
    { agentId: "YOUR_AGENT_ID", match: { channel: "max", accountId: "default" } }
  ]
  ```

### 🔴 Gotcha 3: Audio & Voice Messages in Long Polling vs Webhook
- **System limitation of MAX Platform:** In Long Polling mode (`GET /updates`), MAX server strips voice audio bytes and delivers an empty `message_created` event.
- **Solution:** For voice interaction (speech-to-text / Whisper), set up a Webhook:
  ```json5
  channels: {
    max: {
      token: "...",
      webhookUrl: "https://your-domain.com/max/webhook",
      webhookSecret: "your_secret_optional"
    }
  }
  ```
- If you only need text, buttons, photos, documents, and video, Long Polling works out-of-the-box without a public domain or SSL certificate.

### 🔴 Gotcha 4: Do NOT set `plugins.allow` unless intentional
- If `plugins.allow` is present in `openclaw.json`, it acts as an exclusive whitelist. Any plugin not listed there (including Telegram, Discord, MAX) will be blocked from loading.
- Instead, simply enable the plugin via `plugins.entries.max.enabled = true`.

### 🟡 Gotcha 5: MAX has no native checkbox — and no `reactions`/`edit` capability
- Markdown task lists do **not** survive on their own: `- [ ] text` would arrive as literal
  text. `renderTaskList()` converts them to glyphs that every MAX client shows correctly:
  - `- [ ]` → `⬜` pending
  - `- [x]` / `- [X]` → `✅` done
  - `- [~]` / `- [/]` → `🔄` in progress
  - `- [-]` → `⏭️` skipped
  - Bullet (`-`, `*`, `+`) **and** ordered (`1.`, `1)`) lists are supported, with or without a
    space after the bracket.
- `capabilities.edit` is `false`, so the generic `message(action:"edit")` path returns
  `Unknown target "max:<id>"`. **Do not** try to edit MAX messages through the generic
  message tool. Animation uses `PUT /messages?message_id=…` internally instead.
- `progress_card` never reaches a MAX chat. To show status, post a checklist message.

### 🟢 How the staged plan animation works (v1.1.0+)
Ask the agent to split a task into stages, and it narrates a plan such as:

```
Сделаю поэтапно:
- [ ] Шаг 1. Приём задачи
- [ ] Шаг 2. Разбор вводных
- [ ] Шаг 3. Сборка результата
- [ ] Шаг 4. Проверка и отправка
```

`src/plan.ts` captures it and the channel rewrites the same message while the turn runs,
so the user watches `⬜ → 🔄 → ✅` instead of a static block at the end.

Rules that matter when operating this:
- Any message with **at least two** task-list items is captured. No prompt convention,
  no config flag, no extra tool call.
- **Capture is streaming-safe.** A later, more complete plan replaces an earlier partial
  one. The **first tool result seals** the plan, so labels cannot shift mid-animation.
- **Advancement is work-paced:** each tool result retires the current stage and promotes
  the next. It is not a blind timer, so a fast turn advances quickly and a slow one does not
  lie about progress.
- `deliver()` closes the animation — all stages become `✅`. If the final answer repeats the
  same checklist, marks are substituted in place.
- Edits are throttled to one `PUT` per **800 ms** (`STREAM_EDIT_INTERVAL_MS`).
- Set `channels.max.accounts.<id>.progress: false` to disable the whole live draft
  (including animation); the checklist then only appears in the final answer.

Troubleshooting: if the draft looks frozen mid-turn, grep the log for
`Draft edits failing` — that means `PUT /messages` is failing (usually DNS/network to
`botapi.max.ru`) and the draft is showing a stale frame. From v1.1.0 the failure is logged
at 3 consecutive errors and recovery is logged too, instead of being swallowed silently.

---

## 4. Multi-Account Setup (Multiple MAX Bots)

You can run multiple MAX bots simultaneously on a single OpenClaw gateway:

```json5
{
  channels: {
    max: {
      enabled: true,
      accounts: {
        company_bot: {
          token: "TOKEN_1",
          dmPolicy: "allowlist",
          allowFrom: ["6163830"],
          webhookUrl: "https://domain.com/max/company"
        },
        personal_bot: {
          token: "TOKEN_2",
          dmPolicy: "open"
          // Long polling by default if webhookUrl is omitted
        }
      },
      defaultAccount: "company_bot"
    }
  },
  bindings: [
    {
      agentId: "support_agent",
      match: { channel: "max", accountId: "company_bot" }
    },
    {
      agentId: "personal_agent",
      match: { channel: "max", accountId: "personal_bot" }
    }
  ]
}
```

---

## 5. Supported Commands & Interactive Menus

The plugin natively renders OpenClaw interactive inline keyboards (`inline_keyboard`):
- `/models` — Interactive provider & model selector with pagination and back buttons.
- `/model <provider/model>` — Switch active model for the current session.
- `/think` — Dynamic thinking level selector that automatically adjusts choices to the active model (`gemini`, `grok`, `claude`, `deepseek`, `qwen`).
- `/reasoning [on|off|stream]` — Toggle thought process streaming.
- `/fast [on|off|auto|status]` — Fast mode control.
- `/tts [on|off|status]` — Voice generation control.
- `/verbose [on|off|full]` — Detailed execution logs.
- `/usage [tokens|cost|full|off]` — Token usage footer.

---

## 6. Diagnostic Cheatsheet for AI Operators

When troubleshooting an unresponsive MAX bot:
1. `openclaw channels status` → Check if MAX channel is enabled and accounts are loaded.
2. `openclaw plugins list` → Check if plugin `max` is active and without errors.
3. Check gateway logs:
   ```bash
   journalctl --user -u openclaw-gateway -n 50 --no-pager | grep -i max
   ```
4. Verify token validity:
   ```bash
   curl -s -H "Authorization: YOUR_BOT_TOKEN" "https://platform-api2.max.ru/me"
   ```
   Should return JSON with bot details: `{"user_id": ..., "name": ...}`.
