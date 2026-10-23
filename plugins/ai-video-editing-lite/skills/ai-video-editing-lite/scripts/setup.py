#!/usr/bin/env python3
"""Get this computer ready (run once, and again after updating the plugin). Safe to run many times.

  python3 setup.py          (Windows: py setup.py)

- finds Python 3.10 or newer (or uses uv to get one) and makes ~/.ai-video-editing-lite/venv
- installs what the scripts need there (requirements.txt): image and video handling, speech recognition
  (mlx-whisper on Apple Silicon Macs, faster-whisper elsewhere) and the newest yt-dlp
- checks ffmpeg / ffprobe and downloads the OFL fonts (checked by SHA-256)
- prints the Python to use for every other script ("python": ...)

Written for old Pythons too (macOS's /usr/bin/python3 is 3.9), so it can start from anything.
"""
import json
import os
import platform
import shutil
import subprocess
import sys
from pathlib import Path

SKILL = Path(__file__).resolve().parents[1]
HOME = Path(os.environ.get('AIVE_LITE_HOME') or Path.home() / '.ai-video-editing-lite')
VENV = HOME / 'venv'
WIN = os.name == 'nt'
VPY = VENV / ('Scripts/python.exe' if WIN else 'bin/python')


def say(msg):
    print(msg, flush=True)


def version_of(cmd):
    try:
        out = subprocess.run(cmd + ['-I', '-c', 'import sys;print("%d.%d" % sys.version_info[:2])'], capture_output=True, text=True, timeout=20)
        major, minor = out.stdout.strip().split('.')
        return int(major), int(minor)
    except Exception:
        return None


def find_python():
    cands = []
    if sys.version_info >= (3, 10):
        cands.append([sys.executable])
    for name in ('python3.13', 'python3.12', 'python3.11', 'python3.10', 'python3'):
        p = shutil.which(name)
        if p:
            cands.append([p])
    for p in ('/opt/homebrew/bin/python3', '/usr/local/bin/python3'):
        if Path(p).exists():
            cands.append([p])
    if WIN and shutil.which('py'):
        for v in ('-3.13', '-3.12', '-3.11', '-3.10'):
            cands.append(['py', v])
    for c in cands:
        v = version_of(c)
        if v and (3, 10) <= v < (3, 15):
            return c
    return None


def make_venv():
    if VPY.exists() and version_of([str(VPY)]) and version_of([str(VPY)]) >= (3, 10):
        return
    HOME.mkdir(parents=True, exist_ok=True)
    py = find_python()
    if py:
        say(f'Python の環境を作ります（{" ".join(py)}）')
        subprocess.run(py + ['-I', '-m', 'venv', str(VENV)], check=True)
        return
    uv = shutil.which('uv')
    if uv:
        say('uv で Python 3.12 の環境を作ります')
        subprocess.run([uv, 'venv', '--python', '3.12', str(VENV)], check=True)
        subprocess.run([uv, 'pip', 'install', '--python', str(VPY), 'pip'], check=True)
        return
    sys.exit('Python 3.10 以上が見つかりません。\n'
             '  Mac: ターミナルで  brew install python@3.12  （Homebrew が無ければ https://brew.sh ）\n'
             '  Windows: https://www.python.org/downloads/ から入れる（「Add python.exe to PATH」に印）\n'
             'のあと、もう一度 setup.py を実行してください。')


# Windows は既定の文字コードが UTF-8 ではない（日本語の Windows は cp932）。スクリプトは UTF-8 の JSON・文字起こしを
# encoding を書かずに読み書きするので、この venv の python は必ず UTF-8 モードで動かす。-I（環境変数を読まない）で呼ぶ所も
# あるので PYTHONUTF8 だけでは効かず、起動のたびに -X utf8 を付けて起動し直す（2026-10-23 Windows の検査で見つけた）。
# sitecustomize は Python によっては標準の側にあって読まれないので、site-packages の .pth（どの起動でも読まれる）から呼ぶ
UTF8_MODULE = """# ai-video-editing-lite の setup.py が置いたもの（aive_utf8.pth から読まれる）: Windows でこの venv の python を UTF-8 モードで動かす
import os, sys
# AIVE_FORCE_UTF8 は Windows でない所で試すため。印は「起動し直した親の番号」で、起動し直された本人だけが読み飛ばす（孫は自分で判断する）
if ((os.name == 'nt' or os.environ.get('AIVE_FORCE_UTF8')) and not sys.flags.utf8_mode
        and os.environ.get('AIVE_UTF8_REEXEC') != str(os.getppid())):
    import subprocess
    os.environ['PYTHONUTF8'] = '1'                      # ここから呼ぶ子にも（-I で呼ばない子）
    os.environ['AIVE_UTF8_REEXEC'] = str(os.getpid())
    argv = list(getattr(sys, 'orig_argv', None) or [sys.executable, *sys.argv])
    code = subprocess.call([sys.executable, '-X', 'utf8', *argv[1:]])
    sys.stdout.flush()
    os._exit(code)                                      # site の読み込み中なので sys.exit は使えない（起動の失敗になる）
"""


def utf8_on_windows():
    if not WIN:
        return
    put_utf8(VENV / 'Lib' / 'site-packages')    # Windows の venv の決まった場所（本体の Python には置かない）


def put_utf8(site_packages):
    if not any((d / 'pyvenv.cfg').exists() for d in list(site_packages.parents)[:3]):
        sys.exit(f'{site_packages} は ai-video-editing-lite の venv ではありません（本体の Python には置きません）')
    (site_packages / 'aive_utf8.py').write_text(UTF8_MODULE, encoding='utf-8')
    (site_packages / 'aive_utf8.pth').write_text('import aive_utf8\n', encoding='utf-8')


def install():
    say('必要な道具を入れています（初回は数分かかります）')
    subprocess.run([str(VPY), '-I', '-m', 'pip', 'install', '-q', '--upgrade', 'pip'], check=True)
    subprocess.run([str(VPY), '-I', '-m', 'pip', 'install', '-q', '--upgrade', '-r', str(SKILL / 'requirements.txt')], check=True)


def check_ffmpeg():
    missing = [t for t in ('ffmpeg', 'ffprobe') if not shutil.which(t)]
    if missing:
        hint = ('brew install ffmpeg' if platform.system() == 'Darwin' else
                'winget install Gyan.FFmpeg（入れたあと新しいターミナルで）' if WIN else 'sudo apt install ffmpeg')
        sys.exit(f'{" と ".join(missing)} がありません。{hint} で入れてから、もう一度 setup.py を実行してください。')


def main():
    check_ffmpeg()
    make_venv()
    utf8_on_windows()
    install()
    r = subprocess.run([str(VPY), '-I', '-c', 'import sys; sys.path.insert(0, %r); import lite, asr; lite.ensure_fonts(); print(asr.backend())' % str(SKILL / 'scripts')],
                       capture_output=True, text=True)
    if r.returncode:
        sys.exit('書体か文字起こしの準備で止まりました:\n' + r.stderr[-1500:])
    backend = r.stdout.strip().splitlines()[-1]
    ff = subprocess.run(['ffmpeg', '-version'], capture_output=True, text=True).stdout.splitlines()[0]
    info = {'ok': True, 'python': str(VPY), 'memory': str(HOME), 'speech_recognition': backend, 'ffmpeg': ff,
            'next': f'"{VPY}" "{SKILL / "scripts/doctor.py"}"'}
    (HOME / 'setup.json').write_text(json.dumps(info, ensure_ascii=False, indent=1), encoding='utf-8')
    print(json.dumps(info, ensure_ascii=False, indent=1))


if __name__ == '__main__':
    main()
