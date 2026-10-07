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

## Usage % accuracy (important)
Claude's `plan-usage-history.json` is only written occasionally (hours apart), so Tokkie never shows it raw as "now". `core/calibrate.js` derives *tokens per 1%* from consecutive readings vs tokens seen in between, then shows `last reading + tokens since / k` (labelled "live estimate · Claude said X% Nh ago"). Validated on real data: 21.4% (5 h old) → 34.2% vs Claude's page 34.9%. Enterprise accounts see a *spend limit* (dollars; the `xu` key = % of it); cost-state records in transcripts are only flushed at session end so they can't bridge the gap. Claude Code's desktop Code tab never calls the status-line hook (no ~/.tokkie/rate_limits.json), so that path only helps terminal/IDE users.

## v1.0.4: bridge, dollars, Dock, personality
- **Bridge** (`bridge/`, a Claude Code plugin with function hooks, validated by `claude plugin validate` / `claude plugin test bridge`). It writes `~/.tokkie/bridge/<session>.json` (exact `cost.usd`, context, agents, per-prompt cost deltas) and `rate_limits.json` when `rateLimits` is non-empty (Enterprise: always empty). It's installed by `setup.installBridge` through `env.CLAUDE_CODE_PLUGIN_DIRS`. The desktop Code tab honours this; the status-line hook did not. Connecting removes the old status-line hook.
- **Spend ledger** (`core/spend.js`): per-session cost deltas in 5-minute buckets, kept 45 days. The first sight of a session is its baseline.
- **Dollar mode** (`engine._live`): when `spendLimitUsd > 0` and the bridge has been running since the anchor reading, `extra%` = anchor + Code dollars since ÷ limit + non-bridge tokens ÷ k. Cowork's `audit.jsonl` `total_cost_usd` is NOT usable: it summed to $37k against Claude's $1.77.
- **Pace** (`core/pace.js`): pace = used% − elapsed%. Monthly periods reset at 00:00 UTC on `resetDay`. The 5h period comes from the local block guess when no reset time is known.
- **Renderer**:
  - Layouts are Dock, Pills and Pet only. The Dock sits to the right of the pet, and `layoutPayload` measures its height.
  - `PERSONALITY` in `pet.js` sets the idle face, self-emote cadence, hover and poke reactions, and the bored/sleep minutes.
  - `evolution.display` pins a form; growing up then shows a note instead of transforming.

## Claude bar (v1.0.5–1.0.9)
- The app writes `~/.tokkie/band.json` (`{updatedAt, show, items:[{k,label,value,tone,tip}], alert, avatar}`) and the bridge draws it as an `AbovePrompt` band. A file older than 2 minutes means Tokkie is closed, so no bar is drawn.
- Lessons from the user's screenshots:
  - Bordered `Box` chips render tall on desktop.
  - `Svg isInteractive` draws in a white sandboxed frame that ignores the theme, and its `<title>` tooltips didn't show.
  - What works: borderless rows of a small `Svg` icon plus `Text`, with hover-reveal explanation lines. Those lines are `display:"none"` with `hover:{scope, display:"flex"}`, and the chip and its tip share a `scope`.
  - The terminal resolves `Svg` to an empty Box, so branch on `e.surface === 'terminal'` and use glyphs there.
- Packaging: electron-builder drops `*.d.ts`, so `bridge/` ships via `extraResources`, with `BRIDGE_SOURCE = process.resourcesPath/bridge` when packaged.

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
