# Changelog

All notable changes to **`agy-statusline`** are documented in this file.

---

## [1.0.0] - 2026-10-23

### Added
- Modularized the entire `agy-hud` codebase into clean, zero-dependency CommonJS modules under `src/` (`ansi.js`, `config.js`, `gitinfo.js`, `host.js`, `session.js`, `quota.js`, `quotaProbe.js`, `statusline.js`, `main.js`) with a standalone bundler (`scripts/build.js` -> `dist/agy-hud.js`).
- Added hardware & connection context detection (`MacMini`, `Laptop`, `MacStudio`, `iMac`, `MacPro` + `Local`, `SSH`) across both the Node.js HUD (`src/host.js`) and the Pure-Bash statusline (`scripts/statusline.sh`).
- Added instant `/rename` session title resolution via `history.jsonl` (supporting both `conversationId` and workspace fallback on brand-new sessions before `conversationId` is assigned), live `conversation_title` payload, and SQLite (`conversation_summaries.db`) fallback.
- Added full `tmux` Window & Pane title synchronization (`tmux select-pane -T` and `tmux rename-window`) across `src/session.js`, `scripts/title.sh`, and `scripts/statusline.sh`, plus automatic `~/.tmux.conf` format upgrade in `install.sh`.
- Added `scripts/title.sh` for real-time terminal tab/window title updates (OSC 1, OSC 2, OSC 1337, `tmux select-pane`, `tmux rename-window`) in `dot` and `emoji` styles.
- Added `install.sh` one-command installer supporting `--hud` and `--bash` modes, plus unit tests, shell integration tests, and a 10,000-iteration soak/fuzz test suite (`test/agy-hud.test.js`, `test/scripts.test.js`).
