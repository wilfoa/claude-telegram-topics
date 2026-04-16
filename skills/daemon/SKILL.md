---
name: daemon
description: Manage the Telegram Topics daemon — check status, stop it, or tail its log. Use when the user asks about the daemon process, wants to stop it, or wants to debug why messages aren't flowing.
user-invocable: true
allowed-tools:
  - Read
  - Bash(kill *)
  - Bash(ps *)
  - Bash(tail *)
---

# /telegram-topics:daemon — Daemon Management

Arguments passed: `$ARGUMENTS`

---

## Dispatch on arguments

### No args or `status`

1. Read `~/.claude/channels/telegram-topics/daemon.pid`.
2. If missing, say "Daemon is not running (next Claude Code session with `--channels` will auto-start it)."
3. If present, check if the process is alive: `kill -0 <pid>`.
4. If alive:
   - Show PID and uptime (`ps -p <pid> -o lstart=`).
   - Show the executable path (`ps -p <pid> -o args=`). If the path contains
     `plugins/cache/<marketplace>/<plugin>/<version>`, that version is what
     the daemon is running.
   - Note: if the shown version doesn't match the installed plugin version
     (check `~/.claude/plugins/cache/` for the latest), the daemon is stale
     and should be stopped so the next session can spawn the updated one.
5. If not alive, say "Daemon PID file exists but process is not running (stale)."

### `stop`

1. Read `daemon.pid`.
2. If missing, say "Daemon is not running."
3. Send `SIGTERM`: `kill <pid>`.
4. Wait 2 seconds. If still alive (`kill -0`), send `SIGKILL`: `kill -9 <pid>`.
5. Confirm: "Daemon stopped."

### `restart`

1. Stop the running daemon (as above, ignore if not running).
2. Say "Daemon will auto-start on next Claude Code session with `--channels`.
   The shim also auto-detects stale daemons (from outdated plugin cache paths)
   on connect and replaces them, so normally no manual action is needed after
   `/plugin update`."

### `log`

Tail the daemon log at `~/.claude/channels/telegram-topics/daemon.log`.
Show the last ~50 lines. Useful for debugging when messages don't route.

Common lines to look for:
- `inbound chat=... thread=... sender=...` — a message arrived from Telegram
- `gate result for <id> = deliver` — sender is allowed
- `gate result for <id> = drop` — sender is blocked (not in allowFrom)
- `routing topic=N → shim for /path` — routed successfully to a shim
- `routing topic=N → NO SHIM` — no Claude Code session connected for this topic
- `drop — chat X != configured Y` — message is in a different chat than the configured one
- `drop — no message_thread_id` — message was not in a Forum Topic
- `409 Conflict` — another process is polling with the same bot token
