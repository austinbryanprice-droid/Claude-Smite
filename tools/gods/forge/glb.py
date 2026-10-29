"""Minimal glTF 2.0 binary writer: skinned meshes, a skeleton, named materials, animations."""
from __future__ import annotations

import json
import struct

import numpy as np

FLOAT, U8, U16, U32 = 5126, 5121, 5123, 5125
TYPES = {1: 'SCALAR', 2: 'VEC2', 3: 'VEC3', 4: 'VEC4', 16: 'MAT4'}


class GlbWriter:
    def __init__(self):
        self.gltf = {
            'asset': {'version': '2.0', 'generator': 'Ascendant god forge'},
            'scene': 0, 'scenes': [{'nodes': []}], 'nodes': [], 'meshes': [], 'materials': [],
            'accessors': [], 'bufferViews': [], 'buffers': [],
        }
        self.bin = bytearray()
        self.material_index: dict[str, int] = {}

    def _view(self, data: bytes, target: int | None = None) -> int:
        while len(self.bin) % 4:
            self.bin.append(0)
        view = {'buffer': 0, 'byteOffset': len(self.bin), 'byteLength': len(data)}
        if target:
            view['target'] = target
        self.bin.extend(data)
        self.gltf['bufferViews'].append(view)
        return len(self.gltf['bufferViews']) - 1

    def accessor(self, arr: np.ndarray, normalized: bool = False, target: int | None = None, minmax: bool = False) -> int:
        arr = np.ascontiguousarray(arr)
        comp = {np.float32: FLOAT, np.uint8: U8, np.uint16: U16, np.uint32: U32}[arr.dtype.type]
        width = 1 if arr.ndim == 1 else int(np.prod(arr.shape[1:]))
        acc = {
            'bufferView': self._view(arr.tobytes(), target), 'componentType': comp,
            'count': int(arr.shape[0]), 'type': TYPES[width],
        }
        if normalized:
            acc['normalized'] = True
        if minmax:
            flat = arr.reshape(arr.shape[0], -1)
            acc['min'] = flat.min(axis=0).tolist()
            acc['max'] = flat.max(axis=0).tolist()
        self.gltf['accessors'].append(acc)
        return len(self.gltf['accessors']) - 1

    def material(self, name: str) -> int:
        if name not in self.material_index:
            self.gltf['materials'].append({'name': name, 'pbrMetallicRoughness': {'metallicFactor': 0, 'roughnessFactor': 0.6}})
            self.material_index[name] = len(self.gltf['materials']) - 1
        return self.material_index[name]

    def node(self, **kw) -> int:
        self.gltf['nodes'].append({k: v for k, v in kw.items() if v is not None})
        return len(self.gltf['nodes']) - 1

    def mesh(self, name: str, prims: list[dict]) -> int:
        """prims: dicts with position, normal, indices, material and optional uv, joints, weights, color, extra attrs."""
        out = []
        for p in prims:
            attrs = {
                'POSITION': self.accessor(p['position'].astype(np.float32), target=34962, minmax=True),
                'NORMAL': self.accessor(p['normal'].astype(np.float32), target=34962),
            }
            if p.get('uv') is not None:
                attrs['TEXCOORD_0'] = self.accessor(p['uv'].astype(np.float32), target=34962)
            if p.get('joints') is not None:
                attrs['JOINTS_0'] = self.accessor(p['joints'].astype(np.uint8 if p['joints'].max() < 256 else np.uint16), target=34962)
                attrs['WEIGHTS_0'] = self.accessor(_quantize_weights(p['weights']), normalized=True, target=34962)
            if p.get('color') is not None:
                attrs['COLOR_0'] = self.accessor(np.clip(p['color'] * 255 + 0.5, 0, 255).astype(np.uint8), normalized=True, target=34962)
            for k, v in p.get('extra', {}).items():
                if k == 'ao':  # 0..1 occlusion fits in a normalized byte
                    attrs['_AO'] = self.accessor(np.clip(v * 255 + 0.5, 0, 255).astype(np.uint8), normalized=True, target=34962)
                else:
                    attrs['_' + k.upper()] = self.accessor(v.astype(np.float32), target=34962)
            idx = p['indices'].reshape(-1)
            idx = idx.astype(np.uint16 if idx.max() < 65535 else np.uint32)
            out.append({'attributes': attrs, 'indices': self.accessor(idx, target=34963), 'material': self.material(p['material'])})
        self.gltf['meshes'].append({'name': name, 'primitives': out})
        return len(self.gltf['meshes']) - 1

    def save(self, path) -> int:
        self.gltf['buffers'] = [{'byteLength': len(self.bin)}]
        js = json.dumps(self.gltf, separators=(',', ':')).encode()
        js += b' ' * ((4 - len(js) % 4) % 4)
        while len(self.bin) % 4:
            self.bin.append(0)
        total = 12 + 8 + len(js) + 8 + len(self.bin)
        with open(path, 'wb') as f:
            f.write(struct.pack('<III', 0x46546C67, 2, total))
            f.write(struct.pack('<II', len(js), 0x4E4F534A) + js)
            f.write(struct.pack('<II', len(self.bin), 0x004E4942) + bytes(self.bin))
        return total


def _quantize_weights(w: np.ndarray) -> np.ndarray:
    """Skin weights as normalized bytes that still sum to exactly 255."""
    w = w / np.maximum(w.sum(axis=1, keepdims=True), 1e-9)
    q = np.round(w * 255).astype(np.int32)
    top = np.argmax(w, axis=1)
    q[np.arange(len(q)), top] += 255 - q.sum(axis=1)
    return np.clip(q, 0, 255).astype(np.uint8)
