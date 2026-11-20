#!/usr/bin/env bash
# Chatcap native host installer for macOS / Linux (Chrome + Edge).
# Usage: bash native-host/install.sh <32-letter-extension-id> [python-executable]
set -euo pipefail

if [ "$#" -lt 1 ]; then
  echo "Usage: $0 <extension-id> [python-executable]" >&2
  exit 2
fi

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PYTHON="${2:-python3}"

"$PYTHON" "$HERE/install_host.py" "$1"
