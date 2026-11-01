"""Builds the god models: `python3 tools/gods/build.py [god ...]`.

Writes public/models/gods/<god>.glb and the shared clips file
public/models/gods/clips.glb. Needs the MakeHuman and UAL sources
(`node scripts/fetch-assets.mjs --only src/makehuman` and `--only characters/ual`)
and the Python packages in tools/gods/requirements.txt.
"""
from __future__ import annotations

import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from forge import clips  # noqa: E402
from forge.gods import GODS  # noqa: E402

OUT = Path(__file__).resolve().parents[2] / 'public/models/gods'
# gods imported from sculpts by meshy.py: only rebuilt here when named explicitly
SCULPTED = {'thor'}


def main(names: list[str]) -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    if not names or 'clips' in names:
        n = clips.export(OUT / 'clips.glb')
        print(f'clips.glb  {n / 1e6:.2f} MB')
    for name in names or [g for g in GODS if g not in SCULPTED]:
        if name == 'clips':
            continue
        t = time.time()
        n = GODS[name]().build(OUT / f'{name}.glb')
        print(f'{name}.glb  {n / 1e6:.2f} MB  ({time.time() - t:.1f} s)')


if __name__ == '__main__':
    main(sys.argv[1:])
