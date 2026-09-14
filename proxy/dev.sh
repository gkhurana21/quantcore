#!/usr/bin/env bash
# Start the proxy locally without re-pasting credentials every time.
#
# One-time setup:
#   cp .env.local.example .env.local     # then paste your keys into it
#
# Every time after:
#   ./dev.sh
#
# .env.local is gitignored and never committed.

set -euo pipefail
cd "$(dirname "$0")"

if [[ -f .env.local ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env.local
  set +a
fi

if [[ -z "${ALPACA_API_KEY_ID:-}" || -z "${ALPACA_API_SECRET_KEY:-}" ]]; then
  cat <<'MSG'
Missing Alpaca credentials.

  1. cp .env.local.example .env.local
  2. open .env.local and paste your paper keys
  3. ./dev.sh

(Get them at app.alpaca.markets -> switch to Paper Trading -> Home -> API Keys)
MSG
  exit 1
fi

echo "starting proxy on :${PORT:-8080} (credentials loaded from .env.local)"
exec go run .
