#!/usr/bin/env python3
# coding: utf-8
"""接收直播弹幕，结合游戏遥测调用 Codex CLI 生成并朗读回复。"""

import argparse
import fcntl
import json
import os
import re
import signal
import threading
import time
from pathlib import Path
from urllib.parse import urlparse

from auto_reply import AutoReply, ReplyError, ReplySettings
from liveMan import DouyinLiveWebFetcher


PROJECT_DIR = Path(__file__).resolve().parent
CHAT_TYPES = ('WebcastChatMessage', 'WebcastEmojiChatMessage', 'WebcastMemberMessage')


def parse_live_id(value):
    value = str(value).strip()
    if value.isdecimal():
        return value
    parsed = urlparse(value)
    if parsed.scheme in ('https', 'http') and parsed.hostname == 'live.douyin.com':
        live_id = parsed.path.strip('/')
        if re.fullmatch(r'\d+', live_id):
            return live_id
    raise ValueError('请填写数字房间号或 https://live.douyin.com/房间号 链接')


def listener_control(lock_file, stop=False):
    try:
        fcntl.flock(lock_file, fcntl.LOCK_EX | fcntl.LOCK_NB)
        print('弹幕监听未运行。', flush=True)
        return 0
    except BlockingIOError:
        lock_file.seek(0)
        try:
            pid = int(lock_file.read())
            if pid <= 1:
                raise ValueError()
        except ValueError:
            print('弹幕监听正在启动，请稍后再试。', flush=True)
            return 1
    if not stop:
        print(f'弹幕监听运行中（PID {pid}）。', flush=True)
        return 0
    try:
        os.kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        return 0
    for _ in range(50):
        try:
            fcntl.flock(lock_file, fcntl.LOCK_EX | fcntl.LOCK_NB)
            print('弹幕监听和语音回复已停止。', flush=True)
            return 0
        except BlockingIOError:
            time.sleep(0.1)
    print('已请求停止，正在等待网络连接关闭。', flush=True)
    return 1


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description='抖音弹幕 + Codex 游戏语音回复，按 Ctrl+C 停止')
    parser.add_argument('room', nargs='?', help='直播间链接或房间号；默认读取 config.json')
    parser.add_argument('--config', type=Path, default=PROJECT_DIR / 'config.json')
    parser.add_argument('--all-events', action='store_true', help='显示礼物、点赞、进场等所有事件')
    parser.add_argument('--once', action='store_true', help='连接断开后退出，不自动重连')
    parser.add_argument('--no-reply', action='store_true', help='只读取弹幕，不调用 Codex、不播报')
    parser.add_argument('--mute', action='store_true', help='生成回复并记录，但不提交 dashboard 播报队列')
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--test-reply', metavar='消息', help='用测试消息验证当前游戏状态、Codex 和播报，无需连接抖音')
    mode.add_argument('--status', action='store_true', help='查看当前监听是否运行')
    mode.add_argument('--stop', action='store_true', help='停止当前监听和生成；已提交的播报由 dashboard 管理')
    args = parser.parse_args()
    state_dir = args.config.resolve().parent / '.local'
    state_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (state_dir / 'listener.lock').open('a+', encoding='utf-8') as lock_file:
        if args.status or args.stop:
            return listener_control(lock_file, args.stop)
        try:
            fcntl.flock(lock_file, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            parser.error('已有弹幕监听正在运行。请先用 --stop 停止，避免重复语音回复。')
        lock_file.seek(0)
        lock_file.truncate()
        lock_file.write(str(os.getpid()))
        lock_file.flush()
        return run_listener(args, parser, state_dir)


def run_listener(args, parser, state_dir):
    try:
        config = json.loads(args.config.read_text(encoding='utf-8')) if args.config.exists() else {}
        settings = ReplySettings.from_config(config.get('reply', {}))
        live_id = parse_live_id(args.room or config.get('live_id', '')) if args.test_reply is None else 'test'
        cookie_path = config.get('cookie_file', '.local/cookie.txt')
        cookie_file = args.config.resolve().parent / cookie_path if cookie_path else None
        cookie = cookie_file.read_text(encoding='utf-8').strip() if cookie_file and cookie_file.exists() else ''
        reconnect_seconds = float(config.get('reconnect_seconds', 5))
        if not 1 <= reconnect_seconds <= 300:
            raise ValueError('reconnect_seconds')
    except (OSError, TypeError, ValueError, AttributeError) as exc:
        parser.error(f'配置无效（{type(exc).__name__}）。请检查 config.json、房间号和 Cookie 文件。')

    stopped = threading.Event()
    room = None
    responder = None

    def stop(signum, frame):
        stopped.set()
        if responder is not None:
            responder.close()
        if room is not None:
            room.stop()

    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGTERM, stop)
    try:
        if args.test_reply is not None or (settings.enabled and not args.no_reply):
            responder = AutoReply(settings, state_dir, PROJECT_DIR.parent, muted=args.mute)
        if args.test_reply is not None:
            # The same production path, with a visibly synthetic local message.
            responder.submit({'message_id': f'test-{time.time_ns()}', 'room_id': 'test',
                              'username': '本地测试', 'content': args.test_reply})
            return 0 if responder.process(responder.pending.get_nowait()) else 1

        print(f'直播间：https://live.douyin.com/{live_id}', flush=True)
        print('Cookie：已配置' if cookie else 'Cookie：访客模式', flush=True)
        all_events = args.all_events or not config.get('chat_only', True)
        print('显示：所有事件' if all_events else '显示：聊天弹幕、表情和进场；按 Ctrl+C 停止', flush=True)
        if responder is not None:
            responder.start()
            print(f'回复：Codex CLI {settings.model} / {settings.reasoning_effort} + 当前游戏状态；'
                  + ('静音测试' if args.mute else '提交 dashboard 统一队列播报'), flush=True)
            print('进场欢迎：直接播报“欢迎＋观众昵称”，不调用 Codex。', flush=True)
        else:
            print('回复：已关闭，只读取弹幕。', flush=True)
        while not stopped.is_set():
            failed = False
            try:
                room = DouyinLiveWebFetcher(live_id, cookie=cookie,
                                           message_types=None if all_events else CHAT_TYPES,
                                           on_chat=responder.submit if responder is not None else None,
                                           on_member=responder.submit_member if responder is not None else None)
                room.start()
            except Exception as exc:
                failed = True
                print(f'连接失败（{type(exc).__name__}），请检查网络、开播状态或 Cookie。', flush=True)
            finally:
                if room is not None:
                    room.stop()
                    room.session.close()
            if args.once:
                return 1 if failed else 0
            if not stopped.is_set():
                print(f'{reconnect_seconds:g} 秒后重连…', flush=True)
                stopped.wait(reconnect_seconds)
        print('已停止。', flush=True)
        return 0
    except ReplyError as exc:
        print(f'【语音回复】{exc}', flush=True)
        return 1
    finally:
        if responder is not None:
            responder.close()


if __name__ == '__main__':
    raise SystemExit(main())
