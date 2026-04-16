---
name: daemon
description: Manage the Telegram Topics daemon — check status or stop it. Use when the user asks about the daemon process or wants to stop it.
user-invocable: true
allowed-tools:
  - Read
  - Bash(kill *)
  - Bash(ps *)
---

# /telegram-topics:daemon — Daemon Management

Arguments passed: `$ARGUMENTS`

---

## Dispatch on arguments

### No args or `status`

1. Read `~/.claude/channels/telegram-topics/daemon.pid`.
2. If missing, say "Daemon is not running."
3. If present, check if the process is alive: `kill -0 <pid>`.
4. If alive, show PID and uptime (check process start time via `ps -p <pid> -o lstart=`).
5. If not alive, say "Daemon PID file exists but process is not running (stale)."

### `stop`

1. Read `daemon.pid`.
2. If missing, say "Daemon is not running."
3. Send `SIGTERM`: `kill <pid>`.
4. Confirm: "Daemon stopped."

### `restart`

1. Stop (as above, ignore if not running).
2. Say "Daemon will auto-start on next Claude Code session with --channels."
