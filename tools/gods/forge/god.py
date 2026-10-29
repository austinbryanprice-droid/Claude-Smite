"""Base class for a god recipe: a body plus armor, cloth, hair and props, written as one GLB."""
from __future__ import annotations

import numpy as np
from scipy.sparse import coo_matrix

from . import ao, body as bodymod, export, mh, skin
from .geo import Mesh, merge
from .mathx import normalize
from .regions import Fields


def cavity(V: np.ndarray, quads: np.ndarray, normals: np.ndarray, iters: int = 2) -> np.ndarray:
    """Signed curvature per vertex: > 0 in creases, < 0 on ridges (units: ~1/m scaled)."""
    e = np.concatenate([quads[:, [0, 1]], quads[:, [1, 2]], quads[:, [2, 3]], quads[:, [3, 0]]])
    n = len(V)
    A = coo_matrix((np.ones(len(e) * 2), (np.r_[e[:, 0], e[:, 1]], np.r_[e[:, 1], e[:, 0]])), shape=(n, n)).tocsr()
    A.data[:] = 1
    deg = np.maximum(np.asarray(A.sum(axis=1)).ravel(), 1)
    c = np.zeros(n)
    P = V.copy()
    # larger-scale curvature: compare against a smoothed copy of the surface
    for _ in range(iters):
        P = (A @ P) / deg[:, None]
    c = np.einsum('ij,ij->i', P - V, normals)
    # make it scale-free so small features (fingers, ears) aren't all crease
    el = np.zeros(n)
    L = np.linalg.norm(V[e[:, 0]] - V[e[:, 1]], axis=1)
    np.add.at(el, e[:, 0], L)
    np.add.at(el, e[:, 1], L)
    el = el / np.maximum(np.bincount(e.reshape(-1), minlength=n), 1)
    return c / np.maximum(el, 1e-4) * 0.012


class God:
    name = 'god'
    height = 2.3
    shape = mh.Shape()
    bulk: dict = {}
    definition: float = 0.7  # how strongly muscle forms are exaggerated (0 = MakeHuman as is)

    def __init__(self):
        self.body = bodymod.build(self.shape, self.height)
        if self.bulk:
            bodymod.bulk(self.body, self.bulk)
        self.F = Fields(self.body)
        if self.definition:
            self.define_muscles(self.definition)
        self.parts: list[export.Part] = []
        self.meta: dict = {'hipsScale': self.body.rig.hips_scale, 'height': self.height, 'chains': [], 'cloths': []}

    def define_muscles(self, k: float):
        """Unsharp-masks the body surface so muscle forms read from a game camera.
        Leaves the face, hands and feet alone (their small features would turn lumpy)."""
        from .shell import laplacian
        b = self.body
        tris = b.tris()
        used = b.used
        remap = -np.ones(len(b.verts), dtype=int)
        remap[used] = np.arange(len(used))
        P = b.verts[used]
        T = remap[tris]
        Ps = laplacian(P, T, 20, 0.6)
        mask = 1 - np.clip(self.F.bones('head', 'hand', 'f_', 'thumb', 'foot', 'toe')[used] * 1.5, 0, 1)
        P2 = P + (P - Ps) * (k * mask)[:, None]
        b.verts[used] = P2
        b.normals[:] = bodymod.vertex_normals(b.verts, b.faces)
        self.F = Fields(b)

    # ---------------------------------------------------------------- parts
    def add(self, name: str, material: str, mesh: Mesh, weights: np.ndarray | str | None = None, transfer_only=None):
        """Adds a mesh. weights: dense (N,B) array, a bone name (rigid), or None (nearest body skin)."""
        if isinstance(weights, str):
            W = skin.rigid(len(mesh.v), self.body, weights)
        elif weights is None:
            W = skin.transfer(mesh.v, self.body, only=transfer_only)
        else:
            W = weights
        j, w = skin.top4(W)
        col = mesh.col
        # every part carries the same attributes so materials can be shared
        extra = {k: mesh.attrs.get(k, np.full(len(mesh.v), d)).astype(np.float32) for k, d in (('edge', 1.0), ('side', 1.0))}
        if col is None:
            col = np.zeros((len(mesh.v), 4))
        uv = mesh.uv if mesh.uv is not None else np.full((len(mesh.v), 2), 0.5)  # 0.5: no uv-based trims
        self.parts.append(export.Part(name, material, mesh.v, mesh.normals(), mesh.f, j, w, uv, col, extra))

    def add_merged(self, name: str, material: str, items: list[tuple[Mesh, object]]):
        meshes, Ws = [], []
        for m, w in items:
            if isinstance(w, str):
                Ws.append(skin.rigid(len(m.v), self.body, w))
            elif w is None:
                Ws.append(skin.transfer(m.v, self.body))
            else:
                Ws.append(w)
            meshes.append(m)
        self.add(name, material, merge(meshes), np.concatenate(Ws))

    def body_faces(self, keep: np.ndarray | None = None):
        faces, uvf = mh.base_mesh().groups['body']
        if keep is not None:
            m = keep[faces].all(axis=1) if keep.dtype == bool and len(keep) == len(self.body.verts) else keep
            faces, uvf = faces[m], uvf[m]
        return faces, uvf

    def add_body(self, hide: np.ndarray | None = None, material: str = 'skin'):
        """The skin. `hide` (per MakeHuman vertex, bool) drops faces fully under armor."""
        faces, uvf = mh.base_mesh().groups['body']
        if hide is not None:
            keep = ~hide[faces].all(axis=1)
            faces, uvf = faces[keep], uvf[keep]
        c = cavity(self.body.verts, faces, self.body.normals, iters=3)
        col = np.zeros((len(self.body.verts), 4))
        col[:, 0] = np.clip(c * 60, 0, 1)  # creases
        col[:, 1] = np.clip(-c * 60, 0, 1)  # ridges
        col[:, 2] = self.skin_region()
        self.parts.append(export.body_part(self.body, faces, uvf, material, 'body', col))

    def skin_region(self) -> np.ndarray:
        """Blue channel of the skin data: 1 on the face (for lips/cheek tint)."""
        return self.F.bones('DEF-head')

    def build(self, path) -> int:
        self.make()
        ao.bake(self.parts)
        return export.write(path, self.body, self.parts, self.meta)

    def make(self):
        self.add_body()

    # ---------------------------------------------------------------- helpers
    def eyes(self, material: str = 'eye'):
        verts, faces, uvs = mh.fit_proxy(mh.DATA / 'eyes/high-poly/high-poly.mhclo', mh.morph(self.shape))
        v = verts * self.body.scale + self.body.offset
        tris = np.concatenate([faces[:, [0, 1, 2]], faces[:, [0, 2, 3]]]) if faces.shape[1] == 4 else faces
        m = Mesh(v, tris)
        # red channel: 1 at the pupil, falling off toward the white (for the iris shader)
        col = np.zeros((len(v), 4))
        for side in (v[:, 0] > 0, v[:, 0] <= 0):
            c = v[side].mean(axis=0)
            d = normalize(v[side] - c)
            col[side, 0] = np.clip(d[:, 2], 0, 1)
        m.col = col
        self.add('eyes', material, m, 'DEF-head')

    @staticmethod
    def normal_of(points: np.ndarray) -> np.ndarray:
        return normalize(points)
