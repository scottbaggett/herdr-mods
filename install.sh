#!/bin/sh
# Link these mods, scripts and the layout into Herdr. Safe to re-run; never overwrites your files.
set -e
R=$(cd "$(dirname "$0")" && pwd)
H=${HERDR_APP_HOME:-$HOME/.config/herdr-app}
BIN=$HOME/.local/bin
CFG=$HOME/.config/herdr-mods/config.json

link() { # link <source> <target>: skip if something else already lives there
  if [ -L "$2" ] || [ ! -e "$2" ]; then ln -sfn "$1" "$2"; echo "linked  $2"; else echo "kept    $2 (yours; move it aside to use this repo's)"; fi
}

command -v herdr-app >/dev/null || { echo "Herdr desktop isn't installed (no herdr-app on PATH)."; exit 1; }
mkdir -p "$H/mods" "$H/layouts" "$BIN" "$(dirname "$CFG")"
for m in "$R"/mods/*/; do m=$(basename "$m"); link "$R/mods/$m" "$H/mods/$m"; done
for b in "$R"/bin/*; do link "$b" "$BIN/$(basename "$b")"; done
link "$R/layouts/asks.json" "$H/layouts/asks.json"
[ -e "$CFG" ] || { cp "$R/config.example.json" "$CFG"; echo "created $CFG  <- edit this: your accounts and areas"; }

echo; for t in glab gh agent-bus claude codex; do command -v $t >/dev/null && echo "ok      $t" || echo "missing $t (some panels stay empty without it)"; done
case ":$PATH:" in *":$BIN:"*) ;; *) echo "add $BIN to your PATH";; esac

echo; for m in "$R"/mods/*/; do herdr-app check "$m" >/dev/null && echo "check   $(basename "$m") ok" || herdr-app check "$m"; done
herdr-app do layout.switch --name asks >/dev/null 2>&1 && echo "switched to the asks layout (ctrl-shift-l cycles back)" || echo "open Herdr, then: herdr-app do layout.switch --name asks"
