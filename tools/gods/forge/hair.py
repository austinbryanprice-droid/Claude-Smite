"""Sculpted hair, beards and fur: many tapered, flattened clumps grown from the
skin along a flow field, the way stylized game hair is sculpted. Each clump is
a swept ribbon-tube with UV.x around it (strand shading) and color.r = 0 at
the root, 1 at the tip.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Callable

import numpy as np
from scipy.spatial import cKDTree

from .body import Body
from .geo import Mesh, merge, sweep
from .mathx import normalize


@dataclass
class Style:
    length: float | Callable  # meters, or fn(root points, normals) -> (N,)
    width: float  # clump width at the root (m)
    flatness: float = 0.4  # thickness / width
    segments: int = 8
    sides: int = 6
    lift: float = 0.6  # how strongly clumps start along the skin normal
    gravity: float = 0.5
    flow: Callable | None = None  # fn(p) -> (N,3) preferred direction
    curl: float = 0.0  # radians of twist-wave per clump
    curl_freq: float = 2.0
    jitter: float = 0.25
    taper: float = 1.6  # tip sharpness
    clearance: float = 0.012  # min distance from the skin
    tip_curl: float = 0.0  # curls tips upward/outward (beards)
    seed: int = 1


def sample_roots(body: Body, field: np.ndarray, spacing: float, seed: int = 1, extra_pts: np.ndarray | None = None):
    """Roughly even points on the body surface where field > 0.5 (dart throwing on vertices + jitter)."""
    rng = np.random.default_rng(seed)
    used = body.used
    cand = used[field[used] > 0.5]
    pts, nrm = body.verts[cand], body.normals[cand]
    order = rng.permutation(len(cand))
    chosen = []
    tree_pts = []
    for i in order:
        p = pts[i]
        if tree_pts:
            d = np.min(np.linalg.norm(np.array(tree_pts) - p, axis=1))
            if d < spacing:
                continue
        tree_pts.append(p)
        chosen.append(i)
    P, N = pts[chosen], nrm[chosen]
    if extra_pts is not None:
        P = np.vstack([P, extra_pts])
    return P, N


def grow(body: Body, roots: np.ndarray, normals: np.ndarray, style: Style, collide: bool = True) -> list[np.ndarray]:
    """Clump centerlines grown from the roots along the style's flow."""
    rng = np.random.default_rng(style.seed)
    tree = cKDTree(body.verts[body.used])
    bn = body.normals[body.used]
    bv = body.verts[body.used]
    L = style.length(roots, normals) if callable(style.length) else np.full(len(roots), style.length)
    paths = []
    flow = style.flow(roots) if style.flow else np.zeros_like(roots)
    for k, (p0, n0) in enumerate(zip(roots, normals)):
        n_seg = style.segments
        step = L[k] / n_seg
        d = normalize(n0 * style.lift + flow[k] + rng.normal(size=3) * style.jitter * 0.3)
        p = p0 - n0 * 0.004
        pts = [p.copy()]
        phase = rng.uniform(0, 2 * np.pi)
        for s in range(n_seg):
            t = (s + 1) / n_seg
            f = style.flow(p[None])[0] if style.flow else np.zeros(3)
            d = normalize(d + f * 0.35 + np.array([0, -1.0, 0]) * style.gravity * 0.25 * t)
            if style.curl:
                side = normalize(np.cross(d, n0))
                d = normalize(d + side * np.sin(phase + t * style.curl_freq * 2 * np.pi) * style.curl * 0.3)
            if style.tip_curl and t > 0.6:
                d = normalize(d + n0 * style.tip_curl * (t - 0.6))
            p = p + d * step
            if collide:
                dist, i = tree.query(p)
                q, qn = bv[i], bn[i]
                h = np.dot(p - q, qn)
                if h < style.clearance:
                    p = p + qn * (style.clearance - h)
            pts.append(p.copy())
        paths.append(np.array(pts))
    return paths


def clumps(paths: list[np.ndarray], normals: np.ndarray, style: Style, widths=None) -> Mesh:
    """Flattened tapered tubes along the paths. The flat side faces away from the skin."""
    rng = np.random.default_rng(style.seed + 7)
    meshes = []
    sides = style.sides
    a = np.arange(sides) / sides * 2 * np.pi
    for k, path in enumerate(paths):
        K = len(path)
        t = np.linspace(0, 1, K)
        w = (widths[k] if widths is not None else style.width) * rng.uniform(0.8, 1.2)
        # stylized locks hold their width, swell a little, then taper in the last stretch
        start = np.clip(1 - 0.45 * style.taper, 0.2, 0.75)
        tt = np.clip((t - start) / (1 - start), 0, 1)
        prof_w = w * (1 - (tt * tt * (3 - 2 * tt)) ** 1.2 * 0.94) * (0.78 + 0.22 * np.sin(np.clip(t * 1.6, 0, 1) * np.pi))
        prof_w[0] *= 0.85
        prof_w[-1] = w * 0.03
        section = np.stack([np.cos(a) * style.flatness, np.sin(a)], axis=1)
        m = sweep(path, section, prof_w, up=normals[k], cap=False)
        col = np.zeros((len(m.v), 4))
        col[:, 0] = np.repeat(t, sides)
        col[:, 1] = rng.uniform()  # per-clump random for tint variation
        m.col = col
        meshes.append(m)
    return merge(meshes)


def hair(body: Body, field: np.ndarray, spacing: float, style: Style, extra_roots=None, extra_normals=None) -> tuple[Mesh, list[np.ndarray]]:
    P, N = sample_roots(body, field, spacing, style.seed)
    if extra_roots is not None:
        P = np.vstack([P, extra_roots])
        N = np.vstack([N, extra_normals])
    paths = grow(body, P, N, style)
    return clumps(paths, N, style), paths
