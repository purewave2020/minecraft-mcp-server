"""Read existing game telemetry without opening or controlling a bot session."""

import json
import math
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.request import ProxyHandler, build_opener


OBSERVATIONS = {
    'LLMBot': 'bot-observation.json',
    'GPTBot': 'gptbot-observation.json',
    'GrokBot': 'grokbot-observation.json',
    'DevinBot': 'devinbot-observation.json',
    'ClaudeBot': 'claudebot-observation.json',
    'SWEBot': 'swebot-observation.json',
}
MAX_JSON_BYTES = 1024 * 1024


def age_seconds(value, now):
    try:
        if isinstance(value, str):
            stamp = datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp()
        else:
            stamp = float(value) / 1000  # Dashboard timestamps are milliseconds.
        age = now - stamp
        return round(max(0, age), 1) if math.isfinite(age) and age >= -5 else None
    except (TypeError, ValueError, OverflowError):
        return None


def fresh(value, now, max_age):
    age = age_seconds(value, now)
    return age is not None and age <= max_age


def read_json_file(path):
    with Path(path).open('rb') as source:
        raw = source.read(MAX_JSON_BYTES + 1)
    if len(raw) > MAX_JSON_BYTES:
        raise ValueError('Telemetry too large')
    value = json.loads(raw)
    if not isinstance(value, dict):
        raise ValueError('Telemetry must be an object')
    return value


def read_dashboard(url):
    # Local telemetry should work even when the shell configures an HTTP proxy.
    with build_opener(ProxyHandler({})).open(url.rstrip('/') + '/api/snapshot', timeout=2) as response:
        raw = response.read(MAX_JSON_BYTES + 1)
    if len(raw) > MAX_JSON_BYTES:
        raise ValueError('Telemetry too large')
    value = json.loads(raw)
    if not isinstance(value, dict):
        raise ValueError('Telemetry must be an object')
    return value


def collect_game_context(game_root, dashboard_url='http://127.0.0.1:18100',
                         max_age=20, now=None):
    now = time.time() if now is None else now
    result = {
        'captured_at': datetime.fromtimestamp(now, timezone.utc).isoformat(),
        'available': False,
        'players': [],
        'bot_observations': [],
        'recent_game_chat': [],
    }
    try:
        dashboard = read_dashboard(dashboard_url) if dashboard_url else {}
        collector = dashboard.get('collector') or {}
        live = collector.get('connected') is True and fresh(collector.get('observedAt'), now, max_age)
        result['dashboard_live'] = live
        for player in dashboard.get('players', [])[:50]:
            current = live and player.get('online') is True and fresh(player.get('observedAt'), now, max_age)
            view = {'name': player.get('name'), 'online': player.get('online') if live else None,
                    'state_fresh': current, 'age_seconds': age_seconds(player.get('observedAt'), now)}
            if current:
                result['available'] = True
                for key in ('dimension', 'health', 'food', 'xp', 'equipment', 'effects'):
                    view[key] = player.get(key)
                if fresh(player.get('positionAt'), now, max_age):
                    view['position'] = player.get('position')
            result['players'].append(view)
        for message in dashboard.get('chat', [])[-20:]:
            if fresh(message.get('timestamp'), now, 180):
                result['recent_game_chat'].append({
                    'username': str(message.get('username', ''))[:80],
                    'content': str(message.get('content', ''))[:500],
                    'age_seconds': age_seconds(message.get('timestamp'), now),
                })
    except (OSError, ValueError, TypeError, AttributeError):
        result['dashboard_live'] = False

    for name, filename in OBSERVATIONS.items():
        try:
            observation = read_json_file(Path(game_root) / '.npm' / filename)
            current = observation.get('connected') is True and fresh(observation.get('observedAt'), now, max_age)
            view = {'name': name, 'state_fresh': current,
                    'age_seconds': age_seconds(observation.get('observedAt'), now)}
            if current:
                result['available'] = True
                for key in ('health', 'food', 'position', 'dimension', 'equipment', 'isSleeping'):
                    if key in observation:
                        view[key] = observation[key]
                view['inventory'] = [{'name': item.get('name'), 'count': item.get('count')}
                                     for item in observation.get('inventory', [])[:46]]
                view['nearby_entities'] = [
                    {key: entity[key] for key in ('name', 'username', 'type', 'position') if key in entity}
                    for entity in observation.get('entities', [])[:12]
                ]
                view['world_time'] = {key: observation.get('time', {}).get(key)
                                      for key in ('day', 'timeOfDay', 'isDay')}
            result['bot_observations'].append(view)
        except (OSError, ValueError, TypeError, AttributeError):
            continue
    return result
