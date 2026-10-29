# Ascendant

A third-person browser MOBA in the spirit of Smite 2: 5v5 Conquest against bots, five gods, and no item shop. Each god has a pool of skills (5 equipped, one in the ultimate slot) and three skill trees that share a capped point budget.

**Play:** https://austinbryanprice-droid.github.io/Claude-Smite/ (deployed from `main` by `.github/workflows/pages.yml`).

Best in desktop Chrome or Edge (WebGPU). Other browsers fall back to WebGL 2.

## How to play

1. Pick **Conquest** (5v5 vs bots) or **Training ground**, pick a god, press **Play**.
2. Click the game to capture the mouse. Esc releases it.
3. Destroy the enemy towers and phoenixes along any lane, then the enemy Titan, to win.

| Key | Action |
| --- | --- |
| W A S D | Move |
| Mouse | Aim |
| Left click | Basic attack |
| 1 2 3 4 | Skills: press to aim, press again or click to cast, right click cancels |
| R | Ultimate (unlocks at level 5) |
| B | Recall to the fountain |
| K | Skills & trees: spend points; swap skills at the fountain |
| Tab (hold) | Scoreboard |
| Wheel | Camera zoom |
| H | Controls help |

If it runs slowly, lower the quality at the top right.

## Development

```sh
npm install
npm run dev        # http://localhost:5173
npm test
npm run build
```

URL options: `?map=conquest` or `?map=arena` skip the title screen (`&god=thor` picks the god), `?quality=low|medium|high|ultra`, `?webgl` forces WebGL 2.

Design notes are in `docs/design.md`.
