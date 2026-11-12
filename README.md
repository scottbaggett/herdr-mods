# herdr-mods

Panels for the [Herdr](https://herdr.dev) desktop app, plus the small scripts they run.

| Mod | What you see | Needs |
|---|---|---|
| `mrs` | Your open GitLab MRs and GitHub PRs, and MRs waiting on your review. The icon is colored by status: red for conflicts or a failed pipeline, yellow while running, green when approved or ready. Click to open. | `glab` and/or `gh`, signed in |
| `usage` | Claude and Codex tabs. Each signed-in account's 5-hour and weekly limits, with a tick showing how far through the window you are (pace) and when it resets. | `bin/claude-usage` on PATH |
| `bus` | An [agent-bus](https://github.com/scottbaggett/agent-bus) view: each area's PM, its seats and the work waiting on you, with Reply and Close. | `agent-bus`, `bin/bus-area` |

## Install

```sh
git clone <this repo> ~/code/herdr-mods
for m in mrs usage bus; do ln -s ~/code/herdr-mods/mods/$m ~/.config/herdr-app/mods/$m; done
ln -s ~/code/herdr-mods/bin/claude-usage ~/code/herdr-mods/bin/bus-area ~/.local/bin/
mkdir -p ~/.config/herdr-mods && cp config.example.json ~/.config/herdr-mods/config.json   # then edit
herdr-app check ~/.config/herdr-app/mods/usage
```

Then place each mod in a layout block, for example `{ "id": "usage", "type": "block", "content": { "mod": "usage" }, "size": { "px": 300 } }`.

## Config

Everything specific to you lives in `~/.config/herdr-mods/config.json` (or `$HERDR_MODS_CONFIG` for the scripts). It is never committed. See `config.example.json`.

- `usage.claude`: one entry per Claude Code account. `config_dir` is the `CLAUDE_CONFIG_DIR` you run that account with; `null` means the default. Without this section, the default sign-in is shown.
- `usage.codex`: one entry per Codex account, by `CODEX_HOME`. Without it, `~/.codex` is shown.
- `areas`: for `bus` and `bus-area`: the repo, its worktree folder, the lead identity replies are sent as, and the areas (slug, name, agent-bus lane).

## How `claude-usage` gets its numbers

It reads each account's sign-in from where the CLI keeps it (the macOS keychain for Claude Code, `<CODEX_HOME>/auth.json` for Codex) and asks the same usage endpoints `/usage` and Codex use. It never refreshes a token, so it can't sign a running session out. An expired sign-in shows as stale until you open a session on that account. Tokens never leave the script. macOS only for Claude accounts.
