# AGENTS.md

Instructions for AI coding agents (Claude Code, Copilot, Cursor, Codex, etc.) working on this repo.

## Project overview

`telegram-topics` is a Claude Code channel plugin that routes each project directory to its own Telegram Forum Topic. A single long-lived **daemon** owns the Telegram bot connection; one **shim** per Claude Code session talks to the daemon over a Unix socket. Protocol is newline-delimited JSON.

The repo is small and flat — every source file lives at the root. There are no framework layers, no DI, no code generation. Prefer editing existing files over creating new ones.

## Repo layout

| File | Role |
|------|------|
| `daemon.ts` | Long-lived process. Polls Telegram via grammy, owns the Unix-socket server, routes messages to shims, manages forum topics. |
| `shim.ts` | MCP stdio server spawned by Claude Code per session. Auto-starts the daemon, registers a project path, relays tool calls and notifications. |
| `protocol.ts` | Message types + parser/serializer for the shim↔daemon wire format. Pure helpers only. |
| `state.ts` | JSON read/write for `.env`, `access.json`, `topics.json`, `labels.json`, `daemon.pid`. Pure I/O. |
| `gate.ts` | Inbound-message gate: policy enforcement, pairing code generation, permission-reply regex. Pure. |
| `remove-topic.ts` | Standalone helper invoked by the `project remove-confirm` skill to issue a remove over the daemon socket. |
| `skills/<name>/SKILL.md` | User-invocable slash commands. Markdown with YAML frontmatter (`name`, `description`, `user-invocable`, `allowed-tools`). Claude interprets the body. |
| `*.test.ts` | Tests — see [Testing](#testing). |
| `.claude-plugin/plugin.json` | Plugin manifest. Bump `version` with every feat/fix commit. |
| `.mcp.json` | MCP server entry point for the shim. |

## Build, test, and run commands

- `bun install` — install deps. Runs automatically from `.mcp.json` on plugin invocation.
- `bun test` — full suite (unit + integration + component). Target: 0 failures, 0 flakes across 5+ consecutive runs.
- `bun test <file>` — single-file run (e.g. `bun test component.test.ts`).
- `bunx tsc --noEmit` — typecheck all `.ts` files. Must pass before commit.
- `bun daemon.ts` — run the daemon directly for local debugging. Exits immediately if another daemon holds `daemon.lock` in the state dir.
- `bun shim.ts` — run the shim. Only useful for manual MCP-stdio testing; normally spawned by Claude Code.

Use the `TELEGRAM_TOPICS_STATE_DIR` env var to point either process at a scratch state dir (critical for tests).

## Testing

Three layers; the component layer is the most important for this codebase.

### Unit
`shim.test.ts`, `protocol.test.ts`, `state.test.ts`, `gate.test.ts` — pure helpers with no I/O. When you add a pure function (e.g. a label resolver, a path mapper), write the unit test in the same commit.

### Integration
Round-trip tests for `parseMessages` + `serialize` under realistic stream conditions: fragmented delivery, 1 MB payloads, unicode, malformed frames between valid ones. Lives in `protocol.test.ts` under the "protocol round-trip" describe.

### Component
`component.test.ts` spawns **real daemon child processes** against scratch state dirs seeded with `.env`, `access.json`, and `topics.json`. No Telegram network is required — pre-seeding `topics.json` avoids `ensureTopic` calling `bot.api.createForumTopic`. The grammy poller hits 401 against the fake token and logs harmlessly; the socket side under test runs normally.

When adding component tests:
- Use the existing `seedStateDir`, `spawnDaemon`, `waitForSocket`, and `Client` helpers.
- Always pass a per-test timeout as the third `test(...)` arg — use `LONG_TIMEOUT` (20s) for anything that spawns daemons. Bun's default 5s times out under full-suite load.
- Register the child with `track()` and the state dir with `trackDir()` so `afterEach` cleans them up. Leaked children will pollute unrelated tests.
- Prefer scenarios that would catch a real regression over coverage chasing. Example: "two daemons launched in the same tick" exercises the atomic lock and would fail loudly if the lock regressed.

### Manual end-to-end
Documented as a checklist in `README.md` → Development → Manual end-to-end. Requires a real bot + supergroup. Not automatable.

## Concurrency invariants

The repo's single hardest-earned invariant: **at most one daemon process per state dir, ever.** Two daemons on one bot token fight over Telegram's `getUpdates` consumer and produce `409 Conflict`, eventually killing one (and orphaning its shim). Do not regress this.

Three layers enforce it:

1. **`daemon.ts` lifetime lock.** At startup the daemon does `openSync(join(STATE_DIR, 'daemon.lock'), 'wx')` — atomic on POSIX; exactly one of N racing daemons succeeds. Losers read the holder PID, verify it's alive, exit 0. Stale-holder recovery steals the lock. The OS releases the fd on process exit (backed up by a `process.on('exit')` cleanup).
2. **`shim.ts` spawn lock.** `withSpawnLock(SPAWN_LOCK_PATH, fn)` wraps `ensureDaemon()` using the same `wx`-based pattern on a separate lockfile (`daemon.spawn.lock`). Prevents two shims from both entering the spawn critical section in the first place.
3. **`shim.ts` post-acquire re-check.** After getting the spawn lock, re-check `existsSync(SOCKET_PATH)` before spawning — a sibling shim may have already spawned while we waited.

If you're tempted to replace any of these with probe-then-act, stop. Probes have race windows that concurrent spawns will hit. Atomic `wx` is the primitive; use it.

## Socket protocol

Defined in `protocol.ts`. Newline-delimited JSON over a Unix socket. One message per line; embedded newlines in strings are JSON-escaped.

Shim → Daemon: `register`, `tool_call`, `permission_verdict`, `forward_permission_request`, `remove_topic`.
Daemon → Shim: `registered`, `inbound`, `tool_result`, `permission_request`, `permission_verdict_forward`, `error`, `remove_topic_result`.

To add a message type:
1. Add the type literal + fields in `protocol.ts`, include it in the `ShimMessage` or `DaemonMessage` union.
2. Handle it in `daemon.ts → handleShimMessage` (for shim-originated) or in the shim's `handleDaemonMessage` (for daemon-originated).
3. Add a component test that asserts the end-to-end behavior, not just the parse.
4. Update the relevant skill if it's user-facing.

Never hand-roll JSON parsing in handlers — `parseMessages` handles partial frames correctly; bypassing it will reintroduce buffer-boundary bugs.

## State files

Everything under `~/.claude/channels/telegram-topics/` (configurable via `TELEGRAM_TOPICS_STATE_DIR`). Ownership matters — observe it:

| File | Written by | Do not write from |
|------|-----------|-------------------|
| `.env` | configure skill | daemon, shim |
| `access.json` | access skill + daemon (for pairings and chatId capture) | — |
| `topics.json` | daemon only (actual Telegram state) | skills, shim |
| `labels.json` | configure skill only (user preferences) | daemon, shim |
| `daemon.lock` / `daemon.spawn.lock` | see Concurrency invariants | — |
| `pending-removes/*.json` | project skill (request) + project skill (consume on confirm) | daemon, shim |

Crossing these boundaries caused a past bug (rename stopped working because the configure skill wrote into topics.json, tricking the daemon into thinking Telegram had already renamed). Respect the ownership column.

## Code conventions

- **Bun-first.** Use `Bun.listen`, `Bun.connect`, `Bun.file` where they work. Fall back to Node's `child_process`, `fs` sync APIs where needed.
- **TypeScript strict.** `tsconfig.json` sets `"strict": true`. No `any` without a `// why` comment. Prefer narrowing to casting.
- **No defensive code at internal boundaries.** Shim↔daemon is trusted. Validate at external boundaries (Telegram API responses, user input from skills).
- **No comments stating *what* the code does.** Comments explain *why* — a hidden constraint, a subtle invariant, a workaround. Short lines, no paragraphs.
- **No emojis in source or docs.** The README uses some pre-existing emoji in example output blocks; don't add more.
- **Don't create new files when an existing one fits.** The repo is intentionally flat.
- **Don't add logging for logging's sake.** `process.stderr.write` is the log sink; each line should tell a future debugger something they couldn't derive from state files.

## Adding a feature — default order

1. Write the minimum change in `protocol.ts` if new wire messages are needed.
2. Implement on the daemon side.
3. Implement on the shim side (or add a standalone helper like `remove-topic.ts` when the feature is administrative).
4. Add a component test exercising the end-to-end path against a real daemon.
5. If there's a user-facing surface, extend or add a `skills/<name>/SKILL.md`. Keep `allowed-tools` minimal.
6. Update `README.md` (commands table + the relevant section) and `skills/help/SKILL.md` so the feature is discoverable.
7. Bump `.claude-plugin/plugin.json` version.

## Commit style

Conventional commits with the version in parentheses at the end of the title. Match the existing log:

```
feat: <concise change> (0.0.X)
fix: <concise change> (0.0.X)
docs: <concise change> (0.0.X)
```

Body: explain the *why*, the invariant being preserved, and any subtle tradeoff. Include test-suite numbers when they change (e.g., "61 → 70 tests"). Always sign commits with the `Co-Authored-By: Claude ...` line per the user's workflow.

One commit per semantic change. Don't squash feature + tests + docs into one multi-topic commit unless they're all necessary for the feature to be useful.

## Security considerations

- **Bot token.** Lives in `.env` mode 0600. Never log it, never copy it into error messages. The token's first 10 chars can appear masked in status output.
- **Allowlist gate.** `gate.ts` is the only authority on "can this sender's message reach a shim?". Don't add side-channels. The default policy is `pairing`, which accepts a message solely to produce a pairing code; the code goes in the topic, not the user's DMs.
- **File-path safety.** `assertSendable` in `daemon.ts` refuses to send state files as attachments. Preserve that check if you touch the reply/upload path.
- **Command execution.** Skills should declare narrow `allowed-tools` patterns (e.g. `Bash(bun *)`, not `Bash(*)`). Whenever you add a Bash invocation to a SKILL.md, add the matching pattern.

## Repository

- Upstream: https://github.com/wilfoa/claude-telegram-topics
- Marketplace: https://github.com/wilfoa/claude-plugins

If you push a commit, push to `origin main`. Do not force-push.
