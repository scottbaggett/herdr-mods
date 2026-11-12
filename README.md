# herdr-mods

Panels for the [Herdr](https://herdr.dev) desktop app, the small scripts they run, and the `asks` layout that puts them together: spaces and agents on the left with Claude/Codex usage under them, and Asks, MRs, Files, Changes and Bus as tabs on the right.

| Mod | What you see | Needs |
|---|---|---|
| `mrs` | Your open GitLab MRs and GitHub PRs, and MRs waiting on your review. The icon is colored by status: red for conflicts or a failed pipeline, yellow while running, green when approved or ready. Click to open. | `glab` and/or `gh`, signed in |
| `usage` | Claude and Codex tabs. Each signed-in account's 5-hour and weekly limits, with a tick showing how far through the window you are (pace) and when it resets. | `bin/claude-usage` on PATH |
| `asks`, `tabs-asks`, `spaces-asks` | An inbox of questions your agents are stuck on, across every space, with a badge on the tab bar. Answer from the panel. `tabs-asks` is the tab bar (with the Asks/MRs/Files/Changes buttons), `spaces-asks` the spaces sidebar with each space's pending asks. | `claude` (optional, for classifying questions) |
| `bus` | An [agent-bus](https://github.com/scottbaggett/agent-bus) view: each area's PM, its seats and the work waiting on you, with Reply and Close. | `agent-bus`, `bin/bus-area` |

## Install

```sh
git clone https://github.com/scottbaggett/herdr-mods ~/code/herdr-mods
~/code/herdr-mods/install.sh
```

`install.sh` links every mod, the scripts (into `~/.local/bin`) and the `asks` layout into Herdr, creates `~/.config/herdr-mods/config.json` from the example if you don't have one, says which tools are missing, checks each mod and switches to the layout. It never overwrites a file of yours. `git pull` updates everything in place; Herdr reloads on save.

Useful keys (add to `~/.config/herdr-app/keys.json` under `"layout:asks"`): `"cmd-shift-a": "tabs-asks.toggle"` opens Asks, and `{"command": "layout.select", "args": {"stack": "panel-body", "child": "bus"}}` opens Bus.

`bin/herdr-asks` is the same inbox as a terminal app; see `docs-herdr-asks.md`. Tests: `python3 -m unittest discover -s tests`.

## Status line under each agent

`bin/agent-statusline` puts one line under every Claude Code chat: the account it runs on, its email, the model, context used, and the 5-hour and weekly limits. Each figure is green on pace, yellow ahead of pace, red at 90%. Turn it on in each Claude config dir's `settings.json`:

```json
{ "statusLine": { "type": "command", "command": "agent-statusline", "padding": 0 } }
```

Codex has its own; add to `[tui]` in `config.toml`: `status_line = ["model-with-reasoning", "context-remaining", "five-hour-limit", "weekly-limit", "git-branch"]`.

## Config

Everything specific to you lives in `~/.config/herdr-mods/config.json` (or `$HERDR_MODS_CONFIG` for the scripts). It is never committed. See `config.example.json`.

- `usage.claude`: one entry per Claude Code account. `config_dir` is the `CLAUDE_CONFIG_DIR` you run that account with; `null` means the default. Without this section, the default sign-in is shown.
- `usage.codex`: one entry per Codex account, by `CODEX_HOME`. Without it, `~/.codex` is shown.
- `areas`: for `bus` and `bus-area`: the repo, its worktree folder, the lead identity replies are sent as, and the areas (slug, name, agent-bus lane).

## How `claude-usage` gets its numbers

It reads each account's sign-in from where the CLI keeps it (the macOS keychain for Claude Code, `<CODEX_HOME>/auth.json` for Codex) and asks the same usage endpoints `/usage` and Codex use. It never refreshes a token, so it can't sign a running session out. An expired sign-in shows as stale until you open a session on that account. Tokens never leave the script. macOS only for Claude accounts.
