"""Writes a god (body + parts) as one skinned GLB on the fitted UAL skeleton."""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

from .body import Body
from .glb import GlbWriter


@dataclass
class Part:
    """One skinned mesh. Triangles index into the part's own vertex arrays."""
    name: str
    material: str
    position: np.ndarray
    normal: np.ndarray
    tris: np.ndarray
    joints: np.ndarray
    weights: np.ndarray
    uv: np.ndarray | None = None
    color: np.ndarray | None = None  # (N,4) 0..1, meaning is per material (see src/actors/gods)
    extra: dict = field(default_factory=dict)


def body_part(body: Body, faces: np.ndarray, uv_faces: np.ndarray, material: str, name: str,
              color: np.ndarray | None = None) -> Part:
    """Body quads as a part; vertices are split where UVs are."""
    pairs = np.stack([faces.reshape(-1), uv_faces.reshape(-1)], axis=1)
    uniq, inv = np.unique(pairs, axis=0, return_inverse=True)
    v, u = uniq[:, 0], uniq[:, 1]
    q = inv.reshape(-1, 4)
    tris = np.concatenate([q[:, [0, 1, 2]], q[:, [0, 2, 3]]])
    ones = np.ones(len(v), dtype=np.float32)
    return Part(name, material, body.verts[v], body.normals[v], tris, body.joints[v], body.weights[v],
                body.uvs[u], None if color is None else color[v], {'edge': ones, 'side': ones})


def write(path, body: Body, parts: list[Part], meta: dict) -> int:
    rig = body.rig
    out = GlbWriter()
    bone_ids = []
    for i, n in enumerate(rig.names):
        bone_ids.append(out.node(name=n, translation=rig.local_t[i].tolist(), rotation=rig.local_r[i].tolist()))
    for i, p in enumerate(rig.parents):
        if p >= 0:
            out.gltf['nodes'][bone_ids[p]].setdefault('children', []).append(bone_ids[i])
    inv = np.stack([np.linalg.inv(w) for w in rig.world]).astype(np.float32)
    # glTF matrices are column-major
    ibm = out.accessor(np.ascontiguousarray(inv.transpose(0, 2, 1)).reshape(-1, 16))
    out.gltf['skins'] = [{'joints': bone_ids, 'inverseBindMatrices': ibm, 'skeleton': bone_ids[0]}]
    scene = [bone_ids[0]]
    for p in parts:
        m = out.mesh(p.name, [{
            'position': p.position, 'normal': p.normal, 'indices': p.tris, 'material': p.material,
            'uv': p.uv, 'joints': p.joints, 'weights': p.weights, 'color': p.color, 'extra': p.extra,
        }])
        scene.append(out.node(name=p.name, mesh=m, skin=0))
    root = out.node(name='god', children=scene, extras=meta)
    out.gltf['scenes'][0]['nodes'] = [root]
    return out.save(path)
