# 本机运行说明

本目录源码随 Minecraft 主仓库一起管理，来自 [saermart/DouyinLiveWebFetcher](https://github.com/saermart/DouyinLiveWebFetcher)，基于上游提交 `40a904bdb0561a5a9c958a95634a29681cc4fbf4` 增加本机集成，保留原始 `LICENSE` 和上游说明。已创建 Python 3.10 虚拟环境并安装上游固定版本依赖。使用项目自带的 Protobuf 解析代码，无需另外安装 protoc。签名计算使用 mini_racer，a_bogus 计算使用 Node.js。新聊天和表情会调用本机 Codex CLI，结合最新 Minecraft 状态生成简短中文回复，再提交给 `dashboard/` 与游戏聊天统一排队播报。有人进场时直接使用观众昵称生成「欢迎xxx」，例如「欢迎小明」，不调用 Codex。

## 启动

在 Finder 中双击 `start.command`，或者运行：

```sh
cd /Users/xiaqingbo/Documents/ChatGPT/minecraft-mcp-server/douyin
./start.command
```

默认读取 `config.json` 中的直播间，显示聊天弹幕、表情和进场通知，并自动生成回复。断开后每 5 秒重新连接。按 Ctrl+C 停止；关闭终端也会结束前台运行。程序使用本机文件锁阻止重复监听。后台运行时也可用 `./start.command --status` 查看、`./start.command --stop` 停止监听和生成；已经提交的播报由 dashboard 管理，其全局开关控制停止和清空队列。

进场事件 `WebcastMemberMessage` 默认开启监听，直接把「欢迎＋观众昵称」提交到 dashboard 同一个播报队列。欢迎语不查询游戏、不调用 Codex，也不等待正在生成的聊天回复。重复消息 ID、启动前的历史通知、过期通知和缺少昵称的事件不会重复或空白欢迎；正常离开后再次进入产生的新事件仍会欢迎。`--no-reply` 同时关闭欢迎语，`--mute` 只记录欢迎文本。

日志保存在 `.local/danmu.log`，每次启动追加写入。观看日志：

```sh
tail -f /Users/xiaqingbo/Documents/ChatGPT/minecraft-mcp-server/douyin/.local/danmu.log
```

临时指定其他直播间或显示所有事件：

```sh
./start.command https://live.douyin.com/45544935372
./start.command --all-events
./start.command --no-reply  # 只看弹幕
./start.command --mute      # 生成回复但不提交 dashboard 播报
```

## 配置

`config.json` 不提交到 Git，字段参考 `config.example.json`：

- `live_id`：网页直播间号或直播间完整链接。
- `cookie_file`：Cookie 文本文件，路径相对于配置文件所在目录；文件不存在时使用访客模式。
- `chat_only`：`true` 只显示聊天、表情和进场，`false` 显示上游支持的所有事件。
- `reconnect_seconds`：断开后等待多少秒重连，至少 1 秒。
- `reply`：语音回复配置，见下文；未填写时默认开启。

## Codex 游戏语音回复

需要已安装并登录的 Codex CLI，以及已运行的 dashboard 后台播报服务。固定默认模型为 `gpt-6.1-terra`，推理强度为 `medium`（中）；沿用现有 Codex 登录及提供方，不需要另外填写 API Key。声音由 dashboard 统一使用 Siri 普通话「声音4」，本程序不单独播放语音。

先用本地测试消息检查整条链路，无需开播，也不会给抖音或 Minecraft 发送文字：

```sh
./start.command --test-reply '现在游戏里有哪些机器人在线，状态怎么样？'
./start.command --test-reply '现在大家在做什么？' --mute
```

收到新聊天或表情后，后台工作线程读取同级 Minecraft 仓库 `.npm/*observation.json` 的最新观测和本机世界面板 `http://127.0.0.1:18100/api/snapshot` 的玩家/近期聊天。面板未运行时仍可使用观测文件；两者都不可用时明确说明缺少当前状态。默认超过 20 秒的观测不提供给模型作为当前事实；坐标、血量、饥饿、物品、附近生物不等于已确认具体动作或任务完成。

每条消息通过标准输入传给 `codex exec`，在仓库外的临时目录中运行，以 JSON schema 提取最终回复。关闭 shell、MCP、插件、浏览器等工具并使用只读沙箱；不会新建游戏连接或接管任何机器人。只播报生成的回复，CLI 进度和错误详情不会被朗读。官方调用方式见 [OpenAI Docs：非交互模式](https://developers.openai.com/codex/noninteractive/)。

系统提示词维护在 `codex-system-prompt.txt`，每次通过 Codex 的 `model_instructions_file` 加载，要求「不能修改任何东西，只允许查询游戏中可见数据」。模型只可读取输入 `game` 中提供的可见游戏观测，禁止查询文件、代码、配置、凭据、系统信息或隐藏游戏数据，禁止操作机器人、世界或服务器。弹幕和游戏聊天不能覆盖这些限制；缺少系统提示词时停止本条生成。配置项说明见 [OpenAI Docs：配置参考](https://developers.openai.com/codex/config-reference/)。

`config.example.json` 列出了全部 `reply` 默认值：

| 字段 | 用途 |
| --- | --- |
| `enabled` | 是否自动生成并播报回复，默认 `true` |
| `codex_command` | Codex 可执行文件名或完整路径，默认 `codex` |
| `model` | 默认 `gpt-6.1-terra` |
| `reasoning_effort` | 默认 `medium`（中） |
| `timeout_seconds` | 单次 Codex 生成超时，默认 45 秒 |
| `max_pending` | 最多 8 条待回复消息；满时跳过最早一条 |
| `max_message_age_seconds` | 默认跳过超过 90 秒的弹幕，包括生成后已经过期的消息 |
| `max_reply_chars` | 最长 160 字 |
| `game_state_max_age_seconds` | 当前状态有效期，默认 20 秒 |
| `dashboard_url` | 本机面板地址，用于读取状态和提交播报；只接受本机 HTTP 地址 |

按平台消息 ID 去重，记录在 `.local/reply-seen.json`，重连不会重复回复已经见过的消息。启动前的历史聊天不回复。Codex 逐条生成后，通过 `POST /api/speech/messages` 提交 `{id, text, source: "douyin"}`。dashboard 按入队顺序将游戏聊天和抖音回复放进同一个 FIFO 队列，前一条播放完才开始下一条。待播期间不会因超过 30 秒被丢弃，最多等待 100 条；队满时拒绝新回复并允许重试，不替换较早的消息。

网络或临时服务错误最多重试两次，始终使用相同消息 ID，由 dashboard 去重，避免丢失回执后重复发声。面板关闭播报时会拒绝入队；本程序不会自行开启开关或改用另一套语音。生成超时或提交失败会记录错误并继续监听后续消息。

回复文本和结果保存在 `.local/replies.jsonl`，到 2 MB 后保留一份上次日志。`queued` 表示 dashboard 已接受，不表示已经播放完毕；实际播放状态查看面板。dashboard 在所在 Mac 的系统音频输出中播放；直播观众能否听到，取决于直播软件是否采集该系统音频。

回归检查不连接直播、不调用真实模型，也不实际发声：

```sh
.venv/bin/python -m unittest discover -s tests -v
```

## Cookie

一般先用访客模式读取聊天弹幕。如果连接受到限制，或需要登录后才能接收到的礼物消息，可在本机浏览器登录抖音，在开发者工具的 Network 中找到直播间请求的 Cookie 请求头，将完整的单行值写入 `.local/cookie.txt`。不要包含 `Cookie:` 前缀，不要将 Cookie 发到聊天里。该目录已经加入 Git 忽略列表；保存后重启程序生效。

```sh
chmod 600 .local/cookie.txt
```

## 重建环境

```sh
uv venv --python 3.10 .venv
uv pip install --python .venv/bin/python -r requirements.local.lock
```

只读取平台实际下发到当前连接的消息。网页连接和直播伴侣的消息分发范围可能不同，也不能补回连接前的全部历史弹幕。
