# PROJECT.md — Tokkie (anchor file for future sessions)

**Renamed:** Larrie → Munch → Tokkie (legacy.js migrates userData, ~/.<old> dir and the connected status-line hook).

**What:** Electron desktop pet (mac + Windows) tracking Claude Code/Cowork usage, plan-limit %, and predicting prompt duration vs the user's finish-by time. See PRODUCT.md for brief/design principles, README.md for usage.

## State (as of build session 1)
- Complete v1: core engine, UI (4 tabs), procedural monster generator, emotions, statusline connect, packaging config, CI workflow.
- Verified: 63 unit/integration tests (`npm test`), 36 real-app e2e checks (`npm run e2e`), packaged mac .app e2e passes, independent code review done and P0/P1 findings fixed.
- NOT verified: Windows runtime (no Windows machine; CI builds only), notarised/signed macOS build, real Claude Code actually invoking the statusline hook with the live payload (hook is unit-tested against the documented schema; user must click Connect), Cowork `rate_limits` (Cowork has no statusline → % comes from Claude Code readings).

## Key decisions (and why)
- **Data source = transcript JSONL, not APIs**: `~/.claude/projects/**` and Claude app `local-agent-mode-sessions/**/.claude/projects` (Cowork writes the same format). Zero auth, works offline. `audit.jsonl` is skipped (duplicates).
- **Dedupe by assistant `message.id`, keep max output** – Claude Code rewrites a message while streaming.
- **Usage % source #1 (preferred): the Claude desktop app's own `<app data>/plan-usage-history.json`** (keys fh=5h, sd=7d, xu=extra usage; ~15 min cadence; includes Chat; found by inspecting the app, not a public API — may change). Source #2: statusline `rate_limits`. between readings extrapolate with a learned tokens-per-100% calibration (`limits.js`). Weighted tokens = in + out + cacheWrite + 0.1·cacheRead.
- **Predictor** (`predict.js`): ridge regression, features ln(chars), ln(wording hint), ln(previous run); coefficients bounded ≥0; σ inflated 1.12 after backtest (p90 93%, p25–75 44%). Typical error is still large — UI must always show ranges + confidence.
- **Statusline hook never replaces the user's status line**: chains to the previous command; absolute node path resolved via login shell, else the app binary `--tokkie-statusline`.
- **Pet position persisted as the pet's own screen position**, window anchored by `petRect` so the panel opening never moves the pet; panel opens above/below depending on screen half.
- **Accent colour = pet's OKLCH hue**; neutrals tinted blue-violet; light/dark follow OS.
- npm 11 skips Electron's postinstall → `scripts/ensure-electron.js` runs before start/dist.

## Evolution
`core/evolution.js` (thresholds 0/2M/10M/40M headline tokens → Hatchling/Junior/Champion/Mega; chub level 0–2 inside a form) + `monster.evolveSpec(base, stage, fat)` (pure; Junior = the generated creature; Mega gets a crown). Engine counts tokens from `settings.evolution.start` (set on first run, so history isn't food) and banks pruned messages into `archived`. Renderer celebrates when `stage > stageSeen` (also on next launch if it grew while closed). QA: `TOKKIE_EVO_EATEN=<n>` forces a total; `window.__tokkie.previewForm(stage, fat)`; `dev/forms.html` contact sheet.

## Attention alerts
`renderer/alerts.js` (pure, unit-tested): "done" = a run ≥15 s finished and isn't acknowledged (click bubble/pet, open panel, or a new run); "ask" = a running task silent for >60 s (may be waiting for approval — heuristic, worded with "may"). Acknowledging is per-run. Bubble zone (44 px) is reserved above the pet in the window layout; QA hook `window.__tokkie.forceAlert('done'|'ask')`.

## Pitfalls learned the hard way
- **Electron ≥ 40: `clipboard.readText()` (and writeText) are async in the main process** — returns a Promise. Always `await` (see `readClipboardText`). This silently broke the hotkey and clipboard-watch until caught; the global `uncaughtException` handler hid it. e2e now exercises the real clipboard path.
- macOS blocks synthetic key events (osascript/CGEvent) without Accessibility permission, so the OS-level shortcut delivery can't be e2e-tested; the handler path is (`fireHotkey`).
- Persisted settings override new defaults — any default change needs a migration (see the old ⌘⇧L → ⌘⌥⇧L migration in main.js).

## Conventions
- `src/core/*` CommonJS, no Electron imports; renderer = ES modules, no bundler, CSP `script-src 'self'`.
- Visual QA: `src/renderer/dev/{gallery,states}.html` + mock backend (`dev/mock.js`, auto-loaded when `window.tokkie` is absent). Serve `src/` statically.
- QA env vars: `TOKKIE_USERDATA`, `TOKKIE_SHOT`, `TOKKIE_TAB`, `TOKKIE_EST`, `TOKKIE_E2E`, `TOKKIE_DEBUG`.

## Known gaps / next steps
- Windows manual test; code signing + auto-update; hotkey "auto select-all+copy" (needs accessibility perms); per-weekday finish times; Windows tray icon sizing check.
- Open reviewer P2s not done: display-edge pet jump when clamped (cosmetic), async directory discovery on huge Cowork trees.
