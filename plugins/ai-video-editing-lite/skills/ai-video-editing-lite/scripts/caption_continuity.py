#!/usr/bin/env python3
"""Hold previous captions without advancing speech; audit logical display events.

All intervals are integer output frames [start,end). A glow and its text are
one logical event. This module checks coverage, not speech recognition or pixels.
"""
import argparse
import json
from pathlib import Path


def intervals(items, total):
    if type(total) is not int or total < 1:
        raise ValueError('Positive integer output frame count required')
    result = []
    for item in items:
        a, b = item['start'], item['end']
        if type(a) is not int or type(b) is not int or not 0 <= a < b <= total:
            raise ValueError('Expected integer [start,end) within output')
        result.append(dict(item))
    return sorted(result, key=lambda x: (x['start'], x['end']))


def coverage(events, regions, total):
    """Report exact missing, overlapping and forbidden display intervals."""
    events, regions = intervals(events, total), intervals(regions, total)
    edges = {0: [0, 0], total: [0, 0]}
    for column, items in enumerate((events, regions)):
        for item in items:
            edges.setdefault(item['start'], [0, 0])[column] += 1
            edges.setdefault(item['end'], [0, 0])[column] -= 1
    result = {'gaps': [], 'overlaps': [], 'outside_regions': []}
    count, required = 0, 0
    points = sorted(edges)
    for a, b in zip(points, points[1:]):
        count += edges[a][0]
        required += edges[a][1]
        if required > 1:
            raise ValueError('Caption regions overlap')
        kind = ('outside_regions' if count and not required else
                'gaps' if required and not count else
                'overlaps' if count > 1 else None)
        if kind:
            spans = result[kind]
            if spans and spans[-1]['end'] == a:
                spans[-1]['end'] = b
            else:
                spans.append({'start': a, 'end': b})
    result['gap_frames'] = sum(x['end']-x['start'] for x in result['gaps'])
    result['passed'] = not any(result[k] for k in ('gaps', 'overlaps', 'outside_regions'))
    result['scope'] = 'logical display coverage only; rendered pixels and speech timing unverified'
    return result


def hold_previous(captions, regions, total, replacements=()):
    """Extend ends only. Missing opening text is an error, never a pre-reveal."""
    captions = intervals(captions, total)
    regions = intervals(regions, total)
    replacements = intervals(replacements, total)
    if any(not cap.get('text', '').strip() for cap in captions + replacements):
        raise ValueError('Empty text is not a subtitle')
    if any(a['start'] == b['start'] for a, b in zip(captions, captions[1:])):
        raise ValueError('Simultaneous captions must be composed into one readable event')
    coverage([], regions, total)  # Validate region overlap even for empty captions.
    result = []
    for region in regions:
        a, b = region['start'], region['end']
        active = [dict(c) for c in captions if c['start'] < b and c['end'] > a]
        for i, cap in enumerate(active):
            cap['start'] = max(a, cap['start'])
            cap['end'] = active[i+1]['start'] if i+1 < len(active) else b
            cap['kind'] = 'normal'
            fragments = [cap]
            for replacement in replacements:
                next_fragments = []
                for part in fragments:
                    lo, hi = max(part['start'], replacement['start']), min(part['end'], replacement['end'])
                    if lo >= hi:
                        next_fragments.append(part)
                    else:
                        if part['start'] < lo:
                            next_fragments.append(dict(part, end=lo))
                        if hi < part['end']:
                            next_fragments.append(dict(part, start=hi))
                fragments = next_fragments
            result.extend(fragments)
    result.extend(dict(x, kind='emphasis') for x in replacements)
    result.sort(key=lambda x: (x['start'], x['end']))
    audit = coverage(result, regions, total)
    if not audit['passed']:
        raise ValueError('Cannot produce continuous captions without changing onset: ' + json.dumps(audit))
    return result


def validate_render_layers(plan):
    """Audit the layers actually consumed by the common renderer, not an unused SRT."""
    policy = plan.get('caption_policy')
    if policy is None:
        if plan.get('channel'):
            raise ValueError('Channel edits require caption_policy; see cut-and-caption.md')
        return None  # Generic calibration renders have no selected channel.
    total = plan['frames']
    required = policy['continuous_regions']
    excluded = policy['excluded_regions']
    for span in excluded:
        if not span.get('reason') or not span.get('basis'):
            raise ValueError('Every caption exclusion needs a reason and channel/user basis')
    partition = coverage(required + excluded, [{'start': 0, 'end': total}], total)
    if not partition['passed']:
        raise ValueError('Caption policy must classify every output frame exactly once')
    logical = {}
    for layer in plan.get('layers', []):
        if layer.get('role') != 'caption':
            continue
        if layer.get('caption_kind') == 'point':     # Point panels sit in screen recordings, not on the caption track
            continue
        if not layer.get('caption_id') or layer.get('type') not in ('text', 'image'):
            raise ValueError('Caption layers require caption_id and text/image type')
        if layer.get('type') == 'text' and not layer.get('text', '').strip():
            raise ValueError('Blank text is not a displayed caption')
        if layer.get('opacity', 1) <= 0:
            raise ValueError('Transparent layer is not a displayed caption')
        key = (layer['caption_id'], layer['start'], layer['end'])
        logical[key] = layer
    audit = coverage(list(logical.values()), required, total)
    if not audit['passed']:
        raise ValueError('Caption display contract failed: ' + json.dumps(audit))
    return audit


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('plan', type=Path, help='frames, captions, continuous_regions, optional replacements')
    p.add_argument('--hold', action='store_true', help='Extend previous captions and split around replacements')
    p.add_argument('--output', type=Path, required=True)
    args = p.parse_args()
    data = json.loads(args.plan.read_text())
    events = (hold_previous(data['captions'], data['continuous_regions'], data['frames'], data.get('replacements', []))
              if args.hold else data['captions'])
    report = coverage(events, data['continuous_regions'], data['frames'])
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open('x') as out:
        json.dump({'events': events, 'audit': report}, out, ensure_ascii=False, indent=2)
    print(json.dumps(report, ensure_ascii=False))
    raise SystemExit(0 if report['passed'] else 1)


if __name__ == '__main__':
    main()
