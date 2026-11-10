# Minecraft 世界沙盘

独立运行在 Mac 上的局域网管理面板。BlueMap 5.29 CLI 从 Windows 原版 26.3 服务器的一致性存档快照生成真实三维地形和建筑；Vue 面板展示所有在线真人和机器人。后端通过 SSH 使用已有控制台队列读取数据，不创建玩家连接，不经过 ViaProxy。

## 使用

需要 Node.js **22.13+**、Python **3.9+**、Java **25+**，以及本仓库已配置的 SSH 凭据、控制台队列和 Windows VSS/备份权限。当前固定的 BlueMap CLI 主类使用 Java 25 字节码，部署复用 Minecraft 的 Java 25。第一次连接前须通过正常 SSH 验证服务器主机指纹；桥接器使用 `StrictHostKeyChecking=yes`。

在仓库根目录执行：

```sh
npm ci --prefix dashboard
npm run dashboard:build
npm run dashboard:start
npm run dashboard:status
npm run dashboard:stop
```

打开 <http://127.0.0.1:18100/map/>。首次启动自动下载并校验固定版本的 BlueMap、同步存档、下载官方地图资源并渲染。初次渲染需要几分钟，已有地图会继续显示。启动命令只等待 HTTP 服务就绪，渲染进度显示在页面中。

面板支持三维/俯视、缩放、玩家定位与跟随、真人/机器人筛选、生命/饥饿、装备/背包/经验/效果、最近 15 分钟轨迹、公共聊天和世界动态。手动平移地图会退出跟随。显示的头像是本地生成的像素头像。真人/机器人分类依据已知机器人名，不参与账户认证。

公共聊天同时进入记录与玩家头顶气泡：每人最多三条，8 秒后消失，可关闭气泡；历史消息只进入记录。气泡跟随世界坐标、随镜头投影，并避免重叠，远景优先保留选中玩家的气泡。内容作为文本显示。聊天记录保存 7 天，位置轨迹保存 24 小时。

新聊天由面板所在 Mac 在后台直接播报，固定使用系统 Siri 普通话「声音4」（`com.apple.siri.natural.zh-CN-D`），按「玩家名说：消息」依次朗读。抖音 Codex 回复与游戏聊天共用同一个 FIFO 队列，按入队顺序逐条播放，前一条结束后再开始下一条。默认开启；关闭浏览器后仍继续，多页面访问也只播放一次。右上角开关控制全局后台播报，关闭立即停止并清空队列，重新开启会播放提示。开关保存在面板数据库中，重启后沿用。历史记录、重复事件、启用前和收到时已超过 30 秒的游戏聊天不会朗读；已入队消息持续等待，不因排队超过 30 秒而丢弃。最多保留 100 条待播消息，队满时保留原队列。

`douyin/` 使用 `gpt-6.1-terra`、`medium` 推理生成回复，通过 `POST /api/speech/messages` 提交 `{ "id": "douyin:房间号:消息号", "text": "回复文本", "source": "douyin" }`。接口沿用面板认证，文本最长 1000 字，成功入队返回 `202`，重复 ID 返回 `200`，全局播报关闭返回 `409`，队满返回 `429`（可用相同 ID 重试），语音不可用返回 `503`。重复提交不会再次入队；该入口不会发送 Minecraft 聊天或创建玩家气泡。队列在后台内存中管理，关闭播报或重启会清空待播消息。

后台通过 `/usr/bin/say` 直接向该 Mac 当前音频输出设备播放，网页只显示状态和控制开关，手机访问时声音也来自该 Mac。文本通过标准输入传递，音色标识固定，不调用第三方语音服务。启动时静默合成一小段音频验证声音4，验证文件随后删除；缺失时显示不可用。需要在该 Mac 的系统设置中安装声音4；当前部署已验证可用。停止面板会一并停止后台播报。

## 数据时效与地图更新

- 在线名单、生命/饥饿约 5 秒更新，位置约 2–3 秒更新，完整背包/装备约 30 秒更新；打开详情时会触发有节流的补充查询。
- 地形、建筑默认在每次渲染完成 **5 分钟后**取下一份快照并增量渲染，实际显示延迟还包括传输和渲染时间。界面展示存档时间；玩家图层持续独立更新。
- 只有已经生成并保存的维度才能切换。当前实际存档只有主世界；下界/末地生成后，下次同步会自动增加对应地图。
- 数据中断时显示最后已知状态与采集提示，不把旧数据标成实时。持续观测时长从首次发现/再次上线算起，不代表监控启动前的完整在线时长。
- 断线通过 SSE 事件 ID 续传；事件过期或游标失效时发送完整快照。

地图同步流程：获取与既有每日备份共用的锁 → 验证 `save-off` 和 `save-all flush` → 创建 VSS → 验证 `save-on` → 复制 VSS 中的地图文件。自动保存恢复后才压缩传输。现有保存恢复监控继续处理异常中断留下的 guard。服务器本地时间 **03:25–03:45** 避让每日 03:30 备份；失败保留上次地图并在下一周期重试。

只传输 `level.dat` 和各维度 `region` 内的 `.mca/.mcc` 地图文件。SHA-256 清单决定增量，所有收到的文件先校验，再应用；清单最后提交。缓存损坏或上次应用中断的文件会重新请求。本地文件锁覆盖同步和渲染，避免手动同步与自动渲染同时修改地图源。BlueMap 完成后向浏览器通知刷新瓦片，保留选中玩家和跟随。

## 配置

默认数据目录是仓库内被 Git 忽略的 `.npm/dashboard/`，权限只允许当前用户。SSH 凭据读取用户私有的 `~/.config/minecraft-mcp-server/server-credentials.json` 的 `ssh` 字段，不写入仓库、网页、日志或命令参数。

| 环境变量 | 默认值/用途 |
| --- | --- |
| `DASHBOARD_HOST` | `127.0.0.1` |
| `DASHBOARD_PORT` | `18100` |
| `DASHBOARD_DATA` | `.npm/dashboard`，可设置绝对路径 |
| `DASHBOARD_JAVA` | 当前 Mac 的 Minecraft 内置 Java 路径；其他机器需指定 Java 可执行文件 |
| `DASHBOARD_SYNC_MS` | `300000`，地图更新间隔 |
| `DASHBOARD_PASSWORD` | 可选；绑定非回环地址时必填。HTTP Basic 用户名为 `dashboard`；启动/查询状态时使用同一环境配置 |
| `MINECRAFT_CREDENTIALS` | 可覆盖私有 SSH 凭据文件的位置 |
| `DASHBOARD_OFFLINE=1` | 关闭实时采集、详情补充查询和原生语音，用于隔离测试 |
| `DASHBOARD_SKIP_RENDER=1` | 关闭自动同步和渲染，用于隔离测试 |

改变环境配置前先停止该面板，再使用新环境启动。后台管理器仅管理它持有 PID/随机标识的面板进程，异常退出会重启子进程；它不是系统开机启动服务。单独停止面板不停止游戏服务器或机器人。

私有数据目录可放置 `config.json` 覆盖 Windows 的 `serverRoot`、`backupRoot` 和 `positionIntervalMs`。默认分别是 `D:\\Game\\minecraft-java-26.3`、`E:\\MinecraftBackups\\minecraft-java-26.3` 和 `2500`。这些设置和凭据均不会发送到浏览器。

## 检查与维护

```sh
cd dashboard
npm run lint
npm run build
npm test
# 独立的语音 UI 测试：模拟朗读，不连接游戏，也不实际发声。
DASHBOARD_BROWSER=chrome npm run test:speech-browser
# 已运行真实面板时执行；只向测试浏览器注入聊天，不向游戏发送消息。
DASHBOARD_BROWSER=chrome npm run test:browser
```

浏览器检查使用 Playwright，可通过 `npx playwright install chromium` 安装其浏览器并省略 `DASHBOARD_BROWSER`。它验证真实地图、跟随/手动拖动、气泡的中文/emoji/安全文本/去重/三条上限/8 秒过期、地图刷新和手机布局。截图写入数据目录。Node/Python 单元测试无需 SSH、游戏或 Java。

`npm run setup-map` 单独准备运行时；`npm run sync-map` 单独同步快照但不渲染。需要立即同步并渲染时运行 `python3 bridge/remote.py update`。这些命令与自动周期共用本地锁。

日志位于数据目录的 `service.log`（HTTP/采集错误）、`render.log`（同步和 BlueMap 输出）。`world-manifest.json` 记录已应用快照，`dashboard.sqlite` 存储监控历史，`service.json` 记录当前面板进程。断线重连不会重复展示同一条聊天。

地图损坏时先停止面板，将数据目录中的 `world/`、`world-manifest.json` 和 `web/` 移到备份位置，再重新启动以完整重建；保留 `dashboard.sqlite` 可保留聊天历史，保留 `runtime/` 可复用已下载的资源。常规升级不需要清空数据。完整移除只需停止面板并删除 `dashboard/` 和 `.npm/dashboard/`；没有替换游戏服务脚本、安装插件或调整 MCP/代理进程。

地图引擎：[BlueMap](https://bluemap.bluecolored.de/)（MIT），固定下载版本和校验值见 `bridge/remote.py`。
