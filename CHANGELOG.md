# Changelog

All notable changes to `@synthet1x/openclaw-max` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [1.0.13] - 2026-09-17

### Changed
- Refined and clarified descriptions across `package.json`, `openclaw.plugin.json`, `README.md`, and ClawHub metadata to explicitly state that voice notes require Webhook mode due to upstream MAX platform limitations.

---

## [1.0.12] - 2026-09-16

### Added
- Added official MAX 512x512 high-resolution icon (`assets/icon.png`) for ClawHub package catalog and OpenClaw Control UI branding.
- Added comprehensive `AI_GUIDE.md` for AI operators and automated deployment.

---

## [1.0.11] - 2026-09-16

### Fixed
- Fixed SQLite session query isolation (`%:max:%` prefix matching) so Telegram sessions no longer overwrite active MAX model settings in `/think` menus.
- Added explicit `accountId` to `agentId` mapping via `openclaw.json` bindings.
- Improved compound model identifier parsing (`provider/model`).

---

## [1.0.10] - 2026-09-16

### Added
- **First User Auto-Claim Ownership**:
  - Automatically promotes the first user who sends a direct message to bot owner status if no MAX owner is configured.
  - Automatically adds `max:<userId>` to OpenClaw's global `commands.ownerAllowFrom` in `openclaw.json`.
  - Automatically adds the user to the account's `allowFrom` whitelist if it was empty.
  - Locks ownership claim window once the first owner is established, ensuring zero-friction out-of-the-box setup without compromising security.

---

## [1.0.9] - 2026-09-16

### Added
- **Dynamic Thinking Level Menu (`/think`)**:
  - Automatically queries the active session's model and provider from OpenClaw's SQLite database (`node:sqlite`).
  - Displays currently active thinking level with checkmark (`✓`) and active model info.
  - Generates buttons tailored to the specific model family:
    - **Google / Gemini**: `default`, `off`, `minimal`, `low`, `medium`, `high`, `adaptive`
    - **xAI Grok 4.6**: `default`, `off`, `low`, `medium`, `high`, `xhigh`
    - **xAI Grok 4.3 / 4.5**: `default`, `off`, `minimal`, `low`, `medium`, `high`
    - **Claude / Anthropic**: `default`, `off`, `low`, `medium`, `high`
    - **DeepSeek / Qwen / others**: `default`, `off`, `low`, `medium`, `high`, `max`

---

## [1.0.8] - 2026-09-16

### Added
- Extended `/think` options to include `Default` and `Adaptive` modes for reasoning-capable models.

---

## [1.0.7] - 2026-09-16

### Added
- **Interactive Inline Menus for System Commands**:
  - Added interactive inline keyboards for parameterless slash commands:
    - `/reasoning`: `on`, `off`, `stream`
    - `/fast`: `on`, `off`, `auto`, `default`, `status`
    - `/verbose`: `off`, `on`, `full`
    - `/usage`: `off`, `tokens`, `full`, `cost`
    - `/tts`: `on`, `off`, `status`
    - `/elevated`: `off`, `on`, `ask`, `full`
    - `/tools`: `compact`, `verbose`
    - `/commands`: pagination (`◀ Prev`, `Page`, `Next ▶`)

---

## [1.0.6] - 2026-09-16

### Added
- Extended automatic bot commands registration in MAX Bot API (`PATCH /me/commands`) to 27 essential slash commands upon startup.

---

## [1.0.5] - 2026-09-16

### Added
- **Two-Level Model Browser (`/models`)**:
  - Provider selection menu (`/models`).
  - Model selection sub-menu (`/models <provider>`) with inline buttons per model.
  - Pagination controls (`◀ Prev`, `Page`, `Next ▶`) and `« Back to providers` button.
  - Direct selection via `/model <provider>/<model>` callbacks.

---

## [1.0.4] - 2026-09-16

### Added
- **Inline Keyboard & Callback Engine**:
  - Full support for interactive inline keyboards (`inline_keyboard` attachments).
  - Callback query handler (`message_callback` update type) with instant answer acknowledgment.
  - Streaming draft typing status updates.

---

## [1.0.3] - 2026-09-16

### Fixed
- **Long-polling Stability**:
  - Immediate marker advancement preventing duplicate update reprocessing.
  - Error backoff logic preventing long-polling loops on network hiccups.
  - Robust voice note and typing indicators.

---

## [1.0.2] - 2026-09-16

### Added
- Native inbound media storage integration under `~/.openclaw/media/inbound`.

---

## [1.0.1] - 2026-09-14

### Fixed
- Polling lifecycle and webhook coexistence improvements.

---

## [1.0.0] - 2026-09-14

### Added
- Initial release of OpenClaw MAX channel plugin.
- Direct messages and group chats support.
- Media upload and download (images, files, audio, voice).
- Markdown formatting converter for MAX messenger format.
- Multi-account support.
