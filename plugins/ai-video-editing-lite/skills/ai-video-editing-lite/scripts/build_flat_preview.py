#!/usr/bin/env python3
"""Add a light "flat" video to a built review preview, so the page plays ONE stream instead of many.

Why (2026-10-21: on MIRU the review felt heavy and stuttered): the page composites the edit live
from proxies. A 35-minute talk has ~900 cuts, so the camera, the screen recording and the circle wipe each seek
every ~2 s; over the network every seek is a new range request, and five 720p decoders run at once.

The flat video bakes everything the review page cannot change into one small H.264 (default 960x540, short GOP):
the cut camera with its push-ins, screen recordings, wipes, frames, headers, small QR, separators, the avan and
name cards. What the reviewer edits stays live on top, as before: captions (normal / emphasis / Point), the large
QR and its blurred backdrop, and a past video's thumbnail with its backdrop. The page follows the flat video while
the timeline is the one it was made from; after a cut is changed on the page it maps every clip back to the flat
video by source time, and only footage the flat video does not hold (a restored cut) is drawn live from proxies.

  build_flat_preview.py <case> --name v3 [--scale 0.5] [--crf 30] [--jobs 8]

Run after build_review_preview.py (same --name). Updates the preview's manifest.json (flat, layers[].baked) and
files.json (key f0000). The full render is cached by content (render_offline.py cache), so an unchanged plan is
not rendered again."""
import argparse
import json
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import render_offline as ro  # noqa: E402

LIVE_IDS = ('qr-q', 'qrbg-', 'thumb')       # large QR, its blurred backdrop, a past video's thumbnail (+ backdrop)


def live(layer):
    # headers and the small QR stay live too: they step aside while a large QR shows, and the large QR can be moved
    # on the page (2026-10-21)
    return layer.get('role') in ('caption', 'header', 'small_qr') or str(layer.get('id', '')).startswith(LIVE_IDS)


def flat_plan(plan, scale):
    from PIL import Image
    p = json.loads(json.dumps(plan, ensure_ascii=False))
    p['layers'] = [L for L in p['layers'] if not live(L)]
    for k in ('caption_policy', 'channel', 'review_edits', 'susume_segments', 'qr_backdrop'):
        p.pop(k, None)
    p['audio'] = []
    for c in p['clips']:
        c['mute'] = True
    p['width'], p['height'] = round(plan['width'] * scale / 2) * 2, round(plan['height'] * scale / 2) * 2
    p['crf'] = 20
    for L in p['layers']:
        if L['type'] == 'image' and 'width' not in L and 'height' not in L:
            w, h = Image.open(L['path']).size
            L['width'], L['height'] = w, h
        for f in ('x', 'y', 'width', 'height', 'ring_width'):
            if isinstance(L.get(f), (int, float)):
                L[f] = max(1, round(L[f] * scale)) if f in ('width', 'height') else round(L[f] * scale)
        for kf in L.get('keyframes', []):
            for f in ('x', 'y', 'width', 'height'):
                if isinstance(kf.get(f), (int, float)):
                    kf[f] = round(kf[f] * scale)
    return p


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('case', type=Path)
    ap.add_argument('--name', required=True, help='the preview built by build_review_preview.py')
    ap.add_argument('--scale', type=float, default=0.5, help='0.5 = 960x540 for a 1080p plan')
    ap.add_argument('--crf', type=int, default=30)
    ap.add_argument('--jobs', type=int, default=8)
    a = ap.parse_args()
    case = a.case.resolve()
    pdir = case / '.akari/preview' / a.name
    manifest = json.loads((pdir / 'manifest.json').read_text(encoding='utf-8'))
    files = json.loads((pdir / 'files.json').read_text(encoding='utf-8'))
    plan = json.loads(Path(manifest['plan']).read_text(encoding='utf-8'))
    ro.resolve_plan_fonts(plan)
    fp = flat_plan(plan, a.scale)
    work = case / '.akari/cache/preview-flat'
    work.mkdir(parents=True, exist_ok=True)
    fpath = work / f'plan-{a.name}.json'
    fpath.write_text(json.dumps(fp, ensure_ascii=False), encoding='utf-8')
    raw = work / f'raw-{a.name}.mp4'
    subprocess.run([sys.executable, str(Path(__file__).resolve().parent / 'render_offline.py'), str(fpath),
                    '--output', str(raw), '--jobs', str(max(1, min(8, a.jobs)))], check=True)
    out = work / f'flat-{a.name}.mp4'
    tmp = out.with_name(f'.tmp-{out.name}')
    # short GOP, no B-frames: every cut on the page can be reached quickly; faststart: plays while it downloads
    subprocess.run(['ffmpeg', '-v', 'error', '-nostdin', '-y', '-i', str(raw), '-an', '-c:v', 'libx264', '-preset', 'veryfast',
                    '-tune', 'fastdecode', '-crf', str(a.crf), '-g', '15', '-bf', '0', '-pix_fmt', 'yuv420p',
                    '-movflags', '+faststart', str(tmp)], check=True)
    tmp.replace(out)
    raw.unlink(missing_ok=True)
    key = 'f0000'
    files[key] = str(out)
    manifest.setdefault('media', {})[key] = {'kind': 'flat', 'src_w': fp['width'], 'src_h': fp['height']}
    manifest['flat'] = {
        'media': key, 'width': fp['width'], 'height': fp['height'],
        # the clips of the timeline the flat video was made from: the page maps any later timeline back by source time
        'segments': [{'start': c['start'], 'end': c['end'], 'media': c['media'], 'src': c['src']} for c in manifest['clips']],
        'live': 'captions, headers, small QR, large QR (+ backdrop), past-video thumbnail (+ backdrop)',
    }
    for L in manifest['layers']:
        if live(L):
            L.pop('baked', None)
        else:
            L['baked'] = True
    (pdir / 'files.json').write_text(json.dumps(files, ensure_ascii=False), encoding='utf-8')
    (pdir / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False), encoding='utf-8')
    print(json.dumps({'flat': str(out), 'bytes': out.stat().st_size, 'size': f"{fp['width']}x{fp['height']}",
                      'baked_layers': sum(1 for L in manifest['layers'] if L.get('baked')),
                      'live_layers': sum(1 for L in manifest['layers'] if not L.get('baked'))}, ensure_ascii=False))


if __name__ == '__main__':
    main()
