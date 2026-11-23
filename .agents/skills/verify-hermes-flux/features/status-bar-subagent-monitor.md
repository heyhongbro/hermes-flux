# Status bar and subagent monitor

Provides a docked overall session status column (`#flux-inspector-pod[data-pod-mode="status|subagent|files"]`), a single Titlebar toggle (`#toggle-inspector-btn`), a subagent lifecycle/telemetry dashboard, and a subagent execution stream drill-down view isolated across all three conversation modes.

## Sub-features

- `titlebar-status-toggle`: single `#toggle-inspector-btn` toggles docked `status <-> closed` and shows a 6px pure geometry `.titlebar-status-dot` only when `runningSubagentCount > 0` (zero text/digits).
- `docked-status-pod`: `#flux-inspector-pod[data-pod-mode="status"]` pushes `#flux-middle-pod` inward without floating over messages or `#dock-prompt-input`, while `#flux-inspector-rail` keeps only the Files tab unhighlighted.
- `three-mode-status`: `scratchpad`/`bot_forever_chat` show content-hugging card (`height: auto`), agent avatar + name, clickable `cwd` and conditional `branch`, single-line subagent rows (default max `3` rows behind `显示更多`, hover/touch-visible neutral stop icon, monochrome right-aligned status without seconds), inline usage strip, direct-click context gauge + config-driven threshold tick + read-only breakdown drawer (no compress button); `group_room` shows read-only `member_activity` and hides context/usage telemetry.
- `subagent-detail-view`: custom `aria-haspopup="listbox"` switcher (`Esc` closes listbox only), clickable file chips, read-only `ConversationMessageList` (`#msg-*` duplicate IDs forbidden, zero edit/rollback buttons), active `steer`/`interrupt` controls vs terminal summary copy + quote-to-composer, and desktop fullscreen toggle.
- `files-back-to-status`: opening files from Status Bar preserves `returnTo: 'status'` with `#btn-inspector-back-status`, and auto-collapses the file tree on `390×844` mobile selection.

## Driving it with CDP

- Verify via `node --test packages/desktop/__tests__/cdp/status-bar-subagent-monitor-cdp.test.mjs` against real `packages/desktop/dist/renderer/index.html`.
- Inspect `artifacts/verification/status-bar-subagent-monitor/*.png` visually and confirm `evidence.json` passes desktop (`1440×900` dark & light) and mobile (`390×844`) geometry and functional assertions.
