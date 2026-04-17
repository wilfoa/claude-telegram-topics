@AGENTS.md

## Claude Code specifics

- Use TaskCreate / TaskUpdate to track work on multi-step changes. Mark tasks `completed` as soon as each is done; don't batch.
- When a change touches the daemon, re-run `bun test` after each intermediate edit rather than at the end — the component tests are the main regression net for concurrency.
- For UI changes to skills (`skills/*/SKILL.md`), remember that the body is *instructions to Claude*, not config. Prose clarity matters more than terseness; examples of expected user output help.
- Prefer `Edit` over `Write` for files that already exist. Reserve `Write` for new files.
- Don't amend commits. If a pre-commit hook fails, fix and make a new commit.
