"""Read-only Premiere Source Text decoder; unknown fields remain raw.

Decoder/schema extracted from the local kazaru textstyle_fb.py.
Source SHA256: 1127c78a79f50332f0ca9cf8a692598953e455045d075c6f8331c15739ae20ed
No encoding, project mutation, default color inference or rendering is performed.
Field names are a reverse-engineered schema, not a full Adobe renderer.
"""
from __future__ import annotations

import hashlib
import struct

MAGIC = 0x11223344

# 型: 'u8' / 'u32' / 'f32' / 'str' / 'table:<kind>' / 'vec_table:<kind>' / 'vec_str'
SCHEMA: dict[str, dict[int, str]] = {
    "root": {0: "table:textparam", 4: "u8"},
    "textparam": {
        0: "vec_table:run", 1: "vec_str", 4: "u32", 5: "u32", 6: "f32",
        10: "table:color", 11: "u8", 12: "f32", 13: "f32", 14: "f32", 15: "f32", 16: "f32",
        17: "table:color", 18: "u8", 19: "f32", 20: "f32",
        23: "u32", 24: "u32", 26: "u8", 30: "u32", 34: "f32",
        37: "vec_table:shadow", 40: "table:gradient", 43: "u8", 44: "u8",
    },
    "run": {0: "str", 1: "table:style"},
    "style": {
        1: "f32", 2: "table:color", 4: "table:color", 5: "u8", 6: "f32", 7: "f32", 8: "f32",
        15: "u8", 17: "vec_table:stroke", 20: "u32", 21: "table:gradient", 22: "u32",
        23: "table:gradient", 24: "u32",
    },
    "stroke": {0: "table:color", 1: "u8", 2: "f32", 4: "table:gradient"},
    "shadow": {0: "table:color", 1: "u8", 2: "f32", 3: "f32", 4: "f32", 5: "f32", 6: "f32", 8: "table:gradient"},
    "gradient": {0: "f32", 1: "vec_table:cstop", 2: "vec_table:ostop"},
    "cstop": {0: "table:color", 1: "f32", 2: "f32"},
    "ostop": {0: "f32", 1: "f32", 2: "f32"},
    "color": {0: "u8", 1: "u8", 2: "u8"},
}

# 人が読める名前 (decode 結果のキーはこの名前。未知フィールドは f<番号>)
NAMES: dict[str, dict[int, str]] = {
    "root": {0: "textparam"},
    "textparam": {
        0: "runs", 1: "fonts", 4: "align", 5: "valign", 6: "leading",
        10: "shadow_color", 11: "shadow_visible", 12: "shadow_opacity", 13: "shadow_angle",
        14: "shadow_distance", 15: "shadow_size", 16: "shadow_blur",
        17: "bg_color", 18: "bg_visible", 19: "bg_opacity", 20: "bg_size",
        23: "flag23", 24: "flag24", 26: "flag26", 30: "stroke_count", 34: "flag34",
        37: "shadows", 40: "gradient40", 43: "flag43", 44: "flag44",
    },
    "run": {0: "text", 1: "style"},
    "style": {
        1: "size", 2: "fill", 4: "stroke_color", 5: "stroke_visible", 6: "stroke_width",
        7: "leading", 8: "tracking", 15: "italic", 17: "strokes", 20: "fill_type",
        21: "fill_gradient", 22: "flag22", 23: "stroke_gradient", 24: "flag24",
    },
    "stroke": {0: "color", 1: "visible", 2: "width", 4: "gradient"},
    "shadow": {0: "color", 1: "visible", 2: "opacity", 3: "angle", 4: "distance", 5: "size", 6: "blur", 8: "gradient"},
    "gradient": {0: "angle", 1: "colors", 2: "opacities"},
    "cstop": {0: "color", 1: "pos", 2: "mid"},
    "ostop": {0: "opacity", 1: "pos", 2: "mid"},
    "color": {0: "r", 1: "g", 2: "b"},
}
_REV = {kind: {v: k for k, v in d.items()} for kind, d in NAMES.items()}


def _u32(b, o): return struct.unpack_from("<I", b, o)[0]
def _i32(b, o): return struct.unpack_from("<i", b, o)[0]
def _u16(b, o): return struct.unpack_from("<H", b, o)[0]
def _f32(b, o): return struct.unpack_from("<f", b, o)[0]


class DecodeError(ValueError):
    pass


def _fields(b, pos):
    vt = pos - _i32(b, pos)
    if not (0 <= vt <= len(b) - 4):
        raise DecodeError(f"vtable out of range at {pos}")
    vsz, tsz = _u16(b, vt), _u16(b, vt + 2)
    nf = (vsz - 4) // 2
    offs = [(i, _u16(b, vt + 4 + 2 * i)) for i in range(nf)]
    present = sorted(o for _, o in offs if o)
    out = []
    for i, o in offs:
        if not o:
            continue
        nxt = min([x for x in present if x > o] + [tsz])
        out.append((i, o, nxt - o))
    return out, nf


def _decode_table(b, pos, kind):
    schema = SCHEMA[kind]
    names = NAMES[kind]
    fr, nf = _fields(b, pos)
    d: dict = {"_nf": nf}
    for i, o, w in fr:
        fp = pos + o
        t = schema.get(i)
        key = names.get(i, f"f{i}")
        if t is None:
            d[key] = {"_raw": b[fp:fp + w].hex(), "_w": w}
            continue
        if t == "u8":
            d[key] = b[fp]
        elif t == "u32":
            d[key] = _u32(b, fp)
        elif t == "f32":
            d[key] = _f32(b, fp)
        elif t == "str":
            tgt = fp + _u32(b, fp)
            n = _u32(b, tgt)
            d[key] = b[tgt + 4:tgt + 4 + n].decode("utf-8")
        elif t == "vec_str":
            tgt = fp + _u32(b, fp)
            n = _u32(b, tgt)
            lst = []
            for k in range(n):
                ep = tgt + 4 + 4 * k
                et = ep + _u32(b, ep)
                ln = _u32(b, et)
                lst.append(b[et + 4:et + 4 + ln].decode("utf-8"))
            d[key] = lst
        elif t.startswith("table:"):
            tgt = fp + _u32(b, fp)
            d[key] = _decode_table(b, tgt, t.split(":")[1])
        elif t.startswith("vec_table:"):
            tgt = fp + _u32(b, fp)
            n = _u32(b, tgt)
            lst = []
            for k in range(n):
                ep = tgt + 4 + 4 * k
                lst.append(_decode_table(b, ep + _u32(b, ep), t.split(":")[1]))
            d[key] = lst
    return d


def decode(blob: bytes) -> dict:
    size, zero, magic = struct.unpack_from("<III", blob, 0)
    padding = len(blob) - 12 - size
    if magic != MAGIC or padding < 0 or zero != 0 or any(blob[12+size:]):
        raise DecodeError(f"header mismatch: size={size} len={len(blob)} magic={magic:#x}")
    blob = blob[:12+size]
    root = 12 + _u32(blob, 12)
    result = _decode_table(blob, root, "root")
    if padding:
        result['_trailing_zero_padding_bytes'] = padding
    return result

