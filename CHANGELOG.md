# Changelog

All notable changes to **`agy-statusline`** are documented in this file.

---

## [1.1.0] - 2026-11-12

### Added
- **Responsive Conversation ID & Real Storage Size**: Added `getConversationInfo` (`src/session.js`) and HUD rendering (`src/statusline.js`, `scripts/statusline.sh`) showing full 36-char Conversation UUID on wide terminals, automatically compacting to 8-char short IDs on narrower panes, paired with total real conversation disk usage (`conversations/<id>.db` + `<id>.db-wal` + `transcript_full.jsonl`). Configurable via `show_conversation_id` and `show_conversation_size`.
- **Single-Pass `tmux` Fleet Version & Uptime Monitor (`src/tmux.js`, `scripts/tmux-agent-status.sh`)**: Tracks exact in-memory running versions vs. latest installed binaries on disk and true child process uptimes (`etime`) for both `agy` and Claude Code (`claude` / `X.Y.Z`) across all `tmux` panes, highlighting outdated sessions (`⬆`) on pane borders, window tabs, and `status-right`.

### Changed
- **Unified Symlinked Plugin Architecture (`install.sh`)**: Consolidated `statusLine`, `title`, and `tmux` helper paths inside `~/.gemini/config/plugins/agy-hud/`, defaulting to repository symlink mode (`--link`) on git clones so updates stay synchronized without orphaned copies in `~/.gemini/antigravity-cli/`.

---

## [1.0.0] - 2026-10-23

### Added
- Modularized the entire `agy-hud` codebase into clean, zero-dependency CommonJS modules under `src/` (`ansi.js`, `config.js`, `gitinfo.js`, `host.js`, `session.js`, `quota.js`, `quotaProbe.js`, `statusline.js`, `main.js`) with a standalone bundler (`scripts/build.js` -> `dist/agy-hud.js`).
- Added hardware & connection context detection (`MacMini`, `Laptop`, `MacStudio`, `iMac`, `MacPro` + `Local`, `SSH`) across both the Node.js HUD (`src/host.js`) and the Pure-Bash statusline (`scripts/statusline.sh`).
- Added instant `/rename` session title resolution via `history.jsonl` (supporting both `conversationId` and workspace fallback on brand-new sessions before `conversationId` is assigned), live `conversation_title` payload, and SQLite (`conversation_summaries.db`) fallback.
- Added full `tmux` Window & Pane title synchronization (`tmux select-pane -T` and `tmux rename-window`) across `src/session.js`, `scripts/title.sh`, and `scripts/statusline.sh`, plus automatic `~/.tmux.conf` format upgrade in `install.sh`.
- Added `scripts/title.sh` for real-time terminal tab/window title updates (OSC 1, OSC 2, OSC 1337, `tmux select-pane`, `tmux rename-window`) in `dot` and `emoji` styles.
- Added `install.sh` one-command installer supporting `--hud` and `--bash` modes, plus unit tests, shell integration tests, and a 10,000-iteration soak/fuzz test suite (`test/agy-hud.test.js`, `test/scripts.test.js`).
