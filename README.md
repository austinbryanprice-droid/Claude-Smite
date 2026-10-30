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

### Playing with friends

Under **Play with friends** on the title screen, one player presses **Host co-op** (everyone on one team against bots) or **Host versus** (players on both teams; switch teams in the lobby) and shares the 5-letter code or the invite link. Others enter the code and press **Join**. The host presses **Start match** when everyone is in; bots play every empty slot, and a bot takes over the god of anyone who leaves.

The host's browser runs the match, so the player with the fastest computer and connection should host. Players connect directly (WebRTC); the free public PeerJS server only introduces them.

## Development

```sh
npm install
npm run dev        # http://localhost:5173
npm test
npm run build
```

URL options: `?map=conquest` or `?map=arena` skip the title screen (`&god=thor` picks the god), `?quality=low|medium|high|ultra`, `?webgl` forces WebGL 2.

The title screen's god face cards are baked from the real models into `public/portraits/` by `node tools/portraits/bake.mjs` (needs Playwright and a running `vite preview`); re-run it after god model changes.

Design notes are in `docs/design.md`; how multiplayer works is in `docs/multiplayer.md`.
