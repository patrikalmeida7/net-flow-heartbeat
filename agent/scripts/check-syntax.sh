#!/usr/bin/env sh
set -eu

SRC_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/../src" && pwd)"
find "$SRC_DIR" -type f -name '*.js' -exec sh -c '
  for file do
    node --check "$file" || exit 1
  done
' sh {} +
echo "Agent JavaScript syntax OK"