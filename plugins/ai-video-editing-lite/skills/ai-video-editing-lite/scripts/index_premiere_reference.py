#!/usr/bin/env python3
"""Read a Premiere reference: clip state, text, effects and source-time keyframes.

Never modifies the project. Raw appearance bytes are fingerprinted, not guessed.
Keyframe timing is source-relative; retimed/nested clips require explicit mapping.
"""
import argparse
import base64
import gzip
import hashlib
import struct
from premiere_textstyle import decode as decode_text_style
import json
import re
import struct
from pathlib import Path
import xml.etree.ElementTree as ET

TICKS = 254016000000


def embedded_strings(encoded):
    data = base64.b64decode(encoded)
    result = []
    for i in range(0, len(data) - 4, 4):
        size = struct.unpack_from('<I', data, i)[0]
        if not 3 <= size <= 2048 or i + 4 + size > len(data):
            continue
        try:
            value = data[i + 4:i + 4 + size].rstrip(b'\0').decode('utf-8')
        except UnicodeDecodeError:
            continue
        if value and all(c.isprintable() or c in '\r\n\t' for c in value) and re.search('[A-Za-zぁ-んァ-ヶ一-龥]', value):
            result.append(value)
    return list(dict.fromkeys(result))


def value_from_keyframe(raw):
    parts = raw.split(',')
    return parts[1] if len(parts) > 1 else None


def state_flags(element):
    return {x.tag: x.text for x in element.iter() if x.text and not len(x)
            and re.search('mute|enabled|disabled|bypass|speed', x.tag, re.I)}


def index_project(path):
    raw = path.read_bytes()
    root = ET.fromstring(gzip.decompress(raw) if raw[:2] == b'\x1f\x8b' else raw)
    ids = {x.get('ObjectID'): x for x in root if x.get('ObjectID')}
    uids = {x.get('ObjectUID'): x for x in root if x.get('ObjectUID')}
    shared = {x.get('BinaryHash'): x.text for x in root.iter()
              if x.get('BinaryHash') and x.text and x.get('Encoding') == 'base64'}
    unresolved_blobs = set()

    def resolve(element):
        return ids.get(element.get('ObjectRef')) if element is not None else None

    def references(element):
        if element is not None:
            for node in element.iter():
                if node.get('ObjectRef') in ids:
                    yield ids[node.get('ObjectRef')]

    def source_data(source_clip):
        if source_clip is None:
            return {}
        base = source_clip.find('.//Clip')
        source = resolve(base.find('Source')) if base is not None else None
        out = {'clip_type': source_clip.tag, 'clip_object_id': source_clip.get('ObjectID')}
        if source is not None:
            out.update(source_type=source.tag, source_object_id=source.get('ObjectID'))
            seq_ref = source.find('SequenceSource/Sequence')
            if seq_ref is not None:
                out['nested_sequence_uid'] = seq_ref.get('ObjectURef')
            media_ref = source.find('MediaSource/Media')
            media = uids.get(media_ref.get('ObjectURef')) if media_ref is not None else None
            if media is not None:
                out['media_uid'] = media.get('ObjectUID')
                out['media_paths'] = {k: media.findtext(k) for k in
                                      ('FilePath', 'ActualMediaFilePath', 'RelativePath') if media.findtext(k)}
        if source_clip.tag == 'RemixClip':
            out['remix'] = True
            out['remix_note'] = 'Original source time is not the remixed playback map.'
        return out

    def transition_data(item):
        result = []
        for name in ('HeadTransition', 'TailTransition'):
            trans = resolve(item.find(name))
            if trans is None:
                trans = resolve(item.find('ClipTrackItem/' + name))
            if trans is not None:
                ti = trans.find('TransitionTrackItem/TrackItem')
                result.append({'edge': name, 'id': trans.get('ObjectID'),
                               'name': trans.findtext('TransitionTrackItem/DisplayName'),
                               'match_name': trans.findtext('TransitionTrackItem/MatchName'),
                               'start': int(ti.findtext('Start', '0')) / TICKS if ti is not None else None,
                               'end': int(ti.findtext('End', '0')) / TICKS if ti is not None else None,
                               'raw_xml': ET.tostring(trans, encoding='unicode')})
        return result

    def audio_chain_data(chain):
        output = []
        for component in references(chain):
            if component.find('AudioComponent') is None:
                continue
            params = []
            for param in references(component):
                if param.tag.endswith('Param'):
                    params.append({'id': param.get('ObjectID'), **{x.tag: x.text for x in param if not len(x)}})
            output.append({'id': component.get('ObjectID'), 'type': component.tag, 'params': params})
        return output

    sequences = []
    for seq in root.findall('Sequence'):
        record = {'name': seq.findtext('Name'), 'uid': seq.get('ObjectUID'), 'tracks': [], 'clips': []}
        for link in seq.findall('TrackGroups/TrackGroup/Second'):
            group = resolve(link)
            if group is None:
                continue
            if group.tag == 'VideoTrackGroup':
                frame_ticks = int(group.findtext('TrackGroup/FrameRate', '0'))
                record.update(frame_ticks=frame_ticks, fps=TICKS/frame_ticks if frame_ticks else None,
                              frame_rect=group.findtext('FrameRect'))
            for ref in group.findall('TrackGroup/Tracks/Track'):
                track = uids.get(ref.get('ObjectURef'))
                if track is None or track.tag not in ('VideoClipTrack', 'AudioClipTrack'):
                    continue
                kind = 'video' if track.tag == 'VideoClipTrack' else 'audio'
                number = int(track.findtext('ClipTrack/Track/Index', '0')) + 1
                track_flags = state_flags(track)
                track_data = {'kind': kind, 'number': number, 'flags': track_flags}
                if kind == 'audio':
                    track_data['audio_components'] = audio_chain_data(resolve(track.find('AudioTrack/ComponentOwner/Components')))
                record['tracks'].append(track_data)
                for item_ref in track.findall('ClipTrack/ClipItems/TrackItems/TrackItem'):
                    item = resolve(item_ref)
                    ti = item.find('ClipTrackItem/TrackItem')
                    sub = resolve(item.find('ClipTrackItem/SubClip'))
                    source_clip = resolve(sub.find('Clip')) if sub is not None else None
                    source_in = int(source_clip.findtext('.//Clip/InPoint', '0')) if source_clip is not None else 0
                    source_out_text = source_clip.findtext('.//Clip/OutPoint') if source_clip is not None else None
                    start, end = (int(ti.findtext(n, '0')) for n in ('Start', 'End'))
                    clip = {'id': item.get('ObjectID'), 'kind': kind, 'track': number,
                            'name': sub.findtext('Name') if sub is not None else None,
                            'start_ticks': start, 'end_ticks': end, 'start': start/TICKS, 'end': end/TICKS,
                            'duration': (end-start)/TICKS, 'source_in_ticks': source_in,
                            'source_out_ticks': int(source_out_text) if source_out_text else None,
                            'muted': item.findtext('ClipTrackItem/IsMuted', 'false') == 'true',
                            'flags': state_flags(item), 'track_flags': track_flags, 'components': []}
                    clip['source'] = source_data(source_clip)
                    clip['transitions'] = transition_data(item)
                    master_ref = sub.find('MasterClip') if sub is not None else None
                    master = uids.get(master_ref.get('ObjectURef')) if master_ref is not None else None
                    if master is not None:
                        clip['master_clip_uid'] = master.get('ObjectUID')
                        clip['master_audio_components'] = [audio_chain_data(x) for x in references(master)
                                                           if x.tag == 'AudioComponentChain']
                    chain = resolve(item.find('ClipTrackItem/ComponentOwner/Components'))
                    clip['chain_defaults'] = {x.tag: x.text for x in (chain if chain is not None else []) if not len(x)}
                    for component in references(chain):
                        if not component.tag.endswith('Component') and component.find('AudioComponent') is None:
                            continue
                        comp = {'id': component.get('ObjectID'), 'match_name': component.findtext('MatchName'),
                                'name': component.findtext('.//DisplayName') or component.tag,
                                'flags': state_flags(component), 'params': []}
                        for param in references(component):
                            if not param.tag.endswith('Param'):
                                continue
                            data = {'id': param.get('ObjectID'), 'name': param.findtext('Name')}
                            for element in param:
                                if element.tag in ('StartKeyframe', 'CurrentValue', 'StartKeyframePosition'):
                                    data[element.tag] = element.text
                                if element.tag == 'StartKeyframe' and element.text:
                                    data['static_value'] = value_from_keyframe(element.text)
                                if element.tag == 'StartKeyframeValue' and element.get('Encoding') == 'base64':
                                    binary_hash = element.get('BinaryHash')
                                    encoded = element.text or shared.get(binary_hash)
                                    data['binary_hash'] = binary_hash
                                    if encoded:
                                        data['blob_sha256'] = hashlib.sha256(base64.b64decode(encoded)).hexdigest()
                                        data['strings'] = embedded_strings(encoded)
                                        data['shared_blob_resolved'] = not bool(element.text)
                                        if data['name'] in ('ソーステキスト', 'Source Text'):
                                            try:
                                                data['appearance_raw'] = decode_text_style(base64.b64decode(encoded))
                                            except (ValueError, IndexError, KeyError, struct.error) as error:
                                                data['appearance_decode_error'] = str(error)
                                    else:
                                        unresolved_blobs.add(binary_hash or param.get('ObjectID'))
                                if element.tag == 'Keyframes' and element.text:
                                    data['keyframes_raw'] = element.text
                                    keys = []
                                    for key in element.text.split(';'):
                                        if not key:
                                            continue
                                        parts = key.split(',')
                                        tick = int(parts[0])
                                        offset = (tick-source_in)/TICKS
                                        keys.append({'source_ticks': tick, 'source_offset_seconds': offset,
                                                     'timeline_seconds_assuming_1x': start/TICKS+offset,
                                                     'value': parts[1], 'curve_fields_raw': parts[2:]})
                                    data['keyframes'] = keys
                            comp['params'].append(data)
                        clip['components'].append(comp)
                    record['clips'].append(clip)
        sequences.append(record)
    return {'source': str(path), 'source_sha256': hashlib.sha256(raw).hexdigest(), 'ticks_per_second': TICKS,
            'sequences': sequences, 'shared_blob_count': len(shared), 'unresolved_blobs': sorted(unresolved_blobs),
            'limitations': ['Presence is not visibility: inspect clip, track and component state plus parent nests.',
                            'Source-relative keyframes are not final timing for retimed/nested clips.',
                            'Source Text uses a reverse-engineered schema; absent fields/defaults and unknown raw fields are not inferred.',
                            'Decoded appearance is not rendered fidelity. Curve codes, nested transforms and final compositing require review.',
                            'An absent audio effect does not establish final loudness; source gain and track/master mix may apply.']}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('project', type=Path)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    result = index_project(args.project)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2))
    print(json.dumps({'output': str(args.output), 'sequences': len(result['sequences']),
                      'clips': sum(len(s['clips']) for s in result['sequences'])}, ensure_ascii=False))


if __name__ == '__main__':
    main()
