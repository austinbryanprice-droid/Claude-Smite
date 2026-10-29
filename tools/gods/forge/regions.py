"""Scalar fields over the body surface for cutting armor and cloth regions."""
from __future__ import annotations

import numpy as np

from .body import Body
from . import skin


def smooth(x, lo, hi):
    t = np.clip((np.asarray(x, dtype=np.float64) - lo) / (hi - lo), 0, 1)
    return t * t * (3 - 2 * t)


class Fields:
    def __init__(self, body: Body):
        self.b = body
        self.D = skin.dense(body)
        self.v = body.verts
        self.names = body.rig.names

    def bones(self, *patterns: str) -> np.ndarray:
        """Summed skin weight of bones whose names contain any pattern."""
        cols = [i for i, n in enumerate(self.names) if any(p in n for p in patterns)]
        return self.D[:, cols].sum(axis=1)

    def arms(self) -> np.ndarray:
        """Skin weight of everything from the upper arm to the fingertips."""
        return self.bones('upper_arm', 'forearm', 'hand', 'f_', 'thumb')

    def side(self, s: str) -> np.ndarray:
        """1 on the god's left (+x) or right (-x) half, soft across the middle."""
        x = self.v[:, 0]
        return smooth(x, -0.01, 0.01) if s == 'L' else smooth(-x, -0.01, 0.01)

    def y(self) -> np.ndarray:
        return self.v[:, 1]

    def joint(self, name: str) -> np.ndarray:
        return self.b.rig.head(name)

    def mh(self, name: str) -> np.ndarray:
        return self.b.J[name]

    def along(self, a: np.ndarray, b: np.ndarray) -> np.ndarray:
        """0 at a, 1 at b, projected along the segment a-b."""
        d = b - a
        return ((self.v - a) @ d) / (d @ d)

    def dist(self, p: np.ndarray) -> np.ndarray:
        return np.linalg.norm(self.v - p, axis=1)
