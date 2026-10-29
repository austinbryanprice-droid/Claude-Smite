"""Procedural mesh toolkit for armor, weapons, hair and ornaments.

A `Mesh` is triangles plus optional per-vertex UV and color. Skinning is
attached at the end (`skin.py`), so shapes can be built in plain model space.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

from .mathx import normalize, axis_angle, rot_between


@dataclass
class Mesh:
    v: np.ndarray
    f: np.ndarray
    uv: np.ndarray | None = None
    col: np.ndarray | None = None  # (N,4) material-specific data channels
    n: np.ndarray | None = None  # explicit normals (else computed)
    attrs: dict = field(default_factory=dict)  # extra (N,) float channels

    def copy(self) -> 'Mesh':
        return Mesh(self.v.copy(), self.f.copy(), None if self.uv is None else self.uv.copy(),
                    None if self.col is None else self.col.copy(), None if self.n is None else self.n.copy(),
                    {k: a.copy() for k, a in self.attrs.items()})

    def transformed(self, R=None, t=None, s=None) -> 'Mesh':
        m = self.copy()
        if s is not None:
            m.v = m.v * np.asarray(s)
            if m.n is not None:
                m.n = normalize(m.n / np.asarray(s))
            if np.prod(np.sign(np.broadcast_to(np.asarray(s, dtype=float), (3,)))) < 0:
                m.f = m.f[:, ::-1].copy()
        if R is not None:
            m.v = m.v @ np.asarray(R).T
            if m.n is not None:
                m.n = m.n @ np.asarray(R).T
        if t is not None:
            m.v = m.v + np.asarray(t)
        return m

    def mirrored_x(self) -> 'Mesh':
        return self.transformed(s=[-1, 1, 1])

    def normals(self) -> np.ndarray:
        if self.n is not None:
            return self.n
        return vertex_normals(self.v, self.f)


def vertex_normals(v: np.ndarray, f: np.ndarray) -> np.ndarray:
    fn = np.cross(v[f[:, 1]] - v[f[:, 0]], v[f[:, 2]] - v[f[:, 0]])
    n = np.zeros_like(v)
    for k in range(3):
        np.add.at(n, f[:, k], fn)
    return normalize(n)


def merge(meshes: list[Mesh]) -> Mesh:
    meshes = [m for m in meshes if m is not None and len(m.f)]
    vs, fs, uvs, cols, ns = [], [], [], [], []
    keys = set().union(*[m.attrs.keys() for m in meshes]) if meshes else set()
    attrs = {k: [] for k in keys}
    off = 0
    for m in meshes:
        vs.append(m.v)
        fs.append(m.f + off)
        uvs.append(m.uv if m.uv is not None else np.zeros((len(m.v), 2)))
        cols.append(m.col if m.col is not None else np.zeros((len(m.v), 4)))
        ns.append(m.normals())
        for k in keys:
            attrs[k].append(m.attrs.get(k, np.zeros(len(m.v))))
        off += len(m.v)
    return Mesh(np.concatenate(vs), np.concatenate(fs), np.concatenate(uvs), np.concatenate(cols), np.concatenate(ns),
                {k: np.concatenate(a) for k, a in attrs.items()})


def split_sharp(m: Mesh, angle_deg: float = 40) -> Mesh:
    """Unwelds vertices across edges sharper than angle so hard surfaces shade crisply."""
    v, f = m.v, m.f
    fn_raw = np.cross(v[f[:, 1]] - v[f[:, 0]], v[f[:, 2]] - v[f[:, 0]])
    fn = normalize(fn_raw)
    cos = np.cos(np.radians(angle_deg))
    nf = len(f)
    corner_v = f.reshape(-1)
    corner_f = np.repeat(np.arange(nf), 3)
    order = np.argsort(corner_v, kind='stable')
    sv = corner_v[order]
    starts = np.searchsorted(sv, np.arange(len(v)))
    ends = np.searchsorted(sv, np.arange(len(v)), side='right')
    new_n = np.zeros((nf * 3, 3))
    for vi in range(len(v)):
        cs = order[starts[vi]:ends[vi]]
        if len(cs) == 0:
            continue
        faces = corner_f[cs]
        N = fn[faces]
        sim = (N @ N.T) > cos
        new_n[cs] = normalize(sim.astype(float) @ fn_raw[faces])
    # weld corners that share vertex and (nearly) normal
    key = np.concatenate([corner_v[:, None].astype(np.float64), np.round(new_n * 64)], axis=1)
    uniq, inv = np.unique(key, axis=0, return_inverse=True)
    first = np.zeros(len(uniq), dtype=np.int64)
    first[inv[::-1]] = np.arange(len(inv))[::-1]
    src = corner_v[first]
    out = Mesh(v[src], inv.reshape(-1, 3), None if m.uv is None else m.uv[src], None if m.col is None else m.col[src],
               normalize(new_n[first]), {k: a[src] for k, a in m.attrs.items()})
    return out


# ---------------------------------------------------------------- primitives

def grid_faces(rows: int, cols: int, wrap: bool = False) -> np.ndarray:
    """Quad grid (rows x cols vertices) as triangles; `wrap` closes the columns."""
    f = []
    cmax = cols if wrap else cols - 1
    for r in range(rows - 1):
        for c in range(cmax):
            a = r * cols + c
            b = r * cols + (c + 1) % cols
            d = (r + 1) * cols + c
            e = (r + 1) * cols + (c + 1) % cols
            f.append([a, d, b])
            f.append([b, d, e])
    return np.array(f, dtype=np.int64)


def lathe(profile, segments: int = 32, arc: float = 2 * np.pi, start: float = 0.0, scale_xz=(1.0, 1.0)) -> Mesh:
    """Revolves (radius, y) points around +Y. u = angle, v = distance along the profile."""
    p = np.asarray(profile, dtype=np.float64)
    full = abs(arc - 2 * np.pi) < 1e-6
    cols = segments if full else segments + 1
    ang = start + np.arange(cols) / segments * arc
    rows = len(p)
    v = np.zeros((rows, cols, 3))
    v[:, :, 0] = p[:, 0:1] * np.sin(ang)[None] * scale_xz[0]
    v[:, :, 1] = p[:, 1:2]
    v[:, :, 2] = p[:, 0:1] * np.cos(ang)[None] * scale_xz[1]
    seg = np.r_[0, np.cumsum(np.linalg.norm(np.diff(p, axis=0), axis=1))]
    uv = np.zeros((rows, cols, 2))
    uv[:, :, 0] = (np.arange(cols) / segments)[None]
    uv[:, :, 1] = (seg / max(seg[-1], 1e-9))[:, None]
    return Mesh(v.reshape(-1, 3), grid_faces(rows, cols, wrap=full)[:, ::-1].copy(), uv.reshape(-1, 2))


def frames(path: np.ndarray, up=None) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Parallel-transport frames (tangent, normal, binormal) along a polyline."""
    t = np.gradient(path, axis=0)
    t = normalize(t)
    n = np.zeros_like(path)
    ref = np.array(up if up is not None else [0, 0, 1.0])
    if abs(np.dot(ref, t[0])) > 0.95:
        ref = np.array([1.0, 0, 0])
    n[0] = normalize(np.cross(np.cross(t[0], ref), t[0]))
    for i in range(1, len(path)):
        R = rot_between(t[i - 1], t[i])
        n[i] = normalize(R @ n[i - 1])
    b = np.cross(t, n)
    return t, n, b


def sweep(path, section, scale=None, up=None, closed_section: bool = True, cap: bool = True, twist=None) -> Mesh:
    """Sweeps a 2D section (x along normal, y along binormal) along a path.

    `scale` is per path point (scalar or (K,2)). u runs around the section, v along the path.
    """
    path = np.asarray(path, dtype=np.float64)
    sec = np.asarray(section, dtype=np.float64)
    K, P = len(path), len(sec)
    if scale is None:
        scale = np.ones(K)
    scale = np.asarray(scale, dtype=np.float64)
    if scale.ndim == 1:
        scale = np.stack([scale, scale], axis=1)
    T, N, B = frames(path, up)
    if twist is not None:
        tw = np.asarray(twist, dtype=np.float64)
        c, s = np.cos(tw)[:, None], np.sin(tw)[:, None]
        N, B = N * c + B * s, -N * s + B * c
    v = path[:, None, :] + N[:, None, :] * (sec[None, :, 0:1] * scale[:, None, 0:1]) + B[:, None, :] * (sec[None, :, 1:2] * scale[:, None, 1:2])
    f = grid_faces(K, P, wrap=closed_section)[:, ::-1].copy()
    seg = np.r_[0, np.cumsum(np.linalg.norm(np.diff(path, axis=0), axis=1))]
    uv = np.zeros((K, P, 2))
    uv[:, :, 0] = (np.arange(P) / (P if closed_section else P - 1))[None]
    uv[:, :, 1] = (seg / max(seg[-1], 1e-9))[:, None]
    m = Mesh(v.reshape(-1, 3), f, uv.reshape(-1, 2))
    if cap and closed_section:
        caps = []
        for end, flip in ((0, True), (K - 1, False)):
            ring = np.arange(P) + end * P
            if np.allclose(scale[end], 0):
                continue
            center = len(m.v) + len(caps) * 0
            cv = v[end].mean(axis=0)
            m.v = np.vstack([m.v, cv])
            m.uv = np.vstack([m.uv, [0.5, float(end > 0)]])
            ci = len(m.v) - 1
            tri = np.stack([np.full(P, ci), ring, np.roll(ring, -1)], axis=1)
            if flip:
                tri = tri[:, ::-1]
            caps.append(tri)
            del center
        if caps:
            m.f = np.vstack([m.f] + caps)
    return m


def circle(n: int, rx: float = 1.0, ry: float | None = None) -> np.ndarray:
    a = np.arange(n) / n * 2 * np.pi
    return np.stack([np.cos(a) * rx, np.sin(a) * (rx if ry is None else ry)], axis=1)


def tube(path, radii, sides: int = 8, up=None, flat: float = 1.0, cap: bool = True, twist=None) -> Mesh:
    r = np.asarray(radii, dtype=np.float64)
    if r.ndim == 0:
        r = np.full(len(path), float(r))
    return sweep(path, circle(sides, 1.0, flat), r, up=up, cap=cap, twist=twist)


def sphere(r: float = 1.0, seg: int = 24, rings: int = 16) -> Mesh:
    a = np.linspace(0, np.pi, rings + 1)
    prof = np.stack([np.sin(a) * r, -np.cos(a) * r], axis=1)
    prof[0, 0] = prof[-1, 0] = 1e-5
    return lathe(prof, seg)


def polygon_triangulate(poly: np.ndarray) -> np.ndarray:
    """Ear clipping for a simple CCW polygon."""
    idx = list(range(len(poly)))
    tris = []

    def area(a, b, c):
        return (b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])

    if sum(area(poly[0], poly[i], poly[i + 1]) for i in range(1, len(poly) - 1)) < 0:
        idx.reverse()
    guard = 0
    while len(idx) > 3 and guard < 10000:
        guard += 1
        for k in range(len(idx)):
            i0, i1, i2 = idx[k - 1], idx[k], idx[(k + 1) % len(idx)]
            a, b, c = poly[i0], poly[i1], poly[i2]
            if area(a, b, c) <= 1e-12:
                continue
            ok = True
            for j in idx:
                if j in (i0, i1, i2):
                    continue
                p = poly[j]
                if area(a, b, p) >= 0 and area(b, c, p) >= 0 and area(c, a, p) >= 0:
                    ok = False
                    break
            if ok:
                tris.append([i0, i1, i2])
                idx.pop(k)
                break
        else:
            break
    if len(idx) == 3:
        tris.append(idx)
    return np.array(tris, dtype=np.int64)


def extrude(poly, depth: float, bevel: float = 0.0, bevel_steps: int = 2) -> Mesh:
    """Extrudes a 2D polygon (x, y) along z from -depth/2 to depth/2, with an optional rounded bevel."""
    poly = np.asarray(poly, dtype=np.float64)
    if np.sum(poly[:, 0] * np.roll(poly[:, 1], -1) - np.roll(poly[:, 0], -1) * poly[:, 1]) < 0:
        poly = poly[::-1].copy()
    n = len(poly)
    tri = polygon_triangulate(poly)
    e = np.roll(poly, -1, axis=0) - poly
    en = normalize(np.stack([e[:, 1], -e[:, 0]], axis=1))  # outward for CCW
    vn = normalize(en + np.roll(en, 1, axis=0))
    rings = []
    steps = max(1, bevel_steps) if bevel > 0 else 1
    profile = []
    if bevel > 0:
        for s_ in range(steps + 1):
            a = s_ / steps * np.pi / 2
            profile.append((-(1 - np.sin(a)) * bevel, -depth / 2 + bevel * (1 - np.cos(a))))
        for s_ in range(steps + 1):
            a = s_ / steps * np.pi / 2
            profile.append((-(1 - np.cos(a)) * bevel, depth / 2 - bevel + bevel * np.sin(a)))
    else:
        profile = [(0, -depth / 2), (0, depth / 2)]
    for inset, z in profile:
        ring = np.zeros((n, 3))
        ring[:, :2] = poly + vn * inset
        ring[:, 2] = z
        rings.append(ring)
    R = len(rings)
    v = np.concatenate(rings)
    f = grid_faces(R, n, wrap=True)
    back = tri[:, ::-1]
    front = tri + (R - 1) * n
    m = Mesh(v, np.vstack([f[:, ::-1], back, front]))
    uv = np.zeros((len(v), 2))
    lo, hi = poly.min(axis=0), poly.max(axis=0)
    uv[:, :] = (v[:, :2] - lo) / np.maximum(hi - lo, 1e-9)
    m.uv = uv
    m = split_sharp(m, 50)
    return m


def bend(m: Mesh, fn) -> Mesh:
    """Applies an arbitrary vertex deformation fn(v) -> v and recomputes normals."""
    out = m.copy()
    out.v = fn(out.v.copy())
    out.n = None
    return out


def look_rotation(forward, up=(0, 1, 0)) -> np.ndarray:
    """Rotation whose +Z points along forward and +Y toward up."""
    z = normalize(np.asarray(forward, dtype=np.float64))
    x = normalize(np.cross(up, z))
    y = np.cross(z, x)
    return np.stack([x, y, z], axis=1)


def place(m: Mesh, origin, forward=(0, 0, 1), up=(0, 1, 0), scale=None) -> Mesh:
    return m.transformed(s=scale).transformed(R=look_rotation(forward, up), t=origin)


__all__ = ['Mesh', 'merge', 'split_sharp', 'lathe', 'sweep', 'tube', 'sphere', 'extrude', 'circle', 'bend', 'place',
           'look_rotation', 'axis_angle', 'grid_faces', 'frames']
