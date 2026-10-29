"""Loki: the trickster. Lean and quick, in fitted black leathers under a green
tabard and scarf-cape, a gold gorget and one gold shoulder guard, a swept-back
black mane under a horned gold circlet, and twin curved daggers."""
from __future__ import annotations

import numpy as np

from .. import mh, shell, kit, skin, physics
from ..geo import extrude, tube, merge, look_rotation
from ..god import God
from ..mathx import normalize
from ..regions import smooth
from .common import add_boot_feet, heroic, face_fields, add_hair_head, head_weights, heroic_face


class Loki(God):
    name = 'loki'
    height = 2.22
    bulk = {'DEF-upper_arm': 1.12, 'DEF-forearm': 1.1, 'DEF-thigh': 1.08, 'DEF-shin': 1.05, 'DEF-neck': 1.0}
    shape = mh.Shape(gender=1, muscle=0.8, weight=0.42, height=1.0, proportions=1.0, extra={
        **heroic(0.55, hands=0.3), **heroic_face(0.6),
        'chin/chin-prominent-incr': 0.4, 'nose/nose-scale-vert-incr': 0.2, 'cheek/l-cheek-bones-incr': 0.8,
        'cheek/r-cheek-bones-incr': 0.8, 'head/head-oval': 0.5,
        'expression/units/caucasian/eyebrows-left-down': 0.5, 'expression/units/caucasian/eyebrows-right-down': 0.5,
    })

    def make(self):
        F, b = self.F, self.body
        y = F.y()
        x = F.v[:, 0]
        hips = F.joint('DEF-hips')
        neck = F.joint('DEF-neck')
        arm = F.arms()

        # ---- fitted black leather: jerkin, sleeves to the elbow, trousers
        torso = smooth(1 - F.bones('neck', 'head', 'hand', 'f_', 'thumb', 'forearm', 'shin', 'foot', 'toe'), 0.3, 0.6)
        collar = smooth((neck[1] - 0.03) - y, 0, 0.01)
        thighs = smooth(F.bones('thigh', 'hips', 'spine'), 0.3, 0.5)
        suit_f = np.minimum(np.maximum(torso * (1 - smooth(arm - F.bones('upper_arm'), 0.2, 0.4)), thighs), collar)
        legs = smooth(y, hips[1] + 0.02, hips[1] + 0.04)
        suit, W = shell.wrap(b, np.minimum(suit_f, 1 - legs), offset=0.008, smooth=3)
        self.add('trousers', 'leather', suit, W)
        top, W = shell.wrap(b, np.minimum(suit_f, legs), offset=0.01, smooth=3)
        self.add('tunic', 'cloth', top, W)
        # crossed leather harness over the tunic, pinned by a gold serpent-ring clasp
        s1 = F.joint('DEF-spine.001')
        straps = np.zeros(len(y))
        for side, sx in (('L', 1), ('R', -1)):
            d = (F.v - F.joint(f'DEF-upper_arm.{side}')) @ normalize(np.array([-sx * 0.9, 1.0, 0.0]))
            band = np.minimum(smooth(d, -0.035, -0.025), smooth(-d, -0.035, -0.025))
            straps = np.maximum(straps, band)
        straps = np.minimum.reduce([straps, 1 - smooth(arm, 0.2, 0.4), 1 - F.bones('head', 'neck'), smooth(y, s1[1] - 0.02, s1[1] + 0.02)])
        harness, W = shell.plate(b, straps, offset=0.022, thickness=0.008, rim=0.004, smooth=4)
        self.add('harness', 'leather', harness, W)
        P = b.verts[b.used]
        ua = F.joint('DEF-upper_arm.L')
        cross_y = ua[1] - 0.9 * ua[0]
        near = (np.abs(P[:, 0]) < 0.03) & (np.abs(P[:, 1] - cross_y) < 0.02)
        c = np.array([0, cross_y, P[near, 2].max() + 0.04])
        clasp = [kit.ring_around(c, [0, 0, 1], 0.045, 0.011, seg=32, sides=8, flat=0.6)]
        # a serpent biting its tail: the ring with a small head bump
        clasp.append(kit.dome(0.016, 0.012, seg=12).transformed(R=look_rotation([0, 1, 0], [0, 0, 1]), t=c + np.array([0.0, 0.045, 0.006])))
        self.add('clasp', 'gold', merge(clasp), 'DEF-spine.003')
        self.add('clasp_gem', 'gem', kit.dome(0.022, 0.012, seg=16).transformed(R=look_rotation([0, 1, 0], [0, 0, 1]), t=c), 'DEF-spine.003')
        # gold gorget around the base of the neck, flaring onto the chest
        dn = F.dist(neck + np.array([0, -0.03, 0.0]))
        gor_f = np.minimum.reduce([smooth(-dn, -0.17, -0.15), smooth(dn, 0.06, 0.07), 1 - smooth(arm, 0.3, 0.5), 1 - F.bones('head')])
        gor, W = shell.plate(b, gor_f, offset=0.022, thickness=0.009, rim=0.009, rim_width=0.022, smooth=5)
        self.add('gorget', 'gold', gor, W)
        # belt with crossed straps
        belt_f = np.minimum(smooth(y, hips[1] - 0.01, hips[1] + 0.01), smooth(-y, -(hips[1] + 0.08), -(hips[1] + 0.06)))
        belt, W = shell.plate(b, belt_f * (1 - arm), offset=0.02, thickness=0.01, rim=0.005, smooth=6)
        self.add('belt', 'goldplain', belt, W)

        # ---- one ornate gold shoulder guard on the left, a leather one on the right
        p, W, _ = kit.pauldron(b, 'L', size=1.0, layers=3, spikes=3, rivets=5)
        self.add('pauldron.L', 'gold', p, W)
        p, W, _ = kit.pauldron(b, 'R', size=0.75, layers=2, spikes=0)
        self.add('pauldron.R', 'leather', p, W)
        for s in ('L', 'R'):
            fa, hand = F.joint(f'DEF-forearm.{s}'), F.joint(f'DEF-hand.{s}')
            t = F.along(fa, hand)
            fld = np.minimum(F.bones(f'forearm.{s}'), np.minimum(smooth(t, 0.15, 0.2), smooth(-t, -0.95, -0.9)))
            bracer, W = shell.plate(b, fld, offset=0.012, thickness=0.008, rim=0.007, smooth=4)
            self.add(f'bracer.{s}', 'gold', bracer, W)
            sh, ft = F.joint(f'DEF-shin.{s}'), F.joint(f'DEF-foot.{s}')
            t = F.along(sh, ft)
            boot_f = np.minimum(F.bones(f'shin.{s}'), smooth(t, 0.02, 0.07))
            boot, W = shell.plate(b, boot_f, offset=0.01, thickness=0.009, rim=0.008, smooth=3)
            self.add(f'boot.{s}', 'leather', boot, W)
            kn = F.joint(f'DEF-shin.{s}')
            kd = F.dist(kn + np.array([0, -0.02, 0.05]))
            knee, W = shell.plate(b, np.minimum(smooth(-kd, -0.08, -0.07), F.bones(f'thigh.{s}', f'shin.{s}')), offset=0.03, thickness=0.008, rim=0.008, smooth=3)
            self.add(f'knee.{s}', 'gold', knee, W)

        # ---- green tabard panels and a long scarf-cape
        armmask = F.arms() > 0.3
        self.meta['colliders'] = physics.colliders(b)
        self.meta['cloths'] += [
            physics.panel(b, 'tabard.front', 'cloth', hips[1] + 0.02, True, 0.24, 0.85, rows=11, arm_mask=armmask, clearance=0.04),
            physics.panel(b, 'tabard.back', 'cloth', hips[1] + 0.02, False, 0.3, 0.9, rows=11, arm_mask=armmask, clearance=0.04),
            physics.cape(b, 'cape', 'cloth', width=0.42, length=1.5, arm_mask=armmask, clearance=0.06, flare=0.4),
        ]

        # ---- head: swept-back black mane, horned circlet
        add_hair_head(self, hair_len=0.45, beard=False, mustache=False, seed=17, wild=0.15)
        self.circlet()
        self.daggers()

        hide = (F.bones('foot', 'toe') > 0.9) & (y < 0.06)
        hide = hide | add_boot_feet(self)
        self.add_body(hide=hide)
        self.eyes()
        self.meta['grip'] = ['L', 'R']
        self.meta['curl'] = kit.grip_curl(b, 'L') + kit.grip_curl(b, 'R')
        del x

    def circlet(self):
        lm = face_fields(self)
        eye = lm['eye']
        b = self.body
        V = b.verts[b.used]
        cy = eye[1] + 0.045
        sk = V[(self.F.bones('DEF-head')[b.used] > 0.5) & (np.abs(V[:, 1] - cy) < 0.01)]
        cz = (sk[:, 2].max() + sk[:, 2].min()) / 2
        rx = np.abs(sk[:, 0]).max() + 0.035
        rz = (sk[:, 2].max() - sk[:, 2].min()) / 2 + 0.035
        c = np.array([0, cy, cz])
        band = kit.ring_around(c, normalize(np.array([0, 1, -0.2])), rx, 0.012, seg=48, sides=6, rz=rz / rx)
        pieces = [band]
        # front point dipping onto the forehead
        tip = extrude(np.array([[-0.04, 0.0], [0.04, 0.0], [0.0, -0.06]]), 0.012, 0.003).transformed(t=c + np.array([0, 0.005, rz + 0.004]))
        pieces.append(tip)
        # horns: ridged, swept back along the skull, then hooking down and out like a ram's
        for sx in (-1, 1):
            root = c + np.array([sx * rx * 0.8, 0.015, rz * 0.45])
            t = np.linspace(0, 1, 18)
            a = t * np.pi * 1.25
            path = np.stack([
                root[0] + sx * (0.03 * t + 0.06 * t ** 2),
                root[1] + 0.09 * np.sin(a),
                root[2] - 0.11 * (1 - np.cos(a)) - 0.08 * t,
            ], axis=1)
            r = 0.026 * (1 - t) ** 0.7 + 0.004
            pieces.append(tube(path, r, 8))
            for k in (0.12, 0.24, 0.36, 0.48, 0.6):
                i = int(k * 17)
                pieces.append(kit.ring_around(path[i], normalize(path[i + 1] - path[i - 1]), r[i] + 0.002, 0.004, seg=16, sides=5))
        m = merge(pieces)
        self.add('circlet', 'gold', m, 'DEF-head')
        gem = kit.dome(0.012, 0.008, seg=16).transformed(R=look_rotation([0, 1, 0], [0, 0, 1]), t=c + np.array([0, -0.018, rz + 0.012]))
        self.add('circlet_gem', 'gem', gem, 'DEF-head')

    def daggers(self):
        for s in ('L', 'R'):
            center, along, across, palm = kit.hand_frame(self.body, s)
            grip = center + palm * 0.03 - along * 0.035
            # blade points out of the thumb side of the fist, slightly forward
            R = look_rotation(palm, normalize(across + along * 0.25))
            handle = tube(np.array([[0, -0.07, 0], [0, 0.07, 0]]), np.array([0.018, 0.018]), 8)
            pommel = kit.dome(0.024, 0.02, seg=12).transformed(R=look_rotation([0, 0, 1], [0, -1, 0]), t=[0, -0.075, 0])
            guard = extrude(np.array([[-0.07, -0.012], [0.07, -0.012], [0.09, 0.01], [0.05, 0.014], [0, 0.01], [-0.05, 0.014], [-0.09, 0.01]]), 0.024, 0.005)
            guard = guard.transformed(R=look_rotation([0, 0, 1], [0, 1, 0]), t=[0, 0.075, 0])
            # curved, wavy blade
            n = 9
            t = np.linspace(0, 1, n)
            edge_r = [[0.022 + 0.01 * np.sin(k * 2.2), 0.085 + k * 0.42] for k in t]
            edge_l = [[-0.022 * (1 - k) - 0.004, 0.085 + k * 0.42] for k in t]
            poly = np.array(edge_r + [[-0.01, 0.53]] + edge_l[::-1])
            poly[:, 0] += 0.03 * np.linspace(0, 1, len(poly)) ** 2 * 0  # keep symmetric along the spine
            bl = extrude(poly, 0.008, 0.003)
            curve = lambda v: v + np.stack([np.zeros(len(v)), np.zeros(len(v)), np.zeros(len(v))], 1)  # noqa: E731
            del curve
            T = lambda m: m.transformed(R=R, t=grip)  # noqa: E731
            self.add(f'dagger_grip.{s}', 'leather', T(handle), f'DEF-hand.{s}')
            self.add(f'dagger_trim.{s}', 'gold', T(merge([pommel, guard])), f'DEF-hand.{s}')
            self.add(f'dagger_blade.{s}', 'steel', T(bl), f'DEF-hand.{s}')
            glow_edge = tube(np.array([[0.0, 0.1, 0], [0.0, 0.5, 0]]), np.array([0.003, 0.0015]), 4)
            self.add(f'dagger_glow.{s}', 'glow', T(glow_edge.transformed(t=[0, 0, 0.005])), f'DEF-hand.{s}')
