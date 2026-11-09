# Repository Guidelines

## Project Structure & Module Organization

- `src/main.ts` wires the stdio MCP server, bot connection, and tool registrations.
- `src/tools/*-tools.ts` groups gameplay tools by capability. Shared modules handle configuration, reconnection, proxy lifecycle, logging, and chat storage.
- `tests/*.test.ts` mirrors source modules. `.github/` contains CI and the PR template.
- `dist/` is generated output. `.npm/` and `.minecraft-server/` hold ignored local runtimes, account caches, and worlds; there is no separate asset pipeline.

## Build, Test, and Development Commands

Use Node.js 22+ and run commands from the repository root.

| Command | Purpose |
| --- | --- |
| `npm ci` | Install locked dependencies and build through `prepare`. |
| `npm run dev -- --host 127.0.0.1 --port 25568 --username DevBot --minecraft-version 26.1` | Run TypeScript locally through the protocol proxy described below. |
| `npm run build` | Compile source and declarations into `dist/`. |
| `npm start -- --host 127.0.0.1 --port 25568 --username LLMBot --minecraft-version 26.1` | Run the compiled MCP server locally through the protocol proxy. |
| `npm test` | Run AVA tests. |
| `npx tsc --noEmit` | Type-check source and tests. |
| `npm run lint` / `npm run lint:fix` | Check ESLint rules or apply automatic fixes. |

## Coding Style & Naming Conventions

Use strict TypeScript, two-space indentation, semicolons, and ESM imports with `.js` extensions for local modules. Follow surrounding quote style. Use kebab-case filenames and tool names, camelCase functions, and PascalCase classes/interfaces. Register tools through `ToolFactory` with Zod schemas; reuse coordinate helpers. ESLint is configured; no dedicated formatter is configured.

## Testing Guidelines

Use AVA with `tsx` and Sinon stubs/fake timers. Name files `<module>.test.ts` and describe behavior in test titles. Mock Minecraft connections for unit tests; cover validation, failures, and cleanup. Run a focused file with `npm test -- tests/block-tools.test.ts`. CI requires lint, type-checking, build, and tests; no coverage threshold is configured. Record live Minecraft validation for protocol or gameplay changes.

## Commit & Pull Request Guidelines

History mixes descriptive subjects with scoped messages such as `feat(tools): ...`; use concise, focused subjects. Follow `.github/pull_request_template.md` and acknowledge `CONTRIBUTING.md`. Explain behavior changes, link relevant issues, list validation, and identify Minecraft/proxy versions when applicable.

## Configuration & Agent Guidance

Reserve stdout for MCP; use `src/logger.ts` for stderr diagnostics. Never commit credentials or account caches. Follow the Local MCP Connection section below for this LAN's ViaProxy setup. For library/API/CLI documentation questions, use Context7: `resolve-library-id`, then `query-docs`.

## Server Connection

- SSH host: `192.168.1.3`
- SSH port: `22`
- SSH user: `xiaqingbo`
- Connect with `ssh -p 22 xiaqingbo@192.168.1.3`.
- Account credentials, including the password, are stored in `/Users/xiaqingbo/.config/minecraft-mcp-server/server-credentials.json` under the `ssh` key. This user-private file is outside the repository; its directory has mode `700` and the file has mode `600`.
- Never copy the password into repository files, logs, or command output.

## Minecraft Java Server

- Official vanilla release `26.3`, confirmed as the latest stable release from Mojang's version manifest on `2026-11-09`.
- Install directory on the Windows server: `D:\Game\minecraft-java-26.3`.
- Connection address: `192.168.1.3:25565` (TCP). `online-mode=false`, `enforce-secure-profile=false`, and `white-list=false`; LAN players can join with offline identities, and usernames are not authenticated.
- Dedicated runtime: Temurin Java `25.0.5+8` in the install directory's `runtime` folder. Heap settings: `-Xms1G -Xmx4G`.
- Windows Firewall rule: `Minecraft Java 26.3 (LAN)`, allowing inbound TCP `25565` from `LocalSubnet` on all profiles for the dedicated Java executable.
- Startup task: `MinecraftJava-26.3`, running as `SYSTEM` at boot with no execution time limit. The install directory is restricted to the server account, Administrators, and SYSTEM.
- Start with `D:\Game\minecraft-java-26.3\start.cmd` or `schtasks.exe /Run /TN "MinecraftJava-26.3"`.
- Stop gracefully and save the world with `D:\Game\minecraft-java-26.3\stop.cmd`. Use this before backups or moving the server files.
- Configuration: `server.properties`; world: `world`; gameplay logs: `logs\latest.log`; launcher output: `launcher-logs`; download sources and hashes: `installation.json`.
- The user explicitly accepted the Minecraft EULA on `2026-11-09`; `eula=true`.
- Live validation on `2026-11-09` passed: initial world generation, server-list status and ping from `192.168.1.5` (version `26.3`, protocol `777`), graceful shutdown with world saving, and restart through `start.cmd`. The server was left running in the background.
- Access settings were changed at the user's request on `2026-11-09`: whitelist and account authentication are disabled. The original configurations are backed up under the install directory's `backups` folder. After graceful shutdown and restart, server-list status/ping and an offline login succeeded without an account authentication request; the test connection closed before entering the world.
- Bot compatibility with `26.3` was verified separately on `2026-11-09` through the local ViaProxy connection below, including bot spawn and MCP gameplay responses.

## Local MCP Connection

- Deployment decision, confirmed by the user on `2026-11-09`: run the MCP server and ViaProxy on the local Mac in `/Users/xiaqingbo/Documents/ChatGPT/minecraft-mcp-server`. The Windows host runs the Minecraft game server; SSH port `22` is for administration.
- Connection path: local MCP client → local Node.js stdio MCP server → ViaProxy at `127.0.0.1:25568` → Minecraft at `192.168.1.3:25565`.
- Local Node.js: `/Users/xiaqingbo/.nvm/versions/node/v26.13.0/bin/node`. Install dependencies and build with `npm ci` from the repository root.
- The locked Mineflayer version is `4.39.0`, whose highest supported client version is `26.1` (protocol `775`). The game server is `26.3` (protocol `777`); use the proxy and explicitly pass `--minecraft-version 26.1`. Direct connection with automatic version detection is incompatible.
- The game server uses `online-mode=false`; the bot joins as the offline identity `LLMBot`. SSH credentials are not Minecraft credentials and are not needed for this local MCP connection.
- `src/client-tick-end.ts` sends the tick-end markers missing from Mineflayer `4.39.0`, after each physics tick's movement update. Without them this server disconnects the bot with `multiplayer.disconnect.invalid_player_movement`. Keep Mineflayer pinned until this workaround can be replaced by native tick-end support; avoid sending duplicate markers after an upgrade.

### Local ViaProxy runtime

- Runtime directory: `/Users/xiaqingbo/Documents/ChatGPT/minecraft-mcp-server/.npm/viaproxy` (ignored by Git).
- Installed jar: `ViaProxy-3.4.15-SNAPSHOT.jar`, official ViaVersion Jenkins build `963`, commit `7b9b9b5`. Download URL and SHA-256 are recorded in that directory's `installation.json`.
- Java: `/Users/xiaqingbo/Library/Application Support/minecraft/runtime/java-runtime-epsilon/mac-os-arm64/java-runtime-epsilon/jre.bundle/Contents/Home/bin/java` (Microsoft OpenJDK `25.0.1`).
- Bind only to loopback. When an existing local session is running, it already owns this proxy; do not start a second instance.
- To start the proxy manually in the foreground:

```sh
cd /Users/xiaqingbo/Documents/ChatGPT/minecraft-mcp-server/.npm/viaproxy
"/Users/xiaqingbo/Library/Application Support/minecraft/runtime/java-runtime-epsilon/mac-os-arm64/java-runtime-epsilon/jre.bundle/Contents/Home/bin/java" \
  -Xms64M -Xmx512M -Djava.awt.headless=true \
  -jar ViaProxy-3.4.15-SNAPSHOT.jar cli \
  --bind-address 127.0.0.1:25568 \
  --target-address 192.168.1.3:25565 --target-version 26.3 \
  --auth-method NONE --proxy-online-mode false
```

With the proxy running, an MCP client can launch the stdio server using this configuration:

```json
{
  "command": "/Users/xiaqingbo/.nvm/versions/node/v26.13.0/bin/node",
  "args": [
    "/Users/xiaqingbo/Documents/ChatGPT/minecraft-mcp-server/dist/main.js",
    "--host", "127.0.0.1", "--port", "25568",
    "--username", "LLMBot", "--minecraft-version", "26.1"
  ]
}
```

### Existing local bot session

- A background session was started on `2026-11-09` using `.npm/mcp-session.mjs`. It owns both ViaProxy and an MCP SDK client connected to this project's real stdio server. This is a local runtime session; no Windows MCP service or Mac boot task was installed.
- Local control socket: `/Users/xiaqingbo/Documents/ChatGPT/minecraft-mcp-server/.npm/mcp-control.sock`, restricted to the current user. Requests are forwarded to the stdio MCP client; this is not a network MCP HTTP endpoint.
- Reuse this session for subsequent game actions. Before launching another MCP client with the same bot identity, stop this session to avoid duplicate `LLMBot` connections.
- Start or inspect the existing session, query the bot, and stop it using:

```sh
python3 /Users/xiaqingbo/Documents/ChatGPT/minecraft-mcp-server/.npm/start-session.py
python3 /Users/xiaqingbo/Documents/ChatGPT/minecraft-mcp-server/.npm/mcp-control.py status
python3 /Users/xiaqingbo/Documents/ChatGPT/minecraft-mcp-server/.npm/mcp-control.py get-position
python3 /Users/xiaqingbo/Documents/ChatGPT/minecraft-mcp-server/.npm/mcp-control.py stop
```

- To call a gameplay tool with arguments, pass its name and a JSON object, for example: `python3 /Users/xiaqingbo/Documents/ChatGPT/minecraft-mcp-server/.npm/mcp-control.py get-block-info '{"x":-505,"y":62,"z":-94}'`.
- Session logs: `.npm/mcp-session.log`; proxy logs: `.npm/viaproxy/launcher.log`. `.npm/mcp-session.json` is a cached startup snapshot; use a fresh `get-position` tool call to confirm the bot is currently connected.
- Live validation on `2026-11-09`: `LLMBot` spawned at approximately `(-505, 63, -94)`, remained connected with tick-end markers, and MCP `get-position`, `jump`, `list-inventory`, and `detect-gamemode` succeeded. The bot was in survival mode with an empty inventory. Protocol compatibility for every gameplay tool has not been established.
- Source validation passed: ESLint, TypeScript checking, build, and all `122` AVA tests, including four tick-end ordering/lifecycle regressions.
