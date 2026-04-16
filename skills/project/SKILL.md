---
name: project
description: List registered projects and their Telegram topic mappings. Use when the user wants to see which projects have topics or check topic IDs.
user-invocable: true
allowed-tools:
  - Read
---

# /telegram-topics:project — Project Management

Arguments passed: `$ARGUMENTS`

---

## Dispatch on arguments

### No args or `list`

1. Read `~/.claude/channels/telegram-topics/topics.json`.
2. If missing or empty, say "No projects registered yet."
3. Otherwise, show a table:

| Project Path | Topic Name | Topic ID |
|---|---|---|
| /Users/amir/Development/my-api | API Backend | 12345 |

4. Show current working directory and whether it has a topic registered.
