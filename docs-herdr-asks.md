# Herdr Asks

A terminal question inbox for the Herdr CLI, inspired by
[herdr-agent-ask](https://github.com/sachin-philip/herdr-agent-ask).
Python 3.10+ and Herdr 0.9.3; no Python packages required.

Run `herdr-asks` inside a Herdr pane, or press **Ctrl+A, Q** to open the popup.
The popup watches all workspaces in the current server. It does not change
agent state just to read questions.

```sh
herdr-asks                         # all local workspaces
herdr-asks --current               # caller's workspace; a toggles all/current
herdr-asks --workspace w1          # explicit workspace ID
herdr-asks --dialogs-only          # only blocked agents
herdr-asks --json                  # one scan, JSON on stdout
herdr-asks --machine my-server     # saved remote machine, no fallback to Local
herdr-asks --session other         # another named session
herdr-asks --classify haiku        # optional semantic question classification
```

Use **j/k** or arrows to select an agent, **PgUp/PgDn** to read the question,
and **Enter** to draft an answer. Review the draft, then press **y** to send;
any other key cancels. **Esc** cancels text entry, **Ctrl+U** clears a draft.
For a recognized Claude numbered dialog, enter its option number. Only that
number is sent, without an extra Enter that might accidentally answer a
subsequent prompt. Other blocked dialogs are read-only: **o** focuses their
agent terminal and closes the popup so you can answer there.

**d** dismisses a question without answering. **h** shows submitted answers.
**r** refreshes. **q** closes the inbox. Ordinary completed-turn answers are
sent verbatim via `herdr agent prompt`; blocked dialogs use `send-keys`.

## Detection and delivery

Blocked agents always appear. Numbered choices are actionable only for Claude
Code when the snapshot contains a single sequential option set and a selection
cursor. Codex and other
blocked dialogs can be opened in their original terminal.

Completed-turn detection is deliberately local by default: it extracts the
latest recognizable assistant block from terminal output and surfaces question
marks as **possible questions**. It can miss questions or show false positives;
unknown terminal formats are skipped. It does not have transcript-level access
to every agent. `--dialogs-only` disables this heuristic.

With `--classify haiku`, candidate assistant messages are sent to Anthropic using
the installed `claude -p` command and your existing login. This incurs model
usage. The classifier has no tools and only decides whether a question needs
an answer; it does not compose answers or choose options. Without this flag,
the inbox makes no model calls. Multi-part questions can be answered together
in one message; the initial version uses a single-line draft editor.

Before delivery the inbox checks the terminal ID, agent session, completion or
state counter, current lifecycle state, and question text again. A changed or
resumed agent rejects the draft. Checks and sending are separate Herdr RPCs:
there remains a small race because Herdr has no atomic compare-and-send command.
Avoid answering the same agent simultaneously in multiple interfaces.

There are no automatic answers. Successful CLI submission means input was
submitted, not that the agent accepted the answer or finished work. A timeout
is marked uncertain and never retried automatically; inspect that terminal.

## State and installation

State and an append-only `decisions.jsonl` live in
`~/.local/state/herdr-asks/<server-key>/` (or `$XDG_STATE_HOME`). The directory is
private, and files use mode 600. Questions and answers stay outside agents'
repositories. Use `--state-dir` to override the location; keep separate
directories for separate servers. Dismissals and receipts survive restarts.

`bin/.local/bin/herdr-asks` is the complete application. Stow the `bin` package
to install it, or symlink that script into `~/.local/bin`. The popup binding in
`herdr/config.toml` runs it directly and is active after `herdr server reload-config`.

```sh
python3 -m unittest discover -s extras/herdr-asks -v
```

The tests exercise delivery identity, stale dialogs, exact input, duplicate
suppression, uncertain delivery, scoping, caching, and an actual curses process
in a pseudo-terminal with an isolated fake Herdr executable.
