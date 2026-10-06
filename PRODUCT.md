# Tokkie — product brief

**Register:** product (a tool that serves a task; the interface should disappear into it).

## What it is
A tiny always-on-top desktop pet for people who live in Claude Code and Cowork. It shows live token usage and plan-limit headroom at a glance, and — the part nobody else does — tells you *how long your next prompt will probably run* so you can decide whether to hit enter now, queue it, or go home.

## Users
Developers and knowledge workers on Claude Pro/Max, on macOS and Windows, often several sessions at once. Their teammates install it the same afternoon: it must be zero-config (`npm i && npm start`, or a download).

## Scene (drives theme)
Mid-afternoon, a second monitor, Claude working in another window. The widget sits in a screen corner over arbitrary content in either OS theme. It is glanced at for under a second, many times a day. → Follows the OS theme (light/dark), solid surfaces (no glass), very quiet until something matters.

## Personality
Warm, a little silly, never noisy. The pet carries the emotion (eating when tokens flow, sweating when you're about to overrun, sleeping when idle); the panel carries the facts. Copy is short, plain, and honest about uncertainty ("≈", ranges, confidence).

## Principles
1. Glanceable first: the collapsed pet + one pill must answer "how much is left / how long will this take".
2. Honest numbers: estimates are ranges with a confidence label; never fake precision.
3. Plug and play: auto-detects data; one click to connect plan limits; fully reversible, never clobbers user config.
4. The accent colour is the pet's own hue — each user's UI is subtly theirs.

## Anti-references
Neon "gamer" HUDs, glassmorphism overlays, sci-fi dashboards, cartoonish mobile-game chrome, anything that nags.
