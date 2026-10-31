# Intro trailer

Builds `public/trailer/trailer.mp4` (and `poster.jpg`), which plays after the
home page's Play button on every launch (`src/ui/Intro.ts`). Everything in it
is the game's own: footage filmed from the real game, its synthesized music
and sound effects, its icons and data. The narration is Kokoro TTS (an
Apache-2.0 open model), voice `bm_george`.

| File | What it does |
| --- | --- |
| `script.json` | The narration lines, voice and speed |
| `timeline.mjs` | When each line and cut happens; shared by the edit and the score |
| `narration.py` | Speaks `script.json` into `out/voice/` |
| `shots.mjs`, `film.mjs` | The in-game shots, filmed with `?stage` (`src/dev/Stage.ts`) into `out/frames/` |
| `score.ts` | Music, effects and narration mixed into `out/score.wav` |
| `compose.html`, `compose.ts` | The edit: footage, title cards, skill bar, trees, captions |
| `render.mjs` | Renders the edit frame by frame and encodes the mp4 |

## Rebuilding

```sh
# 1. narration (pip install kokoro-onnx soundfile; model files from
#    https://github.com/thewh1teagle/kokoro-onnx/releases/tag/model-files-v1.0)
python tools/trailer/narration.py kokoro-v1.0.onnx voices-v1.0.bin
for f in tools/trailer/out/voice/*.wav; do ffmpeg -y -i $f -ar 44100 -ac 1 tools/trailer/out/voice44/$(basename $f); done

# 2. footage (headless Chromium on the software GPU: hours, not minutes)
npm run build && npx vite preview --port 4173 &
node tools/trailer/film.mjs                # or a list: heroZeus,cqWyrm

# 3. soundtrack, then the picture and the encode
npx tsx tools/trailer/score.ts
npx vite --port 5173 &
node tools/trailer/render.mjs
```

To change a line, edit `script.json`, rerun steps 1 and 3, and nudge
`timeline.mjs` if the line got longer. To swap the voice, change `voice`
(any Kokoro voice; British ones start with `bm_` and `bf_`).
