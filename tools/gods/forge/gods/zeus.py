"""Zeus: king of the gods. Heroic build, gold cuirass and layered pauldrons,
storm-blue cloth, a white mane and beard, a crackling thunderbolt in the right hand."""
from __future__ import annotations

import numpy as np

from .. import mh, shell, hair, kit, skin, physics
from ..geo import Mesh, extrude, tube, merge, look_rotation
from ..god import God
from ..mathx import normalize
from ..regions import smooth
from .common import heroic, face_fields, add_hair_head, add_skirt


class Zeus(God):
    name = 'zeus'
    height = 2.32
    bulk = {'DEF-thigh': 1.25, 'DEF-shin': 1.2, 'DEF-upper_arm': 1.3, 'DEF-forearm': 1.25, 'DEF-spine.003': (1.1, 1.0, 1.0),
            'DEF-neck': 1.15, 'DEF-hand': 1.1, 'DEF-shoulder': 1.15}
    shape = mh.Shape(gender=1, muscle=1.0, weight=0.62, height=1.0, proportions=1.0, extra={
        **heroic(1.0),
        'chin/chin-prominent-incr': 0.5, 'nose/nose-greek-incr': 0.6, 'head/head-square': 0.4,
        'expression/units/caucasian/eyebrows-left-down': 0.5, 'expression/units/caucasian/eyebrows-right-down': 0.5,
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

        # ---- gold muscle cuirass: scooped neckline, round armholes, a dipped lower edge
        torso = smooth(1 - arm - F.bones('neck', 'head', 'thigh'), 0.3, 0.6)
        shL, shR = F.joint('DEF-upper_arm.L'), F.joint('DEF-upper_arm.R')
        armhole = smooth(np.minimum(F.dist(shL), F.dist(shR)), 0.12, 0.14)
        nl = neck[1] - 0.12 + 0.08 * np.clip(np.abs(x) / 0.13, 0, 1) ** 2 + 0.05 * (z < -0.02)
        neckline = smooth(nl - y, 0.0, 0.015)
        waist = s1[1] - 0.1 - 0.03 * np.cos(np.clip(x / 0.2, -1, 1) * np.pi / 2)
        lower = smooth(y - waist, 0.0, 0.015)
        cuirass_f = np.minimum.reduce([torso, armhole, neckline, lower])
        cuirass, W = shell.plate(b, cuirass_f, offset=0.016, thickness=0.009, rim=0.01, rim_width=0.026, smooth=5, sharpen=1.6)
        self.add('cuirass', 'gold', cuirass, W)

        # ---- toga sash over the left shoulder, across the chest
        d = (F.v - F.joint('DEF-shoulder.L')) @ normalize(np.array([0.75, 1.0, 0.0]))
        sash_f = np.minimum.reduce([1 - arm - F.bones('head', 'neck', 'thigh'), smooth(d, -0.16, -0.14), smooth(-d, 0.02, 0.04), smooth(y, s1[1] - 0.15, s1[1] - 0.1)])
        sash, W = shell.plate(b, sash_f, offset=0.045, thickness=0.006, rim=0.0, smooth=6)
        self.add('sash', 'cloth', sash, W)

        # ---- belt with a gold buckle
        belt_f = np.minimum(smooth(y, hips[1] - 0.03, hips[1] - 0.01), smooth(-y, -(hips[1] + 0.09), -(hips[1] + 0.07)))
        belt, W = shell.plate(b, belt_f * (1 - arm), offset=0.03, thickness=0.012, rim=0.006, smooth=6)
        self.add('belt', 'leather', belt, W)
        front = np.array([0, hips[1] + 0.03, b.verts[b.used][:, 2].max() * 0 + 0.16])
        buckle = kit.ring_around(front, [0, 0, 1], 0.045, 0.012, seg=24, sides=6)
        gem = kit.dome(0.03, 0.018, seg=16).transformed(R=look_rotation([0, 1, 0], [0, 0, 1]) @ np.eye(3), t=front)
        self.add('buckle', 'gold', buckle, 'DEF-hips')
        self.add('buckle_gem', 'gem', gem, 'DEF-hips')

        # ---- forearm bracers and greaves
        for s in ('L', 'R'):
            fa, hand = F.joint(f'DEF-forearm.{s}'), F.joint(f'DEF-hand.{s}')
            t = F.along(fa, hand)
            fld = np.minimum(F.bones(f'forearm.{s}'), np.minimum(smooth(t, 0.3, 0.36), smooth(-t, -0.92, -0.86)))
            bracer, W = shell.plate(b, fld, offset=0.012, thickness=0.007, rim=0.007, smooth=4)
            self.add(f'bracer.{s}', 'gold', bracer, W)
            sh, ft = F.joint(f'DEF-shin.{s}'), F.joint(f'DEF-foot.{s}')
            t = F.along(sh, ft)
            fld = np.minimum(F.bones(f'shin.{s}'), np.minimum(smooth(t, 0.1, 0.16), smooth(-t, -0.86, -0.8)))
            greave, W = shell.plate(b, fld, offset=0.012, thickness=0.007, rim=0.008, smooth=4)
            self.add(f'greave.{s}', 'gold', greave, W)
            # sandal: leather over the foot
            fo = F.bones(f'foot.{s}', f'toe.{s}')
            sandal, W = shell.plate(b, np.minimum(fo, smooth(-y, -0.09, -0.07)), offset=0.006, thickness=0.006, rim=0.003, smooth=2)
            self.add(f'sandal.{s}', 'leather', sandal, W)
            # pauldrons
            p, W, _ = kit.pauldron(b, s, size=1.15, layers=3, spikes=0, rivets=7)
            self.add(f'pauldron.{s}', 'gold', p, W)

        # ---- skirt: pteruges strips and cloth panels
        skirt = add_skirt(self, 'skirt', 'cloth2', hips[1] + 0.02, 0.5, flare=0.12, clearance=0.035)
        self.pteruges(hips)
        self.emblem(neck)
        armmask = F.arms() > 0.3
        self.meta['colliders'] = physics.colliders(b)
        self.meta['cloths'] += [
            physics.panel(b, 'loin.front', 'cloth', hips[1] - 0.03, True, 0.28, 0.55, arm_mask=armmask),
            physics.panel(b, 'loin.back', 'cloth', hips[1] - 0.03, False, 0.32, 0.6, arm_mask=armmask),
            physics.cape(b, 'cape', 'cloth', width=0.52, length=1.45, arm_mask=armmask),
        ]

        # ---- head: mane, beard, brows, laurel crown
        add_hair_head(self, hair_len=0.42, beard_len=0.24, mustache=True, seed=3, wild=0.35)
        self.crown()

        # ---- thunderbolt in the right hand
        self.thunderbolt()

        hide = (cuirass_f > 0.75) | (F.bones('foot', 'toe') > 0.9) & (y < 0.06)
        self.add_body(hide=hide | skirt.hide)
        self.eyes()
        self.meta['grip'] = ['R']
        self.meta['curl'] = kit.grip_curl(self.body, 'R')

    def pteruges(self, hips):
        b = self.body
        n = 16
        strips = []
        Ws = []
        for i in range(n):
            a = (i + 0.5) / n * 2 * np.pi
            dirv = np.array([np.sin(a), 0, np.cos(a)])
            # hip surface radius in this direction
            P = b.verts[b.used]
            band = (np.abs(P[:, 1] - (hips[1] - 0.05)) < 0.03) & (self.F.arms()[b.used] < 0.05)
            proj = P[band] @ dirv
            r = proj.max() + 0.03
            top = np.array([0, hips[1] - 0.04, 0]) + dirv * r
            L = 0.3
            path = np.array([top + dirv * 0.05 * t ** 1.5 + np.array([0, -L * t, 0]) for t in np.linspace(0, 1, 5)])
            strip = tube(path, np.full(5, 0.05), 4, up=dirv, flat=0.12)
            strip.uv[:, 1] = 1 - strip.uv[:, 1]
            strips.append(strip)
            side = 'L' if np.sin(a) > 0 else 'R'
            t = np.clip((hips[1] - strip.v[:, 1]) / L, 0, 1)
            thigh = abs(np.sin(a)) * 0.5 + 0.2
            Ws.append(skin.mix(skin.rigid(len(strip.v), b, 'DEF-hips'), skin.rigid(len(strip.v), b, f'DEF-thigh.{side}'), t * thigh))
            tip = tube(path[-2:] + np.array([0, -0.01, 0]), np.array([0.052, 0.052]), 4, up=dirv, flat=0.2)
            strips.append(tip)
            Ws.append(skin.mix(skin.rigid(len(tip.v), b, 'DEF-hips'), skin.rigid(len(tip.v), b, f'DEF-thigh.{side}'), thigh))
        leather = merge(strips[0::2])
        tips = merge(strips[1::2])
        self.add('pteruges', 'cloth2', leather, np.concatenate(Ws[0::2]))
        self.add('pteruges_tips', 'gold', tips, np.concatenate(Ws[1::2]))

    def emblem(self, neck):
        """Raised medallion with a lightning bolt in the middle of the chest."""
        b = self.body
        P = b.verts[b.used]
        # a brooch pinning the sash at the front of the left shoulder
        cy, cx = neck[1] - 0.1, 0.12
        near = (np.abs(P[:, 0] - cx) < 0.03) & (np.abs(P[:, 1] - cy) < 0.02) & (self.F.arms()[b.used] < 0.3)
        z = P[near, 2].max() + 0.06
        c = np.array([cx, cy, z])
        ring = kit.ring_around(c, [0, 0, 1], 0.06, 0.011, seg=40, sides=8, flat=0.6)
        disc = kit.dome(0.058, 0.012, seg=32).transformed(R=look_rotation([0, 1, 0], [0, 0, 1]), t=c - np.array([0, 0, 0.004]))
        bolt = extrude(kit.bolt_shape(0.1, 0.035, 3), 0.008, 0.002).transformed(t=c + np.array([0, 0, 0.006]))
        wings = []
        for sgn in (-1, 1):
            for k in range(3):
                path = np.array([c + np.array([sgn * (0.06 + 0.035 * t), 0.012 - 0.018 * k + 0.02 * t - 0.03 * t * t * k, -0.006 * t]) for t in np.linspace(0, 1, 5)])
                wings.append(tube(path, np.linspace(0.012, 0.003, 5), 6, flat=0.5))
        self.add('emblem', 'gold', merge([ring, disc] + wings), 'DEF-spine.003')
        self.add('emblem_bolt', 'glow', bolt, 'DEF-spine.003')

    def crown(self):
        F, b = self.F, self.body
        head = F.joint('DEF-head')
        top = b.J['head____tail']
        eye = b.J['eye.L____head']
        c = np.array([0, eye[1] + 0.075, head[2] - 0.005])
        band = kit.ring_around(c, normalize(np.array([0, 1, -0.25])), 0.128, 0.009, seg=40, sides=6, rx=0.95, rz=1.12)
        pieces = [band]
        # lightning spikes rising from the band
        for k, ang in enumerate(np.linspace(-1.1, 1.1, 7)):
            dirv = np.array([np.sin(ang), 0, np.cos(ang)])
            base = c + dirv * 0.13 * np.array([0.95, 1, 1.12]) + np.array([0, 0.01, 0])
            h = 0.15 - abs(ang) * 0.045 + (0.05 if k == 3 else 0)
            poly = kit.bolt_shape(h, 0.035, 2) + np.array([0, h * 0.5])
            bolt = extrude(poly, 0.008, 0.002)
            R = look_rotation(dirv, normalize(np.array([0, 1, 0]) + dirv * 0.35))
            pieces.append(bolt.transformed(R=R, t=base))
        self.add('crown', 'gold', merge(pieces), 'DEF-head')
        gem = kit.dome(0.016, 0.01, seg=16).transformed(R=look_rotation([0, 1, 0], [0, 0, 1]), t=c + np.array([0, 0.012, 0.146]))
        self.add('crown_gem', 'gem', gem, 'DEF-head')
        del top

    def thunderbolt(self):
        center, along, across, palm = kit.hand_frame(self.body, 'R')
        grip = center + palm * 0.035 - along * 0.035
        L = 0.85
        poly = kit.bolt_shape(L, 0.17, 5)
        bolt = extrude(poly, 0.03, 0.01)
        R = look_rotation(palm, across)  # bolt's long axis (+Y) across the fist
        core = bolt.transformed(R=R, t=grip)
        self.add('bolt', 'glow', core, 'DEF-hand.R')
        # gold grip with flared guards
        path = np.array([grip - across * 0.07, grip, grip + across * 0.07])
        handle = tube(path, np.array([0.03, 0.026, 0.03]), 10)
        guards = [kit.ring_around(grip + across * o, across, 0.034, 0.01, seg=20, sides=6) for o in (-0.08, 0.08)]
        self.add('bolt_grip', 'gold', merge([handle] + guards), 'DEF-hand.R')
