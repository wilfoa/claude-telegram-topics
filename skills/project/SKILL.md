---
name: project
description: List registered projects and their Telegram topic mappings, or remove a topic (with a two-step confirmation). Use when the user wants to see which projects have topics, check topic IDs, or delete a topic.
user-invocable: true
allowed-tools:
  - Read
  - Write
  - Bash(bun *)
  - Bash(mkdir *)
  - Bash(rm *)
  - Bash(chmod *)
  - Bash(ls *)
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

### `remove <name-or-path>`

Deletes the matching topic from Telegram *and* `topics.json`. Destructive — requires a confirmation token in a follow-up command.

1. Read `~/.claude/channels/telegram-topics/topics.json`. If missing or empty, say "No projects registered — nothing to remove." and stop.
2. Resolve the target. The argument may be:
   - A project path key exactly as stored (e.g. `/Users/me/proj`).
   - A topic name exactly as stored (e.g. `proj-a`).
   - An instance-suffixed key (e.g. `/Users/me/proj#exp`).
   Match on path first, then topic name. If no match, list the available topics and stop.
   If more than one match (ambiguous topic name across multiple paths), list the candidates and ask the user to re-invoke with the full path.
3. Generate a 6-character token: `openssl rand -hex 3` via Bash, or use Claude-side randomness (e.g. slice of a UUID). Must be lowercase hex.
4. Create the pending directory if needed: `mkdir -p ~/.claude/channels/telegram-topics/pending-removes`.
5. Write `~/.claude/channels/telegram-topics/pending-removes/<token>.json` with:
   ```json
   {"projectPath": "<full-path>", "topicName": "<name>", "topicId": <id>, "expiresAt": <unix-ts-in-seconds>}
   ```
   Expiry = now + 300 seconds. `chmod 600` the file.
6. Tell the user, verbatim:
   > About to remove topic **<topicName>** (id <topicId>) for project `<projectPath>`. This deletes the topic from Telegram — the conversation history in it is lost.
   >
   > Confirm within 5 minutes:
   > ```
   > /telegram-topics:project remove-confirm <token>
   > ```

Do **not** call the helper at this stage — the user must opt in again.

### `remove-confirm <token>`

1. Read `~/.claude/channels/telegram-topics/pending-removes/<token>.json`.
2. If missing, say "Unknown or expired token. Re-run `/telegram-topics:project remove <name>` to get a new one." and stop.
3. Check `expiresAt`. If `now > expiresAt`, delete the pending file and tell the user the token expired.
4. Invoke the helper script, substituting the plugin root (`${CLAUDE_PLUGIN_ROOT}`) and the recorded projectPath:
   ```bash
   bun "${CLAUDE_PLUGIN_ROOT}/remove-topic.ts" "<projectPath>"
   ```
5. Exit code `0` → print the helper's stdout and confirm success. Exit code non-zero → surface the error; do **not** delete the pending file so the user can retry after fixing the underlying issue.
6. On success, remove the pending file: `rm ~/.claude/channels/telegram-topics/pending-removes/<token>.json`.

Notes on behavior:
- If the daemon is down, the helper exits with "daemon socket not found". Ask the user to start a Claude Code session (the shim will auto-spawn the daemon) and try the confirm command again.
- If the topic was already deleted server-side, the daemon clears local state and reports "Telegram API error" alongside success — the local view is consistent either way.
