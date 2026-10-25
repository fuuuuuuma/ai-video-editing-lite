#!/usr/bin/env python3
"""The review site MIRU (Cloudflare): put a built preview there, and bring the reviewer's notes and fixes back.

  miru_sync.py publish <case> --preview v1 [--channel my-ch] [--video my-video] [--title ...] [--jobs 4]
                  --channel: the channel on MIRU (default: the case's channel name; made on MIRU if it is not there yet)
  miru_sync.py pull <case> --preview v10            # notes -> planning/review-comments.json, fixes -> planning/*-edits.json
  miru_sync.py reply <case> --note <id> --text ... [--status done]
  miru_sync.py deliver <case> --preview v3 --file exports/name_v3.mp4   # the finished MP4 of an approved version
  miru_sync.py style <case> --preview v10            # only caption-style.json and its fonts, to a version already up
  miru_sync.py designs-push [--channel my-ch] [--slug my-ch] [--case <case> [--plan planning/render-plan-vN.json]]
                  the channel's emphasis designs (~/.ai-video-editing-lite/channels/<slug>/designs.json) and their
                  samples (<case>/.akari/catalog/emphasis/<id>.jpg; drawn first when --plan is given) to the site.
                  Decisions already made on the site are kept (the site is the master since 2026-10-20).
  miru_sync.py designs-pull [--channel my-ch] [--slug my-ch]  # the site's adopt / reject / memo back into that file

The site and the key: your own MIRU (set up with ../../miru/SETUP.md). MIRU_URL and MIRU_TOKEN, or the files
~/.config/miru/url and ~/.config/miru/token (one line each, made on the site's 設定 → Claude Code・Codex とつなぐ).
There is no default site (since 0.2.0 everyone runs their own MIRU on their own Cloudflare). The key is never printed.

The video's name on the site is kept in <case>/.akari/miru.json. When the name is already used by someone else's
channel the site gives a new one (no51-xxxxx); publish saves it there and pull / reply / style read it back.

Network: every request is retried (429, 5xx, dropped connections; waits 1, 2, 4, 8, 16 s). Big files go up in
50 MB parts; the parts already sent are kept in <case>/.akari/cache/miru-upload, so running publish again resumes
them. A refused upload (402 = the creator's storage is full) is aborted on the site and not retried.

Files that are the same in every version (the camera proxy, sound pieces, fonts) are stored once per video on the
site (by SHA-256) and each version only links to them, so the second version costs only what changed.

publish uploads (only the people invited to the channel on MIRU can see it):
  manifest.json, plan.json (the render plan), durations.json (ffprobe seconds of every file the plan names),
  media/<key>     every file of the preview (videos over 40 MB are made 720p first, cached in .akari/cache/miru-720),
  audio/<id>/<k>.flac + audio/index.json   every sound the plan plays, cut into exact 10-second FLAC pieces
                  (48 kHz stereo; the page mixes them when cuts are changed on the site),
  carried.json    planning/carried-edits.json when it belongs to this preview,
  caption-style.json + fonts/<sha>.<ext>   how retyped captions are drawn in the browser (the export's style);
                  only fonts whose licence (name ID 13) is the SIL Open Font License are sent, others are left out
                  (captions in those fonts show as a stand-in on the site),
  thumb.jpg       a frame from the middle of the camera proxy,
then marks the version ready and prints the link. Re-running replaces the same version.
"""
import argparse
import random
import re
import time
import concurrent.futures as cf
import hashlib
import json
import os
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

def _site():
    u = os.environ.get('MIRU_URL') or ''
    f = Path.home() / '.config/miru/url'
    if not u and f.exists():
        u = f.read_text().strip()
    return u.rstrip('/')


SITE = _site()
NO_SITE = ('MIRU の場所がありません: 自分の MIRU を立ててから（このスキルの miru/SETUP.md、Claude Code は /ai-video-editing-lite:miru-setup、'
           'Codex は $miru-setup）、サイトの「設定 → Claude Code・Codex とつなぐ」→「鍵を作る」→「上げる道具用をコピー（Mac／Windows）」を押して、ターミナルに貼ってください（~/.config/miru/url と token が置かれます）')
CHUNK = 10            # seconds per audio piece
RATE = 48000
PART = 50 * 1024 * 1024
BIG = 40 * 1024 * 1024        # videos larger than this are sent as 720p (the camera and screen proxies)
SMALL_CRF = 27
RETRIES = 5


MIRU_PKG = Path(__file__).resolve().parents[3] / 'miru'   # このプラグインに入っている MIRU ライト（立てる元）
UA = 'miru-sync/1.1'


def bundled_version():
    try:
        return json.loads((MIRU_PKG / 'VERSION.json').read_text())
    except (OSError, ValueError):
        return {}


def site_version():
    """自分の MIRU の版（/api/health。ログイン不要）。読めなければ None"""
    if not SITE.startswith(('https://', 'http://localhost', 'http://127.0.0.1')):
        return None
    try:
        with urllib.request.urlopen(urllib.request.Request(SITE + '/api/health', headers={'user-agent': UA}), timeout=15) as r:
            return json.loads(r.read())
    except (OSError, ValueError, urllib.error.URLError):
        return None


def version_note(health=None):
    """立てた MIRU ライトが、入っている lite の MIRU より古ければ、新しい版にする案内。同じ・読めない・ライトでなければ空"""
    h, b = health if health is not None else site_version(), bundled_version()
    have, want = ((h or {}).get('version') or {}).get('build') or 0, b.get('build') or 0
    if not h or h.get('edition') != 'light' or not want or have >= want:
        return ''
    return (f'あなたの MIRU（版 {have or "?"}）は、入っている lite の MIRU（版 {want}・{b.get("date", "")}）より古いです。'
            f'AI に「MIRU を新しい版にして」と頼むと入れ替わります（node "{MIRU_PKG / "tools" / "setup.mjs"}" update）')


def version_cmd(_args):
    h = site_version()
    print(json.dumps({'site': SITE or None, 'site_version': (h or {}).get('version'), 'edition': (h or {}).get('edition'),
                      'reachable': bool(h and h.get('ok')), 'bundled_version': bundled_version() or None,
                      'setup': str(MIRU_PKG / 'tools' / 'setup.mjs'), 'note': version_note(h) or None}, ensure_ascii=False, indent=1))


class MiruError(Exception):
    def __init__(self, msg, code=0):
        super().__init__(msg)
        self.code = code


def token():
    t = os.environ.get('MIRU_TOKEN') or ''
    f = Path.home() / '.config/miru/token'
    if not t and f.exists():
        t = f.read_text().strip()
    if not t.startswith('miru_'):
        raise SystemExit('MIRU の鍵がありません: サイトの「設定 → Claude Code・Codex とつなぐ」→「鍵を作る」→「上げる道具用をコピー（Mac／Windows）」を押して、ターミナルに貼ってください')
    return t


def call(method, path, body=None, data=None, ctype=None, headers=None):
    if not SITE.startswith(('https://', 'http://localhost', 'http://127.0.0.1')):
        raise SystemExit(NO_SITE)
    """One request to the site, retried on 429 / 5xx / dropped connections. Other failures raise MiruError."""
    # Cloudflare の Browser Integrity Check は Python の既定の名乗り（Python-urllib）を 403（1010）で止める
    h = {'authorization': f'Bearer {token()}', 'user-agent': UA, **(headers or {})}
    if body is not None:
        data = json.dumps(body, ensure_ascii=False).encode()
        h['content-type'] = 'application/json'
    elif ctype:
        h['x-miru-type'] = ctype
    for attempt in range(RETRIES + 1):
        req = urllib.request.Request(SITE + path, data=data, method=method, headers=h)
        try:
            with urllib.request.urlopen(req, timeout=600) as r:
                raw = r.read()
                return json.loads(raw) if raw and r.headers.get('content-type', '').startswith('application/json') else raw
        except urllib.error.HTTPError as e:
            text = e.read().decode(errors='replace')[:500]
            try:
                msg = json.loads(text).get('error') or text
            except ValueError:
                msg = text
            if (e.code == 429 or e.code >= 500) and attempt < RETRIES:
                wait = float(e.headers.get('retry-after') or 0) or 2 ** attempt
                time.sleep(min(60, wait) + random.random())
                continue
            if e.code == 401:
                msg = '鍵が使えません（期限切れか、消されています）。サイトの「設定 → Claude Code・Codex とつなぐ」→「鍵を作る」で作り直し、「上げる道具用をコピー（Mac／Windows）」を押してターミナルに貼ってください'
            elif e.code == 402:
                msg = f'容量が足りません: {msg}'
            raise MiruError(f'{method} {path.split("?")[0]}: {e.code} {msg}', e.code)
        except (urllib.error.URLError, TimeoutError, ConnectionError, OSError) as e:
            if attempt < RETRIES:
                time.sleep(2 ** attempt + random.random())
                continue
            raise MiruError(f'{method} {path.split("?")[0]}: サイトに届きません（{e}）。回線を確かめて、もう一度実行すると続きから上げます')


def default_video_id(case):
    """An ASCII name for the site (the case folder's name, or a short hash when it has no Latin letters)."""
    s = re.sub(r'[^a-z0-9]+', '-', case.name.lower()).strip('-')
    if len(re.sub(r'[^a-z]', '', s)) < 3:
        s = (s + '-' if s else 'v-') + hashlib.sha256(str(case).encode()).hexdigest()[:8]
    return s[:70]


def lite_channel(slug=None):
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    import lite
    return lite, lite.load_channel(slug)


def miru_channel(case=None, given=None):
    """The channel on MIRU: --channel, else the lite channel's miru_channel, else its slug."""
    if given:
        return given
    snap = (case / 'planning/channel-snapshot.json') if case else None
    slug = json.loads(snap.read_text(encoding='utf-8'))['slug'] if snap and snap.exists() else None
    _, prof = lite_channel(slug)
    return prof.get('miru_channel') or prof['slug']


def state_file(case):
    return case / '.akari/miru.json'


def video_id(case, given=None):
    """The video's name on the site: --video, else what publish saved, else the case folder's name."""
    if given:
        return given
    f = state_file(case)
    if f.exists():
        st = json.loads(f.read_text())
        if st.get('site') == SITE and st.get('video'):
            return st['video']
    return default_video_id(case)


def save_state(case, **kw):
    f = state_file(case)
    st = json.loads(f.read_text()) if f.exists() else {}
    if st.get('site') != SITE:
        st = {}
    st.update(site=SITE, **kw)
    f.parent.mkdir(parents=True, exist_ok=True)
    f.write_text(json.dumps(st, ensure_ascii=False, indent=1))


def ctype_of(p):
    ext = Path(p).suffix.lower()
    return {'.mp4': 'video/mp4', '.m4a': 'audio/mp4', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.flac': 'audio/flac',
            '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.json': 'application/json'}.get(ext, 'application/octet-stream')


def put_file(base, rel, src):
    """One file into this version (small ones directly, big ones in parts)."""
    src = Path(src)
    size = src.stat().st_size
    ct = ctype_of(src)
    if size <= 90 * 1024 * 1024:
        call('PUT', f'{base}/files/{urllib.parse.quote(rel)}', data=src.read_bytes(), ctype=ct)
        return size
    qs = urllib.parse.urlencode({'path': rel, 'type': ct, 'size': size})
    multipart(f'{base}/mpu', qs, src, None)
    return size


def multipart(prefix, qs, src, resume_file):
    """Send src in 50 MB parts. With resume_file, the upload id and the parts already sent are kept there, so a
    later run continues instead of starting over. On a refusal (4xx) the upload is aborted on the site."""
    st = json.loads(resume_file.read_text()) if resume_file and resume_file.exists() else {}
    stat = src.stat()
    size = stat.st_size
    # 前と違うファイル（書き出し直した MP4 など。大きさか更新の時刻で見る）なら、前の途中の片を捨ててから始める
    # （2026-10-25 の点検: 捨てずに始めると、前の片が 7 日間 容量を使った）
    if st and (st.get('size') != size or st.get('mtime', stat.st_mtime_ns) != stat.st_mtime_ns):
        try:
            call('POST', f"{prefix}/{st['uploadId']}/abort?{qs}")
        except MiruError:
            pass
        st = {}
    if not st:
        st = {'uploadId': call('POST', f'{prefix}?{qs}')['uploadId'], 'size': size, 'mtime': stat.st_mtime_ns, 'parts': {}}
    uid = st['uploadId']

    def keep():
        if resume_file:
            resume_file.parent.mkdir(parents=True, exist_ok=True)
            resume_file.write_text(json.dumps(st))
    keep()
    try:
        with open(src, 'rb') as f:
            n = 1
            while True:
                chunk = f.read(PART)
                if not chunk:
                    break
                if str(n) not in st['parts']:
                    st['parts'][str(n)] = call('PUT', f'{prefix}/{uid}/{n}?{qs}', data=chunk)['etag']
                    keep()
                n += 1
        parts = [{'partNumber': int(k), 'etag': v} for k, v in sorted(st['parts'].items(), key=lambda kv: int(kv[0]))]
        out = call('POST', f'{prefix}/{uid}/complete?{qs}', body={'parts': parts})
    except MiruError as e:
        if 400 <= e.code < 500:      # refused (full, gone, wrong): start over next time
            try:
                call('POST', f'{prefix}/{uid}/abort?{qs}')
            except MiruError:
                pass
            if resume_file and resume_file.exists():
                resume_file.unlink()
        raise
    if resume_file and resume_file.exists():
        resume_file.unlink()
    return out


def sha_of(case, path, _lock=__import__('threading').Lock()):
    """SHA-256 of a file, remembered by (path, size, mtime) in .akari/cache/miru-sha.json."""
    path = Path(path)
    st = path.stat()
    f = case / '.akari/cache/miru-sha.json'
    key = str(path)
    with _lock:
        memo = json.loads(f.read_text()) if f.exists() else {}
        hit = memo.get(key)
        if hit and hit[0] == st.st_size and hit[1] == st.st_mtime_ns:
            return hit[2]
    h = hashlib.sha256()
    with open(path, 'rb') as fh:
        for b in iter(lambda: fh.read(8 * 1024 * 1024), b''):
            h.update(b)
    d = h.hexdigest()
    with _lock:
        memo = json.loads(f.read_text()) if f.exists() else {}
        memo[key] = [st.st_size, st.st_mtime_ns, d]
        f.parent.mkdir(parents=True, exist_ok=True)
        tmp = f.with_name(f'.tmp-{os.getpid()}-{f.name}')
        tmp.write_text(json.dumps(memo))
        tmp.replace(f)
    return d


def put_blob(case, vid, sha, src):
    """One file into the video's shared store (by SHA-256), resumable."""
    src = Path(src)
    size = src.stat().st_size
    ct = ctype_of(src)
    base = f'/api/videos/{vid}/blobs/{sha}'
    if size <= 90 * 1024 * 1024:
        call('PUT', f'{base}?{urllib.parse.urlencode({"type": ct})}', data=src.read_bytes(), ctype=ct)
        return size
    resume = case / '.akari/cache/miru-upload' / f'{hashlib.sha256((SITE + vid).encode()).hexdigest()[:12]}-{sha[:24]}.json'
    try:
        multipart(f'{base}/mpu', urllib.parse.urlencode({'type': ct, 'size': size}), src, resume)
    except MiruError as e:
        if e.code != 409:
            raise
        # もう置いてある（同時に上げた・前の返事が届かなかった）。つながったかは put_shared が確かめる
    return size


def put_shared(case, vid, base, rel, src):
    """One file through the shared store when the site has it (sent only if no version has it yet)."""
    h = sha_of(case, src)
    miss = link_files(base, [{'path': rel, 'sha': h}])
    if miss is None:
        return put_file(base, rel, src)
    if miss:
        put_blob(case, vid, h, src)
        if link_files(base, [{'path': rel, 'sha': h}]):
            raise MiruError(f'上げたはずのファイルがサイトにありません: {rel}')
    return Path(src).stat().st_size


def link_files(base, items):
    """Link shared files into the version; returns the SHA-256 the site does not have yet (None: old site)."""
    missing = set()
    for i in range(0, len(items), 2000):
        try:
            r = call('POST', f'{base}/links', body={'links': items[i:i + 2000]})
        except MiruError as e:
            if e.code in (404, 405):
                return None
            raise
        missing.update(r.get('missing', []))
    return missing


def probe(path):
    try:
        out = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', str(path)],
                             capture_output=True, text=True, check=True).stdout.strip()
        return float(out)
    except (subprocess.CalledProcessError, ValueError, OSError):
        return None


def small_video(case, src):
    """Videos over 40 MB (the camera and screen proxies) as 720p, same frames, a key frame every second (seeking)."""
    src = Path(src)
    if src.stat().st_size <= BIG:
        return src
    try:            # already 720p or smaller (the light "flat" preview is 960x540): send it as it is, never scale it up
        hgt = int(subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=height', '-of', 'csv=p=0', str(src)],
                                 capture_output=True, text=True, check=True).stdout.strip().splitlines()[0])
        if hgt <= 720:
            return src
    except (subprocess.CalledProcessError, ValueError, IndexError, OSError):
        pass
    h = hashlib.sha256(f'{src}|{src.stat().st_size}|{src.stat().st_mtime_ns}|720|{SMALL_CRF}'.encode()).hexdigest()[:20]
    out = case / '.akari/cache/miru-720' / f'{h}.mp4'
    if not out.exists():
        out.parent.mkdir(parents=True, exist_ok=True)
        tmp = out.with_name(f'.tmp-{h}.mp4')
        subprocess.run(['ffmpeg', '-v', 'error', '-nostdin', '-y', '-i', str(src), '-vf', 'scale=-2:720', '-c:v', 'libx264', '-preset', 'veryfast',
                        '-crf', str(SMALL_CRF), '-g', '30', '-pix_fmt', 'yuv420p', '-an', '-movflags', '+faststart', str(tmp)], check=True)
        tmp.replace(out)
    return out


def audio_pieces(case, path):
    """Exact 10-second FLAC pieces of one sound (48 kHz stereo), made once and cached."""
    path = Path(path)
    st = path.stat()
    h = hashlib.sha256(f'{path}|{st.st_size}|{st.st_mtime_ns}|flac{CHUNK}'.encode()).hexdigest()[:16]
    d = case / '.akari/cache/miru-audio' / h
    done = d / 'done.json'
    if done.exists():
        return h, json.loads(done.read_text())
    d.mkdir(parents=True, exist_ok=True)
    raw = d / 'all.s16'
    subprocess.run(['ffmpeg', '-v', 'error', '-nostdin', '-y', '-i', str(path), '-vn', '-af', f'aresample={RATE}', '-ar', str(RATE), '-ac', '2',
                    '-f', 's16le', str(raw)], check=True)
    n = raw.stat().st_size // 4
    per = RATE * CHUNK
    count = max(1, -(-n // per))

    def one(k):
        with open(raw, 'rb') as f:
            f.seek(k * per * 4)
            pcm = f.read(per * 4)
        subprocess.run(['ffmpeg', '-v', 'error', '-nostdin', '-y', '-f', 's16le', '-ar', str(RATE), '-ac', '2', '-i', 'pipe:0',
                        '-c:a', 'flac', '-compression_level', '8', str(d / f'{k}.flac')], input=pcm, check=True)
    with cf.ThreadPoolExecutor(8) as ex:
        list(ex.map(one, range(count)))
    raw.unlink()
    info = {'chunks': count, 'duration': n / RATE}
    done.write_text(json.dumps(info))
    return h, info


def ofl(path):
    """Is the font under the SIL Open Font License (may be sent to the site)?"""
    try:
        from fontTools.ttLib import TTFont
        f = TTFont(str(path), fontNumber=0, lazy=True)
        lic = (f['name'].getDebugName(13) or '') + ' ' + (f['name'].getDebugName(14) or '')
        return 'SIL Open Font License' in lic or 'scripts.sil.org/OFL' in lic or 'openfontlicense.org' in lic
    except Exception:
        return False


def put_style(case, base, vid=None):
    """caption-style.json with its fonts as keys under this version; fonts that may not be sent become null."""
    p = case / 'planning/caption-style.json'
    if not p.exists():
        return 0
    style = json.loads(p.read_text())
    sent, skipped = {}, set()
    for group in ('normal', 'emphasis'):
        for item in (style.get(group) or {}).values():
            f = item.get('font')
            if not f:
                continue
            if f not in sent and f not in skipped:
                if Path(f).exists() and ofl(f):
                    h = hashlib.sha256(Path(f).read_bytes()).hexdigest()[:16]
                    rel = f'fonts/{h}{Path(f).suffix.lower() or ".otf"}'
                    put_shared(case, vid, base, rel, f) if vid else put_file(base, rel, f)
                    sent[f] = rel
                else:
                    skipped.add(f)
            item['font'] = sent.get(f)
            item.pop('font_sha256', None)
    style.pop('emphasis_designs', None)
    call('PUT', f'{base}/files/caption-style.json', data=json.dumps(style, ensure_ascii=False).encode(), ctype='application/json')
    if skipped:
        print(f'  サイトに置けない書体（OFL でない）: {len(skipped)} 個。その書体の字幕はサイトでは仮表示', file=sys.stderr)
    return len(sent)


def style_only(args):
    case = args.case.resolve()
    vid = video_id(case, args.video)
    n = put_style(case, f'/api/videos/{vid}/versions/{args.preview}', vid)
    print(json.dumps({'fonts': n}, ensure_ascii=False))


def designs_file(slug=None):
    lite, prof = lite_channel(slug)
    return lite.designs_file(prof['slug'])


def designs_push(args):
    f = designs_file(args.slug)
    args.channel = miru_channel(None, args.channel) if not args.slug else (args.channel or lite_channel(args.slug)[1].get('miru_channel') or args.slug)
    data = json.loads(f.read_text())
    if args.case and args.plan:
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        import emphasis_catalog
        emphasis_catalog.render_case(args.case.resolve(), args.case.resolve() / args.plan)
    roles = [{k: r.get(k, '') for k in ('role', 'label', 'when', 'avoid')} for r in data['roles']]
    designs = [{k: d.get(k) for k in ('id', 'role', 'name', 'style', 'status', 'memo')} for d in data['designs']]
    r = call('PUT', f'/api/channels/{args.channel}/designs', body={'roles': roles, 'designs': designs})
    sent = 0
    if args.case:
        cat = args.case.resolve() / '.akari/catalog/emphasis'
        for d in data['designs']:
            jpg = cat / f"{d['id']}.jpg"
            if jpg.exists():
                call('PUT', f"/api/channels/{args.channel}/designs/{d['id']}/image", data=jpg.read_bytes(), ctype='image/jpeg')
                sent += 1
    print(json.dumps({'designs': len(r['designs']), 'images': sent, 'link': f'{SITE}/c/{args.channel}/designs'}, ensure_ascii=False))


def designs_pull(args):
    f = designs_file(args.slug)
    args.channel = miru_channel(None, args.channel) if not args.slug else (args.channel or lite_channel(args.slug)[1].get('miru_channel') or args.slug)
    data = json.loads(f.read_text())
    site = {d['id']: d for d in call('GET', f'/api/channels/{args.channel}/designs')['designs']}
    changed = 0
    for d in data['designs']:
        s_ = site.get(d['id'])
        if not s_:
            continue
        if (d.get('status', 'open'), d.get('memo') or '') != (s_['status'], s_.get('memo') or ''):
            d['status'], d['memo'] = s_['status'], s_.get('memo') or ''
            if s_.get('decided_at'):
                import time as _t
                d['decided_at'] = _t.strftime('%Y-%m-%dT%H:%M:%S%z', _t.localtime(s_['decided_at'] / 1000))
            changed += 1
    if changed:
        import time as _t
        data['updated_at'] = _t.strftime('%Y-%m-%dT%H:%M:%S%z')
        tmp = f.with_name(f'.tmp-{f.name}')
        tmp.write_text(json.dumps(data, ensure_ascii=False, indent=1))
        tmp.replace(f)
    import collections
    print(json.dumps({'changed': changed, 'status': dict(collections.Counter(d.get('status', 'open') for d in data['designs']))}, ensure_ascii=False))


def publish(args):
    case = args.case.resolve()
    prev = case / '.akari/preview' / args.preview
    manifest = json.loads((prev / 'manifest.json').read_text())
    files = json.loads((prev / 'files.json').read_text())
    plan_path = Path(manifest['plan'])
    plan = json.loads(plan_path.read_text())
    vid = video_id(case, args.video)
    src = case / 'planning/source.json'
    title = args.title or (json.loads(src.read_text(encoding='utf-8'))['name'] if src.exists() else vid)
    args.channel = miru_channel(case, args.channel)
    try:
        made = call('POST', f'/api/channels/{args.channel}/videos', body={'id': vid, 'title': title})
    except MiruError as e:
        if e.code != 404:
            raise
        # the channel is not on MIRU yet: make it (the one who makes it is its manager)
        lite, prof = lite_channel(json.loads((case / 'planning/channel-snapshot.json').read_text(encoding='utf-8'))['slug'])
        for k in range(5):
            cid = args.channel if k == 0 else f"{prof['slug'][:60]}-{hashlib.sha256(os.urandom(8)).hexdigest()[:5]}"
            try:
                call('POST', '/api/channels', body={'id': cid, 'name': prof['name']})
                break
            except MiruError as e2:
                if e2.code != 409:        # 409: someone else on MIRU already uses the name; try another
                    raise
        else:
            raise MiruError('MIRU にチャンネルを作れませんでした（名前がぶつかり続けます）。--channel で別の名前を指定してください')
        args.channel = cid
        prof['miru_channel'] = cid
        lite.write_json(lite.channel_dir(prof['slug']) / 'channel.json', prof)
        print(f'  MIRU にチャンネル {cid} を作りました（チャンネルの記憶に記録）', file=sys.stderr)
        made = call('POST', f'/api/channels/{args.channel}/videos', body={'id': vid, 'title': title})
    if isinstance(made, dict) and made.get('id') and made['id'] != vid:
        print(f'  同じ名前が他のチャンネルにあるため、サイトでの名前は {made["id"]} になりました（.akari/miru.json に記録）', file=sys.stderr)
        vid = made['id']
    save_state(case, video=vid, channel=args.channel)
    note = version_note()
    if note:
        print(f'  ※ {note}', file=sys.stderr)
    call('POST', f'/api/videos/{vid}/versions', body={'name': args.preview, 'frames': manifest['frames'], 'fps': manifest['fps_num'] / manifest['fps_den'],
                                                       'note': f'{plan_path.name}'})
    base = f'/api/videos/{vid}/versions/{args.preview}'
    sent = 0

    # sounds the plan plays
    paths = sorted({e['path'] for e in plan.get('audio', [])} | {c['path'] for c in plan['clips'] if not c.get('mute')})
    index = {'chunk_seconds': CHUNK, 'sources': {}}
    jobs = []
    for p in paths:
        if not Path(p).exists():
            print(f'  音のもとが見つかりません（飛ばします）: {p}', file=sys.stderr)
            continue
        sid, info = audio_pieces(case, p)
        index['sources'][p] = {'id': sid, **info}
        jobs += [(f'audio/{sid}/{k}.flac', case / '.akari/cache/miru-audio' / sid / f'{k}.flac') for k in range(info['chunks'])]
    # every file of the preview
    for key, src in files.items():
        if not Path(src).exists():
            raise SystemExit(f'プレビューのファイルがありません: {key} {src}')
        s = small_video(case, src) if str(src).lower().endswith('.mp4') else Path(src)
        jobs.append((f'media/{key}', s))
    total = len(jobs)
    jn = max(1, min(8, args.jobs))
    print(f'ファイル {total} 個の中身を見分けています（前の版と同じものは上げない）', flush=True)
    with cf.ThreadPoolExecutor(jn) as ex:
        shas = list(ex.map(lambda j: sha_of(case, j[1]), jobs))
    items = [{'path': rel, 'sha': h} for (rel, _), h in zip(jobs, shas)]
    missing = link_files(base, items)
    if missing is None:          # the site has no shared store yet: every file into this version
        print(f'上げるファイル {total} 個（サイトが古いので、版ごとに全部上げます）', flush=True)
        todo = jobs
        up = lambda j: put_file(base, j[0], j[1])
    else:
        todo = list({h: (h, src) for (rel, src), h in zip(jobs, shas) if h in missing}.values())
        print(f'上げるファイル {len(todo)} 個（前の版と同じ {total - len(todo)} 個は上げずにつなぐ）', flush=True)
        up = lambda j: put_blob(case, vid, j[0], j[1])
    with cf.ThreadPoolExecutor(jn) as ex:
        for i, size in enumerate(ex.map(up, todo), 1):
            sent += size
            if i % 50 == 0 or i == len(todo):
                print(f'  {i}/{len(todo)}  {sent / 1e9:.2f} GB', flush=True)
    if missing is not None:
        left = link_files(base, items)
        if left:
            raise MiruError(f'上げたはずのファイルがサイトにありません: {len(left)} 個。もう一度 publish してください')

    durations = {}
    for p in {x['path'] for k in ('clips', 'layers', 'audio') for x in plan.get(k, []) if x.get('path')}:
        if Path(p).suffix.lower() in ('.mp4', '.mov', '.wav', '.mp3', '.m4a', '.flac', '.aac'):
            d = probe(p)
            if d is not None:
                durations[p] = d
    small = {'plan.json': plan, 'durations.json': durations, 'audio/index.json': index}
    carried = case / 'planning/carried-edits.json'
    if carried.exists():
        c = json.loads(carried.read_text())
        if c.get('preview') == args.preview:
            small['carried.json'] = c
    for rel, obj in small.items():
        call('PUT', f'{base}/files/{rel}', data=json.dumps(obj, ensure_ascii=False).encode(), ctype='application/json')
    put_style(case, base, vid)
    # the thumbnail: a frame from the middle of the longest video of the preview
    vids = [(Path(s).stat().st_size, s) for s in files.values() if str(s).lower().endswith('.mp4')]
    if vids:
        thumb = case / '.akari/cache/miru-thumb.jpg'
        src = max(vids)[1]
        mid = (probe(src) or 20) / 2
        subprocess.run(['ffmpeg', '-v', 'error', '-nostdin', '-y', '-ss', f'{mid:.2f}', '-i', str(src), '-frames:v', '1', '-vf', 'scale=640:-2', str(thumb)], check=True)
        call('PUT', f'/api/videos/{vid}/thumb', data=thumb.read_bytes(), ctype='image/jpeg')
    call('PUT', f'{base}/files/manifest.json', data=json.dumps(manifest, ensure_ascii=False).encode(), ctype='application/json')
    r = call('POST', f'{base}/ready')
    link = f'{SITE}/v/{vid}?ver={args.preview}'
    print(json.dumps({'link': link, 'bytes': r.get('bytes')}, ensure_ascii=False))


def approval_of(versions, notes):
    """The approval to act on: the newest viewable version's, when no open note came after it -> ({version, by, at} | None, stale).
    Older approvals (a later version was made, or the reviewer asked for more after approving) are stale: shown, never exported.
    versions come newest first (the site orders them by created_at). Sites before 0007 have no approvals."""
    ready = [v for v in versions if v.get('ready')]
    item = lambda v: {'version': v['name'], 'by': v.get('approved_by'), 'at': v.get('approved_at')}
    stale = [item(v) for v in ready[1:] if v.get('approved_at')]
    top = ready[0] if ready else None
    if not top or not top.get('approved_at'):
        return None, stale
    if any(n.get('status') != 'done' and (n.get('created_at') or 0) > top['approved_at'] for n in notes):
        return None, stale + [item(top)]
    return item(top), stale


def pull(args):
    """The site's notes and fixes into the case (the same files the local review page writes)."""
    case = args.case.resolve()
    vid = video_id(case, args.video)
    notes = call('GET', f'/api/videos/{vid}/notes')['notes']
    approved, stale = approval_of(call('GET', f'/api/videos/{vid}').get('versions') or [], notes)     # 見る人の「この版で OK」
    items = [{**n, 'preview': n.get('version'), 'status': 'done' if n['status'] == 'done' else 'open'} for n in notes]
    out = {'planning/review-comments.json': {'items': items}}
    for kind, f in (('caption', 'planning/caption-edits.json'), ('cut', 'planning/cut-edits.json')):
        d = call('GET', f'/api/videos/{vid}/edits/{kind}')
        out[f] = {'schema': d.get('schema') or ('review/cut-edits-v1' if kind == 'cut' else 'review/caption-edits-v1'), 'case': str(case),
                  'items': d.get('items', []), 'saved_at': d.get('saved_at')}
    hist = case / '.akari/reviews'
    hist.mkdir(parents=True, exist_ok=True)
    import time
    ts = time.strftime('%Y%m%d-%H%M%S')
    for rel, data in out.items():
        p = case / rel
        if p.exists():        # keep what was there (history), never lose a local file
            (hist / f'{p.stem}-before-pull-{ts}.json').write_text(p.read_text())
        if rel.endswith('review-comments.json') and p.exists():
            old = json.loads(p.read_text())
            keep = [x for x in old.get('items', []) if x.get('preview') != args.preview]      # notes of other previews stay
            data = {**old, 'items': keep + [x for x in data['items'] if x.get('preview') == args.preview]}
        p.write_text(json.dumps(data, ensure_ascii=False, indent=1))
    print(json.dumps({'notes': len(items), 'caption_edits': len(out['planning/caption-edits.json']['items']),
                      'cut_edits': len(out['planning/cut-edits.json']['items']), 'approved': approved, 'stale_approvals': stale}, ensure_ascii=False))


# 完成版を 1 回で送る大きさの上限（これより大きいものは分けて送り、切れても続きから送る）
ONE_SHOT = 90 * 1024 * 1024


def deliver(args):
    """The finished MP4 of a version someone approved on the site (2026-10-25). The other side downloads it from the
    video's panel. The site takes it only for an approved version and counts it in the space (9 GB on MIRU light;
    the owner can delete it there after the download). Big files go in parts and resume after a break."""
    case = args.case.resolve()
    vid = video_id(case, args.video)
    src = Path(args.file).resolve()
    if not src.is_file() or src.suffix.lower() != '.mp4':
        raise SystemExit(f'MP4 が見つかりません: {src}')
    base = f'/api/videos/{vid}/versions/{urllib.parse.quote(args.preview)}'
    size = src.stat().st_size
    try:
        if size <= ONE_SHOT:
            call('PUT', f'{base}/files/final.mp4', data=src.read_bytes(), ctype='video/mp4')
        else:
            qs = urllib.parse.urlencode({'path': 'final.mp4', 'type': 'video/mp4', 'size': size})
            resume = case / '.akari/cache/miru-upload' / f'final-{hashlib.sha256((SITE + vid).encode()).hexdigest()[:12]}-{args.preview}.json'
            multipart(f'{base}/mpu', qs, src, resume)
    except MiruError as e:
        # 返事が届かずに送り直したときなど: 同じ大きさの完成版がもう置いてあれば、渡せている
        placed = [f for f in (call('GET', f'/api/videos/{vid}').get('final') or []) if f.get('version') == args.preview] if e.code == 409 else []
        if not placed or placed[0].get('size') != size:
            raise
    print(json.dumps({'video': vid, 'preview': args.preview, 'bytes': size,
                      'next': f'相手は MIRU のホーム（{SITE}/）で動画を押すと、「完成版をダウンロード」から受け取れます'}, ensure_ascii=False))


def reply(args):
    vid = video_id(args.case.resolve(), args.video)
    body = {'reply': args.text}
    if args.status:
        body['status'] = args.status
    call('PATCH', f'/api/videos/{vid}/notes/{urllib.parse.quote(args.note)}', body=body)
    print('ok')


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest='cmd', required=True)
    p = sub.add_parser('publish')
    p.add_argument('case', type=Path)
    p.add_argument('--preview', required=True)
    p.add_argument('--channel')
    p.add_argument('--video')
    p.add_argument('--title')
    p.add_argument('--jobs', type=int, default=4, help='files sent at the same time (1..8, default 4)')
    q = sub.add_parser('pull')
    q.add_argument('case', type=Path)
    q.add_argument('--preview', required=True)
    q.add_argument('--video')
    s = sub.add_parser('style')
    s.add_argument('case', type=Path)
    s.add_argument('--preview', required=True)
    s.add_argument('--video')
    dp = sub.add_parser('designs-push')
    dp.add_argument('--channel')
    dp.add_argument('--slug')
    dp.add_argument('--case', type=Path)
    dp.add_argument('--plan', type=Path)
    dl = sub.add_parser('designs-pull')
    dl.add_argument('--channel')
    dl.add_argument('--slug')
    r = sub.add_parser('reply')
    r.add_argument('case', type=Path)
    r.add_argument('--note', required=True)
    r.add_argument('--text', required=True)
    r.add_argument('--status', choices=['open', 'doing', 'done'])
    r.add_argument('--video')
    d = sub.add_parser('deliver', help='承認された版に完成版の MP4 を置く（相手は MIRU の動画のパネルからダウンロードできる）')
    d.add_argument('case', type=Path)
    d.add_argument('--preview', required=True)
    d.add_argument('--file', required=True)
    d.add_argument('--video')
    sub.add_parser('version', help='自分の MIRU と、入っている lite の MIRU の版を比べる')
    args = ap.parse_args()
    try:
        {'publish': publish, 'pull': pull, 'reply': reply, 'style': style_only, 'designs-push': designs_push, 'designs-pull': designs_pull,
         'version': version_cmd, 'deliver': deliver}[args.cmd](args)
    except MiruError as e:
        raise SystemExit(f'MIRU: {e}')


if __name__ == '__main__':
    main()
