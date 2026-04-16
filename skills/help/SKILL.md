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

Each project directory gets its own Telegram Forum Topic. Messages in each
topic reach only the Claude Code instance running in that project directory.

----- Commands -----

Setup:
  /telegram-topics:configure <token>          Save the bot token
  /telegram-topics:configure chat <chat_id>   Set the supergroup chat ID
  /telegram-topics:configure topic <name>     Custom topic name for current project
  /telegram-topics:configure clear            Remove the stored token
  /telegram-topics:configure                  Show full status

Pairing / access:
  /telegram-topics:pair <code>                Approve a pairing code (shortcut)
  /telegram-topics:access pair <code>         Same, via the access skill
  /telegram-topics:access deny <code>         Reject a pending code
  /telegram-topics:access allow <senderId>    Manually allowlist a user
  /telegram-topics:access remove <senderId>   Remove a user from the allowlist
  /telegram-topics:access policy <mode>       pairing | allowlist | disabled

Projects:
  /telegram-topics:project list               Show all registered topics

Daemon:
  /telegram-topics:daemon status              PID, uptime, running version
  /telegram-topics:daemon stop                Kill the daemon
  /telegram-topics:daemon restart             Stop; next session spawns fresh
  /telegram-topics:daemon log                 Tail the daemon log

----- First-run checklist -----

1. Create a bot with @BotFather, copy the token.
2. Create a Telegram supergroup, enable Topics in group settings.
3. Add the bot as admin with "Manage Topics" and "Post Messages".
4. Forward a message from the group to @userinfobot to get the chat ID.
5. /telegram-topics:configure <token>
6. /telegram-topics:configure chat <chat_id>
7. Exit Claude Code, restart with:
      claude --dangerously-load-development-channels plugin:telegram-topics@wilfoa-plugins
8. In Telegram, send any message in a topic.
9. Bot replies with a 6-char pairing code.
10. /telegram-topics:pair <code>
11. /telegram-topics:access policy allowlist

----- Repo -----

https://github.com/wilfoa/claude-telegram-topics
```

After showing this, ask: *"What do you want to do?"* — or, if the user's
original message indicated a specific need (e.g. "how do I rename a topic?"),
point them directly to the relevant command.
