# Tokkie

A tiny always-on-top pixel pet that watches your **Claude Code** and **Cowork** usage, so you never have to open Settings to check it.

- **Live usage at a glance** – your real plan usage as "% used" (same as Claude's Settings → Usage), tokens today / last 5 hours, burn rate, and a 60-minute activity chart.
- **"Should I hit enter?"** – copy your prompt, press the shortcut, and Tokkie estimates how long it will run, how many tokens it will use, and whether it will finish before you want to be done for the day.
- **It taps you on the shoulder** – when Claude finishes (or goes quiet and may be waiting for your approval) a red **“Done — awaiting your response”** bubble and a hopping pet with a blinking “!” appear until you click it. Heads-down in other work? You'll notice.
- **It evolves** – your pet eats the tokens you use and grows: **Hatchling → Junior → Champion → Mega**, getting visibly rounder along the way, with a flash-and-sparkle evolution moment. Unreached forms show as mystery silhouettes in the Pets tab. (Growth starts the day you install; thresholds: 2M / 10M / 40M tokens.)
- **A pet with feelings** – it eats while Claude works, sweats when you're about to overrun, gets grumpy in overtime, bored when idle, sleeps when you're away, and tracks your cursor with its eyes. Click it, pet it (hover), poke it five times…
- **Your own monster** – every user gets a unique pet generated from their username. Generate more, keep up to five.
- **What it tracks:** token counts for Claude Code (terminal, IDE, desktop Code tab) and Cowork; the usage *percentage* comes from Claude itself, so it includes Chat too.
- **Private** – everything is computed locally from files already on your machine. Nothing is uploaded; there is no telemetry.

## Get it running

### Option A — friends who just want the app (recommended)

Download the installer for your computer from the project's **Releases** page (see "Publishing" below):

| You have | Download | First launch |
|---|---|---|
| **Mac, Apple chip** (M1/M2/M3/M4) | `Tokkie-…-mac-arm64.dmg` | Open the .dmg, drag **Tokkie** to *Applications*, then **right-click → Open** once (the app isn't Apple-notarised, so a plain double-click is blocked the first time). |
| **Mac, Intel** | `Tokkie-…-mac-x64.dmg` | Same as above. |
| **Windows 10/11** | `Tokkie-Setup-…-win-x64.exe` (installer) or `Tokkie-Portable-…-win-x64.exe` (no install) | If SmartScreen says "Windows protected your PC": **More info → Run anyway** (the app isn't code-signed). |

No Node.js, no terminal. Tokkie lives in the menu bar / system tray (there's no Dock icon); click the pet to open it.

### Option B — run from source (developers)

Requires [Node.js 20+](https://nodejs.org).

```bash
git clone <your-repo-url> tokkie && cd tokkie
npm install
npm start
```

Tokkie auto-detects Claude Code (`~/.claude`) and Cowork (the Claude desktop app's data folder) on macOS and Windows. No configuration.

### Publishing a release for your friends

1. Create a GitHub repository and push this folder to it (`git init`, `git add .`, `git commit`, `git remote add origin …`, `git push -u origin main`).
2. The workflow in `.github/workflows/build.yml` runs the tests on macOS, Windows and Linux, then builds the installers for both platforms.
3. To publish downloads, tag a version: `git tag v1.0.0 && git push --tags`. A **Release** page appears with every installer attached — send your friends that link.
4. Prefer not to use GitHub? Run `npm run dist:mac` on a Mac (outputs to `dist/`); Windows installers need a Windows machine or the GitHub workflow.

**Removing the warnings (optional, costs money):** Apple Developer ID ($99/yr) + notarisation removes the macOS prompt; a Windows code-signing certificate removes SmartScreen. Configure them in the `build` section of `package.json` — see electron-builder's code-signing docs.

## Using it

| | |
|---|---|
| **Click the pet** | Open / close the panel (also `Enter` when focused). Drag it anywhere. |
| **Dock** | A card **below or above** the pet — or, with **Claude bar**, a one-line bar above Claude Code’s prompt box (drawn by the bridge), while the pet stays on your desktop. Lines: usage % (and `$X/200`), pace / run-out date, status, tokens today, last prompt cost, context, cache timer, agents — each switchable. **Pills** layout has its own picks. |
| **Usage tab** | Plan limits, tokens, burn rate, sparkline. |
| **Estimate tab** | Set "done by" (e.g. `6:30pm`). Paste a prompt, or select it all, **copy** it (⌘C), then press the shortcut from anywhere (default **⌘⌥⇧L / Ctrl+Alt+Shift+L**) — no need to open Tokkie first. |
| **Pets tab** | Generate, save, switch and remove pets (your first one too — and bring it back). **Album**: 35 species to discover (silhouettes until found), including 6 secret ones unlocked with codes. Pick a **personality**; tap an unlocked form to show it; preview emotions. |
| **Settings** | Claude Code bridge, spend limit, layout + Dock lines, theme, size, shortcut, attention alerts, clipboard watch, notifications, launch at login. |

### Your real usage percentage (automatic)

The Claude desktop app already saves your plan-usage readings (the same numbers as **Settings → Usage**) in its own data folder. Tokkie reads that file, so you get Claude's own "**23% used**" bar with no setup — and because it's server-reported, it **includes regular Chat**, other devices and anything else that counts against your plan. It refreshes whenever the Claude app records a new reading (about every 15 minutes while it's running, and when you open Settings → Usage); the panel shows how old the reading is.

Token counts (today / last 5 hours / burn rate) come from local Claude Code and Cowork logs only — Chat isn't stored locally, so it appears in the percentage but not in the token counts.

**Optional – the Claude Code bridge (Settings → Claude Code bridge → Connect).** A tiny, read-only Claude Code plugin that ships inside Tokkie. Each Claude Code session (terminal, IDE or the desktop app's Code tab) writes its exact running cost, context size, running agents and — where your plan provides them — 5-hour/weekly limits to `~/.tokkie`. Connect copies it to `~/.tokkie/claude-bridge` and adds that folder to `CLAUDE_CODE_PLUGIN_DIRS` in the `env` block of `~/.claude/settings.json` (backed up first); Disconnect removes it again. It starts reporting from your **next new** Claude Code session.

**Spend limits (Enterprise / usage-based plans).** Type your monthly dollar limit in Settings. Tokkie then shows `$X of $Y`, and once the bridge has been running since Claude's last reading, the Claude Code part of the live % is exact dollars instead of a token estimate (Cowork and Chat are still estimated). Pace compares % used with % of the month gone and projects a run-out date. You get a heads-up bubble at 75% and 90%. **Will it fit?** Every estimate is checked against what's left: a red *Not enough left for this prompt* (or amber *may not fit*) bubble, in the Estimate tab and in the Claude bar. Tokkie also warns once when even a typical prompt of yours no longer fits. Set the reset date with the calendar in Settings.

The Estimate tab keeps a **Recent runs** log: for each prompt, how long it actually took and how many tokens it used — and, if you estimated it first, whether the estimate was on target, close or off.

## How good are the estimates?

Honest answer: **useful, not magic.** Agent runs vary enormously. Tokkie learns from *your* history using a small regression on prompt length, how "heavy" the wording is, and how long your previous run took. On the author's real history (475 runs, rolling backtest) the worst-case bound was right 93% of the time and the typical range 44% (ideal 50%), beating a plain-median baseline by ~15%. You always get a range plus a confidence label; with few runs it says so. It gets sharper the longer you use it. Run `node scripts/backtest.js` to test it on your own logs.

## Troubleshooting

- **Nothing shows / "No Claude sessions found"** – start a Claude session once; Tokkie picks up new logs within seconds. Settings → *Where I read from* lists the folders it watches.
- **Plan limit never appears** – open the Claude desktop app's Settings → Usage once so it saves a reading, or use **Sync with Claude** on the Usage tab.
- **Bridge says “Installed” but nothing arrives** – it only loads into Claude Code sessions started after you connected. Start a new session.
- **Shortcut doesn't work** – another app owns it; record a different one in Settings.
- **macOS: "Tokkie can't be opened / Apple could not verify…"** – Tokkie isn't notarised by Apple (that needs a paid developer account). Open it once, click **Done**, then go to **System Settings → Privacy & Security**, scroll down and click **Open Anyway**. You only do this once.
- **macOS: "Tokkie is damaged and can't be opened"** (downloads of v1.0.9 and older) – run `xattr -cr /Applications/Tokkie.app` in Terminal, then open it again. Or install v1.0.10 or newer, which is fully signed so you get the normal prompt above instead.
- **Windows** – built and tested in CI only; please report issues.

## Development

```bash
npm test          # unit + integration tests (parser, store, predictor, tailer, setup, monster generator…)
npm run e2e       # drives the real Electron app: panel placement, drag, tabs, estimates, emotes, persistence
npm run icons     # regenerate assets/icon.png
```

`src/core` is plain Node (no Electron) and fully unit-tested; `src/main` is the Electron shell; `src/renderer` is dependency-free HTML/CSS/JS. `src/renderer/dev/` has a monster gallery and pet-state sheet for visual QA (serve `src/` with any static server).

## License

MIT
