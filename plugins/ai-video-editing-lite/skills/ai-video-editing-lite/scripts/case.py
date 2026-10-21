#!/usr/bin/env python3
"""Start an edit (a "case"): one folder with the plans, the work files and the exports of one video.

  case.py new <video> [<video> ...] --name "第1回 〇〇" [--out ~/Movies/ai-video-editing-lite] [--slug my-ch]
      Several videos are joined in the order given (takes of the same talk). Nothing is copied; the
      originals are never changed. Prints the case folder.
  case.py info <case>

The case folder:
  planning/source.json          the videos (path, length, size, frame rate)
  planning/caption-style.json   how captions are drawn (from the channel's learned style; make_style.py)
  planning/transcript.txt       every voiced block, word for word (prepare.py)
  planning/cuts.json            what is cut and why (prepare.py drafts, the agent decides)
  planning/captions.json        the captions (build.py captions drafts, the agent fixes)
  planning/emphasis.json        the emphasis captions (the agent writes)
  planning/render-plan-vN.json  the whole edit, frame by frame (build.py plan)
  .akari/                       work files, previews and caches
  exports/                      finished MP4s
"""
import argparse
import json
import re
import subprocess
import sys
import time
from fractions import Fraction
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import lite  # noqa: E402

DEFAULT_OUT = Path.home() / 'Movies' / 'ai-video-editing-lite'


def probe(path):
    out = subprocess.run(['ffprobe', '-v', 'error', '-show_streams', '-show_format', '-of', 'json', str(path)],
                         capture_output=True, text=True, check=True).stdout
    d = json.loads(out)
    v = next((s for s in d['streams'] if s['codec_type'] == 'video'), None)
    a = next((s for s in d['streams'] if s['codec_type'] == 'audio'), None)
    if v is None:
        raise SystemExit(f'映像がありません: {path}')
    rate = Fraction(v.get('avg_frame_rate') or v.get('r_frame_rate') or '30/1')
    rot = 0
    for sd in v.get('side_data_list', []) or []:
        if 'rotation' in sd:
            rot = int(sd['rotation'])
    w, h = int(v['width']), int(v['height'])
    if abs(rot) in (90, 270):
        w, h = h, w
    return {'path': str(Path(path).resolve()), 'duration': float(d['format']['duration']), 'fps': f'{rate.numerator}/{rate.denominator}',
            'width': w, 'height': h, 'has_audio': a is not None, 'audio_channels': int(a.get('channels', 0)) if a else 0}


def cmd_new(a):
    prof = lite.load_channel(a.slug)
    videos = [probe(Path(v).expanduser()) for v in a.videos]
    stem = re.sub(r'[\\/:*?"<>|]+', '-', a.name).strip() or 'edit'
    case = Path(a.out).expanduser() / f"{time.strftime('%Y%m%d')}-{stem}"
    if case.exists():
        raise SystemExit(f'同じ名前の案件があります: {case}（--name を変えてください）')
    for sub in ('planning', '.akari/work', 'exports'):
        (case / sub).mkdir(parents=True, exist_ok=True)
    lite.write_json(case / 'planning/source.json', {'schema': 'ai-video-editing-lite/source-v1', 'name': a.name,
                                                    'channel': prof['slug'], 'created_at': lite.now(), 'videos': videos})
    import make_style
    lite.write_json(case / 'planning/caption-style.json', make_style.caption_style(prof))
    lite.write_json(case / 'planning/channel-snapshot.json', {**prof, 'designs': make_style.adopted_designs(prof['slug'])})
    print(json.dumps({'case': str(case), 'videos': [{'path': v['path'], 'seconds': round(v['duration'], 1), 'fps': v['fps'],
                                                     'size': f"{v['width']}x{v['height']}"} for v in videos]}, ensure_ascii=False, indent=1))


def cmd_info(a):
    case = Path(a.case).resolve()
    src = lite.read_json(case / 'planning/source.json')
    plans = sorted(p.name for p in (case / 'planning').glob('render-plan-v*.json'))
    previews = sorted(p.name for p in (case / '.akari/preview').glob('*')) if (case / '.akari/preview').exists() else []
    exports = sorted(p.name for p in (case / 'exports').glob('*.mp4'))
    print(json.dumps({'case': str(case), 'name': src['name'], 'channel': src['channel'], 'videos': len(src['videos']),
                      'plans': plans, 'previews': previews, 'exports': exports,
                      'miru': lite.read_json(case / '.akari/miru.json')}, ensure_ascii=False, indent=1))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest='cmd', required=True)
    p = sub.add_parser('new')
    p.add_argument('videos', nargs='+')
    p.add_argument('--name', required=True)
    p.add_argument('--out', default=str(DEFAULT_OUT))
    p.add_argument('--slug')
    p = sub.add_parser('info')
    p.add_argument('case')
    a = ap.parse_args()
    {'new': cmd_new, 'info': cmd_info}[a.cmd](a)


if __name__ == '__main__':
    main()
