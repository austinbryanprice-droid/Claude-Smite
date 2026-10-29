"""Baked ambient occlusion per vertex, across every part of a god.

Contact shadows are what make layered armor, hair and muscle read as solid:
under a pauldron, between plates, where a beard meets the chest. All parts are
voxelized together and short rays are marched from each vertex through the grid.
"""
from __future__ import annotations

import numpy as np


def _hemisphere(n: int, seed: int = 3) -> np.ndarray:
    """Cosine-weighted directions around +Z (Fibonacci spiral, deterministic)."""
    i = np.arange(n) + 0.5
    r = np.sqrt(i / n)
    a = i * np.pi * (3 - np.sqrt(5))
    return np.stack([r * np.cos(a), r * np.sin(a), np.sqrt(1 - r * r)], axis=1)


def _frames(nrm: np.ndarray):
    t = np.cross(nrm, np.array([0, 1.0, 0]))
    bad = np.linalg.norm(t, axis=1) < 1e-3
    t[bad] = np.cross(nrm[bad], np.array([1.0, 0, 0]))
    t /= np.linalg.norm(t, axis=1, keepdims=True)
    b = np.cross(nrm, t)
    return t, b


def bake(parts, voxel: float = 0.012, reach: float = 0.16, rays: int = 20, strength: float = 0.9,
         skip: tuple[str, ...] = ('eye', 'glow')) -> None:
    """Writes part.extra['ao'] (1 = open, toward 0 = enclosed) for every part."""
    solid = [p for p in parts if p.material not in skip]
    allv = np.concatenate([p.position for p in solid])
    lo = allv.min(axis=0) - reach
    hi = allv.max(axis=0) + reach
    dims = np.ceil((hi - lo) / voxel).astype(int) + 1
    grid = np.zeros(dims, dtype=bool)
    rng = np.random.default_rng(1)
    for p in solid:
        V, T = p.position, p.tris.reshape(-1, 3)
        a, b, c = V[T[:, 0]], V[T[:, 1]], V[T[:, 2]]
        area = 0.5 * np.linalg.norm(np.cross(b - a, c - a), axis=1)
        k = np.clip(np.ceil(area / (voxel * voxel) * 4), 1, 400).astype(int)
        idx = np.repeat(np.arange(len(T)), k)
        u, w = rng.random(len(idx)), rng.random(len(idx))
        flip = u + w > 1
        u[flip], w[flip] = 1 - u[flip], 1 - w[flip]
        pts = a[idx] + (b[idx] - a[idx]) * u[:, None] + (c[idx] - a[idx]) * w[:, None]
        pts = np.concatenate([pts, V])
        g = np.clip(((pts - lo) / voxel).astype(int), 0, dims - 1)
        grid[g[:, 0], g[:, 1], g[:, 2]] = True

    H = _hemisphere(rays)
    steps = np.arange(1.6, reach / voxel, 0.85) * voxel
    falloff = 1 - steps / reach  # near hits darken more
    for p in parts:
        if p.material in skip:
            p.extra['ao'] = np.ones(len(p.position), dtype=np.float32)
            continue
        V = p.position
        ln = np.linalg.norm(p.normal, axis=1, keepdims=True)
        N = np.where(ln > 1e-6, p.normal / np.maximum(ln, 1e-9), np.array([0, 1.0, 0]))
        t, b = _frames(N)
        occ = np.zeros(len(V))
        for d in H:
            dirs = t * d[0] + b * d[1] + N * d[2]
            hit = np.zeros(len(V))
            alive = np.ones(len(V), dtype=bool)
            for s, f in zip(steps, falloff):
                q = V + dirs * s
                g = np.clip(((q - lo) / voxel).astype(int), 0, dims - 1)
                h = grid[g[:, 0], g[:, 1], g[:, 2]] & alive
                hit[h] = f
                alive &= ~h
            occ += hit
        occ /= len(H)
        p.extra['ao'] = np.clip(1 - occ * strength * 1.3, 0.18, 1).astype(np.float32)
