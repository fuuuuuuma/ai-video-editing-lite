#!/usr/bin/env python3
"""Draw a caption the way the case's export draws it, from <case>/planning/caption-style.json.

The review page uses it so a caption retyped on the page shows as the real caption image
(same font, edge, glow and placement as the export), and review_edits.py uses it to bake
retyped / added captions into the plan for the export.

caption-style.json (written by the case's plan builder; schema review/caption-style-v1):
  normal      {"K": text item, "S": text item}   styled_text.make_text_image items without "text"
  normal_place  {"one_line_top": 941, "two_line_bottom": 1026, "center_x": 960, "max_width": 1800}
                1 line: the top of the white glyphs at one_line_top; 2 lines: their bottom at two_line_bottom
  emphasis    {role: text item}                  the role's font / fill / strokes / shadows
  emphasis_place {"bottom": 1050, "min_top": 650, "center_x": 960, "max_width": 1800, "max_size": 210,
                  "spacing_ratio": 0.08, "padding": 6}
                glyph box bottom at `bottom`; shrunk until the visible top (glow) is below min_top

  caption_style.py <case> render --kind normal --speaker K --text '...' [--out x.png]
"""
import argparse
import hashlib
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
from styled_text import make_text_image  # noqa: E402

SCHEMA = 'review/caption-style-v1'


def path_of(case):
    return Path(case).resolve() / 'planning/caption-style.json'


def load(case):
    p = path_of(case)
    return json.loads(p.read_text(encoding='utf-8')) if p.exists() else None


def _glyph_box(im):
    a = np.asarray(im)
    ys, xs = np.nonzero(a[:, :, 3] > 200)
    return xs.min(), ys.min(), xs.max(), ys.max()


def _normal(style, text, speaker):
    item = {**style['normal'][speaker if speaker in style['normal'] else 'K'], 'text': text}
    try:
        im = make_text_image(item)
    except ValueError:      # palt shaping can fail on some Latin/digit runs: the export draws those without palt
        im = make_text_image({**item, 'proportional_spacing': False})
    pl = style.get('normal_place', {})
    a = np.asarray(im)
    white = (a[:, :, :3].min(2) > 235) & (a[:, :, 3] > 200)
    ys, xs = np.nonzero(white)
    if not len(xs):
        raise ValueError('caption has no visible glyphs')
    if xs.max() - xs.min() > pl.get('max_width', 1800):
        raise ValueError('caption too wide for one line; split it into 2 lines')
    x = pl.get('center_x', 960) - (int(xs.min()) + int(xs.max())) // 2
    y = (pl.get('one_line_top', 941) - int(ys.min())) if '\n' not in text else (pl.get('two_line_bottom', 1026) - int(ys.max()))
    return im, x, y


def _emphasis(style, text, role):
    st = style['emphasis'].get(role) or next(iter(style['emphasis'].values()))
    pl = style.get('emphasis_place', {})

    def render(size):
        item = {**st, 'font_size': size, 'text': text, 'padding': pl.get('padding', 6),
                'spacing': int(size * pl.get('spacing_ratio', 0.08))}
        return make_text_image(item)

    size = pl.get('max_size', 210)
    im = render(size)
    x0, _, x1, _ = _glyph_box(im)
    if x1 - x0 > pl.get('max_width', 1800):
        size = int(size * pl.get('max_width', 1800) / (x1 - x0)) - 1
        im = render(size)
    bottom, min_top = pl.get('bottom', 1050), pl.get('min_top', 650)
    x0, y0, x1, y1 = _glyph_box(im)
    top = bottom - y1 + im.getbbox()[1]
    if top < min_top:
        k = (bottom - min_top) / (bottom - top)
        im = im.resize((round(im.width * k), round(im.height * k)), Image.LANCZOS)
        x0, y0, x1, y1 = _glyph_box(im)
    return im, pl.get('center_x', 960) - (int(x0) + int(x1)) // 2, bottom - int(y1)


def render(style, kind, text, speaker=None, role=None, cache_dir=None):
    """(png path, x, y) of a caption drawn like the export. Cached by its inputs."""
    key = json.dumps([SCHEMA, style, kind, text, speaker, role], ensure_ascii=False, sort_keys=True)
    h = hashlib.sha256(key.encode()).hexdigest()[:20]
    cache = Path(cache_dir)
    cache.mkdir(parents=True, exist_ok=True)
    png, meta = cache / f'{h}.png', cache / f'{h}.json'
    if png.exists() and meta.exists():
        m = json.loads(meta.read_text())
        return png, m['x'], m['y']
    im, x, y = _emphasis(style, text, role) if kind == 'emphasis' else _normal(style, text, speaker)
    im.save(png)
    meta.write_text(json.dumps({'x': int(x), 'y': int(y)}))
    return png, int(x), int(y)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('case', type=Path)
    sub = ap.add_subparsers(dest='cmd', required=True)
    r = sub.add_parser('render')
    r.add_argument('--kind', choices=('normal', 'emphasis'), default='normal')
    r.add_argument('--speaker', default='K')
    r.add_argument('--role')
    r.add_argument('--text', required=True)
    args = ap.parse_args()
    style = load(args.case)
    if not style:
        raise SystemExit(f'no {path_of(args.case)}')
    png, x, y = render(style, args.kind, args.text.replace('\\n', '\n'), args.speaker, args.role,
                       args.case.resolve() / '.akari/cache/caption-edit-png')
    print(json.dumps({'png': str(png), 'x': x, 'y': y}, ensure_ascii=False))


if __name__ == '__main__':
    main()
