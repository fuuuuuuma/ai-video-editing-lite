#!/usr/bin/env python3
"""Render an explicit frame plan using FFmpeg, Pillow and OpenCV; no Adobe app/API.

This renderer executes editorial decisions. It does not select cuts, transcribe
speech, reconstruct arbitrary Premiere effects, or certify perceptual quality.
See references/offline-editing.md for the plan contract and limitations.

The engine supports a short ``--preview`` render, content-addressed output and
clip caches (``--cache`` / ``--no-cache``), and bounded clip parallelism
(``--jobs 1..8``). It always writes a new output and a portable evidence
package; visual reference matching and full listening remain human review gates.
"""
import argparse
from datetime import datetime, timezone
from fractions import Fraction
import hashlib
import json
import math
import os
import shutil
from pathlib import Path
import subprocess
import sys
import time
import uuid

import cv2
import numpy as np
from PIL import Image, ImageColor, ImageDraw, ImageFont
from caption_continuity import validate_render_layers
from validate_event_links import validate as validate_event_links
from speaker_captions import validate_speakers
from styled_text import make_text_image
from fonts import resolve_plan_fonts

RATE = 48000
RENDER_VERSION = 'offline-engine-2'


def stop_process(process):
    """Close pipes before waiting: a blocked FFmpeg writer may not exit on SIGTERM."""
    for stream in (process.stdout, process.stdin):
        if stream and not stream.closed:
            try:
                stream.close()
            except OSError:
                pass
    if process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()


def probe(path):
    return json.loads(subprocess.check_output(['ffprobe', '-v', 'error',
        '-show_streams', '-show_format', '-of', 'json', str(path)]))


def sha256_file(path, chunk_size=1 << 20):
    digest = hashlib.sha256()
    with open(path, 'rb') as handle:
        for chunk in iter(lambda: handle.read(chunk_size), b''):
            digest.update(chunk)
    return digest.hexdigest()


def ffmpeg_version():
    return subprocess.check_output(['ffmpeg', '-version'], text=True,
        encoding='utf-8', errors='replace').splitlines()[0]


def referenced_paths(plan):
    """Return every file whose contents can affect a rendered frame or sample."""
    paths = set()
    for clip in plan.get('clips', []):
        paths.add(file_path(clip['path']))
    for layer in plan.get('layers', []):
        if layer.get('type') in ('image', 'video'):
            paths.add(file_path(layer['path']))
        elif layer.get('type') == 'text':
            paths.add(file_path(layer['font']))
    for item in plan.get('audio', []):
        paths.add(file_path(item['path']))
    return sorted(paths, key=lambda path: str(path))


def render_cache_key(plan, paths):
    """Build a content-addressed key; mtimes and output names never affect it."""
    files = [{'path': str(path), 'sha256': sha256_file(path)} for path in paths]
    environment = {
        'renderer': RENDER_VERSION,
        'renderer_sha256': sha256_file(Path(__file__).resolve()),
        'ffmpeg': ffmpeg_version(),
        'python': sys.version.split()[0],
        'pillow': getattr(__import__('PIL'), '__version__', 'unknown'),
        'opencv': getattr(cv2, '__version__', 'unknown'),
    }
    payload = {'plan': plan, 'files': files, 'environment': environment}
    encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True,
        separators=(',', ':')).encode('utf-8')
    return hashlib.sha256(encoded).hexdigest(), payload


def cache_entry(cache_dir, key):
    cache_dir.mkdir(parents=True, exist_ok=True)
    return cache_dir / f'{key}.mp4', cache_dir / f'{key}.json'


def cache_is_valid(payload, marker, expected):
    if not payload.is_file() or not marker.is_file():
        return False
    try:
        record = json.loads(marker.read_text(encoding='utf-8'))
        if record.get('payload_sha256') != sha256_file(payload):
            return False
        if record.get('key') != expected['key']:
            return False
        metadata = probe(payload)
        stream = next(s for s in metadata['streams'] if s['codec_type'] == 'video')
        return (int(stream.get('nb_frames', 0)) == expected['frames']
                and int(stream.get('width', 0)) == expected['width']
                and int(stream.get('height', 0)) == expected['height'])
    except (OSError, ValueError, KeyError, StopIteration, TypeError):
        return False


def store_cache(payload, marker, key, plan, result):
    """Store a verified output and marker without replacing an existing entry."""
    temp_payload = payload.with_name(f'.tmp-{uuid.uuid4().hex}.mp4')
    temp_marker = marker.with_name(f'.tmp-{uuid.uuid4().hex}.json')
    try:
        shutil.copy2(result['output'], temp_payload)
        record = {
            'key': key,
            'payload_sha256': sha256_file(temp_payload),
            'frames': result['frames'],
            'width': result['width'],
            'height': result['height'],
            'plan_sha256': hashlib.sha256(json.dumps(plan, ensure_ascii=False,
                sort_keys=True, separators=(',', ':')).encode('utf-8')).hexdigest(),
            'created_at': datetime.now(timezone.utc).isoformat(),
        }
        temp_marker.write_text(json.dumps(record, ensure_ascii=False, indent=2), encoding='utf-8')
        # The cache key is immutable from the plan's point of view. If a
        # previous process left a payload or marker half-written, replace the
        # pair with this verified result instead of creating a marker that
        # points at stale bytes.
        os.replace(temp_payload, payload)
        os.replace(temp_marker, marker)
    finally:
        temp_payload.unlink(missing_ok=True)
        temp_marker.unlink(missing_ok=True)


def frame_timecode(frame, fps):
    seconds = float(Fraction(frame, 1) / fps)
    hours = int(seconds // 3600)
    minutes = int((seconds % 3600) // 60)
    whole = int(seconds % 60)
    millis = int(round((seconds - int(seconds)) * 1000))
    if millis == 1000:
        whole += 1
        millis = 0
    if whole == 60:
        minutes += 1
        whole = 0
    if minutes == 60:
        hours += 1
        minutes = 0
    return f'{hours:02}:{minutes:02}:{whole:02},{millis:03}'


def write_render_artifacts(plan, fps, job, result, stages):
    """Write a portable evidence package beside every render, including cache hits."""
    clips = []
    for clip in plan.get('clips', []):
        clips.append({
            'id': clip.get('id'),
            'source': clip['path'],
            'source_start_seconds': clip.get('source_start_seconds', 0),
            'output_start_frame': clip['start'],
            'output_end_frame': clip['end'],
            'output_start_seconds': float(Fraction(clip['start'], 1) / fps),
            'output_end_seconds': float(Fraction(clip['end'], 1) / fps),
            'frames': clip['end'] - clip['start'],
            'mute': bool(clip.get('mute', False)),
        })
    layers = []
    captions = {}
    for index, layer in enumerate(plan.get('layers', [])):
        item = dict(layer)
        item['index'] = index
        layers.append(item)
        if layer.get('role') == 'caption' and layer.get('caption_id') and layer.get('text'):
            cid = layer['caption_id']
            current = captions.setdefault(cid, {
                'id': cid, 'start': layer['start'], 'end': layer['end'],
                'text': layer['text']})
            current['start'] = min(current['start'], layer['start'])
            current['end'] = max(current['end'], layer['end'])
    timeline = {
        'render_version': RENDER_VERSION,
        'fps': str(fps),
        'frames': plan['frames'],
        'duration_seconds': float(Fraction(plan['frames'], 1) / fps),
        'clips': clips,
        'layers': layers,
        'audio': plan.get('audio', []),
        'caption_policy': plan.get('caption_policy', {}),
        'result': result,
    }
    (job / 'timeline.json').write_text(json.dumps(timeline, ensure_ascii=False, indent=2), encoding='utf-8')
    srt = []
    for number, caption in enumerate(sorted(captions.values(), key=lambda item: (item['start'], item['end'])), 1):
        srt.append(f"{number}\n{frame_timecode(caption['start'], fps)} --> {frame_timecode(caption['end'], fps)}\n{caption['text']}\n")
    (job / 'captions.srt').write_text('\n'.join(srt), encoding='utf-8')
    stages_payload = dict(stages)
    stages_payload.update({
        'render_version': RENDER_VERSION,
        'renderer_sha256': sha256_file(Path(__file__).resolve()),
        'ffmpeg': ffmpeg_version(),
        'source_sha256': {str(path): sha256_file(path) for path in referenced_paths(plan)},
        'output_sha256': (sha256_file(result['output']) if Path(result['output']).is_file() else None),
        'video_clip_cache': result.get('video_clip_cache'),
        'jobs': result.get('jobs', 1),
    })
    (job / 'stages.json').write_text(json.dumps(stages_payload, ensure_ascii=False, indent=2), encoding='utf-8')


def truncate_plan(plan, frames):
    """Create a first-seconds preview without changing source timing or editorial decisions."""
    preview = json.loads(json.dumps(plan, ensure_ascii=False))
    preview['frames'] = frames
    preview['clips'] = [dict(clip, end=min(clip['end'], frames)) for clip in plan.get('clips', [])
                        if clip['start'] < frames and min(clip['end'], frames) > clip['start']]
    preview['layers'] = [dict(layer, end=min(layer['end'], frames)) for layer in plan.get('layers', [])
                         if layer['start'] < frames and min(layer['end'], frames) > layer['start']]
    for key in ('camera', 'audio'):
        preview[key] = [dict(item, end=min(item['end'], frames)) for item in plan.get(key, [])
                        if item['start'] < frames and min(item['end'], frames) > item['start']]
    policy = preview.get('caption_policy')
    if policy:
        policy['continuous_regions'] = [dict(item, end=min(item['end'], frames)) for item in policy.get('continuous_regions', [])
                                        if item['start'] < frames and min(item['end'], frames) > item['start']]
        policy['excluded_regions'] = [dict(item, end=min(item['end'], frames)) for item in policy.get('excluded_regions', [])
                                      if item['start'] < frames and min(item['end'], frames) > item['start']]
    return preview


def sample_at(frame, fps):
    return round(Fraction(frame * RATE, 1) / fps)


def file_path(value):
    p = Path(value)
    if not p.is_absolute() or not p.is_file():
        raise ValueError(f'Existing absolute file path required: {value}')
    return p


def number(value, label):
    if not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(value):
        raise ValueError(f'{label}: finite number required')
    return value


def interval(item, total, label):
    a, b = item.get('start'), item.get('end')
    if type(a) is not int or type(b) is not int or not 0 <= a < b <= total:
        raise ValueError(f'{label}: integer [start,end) within the output required')


def curve(item, field, frame, default):
    base = item.get(field, default)
    keys = [(k['frame'], k[field], k.get('interpolation', 'linear'))
        for k in item.get('keyframes', []) if field in k]
    if not keys:
        return float(base)
    if frame < keys[0][0]:
        return float(base)
    for left, right in zip(keys, keys[1:]):
        if left[0] <= frame < right[0]:
            if left[2] == 'hold':
                return float(left[1])
            u = (frame-left[0])/(right[0]-left[0])
            if left[2] == 'smoothstep':
                u = u*u*(3-2*u)
            return float(left[1] + (right[1]-left[1])*u)
    return float(keys[-1][1])


def validate(plan):
    if plan.get('version') != 1:
        raise ValueError('version must be 1')
    fps = Fraction(str(plan['fps']))
    if not 0 < fps <= 120:
        raise ValueError('fps must be in (0,120]')
    w, h, total = (plan[k] for k in ('width', 'height', 'frames'))
    if any(type(v) is not int or v < 1 for v in (w, h, total)) or w % 2 or h % 2:
        raise ValueError('Positive frame count and positive even canvas dimensions required')
    validate_render_layers(plan)
    validate_speakers(plan)
    end, media = 0, {}
    for i, clip in enumerate(plan.get('clips', [])):
        interval(clip, total, f'clip {i}')
        if clip['start'] != end:
            raise ValueError('Camera clips must cover the output once, without gaps or overlap')
        source = str(file_path(clip['path']))
        media[source] = media[source] if source in media else probe(source)
        if not any(s['codec_type'] == 'video' for s in media[source]['streams']):
            raise ValueError(f'No video stream: {source}')
        offset = number(clip.get('source_start_seconds', 0), 'source_start_seconds')
        if offset < 0:
            raise ValueError('source_start_seconds must not be negative')
        duration = float(media[source]['format']['duration'])
        if offset + float(Fraction(clip['end']-clip['start'],1)/fps) > duration + float(1/fps):
            raise ValueError(f'Clip exceeds source duration: {source}')
        end = clip['end']
    if end != total:
        raise ValueError('Camera clips do not cover all frames')
    for kind in ('camera', 'layers', 'audio'):
        previous_end = 0
        for i, item in enumerate(plan.get(kind, [])):
            interval(item, total, f'{kind} {i}')
            if kind == 'camera' and item['start'] < previous_end:
                raise ValueError('Camera intervals must be ordered and non-overlapping')
            previous_end = item['end']
            keys = item.get('keyframes', [])
            if any(type(k.get('frame')) is not int for k in keys):
                raise ValueError('Keyframes require integer output frame numbers')
            if any(a['frame'] >= b['frame'] for a,b in zip(keys,keys[1:])):
                raise ValueError('Keyframes must be strictly ordered')
            for key in keys:
                if key.get('interpolation','linear') not in ('linear','hold','smoothstep'):
                    raise ValueError('Unsupported interpolation')
            if kind == 'layers':
                if item.get('type') == 'video':
                    source = str(file_path(item['path']))
                    media[source] = media[source] if source in media else probe(source)
                    stream = next((s for s in media[source]['streams'] if s['codec_type'] == 'video'), None)
                    if stream is None:
                        raise ValueError('Video overlay has no video stream')
                    if any(type(item.get(k)) is not int or item[k] <= 0 for k in ('width', 'height')):
                        raise ValueError('Video overlay needs explicit positive width/height')
                    offset = number(item.get('source_start_seconds', 0), 'overlay source_start_seconds')
                    if offset < 0 or offset+float((item['end']-item['start'])/fps) > float(media[source]['format']['duration'])+float(1/fps):
                        raise ValueError('Video overlay exceeds its source')
                    if item.get('mask') not in (None, 'circle'):
                        raise ValueError('Unsupported video mask')
                    if item.get('mask') == 'circle' and item['width'] != item['height']:
                        raise ValueError('Circle wipe requires square bounds')
                    crop = item.get('source_crop')
                    if crop and (any(type(crop.get(k)) is not int for k in ('x', 'y', 'width', 'height'))
                        or min(crop['x'], crop['y']) < 0 or min(crop['width'], crop['height']) <= 0
                        or crop['x']+crop['width'] > stream['width'] or crop['y']+crop['height'] > stream['height']):
                        raise ValueError('Video overlay crop exceeds source bounds')
                elif item.get('type') == 'image':
                    file_path(item['path'])
                elif item.get('type') == 'text':
                    file_path(item['font'])
                elif item.get('type') != 'rect':
                    raise ValueError('Layer type must be video, image, text or rect')
            if kind == 'audio':
                source = str(file_path(item['path']))
                media[source] = media[source] if source in media else probe(source)
                if not any(s['codec_type'] == 'audio' for s in media[source]['streams']):
                    raise ValueError(f'No audio stream: {source}')
    for f in range(total):
        shot = next((s for s in plan.get('camera',[]) if s['start'] <= f < s['end']), {})
        scale = curve(shot, 'scale', f, 1)
        cx, cy = curve(shot,'cx',f,.5), curve(shot,'cy',f,.5)
        if not (scale >= 1 and .5/scale-1e-6 <= cx <= 1-.5/scale+1e-6
                and .5/scale-1e-6 <= cy <= 1-.5/scale+1e-6):
            raise ValueError(f'Camera transform exposes outside the source at frame {f}')
    return fps, media


def rgba(value):
    return ImageColor.getcolor(value, 'RGBA')


def make_layer(item):
    if item['type'] == 'image':
        image = Image.open(item['path']).convert('RGBA')
    elif item['type'] == 'rect':
        image = Image.new('RGBA', (item['width'],item['height']), rgba(item['color']))
    else:
        image = make_text_image(item)
    if item['type'] == 'image' and ('width' in item or 'height' in item):
        width = item.get('width',round(image.width*item['height']/image.height) if 'height' in item else image.width)
        height = item.get('height',round(image.height*width/image.width))
        image = image.resize((width,height),Image.Resampling.LANCZOS)
    return np.asarray(image).copy()


def blend(frame, overlay, x, y, opacity):
    h,w = frame.shape[:2]
    ih,iw = overlay.shape[:2]
    x0,y0,x1,y1 = max(0,x),max(0,y),min(w,x+iw),min(h,y+ih)
    if x1 <= x0 or y1 <= y0:
        return
    part = overlay[y0-y:y1-y,x0-x:x1-x]
    alpha = part[:,:,3:4].astype(np.float32)*(max(0,min(1,opacity))/255)
    frame[y0:y1,x0:x1] = np.rint(part[:,:,:3]*alpha + frame[y0:y1,x0:x1]*(1-alpha)).astype(np.uint8)


def circular_wipe(overlay, item):
    h, w = overlay.shape[:2]
    if item.get('mask') != 'circle':
        return overlay
    yy, xx = np.ogrid[:h, :w]
    distance = np.sqrt((xx-(w-1)/2)**2 + (yy-(h-1)/2)**2)
    outer = np.clip(w/2-distance, 0, 1)
    overlay[:, :, 3] = np.rint(overlay[:, :, 3]*outer).astype('uint8')
    ring = item.get('ring_width', 0)
    if ring:
        if not 0 < ring < w/2:
            raise ValueError('Invalid circle ring width')
        weight = np.clip(distance-(w/2-ring), 0, 1)*outer
        color = np.array(rgba(item.get('ring_color', '#ffffff'))[:3])
        overlay[:, :, :3] = np.rint(overlay[:, :, :3]*(1-weight[:, :, None]) + color*weight[:, :, None]).astype('uint8')
    return overlay


class VideoOverlay:
    """One sequential decoder per independent overlay; its sound is not remixed."""
    def __init__(self, item, fps, log):
        self.item, self.fps, self.log = item, fps, log
        self.process = None
        self.next_frame = item['start']

    def read(self, frame):
        item = self.item
        if frame != self.next_frame:
            raise ValueError('Video overlays must be read once per consecutive active frame')
        if self.process is None:
            filters = []
            crop = item.get('source_crop')
            if crop:
                filters.append(f"crop={crop['width']}:{crop['height']}:{crop['x']}:{crop['y']}")
            filters += [f"scale={item['width']}:{item['height']}:force_original_aspect_ratio=increase",
                        f"crop={item['width']}:{item['height']}", 'setsar=1', f'fps={self.fps}', 'setpts=PTS-STARTPTS']
            self.process = subprocess.Popen(['ffmpeg', '-v', 'error', '-nostdin',
                '-ss', str(item.get('source_start_seconds', 0)), '-i', item['path'], '-an',
                '-vf', ','.join(filters), '-frames:v', str(item['end']-item['start']),
                '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], stdout=subprocess.PIPE, stderr=self.log)
        count = item['width']*item['height']*4
        raw = self.process.stdout.read(count)
        if len(raw) != count:
            raise RuntimeError(f"Video overlay ended early: {item.get('id', item['path'])} @ {frame}")
        self.next_frame += 1
        overlay = np.frombuffer(raw, np.uint8).reshape(item['height'], item['width'], 4).copy()
        if self.next_frame == item['end']:
            self.process.stdout.close()
            if self.process.wait():
                raise RuntimeError('Video overlay decoder failed')
        return circular_wipe(overlay, item)

    def close(self):
        if self.process is not None and self.process.poll() is None:
            stop_process(self.process)


def decode_whole(path, log):
    """The whole file as 48 kHz stereo float32, decoded once."""
    raw = subprocess.run(['ffmpeg','-v','error','-nostdin','-i',str(path),'-vn','-af',f'aresample={RATE}',
        '-ar',str(RATE),'-ac','2','-f','f32le','-'],stdout=subprocess.PIPE,stderr=log,check=True).stdout
    if len(raw)%8:
        raise RuntimeError('Incomplete stereo audio sample')
    return np.frombuffer(raw,dtype='<f4').reshape(-1,2)


def looped_chunks(source, offset, count):
    """`source` repeated from `offset` seconds for `count` samples, a second at a time.

    Indexing the once-decoded file modulo its length keeps every pass sample-exact.
    ffmpeg `-stream_loop -1 -ss` did not: a later pass resumed at offset minus the first
    pass instead of at 0 (68.64 s song from 47.13 s jumped to 25.6 s at the first wrap)."""
    if not len(source):
        raise RuntimeError('Looped audio has no samples')
    first = int(round(offset*RATE))
    for at in range(0,count,RATE):
        yield source[(first+np.arange(at,min(count,at+RATE)))%len(source)]


def piped_chunks(process, count):
    at = 0
    while at < count:
        raw = process.stdout.read(min(RATE,count-at)*8)
        if not raw:
            return
        if len(raw)%8:
            raise RuntimeError('Incomplete stereo audio sample')
        a = np.frombuffer(raw,dtype='<f4').reshape(-1,2)
        at += len(a)
        yield a


def add_audio(mix, path, start, end, offset, item, fps, log, loop=False, source=None):
    """Mix `path` into mix[start:end]. Loops repeat the once-decoded `source` (decoded here
    when not given); other audio streams from ffmpeg seeking to `offset`."""
    count = end-start
    process = None
    if loop:
        chunks = looped_chunks(decode_whole(path,log) if source is None else source,offset,count)
    else:
        process = subprocess.Popen(['ffmpeg','-v','error','-nostdin','-ss',str(offset),'-i',str(path),'-vn','-af',
            f'aresample={RATE},apad,atrim=end_sample={count}','-ar',str(RATE),'-ac','2','-f','f32le','-'],
            stdout=subprocess.PIPE,stderr=log)
        chunks = piped_chunks(process,count)
    at = 0
    fade_in = sample_at(item.get('fade_in_frames',0),fps)
    fade_out = sample_at(item.get('fade_out_frames',0),fps)
    try:
        for a in chunks:
            positions = np.arange(at,at+len(a))
            gains = np.full(len(a),10**(item.get('gain_db',0)/20),dtype=np.float64)
            keys = item.get('keyframes',[])
            if keys:
                output_frames = (start+positions)*float(fps)/RATE
                gains = np.array([10**(curve(item,'gain_db',float(f),0)/20) for f in output_frames])
            if fade_in:
                gains *= np.minimum(1,positions/fade_in)
            if fade_out:
                gains *= np.minimum(1,(count-1-positions)/fade_out)
            mix[start+at:start+at+len(a)] += a*gains[:,None]
            at += len(a)
        if process:
            process.stdout.close()
        if (process and process.wait()) or at != count:
            raise RuntimeError(f'Audio decode failed: {path}; {at}/{count} samples')
    finally:
        if process and process.poll() is None:
            process.terminate(); process.wait()


def audio_mix(plan, fps, media, job):
    count = sample_at(plan['frames'],fps)
    path = job/'mix.f32le'
    mix = np.memmap(path,dtype='<f4',mode='w+',shape=(count,2))
    mix[:] = 0
    with (job/'audio.log').open('w') as log:
        for clip in plan['clips']:
            if clip.get('mute'):
                continue
            if not any(s['codec_type']=='audio' for s in media[clip['path']]['streams']):
                raise ValueError('Silent video clips require explicit mute=true')
            add_audio(mix,clip['path'],sample_at(clip['start'],fps),sample_at(clip['end'],fps),
                clip.get('source_start_seconds',0),clip,fps,log)
        looped = {}
        for event in plan.get('audio',[]):
            loop = event.get('loop',False)
            if loop and event['path'] not in looped:
                looped[event['path']] = decode_whole(event['path'],log)
            add_audio(mix,event['path'],sample_at(event['start'],fps),sample_at(event['end'],fps),
                event.get('source_start_seconds',0),event,fps,log,loop,looped.get(event['path']))
    peak = 0.0
    master = 10**(plan.get('master_gain_db',0)/20)
    for at in range(0,count,RATE):
        mix[at:at+RATE] *= master
        block = mix[at:at+RATE]
        if not np.isfinite(block).all():
            raise ValueError('Non-finite audio samples')
        peak = max(peak,float(np.abs(block).max()))
    mix.flush()
    del mix
    if peak > 1:
        raise ValueError(f'Mix exceeds digital full scale ({20*math.log10(peak):.2f} dBFS). Adjust gain in the plan.')
    return path, {'samples':count,'sample_rate':RATE,'sample_peak':peak,'listening_verified':False}


def _render_sequential(plan, fps, media, job, output):
    audio, audio_stats = audio_mix(plan,fps,media,job)
    w,h,total = (plan[k] for k in ('width','height','frames'))
    images = [None if layer['type'] == 'video' else make_layer(layer) for layer in plan.get('layers',[])]
    temporary = job/'encoded.mp4'
    encoder_args = ['ffmpeg','-v','error','-nostdin','-n','-f','rawvideo','-pix_fmt','rgb24',
        '-s',f'{w}x{h}','-r',str(fps),'-i','pipe:0','-f','f32le','-ar',str(RATE),'-ac','2','-i',str(audio),
        '-map','0:v','-map','1:a','-frames:v',str(total),'-t',f'{float(total/fps):.12f}',
        '-c:v','libx264','-preset','fast','-crf',str(plan.get('crf',18)),'-pix_fmt','yuv420p',
        '-c:a','aac','-b:a','192k','-movflags','+faststart',str(temporary)]
    with (job/'encode.log').open('w') as log:
        videos = {i: VideoOverlay(layer, fps, log) for i, layer in enumerate(plan.get('layers', []))
                  if layer['type'] == 'video'}
        encoder = subprocess.Popen(encoder_args,stdin=subprocess.PIPE,stderr=log)
        try:
            for clip in plan['clips']:
                count = clip['end']-clip['start']
                args = ['ffmpeg','-v','error','-nostdin','-ss',str(clip.get('source_start_seconds',0)),
                    '-i',clip['path'],'-an','-vf',
                    f'scale={w}:{h}:force_original_aspect_ratio=increase,crop={w}:{h},setsar=1,fps={fps},setpts=PTS-STARTPTS',
                    '-frames:v',str(count),'-f','rawvideo','-pix_fmt','rgb24','-']
                decoder = subprocess.Popen(args,stdout=subprocess.PIPE,stderr=log)
                try:
                    for f in range(clip['start'],clip['end']):
                        raw = decoder.stdout.read(w*h*3)
                        if len(raw) != w*h*3:
                            raise RuntimeError(f'Video ended before output frame {f}')
                        frame = np.frombuffer(raw,np.uint8).reshape(h,w,3).copy()
                        shot = next((s for s in plan.get('camera',[]) if s['start']<=f<s['end']),{})
                        scale = curve(shot,'scale',f,1)
                        cx,cy = curve(shot,'cx',f,.5),curve(shot,'cy',f,.5)
                        if scale != 1 or cx != .5 or cy != .5:
                            transform = np.float32([[scale,0,w/2-scale*w*cx],[0,scale,h/2-scale*h*cy]])
                            frame = cv2.warpAffine(frame,transform,(w,h),flags=cv2.INTER_LINEAR,borderMode=cv2.BORDER_REPLICATE)
                        visible_caption = False
                        for index, (layer,source) in enumerate(zip(plan.get('layers',[]),images)):
                            if not layer['start']<=f<layer['end']:
                                continue
                            if index in videos:
                                source = videos[index].read(f)
                            size = curve(layer,'scale',f,1)
                            if size <= 0:
                                continue
                            overlay = source if size == 1 else cv2.resize(source,None,fx=size,fy=size,interpolation=cv2.INTER_LINEAR)
                            x, y = round(curve(layer,'x',f,0)), round(curve(layer,'y',f,0))
                            opacity = curve(layer,'opacity',f,1)
                            if layer.get('role') == 'caption' and opacity > 0:
                                oh, ow = overlay.shape[:2]
                                x0, y0, x1, y1 = max(0,x), max(0,y), min(w,x+ow), min(h,y+oh)
                                if x1 > x0 and y1 > y0:
                                    alpha = overlay[y0-y:y1-y,x0-x:x1-x,3]
                                    visible_caption |= bool(np.any(alpha * min(1,opacity) > 8))
                            blend(frame,overlay,x,y,opacity)
                        required = any(s['start'] <= f < s['end'] for s in
                                       plan.get('caption_policy',{}).get('continuous_regions',[]))
                        if required and not visible_caption:
                            raise RuntimeError(f'Caption has no visible pixels on canvas at frame {f}')
                        encoder.stdin.write(frame.tobytes())
                    decoder.stdout.close()
                    if decoder.wait():
                        raise RuntimeError('Video decoder failed')
                finally:
                    if decoder.poll() is None:
                        stop_process(decoder)
                print(json.dumps({'rendered_frames':clip['end'],'total_frames':total}),flush=True)
            encoder.stdin.close()
            if encoder.wait():
                raise RuntimeError('MP4 encoder failed')
        finally:
            for video in videos.values():
                video.close()
            if encoder.poll() is None:
                stop_process(encoder)
    result = probe(temporary)
    video = next(s for s in result['streams'] if s['codec_type']=='video')
    if int(video['nb_frames']) != total or (video['width'],video['height']) != (w,h):
        raise RuntimeError('Output metadata does not match the frame plan')
    subprocess.run(['ffmpeg','-v','error','-i',str(temporary),'-f','null','-'],check=True)
    # Atomic no-overwrite publication; work and output live on the same filesystem.
    os.link(temporary,output)
    return {'output':str(output),'frames':total,'fps':str(fps),'width':w,'height':h,
        'audio':audio_stats,'full_decode':'passed','visual_style_verified':False,
        'premiere_required':False,'job':str(job)}


def _slice_item(item, start, end, fps):
    """Slice an output-timed item for an independently rendered clip."""
    item_start, item_end = item['start'], item['end']
    left, right = max(start, item_start), min(end, item_end)
    if left >= right:
        return None
    sliced = dict(item, start=left, end=right)
    if 'source_start_seconds' in item:
        sliced['source_start_seconds'] = item.get('source_start_seconds', 0) + float(Fraction(left-item_start, 1) / fps)
    return sliced


def _clip_plan(plan, clip, fps):
    """Build the independent frame plan used by one parallel clip worker."""
    start, end = clip['start'], clip['end']
    return {
        'version': plan.get('version', 1), 'fps': str(fps),
        'width': plan['width'], 'height': plan['height'],
        'frames': end-start, 'clip': dict(clip),
        'camera': [item for item in (_slice_item(item, start, end, fps) for item in plan.get('camera', [])) if item],
        'layers': [item for item in (_slice_item(item, start, end, fps) for item in plan.get('layers', [])) if item],
        'caption_policy': plan.get('caption_policy', {}),
        'crf': plan.get('crf', 18),
    }


def _render_clip_worker(spec, fps, media, target, cache_dir, jobs):
    """Render one video-only chunk; the parent process later muxes one audio mix."""
    clip_plan = spec['plan']
    clip = clip_plan['clip']
    width, height, frames = clip_plan['width'], clip_plan['height'], clip_plan['frames']
    index = spec['index']
    log_path = target.with_suffix('.log')
    files = referenced_paths({'clips': [clip], 'layers': clip_plan['layers']})
    key, _ = render_cache_key(clip_plan, files)
    payload = marker = None
    expected = {'key': key, 'frames': frames, 'width': width, 'height': height}
    cache_hit = False
    if cache_dir is not None:
        payload, marker = cache_entry(cache_dir / 'clips', key)
        if cache_is_valid(payload, marker, expected):
            shutil.copy2(payload, target)
            return {'path': str(target), 'frames': frames, 'cache_hit': True, 'key': key, 'index': index}

    images = [None if layer['type'] == 'video' else make_layer(layer) for layer in clip_plan['layers']]
    log_handle = log_path.open('ab')
    video_layers = {i: VideoOverlay(layer, fps, log_handle)
                    for i, layer in enumerate(clip_plan['layers']) if layer['type'] == 'video'}
    temp = target.with_name(f'.tmp-{target.name}')
    thread_budget = max(1, (os.cpu_count() or 2) // max(1, jobs))
    encoder_args = ['ffmpeg','-v','error','-nostdin','-n','-threads',str(thread_budget),'-f','rawvideo','-pix_fmt','rgb24',
        '-s',f'{width}x{height}','-r',str(fps),'-i','pipe:0','-frames:v',str(frames),
        '-an','-c:v','libx264','-preset','fast','-crf',str(clip_plan.get('crf',18)),
        '-pix_fmt','yuv420p','-video_track_timescale','90000',str(temp)]
    base_args = ['ffmpeg','-v','error','-nostdin','-threads',str(thread_budget),'-ss',str(clip.get('source_start_seconds',0)),
        '-i',clip['path'],'-an','-vf',f'scale={width}:{height}:force_original_aspect_ratio=increase,crop={width}:{height},setsar=1,fps={fps},setpts=PTS-STARTPTS',
        '-frames:v',str(frames),'-f','rawvideo','-pix_fmt','rgb24','-']
    with log_path.open('ab') as log:
        decoder = encoder = None
        try:
            decoder = subprocess.Popen(base_args, stdout=subprocess.PIPE, stderr=log)
            encoder = subprocess.Popen(encoder_args, stdin=subprocess.PIPE, stderr=log)
            for offset in range(frames):
                frame_no = clip['start'] + offset
                raw = decoder.stdout.read(width*height*3)
                if len(raw) != width*height*3:
                    raise RuntimeError(f'Video ended before output frame {frame_no}')
                frame = np.frombuffer(raw, np.uint8).reshape(height, width, 3).copy()
                shot = next((item for item in clip_plan['camera'] if item['start'] <= frame_no < item['end']), {})
                scale = curve(shot, 'scale', frame_no, 1)
                cx, cy = curve(shot, 'cx', frame_no, .5), curve(shot, 'cy', frame_no, .5)
                if scale != 1 or cx != .5 or cy != .5:
                    transform = np.float32([[scale,0,width/2-scale*width*cx],
                                             [0,scale,height/2-scale*height*cy]])
                    frame = cv2.warpAffine(frame, transform, (width,height),
                        flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
                visible_caption = False
                for index2, (layer, source) in enumerate(zip(clip_plan['layers'], images)):
                    if not layer['start'] <= frame_no < layer['end']:
                        continue
                    if index2 in video_layers:
                        source = video_layers[index2].read(frame_no)
                    size = curve(layer, 'scale', frame_no, 1)
                    if size <= 0:
                        continue
                    overlay = source if size == 1 else cv2.resize(source, None, fx=size, fy=size, interpolation=cv2.INTER_LINEAR)
                    x, y = round(curve(layer,'x',frame_no,0)), round(curve(layer,'y',frame_no,0))
                    opacity = curve(layer, 'opacity', frame_no, 1)
                    if layer.get('role') == 'caption' and opacity > 0:
                        oh, ow = overlay.shape[:2]
                        x0, y0, x1, y1 = max(0,x), max(0,y), min(width,x+ow), min(height,y+oh)
                        if x1 > x0 and y1 > y0:
                            alpha = overlay[y0-y:y1-y, x0-x:x1-x, 3]
                            visible_caption |= bool(np.any(alpha * min(1,opacity) > 8))
                    blend(frame, overlay, x, y, opacity)
                required = any(item['start'] <= frame_no < item['end'] for item in
                               clip_plan.get('caption_policy',{}).get('continuous_regions',[]))
                if required and not visible_caption:
                    raise RuntimeError(f'Caption has no visible pixels on canvas at frame {frame_no}')
                encoder.stdin.write(frame.tobytes())
            decoder.stdout.close()
            if decoder.wait():
                raise RuntimeError('Video decoder failed')
            encoder.stdin.close()
            if encoder.wait():
                raise RuntimeError('MP4 encoder failed')
            metadata = probe(temp)
            stream = next(s for s in metadata['streams'] if s['codec_type'] == 'video')
            if int(stream.get('nb_frames',0)) != frames:
                raise RuntimeError(f'Chunk frame count mismatch: {index}')
            os.replace(temp, target)
        finally:
            if decoder is not None and decoder.poll() is None:
                stop_process(decoder)
            if encoder is not None and encoder.poll() is None:
                stop_process(encoder)
            for overlay in video_layers.values():
                overlay.close()
            log_handle.close()
            temp.unlink(missing_ok=True)
    if cache_dir is not None:
        store_cache(payload, marker, key, clip_plan, {'output': str(target), 'frames': frames,
            'width': width, 'height': height})
    return {'path': str(target), 'frames': frames, 'cache_hit': cache_hit, 'key': key, 'index': index}


def _render_parallel(plan, fps, media, job, output, cache_dir, jobs):
    """Bounded parallel video chunks with one deterministic final audio mux."""
    from concurrent.futures import ThreadPoolExecutor
    audio, audio_stats = audio_mix(plan, fps, media, job)
    clip_specs = [{'index': i, 'plan': _clip_plan(plan, clip, fps)}
                  for i, clip in enumerate(plan['clips'])]
    chunk_dir = job/'video-chunks'
    chunk_dir.mkdir()
    futures = []
    with ThreadPoolExecutor(max_workers=jobs) as pool:
        for spec in clip_specs:
            target = chunk_dir/f"video_{spec['index']:04}.mp4"
            futures.append(pool.submit(_render_clip_worker, spec, fps, media, target, cache_dir, jobs))
        chunks = [future.result() for future in futures]
    chunks.sort(key=lambda item: item['index'])
    concat = job/'video.txt'
    concat.write_text(''.join(f"file '{Path(item['path']).as_posix()}'\n" for item in chunks), encoding='utf-8')
    joined = job/'video-joined.mp4'
    subprocess.run(['ffmpeg','-v','error','-y','-f','concat','-safe','0','-i',str(concat),
        '-an','-c:v','copy','-movflags','+faststart',str(joined)], check=True)
    total = plan['frames']; duration = float(Fraction(total, 1) / fps)
    partial = job/'encoded.mp4'
    subprocess.run(['ffmpeg','-v','error','-y','-i',str(joined),'-f','f32le','-ar',str(RATE),'-ac','2','-i',str(audio),
        '-map','0:v:0','-map','1:a:0','-c:v','copy','-c:a','aac','-b:a','192k','-t',f'{duration:.12f}',
        '-movflags','+faststart',str(partial)], check=True)
    metadata = probe(partial)
    video = next(s for s in metadata['streams'] if s['codec_type'] == 'video')
    if int(video.get('nb_frames',0)) != total or (int(video['width']),int(video['height'])) != (plan['width'],plan['height']):
        raise RuntimeError('Output metadata does not match the frame plan')
    subprocess.run(['ffmpeg','-v','error','-i',str(partial),'-f','null','-'], check=True)
    os.link(partial, output)
    return {'output':str(output),'frames':total,'fps':str(fps),'width':plan['width'],'height':plan['height'],
        'audio':audio_stats,'full_decode':'passed','visual_style_verified':False,
        'premiere_required':False,'job':str(job),'jobs':jobs,
        'video_clip_cache': {'hits': sum(item['cache_hit'] for item in chunks),
                             'misses': sum(not item['cache_hit'] for item in chunks)}}


def render(plan, fps, media, job, output, cache_dir=None, jobs=1):
    if jobs > 1:
        return _render_parallel(plan, fps, media, job, output, cache_dir, jobs)
    return _render_sequential(plan, fps, media, job, output)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('plan',type=Path)
    parser.add_argument('--output',type=Path)
    parser.add_argument('--validate-only',action='store_true')
    parser.add_argument('--preview', action='store_true',
        help='render only the first preview window into the job folder')
    parser.add_argument('--preview-seconds', type=float, default=3.0,
        help='duration of the preview window (default: 3 seconds)')
    parser.add_argument('--cache', type=Path,
        help='content-addressed cache directory (default: <task>/.akari/cache/render-offline)')
    parser.add_argument('--no-cache', action='store_true',
        help='disable the content-addressed output cache')
    parser.add_argument('--jobs', type=int, default=1,
        help='bounded parallel video chunks (1..8; default: 1)')
    parser.add_argument('--coverage', type=Path,
        help='editing-coverage.json to resolve every editorial event before rendering')
    args = parser.parse_args()
    plan = json.loads(args.plan.read_text(encoding='utf-8'))
    font_relocations = resolve_plan_fonts(plan)
    if args.jobs < 1 or args.jobs > 8:
        parser.error('--jobs must be between 1 and 8')
    if args.coverage:
        coverage = json.loads(args.coverage.read_text(encoding='utf-8'))
        link_errors = validate_event_links(coverage, plan)
        if link_errors:
            raise ValueError('Editorial event links are incomplete: ' + '; '.join(link_errors))
    started = time.monotonic()
    fps,media = validate(plan)
    validated_at = time.monotonic()
    if args.validate_only:
        print(json.dumps({'plan_valid':True,'frames':plan['frames'],'fps':str(fps),'premiere_required':False}))
        return
    root = args.plan.resolve().parent.parent
    job = root/'.akari/work'/('offline-'+datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')+'-'+uuid.uuid4().hex[:6])
    job.mkdir(parents=True)
    (job/'plan.json').write_text(json.dumps(plan,ensure_ascii=False,indent=2))
    if font_relocations:
        (job/'font-relocations.json').write_text(json.dumps(font_relocations,ensure_ascii=False,indent=2))
    evidence = {'plan_sha256':hashlib.sha256(args.plan.read_bytes()).hexdigest(),
        'renderer_sha256':sha256_file(Path(__file__).resolve()),
        'source_files':[{'path':p,'bytes':Path(p).stat().st_size,'mtime_ns':Path(p).stat().st_mtime_ns} for p in media]}
    (job/'inputs.json').write_text(json.dumps(evidence,ensure_ascii=False,indent=2))
    if args.preview:
        if args.preview_seconds <= 0 or not math.isfinite(args.preview_seconds):
            parser.error('--preview-seconds must be a positive finite number')
        preview_frames = max(1, min(plan['frames'], round(args.preview_seconds * float(fps))))
        preview_plan = truncate_plan(plan, preview_frames)
        preview_output = job/'preview.mp4'
        result = render(preview_plan, fps, media, job, preview_output, jobs=1)
        result.update({'preview': True, 'preview_seconds': preview_frames / float(fps),
                       'premiere_required': False})
        stages = {'validate_seconds': round(validated_at-started, 3),
                  'render_seconds': round(time.monotonic()-validated_at, 3),
                  'cache': {'enabled': False, 'hit': False, 'key': None}}
        write_render_artifacts(preview_plan, fps, job, result, stages)
        frame_path = job/'preview-frame.png'
        subprocess.run(['ffmpeg','-v','error','-y','-i',str(preview_output),'-frames:v','1',str(frame_path)], check=True)
        result['preview_frame'] = str(frame_path)
        (job/'result.json').write_text(json.dumps(result,ensure_ascii=False,indent=2), encoding='utf-8')
        print(json.dumps(result,ensure_ascii=False,indent=2))
        return
    if not args.output or not args.output.is_absolute() or args.output.suffix.lower() != '.mp4':
        parser.error('--output requires an absolute .mp4 path')
    if args.output.exists():
        raise FileExistsError(f'Output already exists; choose a new version: {args.output}')
    args.output.parent.mkdir(parents=True,exist_ok=True)
    cache_dir = None if args.no_cache else (args.cache.resolve() if args.cache else root/'.akari/cache/render-offline')
    cache_key = None
    cache_payload = cache_marker = None
    cache_record = {'enabled': cache_dir is not None, 'hit': False, 'key': None}
    if cache_dir is not None:
        cache_key, cache_inputs = render_cache_key(plan, referenced_paths(plan))
        cache_payload, cache_marker = cache_entry(cache_dir, cache_key)
        cache_record['key'] = cache_key
        expected = {'key': cache_key, 'frames': plan['frames'],
                    'width': plan['width'], 'height': plan['height']}
        if cache_is_valid(cache_payload, cache_marker, expected):
            shutil.copy2(cache_payload, args.output)
            cache_record['hit'] = True
            result = {'output':str(args.output),'frames':plan['frames'],'fps':str(fps),
                      'width':plan['width'],'height':plan['height'],
                      'full_decode':'cached_verified','visual_style_verified':False,
                      'premiere_required':False,'cache_hit':True,'job':str(job)}
        else:
            result = render(plan,fps,media,job,args.output,cache_dir=cache_dir,jobs=args.jobs)
            store_cache(cache_payload, cache_marker, cache_key, plan, result)
            result['cache_hit'] = False
    else:
        result = render(plan,fps,media,job,args.output,cache_dir=cache_dir,jobs=args.jobs)
        result['cache_hit'] = False
    result['cache'] = cache_record
    finished_at = time.monotonic()
    stages = {'validate_seconds': round(validated_at-started, 3),
              'render_seconds': round(finished_at-validated_at, 3),
              'total_seconds': round(finished_at-started, 3),
              'cache': cache_record}
    write_render_artifacts(plan, fps, job, result, stages)
    (job/'result.json').write_text(json.dumps(result,ensure_ascii=False,indent=2), encoding='utf-8')
    reports = root/'.akari/reports'; reports.mkdir(parents=True,exist_ok=True)
    report = reports/(args.output.stem+'-render.json')
    report.write_text(json.dumps(result,ensure_ascii=False,indent=2))
    print(json.dumps(result,ensure_ascii=False,indent=2))


if __name__ == '__main__':
    try:
        main()
    except (ValueError,OSError,KeyError,RuntimeError,subprocess.CalledProcessError) as error:
        print(f'offline render failed: {error}',file=sys.stderr)
        raise SystemExit(1)
