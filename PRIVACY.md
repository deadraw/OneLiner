# OneLiner privacy policy

OneLiner is a Claude Code mod by deadraw. It has no servers, no accounts, no analytics and no telemetry. Nothing it collects leaves your machine except through Claude Code itself, in your own session.

## What it stores, on your machine only

- **Usage totals for the work report and the strip**: per day, how long Claude worked, the API-price cost Claude Code reports, token counts, how many prompts were answered, which models ran and the names of the project folders. Also the conversation's running cost and the last 5-hour limit reading. These are kept in Claude Code's local mod store on your computer.
- **Handoff notes**: when you ask for a handoff (or before a compaction), a summary of the conversation is written to a file in your project (`HANDOFF.md`, `CURRENT.md`, the file you already use, or `.claude/handoff.md`), with a backup of the previous text.

There is no expiry: the data stays until you delete it. Uninstalling OneLiner stops all collection; the handoff files are ordinary files in your project that you can delete.

## What it sends, and where

- **Model calls go through your own Claude Code session**, the same way your prompts do. Features such as `/brief`, ideas, `/handoff`, commit messages, Create PR texts and Prompt Upgrade send Claude a question with a short digest: your recent prompts, Claude's last answer, your handoff file and `git status`. They fall under Anthropic's terms for your account, not under any service of OneLiner's.
- **`git` and `gh`** talk only to your repository's own remote, signed in the way you set them up. OneLiner never sees those logins.
- **One local HTTP request** to `http://localhost:<your dev port>/`, to show whether your dev server is up. It never leaves your machine.

OneLiner sends nothing anywhere else, never reads your credentials, and never changes Claude Code's settings or permission files.

## Children

OneLiner is a developer tool and is not intended for people under 18.

## Changes and contact

Changes to this policy are made in this file, and its history is public in the repository. Questions: [open an issue](https://github.com/deadraw/OneLiner/issues).

The full list of everything OneLiner runs, reads and writes is in the README, under [Privacy and what it runs](README.md#privacy-and-what-it-runs).
