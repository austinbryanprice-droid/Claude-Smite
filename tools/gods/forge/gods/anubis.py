"""Anubis: guardian of the dead. A lean dark-furred body with a sculpted jackal
head, a gold and lapis broad collar, a white linen kilt with a blue-and-gold
apron, gold arm bands and greaves, and a tall hook-topped staff."""
from __future__ import annotations

import numpy as np

from .. import mh, shell, kit, skin, physics, sdf
from ..geo import extrude, tube, merge, look_rotation, sphere
from ..god import God
from ..mathx import normalize
from ..regions import smooth
from .common import add_boot_feet, heroic, add_skirt, head_weights


class Anubis(God):
    name = 'anubis'
    height = 2.36
    bulk = {'DEF-thigh': 1.12, 'DEF-shin': 1.08, 'DEF-upper_arm': 1.2, 'DEF-forearm': 1.15, 'DEF-spine.003': (1.06, 1.0, 1.0),
            'DEF-neck': 1.1, 'DEF-shoulder': 1.1}
    shape = mh.Shape(gender=1, muscle=1.0, weight=0.5, height=1.0, proportions=1.0, extra={**heroic(0.8, hands=0.4)})

    def make(self):
        F, b = self.F, self.body
        y = F.y()
        hips = F.joint('DEF-hips')
        neck = F.joint('DEF-neck')
        arm = F.arms()

        # ---- broad collar: rings of gold and lapis over the shoulders and chest
        dn = F.dist(neck + np.array([0, -0.05, 0.0]))
        base = np.minimum.reduce([1 - smooth(arm, 0.35, 0.55), 1 - F.bones('head')])
        for i, (r0, r1, mat, off) in enumerate([(0.07, 0.235, 'gold', 0.014), (0.11, 0.19, 'cloth2', 0.026), (0.14, 0.165, 'goldplain', 0.034)]):
            f = np.minimum.reduce([base, smooth(-dn, -r1, -r1 + 0.012), smooth(dn, r0, r0 + 0.012)])
            m, W = shell.plate(b, f, offset=off, thickness=0.008, rim=0.006, rim_width=0.016, smooth=5)
            self.add(f'collar{i}', mat, m, W)

        # ---- linen kilt, apron and gold belt
        skirt = add_skirt(self, 'kilt', 'cloth', hips[1] + 0.06, 0.48, flare=0.1, pleats=26, depth=0.006, clearance=0.03)
        belt_f = np.minimum(smooth(y, hips[1] + 0.03, hips[1] + 0.05), smooth(-y, -(hips[1] + 0.13), -(hips[1] + 0.11)))
        belt, W = shell.plate(b, belt_f * (1 - arm), offset=0.06, thickness=0.012, rim=0.006, smooth=6)
        self.add('belt', 'gold', belt, W)
        armmask = arm > 0.3
        self.meta['colliders'] = physics.colliders(b)
        self.meta['cloths'] += [
            physics.panel(b, 'apron', 'cloth2', hips[1] + 0.05, True, 0.2, 0.55, arm_mask=armmask, clearance=0.08),
            physics.cape(b, 'cape', 'cloth2', width=0.5, length=1.5, arm_mask=armmask, clearance=0.07),
        ]

        # ---- arm bands, bracers, greaves
        for s in ('L', 'R'):
            sh, el = F.joint(f'DEF-upper_arm.{s}'), F.joint(f'DEF-forearm.{s}')
            t = F.along(sh, el)
            fld = np.minimum(F.bones(f'upper_arm.{s}'), np.minimum(smooth(t, 0.38, 0.42), smooth(-t, -0.56, -0.52)))
            m, W = shell.plate(b, fld, offset=0.012, thickness=0.008, rim=0.006, smooth=3)
            self.add(f'armband.{s}', 'gold', m, W)
            fa, hand = F.joint(f'DEF-forearm.{s}'), F.joint(f'DEF-hand.{s}')
            t = F.along(fa, hand)
            fld = np.minimum(F.bones(f'forearm.{s}'), np.minimum(smooth(t, 0.4, 0.45), smooth(-t, -0.95, -0.9)))
            m, W = shell.plate(b, fld, offset=0.012, thickness=0.008, rim=0.008, smooth=4)
            self.add(f'bracer.{s}', 'gold', m, W)
            shn, ft = F.joint(f'DEF-shin.{s}'), F.joint(f'DEF-foot.{s}')
            t = F.along(shn, ft)
            fld = np.minimum(F.bones(f'shin.{s}'), np.minimum(smooth(t, 0.15, 0.2), smooth(-t, -0.85, -0.8)))
            m, W = shell.plate(b, fld, offset=0.012, thickness=0.008, rim=0.009, smooth=4)
            self.add(f'greave.{s}', 'gold', m, W)
            p, W, _ = kit.pauldron(b, s, size=0.9, layers=2, spikes=0)
            self.add(f'pauldron.{s}', 'gold', p, W)

        hide = F.bones('DEF-head') > 0.25
        self.jackal_head()
        self.staff()
        hide = hide | add_boot_feet(self) | skirt.hide
        self.add_body(hide=hide)
        self.meta['grip'] = ['R']
        self.meta['curl'] = kit.grip_curl(b, 'R')

    def jackal_head(self):
        b = self.body
        J = b.J
        H = self.F.joint('DEF-head') + np.array([0, 0.1, 0.0])  # skull center
        nk = self.F.joint('DEF-neck')
        up, fwd = np.array([0, 1.0, 0]), np.array([0, 0, 1.0])

        S = 1.18  # heroic head scale

        def fn0(p):
            d = sdf.ellipsoid(p, H + [0, 0.01, -0.01], np.array([0.083, 0.088, 0.1]))
            # muzzle and lower jaw, long and narrow
            d = sdf.smin(d, sdf.capsule(p, H + [0, -0.015, 0.05], H + [0, -0.035, 0.245], 0.058, 0.022), 0.04)
            d = sdf.smin(d, sdf.capsule(p, H + [0, -0.06, 0.03], H + [0, -0.062, 0.215], 0.04, 0.016), 0.03)
            d = sdf.smin(d, sdf.sphere(p, H + [0, -0.03, 0.252], 0.023), 0.01)  # nose
            # brow ridges
            for sx in (-1, 1):
                d = sdf.smin(d, sdf.capsule(p, H + [sx * 0.03, 0.035, 0.085], H + [sx * 0.06, 0.03, 0.05], 0.014), 0.02)
            # cheeks
            for sx in (-1, 1):
                d = sdf.smin(d, sdf.sphere(p, H + [sx * 0.05, -0.04, 0.05], 0.04), 0.03)
            # tall ears, flattened front to back, hollowed in front
            for sx in (-1, 1):
                a = H + [sx * 0.045, 0.06, -0.035]
                t = H + [sx * 0.085, 0.27, -0.06]
                ear = sdf.capsule(p, a, t, 0.05, 0.004, squash=(fwd, 3.2))
                cav = sdf.capsule(p, a + [0, 0.03, 0.03], t + [0, -0.03, 0.012], 0.032, 0.002, squash=(fwd, 3.5))
                ear = sdf.smax(ear, -cav, 0.008)
                d = sdf.smin(d, ear, 0.025)
            # neck, down into the collar
            d = sdf.smin(d, sdf.capsule(p, H + [0, -0.03, -0.03], H + (nk + [0, -0.06, 0.0] - H) / S, 0.07 / S, 0.078 / S), 0.05)
            # eye sockets
            for sx in (-1, 1):
                d = sdf.smax(d, -sdf.sphere(p, H + [sx * 0.05, 0.012, 0.085], 0.014), 0.008)
            return d

        def fn(p):
            return fn0(H + (p - H) / S) * S

        lo = np.array([-0.16, nk[1] - 0.1, H[2] - 0.17])
        lo[0], lo[2] = -0.19, H[2] - 0.2
        hi = np.array([0.19, H[1] + 0.36, H[2] + 0.36])
        m = sdf.mesh(fn, lo, hi, step=0.0035, smooth=4)
        col = np.zeros((len(m.v), 4))
        m.col = col
        self.add('jackal', 'skin', m, head_weights(self, m.v, fall=0.12))
        # glowing eyes, gold ear cuffs and muzzle band
        eyes = [sphere(0.011, 12, 8).transformed(s=[1.4, 0.7, 0.9], t=H + np.array([sx * 0.05, 0.012, 0.088]) * S) for sx in (-1, 1)]
        self.add('jackal_eyes', 'glow', merge(eyes), 'DEF-head')
        trim = []
        for sx in (-1, 1):
            a = H + np.array([sx * 0.045, 0.06, -0.035]) * S
            t = H + np.array([sx * 0.085, 0.27, -0.06]) * S
            for k in (0.2, 0.32):
                c = a + (t - a) * k
                r = (0.05 + (0.004 - 0.05) * k) * S
                trim.append(kit.ring_around(c, normalize(t - a), r + 0.006, 0.006, seg=24, sides=6, rz=1 / 3.0))
        trim.append(kit.ring_around(H + np.array([0, -0.03, 0.17]) * S, normalize(np.array([0, 0.05, 1.0])), 0.046 * S, 0.007, seg=24, sides=6, rx=0.9, rz=1.1))
        tm = merge(trim)
        self.add('jackal_trim', 'gold', tm, 'DEF-head')
        del up, J

    def staff(self):
        center, along, across, palm = kit.hand_frame(self.body, 'R')
        grip = center + palm * 0.035 - along * 0.035
        R = look_rotation(palm, normalize(across * 0.9 + along * 0.3))
        back, front = 0.9, 1.25
        sy = np.linspace(-back, front, 16)
        shaft = tube(np.stack([np.zeros(16), sy, np.zeros(16)], axis=1), np.full(16, 0.022), 10)
        bands = [kit.ring_around([0, yy, 0], [0, 1, 0], 0.024, 0.007, seg=20, sides=6) for yy in np.linspace(-0.4, front - 0.1, 7)]
        # hooked head angled forward, with a crescent blade
        head = tube(np.array([[0, front, 0], [0, front + 0.08, 0.0], [0.0, front + 0.14, 0.06], [0, front + 0.15, 0.16]]),
                    np.array([0.03, 0.034, 0.032, 0.02]), 10)
        blade_poly = np.array([[0.0, 0.0], [0.09, 0.05], [0.16, 0.16], [0.17, 0.3], [0.1, 0.22], [0.03, 0.12]])
        blade = extrude(blade_poly, 0.012, 0.004).transformed(R=look_rotation([1, 0, 0], [0, 1, 0]), t=[0, front - 0.1, -0.02])
        fork = [tube(np.array([[0, -back, 0], [sx * 0.04, -back - 0.1, 0]]), np.array([0.02, 0.008]), 6) for sx in (-1, 1)]
        T = lambda m: m.transformed(R=R, t=grip)  # noqa: E731
        self.add('staff_shaft', 'cloth2', T(shaft), 'DEF-hand.R')
        self.add('staff_trim', 'gold', T(merge(bands + [head] + fork)), 'DEF-hand.R')
        self.add('staff_blade', 'glow', T(blade), 'DEF-hand.R')
