"""Speech recognition on this computer (Whisper large-v3-turbo): mlx-whisper on Apple Silicon Macs,
faster-whisper elsewhere (Windows, Intel Macs, Linux). Nothing is sent anywhere.

transcribe(audio16k_float32, prompt, words=True) -> [{'text', 'start', 'end', 'words': [{'text','start','end'}]}]
"""
from __future__ import annotations

import os
import platform

MLX_REPO = os.environ.get('AIVE_LITE_MLX_MODEL', 'mlx-community/whisper-large-v3-turbo')
FW_MODEL = os.environ.get('AIVE_LITE_FW_MODEL', 'large-v3-turbo')
_fw = None


def backend() -> str:
    forced = os.environ.get('AIVE_LITE_ASR')
    if forced in ('mlx', 'faster-whisper'):
        return forced
    errors = []
    if platform.system() == 'Darwin' and platform.machine() == 'arm64':
        try:
            import mlx_whisper  # noqa: F401
            return 'mlx'
        except ImportError as e:
            errors.append(f'mlx-whisper: {e}'.splitlines()[0])
    try:
        import faster_whisper  # noqa: F401
        return 'faster-whisper'
    except ImportError as e:
        errors.append(f'faster-whisper: {e}'.splitlines()[0])
        raise SystemExit('文字起こしの道具が読めません。setup.py を実行してください（Mac は mlx-whisper、ほかは faster-whisper を入れます）\n  '
                         + '\n  '.join(errors))


def transcribe(audio, prompt=None, words=True):
    if backend() == 'mlx':
        import mlx_whisper
        r = mlx_whisper.transcribe(audio, path_or_hf_repo=MLX_REPO, language='ja', condition_on_previous_text=False,
                                   temperature=0.0, initial_prompt=prompt, word_timestamps=words)
        return [{'text': s['text'], 'start': s['start'], 'end': s['end'], 'no_speech': s.get('no_speech_prob', 0),
                 'words': [{'text': w['word'], 'start': w['start'], 'end': w['end']} for w in s.get('words', [])]}
                for s in r['segments']]
    global _fw
    if _fw is None:
        from faster_whisper import WhisperModel
        device = 'cuda' if os.environ.get('AIVE_LITE_CUDA') == '1' else 'auto'
        _fw = WhisperModel(FW_MODEL, device=device, compute_type='default')
    segs, _ = _fw.transcribe(audio, language='ja', initial_prompt=prompt, condition_on_previous_text=False,
                             temperature=0.0, word_timestamps=words, vad_filter=False)
    return [{'text': s.text, 'start': s.start, 'end': s.end, 'no_speech': s.no_speech_prob,
             'words': [{'text': w.word, 'start': w.start, 'end': w.end} for w in (s.words or [])]} for s in segs]
