# 本地部署与维护

连接链路：本机 MCP 客户端 → Node.js stdio MCP → `127.0.0.1:25568` ViaProxy → `192.168.1.3:25565` Windows Minecraft。客户端固定使用 `1.21.8`，服务器为 `26.3`；Mineflayer 和 ViaProxy 的固定版本见根目录 `AGENTS.md`。stdout 仅用于 JSON-RPC，诊断写入 stderr。

## 会话与共享代理

从仓库根目录执行：

```sh
node scripts/proxy-service.mjs status
node scripts/proxy-service.mjs ensure
python3 scripts/start-session.py LLMBot
python3 .npm/llmbot-control.py status
python3 .npm/llmbot-control.py get-connection-status
```

使用 Node.js 22+；当前 Mac 的会话启动器使用 `AGENTS.md` 中记录的 Node.js 绝对路径。`.npm/` 中原有入口委托到 `scripts/`，可继续使用。

代理由独立进程管理，可接管已有代理；结束单个 MCP 会话不会终止共享代理。代理启动前校验 JAR 哈希，监听地址限定为回环地址。进程锁和 MCP 身份锁拒绝同一身份的重复启动，重复登录踢出后暂停自动重连，需先核实控制归属。

每个会话每 5 秒查询真实 MCP 连接状态并刷新私有状态文件。MCP 子进程退出后自动恢复；连续三次 MCP 健康请求失败也会触发恢复。服务器暂时断线由 MCP 自己按退避策略重连，不重复启动身份。

代理管理器每 15 秒分别查询直连和代理路径的 Minecraft 状态协议，无需登录机器人。`proxy-owner.json` 的 `healthy`、`probe`、`backend`、`alerts` 记录真实后端状态；`verified` 只表示监听进程身份已验证。各会话读取 15 秒内的共享探测结果，避免重复执行 `lsof`。只有全部现有会话状态新鲜且都断线、直连成功、代理连续失败至少一分钟时，才会校验进程指纹并向共享代理发送 SIGTERM 恢复；两次恢复间隔至少五分钟。有连接仍在线、会话状态过期或直连也失败时不自动重启共享代理。

`LLMBot` 的控制归属保留在 `.npm/runtime/controller-llmbot.json`。控制请求携带 `CODEX_THREAD_ID`，已分配身份的操作及停止请求仅接受所属控制者；诊断读取可独立执行。转交控制权仍须明确的人类指令。

维护期间可写入私有 `.npm/runtime/maintenance.json`，将 `untilUnix` 字段设为未来的 Unix 秒数。截止前会阻止新会话启动；维护完成后删除此文件。已有连接仍可查询状态。

## 动作、聊天与诊断

- 修改游戏状态的工具串行执行；状态、聊天读取等工具可独立响应。
- 导航默认 30 秒、上限 60 秒，手动移动上限 10 秒；单次动作总上限 70 秒，MCP 请求上限 90 秒，控制套接字上限 100 秒。
- 取消、断线、死亡、重生会停止动作。无法及时结束的原生操作会隔离旧连接并重连，防止旧动作继续影响后续操作。
- 服务端纠正位置、无效坐标或区块未加载会停止当前移动。`get-connection-status` 返回纠正和停止计数，排查时应结合游戏日志。
- 默认寻路禁止自动挖掘和搭柱；需要开路的专用会话可显式使用 `--navigation-dig`、`--navigation-tower`。持续两秒没有支撑且不正常下落的移动会取消，水中和创造飞行不使用此判断；这不能替代跨版本移动实测。
- `lastKick`、`lastError`、`lastEnd` 分别保留原因及时间，`lastDisconnect` 优先保留本次连接的真实失败原因，不被通用退出消息覆盖。
- 自动防御设置按身份保存并在重连时恢复。`get-status` 返回实际防御状态；它不能保证复杂地形中的生存。
- `qingyage` 的未确认消息独立持久化。使用 `read-chat` 的 `pendingOnly:true` 和序号游标读取，用 `ack-chat` 确认已处理消息；普通最近聊天保留 100 条。历史待处理消息在确认前持续保留。
- 状态、聊天和观察文件原子写入并限制文件权限。消费观察文件必须检查 `observedAt` 和 `connected`。

## Windows 服务器

维护源文件在 `ops/windows/`。通过现有私有 SSH 助手部署：

```sh
python3 scripts/deploy-windows-maintenance.py
# 仅在线更新维护脚本，不变更任务与游戏服配置：
python3 scripts/deploy-windows-maintenance.py --scripts-only
```

部署器校验 PowerShell 语法，备份启动脚本和配置，然后安装维护脚本及 SYSTEM 计划任务。部署不自动重启游戏服。SSH 密码始终从仓库外的私有凭据文件读取。

当前配置为 `view-distance=8`、`simulation-distance=6`，Java 堆维持 `-Xms1G -Xmx4G`。启动配置还包含 GC 日志。使用现有 `stop.cmd` 保存并优雅关闭，再通过 `MinecraftJava-26.3` 计划任务启动以使 JVM/视距配置生效；切勿强杀 Java。

| 任务 | 周期 | 输出与保留 |
| --- | --- | --- |
| `MinecraftJava-26.3-Backup` | 每天 03:30 | `E:\MinecraftBackups\minecraft-java-26.3`，保留 14 份完成的 ZIP |
| `MinecraftJava-26.3-Monitor` | 每分钟 | 安装目录 `metrics/latest.json` 和 JSONL，保留 7 天 |

在线备份先确认 `save-off` 和 `save-all flush`，创建 VSS 快照后立即确认 `save-on`；从快照复制世界，避免压缩期间阻塞自动保存。备份包含世界与管理配置、SHA-256 清单，完成前解压并逐个校验文件。任务失败不覆盖上一份成功备份；`latest-result.json` 与 `last-error.json` 分别记录成功和失败状态。

中断恢复标记 `backup-save-guard.json` 由监控处理。监控从游戏日志确认自动保存已恢复后才归档标记。控制台的 dispatched 回执只表示写入 stdin，不能代替游戏执行结果。

监控记录 tick 平均耗时与 P50/P95/P99、CPU、内存、磁盘、GC 尾部和近期卡顿/移动告警。`tickError` 非空表示未确认采样，不能当作正常值。启动输出单文件 10 MB、最多 5 个历史文件；GC 同样按 10 MB 滚动，旧启动输出和 GC 文件保留 7 天。

监控通过正数 PID、专用 Java 路径及 `server.jar` 命令行共同验证进程，避免将 PID 0 的系统计数误报为服务器。`running` 表示进程存在，`healthy` 表示 tick 查询成功，`state` 区分停止、无响应和降级。磁盘少于 15 GB 或 10% 时写入 `disk-space-low` 告警。日志使用持久化字节游标增量计数；`latest.json` 原子替换，采集异常另存 `last-error.json`，消费者仍需检查时间。

地图快照默认最短间隔 15 分钟；失败后至少等待 30 分钟，面板调度按失败退避至一小时。快照在取锁后检查最近 90 秒的监控，tick 平均值达到 25 ms、P99 达到 100 ms、CPU 达到 85% 或健康未确认时延后，不发送强制存盘。这个措施减少触发存盘阻塞的机会，尚不代表 Minecraft 的存盘阻塞根因已消除。实体完整信息默认每 5 秒查询，玩家完整 NBT 默认每 120 秒查询；位置更新及按需详情保留。

`python3 scripts/mirror-backup.py` 将 Windows 最近一份成功备份复制到本机 `~/.local/share/minecraft-world-backups`，再次验证整个 ZIP 和清单内所有文件的 SHA-256，成功后保留最近 14 份。本机 launchd 任务 `local.minecraft.backup-mirror` 每天 04:15 执行；它使用仓库外现有私有 SSH 凭据。该副本可应对单台服务器故障，两台设备同处局域网仍不等于离线或异地备份。

安装或更新本机镜像任务：`python3 scripts/install-backup-mirror.py`。卸载时先执行 `launchctl bootout gui/$(id -u)/local.minecraft.backup-mirror`，再删除对应的 `~/Library/LaunchAgents/local.minecraft.backup-mirror.plist`；已有备份保留。

`ops/windows/verify-restore.ps1` 可在 E 盘隔离目录解压并验证最新备份，以回环地址 `127.0.0.1:25575`、1 GB 最大堆启动恢复副本，确认启动与优雅保存关闭；不使用生产世界目录。演练结果写入备份目录的 `restore-rehearsal-result.json`。`test-maintenance.ps1` 和 `test-snapshot-policy.ps1` 在 Windows 实际 PowerShell 运行时验证进程识别、日志游标、原子写入和快照准入条件。

## 回滚与恢复

配置部署前的副本在服务器 `backups/maintenance-*`。本次优化前的原始视距与启动脚本位于 `backups/maintenance-20261109-234523`。恢复配置需优雅停服、复制对应文件并重新启动。

恢复世界时，先停止机器人会话并用 `stop.cmd` 关闭游戏服；将当前世界移到另一个备份目录，解压所选 ZIP，按 `manifest.json` 校验 SHA-256，再恢复 `world`。按需要恢复管理配置后启动服务器，确认日志和世界状态再恢复原会话。文件一致性验证与实际启动演练均不能替代生产业务状态的逐项核对。

修改后执行 ESLint、TypeScript 检查、构建、AVA 测试及 `npm run test:runtime`。协议与游戏操作变更还需要现有身份控制者进行实际游戏验证。
