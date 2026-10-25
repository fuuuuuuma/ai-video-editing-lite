"""Tests that need no network, no video and no speech model:  PY -m unittest discover -s tests"""
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parents[1] / 'scripts'
sys.path.insert(0, str(SCRIPTS))
TMP = tempfile.mkdtemp(prefix='aive-lite-test-')
os.environ['AIVE_LITE_HOME'] = TMP

import lite  # noqa: E402
import build  # noqa: E402
import prepare  # noqa: E402


def run(*args):
    r = subprocess.run([sys.executable, *map(str, args)], capture_output=True, text=True, env={**os.environ, 'AIVE_LITE_HOME': TMP})
    if r.returncode:
        raise AssertionError(r.stderr)
    return r.stdout


class Memory(unittest.TestCase):
    def test_add_set_style_keeps_decisions(self):
        run(SCRIPTS / 'channel_memory.py', 'add', '--name', 'テスト', '--slug', 'mem-a')
        rows = json.loads(run(SCRIPTS / 'channel_memory.py', 'list'))
        self.assertTrue(any(r['slug'] == 'mem-a' and r['current'] for r in rows))
        d = lite.designs_file('mem-a')
        data = json.loads(d.read_text())
        data['designs'][0].update(status='reject', decided_at='2026-10-21T00:00:00+0900')       # the reviewer rejected A1
        d.write_text(json.dumps(data, ensure_ascii=False))
        style = json.loads((lite.SKILL / 'assets/style-default.json').read_text())
        style['caption']['max_chars_per_line'] = 14
        f = Path(TMP) / 'style.json'
        f.write_text(json.dumps(style, ensure_ascii=False))
        run(SCRIPTS / 'channel_memory.py', 'set-style', '--file', f, '--slug', 'mem-a')
        prof = lite.load_channel('mem-a')
        self.assertEqual(prof['style']['caption']['max_chars_per_line'], 14)
        self.assertTrue(prof['learned'])
        self.assertEqual(json.loads(d.read_text())['designs'][0]['status'], 'reject')   # kept
        run(SCRIPTS / 'channel_memory.py', 'rule', '強調は1分に1個まで', '--slug', 'mem-a')
        self.assertEqual(lite.load_channel('mem-a')['rules'][0]['text'], '強調は1分に1個まで')

    def test_slug(self):
        self.assertEqual(lite.slugify('My Channel!'), 'my-channel')
        self.assertTrue(lite.slugify('日本語だけ').startswith('ch-'))


class Words(unittest.TestCase):
    def test_filler_only_blocks(self):
        rx = prepare.filler_regex(json.loads((lite.SKILL / 'assets/style-default.json').read_text()))
        for t in ('えー', 'えーっと'.replace('っ', ''), 'あのー', 'えーあのー', 'うーん'):
            self.assertTrue(rx.match(prepare.norm(t)), t)
        for t in ('あのね', 'えーすごい', 'はい'):
            self.assertFalse(rx.match(prepare.norm(t)), t)

    def test_line_break_not_before_particle(self):
        lines = build.split_two('ゼロイチ担当してくださいっていうのを受けたことあるんですよ', 18)
        self.assertEqual(len(lines), 2)
        self.assertTrue(all(len(x) <= 18 for x in lines))
        self.assertNotIn(lines[1][0], 'をがはにでとものへや')


class Timeline(unittest.TestCase):
    def make_case(self, removals=()):
        case = Path(tempfile.mkdtemp(dir=TMP))
        (case / 'planning').mkdir()
        (case / '.akari/work').mkdir(parents=True)
        style = json.loads((lite.SKILL / 'assets/style-default.json').read_text())
        lite.write_json(case / 'planning/source.json', {'videos': [{'path': '/x.mp4', 'duration': 20.0, 'fps': '30/1', 'has_audio': True}]})
        lite.write_json(case / 'planning/channel-snapshot.json', {'slug': 't', 'style': style})
        lite.write_json(case / '.akari/work/voice-0.json', {'runs': [[1.0, 3.0], [3.2, 5.0], [9.0, 12.0]]})
        lite.write_json(case / '.akari/work/blocks-0.json', [])
        lite.write_json(case / 'planning/cuts.json', {'removals': list(removals)})
        return build.Case(case)

    def test_pauses_closed_and_removals_taken_out(self):
        c = self.make_case()
        # 1.0-5.0 (the 0.2 s pause is kept), 9.0-12.0 ; padded by 2 frames
        self.assertEqual(len(c.segments), 2)
        self.assertAlmostEqual(c.segments[0]['start'], 1.0 - 2 / 30, places=3)
        self.assertIsNone(c.frame_of(0, 7.0))          # the long silence is cut
        f = c.frame_of(0, 9.0)
        self.assertEqual(f, c.segments[1]['out_start'] + 2)
        c2 = self.make_case([{'src': 0, 'start': 2.0, 'end': 2.5, 'why': 'retake'}])
        self.assertIsNone(c2.frame_of(0, 2.2))
        self.assertEqual(len(c2.segments), 3)
        self.assertEqual(c2.total, sum(s['out_end'] - s['out_start'] for s in c2.segments))

    def test_voice_onset(self):
        c = self.make_case()
        self.assertEqual(c.voice_onset(0, 9.2), 9.0)    # Whisper late: snap back to the voice
        self.assertEqual(c.voice_onset(0, 4.0), 4.0)    # inside talk: keep


class Miru(unittest.TestCase):
    def test_video_id_is_ascii(self):
        import miru_sync
        self.assertRegex(miru_sync.default_video_id(Path('/a/20261021-テスト1')), r'^[a-z0-9][a-z0-9-]{0,69}$')
        self.assertEqual(miru_sync.default_video_id(Path('/a/20261021-my-talk')), '20261021-my-talk')

    def test_no_default_site(self):
        # 0.2.0: 共用のサイトへは上げない。自分の MIRU（~/.config/miru/url か MIRU_URL）が無ければ立て方を案内して止まる
        home = tempfile.mkdtemp(prefix='aive-lite-home-')
        env = {k: v for k, v in os.environ.items() if k not in ('MIRU_URL', 'MIRU_TOKEN')}
        env.update(HOME=home, USERPROFILE=home, MIRU_TOKEN='miru_test')
        r = subprocess.run([sys.executable, '-I', '-c', 'import sys; sys.path.insert(0, sys.argv[1]); import miru_sync; miru_sync.call("GET", "/api/me")', str(SCRIPTS)],
                           env=env, capture_output=True, text=True)
        self.assertNotEqual(r.returncode, 0)
        self.assertIn('miru-setup', r.stderr)
        self.assertNotIn('pin' + 'pon', (SCRIPTS / 'miru_sync.py').read_text() + (SCRIPTS / 'doctor.py').read_text())   # 持ち主のサイトを既定にしない
        Path(home, '.config/miru').mkdir(parents=True)
        Path(home, '.config/miru/url').write_text('https://miru.example.workers.dev/\n')
        r = subprocess.run([sys.executable, '-I', '-c', 'import sys; sys.path.insert(0, sys.argv[1]); import miru_sync; print(miru_sync.SITE)', str(SCRIPTS)],
                           env=env, capture_output=True, text=True)
        self.assertEqual(r.stdout.strip(), 'https://miru.example.workers.dev')



class MiruApproved(unittest.TestCase):
    def test_only_the_newest_version_without_later_asks(self):
        import miru_sync
        v1 = {'name': 'v1', 'ready': 1, 'approved_by': 'ed@example.com', 'approved_at': 100}
        v2 = {'name': 'v2', 'ready': 1, 'approved_by': None, 'approved_at': None}
        self.assertEqual(miru_sync.approval_of([v1], []), ({'version': 'v1', 'by': 'ed@example.com', 'at': 100}, []))
        # v1 を承認 → 直して v2 を上げた: v1 の承認は古い（書き出さない）
        self.assertEqual(miru_sync.approval_of([v2, v1], []), (None, [{'version': 'v1', 'by': 'ed@example.com', 'at': 100}]))
        # 承認のあとに「やっぱりここも」: まだ書き出さない。済んだ指示や承認の前の指示は数えない
        self.assertEqual(miru_sync.approval_of([v1], [{'status': 'open', 'created_at': 150}])[0], None)
        self.assertEqual(miru_sync.approval_of([v1], [{'status': 'done', 'created_at': 150}, {'status': 'open', 'created_at': 50}])[0]['version'], 'v1')
        # 上げ途中の版は数えない・承認の無い MIRU（0007 より前）
        self.assertEqual(miru_sync.approval_of([{'name': 'v2', 'ready': 0}, v1], [])[0]['version'], 'v1')
        self.assertEqual(miru_sync.approval_of([{'name': 'v1', 'ready': 1}], []), (None, []))


class MiruVersion(unittest.TestCase):
    def test_bundled_miru_and_version_note(self):
        # 0.2.1: lite に入っている MIRU ライトの版（tools/release-light.mjs が書く）と、立てた MIRU が古いときの案内
        import miru_sync
        b = miru_sync.bundled_version()
        self.assertGreater(b.get('build', 0), 0)
        self.assertTrue((miru_sync.MIRU_PKG / 'tools' / 'setup.mjs').exists())
        light = lambda n: {'ok': True, 'edition': 'light', 'version': {'build': n}}
        self.assertEqual(miru_sync.version_note(light(b['build'])), '')
        self.assertIn('setup.mjs', miru_sync.version_note(light(b['build'] - 1)))
        self.assertEqual(miru_sync.version_note({'ok': True, 'edition': 'personal', 'version': {'build': 0}}), '')   # 個人用の MIRU には言わない

class Utf8Relaunch(unittest.TestCase):
    """Windows で venv の python を UTF-8 モードで起動し直す所（setup.py の UTF8_MODULE）。AIVE_FORCE_UTF8 でほかの OS でも試す"""
    @classmethod
    def setUpClass(cls):
        import setup
        venv = Path(tempfile.mkdtemp(prefix='aive-utf8-')) / 'venv'
        subprocess.run([sys.executable, '-m', 'venv', '--without-pip', str(venv)], check=True)
        cls.py = venv / ('Scripts/python.exe' if os.name == 'nt' else 'bin/python')
        site = subprocess.run([str(cls.py), '-c', 'import sysconfig; print(sysconfig.get_paths()["purelib"])'],
                              capture_output=True, text=True, check=True).stdout.strip()
        setup.put_utf8(Path(site))

    def go(self, code, **extra):
        env = {k: v for k, v in os.environ.items() if k not in ('PYTHONUTF8', 'PYTHONIOENCODING', 'AIVE_UTF8_REEXEC')}
        return subprocess.run([str(self.py), '-c', code], capture_output=True, text=True, encoding='utf-8', errors='replace',
                              env={**env, 'AIVE_FORCE_UTF8': '1', **extra})

    def test_relaunch_in_utf8_mode_and_keep_exit_code(self):
        r = self.go('import sys; print(sys.flags.utf8_mode); sys.exit(3)')
        self.assertEqual((r.stdout.strip(), r.returncode), ('1', 3), r.stderr)

    def test_says_so_and_goes_on_when_it_cannot_relaunch(self):
        broken = Path(tempfile.mkdtemp(prefix='aive-utf8-broken-'))
        (broken / 'subprocess.py').write_text('raise ImportError("broken on purpose")\n', encoding='utf-8')
        r = self.go('import sys; print(sys.flags.utf8_mode)', PYTHONPATH=str(broken))
        self.assertEqual((r.stdout.strip(), r.returncode), ('0', 0), r.stderr)     # 前は何も言わずに 1 で終わっていた
        self.assertIn('aive_utf8:', r.stderr)


if __name__ == '__main__':
    unittest.main()
