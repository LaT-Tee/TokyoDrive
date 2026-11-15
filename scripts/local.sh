#!/bin/zsh
# The project lives on a slow SMB share where Vite/Vitest hang. This script
# mirrors the sources to a local build directory (which holds node_modules)
# and runs a command there, e.g.:
#   scripts/local.sh npm run dev
#   scripts/local.sh npm test
# Data (self-hosted tiles) is NOT mirrored: TOKYODRIVE_DATA_DIR points the dev
# server's /data mount at the project's data/ directory on the share.
set -e
SRC="${0:A:h:h}"
DST="${TOKYODRIVE_LOCAL:-$HOME/.tokyodrive-deps}"
mkdir -p "$DST"
rsync -a --delete --exclude node_modules --exclude data --exclude .git --exclude dist --exclude '._*' --exclude .DS_Store --exclude screenshots "$SRC/" "$DST/"
export TOKYODRIVE_DATA_DIR="${TOKYODRIVE_DATA_DIR:-$SRC/data}"
export TOKYODRIVE_SRC="$SRC"
cd "$DST"
[ -d node_modules ] || npm ci
exec "$@"
