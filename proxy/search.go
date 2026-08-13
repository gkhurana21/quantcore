package main

import (
	"encoding/json"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"sync"
	"time"
)

// Symbol search. The tradable universe changes daily at most, so it is pulled
// once and held in memory — a search-as-you-type box must not put an upstream
// call behind every keystroke.

const (
	universeTTL = 12 * time.Hour
	searchTTL   = 5 * time.Minute
)

type SearchHit struct {
	Symbol   string `json:"symbol"`
	Name     string `json:"name"`
	Kind     string `json:"kind"` // crypto | etf | stock
	Exchange string `json:"exchange,omitempty"`
}

type universe struct {
	mu      sync.RWMutex
	hits    []SearchHit
	fetched time.Time
}

var uni universe

// Alpaca's asset rows carry no ETF flag, so classification leans on the name.
// Imperfect at the margin, but right for everything a person is likely to type.
var etfHints = []string{" etf", "etf ", " fund", " trust", "index shares",
	"ishares", "spdr", "vanguard", "invesco", "proshares", "wisdomtree",
	"direxion", "select sector"}

func looksLikeETF(name string) bool {
	n := strings.ToLower(name)
	for _, h := range etfHints {
		if strings.Contains(n, h) {
			return true
		}
	}
	return false
}

func (a *alpacaClient) fetchUniverse() ([]SearchHit, error) {
	out := make([]SearchHit, 0, 12000)

	// US equities and ETFs
	body, err := a.get(alpacaTradingBase, "/v2/assets", url.Values{
		"status":      {"active"},
		"asset_class": {"us_equity"},
	})
	if err == nil {
		var rows []struct {
			Symbol   string `json:"symbol"`
			Name     string `json:"name"`
			Exchange string `json:"exchange"`
			Tradable bool   `json:"tradable"`
		}
		if json.Unmarshal(body, &rows) == nil {
			for _, r := range rows {
				if !r.Tradable || r.Symbol == "" {
					continue
				}
				kind := "stock"
				if looksLikeETF(r.Name) {
					kind = "etf"
				}
				out = append(out, SearchHit{r.Symbol, r.Name, kind, r.Exchange})
			}
		}
	}

	// Crypto, straight from Coinbase's public product list (no key required).
	if resp, cerr := a.http.Get("https://api.exchange.coinbase.com/products"); cerr == nil {
		defer resp.Body.Close()
		var prods []struct {
			ID              string `json:"id"`
			BaseCurrency    string `json:"base_currency"`
			QuoteCurrency   string `json:"quote_currency"`
			DisplayName     string `json:"display_name"`
			TradingDisabled bool   `json:"trading_disabled"`
		}
		if json.NewDecoder(resp.Body).Decode(&prods) == nil {
			seen := map[string]bool{}
			for _, p := range prods {
				if p.QuoteCurrency != "USD" || p.TradingDisabled || seen[p.BaseCurrency] {
					continue
				}
				seen[p.BaseCurrency] = true
				out = append(out, SearchHit{p.BaseCurrency, p.DisplayName, "crypto", "Coinbase"})
			}
		}
	}

	if len(out) == 0 {
		return nil, &upstreamError{status: http.StatusBadGateway, msg: "could not load symbol universe"}
	}
	return out, nil
}

func (s *server) getUniverse() ([]SearchHit, error) {
	uni.mu.RLock()
	if time.Since(uni.fetched) < universeTTL && len(uni.hits) > 0 {
		defer uni.mu.RUnlock()
		return uni.hits, nil
	}
	uni.mu.RUnlock()

	uni.mu.Lock()
	defer uni.mu.Unlock()
	if time.Since(uni.fetched) < universeTTL && len(uni.hits) > 0 {
		return uni.hits, nil // another goroutine won the race
	}
	hits, err := s.alpaca.fetchUniverse()
	if err != nil {
		return nil, err
	}
	uni.hits, uni.fetched = hits, time.Now()
	return hits, nil
}

// Alpaca's asset list carries no volume or market-cap signal, so an exact
// match on "BTC" ranks a thinly-traded trust the same as Bitcoin itself. This
// is the small set of things people actually search for, nudged to the top.
// Keyed "SYMBOL|kind" because the same ticker exists across asset classes.
var majors = map[string]int{
	"BTC|crypto": 500, "ETH|crypto": 500, "SOL|crypto": 400, "XRP|crypto": 400,
	"DOGE|crypto": 350, "ADA|crypto": 300, "AVAX|crypto": 300, "LINK|crypto": 300,
	"MATIC|crypto": 250, "DOT|crypto": 250, "LTC|crypto": 250, "BCH|crypto": 250,
	"AAPL|stock": 500, "MSFT|stock": 500, "NVDA|stock": 500, "TSLA|stock": 500,
	"AMZN|stock": 480, "GOOGL|stock": 480, "META|stock": 480, "NFLX|stock": 420,
	"AMD|stock": 420, "INTC|stock": 380, "SHOP|stock": 380, "COIN|stock": 380,
	"JPM|stock": 360, "V|stock": 340, "DIS|stock": 340, "UBER|stock": 340,
	"SPY|etf": 500, "QQQ|etf": 500, "VOO|etf": 460, "VTI|etf": 440,
	"IWM|etf": 400, "DIA|etf": 400, "ARKK|etf": 340, "VXUS|etf": 300,
	"GLD|etf": 460, "SLV|etf": 400, "USO|etf": 380, "UNG|etf": 320,
	"DBC|etf": 300, "DBA|etf": 280, "PDBC|etf": 280, "IAU|etf": 300,
	"TLT|etf": 340, "HYG|etf": 300, "VIXY|etf": 280,
}

// Words people type when they mean a specific instrument but not its ticker.
var aliases = map[string]string{
	"bitcoin": "BTC", "ether": "ETH", "ethereum": "ETH", "solana": "SOL",
	"dogecoin": "DOGE", "ripple": "XRP", "cardano": "ADA",
	"gold": "GLD", "silver": "SLV", "oil": "USO", "crude": "USO",
	"natural gas": "UNG", "commodities": "DBC", "wheat": "DBA",
	"apple": "AAPL", "tesla": "TSLA", "nvidia": "NVDA", "microsoft": "MSFT",
	"amazon": "AMZN", "google": "GOOGL", "alphabet": "GOOGL", "meta": "META",
	"facebook": "META", "netflix": "NFLX", "shopify": "SHOP",
	"s&p": "SPY", "sp500": "SPY", "s&p 500": "SPY", "nasdaq": "QQQ",
	"dow": "DIA", "russell": "IWM", "bonds": "TLT", "treasuries": "TLT",
	"vix": "VIXY", "volatility": "VIXY",
}

// score ranks a match: exact symbol beats symbol prefix beats name match.
// Shorter symbols win ties so AAPL outranks AAPLW for "aapl".
func score(h SearchHit, q string) int {
	sym, name := strings.ToLower(h.Symbol), strings.ToLower(h.Name)
	boost := majors[h.Symbol+"|"+h.Kind]
	// an alias ("gold", "bitcoin") is treated as if the ticker itself were typed
	if want, ok := aliases[q]; ok && h.Symbol == want {
		return 1200 + boost
	}
	switch {
	case sym == q:
		return 1000 + boost
	case strings.HasPrefix(sym, q):
		return 700 + boost - len(sym)
	case strings.HasPrefix(name, q):
		return 400 + boost - len(sym)
	case strings.Contains(name, q):
		return 200 + boost - len(sym)
	case strings.Contains(sym, q):
		return 100 + boost - len(sym)
	}
	return -1
}

func (s *server) handleSearch(w http.ResponseWriter, r *http.Request) {
	q := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("q")))
	if len(q) < 1 || len(q) > 24 {
		writeError(w, http.StatusBadRequest, "q must be 1-24 characters")
		return
	}
	kind := r.URL.Query().Get("kind") // crypto | etf | stock, empty = all

	s.serveCached(w, "search:"+kind+":"+q, searchTTL, func() (any, error) {
		all, err := s.getUniverse()
		if err != nil {
			return nil, err
		}
		type scored struct {
			h SearchHit
			s int
		}
		found := make([]scored, 0, 64)
		for _, h := range all {
			if kind != "" && h.Kind != kind {
				continue
			}
			if sc := score(h, q); sc > 0 {
				found = append(found, scored{h, sc})
			}
		}
		sort.SliceStable(found, func(i, j int) bool { return found[i].s > found[j].s })

		limit := 6
		if len(found) < limit {
			limit = len(found)
		}
		hits := make([]SearchHit, 0, limit)
		for _, f := range found[:limit] {
			hits = append(hits, f.h)
		}
		return map[string]any{"query": q, "kind": kind, "results": hits}, nil
	})
}
