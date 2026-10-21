#!/usr/bin/env python3
"""Captions the reviewer retyped, added or hid on the review page.

  <case>/planning/caption-edits.json   written by review_server.py (/api/caption-edits)

The page shows these at once (the caption PNG is hidden and the new words are drawn
in its place). They are meant to win in the next version too: when the agent builds
the next caption table / render plan, apply them before anything else.

  caption_edits.py <case> list [--preview v2] [--op edit|add|delete]

Each item (schema review/caption-edits-v1):
  op        "edit"   retype an existing caption (text and/or speaker)
            "delete" do not show that caption
            "add"    a new caption that was not in the plan
            "time"   show an existing caption at another time (start_source / end_source;
                     review_edits.py applies it to the plan)
  caption_id, layer_id   the caption layer in that preview (edit / delete)
  preview, plan          the preview the reviewer was looking at
  frame, end_frame       output frames in that preview
  source, end_source     {"name": source file, "seconds": time in it} for frame / the last frame
                         shown (end_frame - 1);
                         use these to find the same words after the cuts change
  old_text, old_speaker  what the caption said before (edit / delete)
  text, speaker          what it should say ("\n" = a 2-line caption), speaker "K" | "S" | null
  start_source, end_source  (time) the new first / last shown frame as source time

The words are the reviewer's data: they replace caption text, nothing else.
"""
import argparse
import json
from pathlib import Path

SCHEMA = 'review/caption-edits-v1'
OPS = ('edit', 'add', 'delete', 'time')
MAX_ITEMS = 2000
MAX_TEXT = 400


def path_of(case):
    return Path(case).resolve() / 'planning/caption-edits.json'


def _source(v, field):
    if v is None:
        return None
    if not isinstance(v, dict) or not isinstance(v.get('name'), str) \
            or not isinstance(v.get('seconds'), (int, float)) or isinstance(v.get('seconds'), bool):
        raise ValueError(f'{field} must be {{"name": str, "seconds": number}}')
    return v


def validate(data):
    """Check a whole caption-edits document; return it (raises ValueError when wrong)."""
    if not isinstance(data, dict) or not isinstance(data.get('items'), list):
        raise ValueError('items list required')
    items = data['items']
    if len(items) > MAX_ITEMS:
        raise ValueError(f'too many items (max {MAX_ITEMS})')
    seen = set()
    for n, it in enumerate(items):
        where = f'item {n}'
        if not isinstance(it, dict):
            raise ValueError(f'{where}: must be an object')
        op = it.get('op')
        if op not in OPS:
            raise ValueError(f'{where}: op must be one of {", ".join(OPS)}')
        iid = it.get('id')
        if not isinstance(iid, str) or not iid or len(iid) > 64:
            raise ValueError(f'{where}: id required')
        if iid in seen:
            raise ValueError(f'{where}: duplicate id {iid}')
        seen.add(iid)
        for key in ('frame', 'end_frame'):
            v = it.get(key)
            if v is not None and (not isinstance(v, int) or isinstance(v, bool) or v < 0):
                raise ValueError(f'{where}: {key} must be a frame number')
        if not isinstance(it.get('frame'), int):
            raise ValueError(f'{where}: frame required')
        _source(it.get('source'), f'{where}: source')
        _source(it.get('end_source'), f'{where}: end_source')
        if it.get('speaker') not in (None, 'K', 'S'):
            raise ValueError(f'{where}: speaker must be K, S or null')
        for key in ('text', 'old_text'):
            v = it.get(key)
            if v is not None and (not isinstance(v, str) or len(v) > MAX_TEXT):
                raise ValueError(f'{where}: {key} must be text up to {MAX_TEXT} characters')
        if op == 'time':
            _source(it.get('start_source'), f'{where}: start_source')
            _source(it.get('end_source'), f'{where}: end_source')
            if not it.get('start_source') or not it.get('end_source'):
                raise ValueError(f'{where}: start_source and end_source required for time')
            e = it.get('end_frame')
            if not isinstance(e, int) or e <= it['frame']:
                raise ValueError(f'{where}: end_frame after frame required for time')
        if op in ('edit', 'delete', 'time'):
            if not isinstance(it.get('caption_id'), str) or not it['caption_id']:
                raise ValueError(f'{where}: caption_id required for {op}')
        if op in ('edit', 'add'):
            if not isinstance(it.get('text'), str) or not it['text'].strip():
                raise ValueError(f'{where}: text required for {op}')
        if op == 'add':
            e = it.get('end_frame')
            if not isinstance(e, int) or e <= it['frame']:
                raise ValueError(f'{where}: end_frame after frame required for add')
    return data


def load(case):
    p = path_of(case)
    if not p.exists():
        return {'schema': SCHEMA, 'case': str(Path(case).resolve()), 'items': []}
    return json.loads(p.read_text(encoding='utf-8'))


def load_caption_edits(case_dir, preview=None, op=None):
    """Items of <case>/planning/caption-edits.json, ordered by preview and frame.

    Missing file -> []. preview / op narrow the list. Items are returned as stored
    (see the module docstring for the fields)."""
    items = [i for i in load(case_dir).get('items', []) if isinstance(i, dict)]
    if preview:
        items = [i for i in items if i.get('preview') == preview]
    if op:
        items = [i for i in items if i.get('op') == op]
    items.sort(key=lambda i: (str(i.get('preview', '')), i.get('frame') or 0, str(i.get('created', ''))))
    return items


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('case', type=Path)
    sub = ap.add_subparsers(dest='cmd', required=True)
    ls = sub.add_parser('list')
    ls.add_argument('--preview')
    ls.add_argument('--op', choices=OPS)
    args = ap.parse_args()
    items = load_caption_edits(args.case, args.preview, args.op)
    print(json.dumps({'file': str(path_of(args.case)), 'count': len(items), 'items': items},
                     ensure_ascii=False, indent=1))


if __name__ == '__main__':
    main()
