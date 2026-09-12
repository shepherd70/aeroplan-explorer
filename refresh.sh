#!/usr/bin/env bash
# Aeroplan Award Explorer — scheduled refresh.
# Runs the ingester quietly from the repo directory and appends its output to ingest.log,
# so a scheduler can call it by path with no quoting:
#   bash /path/to/aeroplan-explorer/refresh.sh            # outbound legs only (~200 API calls)
#   bash /path/to/aeroplan-explorer/refresh.sh --returns  # also return legs, for Round trips (~400)
# Extra arguments go straight to `node ingest.mjs`. See README → "Keeping it fresh".
cd "$(dirname "$0")" || exit 1
# Schedulers start without your profile; pick up an nvm-installed Node when there is one.
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null
exec node ingest.mjs --quiet "$@" >> ingest.log 2>&1
