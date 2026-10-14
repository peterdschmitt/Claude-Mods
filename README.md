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
