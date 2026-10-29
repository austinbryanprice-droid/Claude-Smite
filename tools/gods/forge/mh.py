"""MakeHuman (CC0) loader: base mesh, morph targets, skeleton joints, skin weights, proxies.

All data comes from assets-src/makehuman (fetched by scripts/fetch-assets.mjs).
Units are MakeHuman decimeters until `Body.finish()` converts to meters.
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[3]
DATA = ROOT / 'assets-src/makehuman/makehuman/data'


@dataclass
class BaseMesh:
    verts: np.ndarray  # (N,3) every vertex, helpers included
    uvs: np.ndarray  # (M,2)
    groups: dict[str, tuple[np.ndarray, np.ndarray]]  # name -> (faces (F,4) vertex idx, (F,4) uv idx)


@lru_cache(maxsize=1)
def base_mesh() -> BaseMesh:
    path = DATA / '3dobjs/base.obj'
    if not path.exists():
        raise SystemExit('MakeHuman data missing: run `node scripts/fetch-assets.mjs --only src/makehuman` first')
    v, vt, groups = [], [], {}
    cur = None
    for line in path.open():
        if line.startswith('v '):
            v.append([float(x) for x in line.split()[1:4]])
        elif line.startswith('vt '):
            vt.append([float(x) for x in line.split()[1:3]])
        elif line.startswith('g '):
            cur = line.split()[1]
        elif line.startswith('f '):
            parts = [p.split('/') for p in line.split()[1:]]
            fv, fu = groups.setdefault(cur, ([], []))
            fv.append([int(p[0]) - 1 for p in parts])
            fu.append([int(p[1]) - 1 for p in parts])
    return BaseMesh(
        np.array(v, dtype=np.float64),
        np.array(vt, dtype=np.float64),
        {k: (np.array(a, dtype=np.int32), np.array(b, dtype=np.int32)) for k, (a, b) in groups.items()},
    )


@lru_cache(maxsize=None)
def target(name: str) -> tuple[np.ndarray, np.ndarray]:
    """Loads `targets/<name>.target` as (indices, deltas)."""
    idx, d = [], []
    for line in (DATA / 'targets' / f'{name}.target').open():
        if not line.strip() or line.startswith('#'):
            continue
        p = line.split()
        idx.append(int(p[0]))
        d.append([float(p[1]), float(p[2]), float(p[3])])
    return np.array(idx, dtype=np.int64), np.array(d, dtype=np.float64).reshape(-1, 3)


def _pair(value: float, lo: str, mid: str, hi: str) -> list[tuple[str, float]]:
    """MakeHuman's macro interpolation between three anchor targets."""
    if value < 0.5:
        w = (0.5 - value) * 2
        return [(lo, w), (mid, 1 - w)]
    w = (value - 0.5) * 2
    return [(mid, 1 - w), (hi, w)]


def macro_targets(gender: float, muscle: float, weight: float, height: float, proportions: float,
                  race: dict[str, float] | None = None) -> list[tuple[str, float]]:
    """The weighted macro targets MakeHuman applies for a young adult with these sliders (0..1)."""
    race = race or {'caucasian': 1 / 3, 'african': 1 / 3, 'asian': 1 / 3}
    genders = [('female', 1 - gender), ('male', gender)]
    muscles = _pair(muscle, 'minmuscle', 'averagemuscle', 'maxmuscle')
    weights = _pair(weight, 'minweight', 'averageweight', 'maxweight')
    out: list[tuple[str, float]] = []
    for g, gw in genders:
        for r, rw in race.items():
            out.append((f'macrodetails/{r}-{g}-young', gw * rw))
        for m, mw in muscles:
            for wt, ww in weights:
                base = gw * mw * ww
                out.append((f'macrodetails/universal-{g}-young-{m}-{wt}', base))
                if height < 0.5:
                    out.append((f'macrodetails/height/{g}-young-{m}-{wt}-minheight', base * (0.5 - height) * 2))
                elif height > 0.5:
                    out.append((f'macrodetails/height/{g}-young-{m}-{wt}-maxheight', base * (height - 0.5) * 2))
                if proportions > 0.5:
                    out.append((f'macrodetails/proportions/{g}-young-{m}-{wt}-idealproportions', base * (proportions - 0.5) * 2))
                elif proportions < 0.5:
                    out.append((f'macrodetails/proportions/{g}-young-{m}-{wt}-uncommonproportions', base * (0.5 - proportions) * 2))
    return [(n, w) for n, w in out if w > 1e-4]


def apply_targets(verts: np.ndarray, targets: list[tuple[str, float]]) -> np.ndarray:
    out = verts.copy()
    for name, w in targets:
        idx, d = target(name)
        np.add.at(out, idx, d * w)
    return out


@lru_cache(maxsize=1)
def skeleton() -> dict:
    return json.loads((DATA / 'rigs/default.mhskel').read_text())


@lru_cache(maxsize=1)
def weights() -> dict[str, list[tuple[int, float]]]:
    return json.loads((DATA / 'rigs/default_weights.mhw').read_text())['weights']


def joints(verts: np.ndarray) -> dict[str, np.ndarray]:
    """Joint positions (bone heads and tails) for a morphed mesh: means of helper vertices."""
    return {k: verts[np.array(v)].mean(axis=0) for k, v in skeleton()['joints'].items()}


def fit_proxy(mhclo: Path, verts: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Fits a MakeHuman proxy (eyes, clothes) to a morphed body. Returns (verts, faces, uvs)."""
    refs, scales = [], {}
    lines = mhclo.read_text().splitlines()
    obj = None
    in_verts = False
    for line in lines:
        p = line.split()
        if not p or p[0].startswith('#'):
            continue
        if p[0] == 'obj_file':
            obj = mhclo.parent / p[1]
        elif p[0] in ('x_scale', 'y_scale', 'z_scale'):
            scales[p[0][0]] = (int(p[1]), int(p[2]), float(p[3]))
        elif p[0] == 'verts':
            in_verts = True
        elif in_verts and len(p) == 9:
            refs.append(p)
        elif in_verts and len(p) == 1:
            refs.append([p[0], p[0], p[0], '1', '0', '0', '0', '0', '0'])
    r = np.array(refs, dtype=np.float64)
    i = r[:, :3].astype(np.int64)
    w = r[:, 3:6]
    off = r[:, 6:9]
    s = np.array([abs(verts[scales[a][0]][k] - verts[scales[a][1]][k]) / scales[a][2] for k, a in enumerate('xyz')])
    out = (verts[i] * w[:, :, None]).sum(axis=1) + off * s
    pv, pu, pf, pfu = [], [], [], []
    for line in obj.open():
        if line.startswith('v '):
            pv.append(1)
        elif line.startswith('vt '):
            pu.append([float(x) for x in line.split()[1:3]])
        elif line.startswith('f '):
            parts = [q.split('/') for q in line.split()[1:]]
            pf.append([int(q[0]) - 1 for q in parts])
            pfu.append([int(q[1]) - 1 for q in parts])
    return out, np.array(pf), np.array(pu)


@dataclass
class Shape:
    """Body sliders. Values follow MakeHuman's 0..1 convention (0.5 = average)."""
    gender: float = 1.0
    muscle: float = 0.5
    weight: float = 0.5
    height: float = 0.5
    proportions: float = 1.0
    race: dict[str, float] | None = None
    extra: dict[str, float] = field(default_factory=dict)  # target name -> weight

    def targets(self) -> list[tuple[str, float]]:
        t = macro_targets(self.gender, self.muscle, self.weight, self.height, self.proportions, self.race)
        return t + [(k, v) for k, v in self.extra.items() if v]


def morph(shape: Shape) -> np.ndarray:
    return apply_targets(base_mesh().verts, shape.targets())
