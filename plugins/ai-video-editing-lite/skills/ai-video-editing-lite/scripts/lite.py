"""Shared places of ai-video-editing-lite: the memory folder, the learned channels and the bundled fonts.

Memory (kept outside the plugin, so updates and reinstalls keep it):
  ~/.ai-video-editing-lite/            (AIVE_LITE_HOME to move it)
    current.json                       the channel used when none is named
    channels/<slug>/channel.json       name, sources, learned style, standing rules
    channels/<slug>/designs.json       emphasis designs (adopt / reject / open)
    channels/<slug>/learn/             frames, contact sheets and notes made while learning
    fonts/                             the OFL fonts below, downloaded once and checked by SHA-256
    venv/                              the Python environment made by setup.py
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import time
import urllib.request
from pathlib import Path

SKILL = Path(__file__).resolve().parents[1]
HOME = Path(os.environ.get('AIVE_LITE_HOME') or Path.home() / '.ai-video-editing-lite')
CHANNELS = HOME / 'channels'
FONTS = HOME / 'fonts'
SCHEMA = 'ai-video-editing-lite/channel-v1'

# Fonts under the SIL Open Font License from github.com/google/fonts, pinned to one commit and checked by SHA-256.
FONT_COMMIT = '47d54ca1ebb14fd864695f1d39dc734f39017c33'
FONT_SET = {
    'gothic':       ('mplus1p/MPLUS1p-Black.ttf', '815821a62ce085e453af318ca004768e336329d5a7d6f7bed272e97e7862d43e', 'M PLUS 1p Black（太いゴシック・通常字幕向き）'),
    'gothic-bold':  ('mplus1p/MPLUS1p-ExtraBold.ttf', 'd17f745712668b0dcd95e42b3634a90a76195228d4abf88a0be8e98ddbc441b2', 'M PLUS 1p ExtraBold（少し細いゴシック）'),
    'dela':         ('delagothicone/DelaGothicOne-Regular.ttf', '4ff87a0965f1b0505e5a2c58424bc6ad3cff27e56a82f21c2fc9d6b0e3857ee2', 'Dela Gothic One（極太・強調向き）'),
    'mincho':       ('zenoldmincho/ZenOldMincho-Black.ttf', '84a80d8bca79d7d9478935045b216ed003ad40fdea5fd9116d524eb26e872cdc', 'Zen Old Mincho Black（太い明朝・言い切り向き）'),
    'round':        ('mplusrounded1c/MPLUSRounded1c-Black.ttf', 'd5981a59ccc5f00da1bd3ae46750fa95cd165b0e6b3a5fc7a1945f94c59449e3', 'M PLUS Rounded 1c Black（丸文字・ボケ向き）'),
    'brush':        ('yujisyuku/YujiSyuku-Regular.ttf', '82728ebafc8c97391e2dab633414a806f344b8e4e2227d307179f07b548fca61', 'Yuji Syuku（筆文字・強い否定向き）'),
    'reggae':       ('reggaeone/ReggaeOne-Regular.ttf', 'aebe62598732d76036f30ec11bb0ec5f68938e373a06d1b4ceb6b9cf1abf3db2', 'Reggae One（にぎやか）'),
    'pop':          ('mochiypopone/MochiyPopOne-Regular.ttf', '9e009430e1316c271a5f34759c6b65fc343c4e806f193042528887e7235a92c6', 'Mochiy Pop One（ポップ）'),
}


def sha256_file(path) -> str:
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for b in iter(lambda: f.read(1 << 20), b''):
            h.update(b)
    return h.hexdigest()


def ensure_fonts(keys=None, quiet=False) -> dict:
    """Download the pinned fonts that are missing (or broken). Returns {key: path}."""
    FONTS.mkdir(parents=True, exist_ok=True)
    out = {}
    for key in keys or FONT_SET:
        rel, sha, _ = FONT_SET[key]
        dest = FONTS / Path(rel).name
        if not (dest.exists() and sha256_file(dest) == sha):
            url = f'https://raw.githubusercontent.com/google/fonts/{FONT_COMMIT}/ofl/{rel}'
            if not quiet:
                print(f'書体を取得: {dest.name}', flush=True)
            tmp = dest.with_name(f'.tmp-{os.getpid()}-{dest.name}')
            req = urllib.request.Request(url, headers={'user-agent': 'ai-video-editing-lite'})
            with urllib.request.urlopen(req, timeout=120) as r:
                tmp.write_bytes(r.read())
            if sha256_file(tmp) != sha:
                tmp.unlink()
                raise SystemExit(f'書体の中身が記録と違います: {dest.name}（ネットワークを確かめて、もう一度実行してください）')
            tmp.replace(dest)
        out[key] = dest
    return out


def font_file(value) -> str:
    """A font key of FONT_SET (downloaded on first use) or a path to the user's own font file."""
    if value in FONT_SET:
        return str(ensure_fonts([value], quiet=True)[value])
    p = Path(str(value)).expanduser()
    if not p.is_file():
        raise SystemExit(f'書体がありません: {value}（{", ".join(FONT_SET)} のどれか、または書体ファイルの場所）')
    return str(p)


def slugify(name: str) -> str:
    s = re.sub(r'[^a-z0-9]+', '-', name.lower()).strip('-')
    return s[:40] or 'ch-' + hashlib.sha256(name.encode()).hexdigest()[:8]


def now() -> str:
    return time.strftime('%Y-%m-%dT%H:%M:%S%z')


def read_json(path, default=None):
    path = Path(path)
    return json.loads(path.read_text(encoding='utf-8')) if path.exists() else default


def write_json(path, data) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f'.tmp-{os.getpid()}-{path.name}')
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding='utf-8')
    tmp.replace(path)


def current_slug():
    return (read_json(HOME / 'current.json') or {}).get('slug')


def channel_dir(slug=None) -> Path:
    slug = slug or current_slug()
    if not slug:
        raise SystemExit('チャンネルがまだ登録されていません。先に channel_memory.py add で登録してください')
    d = CHANNELS / slug
    if not (d / 'channel.json').exists():
        raise SystemExit(f'チャンネル {slug} は登録されていません（channel_memory.py list で一覧）')
    return d


def load_channel(slug=None) -> dict:
    return read_json(channel_dir(slug) / 'channel.json')


def designs_file(slug=None) -> Path:
    return channel_dir(slug) / 'designs.json'
