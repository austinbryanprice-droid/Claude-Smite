"""Imports a sculpted, painted god model (a Meshy export) onto the shared UAL rig.

    python3 tools/gods/meshy.py [thor]

Writes public/models/gods/<god>.glb in the same layout as the forge's gods
(tools/gods/build.py): one skinned mesh on the 53-bone UAL skeleton, `_ao`
baked per vertex, and the god's meta on the `god` root node. The source is a
single unrigged, textured mesh posed however the sculptor left it, so:

- **Rig**: the skeleton starts from the forge's fitted skeleton
  (`sources/ual_rig.json`), and each bone is swung (and, for the spine, turned)
  onto landmarks read off the sculpt. The bind pose is the sculpt's own pose;
  bone frames keep the UAL axes, so the shared clips play unchanged.
- **Weights**: inverse distance to each bone segment, limited to the bones
  that can own a region (the cape follows the spine, not the arms), then
  smoothed over the surface.
- **Weapon**: the sculpt's weapon pieces are lifted out, scaled, and put back
  in the hand exactly where the forge god held its weapon, so attack clips
  swing it the same way.
- **Surface**: one level of Phong tessellation rounds the low-poly silhouette;
  texture islands are bled outward so mipmaps don't pull in the black gutter.
"""
from __future__ import annotations

import io
import json
import struct
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter
from scipy.sparse import coo_matrix
from scipy.sparse.csgraph import connected_components

sys.path.insert(0, str(Path(__file__).parent))

from forge import ao  # noqa: E402
from forge.export import Part  # noqa: E402
from forge.glb import GlbWriter  # noqa: E402

HERE = Path(__file__).parent
SRC = HERE / 'sources'
OUT = HERE.parents[1] / 'public/models/gods'

# ---------------------------------------------------------------- recipes

THOR = {
    'source': 'thor_meshy.glb',
    'height': 2.3,
    # joint positions on the sculpt, meters, +Y up, +Z forward, the god's right hand toward -X
    'joints': {
        'DEF-hips': (0.0, 1.22, 0.03),
        'DEF-spine.001': (0.0, 1.38, 0.035),
        'DEF-spine.002': (0.0, 1.48, 0.035),
        'DEF-spine.003': (0.0, 1.63, 0.02),
        'DEF-neck': (0.0, 1.86, -0.02),
        'DEF-head': (0.01, 1.98, 0.0),
        'DEF-upper_arm.R': (-0.32, 1.77, 0.12),
        'DEF-forearm.R': (-0.50, 1.50, 0.29),
        'DEF-hand.R': (-0.55, 1.20, 0.33),
        'DEF-upper_arm.L': (0.32, 1.77, -0.15),
        'DEF-forearm.L': (0.38, 1.47, -0.24),
        'DEF-hand.L': (0.43, 1.12, -0.22),
        'DEF-thigh.R': (-0.14, 1.20, 0.08),
        'DEF-shin.R': (-0.33, 0.66, 0.10),
        'DEF-foot.R': (-0.41, 0.18, 0.08),
        'DEF-toe.R': (-0.42, 0.06, 0.34),
        'DEF-thigh.L': (0.12, 1.20, -0.02),
        'DEF-shin.L': (0.26, 0.64, -0.08),
        'DEF-foot.L': (0.35, 0.18, -0.15),
        'DEF-toe.L': (0.37, 0.06, 0.08),
    },
    # the sculpt stands turned a little to its left: world yaw (radians) of these bones in the bind pose
    'yaw': {'DEF-hips': 0.36, 'DEF-spine.001': 0.36, 'DEF-spine.002': 0.38, 'DEF-spine.003': 0.4, 'DEF-neck': 0.25},
    # ...and hunches, chin down: pitch (about model +X, + = forward) the bind so the clips stand him up
    'pitch': {'DEF-spine.003': 0.12, 'DEF-neck': 0.15, 'DEF-head': 0.35},
    'weapon_hand': 'DEF-hand.R',
    # the forge Thor's hammer (handle axis toward the head, head's long axis, grip point) in its hand's bind frame
    'weapon_ref': 'thor_hammer_ref.json',
    'weapon_scale': 1.18,
}

RECIPES = {'thor': THOR}

# bones whose segment runs to this child (or, without one, extends along their own axis by this length)
SEGMENT = {
    'DEF-hips': 'DEF-spine.001', 'DEF-spine.001': 'DEF-spine.002', 'DEF-spine.002': 'DEF-spine.003',
    'DEF-spine.003': 'DEF-neck', 'DEF-neck': 'DEF-head', 'DEF-head': 0.25,
    'DEF-upper_arm.L': 'DEF-forearm.L', 'DEF-forearm.L': 'DEF-hand.L', 'DEF-hand.L': 0.14,
    'DEF-upper_arm.R': 'DEF-forearm.R', 'DEF-forearm.R': 'DEF-hand.R', 'DEF-hand.R': 0.14,
    'DEF-thigh.L': 'DEF-shin.L', 'DEF-shin.L': 'DEF-foot.L', 'DEF-foot.L': 'DEF-toe.L', 'DEF-toe.L': 0.1,
    'DEF-thigh.R': 'DEF-shin.R', 'DEF-shin.R': 'DEF-foot.R', 'DEF-foot.R': 'DEF-toe.R', 'DEF-toe.R': 0.1,
}
TORSO = ['DEF-hips', 'DEF-spine.001', 'DEF-spine.002', 'DEF-spine.003']


# ---------------------------------------------------------------- glb in

def read_glb(path: Path):
    d = path.read_bytes()
    n = struct.unpack('<I', d[12:16])[0]
    j = json.loads(d[20:20 + n])
    b0 = 20 + n + 8
    types = {5126: np.float32, 5121: np.uint8, 5123: np.uint16, 5125: np.uint32}
    width = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4}

    def acc(i):
        a = j['accessors'][i]
        bv = j['bufferViews'][a['bufferView']]
        k = width[a['type']]
        arr = np.frombuffer(d, dtype=types[a['componentType']], count=a['count'] * k,
                            offset=b0 + bv.get('byteOffset', 0) + a.get('byteOffset', 0))
        return arr.reshape(a['count'], k) if k > 1 else arr

    prim = j['meshes'][0]['primitives'][0]
    img = j['images'][j['textures'][j['materials'][prim['material']]['pbrMetallicRoughness']['baseColorTexture']['index']]['source']]
    bv = j['bufferViews'][img['bufferView']]
    png = d[b0 + bv.get('byteOffset', 0):b0 + bv.get('byteOffset', 0) + bv['byteLength']]
    a = prim['attributes']
    return (acc(a['POSITION']).astype(np.float64), acc(a['NORMAL']).astype(np.float64),
            acc(a['TEXCOORD_0']).astype(np.float64), acc(prim['indices']).reshape(-1, 3).astype(np.int64),
            Image.open(io.BytesIO(png)).convert('RGB'))


# ---------------------------------------------------------------- math

def quat_to_mat(q):
    x, y, z, w = q
    return np.array([[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
                     [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
                     [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]])


def mat_to_quat(m):
    t = np.trace(m)
    if t > 0:
        s = np.sqrt(t + 1) * 2
        q = [(m[2, 1] - m[1, 2]) / s, (m[0, 2] - m[2, 0]) / s, (m[1, 0] - m[0, 1]) / s, s / 4]
    elif m[0, 0] > m[1, 1] and m[0, 0] > m[2, 2]:
        s = np.sqrt(1 + m[0, 0] - m[1, 1] - m[2, 2]) * 2
        q = [s / 4, (m[0, 1] + m[1, 0]) / s, (m[0, 2] + m[2, 0]) / s, (m[2, 1] - m[1, 2]) / s]
    elif m[1, 1] > m[2, 2]:
        s = np.sqrt(1 + m[1, 1] - m[0, 0] - m[2, 2]) * 2
        q = [(m[0, 1] + m[1, 0]) / s, s / 4, (m[1, 2] + m[2, 1]) / s, (m[0, 2] - m[2, 0]) / s]
    else:
        s = np.sqrt(1 + m[2, 2] - m[0, 0] - m[1, 1]) * 2
        q = [(m[0, 2] + m[2, 0]) / s, (m[1, 2] + m[2, 1]) / s, s / 4, (m[1, 0] - m[0, 1]) / s]
    q = np.array(q)
    return q / np.linalg.norm(q)


def axis_angle(axis, angle):
    axis = np.asarray(axis, float) / np.linalg.norm(axis)
    x, y, z = axis
    c, s, C = np.cos(angle), np.sin(angle), 1 - np.cos(angle)
    return np.array([[c + x * x * C, x * y * C - z * s, x * z * C + y * s],
                     [y * x * C + z * s, c + y * y * C, y * z * C - x * s],
                     [z * x * C - y * s, z * y * C + x * s, c + z * z * C]])


def swing(a, b):
    """Smallest rotation taking direction a to direction b."""
    a = a / np.linalg.norm(a)
    b = b / np.linalg.norm(b)
    v = np.cross(a, b)
    s, c = np.linalg.norm(v), np.dot(a, b)
    if s < 1e-9:
        return np.eye(3)
    return axis_angle(v, np.arctan2(s, c))


def normalize(v):
    return v / np.maximum(np.linalg.norm(v, axis=-1, keepdims=True), 1e-12)


# ---------------------------------------------------------------- rig

class Rig:
    def __init__(self, template: dict):
        self.names: list[str] = template['names']
        self.parents: list[int] = template['parents']
        self.world_old = np.array(template['world'])  # glTF world matrices are row-major here (4x4 per bone)
        self.world = self.world_old.copy()

    def index(self, name: str) -> int:
        return self.names.index(name)

    def fit(self, joints: dict, yaw: dict, pitch: dict) -> None:
        """Moves every bone onto the sculpt: landmarks set positions; each bone swings toward its child's landmark."""
        old, new = self.world_old, self.world
        n = len(self.names)
        pos_old = old[:, :3, 3]
        for i in range(n):  # template order is parents first
            name = self.names[i]
            p = self.parents[i]
            # rigid follow of the parent unless a landmark says otherwise
            follow = new[p] @ np.linalg.inv(old[p]) if p >= 0 else np.eye(4)
            pos = np.array(joints[name], float) if name in joints else (follow @ np.r_[pos_old[i], 1])[:3]
            R = follow[:3, :3] @ old[i][:3, :3]
            target = SEGMENT.get(name)
            if isinstance(target, str) and target in joints:
                c = self.index(target)
                R = swing(pos_old[c] - pos_old[i], np.array(joints[target], float) - pos) @ old[i][:3, :3]
            if name in yaw:
                # turn about world up, after removing whatever yaw the swing left
                R = axis_angle([0, 1, 0], yaw[name]) @ R
            if name in pitch:
                R = axis_angle([1, 0, 0], pitch[name]) @ R
            M = np.eye(4)
            M[:3, :3] = R
            M[:3, 3] = pos
            new[i] = M

    def locals(self):
        """Local translation and rotation (xyzw) per bone, from the fitted world matrices."""
        t, r = [], []
        for i, p in enumerate(self.parents):
            L = np.linalg.inv(self.world[p]) @ self.world[i] if p >= 0 else self.world[i]
            t.append(L[:3, 3])
            r.append(mat_to_quat(L[:3, :3]))
        return np.array(t), np.array(r)


# ---------------------------------------------------------------- mesh

def weld(P: np.ndarray, tol: float = 1e-5):
    key = np.round(P / tol).astype(np.int64)
    _, first, inv = np.unique(key, axis=0, return_index=True, return_inverse=True)
    return first, inv.ravel()


def components(P, I):
    _, inv = weld(P)
    T = inv[I]
    e = np.concatenate([T[:, [0, 1]], T[:, [1, 2]], T[:, [2, 0]]])
    m = inv.max() + 1
    _, lab = connected_components(coo_matrix((np.ones(len(e)), (e[:, 0], e[:, 1])), shape=(m, m)), directed=False)
    return lab[inv]


def smooth_normals(P, I):
    """Area-weighted vertex normals shared across UV seams."""
    _, inv = weld(P)
    a, b, c = P[I[:, 0]], P[I[:, 1]], P[I[:, 2]]
    fn = np.cross(b - a, c - a)
    acc = np.zeros((inv.max() + 1, 3))
    for k in range(3):
        np.add.at(acc, inv[I[:, k]], fn)
    return normalize(acc[inv])


def phong_tessellate(P, N, UV, I, alpha=0.6):
    """Splits every triangle in four; new edge points are pulled onto the curved surface the normals describe."""
    _, inv = weld(P)
    edges = {}
    newP, newN, newUV = [P], [N], [UV]
    count = len(P)
    tris = []

    def mid(i, j):
        nonlocal count
        # one point per (corner pair) so UV seams stay split, but its position depends only on welded ids
        key = (min(i, j), max(i, j))
        if key in edges:
            return edges[key]
        p = (P[i] + P[j]) / 2
        proj_i = p - np.dot(p - P[i], N[i]) * N[i]
        proj_j = p - np.dot(p - P[j], N[j]) * N[j]
        q = (1 - alpha) * p + alpha * (proj_i + proj_j) / 2
        newP.append(q[None])
        newN.append(normalize(N[i] + N[j])[None])
        newUV.append(((UV[i] + UV[j]) / 2)[None])
        edges[key] = count
        count += 1
        return edges[key]

    for a, b, c in I:
        ab, bc, ca = mid(a, b), mid(b, c), mid(c, a)
        tris += [(a, ab, ca), (ab, b, bc), (ca, bc, c), (ab, bc, ca)]
    return np.concatenate(newP), np.concatenate(newN), np.concatenate(newUV), np.array(tris, dtype=np.int64)


def segment_distance(V, a, b):
    ab = b - a
    t = np.clip(((V - a) @ ab) / max(np.dot(ab, ab), 1e-12), 0, 1)
    return np.linalg.norm(V - (a + t[:, None] * ab), axis=1)


def skin_weights(V, I, rig: Rig, cape: np.ndarray, rigid: np.ndarray | None):
    """Dense (N, B) weights: inverse distance to bone segments, region-limited, smoothed over the surface."""
    names = rig.names
    W = np.zeros((len(V), len(names)))
    pos = rig.world[:, :3, 3]
    side = V[:, 0]
    for name, target in SEGMENT.items():
        i = rig.index(name)
        a = pos[i]
        if isinstance(target, str):
            b = pos[rig.index(target)]
        else:
            # along the bone's own axis (UAL bones point down their local +Y)
            b = a + rig.world[i][:3, 1] * target
        d = segment_distance(V, a, b)
        w = 1 / np.maximum(d, 0.01) ** 4
        # a bone of one side never owns the far side of the body
        if name.endswith('.L'):
            w = w * (side > -0.06)
        elif name.endswith('.R'):
            w = w * (side < 0.06)
        if name not in TORSO and name not in ('DEF-neck', 'DEF-head'):
            w = w * ~cape
        W[:, i] = w
    W /= np.maximum(W.sum(1, keepdims=True), 1e-12)
    # smooth over welded neighbors so joints bend instead of creasing
    _, inv = weld(V)
    T = inv[I]
    e = np.concatenate([T[:, [0, 1]], T[:, [1, 2]], T[:, [2, 0]]])
    m = inv.max() + 1
    A = coo_matrix((np.ones(len(e) * 2), (np.r_[e[:, 0], e[:, 1]], np.r_[e[:, 1], e[:, 0]])), shape=(m, m)).tocsr()
    A.data[:] = 1
    deg = np.maximum(np.asarray(A.sum(1)).ravel(), 1)
    Wu = np.zeros((m, len(names)))
    np.add.at(Wu, inv, W)
    Wu /= np.bincount(inv, minlength=m)[:, None]
    for _ in range(3):
        Wu = 0.5 * Wu + 0.5 * (A @ Wu) / deg[:, None]
    W = Wu[inv]
    if rigid is not None:
        W[rigid] = 0
        W[rigid, rig.index('DEF-hand.R')] = 1
    return W / np.maximum(W.sum(1, keepdims=True), 1e-12)


def top4(W):
    order = np.argsort(-W, axis=1)[:, :4]
    w = np.take_along_axis(W, order, axis=1)
    w[w < 0.02] = 0
    return order.astype(np.uint8), (w / np.maximum(w.sum(1, keepdims=True), 1e-12)).astype(np.float32)


# ---------------------------------------------------------------- texture

def bleed(img: Image.Image, UV: np.ndarray, I: np.ndarray) -> Image.Image:
    """Fills the gutter between texture islands with the nearest island color (push-pull)."""
    w, h = img.size
    mask = Image.new('L', (w, h), 0)
    draw = ImageDraw.Draw(mask)
    px = UV * np.array([w, h])
    for t in I:
        draw.polygon([tuple(px[k]) for k in t], fill=255)
    mask = mask.filter(ImageFilter.MaxFilter(5))
    col = np.asarray(img, dtype=np.float64) / 255
    m = np.asarray(mask, dtype=np.float64)[..., None] / 255
    levels = [(col * m, m)]
    while levels[-1][0].shape[0] > 1:
        c, a = levels[-1]
        hh, ww = c.shape[0] // 2, c.shape[1] // 2
        c2 = c[:hh * 2, :ww * 2].reshape(hh, 2, ww, 2, 3).sum((1, 3))
        a2 = a[:hh * 2, :ww * 2].reshape(hh, 2, ww, 2, 1).sum((1, 3))
        levels.append((c2, a2))
    fill = levels[-1][0] / np.maximum(levels[-1][1], 1e-9)
    for c, a in reversed(levels[:-1]):
        up = np.repeat(np.repeat(fill, 2, 0), 2, 1)[:c.shape[0], :c.shape[1]]
        own = c / np.maximum(a, 1e-9)
        k = np.clip(a, 0, 1)
        fill = own * k + up * (1 - k)
    out = col * m + fill * (1 - m)
    return Image.fromarray(np.clip(out * 255 + 0.5, 0, 255).astype(np.uint8))


# ---------------------------------------------------------------- build

def build(god: str) -> int:
    rec = RECIPES[god]
    P, N, UV, I, tex = read_glb(SRC / rec['source'])

    # stand on the ground at the recipe's height, feet centered on the origin
    k = rec['height'] / (P[:, 1].max() - P[:, 1].min())
    P = P * k
    P[:, 1] -= P[:, 1].min()
    feet = P[P[:, 1] < 0.15].mean(0)
    P[:, 0] -= feet[0]
    P[:, 2] -= feet[2]

    rig = Rig(json.loads((SRC / 'ual_rig.json').read_text()))
    rig.fit(rec['joints'], rec['yaw'], rec.get('pitch', {}))

    # ---- weapon: the two smallest loose pieces near the weapon hand
    lab = components(P, I)
    tri_lab = lab[I[:, 0]]
    sizes = np.bincount(lab)
    hand = np.array(rec['joints'][rec['weapon_hand']])
    cand = [c for c in np.argsort(sizes) if np.linalg.norm(P[lab == c].mean(0) - hand) < 0.7][:2]
    weapon_tri = np.isin(tri_lab, cand)
    handle_c = max(cand, key=lambda c: np.ptp(P[lab == c], axis=0).max())  # the longer piece is the handle
    head_c = [c for c in cand if c != handle_c][0]
    P = place_weapon(P, lab, handle_c, head_c, rig, rec)

    body_I, weap_I = I[~weapon_tri], I[weapon_tri]

    # ---- surface: round the low-poly body; the weapon keeps its crisp edges
    Ns = smooth_normals(P, body_I)
    Pt, Nt, UVt, It = phong_tessellate(P, Ns, UV, body_I)
    used = np.unique(np.concatenate([It.ravel(), weap_I.ravel()]))
    # weapon vertices keep their original (flat-ish) normals
    Nfinal = Nt.copy()
    wv = np.unique(weap_I)
    Nfinal[wv] = N[wv]
    remap = -np.ones(len(Pt), dtype=np.int64)
    remap[used] = np.arange(len(used))
    V, Nv, UVv = Pt[used], normalize(Nfinal[used]), UVt[used]
    T_body, T_weap = remap[It], remap[weap_I]
    T = np.concatenate([T_body, T_weap])
    rigid = np.zeros(len(V), dtype=bool)
    rigid[np.unique(T_weap)] = True

    # ---- cape: red cloth behind the torso follows the spine only
    rgb = np.asarray(tex, dtype=np.float64) / 255
    w, h = tex.size
    px = np.clip((UVv * [w, h]).astype(int), 0, [w - 1, h - 1])
    c = rgb[px[:, 1], px[:, 0]]
    red = (c[:, 0] > 0.35) & (c[:, 0] > c[:, 1] * 2.2) & (c[:, 0] > c[:, 2] * 2.2)
    back = V[:, 2] < -0.12
    low = V[:, 1] < 1.6
    cape = red & back & low

    Wd = skin_weights(V, T, rig, cape, rigid)
    joints, weights = top4(Wd)

    # hair and beard are painted the same yellow as the gold: keep them out of the metal finish
    head = rig.world[rig.index('DEF-head')][:3, 3] + np.array([0, 0.1, 0.02])
    metal = np.ones(len(V), dtype=np.float32)
    metal[np.linalg.norm(V - head, axis=1) < 0.3] = 0
    beard = (np.abs(V[:, 0] - head[0]) < 0.17) & (V[:, 1] > 1.5) & (V[:, 2] > 0.1)
    metal[beard & ~rigid] = 0

    part = Part('body', 'painted', V.astype(np.float32), Nv.astype(np.float32), T, joints, weights,
                UVv.astype(np.float32), None, {'metal': metal})
    ao.bake([part], reach=0.2)

    tex = bleed(tex, UV, I)
    tex = tex.filter(ImageFilter.UnsharpMask(radius=2, percent=45, threshold=2))
    buf = io.BytesIO()
    tex.save(buf, 'JPEG', quality=90, optimize=True)

    hips_old = rig.world_old[rig.index('DEF-hips')][1, 3]
    hips_new = rig.world[rig.index('DEF-hips')][1, 3]
    template_meta = json.loads((SRC / 'ual_rig.json').read_text()).get('meta', {})
    meta = {
        'hipsScale': template_meta.get('hipsScale', 1.4057653752051593) * hips_new / hips_old,
        'height': rec['height'], 'chains': [], 'cloths': [], 'colliders': [],
    }
    return write(OUT / f'{god}.glb', rig, part, meta, buf.getvalue())


def place_weapon(P, lab, handle_c, head_c, rig: Rig, rec):
    """Moves the sculpted weapon into the hand the way the forge god held its own."""
    ref = json.loads((SRC / rec['weapon_ref']).read_text())
    hand = rig.world[rig.index(rec['weapon_hand'])]
    # reference frame (bone space) -> model space through the fitted hand
    R_h, t_h = hand[:3, :3], hand[:3, 3]
    want_axis = R_h @ np.array(ref['axis'])
    want_head = R_h @ np.array(ref['head_axis'])
    want_grip = R_h @ np.array(ref['grip']) + t_h

    hp = P[lab == handle_c]
    c = hp.mean(0)
    _, _, vt = np.linalg.svd(hp - c)
    axis = vt[0]
    hc = P[lab == head_c].mean(0)
    if np.dot(hc - c, axis) < 0:
        axis = -axis
    # the head's long axis, across the handle
    q = P[lab == head_c] - hc
    q = q - np.outer(q @ axis, axis)
    _, _, vt2 = np.linalg.svd(q)
    head_axis = vt2[0]
    if np.dot(head_axis, want_head) < 0:
        head_axis = -head_axis
    # sculpt grip: where the fist closes, on the handle a little short of its far end
    t = (hp - c) @ axis
    grip = c + axis * (t.min() + (t.max() - t.min()) * ref['grip_t'])

    src = np.stack([axis, head_axis, np.cross(axis, head_axis)], 1)
    dst = np.stack([want_axis, want_head, np.cross(want_axis, want_head)], 1)
    R = dst @ src.T
    s = rec['weapon_scale']
    out = P.copy()
    m = (lab == handle_c) | (lab == head_c)
    out[m] = (P[m] - grip) @ R.T * s + want_grip
    return out


def write(path: Path, rig: Rig, part: Part, meta: dict, jpeg: bytes) -> int:
    out = GlbWriter()
    lt, lr = rig.locals()
    ids = [out.node(name=n, translation=lt[i].tolist(), rotation=lr[i].tolist()) for i, n in enumerate(rig.names)]
    for i, p in enumerate(rig.parents):
        if p >= 0:
            out.gltf['nodes'][ids[p]].setdefault('children', []).append(ids[i])
    inv = np.stack([np.linalg.inv(w) for w in rig.world]).astype(np.float32)
    ibm = out.accessor(np.ascontiguousarray(inv.transpose(0, 2, 1)).reshape(-1, 16))
    out.gltf['skins'] = [{'joints': ids, 'inverseBindMatrices': ibm, 'skeleton': ids[0]}]
    m = out.mesh(part.name, [{
        'position': part.position, 'normal': part.normal, 'indices': part.tris, 'material': part.material,
        'uv': part.uv, 'joints': part.joints, 'weights': part.weights, 'extra': part.extra,
    }])
    mesh_node = out.node(name=part.name, mesh=m, skin=0)
    # the painted texture
    view = out._view(jpeg)
    out.gltf['images'] = [{'bufferView': view, 'mimeType': 'image/jpeg'}]
    out.gltf['samplers'] = [{'magFilter': 9729, 'minFilter': 9987}]
    out.gltf['textures'] = [{'source': 0, 'sampler': 0}]
    mat = out.gltf['materials'][out.material_index[part.material]]
    mat['pbrMetallicRoughness']['baseColorTexture'] = {'index': 0}
    mat['doubleSided'] = True
    root = out.node(name='god', children=[ids[0], mesh_node], extras=meta)
    out.gltf['scenes'][0]['nodes'] = [root]
    return out.save(path)


if __name__ == '__main__':
    for g in sys.argv[1:] or list(RECIPES):
        print(f'{g}.glb  {build(g) / 1e6:.2f} MB')
