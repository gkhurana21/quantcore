#!/usr/bin/env bash
# Alpaca credential diagnostic.
#
# "Keys rejected" can mean four very different things. This isolates which.
# Never prints your secret.
#
#   export ALPACA_API_KEY_ID=PK...
#   export ALPACA_API_SECRET_KEY=...
#   ./diagnose.sh

set -uo pipefail

KEY="${ALPACA_API_KEY_ID:-}"
SEC="${ALPACA_API_SECRET_KEY:-}"

if [[ -z "$KEY" || -z "$SEC" ]]; then
  echo "Set both env vars first:"
  echo "  export ALPACA_API_KEY_ID=PK..."
  echo "  export ALPACA_API_SECRET_KEY=..."
  exit 1
fi

hdr=(-H "APCA-API-KEY-ID: $KEY" -H "APCA-API-SECRET-KEY: $SEC" -H "Accept: application/json")

echo
echo "  ALPACA CREDENTIAL DIAGNOSTIC"
echo "  ────────────────────────────────────────────"

# ---- shape checks (catch the boring failures first) -------------------
klen=${#KEY}; slen=${#SEC}
echo "  key id      ${KEY:0:6}…  (${klen} chars)"
echo "  secret      ****        (${slen} chars)"

if [[ "$KEY" =~ [[:space:]] || "$SEC" =~ [[:space:]] ]]; then
  echo "  !! whitespace/newline inside a credential — re-copy it."
fi
case "$KEY" in
  PK*) echo "  prefix      PK = paper Trading API key  ✓" ;;
  AK*) echo "  prefix      AK = LIVE Trading API key (paper endpoints will reject)" ;;
  CK*) echo "  prefix      CK = Broker API key — WRONG PRODUCT. See note at bottom." ;;
  *)   echo "  prefix      unrecognized ('${KEY:0:2}') — likely not a Trading API key" ;;
esac
echo

probe() { # name, url
  local name="$1" url="$2" out status body
  out=$(curl -s -m 15 -w $'\n%{http_code}' "${hdr[@]}" "$url")
  status=$(tail -n1 <<<"$out")
  body=$(sed '$d' <<<"$out" | tr -d '\n' | cut -c1-160)
  printf "  %-26s %s\n" "$name" "$status"
  case "$status" in
    200) ;;
    401) echo "      → 401 unauthorized: key/secret pair is wrong or revoked." ;;
    403) echo "      → 403 forbidden: credentials are valid but this product/feed isn't entitled." ;;
    404) echo "      → 404: endpoint or symbol path wrong." ;;
    429) echo "      → 429: rate limited (free tier = 200 req/min)." ;;
    000) echo "      → no response: network/DNS/timeout." ;;
    *)   echo "      → unexpected." ;;
  esac
  [[ "$status" != "200" && -n "$body" ]] && echo "      $body"
}

echo "  1. IDENTITY  (does the key pair authenticate at all?)"
probe "paper trading /v2/account" "https://paper-api.alpaca.markets/v2/account"
echo
echo "  2. STOCK DATA  (free Basic = IEX feed)"
probe "latest quote SPY (iex)" "https://data.alpaca.markets/v2/stocks/SPY/quotes/latest?feed=iex"
probe "latest quote SPY (sip)" "https://data.alpaca.markets/v2/stocks/SPY/quotes/latest?feed=sip"
echo
echo "  3. OPTIONS DATA  (what the chain endpoints need)"
probe "options snapshots SPY" "https://data.alpaca.markets/v1beta1/options/snapshots/SPY?limit=1"
probe "options contracts SPY" "https://paper-api.alpaca.markets/v2/options/contracts?underlying_symbols=SPY&limit=1"

cat <<'NOTE'

  ────────────────────────────────────────────
  READING THE RESULT

  #1 fails (401)
      The pair itself is bad. Regenerate at
      app.alpaca.markets → Home → API Keys → Regenerate.
      The secret is shown exactly once — if you only saved the key ID,
      you must regenerate to get a matching pair.

  #1 fails (403) and your key starts with CK
      You created BROKER API credentials, not Trading API.
      They are a different product and use HTTP Basic auth, not these
      headers — they will never work here. Create a plain paper
      trading account at app.alpaca.markets/signup instead.

  #1 passes, #2 iex fails
      Data entitlement issue. Confirm the account is activated.

  #2 iex passes, #2 sip fails (403)
      Expected and fine — SIP is the paid feed. The proxy should use IEX.

  #3 fails but #1/#2 pass
      Options data is not entitled on this account. Stock quotes and
      ticker search still work; chain-driven strikes do not.
      This is the most likely blocker for the expiry/chain work.
NOTE
echo
