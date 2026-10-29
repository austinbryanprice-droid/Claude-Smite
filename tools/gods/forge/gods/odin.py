"""Odin: the one-eyed allfather. A tall, weathered king in dark steel and gold
with a winged helm, an eyepatch, a long grey beard, a fur-collared storm-grey
cloak over an ankle-length robe, and a rune-bladed spear."""
from __future__ import annotations

import numpy as np

from .. import mh, shell, kit, skin, physics
from .. import hair as hairmod
from ..geo import extrude, tube, merge, look_rotation, sphere
from ..god import God
from ..mathx import normalize
from ..regions import smooth
from .common import add_boot_feet, heroic, face_fields, add_hair_head, add_skirt, head_weights, heroic_face


class Odin(God):
    name = 'odin'
    height = 2.4
    bulk = {'DEF-thigh': 1.2, 'DEF-shin': 1.15, 'DEF-upper_arm': 1.28, 'DEF-forearm': 1.22, 'DEF-spine.003': (1.1, 1.0, 1.04),
            'DEF-neck': 1.18, 'DEF-hand': 1.1, 'DEF-shoulder': 1.15}
    shape = mh.Shape(gender=1, muscle=0.85, weight=0.7, height=1.0, proportions=1.0, extra={
        **heroic(0.9), **heroic_face(0.9),
        'nose/nose-hump-incr': 0.6, 'nose/nose-scale-vert-incr': 0.3, 'head/head-square': 0.3,
        'cheek/l-cheek-bones-incr': 0.5, 'cheek/r-cheek-bones-incr': 0.5,
        'expression/units/caucasian/eyebrows-left-down': 0.8, 'expression/units/caucasian/eyebrows-right-down': 0.8,
    })

    def make(self):
        F, b = self.F, self.body
        y = F.y()
        x = F.v[:, 0]
        z = F.v[:, 2]
        hips = F.joint('DEF-hips')
        s1 = F.joint('DEF-spine.001')
        neck = F.joint('DEF-neck')
        arm = F.arms()
        P = b.verts[b.used]

        # ---- dark steel cuirass with gold trim, down over the stomach
        torso = smooth(1 - arm - F.bones('neck', 'head', 'thigh'), 0.3, 0.6)
        shL, shR = F.joint('DEF-upper_arm.L'), F.joint('DEF-upper_arm.R')
        armhole = smooth(np.minimum(F.dist(shL), F.dist(shR)), 0.12, 0.14)
        nl = neck[1] - 0.08 + 0.06 * np.clip(np.abs(x) / 0.12, 0, 1) ** 2 + 0.03 * (z < -0.02)
        neckline = smooth(nl - y, 0.0, 0.015)
        lower = smooth(y - (hips[1] + 0.08), 0.0, 0.015)
        plate_f = np.minimum.reduce([torso, armhole, neckline, lower])
        plate, W = shell.plate(b, plate_f, offset=0.03, thickness=0.012, rim=0.012, rim_width=0.03, smooth=6, sharpen=1.6)
        self.add('cuirass', 'steel', plate, W)
        # gold raven-eye medallion
        cy = neck[1] - 0.22
        near = (np.abs(P[:, 0]) < 0.03) & (np.abs(P[:, 1] - cy) < 0.02)
        c = np.array([0, cy, P[near, 2].max() + 0.05])
        med = [kit.ring_around(c, [0, 0, 1], 0.075, 0.013, seg=40, sides=8, flat=0.6),
               kit.ring_around(c, [0, 0, 1], 0.045, 0.008, seg=32, sides=6, flat=0.6)]
        for a in np.arange(8) * np.pi / 4:
            d = np.array([np.sin(a), np.cos(a), 0])
            med.append(tube(np.array([c + d * 0.05, c + d * 0.07]), np.array([0.006, 0.006]), 6))
        self.add('medallion', 'gold', merge(med), 'DEF-spine.003')
        self.add('medallion_gem', 'gem', kit.dome(0.026, 0.016, seg=16).transformed(R=look_rotation([0, 1, 0], [0, 0, 1]), t=c), 'DEF-spine.003')

        # ---- ankle-length robe, red sash belt
        skirt = add_skirt(self, 'robe', 'cloth', hips[1] + 0.12, 1.0, flare=0.22, pleats=12, depth=0.012, clearance=0.04, rows=12)
        belt_f = np.minimum(smooth(y, hips[1] + 0.03, hips[1] + 0.05), smooth(-y, -(hips[1] + 0.15), -(hips[1] + 0.13)))
        belt, W = shell.plate(b, belt_f * (1 - arm), offset=0.075, thickness=0.012, rim=0.004, smooth=6)
        self.add('sash', 'cloth2', belt, W)

        for s in ('L', 'R'):
            p, W, _ = kit.pauldron(b, s, size=1.2, layers=3, spikes=0, rivets=7)
            self.add(f'pauldron.{s}', 'steel', p, W)
            fa, hand = F.joint(f'DEF-forearm.{s}'), F.joint(f'DEF-hand.{s}')
            t = F.along(fa, hand)
            fld = np.minimum(F.bones(f'forearm.{s}'), np.minimum(smooth(t, 0.2, 0.26), smooth(-t, -0.95, -0.9)))
            bracer, W = shell.plate(b, fld, offset=0.014, thickness=0.01, rim=0.008, smooth=4)
            self.add(f'bracer.{s}', 'gold', bracer, W)
            sh, ft = F.joint(f'DEF-shin.{s}'), F.joint(f'DEF-foot.{s}')
            t = F.along(sh, ft)
            boot_f = np.minimum(F.bones(f'shin.{s}'), smooth(t, 0.45, 0.5))
            boot, W = shell.plate(b, boot_f, offset=0.012, thickness=0.01, rim=0.006, smooth=3)
            self.add(f'boot.{s}', 'leather', boot, W)

        # ---- fur collar and long cloak
        dn = F.dist(neck + np.array([0, -0.04, -0.02]))
        mantle = np.minimum.reduce([smooth(-dn, -0.22, -0.18), smooth(dn, 0.07, 0.09), 1 - smooth(arm, 0.5, 0.7),
                                    smooth(y, neck[1] - 0.14, neck[1] - 0.1), 1 - F.bones('head')])

        def mflow(p):
            o = p - neck
            o[:, 1] = 0
            return normalize(normalize(o + 1e-6) * 0.7 + np.array([0, -1.0, 0]))
        style = hairmod.Style(length=0.14, width=0.08, flatness=0.4, segments=8, sides=8, grooves=3, lift=0.9, gravity=0.5, flow=mflow,
                              curl=0.25, jitter=0.35, clearance=0.075, taper=0.8, seed=21)
        m, _ = hairmod.hair(b, mantle, 0.028, style)
        self.add('mantle', 'fur', m, None)

        armmask = F.arms() > 0.3
        self.meta['colliders'] = physics.colliders(b)
        self.meta['cloths'] += [
            physics.cape(b, 'cape', 'cloth', width=0.66, length=1.85, arm_mask=armmask, clearance=0.09, flare=0.35),
            physics.panel(b, 'loin.front', 'cloth2', hips[1] + 0.03, True, 0.22, 0.75, arm_mask=armmask, clearance=0.1),
        ]

        # ---- head: long grey hair and beard, winged helm, eyepatch
        add_hair_head(self, hair_len=0.48, beard_len=0.42, mustache=True, seed=13, wild=0.2, cap_y=face_fields(self)['eye'][1] - 0.01)
        self.helm()
        self.eyepatch()
        self.spear()

        hide = (plate_f > 0.75) | (F.bones('foot', 'toe') > 0.9) & (y < 0.06)
        hide = hide | add_boot_feet(self)
        # skin under the helm (the heavy brow would poke through the dome)
        hide = hide | ((F.bones('DEF-head') > 0.5) & (y > face_fields(self)['eye'][1] + 0.045))
        self.add_body(hide=hide | skirt.hide)
        self.eyes()
        self.meta['grip'] = ['R']
        self.meta['curl'] = kit.grip_curl(self.body, 'R')

    def helm(self):
        lm = face_fields(self)
        eye = lm['eye']
        top = lm['crown']
        # fit the cap around the skull above the brow
        b = self.body
        cy = eye[1] + 0.03
        V = b.verts[b.used]
        sk = V[(self.F.bones('DEF-head')[b.used] > 0.5) & (V[:, 1] > cy)]
        cz = (sk[:, 2].max() + sk[:, 2].min()) / 2
        rx = np.abs(sk[:, 0]).max() + 0.02
        rz = (sk[:, 2].max() - sk[:, 2].min()) / 2 + 0.02
        h = sk[:, 1].max() - cy + 0.025
        o = np.array([0, cy, cz])
        cap = kit.dome(rx, h, rings=14, seg=40, lip=0.008, arc=np.pi * 0.5).transformed(s=[1, 1, rz / rx], t=o)
        self.add('helm', 'steel', cap, 'DEF-head')
        # gold brow band and nasal ridge
        band = kit.ring_around(o + np.array([0, -0.008, 0.0]), [0, 1, 0], rx + 0.004, 0.012, seg=48, sides=6, rz=rz / rx)
        ridge_pts = np.array([o + np.array([0, (h + 0.004) * np.cos(a), (rz + 0.004) * np.sin(a)]) for a in np.linspace(-1.5, 1.5, 14)])
        ridge = tube(ridge_pts, np.full(14, 0.011), 6, flat=0.6)
        # side-to-side strap (spangenhelm frame) and rivets along the brow band
        cross_pts = np.array([o + np.array([(rx + 0.004) * np.sin(a), (h + 0.004) * np.cos(a), 0.0]) for a in np.linspace(-1.5, 1.5, 14)])
        cross = tube(cross_pts, np.full(14, 0.009), 6, flat=0.6)
        rivets = []
        for a in np.linspace(0, 2 * np.pi, 16, endpoint=False):
            if abs(np.sin(a)) > 0.97:
                continue  # leave the temples clear for the wings
            pnt = o + np.array([np.sin(a) * (rx + 0.016), -0.008, np.cos(a) * (rz + 0.016)])
            rivets.append(sphere(0.006, 8, 6).transformed(t=pnt))
        nasal = tube(np.array([o + np.array([0, 0.0, rz + 0.004]), o + np.array([0, -0.06, rz + 0.012])]), np.array([0.012, 0.008]), 6, flat=0.5)
        # wings: fanned feathers sweeping up and back from each temple
        feathers = []
        for sx in (-1, 1):
            root = o + np.array([sx * rx * 0.95, 0.02, -0.01])
            for k in range(6):
                ang = 0.35 + k * 0.2
                L = 0.24 - k * 0.022
                leaf = np.array([[0, 0], [0.03, 0.25], [0.02, 0.85], [0, 1.0], [-0.015, 0.85], [-0.025, 0.3]]) * np.array([1.0, L]) * np.array([1.6, 1])
                f = extrude(leaf, 0.008, 0.002)
                d = normalize(np.array([sx * 0.3, np.cos(ang), -np.sin(ang)]))
                n = normalize(np.array([sx, 0.0, 0.5]))
                R = look_rotation(normalize(n - d * np.dot(n, d)), d)
                feathers.append(f.transformed(R=R, t=root + np.array([0, 0, -0.008 * k])))
        self.add('helm_trim', 'gold', merge([band, ridge, cross, nasal] + rivets), 'DEF-head')
        self.add('helm_wings', 'steel', merge(feathers), 'DEF-head')

    def eyepatch(self):
        J = self.body.J
        e = J['eye.L____head']
        n = normalize(np.array([0.25, 0.05, 1.0]))
        patch = kit.dome(0.03, 0.012, seg=20).transformed(s=[1.1, 1, 0.9], R=look_rotation([0, 1, 0], n), t=e + n * 0.03)
        lm = face_fields(self)
        strap = kit.ring_around(np.array([0, e[1] + 0.012, lm['head'][2] - 0.01]), normalize(np.array([0.3, 1, 0.0])), 0.108, 0.005,
                                seg=40, sides=5, flat=0.4, rx=0.98, rz=1.15)
        self.add('eyepatch', 'leather', merge([patch, strap]), 'DEF-head')

    def spear(self):
        center, along, across, palm = kit.hand_frame(self.body, 'R')
        grip = center + palm * 0.035 - along * 0.035
        R = look_rotation(palm, normalize(across * 0.9 + along * 0.3))
        back, front = 0.8, 1.45
        sy = np.linspace(-back, front, 16)
        shaft = tube(np.stack([np.zeros(16), sy, np.zeros(16)], axis=1), np.full(16, 0.024), 10)
        rings = [kit.ring_around([0, yy, 0], [0, 1, 0], 0.026, 0.007, seg=20, sides=6) for yy in (-0.12, 0.12, front - 0.02, -back + 0.03)]
        butt = sphere(0.04, 14, 8).transformed(s=[1, 1.4, 1], t=[0, -back - 0.02, 0])
        # leaf blade with a raised spine
        blade = np.array([[0, 0], [0.06, 0.08], [0.075, 0.2], [0.045, 0.38], [0, 0.5], [-0.045, 0.38], [-0.075, 0.2], [-0.06, 0.08]])
        bl = extrude(blade, 0.014, 0.006, 2).transformed(t=[0, front + 0.02, 0])
        spine = tube(np.array([[0, front + 0.03, 0], [0, front + 0.47, 0]]), np.array([0.012, 0.003]), 4, flat=0.8)
        socket = tube(np.array([[0, front - 0.08, 0], [0, front + 0.04, 0]]), np.array([0.03, 0.036]), 8)
        runes = [extrude(np.array([[-0.004, -0.03], [0.004, -0.03], [0.004, 0.03], [-0.004, 0.03]]), 0.018, 0.0)
                 .transformed(R=look_rotation([0, 0, 1], [np.sin(0.5 * (k % 2 * 2 - 1)), 1, 0]), t=[0, front + 0.12 + k * 0.07, 0]) for k in range(3)]
        T = lambda m: m.transformed(R=R, t=grip)  # noqa: E731
        self.add('spear_shaft', 'leather', T(shaft), 'DEF-hand.R')
        self.add('spear_trim', 'gold', T(merge(rings + [butt, socket])), 'DEF-hand.R')
        self.add('spear_blade', 'steel', T(merge([bl, spine])), 'DEF-hand.R')
        self.add('spear_runes', 'glow', T(merge(runes)), 'DEF-hand.R')
