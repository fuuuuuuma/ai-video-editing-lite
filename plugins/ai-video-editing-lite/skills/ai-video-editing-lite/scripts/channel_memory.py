#!/usr/bin/env python3
"""The channels this skill has learned: register, switch, read and update their style and standing rules.

  channel_memory.py add --name "〇〇チャンネル" [--slug my-ch] [--youtube URL] [--prproj P] [--mp4 M]
  channel_memory.py list                       # registered channels (* = current)
  channel_memory.py use <slug>                 # switch the current channel
  channel_memory.py show [<slug>]              # the profile (style, rules, sources) as JSON
  channel_memory.py set-style --file style.json [--slug s]
                   # merge a learned style (same shape as assets/style-default.json) into the profile;
                   # its "designs" go to designs.json, keeping adopt / reject already decided by the reviewer
  channel_memory.py rule "テロップは1行18文字まで" [--slug s]   # a standing rule kept for every next video
  channel_memory.py sample --out sample.jpg [--frame camera.jpg] [--slug s]
                   # one picture: the normal caption and every adopted emphasis design (to confirm the learned style)

Everything is kept under ~/.ai-video-editing-lite (lite.py). Nothing is sent anywhere.
"""
import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import lite  # noqa: E402

DEFAULT = lite.SKILL / 'assets/style-default.json'


def default_style():
    return json.loads(DEFAULT.read_text(encoding='utf-8'))


def merge(a, b):
    """b over a, recursively for objects; lists and values are replaced."""
    if isinstance(a, dict) and isinstance(b, dict):
        out = dict(a)
        for k, v in b.items():
            out[k] = merge(a.get(k), v) if k in a else v
        return out
    return b


def write_designs(slug, style):
    """designs.json for the review page and the plan builder (emphasis_catalog.py reads it)."""
    path = lite.designs_file(slug)
    old = {d['id']: d for d in (lite.read_json(path, {}) or {}).get('designs', [])}
    designs = []
    for d in style.get('designs', []):
        prev = old.get(d['id'])
        keep = prev and prev.get('status') != d.get('status', 'open') and prev.get('decided_at')
        designs.append({**d, **({'status': prev['status'], 'memo': prev.get('memo', ''), 'decided_at': prev['decided_at']} if keep else {})})
    lite.write_json(path, {'schema': 'ai-video-editing-lite/emphasis-designs-v1', 'channel': slug, 'updated_at': lite.now(),
                           'roles': style.get('roles', []), 'designs': designs})
    return len(designs)


def cmd_add(a):
    slug = a.slug or lite.slugify(a.name)
    d = lite.CHANNELS / slug
    if (d / 'channel.json').exists():
        raise SystemExit(f'{slug} はもう登録されています（use {slug} で切り替え、set-style で学習を足す）')
    style = default_style()
    prof = {'schema': lite.SCHEMA, 'name': a.name, 'slug': slug, 'created_at': lite.now(), 'updated_at': lite.now(),
            'sources': {'youtube': a.youtube or [], 'prproj': [str(Path(p).expanduser()) for p in a.prproj or []],
                        'mp4': [str(Path(p).expanduser()) for p in a.mp4 or []]},
            'learned': False, 'style': {k: v for k, v in style.items() if k not in ('designs', 'note', 'schema')}, 'rules': []}
    lite.write_json(d / 'channel.json', prof)
    (d / 'learn').mkdir(parents=True, exist_ok=True)
    lite.write_json(lite.HOME / 'current.json', {'slug': slug})
    write_designs(slug, style)
    print(json.dumps({'slug': slug, 'path': str(d)}, ensure_ascii=False))


def cmd_list(a):
    cur = lite.current_slug()
    rows = []
    for p in sorted(lite.CHANNELS.glob('*/channel.json')) if lite.CHANNELS.exists() else []:
        c = json.loads(p.read_text(encoding='utf-8'))
        rows.append({'slug': c['slug'], 'name': c['name'], 'current': c['slug'] == cur, 'learned': c.get('learned', False),
                     'rules': len(c.get('rules', [])), 'updated_at': c.get('updated_at')})
    print(json.dumps(rows, ensure_ascii=False, indent=1))


def cmd_use(a):
    lite.channel_dir(a.slug)
    lite.write_json(lite.HOME / 'current.json', {'slug': a.slug})
    print(json.dumps({'current': a.slug}, ensure_ascii=False))


def cmd_show(a):
    c = lite.load_channel(a.slug)
    c['designs'] = lite.read_json(lite.designs_file(c['slug']), {}).get('designs', [])
    print(json.dumps(c, ensure_ascii=False, indent=1))


def cmd_set_style(a):
    d = lite.channel_dir(a.slug)
    prof = lite.load_channel(a.slug)
    new = json.loads(Path(a.file).read_text(encoding='utf-8'))
    designs = new.pop('designs', None)
    sources = new.pop('sources', None)
    new.pop('schema', None)
    new.pop('note', None)
    prof['style'] = merge(prof['style'], new)
    if sources:
        for k, v in sources.items():
            prof['sources'][k] = sorted(set(prof['sources'].get(k, [])) | set(v))
    prof['learned'] = True
    prof['updated_at'] = lite.now()
    lite.write_json(d / 'channel.json', prof)
    n = None
    if designs is not None:
        n = write_designs(prof['slug'], {'roles': prof['style'].get('roles', []), 'designs': designs})
    print(json.dumps({'slug': prof['slug'], 'designs': n}, ensure_ascii=False))


def cmd_rule(a):
    d = lite.channel_dir(a.slug)
    prof = lite.load_channel(a.slug)
    prof.setdefault('rules', []).append({'text': a.text, 'at': lite.now()})
    prof['updated_at'] = lite.now()
    lite.write_json(d / 'channel.json', prof)
    print(json.dumps({'rules': len(prof['rules'])}, ensure_ascii=False))


def cmd_sample(a):
    from PIL import Image, ImageDraw
    import make_style
    prof = lite.load_channel(a.slug)
    cap = make_style.caption_style(prof)
    import caption_style
    W, H = prof['style'].get('canvas', {}).get('width', 1920), prof['style'].get('canvas', {}).get('height', 1080)
    if a.frame:
        bg = Image.open(a.frame).convert('RGB').resize((W, H))
    else:
        bg = Image.new('RGB', (W, H), (70, 80, 92))
        dr = ImageDraw.Draw(bg)
        for y in range(H):
            v = int(55 + 60 * y / H)
            dr.line([(0, y), (W, y)], fill=(v, v + 8, v + 18))
    cache = lite.channel_dir(prof['slug']) / 'learn/sample-cache'
    tiles = []
    png, x, y = caption_style.render(cap, 'normal', '通常の字幕はこう出ます', speaker='K', cache_dir=cache)
    tiles.append(('通常の字幕', png, x, y))
    for d in make_style.adopted_designs(prof['slug']):
        one = {**cap, 'emphasis': {d['role']: make_style.resolve_item(d['style'])}}
        png, x, y = caption_style.render(one, 'emphasis', d.get('sample') or d['name'], role=d['role'], cache_dir=cache)
        tiles.append((f"{d['id']} {d['name']}", png, x, y))
    from PIL import ImageFont
    label_font = ImageFont.truetype(lite.font_file('gothic-bold'), 30)
    cols = 2
    rows = (len(tiles) + cols - 1) // cols
    tw, th = W // 2, H // 2
    sheet = Image.new('RGB', (tw * cols, th * rows), (20, 20, 20))
    for i, (label, png, x, y) in enumerate(tiles):
        f = bg.copy().convert('RGBA')
        f.alpha_composite(Image.open(png).convert('RGBA'), (max(0, x), max(0, y)))
        f = f.convert('RGB').resize((tw, th))
        ImageDraw.Draw(f).text((16, 12), label, fill=(255, 255, 255), font=label_font, stroke_width=3, stroke_fill=(0, 0, 0))
        sheet.paste(f, ((i % cols) * tw, (i // cols) * th))
    out = Path(a.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(out, quality=88)
    print(json.dumps({'sample': str(out), 'tiles': len(tiles)}, ensure_ascii=False))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest='cmd', required=True)
    p = sub.add_parser('add')
    p.add_argument('--name', required=True)
    p.add_argument('--slug')
    p.add_argument('--youtube', action='append')
    p.add_argument('--prproj', action='append')
    p.add_argument('--mp4', action='append')
    sub.add_parser('list')
    p = sub.add_parser('use')
    p.add_argument('slug')
    p = sub.add_parser('show')
    p.add_argument('slug', nargs='?')
    p = sub.add_parser('set-style')
    p.add_argument('--file', required=True)
    p.add_argument('--slug')
    p = sub.add_parser('rule')
    p.add_argument('text')
    p.add_argument('--slug')
    p = sub.add_parser('sample')
    p.add_argument('--out', required=True)
    p.add_argument('--frame')
    p.add_argument('--slug')
    a = ap.parse_args()
    {'add': cmd_add, 'list': cmd_list, 'use': cmd_use, 'show': cmd_show, 'set-style': cmd_set_style,
     'rule': cmd_rule, 'sample': cmd_sample}[a.cmd](a)


if __name__ == '__main__':
    main()
