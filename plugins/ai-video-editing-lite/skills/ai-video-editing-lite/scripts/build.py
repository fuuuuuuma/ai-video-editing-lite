#!/usr/bin/env python3
"""Captions and the whole edit (render plan) from the case's decisions.

  build.py captions <case> [--force]
      planning/captions.json from the transcript's words that survive the cuts: fillers dropped from the
      text, one or two lines of at most style.caption.max_chars_per_line, broken at particles. The agent then
      fixes mis-heard words, line breaks and speakers (K = the channel's person, S = the other person) in it.
      An existing captions.json is never overwritten without --force (captions-draft.json is written instead).
  build.py plan <case> [--version v1]
      planning/render-plan-<v>.json: cuts (voice runs padded by style.cut.pad_frames; silences longer than
      style.cut.max_pause_seconds closed; planning/cuts.json removals taken out), the voice, normal captions
      (each from 1 frame before its voice starts — never before its cut point — until the next caption),
      emphasis captions from planning/emphasis.json (they replace the normal caption and the camera pushes in
      by style.zoom.emphasis_scale), the voice at about -14 LUFS (.akari/work/voice-<n>.wav).

Times in captions.json / emphasis.json / cuts.json are seconds of the ORIGINAL video "src" (0 = first video).
"""
import argparse
import bisect
import json
import math
import re
import subprocess
import sys
from fractions import Fraction
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import lite  # noqa: E402

PUNCT_END = '、。，．,.!！?？…'
BREAK_AFTER = 'をがはにでとものへやか、・'


def norm(t):
    return re.sub(r'[、。，．,.!！?？・…「」『』（）()\s　]', '', t)


class Case:
    def __init__(self, path):
        self.dir = Path(path).resolve()
        self.src = lite.read_json(self.dir / 'planning/source.json')
        self.prof = lite.read_json(self.dir / 'planning/channel-snapshot.json')
        self.style = self.prof['style']
        canvas = self.style.get('canvas', {})
        v0 = self.src['videos'][0]
        rate = Fraction(v0['fps'])
        if rate > 31:            # 60p footage is edited at 30p (half), like most talk videos
            rate = rate / 2
        self.fps = rate if 23 <= rate <= 31 else Fraction(canvas.get('fps', '30/1'))
        self.width, self.height = canvas.get('width', 1920), canvas.get('height', 1080)
        self.blocks = {}
        self.voice = {}
        for n, _ in enumerate(self.src['videos']):
            self.blocks[n] = lite.read_json(self.dir / f'.akari/work/blocks-{n}.json', [])
            self.voice[n] = (lite.read_json(self.dir / f'.akari/work/voice-{n}.json', {}) or {}).get('runs', [])
        cuts = lite.read_json(self.dir / 'planning/cuts.json', {}) or {}
        self.removals = [r for r in cuts.get('removals', []) if r.get('end', 0) > r.get('start', 0)]
        self.segments = self._segments()
        self.starts = [s['out_start'] for s in self.segments]

    # ── cuts ──
    def _segments(self):
        cut = self.style['cut']
        pad = cut.get('pad_frames', 2) / float(self.fps)
        bridge = cut.get('max_pause_seconds', 0.35)
        segs = []
        for n, v in enumerate(self.src['videos']):
            dur = v['duration']
            runs = self.voice[n] or [[0.0, dur]]
            merged = []
            for s, e in runs:
                s, e = max(0.0, s - pad), min(dur, e + pad)
                if merged and s - merged[-1][1] <= bridge:
                    merged[-1][1] = max(merged[-1][1], e)
                else:
                    merged.append([s, e])
            rem = sorted((r['start'], r['end']) for r in self.removals if r.get('src', 0) == n)
            for s, e in merged:
                parts = [[s, e]]
                for rs, re_ in rem:
                    nxt = []
                    for a, b in parts:
                        if re_ <= a or rs >= b:
                            nxt.append([a, b])
                            continue
                        if rs > a:
                            nxt.append([a, rs])
                        if re_ < b:
                            nxt.append([re_, b])
                    parts = nxt
                for a, b in parts:
                    if b - a >= 3 / float(self.fps):
                        segs.append({'src': n, 'start': a, 'end': b})
        out_f = 0
        for s in segs:
            frames = int(math.floor((s['end'] - s['start']) * self.fps))
            s.update(out_start=out_f, out_end=out_f + frames)
            out_f += frames
        self.total = out_f
        return [s for s in segs if s['out_end'] > s['out_start']]

    def frame_of(self, src, t):
        """Output frame of source time t, or None when t was cut."""
        for s in self.segments:
            if s['src'] == src and s['start'] <= t < s['end']:
                return s['out_start'] + int(float(t - s['start']) * float(self.fps) + 1e-6)
        return None

    def segment_at(self, frame):
        i = bisect.bisect_right(self.starts, frame) - 1
        return self.segments[max(0, i)]

    def voice_onset(self, src, t):
        """The start of the voice nearest t (Whisper word times can be early or late by a few frames).
        Inside a voice run that began well before t (talk without a pause), t itself."""
        for s, e in self.voice[src]:
            if s > t + 0.3:
                break
            if t - 0.25 <= s:
                return s
            if s <= t <= e:
                return t
        return t


def words_kept(case):
    fill = {norm(w) for w in case.style['cut'].get('fillers', [])}
    out = []
    for n, blocks in case.blocks.items():
        for b in blocks:
            for w in b.get('words', []):
                mid = (w['start'] + w['end']) / 2
                f = case.frame_of(n, mid)
                if f is None:
                    continue
                t = norm(w['text'].strip().rstrip('ー'))
                if not t or t in fill or norm(w['text']) in fill:
                    continue
                out.append({**w, 'src': n, 'frame': f, 'block': b['id']})
    out.sort(key=lambda w: w['frame'])
    return out


def split_two(text, limit):
    if len(text) <= limit:
        return [text]
    particles = 'をがはにでとものへやか、・'
    cands = [i + 1 for i, ch in enumerate(text[:-1]) if ch in BREAK_AFTER and text[i + 1] not in particles + 'ーっゃゅょぁぃぅぇぉ']
    cands = cands or [i for i in range(1, len(text)) if text[i] not in particles + 'ーっゃゅょぁぃぅぇぉ'] or list(range(1, len(text)))
    cut = min(cands, key=lambda i: (max(i, len(text) - i) > limit, abs(i - len(text) / 2)))
    return [text[:cut], text[cut:]]


def cmd_captions(a):
    case = Case(a.case)
    limit = case.style['caption'].get('max_chars_per_line', 18)
    words = words_kept(case)
    units, cur = [], []

    def flush():
        if cur:
            units.append(list(cur))
            cur.clear()
    for w in words:
        if cur:
            prev = cur[-1]
            pf = case.frame_of(prev['src'], max(prev['start'], prev['end'] - 0.01))
            gap_out = w['frame'] - (pf if pf is not None else prev['frame'])
            text_len = len(norm(''.join(x['text'] for x in cur)))
            if (gap_out > 0.5 * float(case.fps) or prev['text'].strip()[-1:] in '。!！?？' or
                    text_len + len(norm(w['text'])) > 2 * limit or prev['src'] != w['src']):
                flush()
        cur.append(w)
    flush()
    items = []
    for u in units:
        text = re.sub(r'[、。，．,.]+', ' ', ''.join(x['text'].strip() for x in u)).strip()
        text = re.sub(r'\s+', ' ', text)
        if not norm(text):
            continue
        lines = split_two(text.replace(' ', ''), limit) if len(text.replace(' ', '')) > limit else [text]
        items.append({'id': f'c{len(items) + 1:04d}', 'src': u[0]['src'], 'start': round(u[0]['start'], 3), 'end': round(u[-1]['end'], 3),
                      'speaker': 'K', 'text': '\n'.join(lines)})
    out = case.dir / 'planning/captions.json'
    target = out if (a.force or not out.exists()) else case.dir / 'planning/captions-draft.json'
    lite.write_json(target, {'schema': 'ai-video-editing-lite/captions-v1',
                             'note': 'text を直す（聞き間違い・表記・改行 \\n は 1 行 ' + str(limit) + ' 文字まで）。speaker は K（本人）か S（相手）。'
                                     'start / end は元の動画の秒（src 番目）。いらない字幕は消す。2 つに分けたいときは words の秒で分ける。',
                             'items': items})
    print(json.dumps({'captions': len(items), 'file': str(target)}, ensure_ascii=False))


def voice_track(case, n):
    """The n-th video's sound at YouTube's level (about -14 LUFS, peaks under -1.5 dBTP), made once.
    The export mixes this instead of the camera sound (the camera file is never changed)."""
    v = case.src['videos'][n]
    out = case.dir / f'.akari/work/voice-{n}.wav'
    if not out.exists():
        tmp = out.with_name(f'.tmp-{out.name}')
        subprocess.run(['ffmpeg', '-v', 'error', '-nostdin', '-y', '-i', v['path'], '-vn', '-af', 'loudnorm=I=-15:TP=-1.5:LRA=11',
                        '-ar', '48000', '-ac', '2', '-c:a', 'pcm_s16le', str(tmp)], check=True)
        tmp.replace(out)
    return str(out)


def cmd_plan(a):
    import caption_style
    import make_style
    case = Case(a.case)
    if not case.segments:
        raise SystemExit('残る区間がありません（cuts.json を確かめてください）')
    plans = sorted(case.dir.glob('planning/render-plan-v*.json'), key=lambda p: int(re.sub(r'\D', '', p.stem.split('-v')[-1]) or 0))
    ver = a.version or f"v{(int(re.sub(r'[^0-9]', '', plans[-1].stem.split('-v')[-1])) + 1) if plans else 1}"
    style = lite.read_json(case.dir / 'planning/caption-style.json')
    cache = case.dir / '.akari/cache/caption-png'
    fps = case.fps
    total = case.total
    clips, audio = [], []
    for i, s in enumerate(case.segments):
        path = case.src['videos'][s['src']]['path']
        clips.append({'path': path, 'source_start_seconds': round(s['start'], 4), 'start': s['out_start'], 'end': s['out_end'], 'mute': True})
        if case.src['videos'][s['src']]['has_audio']:
            audio.append({'id': f'voice-{i}', 'path': voice_track(case, s['src']), 'source_start_seconds': round(s['start'], 4), 'start': s['out_start'],
                          'end': s['out_end'], 'fade_in_frames': 1, 'fade_out_frames': 1, 'kind': 'voice'})
    caps = (lite.read_json(case.dir / 'planning/captions.json', {}) or {}).get('items', [])
    if not caps:
        raise SystemExit('planning/captions.json がありません（先に build.py captions）')
    placed = []
    for c in caps:
        onset = case.voice_onset(c['src'], c['start'])
        f = case.frame_of(c['src'], onset)
        if f is None:
            f = case.frame_of(c['src'], c['start'])
        if f is None:          # the caption's first words were cut: start at the first kept moment inside it
            t = c['start']
            while t < c['end'] and case.frame_of(c['src'], t) is None:
                t += 1 / float(fps)
            f = case.frame_of(c['src'], t)
        if f is None:
            continue
        seg = case.segment_at(f)
        f = max(seg['out_start'], f - 1)
        if placed and f <= placed[-1]['start']:
            placed[-1]['text'] = placed[-1]['text'] + ' ' + c['text'].replace('\n', '')
            continue
        placed.append({**c, 'start': f})
    if not placed:
        raise SystemExit('出せる字幕がありません')
    for k, c in enumerate(placed):
        c['end'] = placed[k + 1]['start'] if k + 1 < len(placed) else total
    # emphasis
    designs = make_style.design_by_id(case.prof['slug'])
    emph = []
    for e in (lite.read_json(case.dir / 'planning/emphasis.json', {}) or {}).get('items', []):
        f0 = case.frame_of(e.get('src', 0), case.voice_onset(e.get('src', 0), e['start']))
        f1 = case.frame_of(e.get('src', 0), e['end'])
        if f0 is None:
            print(f"  強調 {e.get('id')} の始まりが切られています（飛ばします）", file=sys.stderr)
            continue
        seg = case.segment_at(f0)
        f0 = max(seg['out_start'], f0 - 1)
        f1 = max(f0 + int(0.7 * fps), (f1 if f1 is not None else seg['out_end']))
        f1 = min(f1, total)
        if emph and f0 < emph[-1]['end']:
            print(f"  強調 {e.get('id')} が前の強調と重なっています（飛ばします）", file=sys.stderr)
            continue
        emph.append({**e, 'start': f0, 'end': f1})
    layers, camera = [], []
    zoom = case.style.get('zoom', {})

    def normal_layer(c, a0, a1, part):
        text = c['text']
        try:
            png, x, y = caption_style.render(style, 'normal', text, speaker=c.get('speaker', 'K'), cache_dir=cache)
        except ValueError:
            text = '\n'.join(split_two(text.replace('\n', ''), max(6, len(text.replace('\n', '')) // 2 + 1)))
            png, x, y = caption_style.render(style, 'normal', text, speaker=c.get('speaker', 'K'), cache_dir=cache)
        return {'type': 'image', 'path': str(png), 'start': a0, 'end': a1, 'x': x, 'y': y, 'id': f"{c['id']}{part}", 'role': 'caption',
                'caption_id': c['id'], 'caption_kind': 'normal', 'speaker': c.get('speaker', 'K'), 'text': c['text']}
    for c in placed:
        pieces = [[c['start'], c['end']]]
        for e in emph:
            nxt = []
            for p0, p1 in pieces:
                if e['end'] <= p0 or e['start'] >= p1:
                    nxt.append([p0, p1])
                    continue
                if e['start'] > p0:
                    nxt.append([p0, e['start']])
                if e['end'] < p1:
                    nxt.append([e['end'], p1])
            pieces = nxt
        for k, (p0, p1) in enumerate(pieces):
            if p1 > p0:
                layers.append(normal_layer(c, p0, p1, '' if len(pieces) == 1 else f'-{k}'))
    for e in emph:
        role = e.get('role') or 'assertion'
        st = style
        did = e.get('design')
        if did and did in designs:
            st = {**style, 'emphasis': {**style['emphasis'], role: {**make_style.resolve_item(designs[did]['style']), 'design_id': did}}}
        elif role not in style['emphasis']:
            print(f"  強調 {e.get('id')} の役割 {role} に採用したデザインがありません（飛ばします）", file=sys.stderr)
            continue
        png, x, y = caption_style.render(st, 'emphasis', e['text'], role=role, cache_dir=cache)
        layers.append({'type': 'image', 'path': str(png), 'start': e['start'], 'end': e['end'], 'x': x, 'y': y,
                       'id': f"emph-{e.get('id', len(layers))}", 'role': 'caption', 'caption_id': f"emph-{e.get('id', len(layers))}",
                       'caption_kind': 'emphasis', 'emphasis_role': role, 'design_id': st['emphasis'][role].get('design_id'), 'text': e['text']})
        sc = float(zoom.get('emphasis_scale', 1))
        if sc > 1:
            lo, hi = 0.5 / sc, 1 - 0.5 / sc          # the pushed-in frame must stay inside the picture
            camera.append({'id': f"zoom-{e.get('id')}", 'start': e['start'], 'end': e['end'], 'scale': sc,
                           'cx': round(min(hi, max(lo, zoom.get('cx', 0.5))), 4), 'cy': round(min(hi, max(lo, zoom.get('cy', 0.42))), 4)})
    layers.sort(key=lambda l: (l['start'], l['end']))
    first = placed[0]['start']
    policy = {'continuous_regions': [{'start': first, 'end': total}],
              'excluded_regions': ([{'start': 0, 'end': first, 'reason': '話し始めより前', 'basis': 'ai-video-editing-lite: 字幕は最初の声から'}] if first > 0 else [])}
    plan = {'version': 1, 'fps': f'{fps.numerator}/{fps.denominator}', 'master_gain_db': 0, 'width': case.width,
            'height': case.height, 'frames': total, 'crf': 18, 'channel': f"lite:{case.prof['slug']}", 'speakers': case.style.get('speakers', {'K': '本人', 'S': '相手'}),
            'caption_policy': policy, 'clips': clips, 'camera': camera, 'layers': layers, 'audio': audio,
            'notes': [f'ai-video-editing-lite build.py plan {ver}', f'segments {len(case.segments)}, captions {len(placed)}, emphasis {len(emph)}']}
    out = case.dir / f'planning/render-plan-{ver}.json'
    lite.write_json(out, plan)
    lite.write_json(case.dir / f'planning/cut-pieces-{ver}.json', {'schema': 'ai-video-editing-lite/cut-pieces-v1', 'fps': str(fps),
                                                                  'pieces': [{k: (round(v, 3) if isinstance(v, float) else v) for k, v in s.items()} for s in case.segments]})
    secs = total / float(fps)
    src_secs = sum(v['duration'] for v in case.src['videos'])
    print(json.dumps({'plan': str(out), 'version': ver, 'length': f'{int(secs // 60)}分{secs % 60:04.1f}秒', 'from': f'{int(src_secs // 60)}分{src_secs % 60:04.1f}秒',
                      'cuts': len(case.segments), 'captions': len(placed), 'emphasis': len(emph)}, ensure_ascii=False))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest='cmd', required=True)
    p = sub.add_parser('captions')
    p.add_argument('case')
    p.add_argument('--force', action='store_true')
    p = sub.add_parser('plan')
    p.add_argument('case')
    p.add_argument('--version')
    a = ap.parse_args()
    {'captions': cmd_captions, 'plan': cmd_plan}[a.cmd](a)


if __name__ == '__main__':
    main()
