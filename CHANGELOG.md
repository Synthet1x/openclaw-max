# Changelog

All notable changes to `@synthet1x/openclaw-max` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [1.1.0] - 2026-11-11

### Added
- **Staged plan animation.** When the agent narrates a checklist plan
  (`- [ ]` / `- [x]` / `- [~]`), the channel now captures it and advances the
  stages live inside one editable message: `⬜ → 🔄 → ✅`. Previously a plan was
  rendered once as static glyphs and never moved, which read as "checkboxes
  don't animate".
  - New module `src/plan.ts`: pure state machine (`StageAnimator`) plus
    `extractPlan` / `extractPlanHeader` / `hasAnimatablePlan` / `substitutePlan`.
    No network, no timers, no logging — trivially unit-testable.
  - A plan is captured from the model's own narration, so no extra tool call or
    prompt convention is required; any message carrying at least two checklist
    items qualifies.
  - While the plan is still streaming in, later (more complete) versions replace
    earlier ones. The first tool result **seals** the plan, after which it cannot
    change mid-animation.
  - Each tool result retires the current stage and promotes the next, so the
    checklist advances at the pace of real work rather than on a blind timer.
  - `deliver()` closes the animation: every stage becomes `✅` and, when the
    final answer repeats the same checklist, the marks are substituted in place.

### Fixed
- **Block streaming is now enabled for MAX, scoped to this channel.** This is what
  actually makes the animation possible. `agents.defaults.blockStreamingDefault`
  defaults to `"off"`, and with it off the core never invokes `onPartialReply`, so
  the whole answer — including any narrated checklist — arrived only at the end in
  `deliver()`. The animator therefore had no intermediate frames to render and the
  checkboxes appeared once, already final. Setting `disableBlockStreaming: false`
  in `replyOptions` turns streaming on for MAX only, without flipping it globally
  for every channel on the gateway.

  Diagnosis evidence (2026-11-11, live): after a restart with v1.1.0 loaded,
  `Start draft created` appeared but `Streaming started` and `Plan captured`
  never fired once — proving `onPartialToken` was never called.
- **Draft no longer freezes silently on network failure.** Edits were wrapped in
  `.catch(() => {})`, so a failed `PUT /messages` left the draft stuck on a stale
  frame while the turn kept running — indistinguishable from a hung bot. Edits
  now go through `applyEdit()`, which counts consecutive failures, logs a warning
  at 3, and logs recovery. Observed live on 2026-11-11: 13 consecutive
  `editMessage error: fetch failed` during a DNS blip, with the user asking "did
  it hang?" because the draft showed nothing.
- **Stale plan across work segments.** A steered follow-up or a second work
  segment now resets the animator, header and failure counter, so the previous
  turn's checklist can never animate into the next answer.

### Note
- `capabilities.edit` remains `false`: OpenClaw's generic `message(action:"edit")`
  path is still unsupported for MAX. Animation uses `PUT /messages` directly, so
  it is unaffected. Exposing generic editing is tracked separately.
- Verified with `tsc --noEmit` and a clean `tsc` build; takes effect after a
  gateway restart.

---

## [1.0.19] - 2026-11-03

### Fixed
- **Checklist coverage widened.** `renderTaskList()` now also converts:
  - ordered lists: `1. [ ]`, `1) [X]` (previously only `-`, `*`, `+`)
  - lines without a space after the bracket: `- [ ]step`
  - empty items: `- [ ]` → `⬜`
  - trailing whitespace is trimmed from the label
- **Agent hint now advertises checklists.** `messageToolHints` lists bullet/ordered
  lists and the `- [ ]` / `- [x]` / `- [~]` / `- [-]` task-list marks, states that
  tables and fenced code blocks are unsupported, and warns that `progress_card`
  never reaches a MAX chat (use a checklist message instead). Previously the hint
  named only bold/italic/strikethrough/code/links, so agents never produced
  checklists at all — the actual cause of the "checkboxes don't render" report.

### Note
- Verified locally against `dist/`; takes effect after a gateway restart.

---

## [1.0.15] - 2026-10-19

### Added
- **Live progress draft (like Telegram's `progress` streaming mode)**: while the agent runs, the channel now keeps one editable status message showing what it is doing.
  - Shows `⏳ Работаю…` plus the most recent tool-activity lines (last 6 shown, last 20 kept).
  - Subscribes to tool results via `onToolResult` with `forceToolResultProgress: true`, so activity appears without requiring `/verbose`.
  - Tool lines stay inside the draft instead of arriving as separate chat messages.
  - The draft yields to the answer as soon as answer text starts streaming, so it never fights the reply preview.
  - Throttled edits (min 800 ms apart) to respect MAX API rate limits.

### Changed
- New per-account config flag `progress` (default `true`) to enable or disable the live progress draft: set `channels.max.accounts.<id>.progress: false` to turn it off.
- `resolveAccount` now surfaces the `progress` flag on the resolved account.

---

## [1.0.14] - 2026-09-19

### Security & Access Control
- **SSRF & Token Leak Prevention**:
  - `downloadFile` in `client.ts` now strictly restricts `Authorization: <token>` headers to official `*.max.ru` domains.
  - Added loopback (`127.0.0.1`, `localhost`) and private RFC1918 IPv4/IPv6 address filtering to prevent SSRF attacks against internal network resources.
- **Timing-Safe Webhook Secret Verification**:
  - `validateSecret` in `webhook-handler.ts` now uses `crypto.timingSafeEqual` to prevent timing side-channel attacks on `x-max-bot-api-secret`.
- **Primary Owner & Restricted Multi-User Architecture**:
  - First authorized user added to `allowFrom` (via initial setup or pairing code) is automatically granted primary Owner rights (`commands.ownerAllowFrom`).
  - Subsequent users who join `allowFrom` later (family, colleagues, guest invites) receive standard restricted permissions:
    - Administrative commands and menus (`/elevated`, `/think`, `/fast`, `/reasoning`) are strictly gated and restricted to the primary Owner.
    - Subsequent users cannot alter models or privilege levels until explicitly promoted by the primary Owner.
- **Dependency Security**:
  - Patched high-severity vulnerability in `undici` via `npm audit fix`.

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
