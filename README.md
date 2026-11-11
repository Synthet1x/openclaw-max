# @synthet1x/openclaw-max

MAX messenger (max.ru) channel plugin for [OpenClaw](https://github.com/openclaw/openclaw).

Production-ready connector with full inbound/outbound document and media support (documents, images, video, and webhook-based voice notes), quote/forward unwrapping (`msg.link`), automatic webhook deduplication, and zero-config Long Polling for home setups.

---

## Credits & Acknowledgments

This project is a community-driven fork of the original [@olegbalbekov/openclaw-max](https://github.com/olegbalbekov/openclaw-max) by [Oleg Balbekov](https://github.com/olegbalbekov).

### What's improved in this fork:
1. **Full document & media attachments:** Handles arbitrary files (PDF, DOCX, XLSX, ZIP, video, images) across both Webhook and Long Polling modes.
2. **Audio & Voice notes (Webhook only):** Automatic download, MIME detection, and forwarding to OpenClaw STT/Whisper. *(Note: Voice messages require Webhook mode; in Long Polling mode, the MAX platform strips audio content from `message_created` events due to an upstream platform limitation).*
3. **Forward & reply unwrap (`unwrapLink`):** Extracts quotes, original senders, and nested attachments from forwarded messages.
4. **Automatic webhook deduplication:** In-memory TTL cache preventing double processing from network retries.
5. **Cross-platform:** Tested and verified on both Linux and Windows environments.
6. **Modern OpenClaw manifest:** Includes `channelConfigs` and `uiHints` to avoid gateway validation warnings.

---

## Features

- DM and group chat support
- Long polling (default, works without public IP/domain) and Webhook modes
- Streaming replies with typing indicator
- **Live staged plan animation:** checklists advance `⬜ → 🔄 → ✅` inside one editable message
- Markdown task lists rendered as visible checklists (MAX has no native checkbox)
- Full media sending and receiving (documents, images, video, audio)
- Voice notes reception & STT transcription (in Webhook mode)
- Allowlist-based access control
- Modern OpenClaw Channel Plugin architecture
- Interactive menus & inline keyboards: `/models`, `/model`, `/think`, `/fast`, `/reasoning`, `/tts`, `/verbose`, `/usage`

> 💡 **For AI Agents & Automation:** See [AI_GUIDE.md](./AI_GUIDE.md) for detailed gotchas, edge cases, and automated troubleshooting instructions.

## Live Staged Plan Animation

MAX has no native checkbox entity and no message-editing UI of its own, so a
"live" checklist is built from two primitives the Bot API does expose:

1. `PUT /messages?message_id=…` rewrites one message in place;
2. the glyphs `⬜` / `🔄` / `✅` / `⏭️` read as a checklist on every MAX client.

The channel owns the checklist and redraws it as work progresses, so the user
watches `⬜ → 🔄 → ✅` instead of receiving a static block at the end.

### Two sources, in priority order

**1. Core plan stream (authoritative).** OpenClaw projects the `progress_card`
tool into a structured plan event carrying real statuses:

```ts
{ steps: [{ step: "Сбор данных", status: "in_progress" }], title: "…" }
// status: "pending" | "in_progress" | "completed"
```

Handled via `onPlanUpdate`. No text parsing, no wording drift, and it cannot
disagree with what the agent actually did.

**2. Narration capture (fallback).** Any answer carrying at least two task-list
items is captured and animated the same way:

```
Сделаю поэтапно:
- [ ] Шаг 1. Приём задачи
- [ ] Шаг 2. Разбор вводных
- [ ] Шаг 3. Сборка результата
- [ ] Шаг 4. Проверка и отправка
```

→ redrawn in place as:

```
✅ Шаг 1. Приём задачи
🔄 Шаг 2. Разбор вводных
⬜ Шаг 3. Сборка результата
⬜ Шаг 4. Проверка и отправка
```

### Design notes

- **Core plan wins.** When both sources are present the structured one is used,
  because it carries real statuses rather than inferred ones.
- **Streaming-safe capture.** While the model is still emitting a plan, a more
  complete later version replaces the earlier one. The first tool result seals
  it so labels cannot shift mid-animation.
- **Work-paced, not timer-paced.** Each tool result retires the current stage and
  promotes the next, so the checklist reflects real progress rather than elapsed
  time.
- **Closed on delivery.** A finished turn marks every stage `✅`.
- **Throttled edits.** At most one `PUT` per 800 ms, to respect MAX rate limits.
  The API allows roughly two messages per second per dialog.

### Requirements and limits

- Animation needs the agent to emit `progress_card`. A markdown checklist typed
  into the answer body renders as static glyphs and carries no plan event, so it
  does not animate. That is core behaviour, not a plugin limitation.
- Two channel-level flags make it work, both set by the plugin: `disableBlockStreaming: false`
  and `suppressDefaultToolProgressMessages: true`. Without the second one the
  core discards plan events whenever tool summaries are hidden, which is the
  default.
- **Server-side emoji animation is not available to bots.** MAX clients animate
  some Unicode emoji, but a symbol sent through Bot API arrives as plain text
  with zero attachments and is rendered statically for bot messages. To animate
  in-line glyphs the channel must redraw frames itself.
- Verified 2026-11-11: `Plan update: 4 steps` on every `progress_card` update,
  24 consecutive draft edits with zero `editMessage error`.

## Installation

### 1. Install the plugin

**From ClawHub (Official OpenClaw Registry):**
```bash
openclaw plugins install clawhub:@synthet1x/openclaw-max
```

**From NPM:**
```bash
openclaw plugins install @synthet1x/openclaw-max
```

Or manually — clone/copy the plugin directory into `~/.openclaw/extensions/max/` and add to your config:

```json5
{
  plugins: {
    load: {
      paths: ["~/.openclaw/extensions/max"]
    },
    entries: {
      max: { enabled: true }
    }
  }
}
```

> **Important:** Do NOT add `plugins.allow` unless you explicitly need it. When `plugins.allow` is set, it acts as a strict allowlist and will block all bundled plugins (including Telegram) that are not listed. Use `plugins.entries` instead to enable/disable individual plugins.

### 2. Get a MAX bot token

1. Go to [business.max.ru](https://business.max.ru) and create a bot
2. Copy the bot token

### 3. Configure OpenClaw

Add to `~/.openclaw/openclaw.json`:

```json5
{
  channels: {
    max: {
      enabled: true,
      token: "YOUR_BOT_TOKEN_HERE",
      dmPolicy: "allowlist",         // "open" | "allowlist" | "closed"
      allowFrom: ["YOUR_USER_ID"],   // MAX user IDs — must be strings
      // webhookUrl: "https://your-domain.com/max/webhook", // Required for voice notes (MAX platform limitation)
    }
  },
  bindings: [
    {
      agentId: "main",
      match: { channel: "max", accountId: "default" }
    }
  ]
}
```

### 4. Restart the gateway

```bash
sudo systemctl restart openclaw
# or
openclaw gateway restart
```

### 5. Verify

```bash
openclaw channels status
```

Should show: `MAX default: enabled, dm:allowlist, allow:YOUR_USER_ID`

## Configuration reference

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `token` | string | required | MAX Bot API token |
| `enabled` | boolean | `true` | Enable/disable channel |
| `dmPolicy` | string | `"allowlist"` | DM access policy: `open`, `allowlist`, `closed` |
| `allowFrom` | string[] | `[]` | MAX user IDs allowed to DM (when dmPolicy=allowlist) |
| `groupPolicy` | string | `"allowlist"` | Group chat access policy: `open`, `allowlist`, `closed` |
| `groupAllowFrom` | string[] | `[]` | MAX user IDs allowed in group chats (when groupPolicy=allowlist) |
| `webhookUrl` | string | — | Webhook URL (optional; required for voice notes; uses long polling if omitted) |
| `webhookSecret` | string | — | Webhook secret for request verification |
| `httpProxy` | string | — | Optional HTTP(S) proxy for MAX API traffic, e.g. `http://user:pass@host:port` |

## License

MIT © [Oleg Balbekov](https://github.com/olegbalbekov) & [Boris Orlyuk](https://github.com/Synthet1x)
