#!/usr/bin/env python3
"""Gather what is needed to learn a channel's editing style. The agent then LOOKS at the contact sheets,
reads the numbers, and writes the style with channel_memory.py set-style (references/learning.md).

  learn.py youtube <channel or video URL> [--videos 4] [--seconds 60] [--slug s]
      lists the channel's recent long videos, downloads a short low-resolution piece of each (480p, for
      analysis on this computer only; nothing is uploaded or shared) and analyses it like an MP4
  learn.py mp4 <finished.mp4> [--start 60] [--seconds 90] [--slug s]
      a finished video on this computer
  learn.py prproj <project.prproj> [--slug s]
      a Premiere project, read as a file (Premiere is never opened): caption fonts / sizes / colours /
      edges and how often each is used, cut length, sound effects and BGM names, effects in use

Output: <memory>/channels/<slug>/learn/<kind>/<name>/ with analysis.json and sheet-NN.jpg
(16 frames each, one per second; the agent reads every sheet before writing the style).
"""
import argparse
import collections
import json
import re
import statistics
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import lite  # noqa: E402


def run(cmd, **kw):
    return subprocess.run(cmd, capture_output=True, text=True, **kw)


def duration(path):
    out = run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', str(path)]).stdout.strip()
    try:
        return float(out)
    except ValueError:
        return 0.0


def contact_sheets(src, out, start, seconds, every=1.0):
    """Frames every `every` seconds, 16 per sheet (4x4 of 480x270), numbered with their time."""
    from PIL import Image, ImageDraw
    frames = out / 'frames'
    frames.mkdir(parents=True, exist_ok=True)
    for f in frames.glob('*.jpg'):
        f.unlink()
    run(['ffmpeg', '-v', 'error', '-nostdin', '-y', '-ss', f'{start:.2f}', '-t', f'{seconds:.2f}', '-i', str(src),
         '-vf', f'fps=1/{every},scale=960:-2', '-q:v', '3', str(frames / '%04d.jpg')], check=True)
    files = sorted(frames.glob('*.jpg'))
    sheets = []
    font = None
    try:
        from PIL import ImageFont
        font = ImageFont.truetype(lite.font_file('gothic-bold'), 22)
    except Exception:
        pass
    for k in range(0, len(files), 16):
        sheet = Image.new('RGB', (1920, 1080), (16, 16, 16))
        for i, f in enumerate(files[k:k + 16]):
            im = Image.open(f).convert('RGB').resize((480, 270))
            t = start + (k + i) * every
            ImageDraw.Draw(im).text((8, 6), f'{int(t // 60)}:{t % 60:04.1f}', fill=(255, 255, 0), font=font, stroke_width=2, stroke_fill=(0, 0, 0))
            sheet.paste(im, ((i % 4) * 480, (i // 4) * 270))
        p = out / f'sheet-{k // 16 + 1:02d}.jpg'
        sheet.save(p, quality=85)
        sheets.append(str(p))
    return sheets, [str(f) for f in files]


def scene_cuts(src, start, seconds):
    r = run(['ffmpeg', '-v', 'info', '-nostdin', '-ss', f'{start:.2f}', '-t', f'{seconds:.2f}', '-i', str(src),
             '-vf', "scale=320:-2,select='gt(scene,0.32)',showinfo", '-an', '-f', 'null', '-'])
    return len(re.findall(r'pts_time:', r.stderr))


def pauses(src, start, seconds):
    """Silences of 0.15 s or more (how tightly the talk is cut) and how much of the time is speech."""
    r = run(['ffmpeg', '-v', 'info', '-nostdin', '-ss', f'{start:.2f}', '-t', f'{seconds:.2f}', '-i', str(src),
             '-af', 'silencedetect=noise=-38dB:d=0.15', '-vn', '-f', 'null', '-'])
    d = [float(x) for x in re.findall(r'silence_duration: ([0-9.]+)', r.stderr)]
    return {'count': len(d), 'per_minute': round(len(d) * 60 / max(1, seconds), 1),
            'median_seconds': round(statistics.median(d), 2) if d else None,
            'longest_seconds': round(max(d), 2) if d else None, 'silent_share': round(sum(d) / max(1, seconds), 3)}


def caption_band(frames):
    """Where bright text with a dark edge sits (rough; the agent confirms on the sheets).
    For each frame: rows of the lower half where many near-white pixels touch dark pixels."""
    import numpy as np
    from PIL import Image
    tops, bottoms, hits, edge_colors = [], [], 0, collections.Counter()
    for f in frames:
        a = np.asarray(Image.open(f).convert('RGB').resize((480, 270))).astype(int)
        white = (a.min(2) > 225)
        dark = (a.max(2) < 90)
        near = np.zeros_like(white)
        near[1:-1, 1:-1] = dark[:-2, 1:-1] | dark[2:, 1:-1] | dark[1:-1, :-2] | dark[1:-1, 2:]
        text = white & near
        rows = text[135:].sum(1)
        good = np.nonzero(rows > 6)[0]
        if len(good) >= 4:
            hits += 1
            tops.append(int(good.min() + 135) * 4)
            bottoms.append(int(good.max() + 135) * 4)
            ys, xs = np.nonzero(text[135:])
            for y, x in list(zip(ys, xs))[::25]:
                for dy, dx in ((-2, 0), (2, 0), (0, -2), (0, 2)):
                    yy, xx = y + 135 + dy, x + dx
                    if 0 <= yy < 270 and 0 <= xx < 480 and not white[yy, xx]:
                        c = a[yy, xx]
                        edge_colors['#%02x%02x%02x' % tuple(int(v) // 32 * 32 for v in c)] += 1
    n = max(1, len(frames))
    return {'frames_with_bottom_text': round(hits / n, 2),
            'text_top_y_1080p': int(statistics.median(tops)) if tops else None,
            'text_bottom_y_1080p': int(statistics.median(bottoms)) if bottoms else None,
            'edge_colors': [c for c, _ in edge_colors.most_common(5)]}


def analyse(src, out, start, seconds, meta=None):
    out.mkdir(parents=True, exist_ok=True)
    total = duration(src)
    seconds = max(5.0, min(seconds, total - start)) if total else seconds
    sheets, frames = contact_sheets(src, out, start, seconds)
    cuts = scene_cuts(src, start, seconds)
    result = {'source': str(src), **(meta or {}), 'start': start, 'seconds': round(seconds, 1),
              'scene_changes_per_minute': round(cuts * 60 / max(1, seconds), 1),
              'pauses': pauses(src, start, seconds), 'caption_band': caption_band(frames),
              'sheets': sheets,
              'look_for': ['通常字幕の位置・書体の太さ・色・縁（何色・何重）・1行の文字数・2行にする条件',
                           '強調テロップ: どんな言葉で出るか・書体・色・大きさ・出し方（寄り・効果音らしき間）',
                           '話者が2人以上いるときの字幕の色分け',
                           'カットの詰め方（言い直し・間の残し方）・画面の寄り引き',
                           '使っていない要素（字幕なし区間・画面収録・BGM の有無）']}
    lite.write_json(out / 'analysis.json', result)
    return result


def cmd_youtube(a, learn):
    url = a.url
    tab = url if re.search(r'(watch\?v=|youtu\.be/|/shorts/|/live/)', url) else url.rstrip('/') + ('' if url.rstrip('/').endswith('/videos') else '/videos')
    ytdlp = [sys.executable, '-I', '-m', 'yt_dlp'] if run([sys.executable, '-I', '-m', 'yt_dlp', '--version']).returncode == 0 else ['yt-dlp']   # -I: files in the current folder must not shadow the standard library
    r = run(ytdlp + ['--flat-playlist', '-J', '--playlist-end', str(max(a.videos * 3, 10)), tab], timeout=300)
    if r.returncode:
        raise SystemExit(f'YouTube の一覧が取れません: {r.stderr.strip()[-300:]}')
    info = json.loads(r.stdout)
    entries = info.get('entries') or [info]
    picked = [e for e in entries if (e.get('duration') or 0) >= 180][:a.videos] or entries[:a.videos]
    base = learn / 'youtube'
    results = []
    for e in picked:
        vid = e.get('id')
        dur = e.get('duration') or 0
        start = max(0, min(dur * 0.3, dur - a.seconds - 5)) if dur else 60
        out = base / vid
        clip = out / 'sample.mp4'
        if not clip.exists():
            out.mkdir(parents=True, exist_ok=True)
            d = run(ytdlp + ['-f', '135+140/134+140/18/bv*[height<=480]+ba/b[height<=480]', '--merge-output-format', 'mp4', '--no-progress',
                             '--download-sections', f'*{start:.0f}-{start + a.seconds:.0f}', '-o', str(clip),
                             f'https://www.youtube.com/watch?v={vid}'], timeout=900)
            if d.returncode or not clip.exists():
                # cutting on YouTube's side sometimes gets 403: take the whole low-resolution video with yt-dlp's own
                # downloader instead, cut the piece here and throw the rest away
                full = out / 'full.mp4'
                d2 = run(ytdlp + ['-f', '18/134+140/135+140/b[height<=480]', '--merge-output-format', 'mp4', '--no-progress',
                                  '--max-filesize', '600M', '-o', str(full), f'https://www.youtube.com/watch?v={vid}'], timeout=1800)
                if not d2.returncode and full.exists():
                    run(['ffmpeg', '-v', 'error', '-nostdin', '-y', '-ss', f'{start:.2f}', '-t', f'{a.seconds:.2f}', '-i', str(full),
                         '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-c:a', 'aac', str(clip)])
                    full.unlink(missing_ok=True)
                if not clip.exists():
                    err = (d2.stderr or d.stderr).strip()[-200:]
                    hint = '（yt-dlp が古いと 403 になります。setup.py をもう一度実行すると新しくなります）' if '403' in err else ''
                    print(f'  取れませんでした: {vid} {err}{hint}', file=sys.stderr)
                    continue
        results.append(analyse(clip, out, 0, a.seconds, {'video_id': vid, 'title': e.get('title'), 'video_seconds': dur, 'from_second': round(start)}))
        print(f"  {vid} {e.get('title', '')[:40]}  シート {len(results[-1]['sheets'])} 枚", flush=True)
    summary = {'kind': 'youtube', 'url': url, 'channel': info.get('channel') or info.get('uploader') or info.get('title'), 'videos': results}
    lite.write_json(base / 'summary.json', summary)
    return summary


def cmd_mp4(a, learn):
    src = Path(a.path).expanduser().resolve()
    out = learn / 'mp4' / lite.slugify(src.stem)
    res = analyse(src, out, a.start, a.seconds, {'title': src.name})
    return {'kind': 'mp4', 'videos': [res]}


def cmd_prproj(a, learn):
    from index_premiere_reference import index_project
    src = Path(a.path).expanduser().resolve()
    out = learn / 'prproj' / lite.slugify(src.stem)
    out.mkdir(parents=True, exist_ok=True)
    idx = index_project(src)
    seq = max(idx['sequences'], key=lambda s: len(s['clips']))
    styles = collections.Counter()
    sample = {}
    for c in seq['clips']:
        for comp in c['components']:
            for p in comp['params']:
                ap = p.get('appearance_raw')
                if not ap:
                    continue
                tp = ap.get('textparam', {})
                runs = tp.get('runs') or [{}]
                st = runs[0].get('style', {})
                key = json.dumps({'fonts': tp.get('fonts'), 'size': st.get('size'), 'fill': st.get('fill'),
                                  'stroke_width': st.get('stroke_width'), 'strokes': st.get('strokes'),
                                  'shadows': tp.get('shadows'), 'background': tp.get('bg_color') if tp.get('bg_opacity') else None},
                                 ensure_ascii=False, sort_keys=True)
                styles[key] += 1
                sample.setdefault(key, []).append(runs[0].get('text', '')[:40])
    text_styles = [{'count': n, **json.loads(k), 'examples': sample[k][:6]} for k, n in styles.most_common(20)]
    v1 = [c['duration'] for c in seq['clips'] if c['kind'] == 'video' and c['track'] == 1]
    sounds = collections.Counter()
    for c in seq['clips']:
        if c['kind'] == 'audio':
            fp = c['source'].get('media_paths', {}).get('FilePath') or ''
            name = re.split(r'[\\/]', fp)[-1]
            if name and not re.search(r'\.(mov|mp4|mxf)$', name, re.I):
                sounds[name] += 1
    effects = collections.Counter(comp['name'] for c in seq['clips'] for comp in c['components'])
    summary = {'kind': 'prproj', 'source': str(src), 'sequence': seq['name'], 'fps': seq.get('fps'), 'frame': seq.get('frame_rect'),
               'clips': len(seq['clips']), 'cut_median_seconds': round(statistics.median(v1), 2) if v1 else None,
               'cuts_on_track1': len(v1), 'text_styles': text_styles, 'sounds': sounds.most_common(30),
               'effects': effects.most_common(20),
               'notes': ['書体名は PostScript 名。手元に無い書体は lite の書体（gothic・mincho など）から近いものを選び、そう記録する',
                         'fill が null のときは白のことが多い（既定値）。完成動画やサムネで確かめる',
                         '位置（モーション）はここでは読んでいない。完成 MP4 か YouTube のコマで確かめる']}
    lite.write_json(out / 'analysis.json', summary)
    return summary


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest='cmd', required=True)
    p = sub.add_parser('youtube')
    p.add_argument('url')
    p.add_argument('--videos', type=int, default=4)
    p.add_argument('--seconds', type=float, default=60)
    p.add_argument('--slug')
    p = sub.add_parser('mp4')
    p.add_argument('path')
    p.add_argument('--start', type=float, default=60)
    p.add_argument('--seconds', type=float, default=90)
    p.add_argument('--slug')
    p = sub.add_parser('prproj')
    p.add_argument('path')
    p.add_argument('--slug')
    a = ap.parse_args()
    learn = lite.channel_dir(a.slug) / 'learn'
    res = {'youtube': cmd_youtube, 'mp4': cmd_mp4, 'prproj': cmd_prproj}[a.cmd](a, learn)
    prof = lite.load_channel(a.slug)
    src = {'youtube': 'youtube', 'mp4': 'mp4', 'prproj': 'prproj'}[a.cmd]
    val = a.url if a.cmd == 'youtube' else str(Path(a.path).expanduser().resolve())
    if val not in prof['sources'].setdefault(src, []):
        prof['sources'][src].append(val)
        prof['updated_at'] = lite.now()
        lite.write_json(lite.channel_dir(a.slug) / 'channel.json', prof)
    brief = json.loads(json.dumps(res, ensure_ascii=False))
    for v in brief.get('videos', []):
        v.pop('look_for', None)
    print(json.dumps(brief, ensure_ascii=False, indent=1)[:6000])


if __name__ == '__main__':
    main()
