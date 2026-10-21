#!/usr/bin/env python3
"""Local review page for a built preview (build_review_preview.py).

Serves the review page, the preview manifest and its media (HTTP Range, so video can
seek), and reads/writes the reviewer's timecoded revision notes:

  <case>/planning/review-comments.json   current notes (the agent reads this)
  <case>/planning/caption-edits.json     captions retyped / added / hidden / retimed on the page
                                          (shown at once; the next version uses them too)
  <case>/planning/cut-edits.json         cuts restored / added on the page: the server rebuilds
                                          the preview timeline and a quick audio mix at once
                                          (review_edits.py; the export applies the same edits)
  <case>/planning/carried-edits.json     the hand fixes of earlier versions carried into this one,
                                          each checked against its plan (shown in the 手直し tab)
  <case>/.akari/reviews/*.json            a copy of every save (history)

A Point / emphasis whose time is changed on the page takes its SE (and an emphasis its push-in)
along: the server rebuilds the timeline and the mix for those moves too.

Listens on 127.0.0.1 only. Media is limited to the files listed in the preview's
files.json; no other path on disk can be requested.
"""
import argparse
import json
import mimetypes
import os
import re
import hashlib
import socket
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse

sys.path.insert(0, str(Path(__file__).resolve().parent))
import caption_edits  # noqa: E402
import caption_style  # noqa: E402
import emphasis_catalog  # noqa: E402
import review_edits  # noqa: E402

PAGE = Path(__file__).resolve().parents[1] / 'assets/review/index.html'
STYLES_PAGE = Path(__file__).resolve().parents[1] / 'assets/review/styles.html'   # emphasis design catalog (emphasis_catalog.py)
SCHEMA = 'ai-video-editing-lite/review-comments-v1'
MAX_BODY = 20 << 20
MAX_EDITS_BODY = 2 << 20
mimetypes.add_type('video/mp4', '.mp4')
mimetypes.add_type('audio/mp4', '.m4a')
mimetypes.add_type('image/png', '.png')
mimetypes.add_type('audio/wav', '.wav')
mimetypes.add_type('image/jpeg', '.jpg')
KEEP_MIXES = 4


class Review:
    def __init__(self, case, preview):
        self.case = Path(case).resolve()
        self.set_preview(preview)
        self.comments_path = self.case / 'planning/review-comments.json'
        self.edits_path = caption_edits.path_of(self.case)
        self.cuts_path = review_edits.path_of(self.case)
        self.history = self.case / '.akari/reviews'
        self.mix_dir = self.case / '.akari/cache/preview-audio'
        self.pcm = review_edits.Pcm(self.case / '.akari/cache/preview-pcm')
        self.lock = threading.Lock()

    def set_preview(self, preview):
        base = self.case / '.akari/preview'
        if preview is None:
            built = sorted(base.glob('*/manifest.json'), key=lambda p: p.stat().st_mtime)
            if not built:
                raise SystemExit(f'no preview under {base}; run build_review_preview.py first')
            preview = built[-1].parent.name
        self.preview = preview
        self.dir = base / preview
        self.manifest = json.loads((self.dir / 'manifest.json').read_text(encoding='utf-8'))
        self.files = json.loads((self.dir / 'files.json').read_text(encoding='utf-8'))
        self.extra = {}          # media keys added for quick mixes of the edited timeline
        self.edited = None       # (cut_rev, manifest) of the current cut edits
        self.base_plan = None

    # ---------------------------------------------------------------- cut edits
    def load_cut_edits(self):
        return review_edits.load(self.case)

    def plan(self):
        if self.base_plan is None:
            path = Path(self.manifest['plan'])
            text = path.read_bytes()
            if self.manifest.get('plan_sha256') and hashlib.sha256(text).hexdigest() != self.manifest['plan_sha256']:
                raise ValueError(f'{path.name} changed after this preview was built; build the preview again to edit cuts')
            self.base_plan = json.loads(text)
        return self.base_plan

    def edited_manifest(self):
        """The preview manifest with this preview's cut edits applied (rebuilt when they change)."""
        items = review_edits.items_for(self.case, self.preview)
        follow = self.follow_items()
        base = {**self.manifest, 'cut_rev': '', 'follow_rev': '', 'cut_warnings': [], 'cut_check': None, 'retimed': [],
                'caption_style': caption_style.path_of(self.case).exists()}
        if not items and not follow:
            return base
        digest = lambda x: hashlib.sha256(json.dumps(x, ensure_ascii=False, sort_keys=True).encode()).hexdigest()[:16]  # noqa: E731
        rev, frev = (digest(items) if items else ''), (digest(follow) if follow else '')
        with self.lock:
            if self.edited and self.edited[0] == (rev, frev):
                return self.edited[1]
            started = time.monotonic()
            plan, ed = review_edits.apply_all(self.plan(), items, follow, keep_origin=True, duration_of=self.duration, check=True)
            m = self.manifest
            clips = [{**m['clips'][c['_o']], 'i': i, 'src': float(c.get('source_start_seconds', 0)),
                      'start': c['start'], 'end': c['end']} for i, c in enumerate(plan['clips'])]
            layers = []
            for i, L in enumerate(plan.get('layers', [])):
                item = {**m['layers'][L['_o']], 'i': i, 'start': L['start'], 'end': L['end']}
                for k in ('x', 'y', 'width', 'height'):      # an image put in another box on the page
                    if k in L:
                        item[k] = L[k]
                if 'keyframes' in L:
                    item['keyframes'] = L['keyframes']
                if L.get('type') == 'video':
                    item['src'] = float(L.get('source_start_seconds', 0))
                layers.append(item)
            camera = [{k: v for k, v in c.items() if k != '_o'} for c in plan.get('camera', [])]
            audio = self.quick_mix(plan)
            marks = review_edits.remap_spans(m.get('marks', []), ed.ops)
            for r in ed.retimed:       # the moved emphasis / Point / large QR mark follows
                kind = {'large_qr': 'qr'}.get(r['kind'], r['kind'])
                for mk in marks:
                    if mk['kind'] == kind and mk['start'] == r['from'][0]:
                        mk['start'], mk['end'] = r['to']
                        break
            out = {**base, 'frames': plan['frames'], 'clips': clips, 'layers': layers, 'camera': camera,
                   'marks': marks, 'audio': audio, 'cut_rev': rev, 'follow_rev': frev, 'cut_warnings': ed.warnings, 'cut_ops': ed.ops,
                   'cut_check': ed.report, 'retimed': ed.retimed, 'cut_seconds': round(time.monotonic() - started, 2)}
            self.edited = ((rev, frev), out)
            return out

    def duration(self, path):
        # the file's own length (ffprobe): also right for videos without sound (the large QR background)
        return review_edits.probe_duration(path)

    def caption_image(self, body):
        """A retyped caption drawn like the export (planning/caption-style.json): media key and place."""
        style = caption_style.load(self.case)
        if not style:
            raise ValueError('no planning/caption-style.json for this case')
        kind = 'emphasis' if body.get('kind') == 'emphasis' else 'normal'
        text = body.get('text')
        if not isinstance(text, str) or not text.strip() or len(text) > 200 or text.count('\n') > 1:
            raise ValueError('text of 1-2 lines required')
        png, x, y = caption_style.render(style, kind, text, body.get('speaker') or 'K', body.get('role'),
                                         self.case / '.akari/cache/caption-edit-png')
        path = str(png)
        key = next((k for k, v in self.extra.items() if v == path), None)
        if key is None:
            key = f'e{sum(1 for k in self.extra if k[0] == "e") + 1:04d}'
            self.extra[key] = path
        return {'media': key, 'x': x, 'y': y, 'v': png.stem}

    def quick_mix(self, plan):
        keep = {'frames': plan['frames'], 'fps': str(plan['fps']), 'master': plan.get('master_gain_db', 0),
                'clips': [{k: c.get(k) for k in ('path', 'source_start_seconds', 'start', 'end', 'gain_db',
                                                 'fade_in_frames', 'fade_out_frames', 'keyframes')}
                          for c in plan['clips'] if not c.get('mute')],
                'audio': [{k: v for k, v in a.items() if k != '_o'} for a in plan.get('audio', [])]}
        key = hashlib.sha256(json.dumps(keep, ensure_ascii=False, sort_keys=True).encode()).hexdigest()[:20]
        self.mix_dir.mkdir(parents=True, exist_ok=True)
        out = self.mix_dir / f'q-{key}.wav'
        if not out.exists():
            review_edits.quick_mix(plan, out, self.pcm)
        os.utime(out)
        old = sorted(self.mix_dir.glob('q-*.wav'), key=lambda p: p.stat().st_mtime, reverse=True)[KEEP_MIXES:]
        for p in old:          # only this server's own quick mixes are pruned
            if p != out:
                p.unlink(missing_ok=True)
        path = str(out)
        for k, v in self.extra.items():
            if v == path:
                return k
        k = f'q{sum(1 for k in self.extra if k[0] == "q") + 1:04d}'
        self.extra[k] = path
        return k

    # ---------------------------------------------------------------- emphasis designs of the channel
    designs_path = None     # None: the channel list in the skill (tests point it elsewhere)

    def style_catalog(self):
        """The channel's emphasis designs (rejected ones left out) with this case's samples."""
        idx = emphasis_catalog.catalog_for_page(self.case, self.designs_path)
        for r in idx['roles']:
            for d in r['designs']:
                path = d.pop('image', None)
                if not path or not Path(path).exists():
                    continue
                key = next((k for k, v in self.extra.items() if v == path), None)
                if key is None:
                    key = f's{sum(1 for k in self.extra if k[0] == "s") + 1:04d}'
                    self.extra[key] = path
                d['media'] = key
                d['v'] = str(int(Path(path).stat().st_mtime))
        return idx

    def save_style_choices(self, data):
        ch = data.get('choices') if isinstance(data, dict) else None
        saved = emphasis_catalog.set_choices(ch, self.designs_path)
        self.history.mkdir(parents=True, exist_ok=True)
        (self.history / f"emphasis-designs-{time.strftime('%Y%m%d-%H%M%S')}.json").write_text(
            json.dumps(saved, ensure_ascii=False, indent=1), encoding='utf-8')
        return {'saved_at': saved['updated_at'], 'counts': {s: sum(1 for d in saved['designs'] if d.get('status') == s)
                                                             for s in emphasis_catalog.STATES}}

    def save_cut_edits(self, data):
        review_edits.validate(data)
        data = {'schema': review_edits.SCHEMA, 'case': str(self.case), 'items': data['items'],
                'saved_at': time.strftime('%Y-%m-%dT%H:%M:%S%z')}
        self._write(self.cuts_path, data, 'cut-edits')
        return data

    def previews(self):
        base = self.case / '.akari/preview'
        return sorted(p.parent.name for p in base.glob('*/manifest.json'))

    def load_comments(self):
        if self.comments_path.exists():
            return json.loads(self.comments_path.read_text(encoding='utf-8'))
        return {'schema': SCHEMA, 'case': str(self.case), 'items': []}

    def _write(self, path, data, history_name):
        text = json.dumps(data, ensure_ascii=False, indent=1)
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(f'.tmp-review-{os.getpid()}-{path.stem}.json')
        tmp.write_text(text, encoding='utf-8')
        tmp.replace(path)
        self.history.mkdir(parents=True, exist_ok=True)
        (self.history / f"{history_name}-{time.strftime('%Y%m%d-%H%M%S')}.json").write_text(text, encoding='utf-8')

    def save_comments(self, data):
        if not isinstance(data, dict) or not isinstance(data.get('items'), list):
            raise ValueError('items list required')
        data = {**data, 'schema': SCHEMA, 'case': str(self.case),
                'saved_at': time.strftime('%Y-%m-%dT%H:%M:%S%z')}
        self._write(self.comments_path, data, 'comments')
        return data

    def load_caption_edits(self):
        return caption_edits.load(self.case)

    def follow_items(self):
        """Point / emphasis times moved on this preview: their SE and push-in follow (user note v9)."""
        return [it for it in self.load_caption_edits().get('items', []) if it.get('op') == 'time'
                and it.get('preview') == self.preview and it.get('caption_kind') in ('point', 'emphasis')]

    def carried(self):
        """Hand fixes of earlier versions baked into this preview's plan, each with its check."""
        path = self.case / 'planning/carried-edits.json'
        try:
            data = json.loads(path.read_text(encoding='utf-8'))
        except (OSError, ValueError):
            return {'items': []}
        return data if data.get('preview') == self.preview else {'items': []}

    def save_caption_edits(self, data):
        caption_edits.validate(data)
        data = {'schema': caption_edits.SCHEMA, 'case': str(self.case), 'items': data['items'],
                'saved_at': time.strftime('%Y-%m-%dT%H:%M:%S%z')}
        self._write(self.edits_path, data, 'caption-edits')
        return data


def make_handler(review):
    class Handler(BaseHTTPRequestHandler):
        server_version = 'lite-review/1'

        def log_message(self, fmt, *args):
            if os.environ.get('REVIEW_LOG'):
                sys.stderr.write(fmt % args + '\n')

        def send_json(self, obj, status=200):
            body = json.dumps(obj, ensure_ascii=False).encode('utf-8')
            self.send_response(status)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()
            self.wfile.write(body)

        def send_file(self, path, head=False, cache='private, max-age=3600'):
            size = path.stat().st_size
            ctype = mimetypes.guess_type(str(path))[0] or 'application/octet-stream'
            rng = self.headers.get('Range')
            start, end = 0, size - 1
            status = 200
            if rng:
                m = re.match(r'bytes=(\d*)-(\d*)$', rng.strip())
                if not m:
                    self.send_response(416); self.end_headers(); return
                if m.group(1):
                    start = int(m.group(1))
                    end = int(m.group(2)) if m.group(2) else size - 1
                else:
                    start = max(0, size - int(m.group(2)))
                end = min(end, size - 1)
                if start > end:
                    self.send_response(416)
                    self.send_header('Content-Range', f'bytes */{size}')
                    self.end_headers(); return
                status = 206
            self.send_response(status)
            self.send_header('Content-Type', ctype)
            self.send_header('Accept-Ranges', 'bytes')
            self.send_header('Content-Length', str(end - start + 1))
            if status == 206:
                self.send_header('Content-Range', f'bytes {start}-{end}/{size}')
            self.send_header('Cache-Control', cache)
            self.end_headers()
            if head:
                return
            with open(path, 'rb') as f:
                f.seek(start)
                left = end - start + 1
                try:
                    while left > 0:
                        chunk = f.read(min(1 << 20, left))
                        if not chunk:
                            break
                        self.wfile.write(chunk)
                        left -= len(chunk)
                except (BrokenPipeError, ConnectionResetError):
                    pass

        def route(self, head=False):
            path = unquote(urlparse(self.path).path)
            if path in ('/', '/index.html'):
                return self.send_file(PAGE, head, cache='no-store')
            if path in ('/styles', '/styles.html'):
                return self.send_file(STYLES_PAGE, head, cache='no-store')
            if path == '/api/style-catalog':
                try:
                    return self.send_json(review.style_catalog())
                except (ValueError, OSError) as e:
                    return self.send_json({'error': str(e)}, 404)
            if path == '/api/manifest':
                try:
                    man = review.edited_manifest()
                except (ValueError, OSError, KeyError, IndexError) as e:
                    man = {**review.manifest, 'cut_rev': '', 'cut_error': str(e)}
                return self.send_json({**man, 'previews': review.previews(),
                                       'comments_file': str(review.comments_path),
                                       'caption_edits_file': str(review.edits_path),
                                       'cut_edits_file': str(review.cuts_path)})
            if path == '/api/comments':
                return self.send_json(review.load_comments())
            if path == '/api/caption-edits':
                return self.send_json(review.load_caption_edits())
            if path == '/api/cut-edits':
                return self.send_json(review.load_cut_edits())
            if path == '/api/carried':
                return self.send_json(review.carried())
            if path == '/api/previews':
                return self.send_json({'current': review.preview, 'previews': review.previews()})
            m = re.match(r'^/media/([a-z]\d{4})$', path)
            if m and m.group(1) in review.files:
                return self.send_file(Path(review.files[m.group(1)]), head)
            if m and m.group(1) in review.extra:
                return self.send_file(Path(review.extra[m.group(1)]), head)
            self.send_json({'error': 'not found'}, 404)

        def do_GET(self):
            self.route()

        def do_HEAD(self):
            self.route(head=True)

        def do_POST(self):
            path = urlparse(self.path).path
            length = int(self.headers.get('Content-Length') or 0)
            if length > (MAX_EDITS_BODY if path in ('/api/caption-edits', '/api/cut-edits') else MAX_BODY):
                return self.send_json({'error': 'too large'}, 413)
            try:
                body = json.loads(self.rfile.read(length) or b'{}')
                if path == '/api/comments':
                    return self.send_json(review.save_comments(body))
                if path == '/api/caption-edits':
                    saved = review.save_caption_edits(body)
                    try:                   # a moved Point / emphasis takes its SE and push-in along
                        man = review.edited_manifest()
                    except (ValueError, OSError, KeyError, IndexError):
                        man = None
                    return self.send_json({**saved, 'manifest': man})
                if path == '/api/cut-edits':
                    saved = review.save_cut_edits(body)
                    review.plan()          # refuse early when the plan changed under the preview
                    return self.send_json({**saved, 'manifest': review.edited_manifest()})
                if path == '/api/style-choices':
                    return self.send_json(review.save_style_choices(body))
                if path == '/api/caption-image':
                    return self.send_json(review.caption_image(body))
                if path == '/api/preview':
                    review.set_preview(body.get('name'))
                    return self.send_json({'ok': True, 'name': review.preview})
            except (ValueError, OSError, KeyError, IndexError) as e:
                return self.send_json({'error': str(e)}, 400)
            self.send_json({'error': 'not found'}, 404)
    return Handler


def free_port(preferred):
    for port in [preferred] + list(range(preferred + 1, preferred + 50)):
        with socket.socket() as s:
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                s.bind(('127.0.0.1', port))
                return port
            except OSError:
                continue
    raise SystemExit('no free port')


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('case', type=Path)
    ap.add_argument('--preview', help='preview name (default: the newest under .akari/preview)')
    ap.add_argument('--port', type=int, default=8765)
    args = ap.parse_args()
    review = Review(args.case, args.preview)
    snap = args.case.resolve() / 'planning/channel-snapshot.json'
    if snap.exists():          # the emphasis designs of this case's channel
        import lite
        review.designs_path = lite.designs_file(json.loads(snap.read_text(encoding='utf-8'))['slug'])
    port = free_port(args.port)
    httpd = ThreadingHTTPServer(('127.0.0.1', port), make_handler(review))
    print(json.dumps({'url': f'http://localhost:{port}/', 'preview': review.preview,
                      'comments_file': str(review.comments_path),
                      'caption_edits_file': str(review.edits_path)}, ensure_ascii=False), flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == '__main__':
    main()
