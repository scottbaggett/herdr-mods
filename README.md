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

## Agent facts in each pane header

`mods/pane-account` is the pane header with everything about the agent at a glance: the account it runs on (badge), the model, context used, and the 5-hour and weekly limits as small bars with % and time to reset. Green is on pace, yellow ahead of pace, red at 90%.

The folder in the header is a button: click it for an **Open in** menu (`mods/open-in`) with Finder, whichever of Zed, Cursor, VS Code, Windsurf, Xcode, Sublime Text, Nova, Ghostty, iTerm, Warp, Fork and Tower are installed, the repo's web page (on the pane's branch), and copy path. Add your own with `"open_in": [{"name": "Tower", "cmd": ["gittower", "{dir}"]}]` in the config (`{"name", "app"}` for a macOS app by name).

The facts are labels on the agent's Herdr terminal (`agent.account`, `agent.model`, `agent.ctx`, `agent.5h`, `agent.wk`, …), written by:
- **Claude Code:** `bin/agent-statusline` as its status line (`{"statusLine": {"type": "command", "command": "agent-statusline", "padding": 0}}` in each config dir's `settings.json`). Inside Herdr it prints nothing and feeds the header; outside Herdr it prints the same facts as a line. `AGENT_STATUSLINE_SHOW=1` prints it in Herdr too.
- **Codex:** start it through `bin/agent-run --codex-home <CODEX_HOME> <label> codex …` (for example a `codex-work` shell function). It tags the account and follows that session's log for model, context and limits.

## Switching accounts automatically

With two accounts on a runtime (say Claude Work and Personal), `bin/agent-shift` moves an agent to the other one when its own runs low, keeping the whole chat:

- At the end of each turn, if the account in use is at 90% or more of its 5-hour or weekly limit (or the turn failed on a rate limit), the agent moves to the account on the same runtime with the most headroom.
- Its transcript is copied into that account's folder when the two use different ones, and it restarts in the same terminal with `--resume`. Its tab, bus seat and memory stay; the header badge changes, and a note goes on the bus.
- If every account on that runtime is low, it stays put and asks `@lead` on agent-bus (once an hour). It never moves between Claude and Codex.

Setup:
- Start agents through `bin/agent-run <label> <command…>` (it relaunches the agent after a switch). `bus-area` does this; for your shell, wrap `claude` and `codex` in functions that call it.
- Claude Code: add `agent-shift claude-hook` as a `Stop` and a `StopFailure` hook in each config dir's `settings.json`.
- Codex: nothing more; `agent-meta codex-watch` (started by `agent-run --codex-home`) calls it when a turn ends.
- `agent-shift status` shows each account's use and where a low agent would go. Tune with `"shift": {"threshold": 90, "cooldown_min": 10, "gap_sec": 45, "per_agent": 3, "return": true, "return_below": 50, "enabled": true}` in the config.

What keeps a switch safe:
- **It checks the agent came back.** A helper in a Herdr-owned terminal stops the agent, restarts it, and confirms it is running on the new account. If not, it retries once, then posts a `blocked` packet to `@lead` and a desktop notification with the exact resume command.
- **It never kills running work.** An agent with background shell commands or subagents stays put and is looked at again at its next turn end (a rate-limit failure still moves it).
- **Agents move one at a time.** At most one switch per runtime every `gap_sec` (45s), and each agent moved in the last 5 minutes counts `per_agent` (3%) against its new account, so a crowd doesn't land on one account.
- **It uses fresh numbers.** Usage is re-read for every account right before choosing.
- **It goes back.** Once the account an agent left has reset below `return_below` (50%) and has more room than the one it is on, the agent returns (`"return": false` turns this off).
- **It keeps the launch flags** (model, permission mode, …) and the bus lane, and drops the opening prompt so it isn't sent again.

An agent that wasn't started under `agent-run` moves the same way: its resume command is typed into the shell Herdr leaves in the tab. `agent-shift status` also lists the last moves.

Herdr doesn't hot-reload a mod folder that is a symlink: after editing one, switch layouts and back (`ctrl-shift-l`).

## Config

Everything specific to you lives in `~/.config/herdr-mods/config.json` (or `$HERDR_MODS_CONFIG` for the scripts). It is never committed. See `config.example.json`.

- `usage.claude`: one entry per Claude Code account. `config_dir` is the `CLAUDE_CONFIG_DIR` you run that account with; `null` means the default. Without this section, the default sign-in is shown.
- `usage.codex`: one entry per Codex account, by `CODEX_HOME`. Without it, `~/.codex` is shown.
- `areas`: for `bus` and `bus-area`: the repo, its worktree folder, the lead identity replies are sent as, and the areas (slug, name, agent-bus lane).

## How `claude-usage` gets its numbers

It reads each account's sign-in from where the CLI keeps it (the macOS keychain for Claude Code, `<CODEX_HOME>/auth.json` for Codex) and asks the same usage endpoints `/usage` and Codex use. It never refreshes a token, so it can't sign a running session out. An expired sign-in shows as stale until you open a session on that account. Tokens never leave the script. macOS only for Claude accounts.
