"""Specs for runtime secondary physics (src/actors/gods/Physics.ts): capes,
cloth panels, hair locks. Everything is authored in model (bind) space."""
from __future__ import annotations

import numpy as np

from .body import Body, _seg_offset


def colliders(body: Body) -> list[dict]:
    """Capsules for the torso and limbs, sized from the skin around each bone."""
    r = body.rig
    D = np.zeros((len(body.verts), len(r.names)), dtype=np.float32)
    np.put_along_axis(D, body.joints.astype(np.int64), body.weights, axis=1)
    out = []

    def cap(bone, a, b, scale=1.0, pad=0.015):
        w = D[:, r.index(bone)]
        sel = w > 0.6
        if sel.sum() < 4:
            return
        d = np.linalg.norm(_seg_offset(body.verts[sel], a, b), axis=1)
        out.append({'bone': bone, 'a': a.tolist(), 'b': b.tolist(), 'r': float(np.percentile(d, 70) * scale + pad)})

    h = r.head
    cap('DEF-hips', h('DEF-hips') + [0, -0.05, -0.01], h('DEF-spine.001'), 0.95)
    cap('DEF-spine.002', h('DEF-spine.001'), h('DEF-spine.003'))
    cap('DEF-spine.003', h('DEF-spine.003'), h('DEF-neck') + [0, -0.04, 0], 0.95)
    for s in ('L', 'R'):
        cap(f'DEF-thigh.{s}', h(f'DEF-thigh.{s}'), h(f'DEF-shin.{s}'))
        cap(f'DEF-shin.{s}', h(f'DEF-shin.{s}'), h(f'DEF-foot.{s}'))
        cap(f'DEF-upper_arm.{s}', h(f'DEF-upper_arm.{s}'), h(f'DEF-forearm.{s}'))
    return out


def sheet(name: str, material: str, grid: np.ndarray, drive: list[str], drive_index: np.ndarray,
          stiffness: np.ndarray, gravity: float = 9.8, damping: float = 0.03) -> dict:
    rows, cols, _ = grid.shape
    uv = np.stack(np.meshgrid(np.linspace(0, 1, cols), np.linspace(0, 1, rows)), axis=-1).reshape(-1, 2)
    return {
        'name': name, 'material': material, 'rows': rows, 'cols': cols,
        'points': np.round(grid.reshape(-1, 3), 5).tolist(), 'uvs': np.round(uv, 4).tolist(),
        'drive': drive, 'driveIndex': drive_index.reshape(-1).astype(int).tolist(),
        'stiffness': np.round(stiffness.reshape(-1), 4).tolist(), 'gravity': gravity, 'damping': damping,
    }


def stiffness_profile(rows: int, cols: int, pinned_rows: int = 1, top: float = 0.5, bottom: float = 0.02) -> np.ndarray:
    t = np.linspace(0, 1, rows)
    s = top * (1 - t) ** 2 + bottom
    s[:pinned_rows] = 1
    return np.repeat(s[:, None], cols, axis=1)


def back_surface(body: Body, x: float, y: float, band: float = 0.025, front: bool = False) -> float | None:
    """z of the body surface behind (or in front of) the point (x, y), skipping the arms."""
    V = body.verts[body.used]
    sel = (np.abs(V[:, 0] - x) < band) & (np.abs(V[:, 1] - y) < band)
    if not sel.any():
        return None
    return float(V[sel, 2].max() if front else V[sel, 2].min())


def cape(body: Body, name='cape', material='cloth', width=0.5, length=1.4, rows=18, cols=15, clearance=0.05,
         flare=0.25, top_y=None, arm_mask=None) -> dict:
    r = body.rig
    neck = r.head('DEF-neck')
    top = neck[1] - 0.06 if top_y is None else top_y
    grid = np.zeros((rows, cols, 3))
    V = body.verts[body.used]
    keep = np.ones(len(V), dtype=bool) if arm_mask is None else ~arm_mask[body.used]
    Vb = V[keep]
    last_z = np.full(cols, -0.15)
    for i in range(rows):
        t = i / (rows - 1)
        y = top - t * length
        for j in range(cols):
            u = j / (cols - 1) - 0.5
            x = u * width * (1 + flare * t)
            sel = (np.abs(Vb[:, 0] - x) < 0.03) & (np.abs(Vb[:, 1] - y) < 0.03)
            z = Vb[sel, 2].min() - clearance if sel.any() else last_z[j]
            z = min(z, last_z[j]) if i > 0 else z  # hang straight once past the buttocks
            # wrap the top edge forward over the shoulders a little
            if i == 0:
                z += 0.02 + 0.06 * (abs(u) * 2) ** 2
            last_z[j] = z
            # soft vertical folds that deepen toward the hem
            fold = np.sin(u * np.pi * 5 + 0.5) * 0.03 * t
            grid[i, j] = [x, y, z - abs(fold) - 0.01 * t]
    stiff = stiffness_profile(rows, cols, 1, 0.6, 0.015)
    drive = ['DEF-spine.003', 'DEF-hips']
    di = np.zeros((rows, cols), dtype=int)
    di[rows // 2:] = 0  # whole cape follows the chest; hips would twist it when strafing
    return sheet(name, material, grid, drive, di, stiff)


def panel(body: Body, name: str, material: str, top: float, front: bool, width: float, length: float,
          rows: int = 9, cols: int = 6, flare: float = 0.15, arm_mask=None, clearance=0.03) -> dict:
    """A loincloth or tabard panel hanging from the belt."""
    V = body.verts[body.used]
    keep = np.ones(len(V), dtype=bool) if arm_mask is None else ~arm_mask[body.used]
    Vb = V[keep]
    sgn = 1 if front else -1
    grid = np.zeros((rows, cols, 3))
    for j in range(cols):
        x0 = (j / (cols - 1) - 0.5) * width
        sel = (np.abs(Vb[:, 0] - x0) < 0.03) & (np.abs(Vb[:, 1] - top) < 0.03)
        z0 = (Vb[sel, 2].max() if front else Vb[sel, 2].min()) if sel.any() else 0.15 * sgn
        for i in range(rows):
            t = i / (rows - 1)
            grid[i, j] = [x0 * (1 + flare * t), top - t * length, z0 + sgn * (clearance + 0.05 * t)]
    stiff = stiffness_profile(rows, cols, 1, 0.5, 0.03)
    return sheet(name, material, grid, ['DEF-hips'], np.zeros((rows, cols), dtype=int), stiff)


def lock(name: str, material: str, root: np.ndarray, direction: np.ndarray, side: np.ndarray, length: float,
         width: float, bone: str, rows: int = 7, taper: float = 0.4) -> dict:
    """A narrow two-column ribbon (hair lock, belt tassel) hanging from a point."""
    d = direction / np.linalg.norm(direction)
    s = side / np.linalg.norm(side)
    grid = np.zeros((rows, 2, 3))
    for i in range(rows):
        t = i / (rows - 1)
        w = width * (1 - (1 - taper) * t) / 2
        c = root + d * length * t
        grid[i, 0] = c - s * w
        grid[i, 1] = c + s * w
    stiff = stiffness_profile(rows, 2, 1, 0.5, 0.05)
    return sheet(name, material, grid, [bone], np.zeros((rows, 2), dtype=int), stiff)
