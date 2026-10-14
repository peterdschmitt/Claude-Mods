# Ship queue

A Claude Code pane that shows code written but not live yet, color-coded by readiness, with approve-to-ship buttons.

- **Green** — checks pass, no conflicts. **Ship** → Confirm squash-merges into main (Vercel deploys to production).
- **Amber** — checks running or branch behind main.
- **Red** — failing checks or merge conflicts. **Fix** hands it to Claude, who fixes and pushes.
- **Grey** — drafts, branches without a PR, uncommitted work. **Open PR** → Confirm: Claude opens the PR and it ships automatically once every check is green.
- **Shipped** — the last 15 merges into main, newest first.

## Install

Needs the GitHub CLI signed in: `gh auth login`.

At the Claude Code prompt:

```
/plugin install ship-queue --marketplace peterdschmitt/claude-mods
```

Answer `y` to add the marketplace, pick the user scope. Open Claude Code in a project folder; the pane opens on its own, or type `/ship`.

## Using the buttons

Terminal clicks don't reach the pane, so every button has a number:

- **ctrl+x tab** focuses the pane, then press the item's number (1–9). Ship and Open PR ask first: **y** confirms, **n** cancels.
- Or type it: `/ship 68` (a PR number), `/ship 2` (the item's number) or `/ship <branch>`. Typing it is the confirmation.

## Chat links

Items whose commits or PR carry a `Claude-Session` link show 💬 (Terminal) or **chat ↗** (app). `/ship chat 4` or `/ship chat 68` opens that chat in your browser.

## Updating

```
claude plugin marketplace update claude-mods && claude plugin update ship-queue@claude-mods
```

Then restart Claude Code.
