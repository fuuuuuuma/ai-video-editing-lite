"""Portable RGBA text with explicit fill stops, outline layers and shadows.

Pixel parameters belong to this renderer. Premiere shadow size/blur/angle are
not silently converted; calibrate those values against the reference first.
"""
import math
from functools import lru_cache
from pathlib import Path
import sys
import unicodedata
import numpy as np
from PIL import Image, ImageColor, ImageDraw, ImageFilter, ImageFont
from fonts import resolve as resolve_font


def _color(value):
    return ImageColor.getcolor(value, 'RGBA')


def _paint(mask, color):
    rgba = _color(color)
    out = Image.new('RGBA', mask.size, rgba)
    out.putalpha(mask.point(lambda a: round(a * rgba[3] / 255)))
    return out


def _expand(mask, radius):
    radius = int(math.ceil(radius))
    return mask.filter(ImageFilter.MaxFilter(2*radius+1)) if radius else mask.copy()


@lru_cache(maxsize=24)
def _shaping_font(path, index, size):
    try:
        import uharfbuzz as hb
    except ImportError:
        runtime = Path(__file__).resolve().parents[1]/'.runtime/python'
        if str(runtime) not in sys.path:
            sys.path.insert(0, str(runtime))
        try:
            import uharfbuzz as hb
        except ImportError as error:
            raise ValueError('Proportional spacing requires uharfbuzz; see requirements-shaping.txt') from error
    font = hb.Font(hb.Face(Path(path).read_bytes(), index))
    font.scale = (size*64, size*64)
    return hb, font


def _proportional_layout(item, font):
    hb, hbfont = _shaping_font(item['font'], item.get('font_index', 0), item['font_size'])
    lines = []
    for line in unicodedata.normalize('NFC', item['text']).split('\n'):
        buffer = hb.Buffer()
        buffer.add_codepoints([ord(c) for c in line])
        buffer.guess_segment_properties()
        hb.shape(hbfont, buffer, {'palt': 1, 'liga': 0, 'clig': 0})
        if [g.cluster for g in buffer.glyph_infos] != list(range(len(line))):
            raise ValueError('This shaped text needs a glyph renderer; do not substitute unshaped text')
        glyphs, x = [], 0
        for char, info, pos in zip(line, buffer.glyph_infos, buffer.glyph_positions):
            if hbfont.get_nominal_glyph(ord(char)) != info.codepoint:
                raise ValueError('Alternate glyph requires a glyph renderer')
            glyphs.append((char, x+pos.x_offset/64, -pos.y_offset/64))
            x += pos.x_advance/64 + item.get('tracking_px', 0)
        lines.append((glyphs, x-item.get('tracking_px', 0) if line else 0))
    width = max((x[1] for x in lines), default=0)
    placed = [(char, x+(width-line_width)/2, y+i*(item['font_size']+item.get('spacing', 8)))
              for i, (glyphs, line_width) in enumerate(lines) for char, x, y in glyphs]
    boxes = [(x+b[0], y+b[1], x+b[2], y+b[3])
             for char, x, y in placed for b in [font.getbbox(char, anchor='ls')]]
    if not boxes:
        raise ValueError('Empty text')
    box = (math.floor(min(b[0] for b in boxes)), math.floor(min(b[1] for b in boxes)),
           math.ceil(max(b[2] for b in boxes)), math.ceil(max(b[3] for b in boxes)))
    return placed, box


def make_text_image(item):
    if item.get('font_sha256'):
        # Relocates renumbered Adobe Fonts files; a differing file still raises.
        item = {**item, 'font': str(resolve_font(item['font'], item['font_sha256']))}
    font = ImageFont.truetype(item['font'], item['font_size'], index=item.get('font_index', 0))
    text, spacing = item['text'], item.get('spacing', 8)
    strokes = item.get('strokes', [])
    if not strokes and item.get('stroke_width', 0):
        strokes = [{'width': item['stroke_width'], 'color': item.get('stroke_color', 'black')}]
    strokes = [s for s in strokes if s.get('enabled', True)]
    shadows = [s for s in item.get('shadows', []) if s.get('enabled', True)]
    max_stroke = max((s['width'] for s in strokes), default=0)
    # Reserve the effect extent so glow/shadows are not clipped at the glyph box.
    effect_pad = max([max_stroke] + [max_stroke + s.get('spread', 0) +
        3*s.get('blur', 0) + max(abs(s.get('dx', 0)), abs(s.get('dy', 0))) for s in shadows])
    pad = math.ceil(effect_pad) + item.get('padding', 8)
    draw = ImageDraw.Draw(Image.new('L', (1, 1)))
    placed = None
    if item.get('proportional_spacing'):
        placed, box = _proportional_layout(item, font)
    else:
        if item.get('tracking_px'):
            raise ValueError('tracking_px requires proportional_spacing layout')
        box = draw.multiline_textbbox((0, 0), text, font=font, spacing=spacing, align='center')
        lines = text.split('\n')
        widths = [draw.textlength(line, font=font) for line in lines]
        advance = draw.textbbox((0, 0), 'A', font=font)[3] + spacing
        line_origins = [(line, (max(widths)-width)/2, i*advance)
                        for i, (line, width) in enumerate(zip(lines, widths))]

    def paint_glyphs(target, stroke=0):
        painter = ImageDraw.Draw(target)
        if placed is None:
            # Keep line origins independent of outline width. Pillow's multiline
            # stroke layout adds 2*stroke_width to each subsequent line advance.
            for line, x, y in line_origins:
                painter.text((pad-box[0]+x, pad-box[1]+y), line, font=font,
                             fill=255, stroke_width=stroke, stroke_fill=255)
        else:
            for char, x, y in placed:
                painter.text((x+pad-box[0], y+pad-box[1]), char, anchor='ls', font=font,
                             fill=255, stroke_width=stroke, stroke_fill=255)
    mask = Image.new('L', (math.ceil(box[2]-box[0])+2*pad, math.ceil(box[3]-box[1])+2*pad))
    paint_glyphs(mask)
    out = Image.new('RGBA', mask.size, _color(item.get('background', '#00000000')))
    for shadow in reversed(shadows):  # First listed effect is nearest the glyph.
        alpha = _expand(mask, max_stroke + shadow.get('spread', 0))
        alpha = alpha.filter(ImageFilter.GaussianBlur(shadow.get('blur', 0)))
        opacity = shadow.get('opacity', 1)
        if not 0 <= opacity <= 1:
            raise ValueError('Shadow opacity must be in [0,1]')
        alpha = alpha.point(lambda x: round(x*opacity))
        out.alpha_composite(_paint(alpha, shadow['color']),
                            (round(shadow.get('dx', 0)), round(shadow.get('dy', 0))))
    for stroke in sorted(strokes, key=lambda s: s['width'], reverse=True):
        if stroke['width'] < 0:
            raise ValueError('Negative outline width')
        # Pillow's text stroke follows the glyph outline; morphological spread
        # is reserved for shadows and must not turn round outlines into squares.
        outline = Image.new('L', mask.size)
        paint_glyphs(outline, round(stroke['width']))
        out.alpha_composite(_paint(outline, stroke['color']))
    gradient = item.get('fill_gradient')
    if gradient:
        stops = gradient['stops']
        positions = [s['position'] for s in stops]
        if len(stops) < 2 or positions != sorted(set(positions)) or not 0 <= positions[0] < positions[-1] <= 1:
            raise ValueError('Gradient requires ordered distinct stops within [0,1]')
        if gradient.get('axis', 'vertical') not in ('vertical', 'horizontal'):
            raise ValueError('Only explicit vertical/horizontal gradients supported')
        vertical = gradient.get('axis', 'vertical') == 'vertical'
        length = mask.height if vertical else mask.width
        glyph_length = length-2*pad
        t = np.clip((np.arange(length)-pad)/max(1, glyph_length-1), 0, 1)
        colors = np.array([_color(s['color']) for s in stops])
        ramp = np.stack([np.interp(t, positions, colors[:, c]) for c in range(4)], axis=-1)
        pixels = np.broadcast_to(ramp[:, None, :] if vertical else ramp[None, :, :],
                                 (mask.height, mask.width, 4)).copy()
        pixels[:, :, 3] *= np.asarray(mask)/255
        fill = Image.fromarray(np.rint(pixels).astype('uint8'))
    else:
        fill = _paint(mask, item.get('color', 'white'))
    out.alpha_composite(fill)
    sx, sy = item.get('text_scale_x', 1), item.get('text_scale_y', 1)
    if not 0 < sx <= 10 or not 0 < sy <= 10:
        raise ValueError('Text scales must be in (0,10]')
    if sx != 1 or sy != 1:
        out = out.resize((round(out.width*sx), round(out.height*sy)), Image.Resampling.LANCZOS)
    return out
