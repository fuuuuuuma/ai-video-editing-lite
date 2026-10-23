#!/usr/bin/env python3
"""Is everything ready? Prints OK / NG! / 注意 per item and what to do. Run with the Python setup.py printed.

  doctor.py
"""
import importlib
import json
import os
import shutil
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import lite  # noqa: E402

rows = []


def item(ok, name, detail='', fix='', warn=False):
    rows.append({'state': 'OK' if ok else ('注意' if warn else 'NG!'), 'item': name, 'detail': detail, **({'fix': fix} if not ok and fix else {})})


item(sys.version_info >= (3, 10), 'Python 3.10 以上', sys.version.split()[0], 'setup.py を実行して、setup.py が表示した python で動かす')
for mod, why in (('numpy', '計算'), ('PIL', '字幕の絵'), ('cv2', '映像'), ('uharfbuzz', '文字の詰め'), ('fontTools', '書体'), ('yt_dlp', 'YouTube から学ぶ')):
    try:
        importlib.import_module(mod)
        item(True, f'{mod}（{why}）')
    except ImportError:
        item(False, f'{mod}（{why}）', '入っていません', 'setup.py を実行する')
try:
    import asr
    item(True, '文字起こし', asr.backend())
except SystemExit as e:
    item(False, '文字起こし', str(e), 'setup.py を実行する')
if os.name == 'nt':
    item(bool(sys.flags.utf8_mode), 'UTF-8 で動く（Windows）', 'はい' if sys.flags.utf8_mode else 'いいえ', 'setup.py をもう一度実行する（venv に UTF-8 で動かす設定を置く）')
for t in ('ffmpeg', 'ffprobe'):
    item(bool(shutil.which(t)), t, shutil.which(t) or '見つかりません', 'Mac: brew install ffmpeg / Windows: winget install Gyan.FFmpeg')
missing = [k for k, (rel, sha, _) in lite.FONT_SET.items() if not (lite.FONTS / Path(rel).name).exists()]
item(not missing, '書体（OFL）', f'{len(lite.FONT_SET) - len(missing)}/{len(lite.FONT_SET)}', 'setup.py を実行する（ネット接続が要る）')
cur = lite.current_slug()
item(bool(cur), '学習したチャンネル', cur or 'まだありません', 'channel_memory.py add でチャンネルを登録し、learn.py で学ぶ', warn=True)
url = os.environ.get('MIRU_URL') or ((Path.home() / '.config/miru/url').read_text().strip() if (Path.home() / '.config/miru/url').exists() else '')
item(bool(url), '自分の MIRU（確認サイトに上げるとき）', url or 'まだありません',
     'miru-setup（Claude Code は /ai-video-editing-lite:miru-setup、Codex は $miru-setup）で自分の Cloudflare に立てる', warn=True)
tok = os.environ.get('MIRU_TOKEN') or ((Path.home() / '.config/miru/token').read_text().strip() if (Path.home() / '.config/miru/token').exists() else '')
item(tok.startswith('miru_'), 'MIRU の鍵（確認サイトに上げるとき）', 'あり' if tok.startswith('miru_') else 'なし',
     '自分の MIRU に Google でログイン →「設定 → Claude Code・Codex とつなぐ」で鍵を作り、画面のコマンドで ~/.config/miru/token と url を置く', warn=True)
if url and tok.startswith('miru_'):
    import miru_sync
    h = miru_sync.site_version()
    note = miru_sync.version_note(h) if h else ''
    ver = ((h or {}).get('version') or {})
    item(bool(h) and not note, '自分の MIRU の版', f"版 {ver.get('build') or '?'}（{ver.get('date') or '-'}）" if h else 'つながりません',
         note or f'{url} が開くか確かめる（miru-setup の「確かめる」: node <MIRU>/tools/setup.mjs check）', warn=True)
free = shutil.disk_usage(str(Path.home())).free / 1e9
item(free > 20, '空き容量', f'{free:.0f}GB', '作業用に 20GB ほど空ける（書き出しと一時ファイル）', warn=True)
print(json.dumps(rows, ensure_ascii=False, indent=1))
sys.exit(1 if any(r['state'] == 'NG!' for r in rows) else 0)
