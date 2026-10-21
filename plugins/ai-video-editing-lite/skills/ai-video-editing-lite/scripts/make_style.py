#!/usr/bin/env python3
"""Turn the channel's learned style into the case's planning/caption-style.json (what the export and the
review page draw captions with). Font names (gothic, mincho, ...) become the downloaded font files.

  make_style.py <case> [--slug my-ch]
"""
import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import lite  # noqa: E402


def resolve_item(item):
    out = dict(item)
    if out.get('font'):
        out['font'] = lite.font_file(out['font'])
    return out


def adopted_designs(slug=None):
    data = lite.read_json(lite.designs_file(slug), {}) or {}
    return [d for d in data.get('designs', []) if d.get('status') == 'adopt']


def design_by_id(slug=None):
    data = lite.read_json(lite.designs_file(slug), {}) or {}
    return {d['id']: d for d in data.get('designs', [])}


def caption_style(prof):
    st = prof['style']
    cap = st['caption']
    emphasis = {}
    for d in adopted_designs(prof['slug']):
        emphasis.setdefault(d['role'], {**resolve_item(d['style']), 'design_id': d['id']})
    return {
        'schema': 'review/caption-style-v1',
        'from': f"ai-video-editing-lite channel {prof['slug']}",
        'normal': {k: resolve_item(v) for k, v in cap['normal'].items()},
        'normal_place': cap.get('normal_place', {}),
        'emphasis': emphasis,
        'emphasis_place': cap.get('emphasis_place', {}),
    }


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('case', type=Path)
    ap.add_argument('--slug')
    a = ap.parse_args()
    prof = lite.load_channel(a.slug)
    style = caption_style(prof)
    if not style['emphasis']:
        print('注意: 採用している強調デザインがありません（強調なしで作ります）', file=sys.stderr)
    out = a.case.resolve() / 'planning/caption-style.json'
    lite.write_json(out, style)
    lite.write_json(a.case.resolve() / 'planning/channel-snapshot.json', {**prof, 'designs': adopted_designs(prof['slug'])})
    print(json.dumps({'caption_style': str(out), 'emphasis_roles': sorted(style['emphasis'])}, ensure_ascii=False))


if __name__ == '__main__':
    main()
