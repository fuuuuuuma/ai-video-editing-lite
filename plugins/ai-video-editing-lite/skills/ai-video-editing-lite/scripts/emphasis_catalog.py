#!/usr/bin/env python3
"""Emphasis designs of the channel: one list for every video, adopted or rejected by the reviewer.

The list lives in the channel's memory (~/.ai-video-editing-lite/channels/<slug>/designs.json): roles (when to use /
when not to) and designs (the styled_text item, status adopt / reject / open, memo). The review page
shows it over the review page ("強調デザイン"); rejected designs are not shown at the next load, and the
reviewer's choices are written back to that file, so they carry over to the next video.

Rule for editing (SKILL.md): emphases are drawn only with adopted designs. When a role has several
adopted designs, pick by the line's tone and record the design id in the emphasis ledger.

New designs: add an entry with "status": "open" to the file (the agent does this when asked),
render the samples for the case, and the reviewer adopts or rejects them on the page.

  emphasis_catalog.py render <case> --plan planning/render-plan-v8.json [--emphasis planning/emphasis-v8.json]
  emphasis_catalog.py adopted            # adopted designs per role (what the plan builder may use)
  emphasis_catalog.py style <design id>  # the styled_text item of a design (fonts resolved)

Samples are drawn with the export renderer (styled_text) on a pushed-in camera frame of the case:
<case>/.akari/catalog/emphasis/<id>.jpg and index.json.
"""
import argparse
import hashlib
import json
import os
import subprocess
import sys
import time
from fractions import Fraction
from pathlib import Path

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
from styled_text import make_text_image  # noqa: E402

import lite  # noqa: E402

SCHEMA = 'ai-video-editing-lite/emphasis-designs-v1'
STATES = ('adopt', 'reject', 'open')


def designs_path(path=None):
    """The channel's designs.json (the current channel unless a path is given)."""
    return Path(path) if path else lite.designs_file()


def load(path=None):
    return json.loads(designs_path(path).read_text(encoding='utf-8'))


def save(data, path=None):
    data = {**data, 'schema': SCHEMA, 'updated_at': time.strftime('%Y-%m-%dT%H:%M:%S%z')}
    path = designs_path(path)
    tmp = path.with_name(f'.tmp-{os.getpid()}-{path.name}')
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding='utf-8')
    tmp.replace(path)
    return data


def style_of(design):
    """The styled_text item of a design with its font key turned into the file on this Mac."""
    item = dict(design['style'])
    if item.get('font'):
        item['font'] = lite.font_file(item['font'])
    return item


def adopted(data=None):
    out = {}
    for d in (data or load())['designs']:
        if d.get('status') == 'adopt':
            out.setdefault(d['role'], []).append(d)
    return out


def set_choices(choices, path=None):
    """Write the reviewer's adopt / reject / memo to the channel list (unknown ids are refused)."""
    data = load(path)
    by_id = {d['id']: d for d in data['designs']}
    if not isinstance(choices, dict) or len(choices) > 1000:
        raise ValueError('choices object required')
    for k, v in choices.items():
        if k not in by_id:
            raise ValueError(f'unknown design {k}')
        if not isinstance(v, dict) or v.get('state') not in STATES or len(str(v.get('memo') or '')) > 1000:
            raise ValueError(f'bad choice {k}')
    for k, v in choices.items():
        d = by_id[k]
        if d.get('status') != v['state'] or (v.get('memo') or '') != (d.get('memo') or ''):
            d['status'] = v['state']
            d['memo'] = v.get('memo') or ''
            d['decided_at'] = v.get('at') or time.strftime('%Y-%m-%dT%H:%M:%S%z')
    return save(data, path)


def split_line(text):
    """Two lines at a natural break (after a particle or punctuation) nearest the middle; never inside a word."""
    breaks = [i + 1 for i, ch in enumerate(text[:-1]) if ch in 'をがはにでとものへやか、・' or (ch in '円分個人' and not text[i + 1].isdigit())]
    if not breaks:
        return text
    cut = min(breaks, key=lambda i: abs(i - len(text) / 2))
    return text[:cut] + '\n' + text[cut:]


def render_text(item, text, max_w=1700, max_size=200):
    def go(size):
        return make_text_image({**item, 'font_size': size, 'text': text, 'padding': 6, 'spacing': int(size * 0.08)})
    im = go(max_size)
    ys, xs = np.nonzero(np.asarray(im)[:, :, 3] > 200)
    if xs.max() - xs.min() > max_w:
        im = go(int(max_size * max_w / (xs.max() - xs.min())) - 1)
    return im


def camera_frame(media, t, cache):
    out = cache / f"frame-{hashlib.sha1(f'{media}|{t:.2f}'.encode()).hexdigest()[:12]}.png"
    if not out.exists():
        subprocess.run(['ffmpeg', '-v', 'error', '-nostdin', '-y', '-ss', f'{t:.3f}', '-i', media, '-frames:v', '1',
                        '-vf', 'scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080', str(out)], check=True)
    im = Image.open(out).convert('RGB')
    s, cx, cy = 1.3, 0.5, 0.4            # the emphasis push-in of the plan
    w, h = 1920 / s, 1080 / s
    x0 = min(max(0, 1920 * cx - w / 2), 1920 - w)
    y0 = min(max(0, 1080 * cy - h / 2), 1080 - h)
    return im.crop((int(x0), int(y0), int(x0 + w), int(y0 + h))).resize((1920, 1080), Image.LANCZOS)


def place(bg, text_im, bottom=1050, min_top=650):
    a = np.asarray(text_im)
    ys, xs = np.nonzero(a[:, :, 3] > 200)
    top = bottom - ys.max() + text_im.getbbox()[1]
    if top < min_top:
        k = (bottom - min_top) / (bottom - top)
        text_im = text_im.resize((round(text_im.width * k), round(text_im.height * k)), Image.LANCZOS)
        a = np.asarray(text_im)
        ys, xs = np.nonzero(a[:, :, 3] > 200)
    out = bg.copy().convert('RGBA')
    out.alpha_composite(text_im, (max(0, 960 - (int(xs.min()) + int(xs.max())) // 2), max(0, bottom - int(ys.max()))))
    return out.convert('RGB')


def render_case(case, plan_path, emphasis_path=None, data=None):
    """Samples of every design that is not rejected, on this case's footage, with this case's lines."""
    data = data or load()
    plan = json.loads(Path(plan_path).read_text(encoding='utf-8'))
    e_data = json.loads(Path(emphasis_path).read_text(encoding='utf-8')) if emphasis_path else {}
    emph = e_data.get('items') or e_data.get('emphases') or []
    out = case / '.akari/catalog/emphasis'
    out.mkdir(parents=True, exist_ok=True)
    fps = float(Fraction(str(plan['fps'])))
    cam = plan['clips']

    def source_at(f):
        c = next((c for c in cam if c['start'] <= f < c['end']), None)
        return (c['path'], c.get('source_start_seconds', 0) + (f - c['start']) / fps) if c else None

    layers = {L.get('caption_id'): L for L in plan.get('layers', []) if L.get('caption_kind') == 'emphasis'}
    used = {}
    for e in emph:
        used.setdefault(e['role'], []).append(e)
    spare = list(layers.values())
    roles, n = [], 0
    for k, role in enumerate(data['roles']):
        ex = used.get(role['role'], [])
        text = ex[0]['text'] if ex else role.get('example', role['label'])
        if '\n' not in text and len(text) > 13:
            text = split_line(text)
        lay = layers.get(f"emph-{ex[0]['id']}") if ex else None
        lay = lay or (spare[k % len(spare)] if spare else None)
        src = source_at(lay['start'] + 6) if lay else None
        bg = camera_frame(src[0], src[1], out) if src else Image.new('RGB', (1920, 1080), '#444')
        designs = []
        for d in data['designs']:
            if d['role'] != role['role'] or d.get('status') == 'reject':
                continue
            item = style_of(d)
            if not Path(item['font']).exists():
                continue
            jpg = out / f"{d['id']}.jpg"
            place(bg, render_text(item, text)).resize((960, 540), Image.LANCZOS).save(jpg, quality=88)
            designs.append({'id': d['id'], 'image': str(jpg)})
            n += 1
        roles.append({'role': role['role'], 'example': text.replace('\n', ''), 'designs': designs,
                      'used_in_case': [{'id': e['id'], 'text': e['text'].replace('\n', ''), 'why': e.get('why', '')} for e in ex]})
    idx = {'schema': 'review/emphasis-catalog-v2', 'case': str(case), 'plan': str(Path(plan_path).resolve()),
           'designs_file': str(designs_path()), 'roles': roles, 'built_at': time.strftime('%Y-%m-%dT%H:%M:%S%z')}
    (out / 'index.json').write_text(json.dumps(idx, ensure_ascii=False, indent=1), encoding='utf-8')
    return out, n


def catalog_for_page(case, path=None):
    """What the review page shows: roles and designs from the channel list, samples from the case.
    Rejected designs are left out, so they disappear at the next load."""
    data = load(path)
    idx_path = Path(case) / '.akari/catalog/emphasis/index.json'
    idx = json.loads(idx_path.read_text(encoding='utf-8')) if idx_path.exists() else {'roles': []}
    images = {d['id']: d['image'] for r in idx['roles'] for d in r['designs']}
    case_roles = {r['role']: r for r in idx['roles']}
    roles = []
    for role in data['roles']:
        designs = [{'id': d['id'], 'name': d['name'], 'status': d.get('status', 'open'), 'memo': d.get('memo', ''),
                    'current': bool(d.get('current')), 'image': images.get(d['id'])}
                   for d in data['designs'] if d['role'] == role['role'] and d.get('status') != 'reject']
        if designs:
            roles.append({**{k: role.get(k, '') for k in ('role', 'label', 'when', 'avoid')},
                          'used_in_case': case_roles.get(role['role'], {}).get('used_in_case', []), 'designs': designs})
    return {'designs_file': str(designs_path(path)), 'roles': roles,
            'counts': {s: sum(1 for d in data['designs'] if d.get('status', 'open') == s) for s in STATES}}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest='cmd', required=True)
    r = sub.add_parser('render')
    r.add_argument('case', type=Path)
    r.add_argument('--plan', type=Path, required=True)
    r.add_argument('--emphasis', type=Path)
    sub.add_parser('adopted')
    s = sub.add_parser('style')
    s.add_argument('id')
    args = ap.parse_args()
    if args.cmd == 'render':
        out, n = render_case(args.case.resolve(), args.plan, args.emphasis)
        print(json.dumps({'catalog': str(out), 'designs': n}, ensure_ascii=False))
    elif args.cmd == 'adopted':
        print(json.dumps({r: [{'id': d['id'], 'name': d['name']} for d in ds] for r, ds in adopted().items()},
                         ensure_ascii=False, indent=1))
    else:
        d = next((d for d in load()['designs'] if d['id'] == args.id), None)
        if not d:
            raise SystemExit(f'no design {args.id}')
        print(json.dumps({'id': d['id'], 'role': d['role'], 'status': d.get('status'), 'style': style_of(d)},
                         ensure_ascii=False, indent=1))


if __name__ == '__main__':
    main()
