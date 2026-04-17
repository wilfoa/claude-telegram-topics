---
name: help
description: Show the telegram-topics plugin help — list all commands and the typical setup flow. Use when the user asks what they can do with telegram-topics, wants a command list, or doesn't know where to start.
user-invocable: true
allowed-tools: []
---

# /telegram-topics:help — Plugin Help

Arguments passed: `$ARGUMENTS`

---

Show the user the following help text (you can tailor it slightly if the user's
question is narrower, but default to showing everything):

```
telegram-topics — Claude Code channel plugin with Forum Topics

Each project directory gets its own Telegram Forum Topic. Messages in
each topic reach only the Claude Code instance running in that project.

====================================================================
ONE-TIME SETUP  (per machine / Telegram account)
====================================================================

 1. Create a bot
      - DM @BotFather, run /newbot, copy the token.

 2. Create the supergroup
      - New group → convert to supergroup → Edit group → turn on Topics.
      - Add the bot as admin with "Manage Topics" + "Post Messages".

 3. Get the chat ID
      - Forward any message from the group to @userinfobot.
      - It returns a negative integer, e.g. -1001234567890.

 4. Save token + chat (in Claude Code, any directory)
      /telegram-topics:configure <token>
      /telegram-topics:configure chat <chat_id>

 5. Start Claude Code in any project so a topic exists
      cd ~/some/project
      claude --dangerously-load-development-channels \
             plugin:telegram-topics@wilfoa-plugins

 6. Pair your Telegram account  (ONE TIME per account)
      - In Telegram, open the new topic and send "hi".
      - Bot replies with a 6-char pairing code.
      - In Claude Code:
          /telegram-topics:pair <code>
          /telegram-topics:access policy allowlist

    Future projects reuse the same allowlist — no re-pairing.

====================================================================
PER-PROJECT SETUP  (each new project directory)
====================================================================

 1. (Optional) Set a custom topic name, BEFORE first session
      cd ~/Development/my-project
      /telegram-topics:configure topic "My Project"
      - Default is the directory basename. Skip this to accept it.

 2. Restart Claude Code in the project directory
      cd ~/Development/my-project
      claude --dangerously-load-development-channels \
             plugin:telegram-topics@wilfoa-plugins
      - Daemon creates/renames the Forum Topic on first connect.

 3. Talk to it
      - Messages in that topic route only to the Claude Code running
        in that directory. Reactions, attachments, and permission
        prompts all thread back to the same topic.

====================================================================
RUNNING MULTIPLE CLAUDE CODE SESSIONS IN THE SAME PROJECT
====================================================================

The default is auto-suffix: the first session in a directory gets
the primary topic, the second is auto-routed to "<cwd>#2" with a
topic named "<baseLabel> (#2)", the third to "(#3)", etc. No eviction
required, no env var required. Freed slots are reused before new
integers are allocated.

For a stable, human-chosen name instead of an integer, set
TELEGRAM_TOPICS_INSTANCE on launch:

    TELEGRAM_TOPICS_INSTANCE=exp claude \
      --dangerously-load-development-channels \
      plugin:telegram-topics@wilfoa-plugins

Registers as "<baseLabel> (exp)" under "<cwd>#exp". Named instances
don't participate in integer numbering — two unnamed sessions plus a
"#exp" session still land on slots 1, 2, and exp (not 1, 2, 3).

Run /telegram-topics:configure instance <name> for the launch recipe,
or /telegram-topics:configure instance (no name) to list named +
integer instances currently in topics.json for the cwd.

Eviction only fires if you EXPLICITLY collide on the same named or
integer-suffixed instance (e.g. two shells both setting
TELEGRAM_TOPICS_INSTANCE=exp). "Explicit wins over auto."

====================================================================
REMOVING A TOPIC
====================================================================

Two-step, token-confirmed:

    /telegram-topics:project remove <name-or-path>
    # → prints a 6-char token (5 min TTL)
    /telegram-topics:project remove-confirm <token>

Deletes the topic from Telegram and clears its entry from
topics.json. Any Claude Code session still attached is evicted.

====================================================================
COMMANDS
====================================================================

Setup:
  /telegram-topics:configure <token>          Save the bot token
  /telegram-topics:configure chat <chat_id>   Set the supergroup chat ID
  /telegram-topics:configure topic "<name>" [--instance <inst>]
                                              Rename the topic live (no
                                              session restart needed).
                                              --instance targets a named
                                              instance topic.
  /telegram-topics:configure instance [name]  Launch recipe for a second
                                              Claude Code session in the same
                                              project with its own topic.
                                              No name → list instance topics.
  /telegram-topics:configure clear            Remove the stored token
  /telegram-topics:configure                  Show full status

Pairing / access:
  /telegram-topics:pair <code>                Approve a pairing code
  /telegram-topics:access pair <code>         Same, via the access skill
  /telegram-topics:access deny <code>         Reject a pending code
  /telegram-topics:access allow <senderId>    Manually allowlist a user
  /telegram-topics:access remove <senderId>   Remove a user
  /telegram-topics:access policy <mode>       pairing | allowlist | disabled

Projects:
  /telegram-topics:project list               Show all registered topics
  /telegram-topics:project remove <name|path> Request deletion. Prints a
                                              confirmation token (5 min TTL).
  /telegram-topics:project remove-confirm <token>
                                              Complete the deletion.

Daemon:
  /telegram-topics:daemon status              PID, uptime, version
  /telegram-topics:daemon stop                Kill the daemon
  /telegram-topics:daemon restart             Stop; next session respawns
  /telegram-topics:daemon log                 Tail the daemon log

Repo: https://github.com/wilfoa/claude-telegram-topics
```

After showing this, ask: *"What do you want to do?"* — or, if the user's
original message indicated a specific need (e.g. "how do I rename a topic?"),
point them directly to the relevant command.
