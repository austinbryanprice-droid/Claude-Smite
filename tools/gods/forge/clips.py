"""Exports the UAL animation clips the gods use into one small shared GLB.

Only bone rotations are kept, plus the hips translation (scaled per god at
runtime by `hipsScale`), so the clips drive any god body fitted with
`rig.fit` regardless of its proportions.
"""
from __future__ import annotations

import json

import numpy as np

from . import rig as rigmod
from .glb import GlbWriter

CLIPS = [
    'A_TPose', 'Idle_Loop', 'Walk_Loop', 'Jog_Fwd_Loop', 'Sprint_Loop', 'Jump_Start', 'Jump_Loop', 'Jump_Land',
    'Spell_Simple_Enter', 'Spell_Simple_Idle_Loop', 'Spell_Simple_Shoot', 'Spell_Simple_Exit',
    'Sword_Attack', 'Sword_Idle', 'Punch_Jab', 'Punch_Cross', 'Hit_Chest', 'Hit_Head', 'Death01', 'Roll',
]

_SIZES = {5126: 4, 5123: 2, 5121: 1, 5125: 4}
_DT = {5126: np.float32, 5123: np.uint16, 5121: np.uint8, 5125: np.uint32}
_W = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4, 'MAT4': 16}


def read_accessor(g: dict, binary: bytes, i: int) -> np.ndarray:
    a = g['accessors'][i]
    v = g['bufferViews'][a['bufferView']]
    w = _W[a['type']]
    start = v.get('byteOffset', 0) + a.get('byteOffset', 0)
    stride = v.get('byteStride', 0)
    dt = _DT[a['componentType']]
    if stride and stride != w * _SIZES[a['componentType']]:
        rows = [np.frombuffer(binary, dt, w, start + k * stride) for k in range(a['count'])]
        return np.array(rows)
    return np.frombuffer(binary, dt, a['count'] * w, start).reshape(a['count'], w) if w > 1 else np.frombuffer(binary, dt, a['count'], start)


def export(path) -> int:
    g, bones = rigmod.ual()
    binary = (rigmod.UAL.parent / g['buffers'][0]['uri']).read_bytes()
    out = GlbWriter()
    ids = {}
    for b in bones:
        ids[b.name] = out.node(name=b.name, translation=b.t.tolist(), rotation=b.r.tolist())
    for b in bones:
        kids = [ids[c.name] for c in bones if c.parent == b.name]
        if kids:
            out.gltf['nodes'][ids[b.name]]['children'] = kids
    out.gltf['scenes'][0]['nodes'] = [ids['root']]
    nodes = g['nodes']
    anims = []
    for a in g['animations']:
        if a['name'] not in CLIPS:
            continue
        samplers, channels = [], []
        time_cache = {}
        for ch in a['channels']:
            name = nodes[ch['target']['node']]['name']
            path_ = ch['target']['path']
            if name not in ids:
                continue
            if path_ == 'scale' or (path_ == 'translation' and name != 'DEF-hips'):
                continue
            s = a['samplers'][ch['sampler']]
            vals = read_accessor(g, binary, s['output']).astype(np.float32)
            # every rotation track is kept, even constant ones: a god's rest pose
            # differs from the UAL rest pose, so the clip must set every bone
            if s['input'] not in time_cache:
                time_cache[s['input']] = out.accessor(read_accessor(g, binary, s['input']).astype(np.float32), minmax=True)
            samplers.append({'input': time_cache[s['input']], 'output': out.accessor(vals), 'interpolation': s.get('interpolation', 'LINEAR')})
            channels.append({'sampler': len(samplers) - 1, 'target': {'node': ids[name], 'path': path_}})
        anims.append({'name': a['name'], 'samplers': samplers, 'channels': channels})
    out.gltf['animations'] = anims
    del out.gltf['meshes'], out.gltf['materials']
    return out.save(path)
