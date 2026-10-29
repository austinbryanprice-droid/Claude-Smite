"""The shared god rig: the Quaternius UAL skeleton fitted to a MakeHuman body.

Every god uses the 53-bone UAL skeleton so all of them play the same UAL
clips. The body keeps its natural MakeHuman bind pose (an A-pose with bent
elbows); instead of re-posing the mesh, each bone's rest frame is the UAL
rest frame rotated back by the delta between the two rest poses. With that
choice the UAL clips' local rotations apply unchanged and drive the body to
exactly the UAL world pose (see `fit`).
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

import numpy as np

from . import mh
from .mathx import quat_to_mat, mat_to_quat, rot_between, frame_align

ROOT = Path(__file__).resolve().parents[3]
UAL = ROOT / 'public/assets/characters/ual/ual_standard.gltf'

FINGERS = {'thumb': 1, 'f_index': 2, 'f_middle': 3, 'f_ring': 4, 'f_pinky': 5}


@dataclass
class UalBone:
    name: str
    parent: str | None
    t: np.ndarray  # rest local translation
    r: np.ndarray  # rest local rotation (x,y,z,w)
    world: np.ndarray = None  # 4x4 rest world matrix


@lru_cache(maxsize=1)
def ual() -> tuple[dict, list[UalBone]]:
    if not UAL.exists():
        raise SystemExit('UAL rig missing: run `node scripts/fetch-assets.mjs --only characters/ual` first')
    g = json.loads(UAL.read_text())
    nodes = g['nodes']
    joints = g['skins'][0]['joints']
    parent = {}
    for i, n in enumerate(nodes):
        for c in n.get('children', []):
            parent[c] = i
    bones: list[UalBone] = []
    by_index = {}
    for j in joints:
        n = nodes[j]
        p = parent.get(j)
        b = UalBone(n['name'], nodes[p]['name'] if p in joints else None,
                    np.array(n.get('translation', [0, 0, 0]), dtype=np.float64),
                    np.array(n.get('rotation', [0, 0, 0, 1]), dtype=np.float64))
        by_index[j] = b
    # order parents first
    ordered: list[UalBone] = []
    names = {b.name: b for b in by_index.values()}

    def visit(b: UalBone):
        if b in ordered:
            return
        if b.parent:
            visit(names[b.parent])
        ordered.append(b)

    for b in by_index.values():
        visit(b)
    for b in ordered:
        m = np.eye(4)
        m[:3, :3] = quat_to_mat(b.r)
        m[:3, 3] = b.t
        b.world = names[b.parent].world @ m if b.parent else m
    return g, ordered


def ual_bone_for(mh_bone: str) -> str:
    """Which UAL bone a MakeHuman bone's skin weights go to."""
    side = mh_bone[-2:] if mh_bone[-2:] in ('.L', '.R') else ''
    base = mh_bone[:-2] if side else mh_bone
    simple = {
        'root': 'hips', 'spine05': 'hips', 'spine04': 'hips', 'pelvis': 'hips',
        'spine03': 'spine.001', 'spine02': 'spine.002', 'spine01': 'spine.003', 'breast': 'spine.003',
        'neck01': 'neck', 'neck02': 'neck', 'neck03': 'neck',
        'clavicle': 'shoulder', 'shoulder01': 'shoulder',
        'upperarm01': 'upper_arm', 'upperarm02': 'upper_arm',
        'lowerarm01': 'forearm', 'lowerarm02': 'forearm',
        'wrist': 'hand', 'metacarpal1': 'hand', 'metacarpal2': 'hand', 'metacarpal3': 'hand', 'metacarpal4': 'hand',
        'upperleg01': 'thigh', 'upperleg02': 'thigh', 'lowerleg01': 'shin', 'lowerleg02': 'shin', 'foot': 'foot',
    }
    if base in simple:
        out = simple[base]
    elif base.startswith('finger'):
        n, k = base[6:].split('-')
        out = {1: 'thumb', 2: 'f_index', 3: 'f_middle', 4: 'f_ring', 5: 'f_pinky'}[int(n)] + f'.0{k}'
    elif base.startswith('toe'):
        out = 'toe'
    else:
        out = 'head'
    if out in ('hips', 'spine.001', 'spine.002', 'spine.003', 'neck', 'head'):
        return 'DEF-' + out
    return f'DEF-{out}{side}'


def _mh_joint(bone: str, which: str = 'head') -> str:
    return f'{bone}____{which}'


def mh_position(ual_name: str, J: dict[str, np.ndarray]) -> np.ndarray:
    """Where a UAL bone's head sits on a MakeHuman body."""
    n = ual_name.removeprefix('DEF-')
    side = n[-2:] if n[-2:] in ('.L', '.R') else ''
    base = n[:-2] if side else n
    table = {
        'hips': 'spine05', 'spine.001': 'spine03', 'spine.002': 'spine02', 'spine.003': 'spine01',
        'neck': 'neck01', 'head': 'head',
        'shoulder': 'clavicle', 'upper_arm': 'upperarm01', 'forearm': 'lowerarm01', 'hand': 'wrist',
        'thigh': 'upperleg01', 'shin': 'lowerleg01', 'foot': 'foot',
    }
    if base in table:
        return J[_mh_joint(table[base] + side)]
    if base == 'toe':
        return J[_mh_joint('foot' + side, 'tail')]
    finger, k = base.rsplit('.', 1)
    return J[_mh_joint(f'finger{FINGERS[finger]}-{int(k)}{side}')]


def mh_leaf_tail(ual_name: str, J: dict[str, np.ndarray]) -> np.ndarray:
    n = ual_name.removeprefix('DEF-')
    side = n[-2:] if n[-2:] in ('.L', '.R') else ''
    base = n[:-2] if side else n
    if base == 'head':
        return J[_mh_joint('head', 'tail')]
    if base == 'toe':
        return J[_mh_joint('toe3-3' + side, 'tail')]
    finger, k = base.rsplit('.', 1)
    return J[_mh_joint(f'finger{FINGERS[finger]}-{int(k)}{side}', 'tail')]


MAIN_CHILD = {
    'DEF-hips': 'DEF-spine.001', 'DEF-spine.001': 'DEF-spine.002', 'DEF-spine.002': 'DEF-spine.003',
    'DEF-spine.003': 'DEF-neck', 'DEF-neck': 'DEF-head',
}
for s in ('.L', '.R'):
    MAIN_CHILD.update({
        f'DEF-shoulder{s}': f'DEF-upper_arm{s}', f'DEF-upper_arm{s}': f'DEF-forearm{s}', f'DEF-forearm{s}': f'DEF-hand{s}',
        f'DEF-hand{s}': f'DEF-f_middle.01{s}', f'DEF-thigh{s}': f'DEF-shin{s}', f'DEF-shin{s}': f'DEF-foot{s}',
        f'DEF-foot{s}': f'DEF-toe{s}',
    })
    for f in FINGERS:
        MAIN_CHILD[f'DEF-{f}.01{s}'] = f'DEF-{f}.02{s}'
        MAIN_CHILD[f'DEF-{f}.02{s}'] = f'DEF-{f}.03{s}'


@dataclass
class FittedRig:
    names: list[str]
    parents: list[int]  # -1 for the root
    local_t: np.ndarray  # (B,3) rest local translations
    local_r: np.ndarray  # (B,4) rest local rotations
    world: np.ndarray  # (B,4,4) rest world matrices (bind pose)
    hips_scale: float  # multiply UAL hips translation tracks by this

    def index(self, name: str) -> int:
        return self.names.index(name)

    def head(self, name: str) -> np.ndarray:
        return self.world[self.index(name)][:3, 3]


def fit(J: dict[str, np.ndarray], scale: float, offset: np.ndarray) -> FittedRig:
    """UAL skeleton fitted to MakeHuman joints J (decimeters), output in meters.

    `scale` and `offset` convert MakeHuman space to the god's model space.
    """
    _, bones = ual()
    by = {b.name: b for b in bones}
    pos = {}
    for b in bones:
        pos[b.name] = np.zeros(3) if b.name == 'root' else mh_position(b.name, J) * scale + offset

    def ual_head(name):
        return by[name].world[:3, 3]

    world_r = {}
    for b in bones:
        R_ual = b.world[:3, :3]
        if b.name == 'root':
            world_r[b.name] = R_ual
            continue
        if b.name in MAIN_CHILD:
            c = MAIN_CHILD[b.name]
            d_ual = ual_head(c) - ual_head(b.name)
            d_mh = pos[c] - pos[b.name]
        else:
            d_ual = R_ual[:, 1]
            d_mh = mh_leaf_tail(b.name, J) * scale + offset - pos[b.name]
        side = b.name[-2:]
        if b.name.startswith(('DEF-hand', 'DEF-forearm')):
            # align twist too: the knuckle line (index -> pinky) must match
            k_ual = ual_head(f'DEF-f_pinky.01{side}') - ual_head(f'DEF-f_index.01{side}')
            k_mh = pos[f'DEF-f_pinky.01{side}'] - pos[f'DEF-f_index.01{side}']
            delta = frame_align(d_mh, k_mh, d_ual, k_ual)
        else:
            delta = rot_between(d_mh, d_ual)
        world_r[b.name] = delta.T @ R_ual

    names = [b.name for b in bones]
    parents = [names.index(b.parent) if b.parent else -1 for b in bones]
    W = np.zeros((len(bones), 4, 4))
    lt = np.zeros((len(bones), 3))
    lr = np.zeros((len(bones), 4))
    for i, b in enumerate(bones):
        W[i] = np.eye(4)
        W[i][:3, :3] = world_r[b.name]
        W[i][:3, 3] = pos[b.name]
        if parents[i] < 0:
            lt[i] = pos[b.name]
            lr[i] = mat_to_quat(world_r[b.name])
        else:
            P = W[parents[i]]
            lt[i] = P[:3, :3].T @ (pos[b.name] - P[:3, 3])
            lr[i] = mat_to_quat(P[:3, :3].T @ world_r[b.name])
    hips_scale = pos['DEF-hips'][1] / ual_head('DEF-hips')[1]
    return FittedRig(names, parents, lt, lr, W, float(hips_scale))


def skin_weights(n_verts: int, rig: FittedRig) -> tuple[np.ndarray, np.ndarray]:
    """MakeHuman weights mapped onto the UAL bones: (joints (N,4) uint16, weights (N,4) float32)."""
    dense = np.zeros((n_verts, len(rig.names)), dtype=np.float32)
    for bone, pairs in mh.weights().items():
        j = rig.index(ual_bone_for(bone))
        a = np.array(pairs)
        idx = a[:, 0].astype(np.int64)
        ok = idx < n_verts
        np.add.at(dense[:, j], idx[ok], a[ok, 1])
    return top4(dense)


def top4(dense: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    order = np.argsort(-dense, axis=1)[:, :4]
    w = np.take_along_axis(dense, order, axis=1)
    s = w.sum(axis=1, keepdims=True)
    s[s == 0] = 1
    return order.astype(np.uint16), (w / s).astype(np.float32)
