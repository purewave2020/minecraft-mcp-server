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
| `npm run dev -- --host 127.0.0.1 --port 25565 --username DevBot` | Run TypeScript against a local Minecraft server. |
| `npm run build` | Compile source and declarations into `dist/`. |
| `npm start -- --host 127.0.0.1 --port 25565` | Run the compiled MCP server. |
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

Reserve stdout for MCP; use `src/logger.ts` for stderr diagnostics. Never commit credentials or account caches. Follow `README.md` for ViaProxy setup. For library/API/CLI documentation questions, use Context7: `resolve-library-id`, then `query-docs`.
