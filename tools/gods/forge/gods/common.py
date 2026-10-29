"""Shared body presets."""
from __future__ import annotations


def heroic(k: float = 1.0, hands: float = 0.5) -> dict[str, float]:
    """Smite-style heroic exaggeration: V-shaped torso, big shoulders and arms, large hands."""
    out = {
        'torso/torso-vshape-incr': 0.9 * k,
        'torso/torso-muscle-pectoral-incr': 0.7 * k,
        'torso/torso-muscle-dorsi-incr': 0.8 * k,
        'torso/torso-scale-horiz-incr': 0.25 * k,
        'stomach/stomach-tone-incr': 0.8 * k,
        'neck/neck-scale-horiz-incr': 0.5 * k,
        'neck/neck-scale-depth-incr': 0.3 * k,
    }
    for s in ('l', 'r'):
        out.update({
            f'armslegs/{s}-upperarm-muscle-incr': 0.9 * k,
            f'armslegs/{s}-upperarm-shoulder-muscle-incr': 1.0 * k,
            f'armslegs/{s}-lowerarm-muscle-incr': 0.8 * k,
            f'armslegs/{s}-upperleg-muscle-incr': 0.6 * k,
            f'armslegs/{s}-lowerleg-muscle-incr': 0.6 * k,
            f'armslegs/{s}-hand-scale-incr': hands,
            f'armslegs/{s}-foot-scale-incr': hands * 0.4,
        })
    return out


# ---------------------------------------------------------------- head landmarks and hair

import numpy as np  # noqa: E402

from .. import hair as hairmod, skin  # noqa: E402
from ..geo import Mesh, grid_faces  # noqa: E402
from ..mathx import normalize  # noqa: E402
from ..regions import smooth  # noqa: E402


def face_fields(god):
    """Landmarks of the head in model space."""
    b = god.body
    J = b.J
    eye = (J['eye.L____head'] + J['eye.R____head']) / 2
    chin = J['jaw____tail']
    head = god.F.joint('DEF-head')
    crown = J['head____tail']
    mouth = np.array([0, eye[1] - 0.55 * (eye[1] - chin[1]), J['oris06____head'][2]])
    return dict(eye=eye, chin=chin, head=head, crown=crown, mouth=mouth, neck=god.F.joint('DEF-neck'))


def head_weights(god, P: np.ndarray, fall: float = 0.18) -> np.ndarray:
    """Rigid on the head, sliding to the upper spine for hair that falls below the neck."""
    lm = face_fields(god)
    t = smooth(lm['head'][1] - P[:, 1], 0.0, fall)
    W = skin.mix(skin.rigid(len(P), god.body, 'DEF-head'), skin.rigid(len(P), god.body, 'DEF-neck'), np.clip(t * 1.5, 0, 0.5))
    return skin.mix(W, skin.rigid(len(P), god.body, 'DEF-spine.003'), np.clip(t * 1.2 - 0.3, 0, 0.6))


def add_hair_head(god, hair_len=0.25, beard_len=0.15, mustache=True, brows=True, seed=1, wild=0.25,
                  bald_top=False, beard=True, hair=True, material='hair', spacing=0.022, cap_y=None):
    F, b = god.F, god.body
    lm = face_fields(god)
    v = F.v
    y, z = v[:, 1], v[:, 2]
    headw = F.bones('DEF-head')
    ey, ez = lm['eye'][1], lm['eye'][2]
    rel_z = z - lm['head'][2]
    meshes = []
    if hair:
        # hairline: high on the forehead, above the ears on the sides, low at the nape
        front = smooth(rel_z, 0.02, 0.07)
        backness = smooth(-rel_z, 0.0, 0.05)
        line = (ey + 0.045) * front + (ey + 0.012) * (1 - front) * (1 - backness) + (lm['neck'][1] + 0.07) * backness
        scalp = np.minimum(smooth(headw, 0.5, 0.8), smooth(y - line, 0, 0.01))
        if bald_top:
            scalp = np.minimum(scalp, smooth(-(y - lm['crown'][1] + 0.06), 0, 0.02))
        if cap_y is not None:  # under a helmet: only the hair that falls out below its rim
            scalp = np.minimum(scalp, smooth(cap_y - y, 0, 0.01))
        crown = lm['crown'] - np.array([0, 0.03, 0.02])

        def flow(p):
            # combed back from the hairline, sides sweep back and down
            out = p - crown
            side = np.zeros_like(out)
            side[:, 0] = out[:, 0] * 4
            return normalize(side * 0.4 + np.array([0, -0.25, -1.0]))

        def length(P, N):
            back = smooth(-(P[:, 2] - lm['head'][2]), -0.06, 0.08)
            return hair_len * (0.35 + 0.65 * back) * np.random.default_rng(seed).uniform(0.8, 1.15, len(P))

        style = hairmod.Style(length=length, width=0.05, flatness=0.32, segments=12, sides=8, lift=0.12, gravity=0.6, flow=flow,
                           curl=wild, curl_freq=1.1, jitter=0.2, clearance=0.018, taper=1.2, seed=seed)
        m, _ = hairmod.hair(b, scalp, spacing * 0.8, style)
        # a second, fuller layer further out gives the mane volume
        style2 = hairmod.Style(length=lambda P, N: length(P, N) * 1.15, width=0.065, flatness=0.3, segments=12, sides=8, lift=0.22,
                               gravity=0.6, flow=flow, curl=wild * 1.2, curl_freq=0.9, jitter=0.25, clearance=0.034, taper=1.2, seed=seed + 11)
        m2, _ = hairmod.hair(b, scalp, spacing * 1.2, style2)
        meshes.append(m2)
        meshes.append(m)
    if beard:
        mouth = lm['mouth']
        jaw = np.minimum.reduce([
            smooth(headw, 0.5, 0.8),
            smooth(-(y - (ey - 0.05)), 0, 0.012),
            smooth(rel_z, 0.0, 0.03),
            smooth(np.linalg.norm(v - mouth, axis=1), 0.024, 0.03),
        ])

        def bflow(p):
            return normalize(np.array([0, -1.0, 0.45]) + (p - mouth) * np.array([3, 0, 0]))

        def blen(P, N):
            center = smooth(-np.abs(P[:, 0]), -0.07, 0.0)
            low = smooth(-(P[:, 1] - mouth[1]), 0.0, 0.05)
            return beard_len * (0.3 + 0.7 * center * (0.4 + 0.6 * low))

        style = hairmod.Style(length=blen, width=0.036, flatness=0.32, segments=10, sides=8, lift=0.3, gravity=0.6, flow=bflow,
                           curl=wild * 0.8, curl_freq=1.6, jitter=0.25, clearance=0.01, tip_curl=0.2, seed=seed + 1)
        m, _ = hairmod.hair(b, jaw, spacing * 0.85, style)
        meshes.append(m)
    if mustache:
        mouth = lm['mouth']
        roots, norms = [], []
        for sgn in (-1, 1):
            for t in np.linspace(0.15, 1.0, 4):
                roots.append(mouth + np.array([sgn * 0.022 * t, 0.014, -0.004]))
                norms.append(normalize(np.array([sgn * 0.3, 0.1, 1.0])))
        roots, norms = np.array(roots), np.array(norms)

        def mflow(p):
            return normalize(np.array([np.sign(p[0, 0]) * 0.9, -0.8, 0.25]))[None].repeat(len(p), 0)
        style = hairmod.Style(length=0.07, width=0.02, flatness=0.5, segments=6, lift=0.2, gravity=0.4, flow=mflow,
                           jitter=0.1, clearance=0.006, seed=seed + 2)
        paths = hairmod.grow(b, roots, norms, style)
        meshes.append(hairmod.clumps(paths, norms, style))
    if brows:
        eye = lm['eye']
        roots, norms = [], []
        for sgn in (-1, 1):
            for t in np.linspace(0.0, 1.0, 6):
                x = sgn * (0.012 + 0.05 * t)
                roots.append(np.array([x, eye[1] + 0.03 + 0.008 * np.sin(t * np.pi), eye[2] + 0.012 - 0.03 * t * t]))
                norms.append(normalize(np.array([sgn * 0.3 * t, 0.25, 1.0])))
        roots, norms = np.array(roots), np.array(norms)

        def wflow(p):
            return normalize(np.stack([np.sign(p[:, 0]), np.full(len(p), 0.35), np.zeros(len(p))], axis=1))
        style = hairmod.Style(length=0.03, width=0.013, flatness=0.5, segments=4, lift=0.3, gravity=0.0, flow=wflow,
                           jitter=0.05, clearance=0.004, seed=seed + 3)
        paths = hairmod.grow(b, roots, norms, style)
        meshes.append(hairmod.clumps(paths, norms, style))
    from ..geo import merge
    m = merge(meshes)
    god.add('hair', material, m, head_weights(god, m.v))
    return m


def add_cloth_panel(god, name, material, top, front=True, width=0.3, length=0.5, flare=0.06, cols=8, rows=10):
    """A static cloth panel hanging from the belt in front or behind."""
    b = god.body
    P = b.verts[b.used]
    band = (np.abs(P[:, 1] - top) < 0.03) & (god.F.arms()[b.used] < 0.05)
    sgn = 1 if front else -1
    grid = np.zeros((rows, cols, 3))
    for c in range(cols):
        x = (c / (cols - 1) - 0.5) * width
        near = band & (np.abs(P[:, 0] - x) < 0.03)
        zz = (P[near, 2].max() if front else P[near, 2].min()) if near.any() else 0.15 * sgn
        for r in range(rows):
            t = r / (rows - 1)
            grid[r, c] = [x * (1 + t * 0.25), top - t * length, zz + sgn * (0.035 + flare * t + 0.02 * np.sin(c * 1.7) * t)]
    v = grid.reshape(-1, 3)
    f = grid_faces(rows, cols)
    if not front:
        f = f[:, ::-1]
    uv = np.stack(np.meshgrid(np.linspace(0, 1, cols), np.linspace(0, 1, rows)), axis=-1).reshape(-1, 2)
    m = Mesh(v, f, uv)
    t = np.clip((top - v[:, 1]) / length, 0, 1)
    W = skin.rigid(len(v), b, 'DEF-hips')
    for s, sx in (('L', 1), ('R', -1)):
        thigh = skin.rigid(len(v), b, f'DEF-thigh.{s}')
        k = np.clip(v[:, 0] * sx / max(width / 2, 1e-6), 0, 1) * 0.4 + 0.15
        W = skin.mix(W, thigh, t * k * (v[:, 0] * sx > -0.02))
    god.add(name, material, m, W)
    return m


def add_skirt(god, name, material, top, length, flare=0.08, pleats=20, depth=0.008, clearance=0.025, rows=8, seg=48):
    """A pleated cloth skirt wrapped around the hips, flaring toward the hem."""
    from ..geo import lathe
    b = god.body
    P = b.verts[b.used]
    keep = god.F.arms()[b.used] < 0.05
    P = P[keep]
    ang = np.arange(seg) / seg * 2 * np.pi
    dirs = np.stack([np.sin(ang), np.zeros(seg), np.cos(ang)], axis=1)
    rad = np.zeros((rows, seg))
    ys = top - np.linspace(0, 1, rows) ** 1.1 * length
    cz = 0.0
    for i, yy in enumerate(ys):
        band = np.abs(P[:, 1] - yy) < 0.03
        Q = P[band] - np.array([0, 0, cz])
        for j, d in enumerate(dirs):
            # radius of the body in this direction (within a narrow wedge)
            proj = Q @ d
            wedge = np.abs(Q @ np.array([d[2], 0, -d[0]])) < 0.04
            r = proj[wedge & (proj > 0)].max() if (wedge & (proj > 0)).any() else 0.15
            rad[i, j] = r
    # never narrower than the row above (hangs over the buttocks and thighs)
    rad = np.maximum.accumulate(rad, axis=0)
    t = np.linspace(0, 1, rows)[:, None]
    rad = rad + clearance + flare * t ** 1.3 + np.sin(ang[None] * pleats) * depth * (0.3 + t)
    v = np.zeros((rows, seg, 3))
    v[..., 0] = rad * np.sin(ang)[None]
    v[..., 1] = ys[:, None]
    v[..., 2] = rad * np.cos(ang)[None] + cz
    m = lathe(np.stack([np.ones(rows), ys], axis=1), segments=seg)
    m.v = v.reshape(-1, 3)
    vv = m.v
    tt = np.clip((top - vv[:, 1]) / length, 0, 1)
    # split between the legs like wide trousers, so a thigh never pushes through the cloth
    left = smooth(vv[:, 0], -0.05, 0.05)
    follow = np.clip(tt * 3.0, 0, 1) * 0.85
    W = skin.rigid(len(vv), b, 'DEF-hips')
    legs = skin.mix(skin.rigid(len(vv), b, 'DEF-thigh.R'), skin.rigid(len(vv), b, 'DEF-thigh.L'), left)
    W = skin.mix(W, legs, follow)
    god.add(name, material, m, W)
    # skin hidden under the upper skirt, so a hip or thigh can't poke through
    yb = god.F.y()
    m.hide = (yb < top) & (yb > top - length * 0.55) & (god.F.bones('thigh', 'hips') > 0.5) & (god.F.arms() < 0.1)
    return m


def add_boot_feet(god, material='leather', pad=0.012, top=0.11):
    """Smooth closed boot feet: the hull of each foot below `top`, padded out. Returns the skin to hide."""
    from scipy.spatial import ConvexHull
    from ..geo import Mesh
    from ..shell import laplacian
    b = god.body
    hide = np.zeros(len(b.verts), dtype=bool)
    for s in ('L', 'R'):
        sel = (god.F.bones(f'foot.{s}', f'toe.{s}') > 0.3) | ((god.F.bones(f'shin.{s}') > 0.3) & (god.F.y() < top))
        idx = np.intersect1d(np.where(sel & (god.F.y() < top))[0], b.used)
        P = b.verts[idx]
        hull = ConvexHull(P)
        keep = np.unique(hull.simplices)
        remap = -np.ones(len(P), dtype=int)
        remap[keep] = np.arange(len(keep))
        V = P[keep]
        f = remap[hull.simplices]
        c = V.mean(axis=0)
        # consistent outward winding
        n = np.cross(V[f[:, 1]] - V[f[:, 0]], V[f[:, 2]] - V[f[:, 0]])
        flip = np.einsum('ij,ij->i', n, V[f].mean(axis=1) - c) < 0
        f[flip] = f[flip][:, ::-1]
        V = laplacian(V, f, 2, 0.4)
        m = Mesh(V, f)
        nn = m.normals()
        V = V + nn * pad
        V[:, 1] = np.maximum(V[:, 1], 0.004)
        m = Mesh(V, f)
        W = skin.transfer(V, b, only=[f'DEF-foot.{s}', f'DEF-toe.{s}', f'DEF-shin.{s}'])
        god.add(f'bootfoot.{s}', material, m, W)
        hide[idx] = True
    return hide
