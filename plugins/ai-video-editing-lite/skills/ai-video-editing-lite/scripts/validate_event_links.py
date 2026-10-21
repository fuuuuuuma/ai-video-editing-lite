#!/usr/bin/env python3
"""Validate that editorial events resolve to real render-plan elements."""
import argparse
import json
import math
from pathlib import Path


def _interval(value, label):
    if not isinstance(value, list) or len(value) != 2 or any(type(v) is not int for v in value) or value[0] >= value[1]:
        raise ValueError(f'{label} must be an integer [start,end) interval')
    return tuple(value)


def _source_interval(value, label):
    if (not isinstance(value, list) or len(value) != 2
            or any(isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) for v in value)
            or value[0] >= value[1]):
        raise ValueError(f'{label} must be a finite numeric [start,end) interval')
    return tuple(value)


def _index(plan, collection):
    result = {}
    for item in plan.get(collection, []):
        item_id = item.get('id')
        if item_id:
            if item_id in result:
                raise ValueError(f'{collection}: duplicate id {item_id}')
            result[item_id] = item
    return result


def validate(coverage, render_plan):
    errors = []
    if coverage.get('channel') and render_plan.get('channel') and coverage['channel'] != render_plan['channel']:
        errors.append('channel: editing coverage and render plan differ')
    indexed = {collection: _index(render_plan, collection) for collection in ('clips', 'camera', 'layers', 'audio')}
    for area_name, area in coverage.get('areas', {}).items():
        if not isinstance(area, dict) or area.get('decision') != 'use':
            continue
        events = area.get('events')
        if not isinstance(events, list) or not events:
            errors.append(f'{area_name}: use requires events')
            continue
        for pos, event in enumerate(events):
            label = f'{area_name}[{pos}]'
            if not isinstance(event, dict):
                errors.append(f'{label}: event must be an object')
                continue
            for field in ('id', 'reference_id', 'cue', 'action', 'source_interval', 'output_interval'):
                if not event.get(field):
                    errors.append(f'{label}: missing {field}')
            try:
                _source_interval(event.get('source_interval'), f'{label}.source_interval')
            except ValueError as exc:
                errors.append(str(exc))
            try:
                output_start, output_end = _interval(event.get('output_interval'), f'{label}.output_interval')
            except ValueError as exc:
                errors.append(str(exc))
                output_start = output_end = None
            state = event.get('state')
            if not isinstance(state, dict) or not state.get('before') or not state.get('after'):
                errors.append(f'{label}: state.before and state.after are required')
            links = event.get('render')
            if not isinstance(links, dict):
                errors.append(f'{label}: render links are required')
                continue
            linked_any = False
            for collection in ('clips', 'camera', 'layers', 'audio'):
                ids = links.get(collection, [])
                if ids is None:
                    ids = []
                if not isinstance(ids, list):
                    errors.append(f'{label}.render.{collection}: must be a list')
                    continue
                for item_id in ids:
                    linked_any = True
                    item = indexed[collection].get(item_id)
                    if item is None:
                        errors.append(f'{label}: {collection} id not found: {item_id}')
                        continue
                    try:
                        item_start, item_end = _interval([item.get('start'), item.get('end')], f'{collection}.{item_id}')
                    except ValueError as exc:
                        errors.append(str(exc))
                        continue
                    if output_start is not None and (item_start > output_start or item_end < output_end):
                        errors.append(f'{label}: {collection}.{item_id} does not cover output interval')
            if not linked_any:
                errors.append(f'{label}: at least one render element is required')
    return errors


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('coverage', type=Path)
    parser.add_argument('render_plan', type=Path)
    args = parser.parse_args()
    try:
        coverage = json.loads(args.coverage.read_text(encoding='utf-8'))
        render_plan = json.loads(args.render_plan.read_text(encoding='utf-8'))
        errors = validate(coverage, render_plan)
    except (OSError, ValueError, TypeError, json.JSONDecodeError) as error:
        errors = [str(error)]
    result = {'valid': not errors, 'errors': errors,
              'note': '各イベントの参照・状態・出力レイヤー／音声への接続だけを検査する。映像の見た目と実聴は別の確認である。'}
    print(json.dumps(result, ensure_ascii=False, indent=2))
    raise SystemExit(0 if not errors else 1)


if __name__ == '__main__':
    main()
