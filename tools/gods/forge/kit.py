"""Reusable armor and prop pieces positioned on a fitted body."""
from __future__ import annotations

import numpy as np

from .body import Body
from .geo import sphere, Mesh, lathe, merge, sweep, tube, extrude, circle, look_rotation, split_sharp
from .mathx import normalize, axis_angle
from . import skin


def hand_frame(body: Body, s: str):
    """Grip frame of a hand in the bind pose: (center, along fingers, across knuckles, palm normal)."""
    r = body.rig
    h = r.head(f'DEF-hand.{s}')
    mid = r.head(f'DEF-f_middle.01.{s}')
    idx = r.head(f'DEF-f_index.01.{s}')
    pink = r.head(f'DEF-f_pinky.01.{s}')
    along = normalize(mid - h)
    across = normalize(idx - pink)
    across = normalize(across - along * np.dot(across, along))
    palm = normalize(np.cross(along, across)) * (1 if s == 'L' else -1)
    center = h + along * np.linalg.norm(mid - h) * 0.95
    return center, along, across, palm


def arm_frame(body: Body, s: str):
    """Shoulder joint, arm direction (bind pose), outward-up direction for pauldrons."""
    r = body.rig
    sh = r.head(f'DEF-upper_arm.{s}')
    el = r.head(f'DEF-forearm.{s}')
    down = normalize(el - sh)
    out = np.array([1.0 if s == 'L' else -1.0, 0, 0])
    up = normalize(out - down * np.dot(out, down))  # perpendicular to the arm, pointing out/up
    return sh, down, up


def dome(radius: float, height: float, rings: int = 10, seg: int = 36, lip: float = 0.0, arc=np.pi * 0.62) -> Mesh:
    """Spherical cap shell (outer surface + rolled rim + inner), axis +Y."""
    a = np.linspace(0, arc, rings)
    prof = [[np.sin(x) * radius, np.cos(x) * height] for x in a]
    prof[0][0] = 1e-4
    last = prof[-1]
    t = 0.012
    prof += [[last[0] + lip, last[1] - 0.004], [last[0] + lip, last[1] - 0.016], [last[0] - t, last[1] - 0.012]]
    inner = [[x * (1 - t / radius), y * (1 - t / max(height, 1e-6)) - t] for x, y in prof[:-3][::-1]]
    inner[-1][0] = 1e-4
    m = lathe(prof + inner, seg)
    return split_sharp(m, 55)


def pauldron(body: Body, s: str, size: float = 1.0, layers: int = 3, flare: float = 0.0, spikes: int = 0,
             arm_follow: float = 0.35, rivets: int = 0):
    """Layered shoulder guard sitting on top of the shoulder.

    It mostly follows the clavicle bone (so it stays on the shoulder as the
    arm swings) and partly the upper arm.
    """
    sh, _, _ = arm_frame(body, s)
    out = np.array([1.0 if s == 'L' else -1.0, 0, 0])
    up = normalize(out * 0.5 + np.array([0, 1.0, 0]))
    down = normalize(out * 0.8 - np.array([0, 1.0, 0]) * 0.6)  # where the layers step toward
    fwd = np.array([0, 0, 1.0])
    pieces = []
    R_base = look_rotation(fwd, up)
    for i in range(layers):
        k = 1 - i * 0.14
        d = dome(0.15 * size * k, 0.085 * size * k * (1 + flare), lip=0.01)
        d = d.transformed(s=[1.1, 1, 1.3])
        c = sh + up * (0.06 * size) + down * (i * 0.06 * size) + out * 0.015 - fwd * 0.01
        tilt = axis_angle(fwd, (-1 if s == 'L' else 1) * i * 0.22)
        pieces.append(d.transformed(R=tilt @ R_base, t=c))
        if rivets and i == layers - 1:
            r = 0.15 * size * k
            for a in np.linspace(0.25, np.pi - 0.25, rivets):
                # along the outer, lower edge of the last layer
                local = np.array([np.cos(a) * r * 1.1 * 0.92, 0.012, -np.sin(a) * r * 1.3 * 0.92])
                local = local[[0, 1, 2]] * np.array([1, 1, -1])
                p = (tilt @ R_base) @ local + c
                pieces.append(sphere(0.011 * size, 10, 6).transformed(t=p))
    if spikes:
        for j in range(spikes):
            ang = (j - (spikes - 1) / 2) * 0.45
            dirv = normalize(up + fwd * np.sin(ang) * 0.6)
            base = sh + up * 0.13 * size + fwd * np.sin(ang) * 0.06
            path = np.array([base + dirv * t for t in np.linspace(0, 0.13 * size, 5)])
            pieces.append(tube(path, np.linspace(0.025, 0.002, 5) * size, 6))
    m = merge(pieces)
    W = skin.mix(skin.rigid(len(m.v), body, f'DEF-shoulder.{s}'), skin.rigid(len(m.v), body, f'DEF-upper_arm.{s}'), arm_follow)
    return m, W, (sh, up, out)


def ring_around(center, axis, radius, tube_r, seg=48, sides=8, flat=1.0, rx=1.0, rz=1.0) -> Mesh:
    """A torus-like band; rx/rz squash it into an ellipse in the plane."""
    axis = normalize(np.asarray(axis, dtype=float))
    R = look_rotation(np.cross(axis, [1, 0, 0]) if abs(axis[0]) < 0.9 else np.cross(axis, [0, 0, 1]), axis)
    a = np.arange(seg + 1) / seg * 2 * np.pi
    path = np.stack([np.cos(a) * radius * rx, np.zeros_like(a), np.sin(a) * radius * rz], axis=1)
    path[-1] = path[0]
    m = sweep(path[:-1], circle(sides, tube_r * flat, tube_r), None, up=[0, 1, 0], cap=False)
    # close the loop
    K = seg
    P = sides
    extra = []
    for c in range(P):
        a0 = (K - 1) * P + c
        a1 = (K - 1) * P + (c + 1) % P
        b0 = c
        b1 = (c + 1) % P
        extra += [[a0, a1, b0], [a1, b1, b0]]
    m.f = np.vstack([m.f, np.array(extra)[:, ::-1]])
    return m.transformed(R=R, t=center)


def bolt_shape(length: float, width: float, kinks: int = 3) -> np.ndarray:
    """2D zig-zag lightning bolt outline along +Y."""
    pts_l, pts_r = [], []
    for i in range(kinks + 1):
        t = i / kinks
        y = (t - 0.5) * length
        off = (width * 0.6) * (1 if i % 2 else -1) * (1 - abs(t - 0.5) * 1.2)
        w = width * (1 - abs(t - 0.5) * 1.6) + width * 0.15
        pts_l.append([off - w / 2, y])
        pts_r.append([off + w / 2, y])
    tip_top = [0, length * 0.62]
    tip_bot = [0, -length * 0.62]
    poly = [tip_bot] + pts_r + [tip_top] + pts_l[::-1]
    return np.array(poly)


def grip_curl(body: Body, s: str, amount: float = 1.0) -> list[dict]:
    """Finger rotations (bone-local axis + angle) that close a hand around a handle.

    Applied at runtime on top of the animation, so the hand holds its weapon in every clip.
    """
    r = body.rig
    _, along, _, palm = hand_frame(body, s)
    a = normalize(np.cross(along, palm))  # rotating `along` about this turns it toward the palm
    out = []
    angles = {'01': 1.05, '02': 1.25, '03': 0.8}
    for f in ('index', 'middle', 'ring', 'pinky'):
        for seg, ang in angles.items():
            out.append((f'DEF-f_{f}.{seg}.{s}', ang * amount))
    for seg, ang in (('01', 0.25), ('02', 0.5), ('03', 0.45)):
        out.append((f'DEF-thumb.{seg}.{s}', ang * amount))
    res = []
    for name, ang in out:
        Rw = r.world[r.index(name)][:3, :3]
        Rw = Rw / np.linalg.norm(Rw, axis=0, keepdims=True)
        res.append({'bone': name, 'axis': np.round(Rw.T @ a, 5).tolist(), 'angle': float(ang)})
    return res
