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
- Full media sending and receiving (documents, images, video, audio)
- Voice notes reception & STT transcription (in Webhook mode)
- Allowlist-based access control
- Modern OpenClaw Channel Plugin architecture
- Interactive menus & inline keyboards: `/models`, `/model`, `/think`, `/fast`, `/reasoning`, `/tts`, `/verbose`, `/usage`

> 💡 **For AI Agents & Automation:** See [AI_GUIDE.md](./AI_GUIDE.md) for detailed gotchas, edge cases, and automated troubleshooting instructions.

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
