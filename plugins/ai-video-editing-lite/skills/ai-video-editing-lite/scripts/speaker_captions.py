"""Compile speaker-assigned captions and verify assignments reach actual layers.

This does not identify voices. A question/suffix heuristic is not speaker evidence.
Multiple speakers can share one logical caption event with separate styled rows.
"""
import argparse
import copy
import hashlib
import json
from pathlib import Path
from styled_text import make_text_image

EVIDENCE_METHODS = {'audio_review', 'av_sync_review', 'isolated_microphone', 'user_assignment'}
STYLE_FIELDS = {'font', 'font_sha256', 'font_size', 'font_index', 'color', 'stroke_width', 'stroke_color',
                'strokes', 'shadows', 'fill_gradient', 'spacing', 'padding', 'background',
                'proportional_spacing', 'tracking_px', 'text_scale_x', 'text_scale_y'}


def _evidence(evidence):
    if not isinstance(evidence, dict) or evidence.get('method') not in EVIDENCE_METHODS:
        raise ValueError('Speaker requires audio/AV/isolated-microphone/user evidence; text inference is insufficient')
    if not evidence.get('reference') or not evidence.get('note'):
        raise ValueError('Speaker evidence needs a reference and observation note')


def _visual_signature(style):
    return json.dumps({k: style[k] for k in STYLE_FIELDS if k in style}, sort_keys=True)


def validate_speakers(plan):
    policy = plan.get('speaker_policy')
    if policy is None:
        return None
    speakers, styles = policy['speakers'], plan['caption_styles']
    if not speakers:
        raise ValueError('At least one explicitly assigned speaker required')
    signatures = []
    for sid, mapping in speakers.items():
        _evidence(mapping.get('evidence'))
        if mapping.get('normal_style_id') not in styles:
            raise ValueError(f'{sid}: missing normal caption style')
        style = styles[mapping['normal_style_id']]
        if not style.get('reference'):
            raise ValueError('Style must identify its reference')
        signatures.append(_visual_signature(style))
    if len(set(signatures)) != len(signatures):
        raise ValueError('Different speakers resolve to the same visual style')
    turns = policy['utterances']
    by_id = {u['id']: u for u in turns}
    if not turns or len(by_id) != len(turns):
        raise ValueError('Nonempty unique utterance IDs required')
    for u in turns:
        if u.get('speaker_id') not in speakers:
            raise ValueError(f"Unresolved speaker for {u['id']}")
        _evidence(u.get('evidence'))
        if type(u.get('start')) is not int or type(u.get('end')) is not int or not 0 <= u['start'] < u['end'] <= plan['frames']:
            raise ValueError('Utterances require integer output-frame intervals')
    linked = {uid: [] for uid in by_id}
    displayed = {}
    for layer in plan.get('layers', []):
        if layer.get('role') != 'caption':
            continue
        sid, style_id = layer.get('speaker_id'), layer.get('style_id')
        if sid not in speakers or style_id not in styles:
            raise ValueError('Rendered caption has no valid speaker/style assignment')
        if layer.get('caption_kind', 'normal') == 'normal' and style_id != speakers[sid]['normal_style_id']:
            raise ValueError('Normal caption uses another speaker style')
        style = styles[style_id]
        if layer['type'] == 'text':
            if any(layer.get(k) != style.get(k) for k in STYLE_FIELDS):
                raise ValueError('Rendered text appearance differs from its assigned style')
        elif layer['type'] == 'image':
            if not layer.get('style_render_sha256') or hashlib.sha256(Path(layer['path']).read_bytes()).hexdigest() != layer['style_render_sha256']:
                raise ValueError('Caption image requires a matching render hash')
        if not layer.get('utterance_ids'):
            raise ValueError('Caption must link to actual utterance IDs')
        for uid in layer['utterance_ids']:
            if uid not in by_id or by_id[uid]['speaker_id'] != sid:
                raise ValueError('Caption links to another or unknown speaker utterance')
            u = by_id[uid]
            if layer['start'] < u['start']:
                raise ValueError('Caption starts before its utterance')
            # Splitting simultaneous-speaker events must not remove a held row.
            # A post-speech span is legal only as a continuous hold of the same
            # text/image that first appeared during this utterance.
            identity = (uid, style_id, layer['type'], layer.get('text'), layer.get('style_render_sha256'))
            displayed.setdefault(identity, []).append((layer['start'], layer['end']))
            if layer['start'] < u['end']:
                linked[uid].append((max(u['start'], layer['start']), min(u['end'], layer['end'])))
    for identity, spans in displayed.items():
        u = by_id[identity[0]]
        until = -1
        for start, end in sorted(spans):
            if start >= u['end'] and start > until:
                raise ValueError('Held caption has no continuous display from its utterance')
            until = max(until, end)
    for uid, spans in linked.items():
        cursor = by_id[uid]['start']
        for start, end in sorted(spans):
            if start > cursor:
                break
            cursor = max(cursor, end)
        if cursor < by_id[uid]['end']:
            raise ValueError(f'Utterance {uid} is not fully represented in rendered captions')
    return {'speakers': len(speakers), 'utterances': len(turns),
            'assignment_links_verified': True, 'voice_identity_verified_by_this_script': False}


def compile_captions(plan):
    out = copy.deepcopy(plan)
    generated = []
    for cap in out.pop('speaker_captions'):
        parts = cap['parts']
        if not parts:
            raise ValueError('Caption event has no speaker parts')
        bottom = cap.get('bottom_y', out['height']-50)
        rows = []
        for part in parts:
            sid = part['speaker_id']
            mapping = out['speaker_policy']['speakers'][sid]
            style_id = part.get('style_id', mapping['normal_style_id'])
            style = out['caption_styles'][style_id]
            layer = {k: copy.deepcopy(style[k]) for k in STYLE_FIELDS if k in style}
            layer.update(type='text', text=part['text'], start=cap['start'], end=cap['end'],
                         role='caption', caption_id=cap['id'], speaker_id=sid, style_id=style_id,
                         utterance_ids=part['utterance_ids'], caption_kind=part.get('kind', 'normal'))
            image = make_text_image(layer)
            bbox = image.getbbox()
            if bbox is None or bbox[2]-bbox[0] > out['width']-2*cap.get('margin_x', 60):
                raise ValueError('Caption exceeds safe width; split meaning or line breaks, never shrink font')
            rows.append((layer, image, bbox))
        for i, (layer, image, bbox) in reversed(list(enumerate(rows))):
            layer['x'] = round((out['width']-image.width)/2)
            layer['y'] = bottom-bbox[3]
            layer['id'] = f"{cap['id']}:speaker:{i}"
            bottom -= bbox[3]-bbox[1]+cap.get('row_gap', 12)
            if layer['y']+bbox[1] < 0:
                raise ValueError('Caption rows exceed canvas height')
            generated.append(layer)
    out['layers'] = out.get('layers', []) + generated
    validate_speakers(out)
    return out


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('plan', type=Path)
    p.add_argument('--output', required=True, type=Path)
    args = p.parse_args()
    result = compile_captions(json.loads(args.plan.read_text()))
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open('x') as f:
        json.dump(result, f, ensure_ascii=False, indent=2)
    print(json.dumps(validate_speakers(result)))


if __name__ == '__main__':
    main()
