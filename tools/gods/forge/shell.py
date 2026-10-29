"""Armor fitted to the body: cut a region out of the body surface along a smooth
iso-line of a scalar field, lift it off the skin, give it thickness and a raised
rolled rim. The piece inherits the body's skin weights, so it deforms with it.
"""
from __future__ import annotations

import numpy as np
from scipy.sparse import coo_matrix
from scipy.sparse.csgraph import dijkstra

from .body import Body
from .geo import Mesh, vertex_normals
from .mathx import normalize
from . import skin


def clip(body: Body, field: np.ndarray, iso: float = 0.5):
    """Body triangles where field >= iso, cut exactly at the iso-line.

    Returns positions, normals, dense weights and triangles of the cut surface.
    """
    tris = body.tris()
    inside = field >= iso
    keep = inside[tris]
    full = tris[keep.all(axis=1)]
    partial = tris[keep.any(axis=1) & ~keep.all(axis=1)]
    vmap: dict = {}
    pos, nor, src = [], [], []  # src: (i, j, t) interpolation records

    def vid(i):
        k = ('v', int(i))
        if k not in vmap:
            vmap[k] = len(src)
            src.append((int(i), int(i), 0.0))
        return vmap[k]

    def eid(i, j):
        a, b = (int(i), int(j)) if i < j else (int(j), int(i))
        k = ('e', a, b)
        if k not in vmap:
            t = (iso - field[a]) / (field[b] - field[a])
            vmap[k] = len(src)
            src.append((a, b, float(np.clip(t, 0, 1))))
        return vmap[k]

    out = []
    for t in full:
        out.append([vid(t[0]), vid(t[1]), vid(t[2])])
    for t in partial:
        ins = [field[x] >= iso for x in t]
        # rotate so the odd vertex is first
        for r in range(3):
            a, b, c = t[r], t[(r + 1) % 3], t[(r + 2) % 3]
            ia, ib, ic = ins[r], ins[(r + 1) % 3], ins[(r + 2) % 3]
            if ia != ib and ia != ic:
                break
        if ia:  # one vertex inside
            out.append([vid(a), eid(a, b), eid(a, c)])
        else:  # two inside: quad b, c, ca, ab
            out.append([eid(a, b), vid(b), vid(c)])
            out.append([eid(a, b), vid(c), eid(a, c)])
    src = np.array(src)
    i, j, tt = src[:, 0].astype(np.int64), src[:, 1].astype(np.int64), src[:, 2:3]
    P = body.verts[i] * (1 - tt) + body.verts[j] * tt
    Nn = normalize(body.normals[i] * (1 - tt) + body.normals[j] * tt)
    D = skin.dense(body)
    W = D[i] * (1 - tt) + D[j] * tt
    return P, Nn, W, np.array(out, dtype=np.int64)


def _edges(f: np.ndarray):
    e = np.concatenate([f[:, [0, 1]], f[:, [1, 2]], f[:, [2, 0]]])
    key = np.sort(e, axis=1)
    uniq, inv, cnt = np.unique(key, axis=0, return_inverse=True, return_counts=True)
    boundary_dir = e[cnt[inv] == 1]  # directed as in their triangle
    return uniq, boundary_dir


def laplacian(P: np.ndarray, f: np.ndarray, iters: int, lam: float = 0.5, fixed: np.ndarray | None = None) -> np.ndarray:
    uniq, _ = _edges(f)
    n = len(P)
    A = coo_matrix((np.ones(len(uniq) * 2), (np.r_[uniq[:, 0], uniq[:, 1]], np.r_[uniq[:, 1], uniq[:, 0]])), shape=(n, n)).tocsr()
    deg = np.asarray(A.sum(axis=1)).ravel()
    deg[deg == 0] = 1
    P = P.copy()
    for k in range(iters):
        avg = (A @ P) / deg[:, None]
        step = lam if k % 2 == 0 else -lam * 1.04  # Taubin: shrink-free smoothing
        d = (avg - P) * step
        if fixed is not None:
            d[fixed] = 0
        P = P + d
    return P


def edge_distance(P: np.ndarray, f: np.ndarray) -> np.ndarray:
    uniq, bdir = _edges(f)
    n = len(P)
    L = np.linalg.norm(P[uniq[:, 0]] - P[uniq[:, 1]], axis=1)
    G = coo_matrix((np.r_[L, L], (np.r_[uniq[:, 0], uniq[:, 1]], np.r_[uniq[:, 1], uniq[:, 0]])), shape=(n, n)).tocsr()
    srcs = np.unique(bdir.reshape(-1))
    if len(srcs) == 0:
        return np.full(n, 1.0)
    d = dijkstra(G, directed=False, indices=srcs, min_only=True)
    d[~np.isfinite(d)] = 1.0
    return d


def plate(body: Body, field: np.ndarray, *, iso: float = 0.5, offset: float = 0.012, thickness: float = 0.006,
          rim: float = 0.012, rim_width: float = 0.018, smooth: int = 6, inflate=None, bulge=None, sharpen: float = 0.0):
    """A solid armor plate. Returns (Mesh, dense weights).

    attrs['edge'] holds the distance to the plate's border (m), for trim shading.
    `inflate(P) -> (N,)` adds extra offset per vertex (e.g. to puff a pauldron).
    """
    P, Nn, W, f = clip(body, field, iso)
    if len(f) == 0:
        raise ValueError('empty armor region')
    _, bdir = _edges(f)
    bverts = np.unique(bdir.reshape(-1))
    if smooth:
        # smooth the boundary along itself and the interior freely, to soften anatomy
        P = laplacian(P, f, smooth)
    if sharpen:
        # unsharp mask on the surface: exaggerates the anatomy under it (sculpted muscle cuirass)
        Ps = laplacian(P, f, 16, 0.6)
        P = P + (P - Ps) * sharpen
    Nn = normalize(vertex_normals(P, f) * 0.7 + Nn * 0.3)
    d = edge_distance(P, f)
    lift = offset + np.zeros(len(P))
    if inflate is not None:
        lift = lift + inflate(P)
    # rolled rim: a raised round bead just inside the border
    x = np.clip(d / max(rim_width, 1e-6), 0, 1)
    bead = rim * np.sin(np.clip(x * np.pi, 0, np.pi)) * (x < 1)
    outer = P + Nn * (lift + thickness + bead)[:, None]
    inner = P + Nn * lift[:, None]
    if bulge is not None:
        outer = outer + Nn * bulge(P)[:, None]
    n = len(P)
    faces = [f, f[:, ::-1] + n]
    # walls along the border
    a, b = bdir[:, 0], bdir[:, 1]
    faces.append(np.stack([a, b + n, b], axis=1))
    faces.append(np.stack([a, a + n, b + n], axis=1))
    v = np.concatenate([outer, inner])
    m = Mesh(v, np.concatenate(faces))
    m.attrs['edge'] = np.concatenate([d, np.zeros(n)])
    # flag the inside surface so shaders can darken it
    m.attrs['side'] = np.concatenate([np.ones(n), np.zeros(n)])
    del bverts
    return m, np.concatenate([W, W])


def wrap(body: Body, field: np.ndarray, *, iso: float = 0.5, offset: float = 0.006, smooth: int = 2):
    """A thin single-sided layer on the skin (cloth wraps, leather straps, tights)."""
    P, Nn, W, f = clip(body, field, iso)
    if smooth:
        P = laplacian(P, f, smooth)
    Nn = normalize(vertex_normals(P, f) * 0.6 + Nn * 0.4)
    d = edge_distance(P, f)
    m = Mesh(P + Nn * offset, f)
    m.attrs['edge'] = d
    return m, W
