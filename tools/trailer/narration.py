"""Speaks the trailer's lines (script.json) into out/voice/<id>.wav with Kokoro TTS.

    pip install kokoro-onnx soundfile
    # model files from https://github.com/thewh1teagle/kokoro-onnx/releases (model-files-v1.0)
    python tools/trailer/narration.py path/to/kokoro-v1.0.onnx path/to/voices-v1.0.bin

Kokoro is an Apache-2.0 open model, so the narration is free to ship.
"""
import json, os, sys
import soundfile as sf
from kokoro_onnx import Kokoro

here = os.path.dirname(os.path.abspath(__file__))
script = json.load(open(os.path.join(here, 'script.json')))
out = os.path.join(here, 'out', 'voice')
os.makedirs(out, exist_ok=True)
k = Kokoro(sys.argv[1], sys.argv[2])
only = set(sys.argv[3].split(',')) if len(sys.argv) > 3 else None
lengths = {}
for line in script['lines']:
    if only and line['id'] not in only:
        continue
    samples, rate = k.create(line['text'], voice=line.get('voice', script['voice']), speed=line.get('speed', script['speed']), lang='en-gb')
    sf.write(os.path.join(out, line['id'] + '.wav'), samples, rate)
    lengths[line['id']] = round(len(samples) / rate, 3)
    print(line['id'], lengths[line['id']])
path = os.path.join(out, 'lengths.json')
old = json.load(open(path)) if os.path.exists(path) else {}
json.dump({**old, **lengths}, open(path, 'w'), indent=1)
