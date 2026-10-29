"""Signed-distance sculpting for shapes the human base mesh can't morph into
(animal heads). Primitives combine with smooth unions and are meshed with
marching cubes."""
from __future__ import annotations

import numpy as np
from skimage import measure

from .geo import Mesh
from .shell import laplacian


def sphere(p, c, r):
    return np.linalg.norm(p - c, axis=-1) - r


def ellipsoid(p, c, r):
    q = (p - c) / r
    k0 = np.linalg.norm(q, axis=-1)
    k1 = np.linalg.norm(q / r, axis=-1)
    return k0 * (k0 - 1) / np.maximum(k1, 1e-9)


def capsule(p, a, b, ra, rb=None, squash=None):
    """Round cone from a (radius ra) to b (radius rb). squash=(axis, k) scales distance along an axis
    (k > 1 flattens the shape across that axis)."""
    rb = ra if rb is None else rb
    pa = p - a
    if squash is not None:
        ax, k = squash
        ax = ax / np.linalg.norm(ax)
        pa = pa + (pa @ ax)[..., None] * ax * (k - 1)
    ba = b - a
    h = np.clip((pa @ ba) / (ba @ ba), 0, 1)
    return np.linalg.norm(pa - h[..., None] * ba, axis=-1) - (ra + (rb - ra) * h)


def smin(a, b, k):
    h = np.clip(0.5 + 0.5 * (b - a) / k, 0, 1)
    return b * (1 - h) + a * h - k * h * (1 - h)


def smax(a, b, k):
    return -smin(-a, -b, k)


def mesh(fn, lo, hi, step=0.004, smooth=2) -> Mesh:
    lo, hi = np.asarray(lo, float), np.asarray(hi, float)
    n = np.ceil((hi - lo) / step).astype(int) + 1
    axes = [np.linspace(lo[i], lo[i] + (n[i] - 1) * step, n[i]) for i in range(3)]
    P = np.stack(np.meshgrid(*axes, indexing='ij'), axis=-1)
    D = fn(P.reshape(-1, 3)).reshape(P.shape[:3])
    v, f, _, _ = measure.marching_cubes(D, 0.0, spacing=(step, step, step))
    v = v + lo
    f = f.copy()
    if smooth:
        v = laplacian(v, f, smooth, 0.4)
    return Mesh(v, f)
