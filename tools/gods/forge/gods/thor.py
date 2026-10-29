"""Thor: thunder god of the north. A broad brawler in a steel breastplate with
gold trim, a fur mantle and red cape, a long red mane with a braided beard, and
a heavy rune-carved hammer in the right hand."""
from __future__ import annotations

import numpy as np

from .. import mh, shell, kit, skin, physics
from .. import hair as hairmod
from ..geo import extrude, tube, merge, look_rotation, sphere
from ..god import God
from ..mathx import normalize
from ..regions import smooth
from .common import add_boot_feet, heroic, face_fields, add_hair_head, add_skirt, head_weights, heroic_face


class Thor(God):
    name = 'thor'
    height = 2.3
    bulk = {'DEF-thigh': 1.3, 'DEF-shin': 1.25, 'DEF-upper_arm': 1.38, 'DEF-forearm': 1.32, 'DEF-spine.003': (1.14, 1.0, 1.05),
            'DEF-spine.002': (1.06, 1.0, 1.05), 'DEF-neck': 1.25, 'DEF-hand': 1.15, 'DEF-shoulder': 1.2}
    shape = mh.Shape(gender=1, muscle=1.0, weight=0.8, height=0.9, proportions=1.0, extra={
        **heroic(1.15, hands=0.65), **heroic_face(1.0),
        'chin/chin-prominent-incr': 0.6, 'chin/chin-width-incr': 0.5, 'nose/nose-scale-horiz-incr': 0.3,
        'head/head-square': 0.6,
        'expression/units/caucasian/eyebrows-left-down': 0.7, 'expression/units/caucasian/eyebrows-right-down': 0.7,
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

        # ---- steel breastplate, high collar, deep waist
        torso = smooth(1 - arm - F.bones('neck', 'head', 'thigh'), 0.3, 0.6)
        shL, shR = F.joint('DEF-upper_arm.L'), F.joint('DEF-upper_arm.R')
        armhole = smooth(np.minimum(F.dist(shL), F.dist(shR)), 0.125, 0.145)
        nl = neck[1] - 0.06 + 0.06 * np.clip(np.abs(x) / 0.12, 0, 1) ** 2 + 0.03 * (z < -0.02)
        neckline = smooth(nl - y, 0.0, 0.015)
        waist = s1[1] - 0.07 - 0.04 * np.cos(np.clip(x / 0.2, -1, 1) * np.pi / 2)
        lower = smooth(y - waist, 0.0, 0.015)
        plate_f = np.minimum.reduce([torso, armhole, neckline, lower])
        plate, W = shell.plate(b, plate_f, offset=0.02, thickness=0.012, rim=0.012, rim_width=0.03, smooth=5, sharpen=1.6)
        self.add('breastplate', 'steel', plate, W)
        # gold knotwork medallion at the sternum
        P = b.verts[b.used]
        cy = neck[1] - 0.2
        near = (np.abs(P[:, 0]) < 0.03) & (np.abs(P[:, 1] - cy) < 0.02)
        c = np.array([0, cy, P[near, 2].max() + 0.04])
        knot = [kit.ring_around(c, [0, 0, 1], 0.07, 0.012, seg=40, sides=8, flat=0.6)]
        for a in np.arange(3) * 2 * np.pi / 3:
            o = np.array([np.sin(a), np.cos(a), 0]) * 0.03
            knot.append(kit.ring_around(c + o, [0, 0, 1], 0.03, 0.007, seg=24, sides=6, flat=0.6))
        self.add('medallion', 'gold', merge(knot), 'DEF-spine.003')
        self.add('medallion_gem', 'gem', kit.dome(0.022, 0.014, seg=16).transformed(R=look_rotation([0, 1, 0], [0, 0, 1]), t=c), 'DEF-spine.003')

        # ---- tunic: knee-length dark skirt, wide leather belt with a gold buckle
        skirt = add_skirt(self, 'tunic', 'cloth2', waist.max() + 0.02, 0.62, flare=0.12, pleats=14, depth=0.01, clearance=0.03)
        belt_f = np.minimum(smooth(y, hips[1] + 0.0, hips[1] + 0.02), smooth(-y, -(hips[1] + 0.13), -(hips[1] + 0.11)))
        belt, W = shell.plate(b, belt_f * (1 - arm), offset=0.05, thickness=0.014, rim=0.006, smooth=6)
        self.add('belt', 'leather', belt, W)
        front = np.array([0, hips[1] + 0.065, 0])
        near = (np.abs(P[:, 0]) < 0.03) & (np.abs(P[:, 1] - front[1]) < 0.02)
        front[2] = P[near, 2].max() + 0.08
        buckle = extrude(np.array([[-0.07, -0.05], [0.07, -0.05], [0.08, 0], [0.07, 0.05], [-0.07, 0.05], [-0.08, 0]]), 0.02, 0.006)
        self.add('buckle', 'gold', buckle.transformed(t=front), 'DEF-hips')

        # ---- arms: steel pauldrons, leather bracers with steel plates; legs: leather wraps and fur boots
        for s in ('L', 'R'):
            p, W, _ = kit.pauldron(b, s, size=1.25, layers=3, spikes=0, rivets=7)
            self.add(f'pauldron.{s}', 'steel', p, W)
            fa, hand = F.joint(f'DEF-forearm.{s}'), F.joint(f'DEF-hand.{s}')
            t = F.along(fa, hand)
            fld = np.minimum(F.bones(f'forearm.{s}'), np.minimum(smooth(t, 0.25, 0.3), smooth(-t, -0.95, -0.9)))
            bracer, W = shell.plate(b, fld, offset=0.012, thickness=0.01, rim=0.006, smooth=4)
            self.add(f'bracer.{s}', 'leather', bracer, W)
            fld2 = np.minimum(fld, smooth(-np.abs(t - 0.62), -0.2, -0.17))
            vamb, W = shell.plate(b, fld2, offset=0.026, thickness=0.008, rim=0.006, smooth=4)
            self.add(f'vambrace.{s}', 'steel', vamb, W)
            sh, ft = F.joint(f'DEF-shin.{s}'), F.joint(f'DEF-foot.{s}')
            t = F.along(sh, ft)
            boot_f = np.minimum(F.bones(f'shin.{s}'), smooth(t, 0.35, 0.4))
            boot, W = shell.plate(b, boot_f, offset=0.012, thickness=0.01, rim=0.006, smooth=3)
            self.add(f'boot.{s}', 'leather', boot, W)
            cuff = np.minimum(F.bones(f'shin.{s}'), np.minimum(smooth(t, 0.3, 0.34), smooth(-t, -0.5, -0.46)))
            self.fur_patch(f'boot_fur.{s}', cuff, length=0.07, width=0.04, clearance=0.03, spacing=0.03, seed=5 if s == 'L' else 6,
                           flow=lambda p: np.tile([0, -1.0, 0], (len(p), 1)))
            # knee guard
            kn = F.joint(f'DEF-shin.{s}')
            kd = F.dist(kn + np.array([0, 0, 0.05]))
            knee, W = shell.plate(b, np.minimum(smooth(-kd, -0.085, -0.075), F.bones(f'thigh.{s}', f'shin.{s}')), offset=0.035, thickness=0.01, rim=0.008, smooth=3)
            self.add(f'knee.{s}', 'steel', knee, W)

        # ---- fur mantle around the neck and over the shoulders
        dn = F.dist(neck + np.array([0, -0.04, -0.01]))
        mantle = np.minimum.reduce([smooth(-dn, -0.24, -0.2), smooth(dn, 0.07, 0.09), 1 - smooth(arm, 0.5, 0.7),
                                    smooth(y, neck[1] - 0.16, neck[1] - 0.12), 1 - F.bones('head')])

        def mflow(p):
            o = p - neck
            o[:, 1] = 0
            return normalize(normalize(o + 1e-6) * 0.7 + np.array([0, -1.0, 0]))
        self.fur_patch('mantle', mantle, length=0.16, width=0.06, clearance=0.065, spacing=0.028, seed=9, flow=mflow, lift=0.9)

        # ---- red cape and back panel
        armmask = F.arms() > 0.3
        self.meta['colliders'] = physics.colliders(b)
        self.meta['cloths'] += [
            physics.cape(b, 'cape', 'cloth', width=0.6, length=1.55, arm_mask=armmask, clearance=0.08),
            physics.panel(b, 'loin.front', 'cloth', hips[1] + 0.03, True, 0.26, 0.6, arm_mask=armmask, clearance=0.08),
        ]

        # ---- head: long red mane, braided beard
        add_hair_head(self, hair_len=0.5, beard_len=0.26, mustache=True, seed=7, wild=0.28)
        self.braids()
        self.hammer()

        hide = (plate_f > 0.75) | (F.bones('foot', 'toe') > 0.9) & (y < 0.06)
        hide = hide | add_boot_feet(self)
        self.add_body(hide=hide | skirt.hide)
        self.eyes()
        self.meta['grip'] = ['R']
        self.meta['curl'] = kit.grip_curl(self.body, 'R')

    def fur_patch(self, name, field, length, width, clearance, spacing, seed, flow, lift=0.7):
        style = hairmod.Style(length=length, width=width * 1.3, flatness=0.4, segments=8, sides=8, grooves=3, lift=lift, gravity=0.5, flow=flow,
                              curl=0.25, curl_freq=1.0, jitter=0.35, clearance=clearance, taper=0.8, seed=seed)
        m, _ = hairmod.hair(self.body, field, spacing, style)
        self.add(name, 'fur', m, None)

    def braids(self):
        lm = face_fields(self)
        chin = lm['chin']
        pieces, rings = [], []
        for sgn in (-1, 1):
            top = chin + np.array([sgn * 0.03, 0.0, 0.05])
            L = 0.28
            n = 24
            t = np.linspace(0, 1, n)
            path = top + np.stack([sgn * 0.01 * t, -L * t, 0.04 * t - 0.03 * t * t], axis=1)
            # three-strand braid: bumpy radius
            r = 0.026 * (1 - 0.45 * t) * (0.8 + 0.2 * np.abs(np.sin(t * L / 0.03 * np.pi)))
            pieces.append(tube(path, r, 8))
            for k in (0.35, 0.8):
                i = int(k * (n - 1))
                rings.append(kit.ring_around(path[i], normalize(path[i + 1] - path[i - 1]), r[i] + 0.004, 0.006, seg=16, sides=6))
        m = merge(pieces)
        col = np.zeros((len(m.v), 4))
        col[:, 0] = 0.7
        col[:, 1] = 0.5
        m.col = col
        self.add('braids', 'hair', m, head_weights(self, m.v))
        rm = merge(rings)
        self.add('braid_rings', 'gold', rm, head_weights(self, rm.v))

    def hammer(self):
        center, along, across, palm = kit.hand_frame(self.body, 'R')
        grip = center + palm * 0.04 - along * 0.035
        # local +Y along the handle: diagonally through the fist so the head hangs below the hand
        R = look_rotation(palm, normalize(along * 0.8 - across * 0.6))
        L = 0.78
        # handle: wrapped grip with gold bands and a pommel ring
        hy = np.linspace(-0.22, L - 0.18, 12)
        handle = tube(np.stack([np.zeros_like(hy), hy, np.zeros_like(hy)], axis=1), np.full(12, 0.03), 10)
        bands = [kit.ring_around([0, yy, 0], [0, 1, 0], 0.031, 0.008, seg=20, sides=6) for yy in (-0.2, 0.18, L - 0.22)]
        pommel = sphere(0.045, 16, 10).transformed(t=[0, -0.25, 0])
        # head: chamfered block, rune channels glow
        hw, hh, hd = 0.36, 0.2, 0.2
        c = 0.045
        prof = np.array([[-hw / 2 + c, -hh / 2], [hw / 2 - c, -hh / 2], [hw / 2, -hh / 2 + c], [hw / 2, hh / 2 - c],
                         [hw / 2 - c, hh / 2], [-hw / 2 + c, hh / 2], [-hw / 2, hh / 2 - c], [-hw / 2, -hh / 2 + c]])
        head_y = L - 0.08
        block = extrude(prof, hd, 0.02, 3).transformed(t=[0, head_y, 0])
        # gold caps on both striking faces
        caps = []
        for sx in (-1, 1):
            cap = extrude(prof[:, ::-1] * 0.92, 0.04, 0.012, 2)  # profile across Y/Z
            Rc = look_rotation([sx, 0, 0], [0, 1, 0])
            caps.append(cap.transformed(R=Rc, t=[sx * (hw / 2 + 0.01), head_y, 0]))
        runes = []
        for sz in (-1, 1):
            for k, rx in enumerate(np.linspace(-0.1, 0.1, 3)):
                bar = extrude(np.array([[-0.008, -0.05], [0.008, -0.05], [0.008, 0.05], [-0.008, 0.05]]), 0.01, 0.002)
                tilt = look_rotation([0, 0, sz], [np.sin(0.4 * (k - 1)), 1, 0])
                runes.append(bar.transformed(R=tilt, t=[rx, head_y, sz * (hd / 2 + 0.002)]))
        T = lambda m: m.transformed(R=R, t=grip)  # noqa: E731
        self.add('hammer_handle', 'leather', T(merge([handle])), 'DEF-hand.R')
        self.add('hammer_trim', 'gold', T(merge(bands + [pommel] + caps)), 'DEF-hand.R')
        self.add('hammer_head', 'steel', T(block), 'DEF-hand.R')
        self.add('hammer_runes', 'glow', T(merge(runes)), 'DEF-hand.R')
