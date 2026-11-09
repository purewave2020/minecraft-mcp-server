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

`LLMBot` 的控制归属保留在 `.npm/runtime/controller-llmbot.json`。控制请求携带 `CODEX_THREAD_ID`，已分配身份的操作及停止请求仅接受所属控制者；诊断读取可独立执行。转交控制权仍须明确的人类指令。

维护期间可写入私有 `.npm/runtime/maintenance.json`，将 `untilUnix` 字段设为未来的 Unix 秒数。截止前会阻止新会话启动；维护完成后删除此文件。已有连接仍可查询状态。

## 动作、聊天与诊断

- 修改游戏状态的工具串行执行；状态、聊天读取等工具可独立响应。
- 导航默认 30 秒、上限 60 秒，手动移动上限 10 秒；单次动作总上限 70 秒，MCP 请求上限 90 秒，控制套接字上限 100 秒。
- 取消、断线、死亡、重生会停止动作。无法及时结束的原生操作会隔离旧连接并重连，防止旧动作继续影响后续操作。
- 服务端纠正位置、无效坐标或区块未加载会停止当前移动。`get-connection-status` 返回纠正和停止计数，排查时应结合游戏日志。
- 自动防御设置按身份保存并在重连时恢复。`get-status` 返回实际防御状态；它不能保证复杂地形中的生存。
- `qingyage` 的未确认消息独立持久化。使用 `read-chat` 的 `pendingOnly:true` 和序号游标读取，用 `ack-chat` 确认已处理消息；普通最近聊天保留 100 条。历史待处理消息在确认前持续保留。
- 状态、聊天和观察文件原子写入并限制文件权限。消费观察文件必须检查 `observedAt` 和 `connected`。

## Windows 服务器

维护源文件在 `ops/windows/`。通过现有私有 SSH 助手部署：

```sh
python3 scripts/deploy-windows-maintenance.py
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

## 回滚与恢复

配置部署前的副本在服务器 `backups/maintenance-*`。本次优化前的原始视距与启动脚本位于 `backups/maintenance-20261109-234523`。恢复配置需优雅停服、复制对应文件并重新启动。

恢复世界时，先停止机器人会话并用 `stop.cmd` 关闭游戏服；将当前世界移到另一个备份目录，解压所选 ZIP，按 `manifest.json` 校验 SHA-256，再恢复 `world`。按需要恢复管理配置后启动服务器，确认日志和世界状态再恢复原会话。当前自动验证覆盖压缩包解压和文件一致性；仍需在隔离目录演练实际服务器加载恢复世界。

修改后执行 ESLint、TypeScript 检查、构建、AVA 测试及 `npm run test:runtime`。协议与游戏操作变更还需要现有身份控制者进行实际游戏验证。
