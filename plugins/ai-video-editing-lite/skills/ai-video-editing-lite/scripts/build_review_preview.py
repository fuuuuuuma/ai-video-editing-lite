#!/usr/bin/env python3
"""Build a browser review preview from a render plan, without exporting the MP4.

The browser composites the edit live from the plan: light video proxies for every
source video, the plan's own PNG layers, and one pre-mixed audio track that is the
playback clock. Only the audio mix and missing proxies are computed; the full export
is done later with render_offline.py once the reviewer approves.

Output (inside the case folder):
  .akari/preview/<name>/manifest.json   what the review page reads
  .akari/preview/<name>/files.json      media key -> absolute path (server allowlist)
  .akari/preview/<name>/text/*.png      text layers pre-rendered with the export renderer
  .akari/cache/preview-proxies/*.mp4     reusable video proxies (keyed by file identity)
  .akari/cache/preview-audio/*.m4a       reusable audio mixes (keyed by the audio inputs)

Open the page with review_server.py.
"""
import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import render_offline as ro  # noqa: E402

PROXY_HEIGHT = 720
SCHEMA = 'ai-video-editing-lite/review-preview-v1'
LAYER_FIELDS = ('id', 'type', 'start', 'end', 'x', 'y', 'width', 'height', 'opacity', 'scale', 'keyframes',
                'role', 'caption_id', 'caption_kind', 'speaker', 'text', 'emphasis_role', 'mask',
                'ring_width', 'ring_color', 'source_crop', 'color')


def file_identity(path):
    st = Path(path).stat()
    return f'{Path(path).resolve()}|{st.st_size}|{st.st_mtime_ns}'


def short_hash(text, n=20):
    return hashlib.sha256(text.encode('utf-8')).hexdigest()[:n]


def make_proxy(src, cache_dir, height=PROXY_HEIGHT, log=None):
    """Short-GOP H.264 proxy without audio, so the browser can seek every cut quickly."""
    key = short_hash(f'{file_identity(src)}|h{height}|proxy-v1')
    out = cache_dir / f'{key}.mp4'
    if out.exists() and out.stat().st_size > 0:
        return out, True
    tmp = out.with_name(f'.tmp-{key}-{os.getpid()}.mp4')
    subprocess.run(['ffmpeg', '-v', 'error', '-nostdin', '-y', '-i', str(src), '-an',
                    '-vf', f'scale=-2:{height}:flags=bilinear,format=yuv420p',
                    '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'fastdecode', '-crf', '24',
                    '-g', '15', '-bf', '0', '-movflags', '+faststart', str(tmp)],
                   check=True, stderr=log)
    tmp.replace(out)
    return out, False


def audio_key(plan):
    used = [c['path'] for c in plan['clips'] if not c.get('mute')] + [a['path'] for a in plan.get('audio', [])]
    relevant = {
        'fps': str(plan['fps']), 'frames': plan['frames'], 'master': plan.get('master_gain_db', 0),
        'clips': [{k: c.get(k) for k in ('path', 'source_start_seconds', 'start', 'end', 'mute', 'gain_db',
                                         'fade_in_frames', 'fade_out_frames', 'keyframes')} for c in plan['clips']],
        'audio': plan.get('audio', []),
        'files': sorted({file_identity(p) for p in used}),
        'engine': ro.RENDER_VERSION,
    }
    return short_hash(json.dumps(relevant, ensure_ascii=False, sort_keys=True))


def build_audio(plan, fps, media, cache_dir, work):
    """The same mix the export uses (render_offline.audio_mix), encoded once as AAC."""
    key = audio_key(plan)
    out = cache_dir / f'{key}.m4a'
    if out.exists() and out.stat().st_size > 0:
        return out, True
    job = work / f'audio-{key}'
    job.mkdir(parents=True, exist_ok=True)
    mix, _ = ro.audio_mix(plan, fps, media, job)
    tmp = out.with_name(f'.tmp-{key}-{os.getpid()}.m4a')
    subprocess.run(['ffmpeg', '-v', 'error', '-nostdin', '-y', '-f', 'f32le', '-ar', str(ro.RATE), '-ac', '2',
                    '-i', str(mix), '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', str(tmp)], check=True)
    tmp.replace(out)
    shutil.rmtree(job, ignore_errors=True)
    return out, False


def video_dims(meta):
    v = next(s for s in meta['streams'] if s['codec_type'] == 'video')
    w, h = int(v['width']), int(v['height'])
    for sd in v.get('side_data_list', []) or []:
        if abs(int(sd.get('rotation', 0))) in (90, 270):
            w, h = h, w
    return w, h


def marks_from(plan, plan_path=None):
    """Timeline marks read from the plan itself, so they always match what plays (2026-10-19: marks taken from
    timeline-<name>.json drifted by up to a minute once edits made on the review page were applied to the plan).
    Emphasis / Point captions, screen recordings (their frame layer), large QR, CM, separators, a past video's
    thumbnail and the end card."""
    marks = []
    for l in plan.get('layers', []):
        lid = str(l.get('id', ''))
        if l.get('caption_kind') == 'emphasis':
            marks.append({'kind': 'emphasis', 'start': l['start'], 'end': l['end'], 'label': l.get('text', '')})
        elif l.get('caption_kind') == 'point':
            marks.append({'kind': 'point', 'start': l['start'], 'end': l['end'], 'label': 'Point ' + l.get('text', '')})
        elif lid.startswith('frame-s'):
            marks.append({'kind': 'screen', 'start': l['start'], 'end': l['end'], 'label': lid[len('frame-'):]})
        elif lid.startswith('sep'):
            marks.append({'kind': 'separator', 'start': l['start'], 'end': l['end'], 'label': '区切り'})
        elif lid.startswith('thumb-') and l.get('type') == 'image':
            marks.append({'kind': 'thumbnail', 'start': l['start'], 'end': l['end'], 'label': '過去動画のサムネ'})
    for s in plan.get('susume_segments', []):
        if s.get('kind') == 'large_qr':
            marks.append({'kind': 'qr', 'start': s['start'], 'end': s['end'], 'label': '大型QR'})
        elif s.get('kind') == 'end_card':
            marks.append({'kind': 'end_card', 'start': s['start'], 'end': s['end'], 'label': 'エンドカード'})
    for c in plan.get('clips', []):
        if 'CM' in Path(c['path']).stem:
            marks.append({'kind': 'cm', 'start': c['start'], 'end': c['end'], 'label': '独立CM'})
    marks.sort(key=lambda m: (m['start'], m['end']))
    return marks


def build(case, plan_path, name, height=PROXY_HEIGHT, jobs=3):
    case = Path(case).resolve()
    plan_path = Path(plan_path).resolve()
    plan = json.loads(plan_path.read_text(encoding='utf-8'))
    ro.resolve_plan_fonts(plan)
    fps, media = ro.validate(plan)   # same checks as the export (caption gaps, sources)
    out_dir = case / '.akari/preview' / name
    (out_dir / 'text').mkdir(parents=True, exist_ok=True)
    proxy_cache = case / '.akari/cache/preview-proxies'
    audio_cache = case / '.akari/cache/preview-audio'
    proxy_cache.mkdir(parents=True, exist_ok=True)
    audio_cache.mkdir(parents=True, exist_ok=True)
    started = time.monotonic()

    files, table = {}, {}

    def register(path, kind, extra=None):
        path = str(Path(path).resolve())
        if path not in files:
            key = f'{kind[0]}{len(files):04d}'
            files[path] = key
            table[key] = {'kind': kind, 'path': path, **(extra or {})}
        return files[path]

    sources = sorted({str(Path(c['path']).resolve()) for c in plan['clips']} |
                     {str(Path(l['path']).resolve()) for l in plan.get('layers', []) if l['type'] == 'video'})
    with open(out_dir / 'proxy.log', 'w') as log, ThreadPoolExecutor(max_workers=max(1, jobs)) as pool:
        made = dict(zip(sources, pool.map(lambda p: make_proxy(p, proxy_cache, height, log), sources)))
    video_key = {}
    for src in sources:
        sw, sh = video_dims(media.get(src) or ro.probe(src))
        proxy, cached = made[src]
        pw, ph = video_dims(ro.probe(proxy))
        video_key[src] = register(proxy, 'video', {'source': src, 'src_w': sw, 'src_h': sh,
                                                   'proxy_w': pw, 'proxy_h': ph, 'proxy_cached': cached})

    audio_path, audio_cached = build_audio(plan, fps, media, audio_cache, out_dir)
    audio = register(audio_path, 'audio', {'cached': audio_cached})

    clips = [{'i': i, 'media': video_key[str(Path(c['path']).resolve())], 'src': float(c.get('source_start_seconds', 0)),
              'start': c['start'], 'end': c['end'], 'source_name': Path(c['path']).name}
             for i, c in enumerate(plan['clips'])]
    layers = []
    for i, l in enumerate(plan.get('layers', [])):
        item = {k: l[k] for k in LAYER_FIELDS if k in l}
        item['i'] = i
        if l['type'] == 'image':
            item['media'] = register(l['path'], 'image')
        elif l['type'] == 'video':
            item['media'] = video_key[str(Path(l['path']).resolve())]
            item['src'] = float(l.get('source_start_seconds', 0))
        elif l['type'] == 'text':   # draw with the export renderer so the preview matches
            png = out_dir / 'text' / f"{short_hash(json.dumps(l, ensure_ascii=False, sort_keys=True), 16)}.png"
            if not png.exists():
                from PIL import Image
                Image.fromarray(ro.make_layer(l)).save(png)
            item.update(type='image', media=register(png, 'image'))
            item.pop('width', None)
            item.pop('height', None)
        layers.append(item)

    manifest = {
        'schema': SCHEMA, 'name': name, 'built_at': time.strftime('%Y-%m-%dT%H:%M:%S%z'),
        'plan': str(plan_path), 'plan_sha256': ro.sha256_file(plan_path), 'case': str(case),
        'fps': str(fps), 'fps_num': fps.numerator, 'fps_den': fps.denominator,
        'frames': plan['frames'], 'width': plan['width'], 'height': plan['height'],
        'audio': audio, 'clips': clips, 'camera': plan.get('camera', []), 'layers': layers,
        'marks': marks_from(plan, plan_path),
        'speakers': plan.get('speakers') or {'K': '本人', 'S': '相手'},   # 確認画面の話し手の呼び名
        'media': {k: {kk: vv for kk, vv in v.items() if kk not in ('path', 'source')} for k, v in table.items()},
        'note': 'Review preview composited live in the browser from the plan. Video is a proxy; '
                'PNG layers and the audio mix are the same inputs the export uses. Not the deliverable.',
        'stats': {'seconds': round(time.monotonic() - started, 1), 'video_sources': len(sources),
                  'proxies_reused': sum(1 for p, c in made.values() if c), 'audio_reused': audio_cached},
    }
    (out_dir / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False), encoding='utf-8')
    (out_dir / 'files.json').write_text(json.dumps({k: v['path'] for k, v in table.items()}, ensure_ascii=False),
                                        encoding='utf-8')
    return out_dir, manifest


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('case', type=Path, help='case folder (case.py new)')
    ap.add_argument('--plan', type=Path, required=True, help='render-plan JSON to preview')
    ap.add_argument('--name', help='preview name (default: render-plan-v2.json -> v2)')
    ap.add_argument('--proxy-height', type=int, default=PROXY_HEIGHT)
    ap.add_argument('--jobs', type=int, default=3, help='parallel proxy encodes (1..6)')
    args = ap.parse_args()
    name = args.name or args.plan.stem.replace('render-plan-', '').replace('render-plan', 'current')
    out_dir, manifest = build(args.case, args.plan, name, args.proxy_height, max(1, min(6, args.jobs)))
    print(json.dumps({'preview': str(out_dir), 'name': name, 'frames': manifest['frames'],
                      'stats': manifest['stats']}, ensure_ascii=False))


if __name__ == '__main__':
    main()
