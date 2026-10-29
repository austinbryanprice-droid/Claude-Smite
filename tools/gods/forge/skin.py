"""Skin weights for accessory meshes, as dense (N, bones) arrays until export."""
from __future__ import annotations

import numpy as np
from scipy.spatial import cKDTree

from .body import Body


def dense(body: Body, idx: np.ndarray | None = None) -> np.ndarray:
    """Body skin weights as a dense (N, B) array (all MakeHuman verts, or `idx` of them)."""
    j, w = body.joints, body.weights
    if idx is not None:
        j, w = j[idx], w[idx]
    out = np.zeros((len(j), len(body.rig.names)), dtype=np.float32)
    np.put_along_axis(out, j.astype(np.int64), w, axis=1)
    return out


def rigid(n: int, body: Body, bone: str) -> np.ndarray:
    out = np.zeros((n, len(body.rig.names)), dtype=np.float32)
    out[:, body.rig.index(bone)] = 1
    return out


def mix(a: np.ndarray, b: np.ndarray, t) -> np.ndarray:
    t = np.asarray(t, dtype=np.float32)
    if t.ndim == 1:
        t = t[:, None]
    return a * (1 - t) + b * t


_tree_cache: dict[int, tuple[cKDTree, np.ndarray]] = {}


def transfer(v: np.ndarray, body: Body, k: int = 8, only: list[str] | None = None) -> np.ndarray:
    """Weights from the nearest body surface vertices (inverse-distance blended)."""
    key = id(body)
    if key not in _tree_cache:
        used = body.used
        _tree_cache[key] = (cKDTree(body.verts[used]), used)
    tree, used = _tree_cache[key]
    d, i = tree.query(v, k=k)
    w = 1 / np.maximum(d, 1e-4) ** 2
    w /= w.sum(axis=1, keepdims=True)
    D = dense(body, used)
    out = np.einsum('nk,nkb->nb', w, D[i])
    if only:
        mask = np.zeros(out.shape[1], dtype=bool)
        for n in only:
            mask[body.rig.index(n)] = True
        out[:, ~mask] = 0
        s = out.sum(axis=1, keepdims=True)
        fallback = body.rig.index(only[0])
        out[s[:, 0] == 0, fallback] = 1
    return out / np.maximum(out.sum(axis=1, keepdims=True), 1e-9)


def top4(W: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    order = np.argsort(-W, axis=1)[:, :4]
    w = np.take_along_axis(W, order, axis=1)
    w[w < 0.02] = 0
    s = w.sum(axis=1, keepdims=True)
    s[s == 0] = 1
    return order.astype(np.uint16), (w / s).astype(np.float32)
