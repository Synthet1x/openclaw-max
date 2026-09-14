# @synthet1x/openclaw-max

MAX messenger (max.ru) channel plugin for [OpenClaw](https://github.com/openclaw/openclaw).

Production-ready connector with full inbound/outbound attachment support (documents, audio/voice messages, video, images), quote/forward unwrapping (`msg.link`), automatic webhook deduplication, and out-of-the-box Long Polling for home setups.

---

## Credits & Acknowledgments

This project is a community-driven fork of the original [@olegbalbekov/openclaw-max](https://github.com/olegbalbekov/openclaw-max) by [Oleg Balbekov](https://github.com/olegbalbekov).

### What's improved in this fork:
1. **Full attachment support:** Handles arbitrary documents (PDF, DOCX, XLSX, ZIP), audio files, and voice notes — not just images.
2. **Audio & Voice notes:** Automatic download, MIME detection, and forwarding to OpenClaw STT/Whisper for voice interactions.
3. **Forward & reply unwrap (`unwrapLink`):** Extracts quotes, original senders, and nested attachments from forwarded messages.
4. **Automatic webhook deduplication:** In-memory TTL cache preventing double processing from network retries.
5. **Cross-platform:** Tested and verified on both Linux and Windows environments.
6. **Modern OpenClaw manifest:** Includes `channelConfigs` and `uiHints` to avoid gateway validation warnings.

---

## Features

- DM and group chat support
- Long polling (default, works without public IP/domain) and webhook modes
- Streaming replies with typing indicator
- Full media sending and receiving (images, audio, video, documents)
- Allowlist-based access control
- Modern OpenClaw Channel Plugin architecture

## Installation

### 1. Install the plugin

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
| `webhookUrl` | string | — | Webhook URL (optional, uses long polling if not set) |
| `webhookSecret` | string | — | Webhook secret for request verification |
| `httpProxy` | string | — | Optional HTTP(S) proxy for MAX API traffic, e.g. `http://user:pass@host:port` |

## License

MIT © [Oleg Balbekov](https://github.com/olegbalbekov) & [Boris Orlyuk](https://github.com/Synthet1x)
