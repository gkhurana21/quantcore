// QuantCore data proxy: the entire MVP backend (PRD §11, decision 2).
//
// Serves normalized, cached market data from Alpaca's free Basic plan
// (IEX stock quotes, indicative options feed with Greeks/IV) to the
// static dashboard. Caching keeps us inside the 200 req/min limit;
// the client never sees the API keys.
package main

import (
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"os"
	"regexp"
	"strings"
	"time"
)

const (
	quoteTTL       = 60 * time.Second
	expirationsTTL = 15 * time.Minute
	chainTTL       = 15 * time.Minute
)

var symbolRe = regexp.MustCompile(`^[A-Z][A-Z0-9.\-]{0,9}$`)
var expirationRe = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)

type server struct {
	alpaca  *alpacaClient
	cache   *ttlCache
	origins map[string]bool // empty means allow all (dev)
}

func main() {
	keyID := os.Getenv("ALPACA_API_KEY_ID")
	secret := os.Getenv("ALPACA_API_SECRET_KEY")
	if keyID == "" || secret == "" {
		log.Fatal("ALPACA_API_KEY_ID and ALPACA_API_SECRET_KEY are required (free paper-only account: https://alpaca.markets)")
	}
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}

	s := &server{
		alpaca:  newAlpacaClient(keyID, secret),
		cache:   newTTLCache(),
		origins: parseOrigins(os.Getenv("ALLOWED_ORIGINS")),
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("ok"))
	})
	mux.HandleFunc("GET /v1/quote", s.handleQuote)
	mux.HandleFunc("GET /v1/expirations", s.handleExpirations)
	mux.HandleFunc("GET /v1/chain", s.handleChain)

	log.Printf("quantcore proxy listening on :%s", port)
	log.Fatal(http.ListenAndServe(":"+port, s.cors(mux)))
}

func parseOrigins(env string) map[string]bool {
	origins := make(map[string]bool)
	for _, o := range strings.Split(env, ",") {
		if o = strings.TrimSpace(o); o != "" {
			origins[o] = true
		}
	}
	return origins
}

func (s *server) cors(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if len(s.origins) == 0 {
			w.Header().Set("Access-Control-Allow-Origin", "*")
		} else if s.origins[origin] {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Vary", "Origin")
		}
		w.Header().Set("Access-Control-Allow-Methods", "GET, OPTIONS")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (s *server) handleQuote(w http.ResponseWriter, r *http.Request) {
	symbol, ok := requireSymbol(w, r)
	if !ok {
		return
	}
	s.serveCached(w, "quote:"+symbol, quoteTTL, func() (any, error) {
		return s.alpaca.Quote(symbol)
	})
}

func (s *server) handleExpirations(w http.ResponseWriter, r *http.Request) {
	symbol, ok := requireSymbol(w, r)
	if !ok {
		return
	}
	s.serveCached(w, "exp:"+symbol, expirationsTTL, func() (any, error) {
		return s.alpaca.Expirations(symbol)
	})
}

func (s *server) handleChain(w http.ResponseWriter, r *http.Request) {
	symbol, ok := requireSymbol(w, r)
	if !ok {
		return
	}
	expiration := r.URL.Query().Get("expiration")
	if !expirationRe.MatchString(expiration) {
		writeError(w, http.StatusBadRequest, "expiration must be YYYY-MM-DD")
		return
	}
	s.serveCached(w, "chain:"+symbol+":"+expiration, chainTTL, func() (any, error) {
		return s.alpaca.Chain(symbol, expiration)
	})
}

func requireSymbol(w http.ResponseWriter, r *http.Request) (string, bool) {
	symbol := strings.ToUpper(strings.TrimSpace(r.URL.Query().Get("symbol")))
	if !symbolRe.MatchString(symbol) {
		writeError(w, http.StatusBadRequest, "invalid or missing symbol")
		return "", false
	}
	return symbol, true
}

// serveCached returns the cached body when fresh, otherwise fetches,
// caches, and serves. Cache hits never touch Tradier.
func (s *server) serveCached(w http.ResponseWriter, key string, ttl time.Duration, fetch func() (any, error)) {
	w.Header().Set("Content-Type", "application/json")

	if body, ok := s.cache.get(key); ok {
		w.Header().Set("X-Cache", "HIT")
		w.Write(body)
		return
	}

	data, err := fetch()
	if err != nil {
		var ue *upstreamError
		if errors.As(err, &ue) {
			writeError(w, ue.status, ue.msg)
		} else {
			writeError(w, http.StatusInternalServerError, "internal error")
		}
		log.Printf("fetch %s failed: %v", key, err)
		return
	}

	body, err := json.Marshal(data)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "encode failed")
		return
	}
	s.cache.set(key, body, ttl)
	w.Header().Set("X-Cache", "MISS")
	w.Write(body)
}

func writeError(w http.ResponseWriter, status int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(map[string]string{"error": msg})
}
