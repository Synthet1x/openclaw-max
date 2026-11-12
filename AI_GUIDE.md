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

The channel owns the checklist and redraws it in place while the turn runs, so the user
watches `⬜ → 🔄 → ✅` instead of a static block at the end.

**Two sources, in priority order:**

1. **Core plan stream (`onPlanUpdate`) — authoritative.** OpenClaw projects the
   `progress_card` tool into a structured plan event:
   ```ts
   { steps: [{ step: "Сбор данных", status: "in_progress" }], title: "…" }
   // status: "pending" | "in_progress" | "completed"
   ```
   Real statuses, no text parsing, cannot disagree with what the agent did.
2. **Narration capture — fallback.** Any answer with **at least two** task-list items
   (`- [ ]` / `- [x]` / `- [~]`) is captured and animated the same way.

**Two channel flags make this work — do not remove them:**

| Flag | Why |
|---|---|
| `disableBlockStreaming: false` | `agents.defaults.blockStreamingDefault` defaults to `"off"`; with it off the core never calls `onPartialReply`, so no intermediate frames exist for the narration path. |
| `suppressDefaultToolProgressMessages: true` | The core gates plan events behind `requiresToolSummaryVisibility`. With verbose off (default) tool summaries are hidden, so **every plan event is discarded upstream** before the plugin runs. Declaring this flag states the channel owns its own progress UI. |

Without the second flag `onPlanUpdate` is wired but silently never invoked — the exact
failure mode observed on 2026-11-11, where `Plan update` stayed at zero across restarts
while `Start draft created` fired normally.

**Behaviour rules:**
- **Core plan wins** when both sources are present, because it carries real statuses.
- **Capture is streaming-safe.** A later, more complete plan replaces an earlier partial
  one. The **first tool result seals** the plan, so labels cannot shift mid-animation.
- **Advancement is work-paced:** each tool result retires the current stage and promotes
  the next. It is not a blind timer, so a fast turn advances quickly and a slow one does not
  lie about progress.
- `deliver()` closes the animation — all stages become `✅`. If the final answer repeats the
  same checklist, marks are substituted in place.
- Edits are throttled to one `PUT` per **800 ms** (`STREAM_EDIT_INTERVAL_MS`). The API
  allows roughly two messages per second per dialog.
- Set `channels.max.accounts.<id>.progress: false` to disable the whole live draft
  (including animation); the checklist then only appears in the final answer.

**Requirement:** the agent must emit `progress_card`. A markdown checklist typed into the
answer body renders as static glyphs but carries no plan event, so it does not animate.
That is core behaviour, not a plugin limitation — do not "fix" it by parsing answer text
alone.

### 🟢 Buried final answer fix (v1.1.1+)

The live draft is edited in place, so if the user writes while a turn runs, their
messages land **below** the draft and an in-place final edit would leave the answer
buried mid-history. Since v1.1.1 the channel counts inbound messages per account+chat
and snapshots the counter when each draft opens:

- **User wrote during work** → the draft is deleted (`DELETE /messages`) and the final
  answer is sent as a new message at the bottom of the chat.
- **Nobody wrote** → in-place edit, exactly as before.
- **Delete fails** → fallback to the in-place edit (never lose or duplicate the answer).

The baseline is re-captured for every new draft (each work segment), partial answers
frozen by steering get the same treatment, and a repeated final callback is a no-op.
Offline tests: `npm test` (fake MAX client, no network).

### 🟡 Gotcha 6: bots cannot use server-side emoji animation
MAX clients animate some Unicode emoji on their own, but that does **not** reach bot
messages:

- A symbol sent through Bot API arrives as plain text with **zero attachments**
  (`✅` → U+2705), and the client renders it statically for bots.
- The attachment types MAX accepts are `image`, `video`, `audio`, `file`, `sticker`,
  `contact`, `inline_keyboard`, `share`, `location` — there is no "animated emoji" type.
- Therefore frame-by-frame redraw is the only way to animate in-line glyphs. Probed
  2026-11-11 with a 24-emoji set; the user confirmed none animated for the bot.

Troubleshooting: if the draft looks frozen mid-turn, grep the log for
`Draft edits failing` — that means `PUT /messages` is failing (usually DNS/network to
`botapi.max.ru`) and the draft is showing a stale frame. From v1.1.0 the failure is logged
at 3 consecutive errors and recovery is logged too, instead of being swallowed silently.
If the checklist never moves but the draft updates, grep for `Plan update` — a zero count
means the visibility gate is blocking the plan stream.

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
