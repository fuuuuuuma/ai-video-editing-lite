#!/usr/bin/env python3
"""Resolve calibrated font files by content, never by cache path alone.

Adobe Fonts keeps activated fonts as numbered files such as
``~/Library/Application Support/Adobe/CoreSync/plugins/livetype/.r/.23593.otf``
and renumbers or updates them when a font is re-activated. A plan that pins only
the path breaks silently; a plan that pins the SHA-256 can be relocated.

Rules kept from the skill:
- a file whose hash differs is never used as a silent substitute;
- a different version of the same PostScript name is accepted only when it is
  listed in ``references/channels/font-files.json`` under ``accepted_sha256``
  (with a recorded reason), after comparing it against the reference.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import struct
from functools import lru_cache
from pathlib import Path

SKILL = Path(__file__).resolve().parents[1]
REGISTRY = SKILL/'references/channels/font-files.json'
ADOBE_LIVETYPE = Path.home()/'Library/Application Support/Adobe/CoreSync/plugins/livetype/.r'
SEARCH_DIRS = (
    SKILL/'assets/fonts',
    ADOBE_LIVETYPE,
    Path.home()/'Library/Fonts',
    Path('/Library/Fonts'),
)
FONT_SUFFIXES = {'.otf', '.ttf', '.ttc', '.otc'}


class FontUnavailable(ValueError):
    """The calibrated font file (or an accepted version of it) is not on this Mac."""


@lru_cache(maxsize=None)
def _sha256(path: str, mtime_ns: int, size: int) -> str:
    digest = hashlib.sha256()
    with open(path, 'rb') as handle:
        for block in iter(lambda: handle.read(1 << 20), b''):
            digest.update(block)
    return digest.hexdigest()


def sha256_file(path) -> str:
    stat = Path(path).stat()
    return _sha256(str(path), stat.st_mtime_ns, stat.st_size)


def font_names(path, index: int = 0) -> dict:
    """Return name-table entries 4 (full), 5 (version), 6 (PostScript) without fontTools."""
    data = Path(path).read_bytes()
    base = 0
    if data[:4] == b'ttcf':
        base = struct.unpack('>I', data[12 + 4*index:16 + 4*index])[0]
    count = struct.unpack('>H', data[base+4:base+6])[0]
    for i in range(count):
        tag, _, offset, _ = struct.unpack('>4sIII', data[base+12+16*i:base+28+16*i])
        if tag == b'name':
            break
    else:
        return {}
    _, records, strings = struct.unpack('>HHH', data[offset:offset+6])
    found = {}
    for i in range(records):
        pid, _, _, nid, length, start = struct.unpack('>HHHHHH', data[offset+6+12*i:offset+18+12*i])
        if nid in (4, 5, 6) and nid not in found:
            raw = data[offset+strings+start:offset+strings+start+length]
            found[nid] = raw.decode('utf-16-be', 'replace') if pid in (0, 3) else raw.decode('latin-1')
    return {'full_name': found.get(4), 'version': found.get(5), 'postscript': found.get(6)}


def registry() -> dict:
    return json.loads(REGISTRY.read_text(encoding='utf-8')) if REGISTRY.is_file() else {}


def family_for(sha256: str):
    """Return (name, acceptable hashes) for the registry entry that owns this hash."""
    for name, entries in registry().items():
        hashes = set()
        for entry in entries:
            hashes.update(h for h in [entry.get('sha256'), *entry.get('accepted_sha256', [])] if h)
        if sha256 in hashes:
            return name, hashes
    return None, {sha256}


def _candidates():
    for folder in SEARCH_DIRS:
        if folder.is_dir():
            for path in sorted(folder.rglob('*')):
                if path.suffix.lower() in FONT_SUFFIXES and path.is_file():
                    yield path


def resolve(path, sha256: str | None = None) -> Path:
    """Return a file with the calibrated content, relocating renumbered Adobe Fonts files."""
    path = Path(path)
    if not sha256:
        if not path.is_file():
            raise FontUnavailable(f'フォントファイルがありません: {path}')
        return path
    name, acceptable = family_for(sha256)
    if path.is_file() and sha256_file(path) in acceptable:
        return path
    for candidate in _candidates():
        if sha256_file(candidate) in acceptable:
            return candidate
    raise FontUnavailable(_missing_message(path, sha256, name))


def _missing_message(path: Path, sha256: str, name: str | None) -> str:
    if not name and path.is_file():
        name = font_names(path).get('postscript')
    if path.is_file():
        head = (f'フォントの中身が記録と違います（differs）: {name or path.name}'
                f'（記録 sha256 {sha256[:12]}…、現在 {sha256_file(path)[:12]}…、{path}）。'
                'OS や Adobe Fonts の更新で版が変わった可能性があります。')
    else:
        head = f'フォント未検出: {name or path.name}（sha256 {sha256[:12]}…、記録パス {path}）。'
    lines = [head, 'Adobe Fonts でこの書体を有効にするか、同じファイルを assets/fonts/ に置いてください。']
    same = []
    if name:
        for candidate in _candidates():
            if _postscript(candidate) == name:
                version = font_names(candidate).get('version')
                same.append(f'{candidate}（{version}、sha256 {sha256_file(candidate)[:12]}…）')
    if same:
        lines.append('同じ PostScript 名で版が違うファイル: ' + ' / '.join(same))
        lines.append('版違いを使うなら参照と見比べ、font-files.json の accepted_sha256 に理由付きで追記する。')
    lines.append('代わりの書体で描いて「再現済み」にしない。')
    return '\n'.join(lines)


def _postscript(path):
    try:
        return font_names(path).get('postscript')
    except (OSError, struct.error, IndexError):
        return None


def resolve_plan_fonts(plan: dict) -> list:
    """Point every pinned text layer at its current file. Returns relocation records."""
    moved = []
    for layer in plan.get('layers', []):
        if layer.get('type') == 'text' and layer.get('font_sha256'):
            found = resolve(layer['font'], layer['font_sha256'])
            if str(found) != layer['font']:
                moved.append({'id': layer.get('id'), 'from': layer['font'], 'to': str(found)})
                layer['font'] = str(found)
    return moved


def check_registry() -> dict:
    report = {}
    for name, entries in registry().items():
        status = []
        for entry in entries:
            try:
                found = resolve(entry['path'], entry.get('sha256'))
                status.append({'ok': True, 'path': str(found), 'moved': str(found) != entry['path']})
            except FontUnavailable as error:
                status.append({'ok': False, 'message': str(error)})
        if not entries:
            # Hash not recorded yet (e.g. No.27 fonts never found): look for the PostScript name.
            same = [c for c in _candidates() if _postscript(c) == name]
            status = ([{'ok': True, 'path': str(same[0]), 'calibrated': False,
                        'message': 'ハッシュ未記録。参照と見比べてから font-files.json に sha256 を記録する'}]
                      if same else [{'ok': False, 'message': f'フォント未検出: {name}（Adobe Fonts 等で有効化が必要）'}])
        report[name] = status
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument('--check', action='store_true', help='check every font in font-files.json')
    args = parser.parse_args()
    if not args.check:
        parser.print_help()
        return
    print(json.dumps(check_registry(), ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
