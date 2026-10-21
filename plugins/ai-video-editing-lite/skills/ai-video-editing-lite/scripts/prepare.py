#!/usr/bin/env python3
"""Word-for-word transcript by voiced blocks, and a first draft of the cuts.

  prepare.py <case> [--gap 0.15]

For every video: the voice is found by level (the thresholds follow the room's noise), split at silences,
and every block is recognised ALONE with a prompt that keeps fillers and restarts (a whole-file Whisper
pass drops them, so retakes would never show up). Writes:

  .akari/work/blocks-<n>.json   blocks with word times (the first word is held at the block's start:
                                Whisper puts it up to 0.3 s early)
  .akari/work/voice-<n>.json    the voiced 10 ms runs (for cutting silences and timing captions)
  planning/transcript.txt       "b<n>-<k>  start-end  level | text" — read ALL of it before deciding cuts
  planning/cuts.json            (only if missing) removals the script is sure of: blocks that are only
                                fillers. "check" lists retake / noise candidates the agent must decide.
"""
import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import asr  # noqa: E402
import lite  # noqa: E402

SR = 16000
HOP = 160
PROMPT = 'えー、あの、えっと、まあ、なんか。言い直しも、そのまま書き起こします。'
PUNCT = re.compile(r'[、。，．,.!！?？・…「」『』（）()\s　〜~ー-]')


def load_audio(path):
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-nostdin', '-i', str(path), '-vn', '-ac', '1', '-ar', str(SR), '-f', 'f32le', '-'],
                         capture_output=True, check=True).stdout
    return np.frombuffer(raw, np.float32)


def levels(audio):
    n = len(audio) // HOP
    fr = audio[:n * HOP].reshape(n, HOP)
    rms = 20 * np.log10(np.sqrt((fr ** 2).mean(1)) + 1e-9)
    hf = 20 * np.log10(np.sqrt((np.diff(fr, axis=1) ** 2).mean(1)) + 1e-9)
    return rms, hf


def runs(mask):
    out, k, n = [], 0, len(mask)
    while k < n:
        if mask[k]:
            j = k
            while j < n and mask[j]:
                j += 1
            out.append((k, j))
            k = j
        else:
            k += 1
    return out


def blocks_of(voiced, gap_frames, min_frames=6):
    out, k, n = [], 0, len(voiced)
    while k < n:
        if voiced[k]:
            j = k
            while j < n and (voiced[j] or voiced[j:j + gap_frames].any()):
                j += 1
            if j - k >= min_frames:
                out.append((k, j))
            k = j
        else:
            k += 1
    return out


def norm(text):
    return PUNCT.sub('', text)


def filler_regex(style):
    words = sorted({w for w in style['cut'].get('fillers', [])} | {'えー', 'えっと', 'えーと', 'あのー', 'うーん', 'んー'}, key=len, reverse=True)
    alts = '|'.join(re.escape(norm(w)) + 'ー*' for w in words if norm(w))
    return re.compile(rf'^(?:(?:{alts})[ー]*)+$')


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('case', type=Path)
    ap.add_argument('--gap', type=float, default=0.15)
    a = ap.parse_args()
    case = a.case.resolve()
    src = lite.read_json(case / 'planning/source.json')
    style = lite.read_json(case / 'planning/channel-snapshot.json')['style']
    fill_re = filler_regex(style)
    keep_words = {norm(w) for w in style['cut'].get('keep_backchannel', [])}
    work = case / '.akari/work'
    work.mkdir(parents=True, exist_ok=True)
    lines, removals, check = [], [], []
    print(f'文字起こしの道具: {asr.backend()}', flush=True)
    for n, v in enumerate(src['videos']):
        if not v['has_audio']:
            print(f'  {n}: 音がないので飛ばします', file=sys.stderr)
            continue
        audio = load_audio(v['path'])
        rms, hf = levels(audio)
        rms_th = max(-40.0, float(np.percentile(rms, 5)) + 9.7)
        hf_th = max(-66.0, float(np.percentile(hf, 5)) + 7.1)
        voiced = (rms > rms_th) | (hf > hf_th)
        lite.write_json(work / f'voice-{n}.json', {'hop_seconds': HOP / SR, 'rms_db': round(rms_th, 1), 'high_band_db': round(hf_th, 1),
                                                   'runs': [[round(s * HOP / SR, 2), round(e * HOP / SR, 2)] for s, e in runs(voiced)]})
        bl = blocks_of(voiced, int(a.gap * 100))
        z = np.zeros(int(0.3 * SR), np.float32)
        out = []
        for i, (k0, k1) in enumerate(bl):
            seg = audio[max(0, (k0 - 5) * HOP):(k1 + 5) * HOP]
            res = asr.transcribe(np.concatenate([z, seg, z]), PROMPT, words=True)
            t0 = max(0, k0 - 5) * HOP / SR - 0.3
            b0, b1 = k0 * HOP / SR, k1 * HOP / SR
            words = []
            for s in res:
                for w in s['words']:
                    t = w['text'].strip()
                    if not t:
                        continue
                    ws, we = t0 + w['start'], t0 + w['end']
                    ws = min(max(ws, b0), b1)                  # Whisper puts the first word early; never before the voice
                    we = min(max(we, ws + 0.04), b1 + 0.1)
                    words.append({'text': t, 'start': round(ws, 3), 'end': round(we, 3)})
            text = ''.join(s['text'] for s in res).strip()
            ns = max([s.get('no_speech', 0) for s in res] or [1])
            out.append({'id': f'b{n}-{i:04d}', 'src': n, 'start': round(b0, 2), 'end': round(b1, 2), 'text': text,
                        'rms_max': round(float(rms[k0:k1].max()), 1), 'no_speech': round(float(ns), 2), 'words': words})
            if i % 25 == 0:
                print(f'  {n}: {i + 1}/{len(bl)}', flush=True)
        lite.write_json(work / f'blocks-{n}.json', out)
        for k, b in enumerate(out):
            lines.append(f"{b['id']}  {b['start']:8.2f}-{b['end']:8.2f}  {b['rms_max']:6.1f} | {b['text']}")
            t = norm(b['text'])
            if not t or (b['no_speech'] > 0.6 and b['rms_max'] < rms_th + 8):
                check.append({'id': b['id'], 'src': n, 'start': b['start'], 'end': b['end'], 'why': '言葉になっていない（物音・息・相手の声かも）', 'text': b['text']})
            elif t in keep_words:
                pass
            elif fill_re.match(t):
                removals.append({'id': b['id'], 'src': n, 'start': b['start'], 'end': b['end'], 'why': 'filler', 'auto': True, 'text': b['text']})
            nxt = out[k + 1] if k + 1 < len(out) else None
            if nxt and nxt['start'] - b['end'] < 3.0 and len(t) >= 2:
                u = norm(nxt['text'])
                same = 0
                while same < min(len(t), len(u)) and t[same] == u[same]:
                    same += 1
                if same >= 3 or (same >= 2 and b['end'] - b['start'] < 1.2):
                    check.append({'id': b['id'], 'src': n, 'start': b['start'], 'end': b['end'], 'why': '言い直しかも（次の塊と出だしが同じ）',
                                  'text': b['text'], 'next': nxt['text']})
    (case / 'planning/transcript.txt').write_text(
        '# 声の塊ごとの逐語の文字起こし（prepare.py）。id  元の秒  音の強さ(dB) | 文字\n'
        '# 言い直し・フィラー・物音・本編に関係ない話を、最初の行から全部読んで planning/cuts.json に書く\n' + '\n'.join(lines) + '\n',
        encoding='utf-8')
    cuts = case / 'planning/cuts.json'
    draft = {'schema': 'ai-video-editing-lite/cuts-v1',
             'note': 'removals = 映像と音から削るところ（元の動画の秒）。why: filler / retake / noise / offtopic / pause。'
                     'auto=true は prepare.py が「フィラーだけの塊」と判断したもの。check は確かめてから removals に移すか消す。'
                     '1 つの塊の中の一部だけを削るときは、words の秒で start / end を書く。',
             'removals': removals, 'check': check}
    target = cuts if not cuts.exists() else case / 'planning/cuts-suggested.json'
    lite.write_json(target, draft)
    print(json.dumps({'blocks': len(lines), 'auto_filler_removals': len(removals), 'to_check': len(check),
                      'transcript': str(case / 'planning/transcript.txt'), 'cuts': str(target)}, ensure_ascii=False, indent=1))


if __name__ == '__main__':
    main()
