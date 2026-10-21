#!/usr/bin/env python3
"""Cuts and caption timing changed on the review page, applied to a render plan.

  <case>/planning/cut-edits.json       cuts restored / added on the page (review_server.py)
  <case>/planning/caption-edits.json   op "time" items: caption start / end moved on the page

The page sends cut changes in source time, so they stay right when other edits move
the output frames. This module turns them into a new render plan in one place:

  - review_server.py uses it to rebuild the preview timeline and a quick audio mix,
    so the page shows the change at once;
  - `review_edits.py apply` writes the same plan for the export (render_offline.py).

Cut item (schema review/cut-edits-v1):
  id        unique id
  op        "restore"  put a removed source range back
            "cut"      remove a kept source range
  ranges    [{"name": source file name, "s0": seconds, "s1": seconds}, ...]
  frame     output frame where the reviewer made it (picks the right copy when the
            same source is used twice, e.g. the avan)
  preview   preview name the item belongs to; plan  the plan it was made on
  label     what the page showed (free text); created / updated  ISO times

Move item (same file, op "retime"): an emphasis or a large QR shown at another time
  target       {"kind": "emphasis" | "large_qr", "id": its layer id (emph-e03 / qr-q1)}
  start_source, end_source   the new first / last shown frame as source time
  frame, end_frame           the same in output frames of the timeline it was made on
  The emphasis moves with its camera push-in (cam-*) and SE (se-*), and the normal captions
  next to it follow so the caption track keeps no gap. The large QR moves with its blurred
  background, the header / small QR that step aside, its SE and its susume_segments entry.
  When the plan names a full-length blurred copy of each camera file ("qr_backdrop":
  {camera path: blurred path}), the background pieces (qrbg-<qr>-*) are cut again from the
  clips under the new span, so the blur follows the QR anywhere (user note v9 「QRが入っているのに
  モザイクが入ってない」: the short per-QR blur ran out when the QR moved earlier).

Screen recording moved (op "retime", kind "screen", id "frame-<screen>", 2026-10-21): the frame image, the screen
  pieces (scr-<screen>-*) and the camera wipe (wipe-<screen>-*) are cut again from the clips under the new span, keeping
  the screen's own sync (its offset to the camera, measured from the pieces it had). The no-caption region of the screen
  follows. Normal captions the screen now covers are parked (layers[].parked: kept, never drawn); captions parked under
  the part it no longer covers come back, and the captions next to it close the gap. A Point outside the new span is
  warned about.

Place item (same file, op "place"): a large QR or a past-video thumbnail put elsewhere / resized on the page
  target       {"kind": "large_qr" | "thumbnail", "id": its image layer id (qr-q3 / thumb-v9)}
  x, y, width, height   the image's new box on the 1920x1080 frame (integers; the renderer scales the image to it)
  The blurred background behind it stays full-frame. A thumbnail moved in time ("retime", kind "thumbnail")
  takes its blurred background, its SE (se-<id>) and the header / small QR that step aside, like the large QR.

Caption timing item (caption-edits.json, op "time"):
  caption_id, layer_id   the caption
  start_source           {"name", "seconds"} where it should start
  end_source             {"name", "seconds"} the last frame it should be shown
  frame, end_frame       the same in output frames of the timeline it was made on
  A Point or an emphasis moved this way takes what belongs to it by name: its SE (se-<id>)
  keeps its place from the start, an emphasis' push-in (cam-*) spans it (user note v9
  「Pointをズラした時は演出も自動でズレるようにして」).

  review_edits.py <case> carried --plan planning/render-plan-v10.json --preview v10 \
      --from v8=.akari/reviews/caption-edits-v8-baked.json,.akari/reviews/cut-edits-v8-baked.json \
      --from v9=planning/caption-edits.json,planning/cut-edits.json
      every hand fix of the named versions checked one by one against the new plan
      -> planning/carried-edits.json (the page's 手直し tab shows it)
  review_edits.py <case> list [--preview v7]
  review_edits.py <case> apply --plan planning/render-plan-v7.json --preview v7 --out planning/render-plan-v7-r1.json
"""
import argparse
import copy
import hashlib
import json
import math
import os
import struct
import subprocess
import sys
import time
from fractions import Fraction
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import caption_edits  # noqa: E402

SCHEMA = 'review/cut-edits-v1'
OPS = ('restore', 'cut', 'retime', 'place')
RETIME_KINDS = ('emphasis', 'large_qr', 'thumbnail', 'screen')
PLACE_KINDS = ('large_qr', 'thumbnail')
MAX_ITEMS = 2000
MIN_CAP = 12
RATE = 48000


def path_of(case):
    return Path(case).resolve() / 'planning/cut-edits.json'


def load(case):
    p = path_of(case)
    if not p.exists():
        return {'schema': SCHEMA, 'case': str(Path(case).resolve()), 'items': []}
    return json.loads(p.read_text(encoding='utf-8'))


def _num(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def validate(data):
    """Check a whole cut-edits document; return it (raises ValueError when wrong)."""
    if not isinstance(data, dict) or not isinstance(data.get('items'), list):
        raise ValueError('items list required')
    if len(data['items']) > MAX_ITEMS:
        raise ValueError(f'too many items (max {MAX_ITEMS})')
    seen = set()
    for n, it in enumerate(data['items']):
        where = f'item {n}'
        if not isinstance(it, dict):
            raise ValueError(f'{where}: must be an object')
        if it.get('op') not in OPS:
            raise ValueError(f'{where}: op must be one of {", ".join(OPS)}')
        iid = it.get('id')
        if not isinstance(iid, str) or not iid or len(iid) > 64 or iid in seen:
            raise ValueError(f'{where}: unique id required')
        seen.add(iid)
        fr = it.get('frame')
        if not isinstance(fr, int) or isinstance(fr, bool) or fr < 0:
            raise ValueError(f'{where}: frame required')
        if it['op'] == 'place':
            t = it.get('target')
            if not isinstance(t, dict) or t.get('kind') not in PLACE_KINDS or not isinstance(t.get('id'), str) or not t['id']:
                raise ValueError(f'{where}: target {{"kind": large_qr|thumbnail, "id": layer id}} required')
            for k in ('x', 'y', 'width', 'height'):
                v = it.get(k)
                if not isinstance(v, int) or isinstance(v, bool) or not -4000 <= v <= 8000:
                    raise ValueError(f'{where}: {k} must be an integer')
            if it['width'] < 16 or it['height'] < 16:
                raise ValueError(f'{where}: too small')
            continue
        if it['op'] == 'retime':
            t = it.get('target')
            if not isinstance(t, dict) or t.get('kind') not in RETIME_KINDS or not isinstance(t.get('id'), str) or not t['id']:
                raise ValueError(f'{where}: target {{"kind": emphasis|large_qr|thumbnail, "id": layer id}} required')
            for key in ('start_source', 'end_source'):
                v = it.get(key)
                if not isinstance(v, dict) or not isinstance(v.get('name'), str) or not _num(v.get('seconds')):
                    raise ValueError(f'{where}: {key} must be {{"name", "seconds"}}')
            e = it.get('end_frame')
            if not isinstance(e, int) or isinstance(e, bool) or e <= fr:
                raise ValueError(f'{where}: end_frame after frame required')
            continue
        rs = it.get('ranges')
        if not isinstance(rs, list) or not rs or len(rs) > 64:
            raise ValueError(f'{where}: ranges required')
        for r in rs:
            if not isinstance(r, dict) or not isinstance(r.get('name'), str) or not r['name'] \
                    or not _num(r.get('s0')) or not _num(r.get('s1')) or not 0 <= r['s0'] < r['s1']:
                raise ValueError(f'{where}: each range needs name and 0 <= s0 < s1')
            if r['s1'] - r['s0'] > 600:
                raise ValueError(f'{where}: a range longer than 10 minutes is not a cut edit')
        if it.get('label') is not None and (not isinstance(it['label'], str) or len(it['label']) > 200):
            raise ValueError(f'{where}: label must be short text')
    return data


def items_for(case, preview):
    return [i for i in load(case).get('items', []) if isinstance(i, dict) and i.get('preview') == preview]


# ---------------------------------------------------------------- timeline transform

def fps_of(plan):
    return Fraction(str(plan['fps']))


def _src(el):
    return float(el.get('source_start_seconds', 0))


def _end_src(el, fps):
    return _src(el) + (el['end'] - el['start']) / fps


def _name(el):
    return Path(el['path']).name


class Edit:
    """A render plan being edited. Every change is recorded in self.ops so other
    timelines (the preview's marks) can follow: ('ins', P, n, side) or ('del', a, b)."""

    def __init__(self, plan, duration_of=None):
        self.plan = copy.deepcopy(plan)
        self.plan.setdefault('audio', [])
        self.fps = float(fps_of(plan))
        for k in ('clips', 'layers', 'audio', 'camera'):
            for i, el in enumerate(self.plan.get(k, [])):
                el.setdefault('_o', i)
        self.ops = []
        self.warnings = []
        self.retimed = []
        self.timed_edges = []      # caption ends moved on the page (output frames): the drift check starts after them
        self.placed = []           # images put in another box on the page
        self.duration_of = duration_of
        self.voice_path, self.voice_delta = self._voice_track()

    # -- helpers
    def _voice_track(self):
        """The voice track that follows the camera clips, and its time offset to them."""
        found = {}
        clips = self.plan['clips']
        starts = [c['start'] for c in clips]
        import bisect
        for v in self.plan['audio']:
            if v.get('kind') != 'voice':
                continue
            i = bisect.bisect_right(starts, v['start']) - 1
            if i < 0 or not clips[i]['start'] <= v['start'] < clips[i]['end']:
                continue
            c = clips[i]
            d = _src(v) - (_src(c) + (v['start'] - c['start']) / self.fps)
            found.setdefault(v['path'], []).append(round(d, 4))
        if not found:
            return None, 0.0
        path = max(found, key=lambda p: len(found[p]))
        ds = sorted(found[path])
        return path, ds[len(ds) // 2]

    def _f(self, seconds):
        return int(round(seconds * self.fps))

    def _lists(self):
        p = self.plan
        cp = p.get('caption_policy') or {}
        return [
            ('clip', p.get('clips', [])),
            ('layer', p.get('layers', [])),
            ('audio', p.get('audio', [])),
            ('camera', p.get('camera', [])),
            ('segment', p.get('susume_segments', [])),
            ('region', cp.get('continuous_regions', [])),
            ('excluded', cp.get('excluded_regions', [])),
        ]

    @staticmethod
    def _srcful(kind, el):
        if kind == 'clip':
            return True
        if kind == 'layer':
            return el.get('type') == 'video'
        if kind == 'audio':
            return el.get('kind') == 'voice'
        return False

    @staticmethod
    def _continuous(kind, el):
        """Holds through a join: captions (normal or emphasis, so the caption track keeps
        no gap), the camera framing, screen video and caption regions. SE, BGM, marks,
        headers and the pieces themselves do not."""
        if kind in ('camera', 'region'):
            return True
        if kind == 'layer':
            return el.get('type') == 'video' or el.get('role') == 'caption'
        if kind == 'audio':    # BGM covers the frames put back at its edge, so it never runs short there
            return el.get('kind') == 'bgm'
        return False

    @staticmethod
    def _shift_keys(el, fn):
        if el.get('keyframes'):
            seen, keys = set(), []
            for k in el['keyframes']:
                k = {**k, 'frame': fn(k['frame'])}
                if k['frame'] not in seen:
                    seen.add(k['frame'])
                    keys.append(k)
            el['keyframes'] = keys

    # -- primitive changes
    def insert(self, P, n, side, pinned=()):
        """Open n frames at output frame P. side 'A': things ending at P hold through the
        new frames; side 'B': things starting at P start there and cover them."""
        if n <= 0:
            return
        pin = {id(x) for x in pinned}
        fps = self.fps
        for kind, lst in self._lists():
            out = []
            for el in lst:
                if id(el) in pin:
                    out.append(el)
                    continue
                s, e = el['start'], el['end']
                srcful, cont = self._srcful(kind, el), self._continuous(kind, el)
                if e < P:
                    out.append(el)
                    continue
                if e == P:
                    if cont and side == 'A':     # holds through the opened frames
                        el['end'] = e + n
                    out.append(el)
                    continue
                if s >= P:
                    if s == P and side == 'B' and cont and (not srcful or _src(el) >= n / fps):
                        el['end'] = e + n
                        if srcful:
                            el['source_start_seconds'] = round(_src(el) - n / fps, 6)
                        self._shift_keys(el, lambda k: k + n if k > P else k)
                    else:
                        el['start'], el['end'] = s + n, e + n
                        self._shift_keys(el, lambda k: k + n)
                    out.append(el)
                    continue
                # spans P
                if srcful and kind != 'layer':   # a piece of sound/picture: split around the new frames
                    right = copy.deepcopy(el)
                    el['end'] = P
                    right['start'], right['end'] = P + n, e + n
                    right['source_start_seconds'] = round(_src(el) + (P - s) / fps, 6)
                    if kind == 'audio':
                        el['fade_out_frames'] = max(1, el.get('fade_out_frames', 0) or 0)
                        right['fade_in_frames'] = max(1, right.get('fade_in_frames', 0) or 0)
                    self._shift_keys(right, lambda k: k + n if k > P else k)
                    out.append(el)
                    out.append(right)
                    continue
                el['end'] = e + n
                self._shift_keys(el, lambda k: k + n if k > P else k)
                out.append(el)
            lst[:] = out
        self.plan['frames'] += n
        self.ops.append(('ins', P, n, side))

    def delete(self, a, b):
        """Remove output frames [a, b)."""
        if b <= a:
            return
        n = b - a
        fps = self.fps

        def m(f):
            return f if f <= a else (a if f < b else f - n)

        for kind, lst in self._lists():
            out = []
            for el in lst:
                s, e = el['start'], el['end']
                if e <= a:
                    out.append(el)
                    continue
                if s >= b:
                    el['start'], el['end'] = s - n, e - n
                    self._shift_keys(el, m)
                    out.append(el)
                    continue
                if self._srcful(kind, el):
                    src = _src(el)
                    if s < a:
                        left = copy.deepcopy(el)
                        left['end'] = a
                        if kind == 'audio':
                            left['fade_out_frames'] = max(1, left.get('fade_out_frames', 0) or 0)
                        self._shift_keys(left, m)
                        out.append(left)
                    if e > b:
                        el['source_start_seconds'] = round(src + (max(s, b) - s) / fps, 6)
                        el['start'], el['end'] = (a if s < b else s - n), e - n
                        if kind == 'audio' and s < b:
                            el['fade_in_frames'] = max(1, el.get('fade_in_frames', 0) or 0)
                        self._shift_keys(el, m)
                        out.append(el)
                    continue
                el['start'], el['end'] = m(s), m(e)
                self._shift_keys(el, m)
                if el['end'] > el['start']:
                    out.append(el)
            lst[:] = out
        self.plan['frames'] -= n
        self.ops.append(('del', a, b))

    # -- source-time edits
    def _clips_of(self, name):
        return [c for c in self.plan['clips'] if _name(c) == name]

    def _voice_at(self, clip, edge):
        """The voice event that follows this clip at its tail ('end') or head ('start')."""
        if not self.voice_path:
            return None
        at = clip['end'] if edge == 'end' else clip['start']
        want = (_end_src(clip, self.fps) if edge == 'end' else _src(clip)) + self.voice_delta
        for v in self.plan['audio']:
            if v.get('kind') != 'voice' or v['path'] != self.voice_path or v.get(edge) != at:
                continue
            got = _end_src(v, self.fps) if edge == 'end' else _src(v)
            if abs(got - want) < 0.6 / self.fps:
                return v
        return None

    def _new_voice(self, P, n, src):
        if not self.voice_path:
            return None
        return {'id': f'voice-r{len(self.plan["audio"])}-{P}', 'path': self.voice_path,
                'source_start_seconds': round(src + self.voice_delta, 6), 'start': P, 'end': P + n,
                'fade_in_frames': 1, 'fade_out_frames': 1, 'kind': 'voice'}

    def _merge_at(self, P):
        """After a full restore, join the two pieces that now continue each other."""
        eps = 0.6 / self.fps
        cl = self.plan['clips']
        for i in range(len(cl) - 1):
            A, B = cl[i], cl[i + 1]
            if A['end'] == P == B['start'] and A['path'] == B['path'] and bool(A.get('mute')) == bool(B.get('mute')) \
                    and abs(_end_src(A, self.fps) - _src(B)) < eps:
                A['end'] = B['end']
                del cl[i + 1]
                break
        au = self.plan['audio']
        for va in au:
            if va.get('kind') != 'voice' or va['end'] != P:
                continue
            for vb in au:
                if vb is not va and vb.get('kind') == 'voice' and vb['start'] == P and vb['path'] == va['path'] \
                        and abs(_end_src(va, self.fps) - _src(vb)) < eps:
                    va['end'] = vb['end']
                    va['fade_out_frames'] = vb.get('fade_out_frames', 0)
                    au.remove(vb)
                    return

    def restore(self, name, s0, s1, near):
        eps = 0.6 / self.fps
        clips = self._clips_of(name)
        win = 20 * self.fps

        def dist(c):
            return 0 if c['start'] <= near <= c['end'] else min(abs(c['start'] - near), abs(c['end'] - near))

        if any(_src(c) - eps <= s0 and s1 <= _end_src(c, self.fps) + eps and dist(c) <= win for c in clips):
            self.warnings.append(f'{name} {s0:.2f}-{s1:.2f}: already in the edit')
            return
        tails = [c for c in clips if abs(_end_src(c, self.fps) - s0) < eps]
        heads = [c for c in clips if abs(_src(c) - s1) < eps]
        A = min(tails, key=dist) if tails else None
        B = min(heads, key=dist) if heads else None
        if A is not None and B is not None and dist(B) < dist(A):
            A = None
        if A is not None:                        # grow the piece before the join
            i = self.plan['clips'].index(A)
            nxt = self.plan['clips'][i + 1] if i + 1 < len(self.plan['clips']) else None
            if nxt is not None and nxt['path'] == A['path'] and _src(nxt) > s0:
                s1 = min(s1, _src(nxt))
            n = self._f(s1 - s0)
            if n <= 0:
                return
            P = A['end']
            va = self._voice_at(A, 'end')
            self.insert(P, n, 'A', pinned=[A] + ([va] if va else []))
            A['end'] += n
            if va:
                va['end'] += n
            else:
                v = self._new_voice(P, n, s0)
                if v:
                    self.plan['audio'].append(v)
            self._merge_at(P + n)
            return
        if B is not None:                        # grow the piece after the join
            i = self.plan['clips'].index(B)
            prv = self.plan['clips'][i - 1] if i > 0 else None
            if prv is not None and prv['path'] == B['path'] and _end_src(prv, self.fps) < s1:
                s0 = max(s0, _end_src(prv, self.fps))
            n = self._f(s1 - s0)
            if n <= 0:
                return
            P = B['start']
            vb = self._voice_at(B, 'start')
            self.insert(P, n, 'B', pinned=[B] + ([vb] if vb else []))
            B['end'] += n
            B['source_start_seconds'] = round(_src(B) - n / self.fps, 6)
            if vb:
                vb['end'] += n
                vb['source_start_seconds'] = round(_src(vb) - n / self.fps, 6)
            else:
                v = self._new_voice(P, n, s0)
                if v:
                    self.plan['audio'].append(v)
            self._merge_at(P)
            return
        before = [c for c in clips if _end_src(c, self.fps) <= s0 + eps]
        if not before:
            self.warnings.append(f'{name} {s0:.2f}-{s1:.2f}: no place to put it back')
            return
        close = [c for c in before if dist(c) <= 3 * win] or before
        A = min(close, key=lambda c: s0 - _end_src(c, self.fps))
        n = self._f(s1 - s0)
        if n <= 0:
            return
        P = A['end']
        idx = self.plan['clips'].index(A)
        self.insert(P, n, 'A', pinned=[A])
        piece = {k: v for k, v in A.items() if k != 'keyframes'}
        piece.update(start=P, end=P + n, source_start_seconds=round(s0, 6))
        self.plan['clips'].insert(idx + 1, piece)
        v = self._new_voice(P, n, s0)
        if v:
            self.plan['audio'].append(v)

    def cut(self, name, s0, s1, near):
        spans = []
        for c in self._clips_of(name):
            src, end = _src(c), _end_src(c, self.fps)
            lo, hi = max(s0, src), min(s1, end)
            if hi <= lo:
                continue
            a = c['start'] + self._f(lo - src)
            b = min(c['end'], c['start'] + self._f(hi - src))
            if b > a:
                spans.append((a, b))
        if not spans:
            self.warnings.append(f'{name} {s0:.2f}-{s1:.2f}: not in the edit')
            return
        far = 20 * self.fps
        close = [s for s in spans if s[0] - far <= near <= s[1] + far]
        if not close:
            close = [min(spans, key=lambda s: min(abs(s[0] - near), abs(s[1] - near)))]
        for a, b in sorted(close, reverse=True):
            self.delete(a, b)

    def apply_items(self, items):
        ordered = sorted(items, key=lambda x: str(x.get('created', '')))
        for it in ordered:
            if it['op'] in ('retime', 'place'):
                continue
            for r in it['ranges']:
                if it['op'] == 'restore':
                    self.restore(r['name'], float(r['s0']), float(r['s1']), it['frame'])
                else:
                    self.cut(r['name'], float(r['s0']), float(r['s1']), it['frame'])
        for it in ordered:      # emphasis / large QR / thumbnail moved on the page: after the cuts, by source time
            if it['op'] == 'retime':
                self.retime(it)
        for it in ordered:      # a large QR / thumbnail put elsewhere or resized: its box only
            if it['op'] == 'place':
                self.place(it)
        self.plan['audio'].sort(key=lambda a: a['start'])
        return self

    # -- what belongs to a Point / an emphasis by name follows it when its time is changed
    def _follow(self, L, a, b):
        lid = str(L.get('id') or '')
        suffix = lid.split('-', 1)[1] if '-' in lid else lid
        d = a - L['start']
        for se in self.plan.get('audio', []):
            if se.get('kind') == 'se' and se.get('id') in (f'se-{lid}', f'se-{suffix}'):
                se['start'], se['end'] = se['start'] + d, se['end'] + d
        if L.get('caption_kind') == 'emphasis':
            for c in self.plan.get('camera', []):
                if c.get('id') in (f'cam-{lid}', f'cam-{suffix}'):
                    c['start'], c['end'] = a, b

    # -- a screen recording shown over another span (see the module notes)
    def _retime_screen(self, L, a, b):
        tid = L['id']; sid = tid[len('frame-'):]
        s0, e0 = L['start'], L['end']
        layers, fps = self.plan['layers'], self.fps
        clips = self.plan.get('clips', [])
        def cam_at(f):
            for c in clips:
                if c['start'] <= f < c['end']:
                    return c, _src(c) + (f - c['start']) / fps
            return None, None
        groups = {}
        for pre in ('scr', 'wipe'):
            ps = [x for x in layers if str(x.get('id', '')).startswith(f'{pre}-{sid}-')]
            if not ps:
                continue
            offs = []
            for x in ps:
                c, cs = cam_at(x['start'])
                if c is not None:
                    offs.append(_src(x) - cs)
            offs.sort()
            groups[pre] = (ps, offs[len(offs) // 2] if offs else 0.0)
        if not groups:
            self.warnings.append(f'{tid}: no screen pieces; left as it was')
            return None
        cam_path = None
        for pre, (ps, off) in groups.items():
            c, _ = cam_at(ps[0]['start'])
            cam_path = cam_path or (c and c['path'])
        if self.duration_of:      # the screen file has an end: the moved span stops there
            for pre, (ps, off) in groups.items():
                dur = self.duration_of(ps[0]['path'])
                if not dur:
                    continue
                for c in clips:
                    ss, ee = max(a, c['start']), min(b, c['end'])
                    if ee <= ss or (cam_path and c['path'] != cam_path):
                        continue
                    lim = ss + int((dur - (_src(c) + (ss - c['start']) / fps + off)) * fps)
                    if lim < ee:
                        b = max(ss, lim)
                        break
        if b - a < MIN_CAP:
            self.warnings.append(f'{tid}: too short after the move; left as it was')
            return None
        for pre, (ps, off) in groups.items():
            at, tpl = layers.index(ps[0]), ps[0]
            for x in ps:
                layers.remove(x)
            new = []
            for c in clips:
                ss, ee = max(a, c['start']), min(b, c['end'])
                if ee <= ss or (cam_path and c['path'] != cam_path):
                    continue
                src = _src(c) + (ss - c['start']) / fps + off
                if src < 0:
                    continue
                new.append({**tpl, 'id': f'{pre}-{sid}-{ss}', 'start': ss, 'end': ee, 'source_start_seconds': round(src, 6)})
            layers[at:at] = new
        L['start'], L['end'] = a, b
        # the screen's no-caption region; the regions that keep captions are what is left of the film
        pol = self.plan.get('caption_policy')
        if pol:
            for r in pol.get('excluded_regions', []):
                if r['start'] == s0 and r['end'] == e0:
                    r['start'], r['end'] = a, b
            ex = sorted((r['start'], r['end']) for r in pol.get('excluded_regions', []))
            cont = []
            lo = min([r['start'] for r in pol.get('continuous_regions', [])] + [x[0] for x in ex] or [0])
            hi = max([r['end'] for r in pol.get('continuous_regions', [])] + [x[1] for x in ex] or [self.plan['frames']])
            f = lo
            for xs, xe in ex:
                if xs > f:
                    cont.append({'start': f, 'end': xs})
                f = max(f, xe)
            if f < hi:
                cont.append({'start': f, 'end': hi})
            pol['continuous_regions'] = cont
        # captions: park what the screen covers now, bring back what it no longer covers
        normal = lambda x: x.get('role') == 'caption' and x.get('caption_kind', 'normal') == 'normal'
        for x in layers:
            if normal(x) and not x.get('parked') and x['start'] < b and a < x['end']:
                if x['start'] < a:
                    x['end'] = a
                elif x['end'] > b:
                    x['start'] = b
                else:
                    x['parked'] = True
        for rs, re_ in ((s0, min(a, e0)), (max(b, s0), e0)):
            if re_ <= rs:
                continue
            for x in layers:
                if normal(x) and x.get('parked') and x['start'] < re_ and rs < x['end']:
                    x.pop('parked', None)
                    x['start'], x['end'] = max(x['start'], rs), min(x['end'], re_)
        # no gap inside the regions that keep captions, around what changed
        w0, w1 = min(s0, a) - 1, max(e0, b) + 1
        ex = [(r['start'], r['end']) for r in (pol or {}).get('excluded_regions', [])]
        open_ = lambda f0, f1: not any(xs < f1 and f0 < xe for xs, xe in ex)
        live = sorted((x for x in layers if normal(x) and not x.get('parked')), key=lambda x: x['start'])
        others = [(x['start'], x['end']) for x in layers if x.get('role') == 'caption' and x.get('caption_kind', 'normal') != 'normal' and not x.get('parked')]
        for i in range(len(live) - 1):
            x, nxt = live[i], live[i + 1]
            if x['end'] < nxt['start'] and x['end'] <= w1 and nxt['start'] >= w0 and open_(x['end'], nxt['start']):
                inside = [(os_, oe) for os_, oe in others if os_ < nxt['start'] and x['end'] < oe]
                if inside:       # an emphasis / Point in the gap: the caption after it starts where it ends
                    e = max(oe for _, oe in inside)
                    if x['end'] >= min(os_ for os_, _ in inside) and e < nxt['start']:
                        nxt['start'] = e
                else:
                    x['end'] = nxt['start']
        for r in (pol or {}).get('continuous_regions', []):
            if not (w0 <= r['start'] <= w1):
                continue
            first = next((x for x in live if x['end'] > r['start']), None)
            if first and first['start'] > r['start'] and first['start'] < r['end'] and open_(r['start'], first['start']):
                first['start'] = r['start']
        for x in layers:
            if x.get('caption_kind') == 'point' and (x['start'] < a or x['end'] > b) and x['start'] < e0 and s0 < x['end']:
                self.warnings.append(f'{tid}: Point 「{x.get("text", "")}」 is outside the moved screen recording')
        return a, b

    # -- an emphasis or a large QR shown at another time, with what belongs to it
    def retime(self, it):
        tid, kind = it['target']['id'], it['target']['kind']
        L = next((x for x in self.plan.get('layers', []) if x.get('id') == tid), None)
        if L is None:
            self.warnings.append(f'{tid}: not in the plan')
            return
        s0, e0 = L['start'], L['end']
        a = self.frame_of(it.get('start_source'), s0)
        b = self.frame_of(it.get('end_source'), e0 - 1)
        if a is None or b is None:
            self.warnings.append(f'{tid}: its words are no longer in the edit')
            return
        b += 1
        layers = self.plan['layers']
        suffix = tid.split('-', 1)[1] if '-' in tid else tid
        if kind == 'screen':
            for x in layers:      # never over an emphasis: the screen stops where it starts / ends
                if (x.get('caption_kind') == 'emphasis' or str(x.get('id', '')).startswith(('qr-q', 'thumb-'))) \
                        and not x.get('parked') and x['start'] < b and a < x['end']:     # nor over a large QR / thumbnail
                    if x['start'] < s0 or x['end'] <= s0:
                        a = max(a, x['end'])
                    else:
                        b = min(b, x['start'])
            if b - a < MIN_CAP:
                self.warnings.append(f'{tid}: too short after the move; left as it was')
                return
            r = self._retime_screen(L, a, b)
            if r is None:
                return
            a, b = r
            self.retimed.append({'kind': kind, 'id': tid, 'from': [s0, e0], 'to': [a, b]})
            return
        if kind == 'emphasis':
            normal = [x for x in layers if x.get('role') == 'caption' and not x.get('parked') and x.get('caption_kind', 'normal') != 'emphasis']
            prev = [x for x in normal if x['end'] == s0]
            nxt = [x for x in normal if x['start'] == e0]
            a = max([a] + [x['start'] + MIN_CAP for x in prev])
            b = min([b] + [x['end'] - MIN_CAP for x in nxt])
            others = [x for x in layers if x is not L and x.get('caption_kind') == 'emphasis']
            for x in others:      # never over another emphasis
                if x['end'] <= s0:
                    a = max(a, x['end'])
                elif x['start'] >= e0:
                    b = min(b, x['start'])
            if b - a < MIN_CAP:
                self.warnings.append(f'{tid}: too short after the move; left as it was')
                return
            inside = [x for x in normal if x not in prev and x not in nxt and x['start'] < b and a < x['end']]
            for x in inside:
                if x['start'] < a:
                    x['end'] = a
                elif x['end'] > b:
                    x['start'] = b
                else:
                    self.warnings.append(f'{tid}: would hide the caption 「{x.get("text", "")}」; left as it was')
                    return
            for x in prev:
                x['end'] = a
            for x in nxt:
                x['start'] = b
            # the push-in belongs to the emphasis by name: it always follows (user note v8 No.11)
            for c in self.plan.get('camera', []):
                if c.get('id') == f'cam-{suffix}':
                    c['start'], c['end'] = a, b
        elif self._backdrop_pieces(suffix):
            if b - a < MIN_CAP:
                self.warnings.append(f'{tid}: too short after the move; left as it was')
                return
            self._cut_backdrop(suffix, a, b)
            for x in layers:      # images that came and went with the QR
                if x is not L and x['start'] == s0 and x['end'] == e0 and x.get('role') not in ('caption', 'header', 'small_qr'):
                    x['start'], x['end'] = a, b
            for x in layers:      # the header and the small QR step aside while the large QR shows
                if x.get('role') in ('header', 'small_qr'):
                    if x['end'] == s0:
                        x['end'] = a
                    elif x['start'] == e0:
                        x['start'] = b
            for sgm in self.plan.get('susume_segments', []):
                if sgm.get('kind') == 'large_qr' and sgm['start'] == s0:
                    sgm['start'], sgm['end'] = a, b
        else:
            group = [x for x in layers if x['start'] == s0 and x['end'] == e0 and x.get('role') != 'caption']
            for x in group:       # the blurred background is a video: keep it inside its file
                if x.get('type') == 'video':
                    src = _src(x)
                    a = max(a, s0 - int(src * self.fps))
                    dur = self.duration_of(x['path']) if self.duration_of else None
                    if dur:
                        b = min(b, a + int((dur - (src + (a - s0) / self.fps)) * self.fps))
            if b - a < MIN_CAP:
                self.warnings.append(f'{tid}: too short after the move; left as it was')
                return
            for x in group:
                if x.get('type') == 'video':
                    x['source_start_seconds'] = round(_src(x) + (a - s0) / self.fps, 6)
                x['start'], x['end'] = a, b
            for x in layers:      # the header and the small QR step aside while the large QR shows
                if x.get('role') in ('header', 'small_qr'):
                    if x['end'] == s0:
                        x['end'] = a
                    elif x['start'] == e0:
                        x['start'] = b
            for sgm in self.plan.get('susume_segments', []):
                if sgm.get('kind') == 'large_qr' and sgm['start'] == s0:
                    sgm['start'], sgm['end'] = a, b
        L['start'], L['end'] = a, b
        for se in self.plan.get('audio', []):
            if se.get('kind') == 'se' and se.get('id') in (f'se-{suffix}', f'se-{tid}'):
                se['start'], se['end'] = se['start'] + a - s0, se['end'] + a - s0
        self.retimed.append({'kind': kind, 'id': tid, 'from': [s0, e0], 'to': [a, b]})

    # -- a large QR / thumbnail image in another box (position and size on the frame)
    def place(self, it):
        tid = it['target']['id']
        L = next((x for x in self.plan.get('layers', []) if x.get('id') == tid and x.get('type') == 'image'), None)
        if L is None:
            self.warnings.append(f'{tid}: not in the plan')
            return
        L['x'], L['y'], L['width'], L['height'] = int(it['x']), int(it['y']), int(it['width']), int(it['height'])
        self.placed.append({'id': tid, 'box': [L['x'], L['y'], L['width'], L['height']]})

    # -- the blurred background of a large QR, cut from a full-length blurred copy of the camera
    def _backdrop_pieces(self, qid):
        backdrop = set((self.plan.get('qr_backdrop') or {}).values())
        pieces = [x for x in self.plan.get('layers', []) if str(x.get('id', '')).startswith(f'qrbg-{qid}-')]
        return pieces if pieces and backdrop and all(x.get('path') in backdrop for x in pieces) else []

    def _cut_backdrop(self, qid, a, b):
        layers, backdrop = self.plan['layers'], self.plan['qr_backdrop']
        pieces = self._backdrop_pieces(qid)
        at, tpl = layers.index(pieces[0]), pieces[0]
        for x in pieces:
            layers.remove(x)
        new = []
        for c in self.plan.get('clips', []):
            ss, ee = max(a, c['start']), min(b, c['end'])
            if ee <= ss:
                continue
            path = backdrop.get(c['path'])
            if not path:
                self.warnings.append(f'qr-{qid}: no blurred copy of {_name(c)}; that part shows unblurred')
                continue
            new.append({**tpl, 'id': f'qrbg-{qid}-{ss}', 'path': path, 'start': ss, 'end': ee,
                        'source_start_seconds': round(_src(c) + (ss - c['start']) / self.fps, 6)})
        layers[at:at] = new

    # -- checks shown on the page after every change
    def check(self, base):
        """Did everything after the last change move by the same amount, does the caption
        track keep no gap, and does every BGM have enough sound for its length."""
        notes = []
        p = self.plan
        clips = p.get('clips', [])
        if clips and clips[-1]['end'] != p['frames']:
            notes.append(f'映像の最後（{clips[-1]["end"]}）と動画の長さ（{p["frames"]}）が合いません')
        for x in p.get('layers', []) + p.get('audio', []):
            if x['end'] > p['frames']:
                notes.append(f'{x.get("id", "")} が動画の終わりより後まで続きます')
        # caption track: no gap inside the regions that keep captions
        cov = np.zeros(p['frames'] + 1, dtype=bool)
        for x in p.get('layers', []):
            if x.get('role') == 'caption' and not x.get('parked'):
                cov[max(0, x['start']):min(p['frames'], x['end'])] = True
        for r in (p.get('caption_policy') or {}).get('continuous_regions', []):
            hole = np.nonzero(~cov[r['start']:r['end']])[0]
            if len(hole):
                notes.append(f'字幕の空白 {len(hole)}コマ（{r["start"] + int(hole[0])} から）')
        # BGM long enough
        for x in p.get('audio', []):
            if x.get('kind') != 'bgm' or x.get('loop') or not self.duration_of:
                continue
            dur = self.duration_of(x['path'])
            need = _src(x) + (x['end'] - x['start']) / self.fps
            if dur and need > dur + 1 / self.fps:
                notes.append(f'BGM「{Path(x["path"]).name}」が {round((need - dur) * self.fps)}コマ足りません')
        # everything after the last change moved by the same amount
        delta = p['frames'] - base['frames']
        last = self._last_base_point()
        moved = bad = 0
        if last is not None:
            for k in ('clips', 'layers', 'audio', 'camera'):
                now = {}
                for x in p.get(k, []):
                    now.setdefault(x.get('_o'), []).append(x)
                for i, x in enumerate(base.get(k, [])):
                    if x['start'] <= last:
                        continue
                    got = now.get(i, [])
                    moved += 1
                    if len(got) != 1 or got[0]['start'] != x['start'] + delta or got[0]['end'] != x['end'] + delta:
                        bad += 1
        if bad:
            notes.append(f'最後の直しより後の {bad}個が、同じだけずれていません')
        return {'ok': not notes, 'notes': notes, 'delta_frames': delta, 'checked_after_last_change': moved}

    def _last_base_point(self):
        """The latest frame of the original plan that any change touched."""
        def to_base(y, upto):
            for prev in reversed(self.ops[:upto]):     # back to the original plan's frames
                if prev[0] == 'ins':
                    _, P, n, _s = prev
                    y = y - n if y >= P + n else (P if y >= P else y)
                else:
                    _, a, b = prev
                    y = y + (b - a) if y >= a else y
            return y
        pts = [to_base(op[1] if op[0] == 'ins' else op[2], j) for j, op in enumerate(self.ops)]
        pts += [to_base(max(r['from'][1], r['to'][1]), len(self.ops)) for r in self.retimed]
        pts += [to_base(e, len(self.ops)) for e in self.timed_edges]
        return max(pts) if pts else None

    # -- captions moved on the page
    def frame_of(self, src, near):
        if not src:
            return None
        best = None
        for c in self.plan['clips']:
            if _name(c) != src.get('name'):
                continue
            d = float(src['seconds']) - _src(c)
            if -0.5 / self.fps <= d < (c['end'] - c['start']) / self.fps:
                f = c['start'] + max(0, int(round(d * self.fps)))
                f = min(f, c['end'] - 1)
                if best is None or abs(f - near) < abs(best - near):
                    best = f
        return best

    def frame_kept(self, src, near, step):
        """frame_of, or when that source frame was cut later (the reviewer timed a caption, then cut
        its edge), the nearest kept frame inward: step +1 for a start, -1 for an end (up to 1 s)."""
        f = self.frame_of(src, near)
        if f is not None or not src:
            return f
        for k in range(1, int(self.fps) + 1):
            f = self.frame_of({**src, 'seconds': float(src['seconds']) + step * k / self.fps}, near)
            if f is not None:
                return f
        return None

    def apply_caption_times(self, items):
        caps = {}
        for L in self.plan.get('layers', []):
            if L.get('role') == 'caption' and not L.get('parked'):     # a caption parked under a screen recording is not on screen
                caps.setdefault(L.get('id'), L)
                caps.setdefault(L.get('caption_id') or L.get('id'), L)
        moved = []
        for it in items:
            if it.get('op') != 'time':
                continue
            # the words of the caption: before the reviewer retyped it, or after (a rebuilt plan already has the new words)
            words = {str(t).replace('\n', '') for t in (it.get('old_text'), it.get('text_now')) if t}
            L = caps.get(it.get('layer_id')) or caps.get(it.get('caption_id'))
            if L is not None and words and L.get('text', '').replace('\n', '') not in words:
                L = None
            if L is None:      # the plan was rebuilt and the ids moved: the same words at the same place in the source
                f = self.frame_kept(it.get('source') or it.get('start_source'), it.get('old_frame', it.get('frame', 0)), 1)
                if f is not None and words:
                    L = next((x for x in self.plan.get('layers', []) if x.get('role') == 'caption' and not x.get('parked') and x['start'] - 20 <= f < x['end'] + 20
                              and x.get('text', '').replace('\n', '') in words), None)
            if L is None:
                self.warnings.append(f"caption {it.get('caption_id')}: not in the plan")
                continue
            a = self.frame_kept(it.get('start_source'), L['start'], 1)
            b = self.frame_kept(it.get('end_source'), L['end'] - 1, -1)
            if a is None or b is None or b + 1 <= a:
                self.warnings.append(f"caption {it.get('caption_id')}: its words are no longer in the edit")
                continue
            if L.get('caption_kind', 'normal') == 'normal':     # never into a stretch the reviewer said has no caption
                for r in (self.plan.get('caption_policy') or {}).get('excluded_regions', []):
                    if r['start'] <= a < r['end'] and r['end'] <= b:
                        a = r['end']
                    if r['start'] <= b < r['end'] and a < r['start']:
                        b = r['start'] - 1
            if L.get('caption_kind') in ('point', 'emphasis') and (L['start'], L['end']) != (a, b + 1):
                self.retimed.append({'kind': L['caption_kind'], 'id': L.get('id'), 'from': [L['start'], L['end']], 'to': [a, b + 1]})
                self._follow(L, a, b + 1)
            self.timed_edges.append(max(L['end'], b + 1) + 1)     # its neighbour moves with it
            L['start'], L['end'] = a, b + 1
            L['timed_by_reviewer'] = True          # caption_onset_audit.py fix leaves it alone
            moved.append(L)
        if moved:   # keep normal captions from overlapping after the moves
            mv = {id(L) for L in moved}
            normal = sorted((L for L in self.plan['layers'] if L.get('role') == 'caption' and not L.get('parked')
                             and L.get('caption_kind', 'normal') != 'emphasis'), key=lambda L: (L['start'], L['end']))
            for p, q in zip(normal, normal[1:]):
                if p['end'] > q['start']:
                    if id(q) in mv and id(p) not in mv:
                        p['end'] = q['start']
                    else:
                        q['start'] = p['end']
                elif 0 < q['start'] - p['end'] <= 2 and (id(p) in mv or id(q) in mv):
                    # source seconds rounded on the page: one boundary, not a 1-frame hole; the caption the
                    # reviewer did not move takes the edge of the one they did
                    if id(p) in mv and id(q) not in mv:
                        q['start'] = p['end']
                    else:
                        p['end'] = q['start']
            self.plan['layers'] = [L for L in self.plan['layers'] if L['end'] > L['start']]
        return self

    # -- captions retyped / added / hidden on the page, drawn like the export (caption_style.py)
    def apply_caption_texts(self, items, style, cache_dir):
        import caption_style
        layers = self.plan['layers']

        def find(it):
            for x in layers:
                if x.get('role') == 'caption' and not x.get('parked') and (x.get('caption_id') or x.get('id')) == it.get('caption_id') \
                        and x.get('text', '').replace('\n', '') in (str(it.get('old_text', '')).replace('\n', ''),
                                                                    str(it.get('text', '')).replace('\n', '')):
                    return x
            f = self.frame_of(it.get('source'), it.get('frame', 0))
            if f is None:
                return None
            for x in layers:
                if x.get('role') == 'caption' and not x.get('parked') and x['start'] - 15 <= f < x['end'] \
                        and x.get('text', '').replace('\n', '') == str(it.get('old_text', '')).replace('\n', ''):
                    return x
            return None

        baked = 0
        for it in sorted(items, key=lambda x: str(x.get('created', ''))):
            op = it.get('op')
            if op == 'edit':
                L = find(it)
                if L is None:
                    f = self.frame_of(it.get('source'), it.get('frame', 0))
                    done = f is not None and any(x.get('role') == 'caption' and not x.get('parked') and x['start'] - 20 <= f < x['end'] + 20
                                                 and x.get('text', '').replace('\n', '') == str(it.get('text', '')).replace('\n', '')
                                                 for x in layers)
                    if not done:       # a rebuilt plan may already carry the new words
                        self.warnings.append(f"caption 「{it.get('old_text')}」: not in the plan")
                    continue
                kind = L.get('caption_kind', 'normal')
                spk = it.get('speaker') or L.get('speaker') or 'K'
                png, x, y = caption_style.render(style, kind, it['text'], spk, L.get('emphasis_role'), cache_dir)
                L.update(path=str(png), x=x, y=y, text=it['text'])
                L.pop('width', None)
                L.pop('height', None)
                if kind != 'emphasis':
                    L['speaker'] = spk
                baked += 1
            elif op == 'delete':
                L = find(it)
                if L is None:
                    continue
                prev = [x for x in layers if x is not L and x.get('role') == 'caption' and not x.get('parked') and x['end'] == L['start']]
                for x in prev:      # the caption before holds through, so the track keeps no gap
                    x['end'] = L['end']
                layers.remove(L)
                baked += 1
            elif op == 'add':
                a = self.frame_of(it.get('source'), it['frame'])
                e = self.frame_of(it.get('end_source'), it.get('end_frame', it['frame'] + 1) - 1)
                if a is None or e is None or e + 1 <= a:
                    self.warnings.append(f"caption 「{it.get('text')}」: its place is no longer in the edit")
                    continue
                b = e + 1
                spk = it.get('speaker') or 'K'
                png, x, y = caption_style.render(style, 'normal', it['text'], spk, None, cache_dir)
                for c in [c for c in layers if c.get('role') == 'caption' and not c.get('parked') and c.get('caption_kind', 'normal') != 'emphasis'
                          and c['start'] < b and a < c['end']]:
                    if c['start'] < a and c['end'] > b:
                        right = {**c, 'start': b}
                        c['end'] = a
                        layers.append(right)
                    elif c['start'] < a:
                        c['end'] = a
                    elif c['end'] > b:
                        c['start'] = b
                    else:
                        layers.remove(c)
                layers.append({'type': 'image', 'path': str(png), 'start': a, 'end': b, 'x': x, 'y': y,
                               'id': f"cap-add-{it.get('id')}", 'role': 'caption', 'caption_id': f"add-{it.get('id')}",
                               'caption_kind': 'normal', 'speaker': spk, 'text': it['text']})
                baked += 1
        return baked

    def result(self, keep_origin=False):
        p = copy.deepcopy(self.plan)
        if not keep_origin:
            for k in ('clips', 'layers', 'audio', 'camera'):
                for el in p.get(k, []):
                    el.pop('_o', None)
        return p


def remap_spans(spans, ops):
    """Follow plain [start, end) spans (the preview's marks) through recorded ops."""
    out = [dict(s) for s in spans]
    for op in ops:
        nxt = []
        if op[0] == 'ins':
            _, P, n, _side = op
            for s in out:
                if s['start'] >= P:
                    s['start'] += n
                    s['end'] += n
                elif s['end'] > P:
                    s['end'] += n
                nxt.append(s)
        else:
            _, a, b = op
            for s in out:
                s['start'] = s['start'] if s['start'] <= a else (a if s['start'] < b else s['start'] - (b - a))
                s['end'] = s['end'] if s['end'] <= a else (a if s['end'] < b else s['end'] - (b - a))
                if s['end'] > s['start']:
                    nxt.append(s)
        out = nxt
    return out


def apply_all(plan, cut_items, time_items=(), keep_origin=False, text_items=(), style=None, cache_dir=None,
              duration_of=None, check=False):
    """cuts -> emphasis / large QR moves -> caption times -> (with a style) retyped captions."""
    ed = Edit(plan, duration_of).apply_items(cut_items)
    ed.apply_caption_times(list(time_items))
    ed.baked = ed.apply_caption_texts(list(text_items), style, cache_dir) if style and text_items else 0
    ed.report = ed.check(plan) if check else None
    return ed.result(keep_origin), ed


# ---------------------------------------------------------------- hand fixes carried into a new version

def _words(t):
    return str(t or '').replace('\n', '').replace(' ', '').replace('　', '')


def check_carried(plan, groups, frames_of=None):
    """Is every hand fix of earlier versions in this plan? One row per item, in the order they were made.

    groups: [(version name, caption-edit and cut-edit items of that version), ...] oldest first.
    frames_of(plan path) -> frames of the plan an item was made on (to guess where its copy is).
    state: ok (in the plan as made), later (a later fix of the same place changed it), ng (missing)."""
    ed = Edit(plan)
    total = plan['frames']
    caps = [L for L in plan.get('layers', []) if L.get('role') == 'caption' and not L.get('parked')]
    allit = [(v, it) for v, its in groups for it in sorted(its, key=lambda x: str(x.get('created', '')))]
    rows = []

    def near_of(it):
        f = it.get('frame') or 0
        n = frames_of(it.get('plan')) if frames_of and it.get('plan') else None
        return int(f * total / n) if n else f

    def later(k, test):
        return any(test(it2) for _, it2 in allit[k + 1:])

    def words_of(it):
        return {_words(t) for t in (it.get('old_text'), it.get('text_now'), it.get('text')) if t}

    def cap_at(f, words, slack=20):
        return [L for L in caps if L['start'] - slack <= f < L['end'] + slack and _words(L.get('text')) in words]

    def deleted(tid, words):
        return any(x.get('op') == 'delete' and (x.get('caption_id') == tid or _words(x.get('old_text')) in words) for _, x in allit)

    def covered(name, sec, near):
        f = ed.frame_of({'name': name, 'seconds': sec}, near)
        return f is not None and abs(f - near) < 1500

    for k, (ver, it) in enumerate(allit):
        op, near = it.get('op'), near_of(it)
        row = {'from': ver, 'id': it.get('id'), 'op': op}
        state, note, frame = 'ok', '', None
        if op in ('cut', 'restore'):
            r0 = it['ranges'][0]
            row['label'] = it.get('label') or ''
            frame = ed.frame_of({'name': r0['name'], 'seconds': r0['s0']}, near)
            keep = [covered(r['name'], (r['s0'] + r['s1']) / 2, near) for r in it['ranges']]
            bad = any(keep) if op == 'cut' else not all(keep)
            if bad:
                other = 'restore' if op == 'cut' else 'cut'
                if later(k, lambda x: x.get('op') == other and any(abs(r['s0'] - q['s0']) < 3 for r in x.get('ranges', []) for q in it['ranges'])):
                    state, note = 'later', '後の手直しで戻した／切った'
                else:
                    state, note = 'ng', 'その区間が' + ('残っている' if op == 'cut' else '戻っていない')
        elif op == 'place':
            tid = it['target']['id']
            L = next((x for x in plan['layers'] if x.get('id') == tid), None)
            row['label'], frame = it.get('label') or '', (L or {}).get('start')
            box = [it.get('x'), it.get('y'), it.get('width'), it.get('height')]
            if L is None:
                state, note = 'later', 'その画像はもう無い'
            elif [L.get('x'), L.get('y'), L.get('width'), L.get('height')] != box:
                if later(k, lambda x: x.get('op') == 'place' and (x.get('target') or {}).get('id') == tid):
                    state, note = 'later', '後で置き直した'
                else:
                    state, note = 'ng', f'{L.get("x")},{L.get("y")} {L.get("width")}x{L.get("height")} にある（手直しは {box[0]},{box[1]} {box[2]}x{box[3]}）'
        elif op == 'retime':
            a = ed.frame_of(it.get('start_source'), it.get('frame', near))
            b = ed.frame_of(it.get('end_source'), it.get('end_frame', near))
            row['label'], frame = it.get('label') or '', a
            tid = it['target']['id']
            L = next((x for x in plan['layers'] if x.get('id') == tid), None)
            hit = a is not None and b is not None and (
                (L is not None and (L['start'], L['end']) == (a, b + 1))
                or any((x['start'], x['end']) == (a, b + 1) and (x.get('caption_kind') == 'emphasis' or str(x.get('id', '')).startswith('qr-'))
                       for x in plan['layers']))
            if not hit and deleted(tid, set()):
                state, note = 'later', '後で「出さない」にした'
            elif not hit:
                if later(k, lambda x: (x.get('target') or {}).get('id') == tid or x.get('caption_id') == tid
                         or x.get('layer_id') == tid):
                    state, note = 'later', '後の手直しで動かし直した'
                elif a is None or b is None:
                    state, note = 'later', 'その声がカットされた'
                else:
                    state, note = 'ng', f'{L["start"] if L else "-"}〜{L["end"] if L else "-"} にある（手直しは {a}〜{b + 1}）'
        elif op == 'time':
            words = words_of(it)
            a = ed.frame_kept(it.get('start_source'), it.get('frame', near), 1)
            b = ed.frame_kept(it.get('end_source'), it.get('end_frame', near), -1)
            row['label'], frame = (it.get('text_now') or it.get('old_text') or ''), a
            if a is None or b is None:
                state, note = 'later', 'その声がカットされた'
            elif deleted(it.get('caption_id'), words):
                state, note = 'later', '後で「出さない」にした'
            else:
                L = min(cap_at(a, words) or [x for x in caps if x['start'] == a] or [None],
                        key=lambda x: abs(x['start'] - a) if x else 0)        # retyped later: the caption that starts there
                if L is None and later(k, lambda x: x.get('caption_id') == it.get('caption_id')):
                    state, note = 'later', '後で打ち直し・動かし直した'
                elif L is None:
                    state, note = 'ng', 'その字幕が見つからない'
                elif (L['start'], L['end']) != (a, b + 1):
                    pts = set()       # frames a later fix put a caption edge on (its own or a neighbour's)
                    for _, x in allit[k + 1:]:
                        for key in ('start_source', 'end_source', 'source'):
                            g = ed.frame_of(x.get(key), a) if x.get(key) else None
                            if g is not None:
                                pts |= {g, g + 1}
                        for r in x.get('ranges', []):
                            g = ed.frame_of({'name': r['name'], 'seconds': r['s0']}, a)
                            if g is not None:
                                pts.add(g)
                    excl = (plan.get('caption_policy') or {}).get('excluded_regions', [])
                    gone = [ed.frame_of(x.get('source') or x.get('start_source'), a) for _, x in allit[k + 1:] if x.get('op') == 'delete']
                    if {L['start'], L['end']} - {a, b + 1} <= pts:
                        state, note = 'later', f'{L["start"]}〜{L["end"]}（後の手直しで隣と一緒に動いた）'
                    elif any(r['start'] <= a < r['end'] and L['start'] == r['end'] for r in excl) or \
                            any(r['start'] <= b < r['end'] and L['end'] == r['start'] for r in excl):
                        state, note = 'later', f'{L["start"]}〜{L["end"]}（字幕を出さない区間の分を除いた）'
                    elif L['end'] > b + 1 and any(g is not None and b - 1 <= g <= L['end'] for g in gone):
                        state, note = 'later', f'{L["start"]}〜{L["end"]}（後で「出さない」にした字幕の間を保持）'
                    elif L.get('caption_kind', 'normal') != it.get('caption_kind', 'normal'):
                        state, note = 'later', f'{L["start"]}〜{L["end"]}（指摘で{"強調" if L.get("caption_kind") == "emphasis" else "別の字幕"}に変えた）'
                    else:
                        state, note = 'ng', f'{L["start"]}〜{L["end"]} にある（手直しは {a}〜{b + 1}）'
        else:          # edit / add / delete
            f = ed.frame_of(it.get('source') or it.get('start_source'), near)
            frame = f
            new, old = _words(it.get('text')), _words(it.get('old_text'))
            row['label'] = (f"{it.get('old_text') or ''} → {it.get('text') or '（出さない）'}" if op != 'add' else it.get('text') or '')
            if f is None:
                state, note = 'later', 'その声がカットされた'
            elif op == 'delete':
                if cap_at(f, {old}, 5):
                    state, note = 'ng', 'まだ出ている'
            elif not cap_at(f, {new}, 45):      # it may start a little later (a no-caption stretch before it)
                if later(k, lambda x: _words(x.get('old_text')) == new or x.get('caption_id') == it.get('caption_id')) \
                        or deleted(it.get('caption_id'), {new}):
                    state, note = 'later', '後で打ち直した'
                else:
                    state, note = 'ng', 'その文字の字幕が見つからない'
        row.update(frame=frame, check={'state': state, 'note': note})
        rows.append(row)
    return rows


def probe_duration(path, _cache={}):
    path = str(path)
    if path not in _cache:
        try:
            out = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path],
                                 capture_output=True, text=True, check=True).stdout.strip()
            _cache[path] = float(out)
        except (subprocess.CalledProcessError, ValueError, OSError):
            _cache[path] = None
    return _cache[path]


# ---------------------------------------------------------------- quick audio mix for the page

def sample_at(frame, fps):
    return round(Fraction(frame * RATE, 1) / fps)


def _wav_data(path):
    """(offset, frames) of the PCM data when the file is 48 kHz stereo 16-bit WAV, else None."""
    try:
        with open(path, 'rb') as f:
            head = f.read(12)
            if len(head) < 12 or head[:4] != b'RIFF' or head[8:12] != b'WAVE':
                return None
            fmt = None
            while True:
                h = f.read(8)
                if len(h) < 8:
                    return None
                cid, size = h[:4], struct.unpack('<I', h[4:])[0]
                if cid == b'fmt ':
                    fmt = f.read(size)
                    if size % 2:
                        f.read(1)
                elif cid == b'data':
                    if not fmt or len(fmt) < 16:
                        return None
                    tag, ch, rate, _br, _al, bits = struct.unpack('<HHIIHH', fmt[:16])
                    if tag not in (1, 0xFFFE) or ch != 2 or rate != RATE or bits != 16:
                        return None
                    total = os.path.getsize(path) - f.tell()
                    return f.tell(), min(size, total) // 4
                else:
                    f.seek(size + (size % 2), 1)
    except OSError:
        return None


class Pcm:
    """Decoded audio of each file, read once: 48 kHz stereo int16, memory-mapped."""

    def __init__(self, cache_dir):
        self.cache = Path(cache_dir)
        self.cache.mkdir(parents=True, exist_ok=True)
        self.open = {}

    def get(self, path):
        path = str(Path(path).resolve())
        st = os.stat(path)
        key = (path, st.st_size, st.st_mtime_ns)
        if key in self.open:
            return self.open[key]
        w = _wav_data(path)
        if w:
            arr = np.memmap(path, dtype='<i2', mode='r', offset=w[0], shape=(w[1], 2)) if w[1] else np.zeros((0, 2), '<i2')
        else:
            h = hashlib.sha256(f'{path}|{st.st_size}|{st.st_mtime_ns}|pcm-v1'.encode()).hexdigest()[:20]
            raw = self.cache / f'{h}.s16'
            if not raw.exists():
                tmp = raw.with_name(f'.tmp-{h}-{os.getpid()}.s16')
                subprocess.run(['ffmpeg', '-v', 'error', '-nostdin', '-y', '-i', path, '-vn', '-af', f'aresample={RATE}',
                                '-ar', str(RATE), '-ac', '2', '-f', 's16le', str(tmp)], check=True)
                tmp.replace(raw)
            n = raw.stat().st_size // 4
            arr = np.memmap(raw, dtype='<i2', mode='r', shape=(n, 2)) if n else np.zeros((0, 2), '<i2')
        self.open[key] = arr
        return arr


def _gain_curve(item, frames):
    """Vectorised render_offline.curve(item, 'gain_db', f, 0) over many output frames."""
    base = item.get('gain_db', 0)
    keys = [k for k in item.get('keyframes', []) if 'gain_db' in k]
    out = np.full(len(frames), base, dtype=np.float64)
    for i, a in enumerate(keys):
        if i == len(keys) - 1:
            out[frames >= a['frame']] = a['gain_db']
            break
        b = keys[i + 1]
        sel = (frames >= a['frame']) & (frames < b['frame'])
        if not sel.any():
            continue
        it = a.get('interpolation', 'linear')
        if it == 'hold':
            out[sel] = a['gain_db']
            continue
        u = (frames[sel] - a['frame']) / (b['frame'] - a['frame'])
        if it == 'smoothstep':
            u = u * u * (3 - 2 * u)
        out[sel] = a['gain_db'] + (b['gain_db'] - a['gain_db']) * u
    return out


def quick_mix(plan, out_path, pcm, block_seconds=30):
    """The export's mix (render_offline.audio_mix) from audio read once per file, written
    as 16-bit WAV. Seconds instead of a minute; for the review page only (the export
    still mixes with render_offline)."""
    fps = fps_of(plan)
    count = sample_at(plan['frames'], fps)
    events = [(c, False) for c in plan['clips'] if not c.get('mute')]
    events += [(e, bool(e.get('loop'))) for e in plan.get('audio', [])]
    prepared = []
    for item, loop in events:
        es, ee = sample_at(item['start'], fps), sample_at(item['end'], fps)
        if ee > es:
            prepared.append((es, ee, item, loop, pcm.get(item['path'])))
    prepared.sort(key=lambda x: x[0])
    master = 10 ** (plan.get('master_gain_db', 0) / 20)
    block = RATE * block_seconds
    out_path = Path(out_path)
    tmp = out_path.with_name(f'.tmp-{out_path.stem}-{os.getpid()}.wav')
    peak = 0.0
    with open(tmp, 'wb') as f:
        data = count * 4
        f.write(b'RIFF' + struct.pack('<I', 36 + data) + b'WAVE')
        f.write(b'fmt ' + struct.pack('<IHHIIHH', 16, 1, 2, RATE, RATE * 4, 4, 16))
        f.write(b'data' + struct.pack('<I', data))
        for b0 in range(0, count, block):
            b1 = min(count, b0 + block)
            mix = np.zeros((b1 - b0, 2), dtype=np.float32)
            for es, ee, item, loop, src in prepared:
                if es >= b1:
                    break
                if ee <= b0:
                    continue
                lo, hi = max(es, b0), min(ee, b1)
                pos = np.arange(lo - es, hi - es)
                off = int(round(_src(item) * RATE))
                n = len(src)
                if loop and n:
                    a = src[(off + pos) % n].astype(np.float32)
                else:
                    a = np.zeros((len(pos), 2), dtype=np.float32)
                    s0, s1 = off + int(pos[0]), off + int(pos[-1]) + 1
                    v0, v1 = max(0, s0), min(n, s1)
                    if v1 > v0:
                        a[v0 - s0:v1 - s0] = src[v0:v1]
                a *= 1 / 32768
                if item.get('keyframes'):
                    g = 10 ** (_gain_curve(item, (es + pos) * float(fps) / RATE) / 20)
                else:
                    g = np.full(len(pos), 10 ** (item.get('gain_db', 0) / 20), dtype=np.float64)
                cnt = ee - es
                fi = sample_at(item.get('fade_in_frames', 0) or 0, fps)
                fo = sample_at(item.get('fade_out_frames', 0) or 0, fps)
                if fi:
                    g = g * np.minimum(1, pos / fi)
                if fo:
                    g = g * np.minimum(1, (cnt - 1 - pos) / fo)
                mix[lo - b0:hi - b0] += a * g[:, None].astype(np.float32)
            if master != 1:
                mix *= master
            if len(mix):
                peak = max(peak, float(np.abs(mix).max()))
            f.write((np.clip(mix, -1, 1) * 32767).round().astype('<i2').tobytes())
    tmp.replace(out_path)
    return {'samples': count, 'peak': peak, 'clipped': peak > 1}


# ---------------------------------------------------------------- CLI

def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('case', type=Path)
    sub = ap.add_subparsers(dest='cmd', required=True)
    ls = sub.add_parser('list', help='cut edits and caption timing edits')
    ls.add_argument('--preview')
    car = sub.add_parser('carried', help='check that the hand fixes of earlier versions are in a new plan')
    car.add_argument('--plan', type=Path, required=True)
    car.add_argument('--preview', required=True, help='the preview built from that plan')
    car.add_argument('--from', dest='groups', action='append', required=True, metavar='VERSION=FILE[,FILE]')
    apl = sub.add_parser('apply', help='write the plan with the page edits applied (for the export)')
    apl.add_argument('--plan', type=Path, required=True)
    apl.add_argument('--preview', required=True, help='preview the edits were made on')
    apl.add_argument('--out', type=Path, required=True)
    args = ap.parse_args()
    case = args.case.resolve()
    times = caption_edits.load_caption_edits(case, args.preview, 'time')
    texts = [i for i in caption_edits.load_caption_edits(case, args.preview) if i.get('op') != 'time']
    if args.cmd == 'carried':
        plan = json.loads((case / args.plan if not args.plan.is_absolute() else args.plan).read_text(encoding='utf-8'))
        groups = []
        for g in args.groups:
            ver, files = g.split('=', 1)
            its = []
            for f in files.split(','):
                fp = Path(f) if Path(f).is_absolute() else case / f
                its += [i for i in json.loads(fp.read_text(encoding='utf-8')).get('items', []) if i.get('preview') == ver]
            groups.append((ver, its))
        frames = {}

        def frames_of(path):
            if path not in frames:
                try:
                    frames[path] = json.loads(Path(path).read_text(encoding='utf-8'))['frames']
                except (OSError, ValueError, KeyError):
                    frames[path] = None
            return frames[path]
        rows = check_carried(plan, groups, frames_of)
        counts = {s_: sum(1 for r in rows if r['check']['state'] == s_) for s_ in ('ok', 'later', 'ng')}
        out = {'schema': 'review/carried-edits-v1', 'preview': args.preview, 'plan': str(args.plan),
               'from': [g for g, _ in groups], 'counts': counts, 'built_at': time.strftime('%Y-%m-%dT%H:%M:%S%z'), 'items': rows}
        (case / 'planning/carried-edits.json').write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding='utf-8')
        print(json.dumps({'items': len(rows), **counts,
                          'ng': [{k: r[k] for k in ('from', 'op', 'frame', 'label')} | r['check'] for r in rows if r['check']['state'] == 'ng']},
                         ensure_ascii=False, indent=1))
        return
    if args.cmd == 'list':
        cuts = [i for i in load(case).get('items', []) if not args.preview or i.get('preview') == args.preview]
        print(json.dumps({'cut_edits': cuts, 'caption_times': times, 'caption_text_edits': len(texts)},
                         ensure_ascii=False, indent=1))
        return
    if args.out.resolve() == args.plan.resolve():
        raise SystemExit('write to a new plan file; the original stays as it is')
    import caption_style
    plan = json.loads(args.plan.read_text(encoding='utf-8'))
    cuts = items_for(case, args.preview)
    style = caption_style.load(case)
    out, ed = apply_all(plan, cuts, times, text_items=texts if style else (), style=style,
                        cache_dir=case / '.akari/work/render-assets/review-edits', duration_of=probe_duration, check=True)
    out['review_edits'] = {
        'from_plan': str(args.plan.resolve()), 'preview': args.preview, 'cut_edits': len(cuts),
        'caption_times': len(times), 'applied_at': time.strftime('%Y-%m-%dT%H:%M:%S%z'),
        'caption_texts_baked': ed.baked,
        'note': 'retyped / added / hidden captions are drawn with planning/caption-style.json (the export style); '
                'without that file they are left to the caption builder'}
    args.out.write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding='utf-8')
    print(json.dumps({'plan': str(args.out), 'frames': out['frames'], 'cut_edits': len(cuts),
                      'caption_times': len(times), 'caption_texts_baked': ed.baked,
                      'caption_text_edits_left_to_bake': 0 if style else len(texts),
                      'check': ed.report, 'warnings': ed.warnings}, ensure_ascii=False, indent=1))


if __name__ == '__main__':
    main()
