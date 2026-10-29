"""A god's body: a morphed MakeHuman mesh in model space (meters, feet at y=0, facing +Z), skinned to the fitted rig."""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from . import mh, rig as rigmod
from .mathx import normalize


@dataclass
class Body:
    shape: mh.Shape
    verts: np.ndarray  # (N,3) every MakeHuman vertex in model space (helpers included)
    faces: np.ndarray  # (F,4) body quads (vertex idx)
    uv_faces: np.ndarray  # (F,4)
    uvs: np.ndarray
    normals: np.ndarray  # (N,3) smooth normals of the body surface
    joints: np.ndarray  # (N,4)
    weights: np.ndarray  # (N,4)
    rig: rigmod.FittedRig
    J: dict  # MakeHuman joints in model space
    scale: float
    offset: np.ndarray

    @property
    def used(self) -> np.ndarray:
        return np.unique(self.faces)

    def tris(self, faces: np.ndarray | None = None) -> np.ndarray:
        f = self.faces if faces is None else faces
        return np.concatenate([f[:, [0, 1, 2]], f[:, [0, 2, 3]]])


def vertex_normals(verts: np.ndarray, quads: np.ndarray) -> np.ndarray:
    n = np.zeros_like(verts)
    for a, b, c in ((0, 1, 2), (0, 2, 3)):
        fn = np.cross(verts[quads[:, b]] - verts[quads[:, a]], verts[quads[:, c]] - verts[quads[:, a]])
        for k in (a, b, c):
            np.add.at(n, quads[:, k], fn)
    return normalize(n)


def _seg_offset(V: np.ndarray, a: np.ndarray, b: np.ndarray) -> np.ndarray:
    """Vector from the closest point on segment a-b to each vertex."""
    d = b - a
    t = np.clip(((V - a) @ d) / (d @ d), 0, 1)
    return V - (a + t[:, None] * d)


# bone -> child used as the bone's axis segment for bulking
_AXIS = {
    'DEF-upper_arm': 'DEF-forearm', 'DEF-forearm': 'DEF-hand', 'DEF-thigh': 'DEF-shin', 'DEF-shin': 'DEF-foot',
    'DEF-neck': 'DEF-head', 'DEF-spine.002': 'DEF-spine.003', 'DEF-spine.003': 'DEF-neck', 'DEF-spine.001': 'DEF-spine.002',
    'DEF-hips': 'DEF-spine.001', 'DEF-hand': 'DEF-f_middle.01', 'DEF-shoulder': 'DEF-upper_arm',
}


def bulk(b: 'Body', factors: dict[str, float | tuple[float, float, float]]) -> None:
    """Thickens body parts around their bone axes (stylized proportions).

    factors: bone base name (e.g. 'DEF-thigh', applies to both sides) -> scale of the
    distance from the bone axis, or (sx, sy, sz) to scale that offset per axis.
    """
    V = b.verts
    used = b.used
    D = np.zeros((len(V), len(b.rig.names)), dtype=np.float32)
    np.put_along_axis(D, b.joints.astype(np.int64), b.weights, axis=1)
    disp = np.zeros_like(V)
    for base, k in factors.items():
        k3 = np.array(k if isinstance(k, tuple) else (k, k, k), dtype=np.float64)
        for side in ('', '.L', '.R'):
            name = base + side
            if name not in b.rig.names or base not in _AXIS:
                continue
            child = _AXIS[base] + side
            if child not in b.rig.names:
                continue
            w = D[:, b.rig.index(name)]
            off = _seg_offset(V, b.rig.head(name), b.rig.head(child))
            disp += w[:, None] * off * (k3 - 1)
    V2 = V.copy()
    V2[used] += disp[used]
    b.verts[:] = V2
    b.normals[:] = vertex_normals(b.verts, b.faces)


def build(shape: mh.Shape, height: float) -> Body:
    base = mh.base_mesh()
    V = mh.morph(shape)
    faces, uv_faces = base.groups['body']
    used = np.unique(faces)
    lo, hi = V[used, 1].min(), V[used, 1].max()
    s = height / (hi - lo)
    offset = np.array([0.0, -lo * s, 0.0])
    Vm = V * s + offset
    J = {k: v * s + offset for k, v in mh.joints(V).items()}
    rig = rigmod.fit(mh.joints(V), s, offset)
    joints, weights = rigmod.skin_weights(len(V), rig)
    return Body(shape, Vm, faces, uv_faces, base.uvs, vertex_normals(Vm, faces), joints, weights, rig, J, s, offset)
