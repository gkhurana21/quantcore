# QuantCore data proxy

The entire MVP backend ([PRD](../PRD.md) §11, decision 2): a small Go service that serves normalized, cached market data from [Alpaca's free Basic plan](https://alpaca.markets) to the static dashboard. The API keys never reach the browser; in-memory caching keeps the proxy well inside Alpaca's 200 req/min free limit.

Alpaca was chosen because a **paper-only account is a global email signup** — it works from Canada with no brokerage application (see PRD §11, decision 1). The free tier provides IEX stock quotes and the options *indicative* feed with Greeks/IV. Indicative data approximates real OPRA quotes — right for education and analysis, never for execution — and every response is labeled with its `feed`.

## Endpoints

| Endpoint | Cache TTL | Example |
|---|---|---|
| `GET /v1/quote?symbol=SPY` | 60 s | IEX stock quote (last, bid/ask, prev close) |
| `GET /v1/expirations?symbol=SPY` | 15 min | option expiration dates |
| `GET /v1/chain?symbol=SPY&expiration=2026-08-21` | 15 min | full chain with Greeks/IV and open interest |
| `GET /healthz` | — | liveness |

## Run locally

```bash
export ALPACA_API_KEY_ID=...      # free paper-only account: app.alpaca.markets/signup
export ALPACA_API_SECRET_KEY=...
go run .                          # listens on :8080
curl 'localhost:8080/v1/quote?symbol=SPY'
```

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `ALPACA_API_KEY_ID` | (required) | Alpaca paper account API key ID |
| `ALPACA_API_SECRET_KEY` | (required) | Alpaca paper account API secret |
| `PORT` | `8080` | listen port |
| `ALLOWED_ORIGINS` | allow all | comma-separated CORS allowlist for production, e.g. `https://quantcore.app` |

## Deploy (Fly.io)

```bash
fly launch --no-deploy         # generates fly.toml, pick a region
fly secrets set ALPACA_API_KEY_ID=... ALPACA_API_SECRET_KEY=...
fly deploy
```

The Dockerfile builds a static binary on distroless; Cloud Run works with the same image.
