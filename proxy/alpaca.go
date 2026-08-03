package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"
)

const (
	alpacaDataBase    = "https://data.alpaca.markets"
	alpacaTradingBase = "https://paper-api.alpaca.markets"
	maxPages          = 10
)

type alpacaClient struct {
	keyID  string
	secret string
	http   *http.Client
}

func newAlpacaClient(keyID, secret string) *alpacaClient {
	return &alpacaClient{
		keyID:  keyID,
		secret: secret,
		http:   &http.Client{Timeout: 15 * time.Second},
	}
}

// upstreamError distinguishes Alpaca failures (502 to the client, so the
// dashboard falls back to snapshot mode) from bad requests (400/404).
type upstreamError struct {
	status int
	msg    string
}

func (e *upstreamError) Error() string { return e.msg }

func (a *alpacaClient) get(base, path string, params url.Values) ([]byte, error) {
	req, err := http.NewRequest(http.MethodGet, base+path+"?"+params.Encode(), nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("APCA-API-KEY-ID", a.keyID)
	req.Header.Set("APCA-API-SECRET-KEY", a.secret)
	req.Header.Set("Accept", "application/json")

	resp, err := a.http.Do(req)
	if err != nil {
		return nil, &upstreamError{status: http.StatusBadGateway, msg: "alpaca unreachable: " + err.Error()}
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(io.LimitReader(resp.Body, 16<<20))
	if err != nil {
		return nil, &upstreamError{status: http.StatusBadGateway, msg: "alpaca read failed: " + err.Error()}
	}
	if resp.StatusCode == http.StatusNotFound {
		return nil, &upstreamError{status: http.StatusNotFound, msg: "not found upstream"}
	}
	if resp.StatusCode != http.StatusOK {
		return nil, &upstreamError{status: http.StatusBadGateway, msg: fmt.Sprintf("alpaca returned %d", resp.StatusCode)}
	}
	return body, nil
}

// --- Normalized response shapes served to the dashboard ---

type Quote struct {
	Symbol    string  `json:"symbol"`
	Last      float64 `json:"last"`
	Bid       float64 `json:"bid"`
	Ask       float64 `json:"ask"`
	PrevClose float64 `json:"prevClose"`
	Change    float64 `json:"change"`
	Feed      string  `json:"feed"` // "iex" — education/analysis, not execution
	AsOf      string  `json:"asOf"`
}

type Expirations struct {
	Symbol      string   `json:"symbol"`
	Expirations []string `json:"expirations"`
}

type ChainOption struct {
	Symbol       string   `json:"symbol"`
	Type         string   `json:"type"`
	Strike       float64  `json:"strike"`
	Bid          float64  `json:"bid"`
	Ask          float64  `json:"ask"`
	Last         float64  `json:"last"`
	OpenInterest int64    `json:"openInterest"`
	IV           *float64 `json:"iv,omitempty"`
	Delta        *float64 `json:"delta,omitempty"`
	Gamma        *float64 `json:"gamma,omitempty"`
	Theta        *float64 `json:"theta,omitempty"`
	Vega         *float64 `json:"vega,omitempty"`
}

type Chain struct {
	Symbol     string        `json:"symbol"`
	Expiration string        `json:"expiration"`
	Feed       string        `json:"feed"` // "indicative" — approximates OPRA
	Options    []ChainOption `json:"options"`
}

// --- Alpaca wire formats (only the fields we consume) ---

// flexFloat tolerates Alpaca's trading API returning numbers as strings.
type flexFloat float64

func (f *flexFloat) UnmarshalJSON(b []byte) error {
	s := strings.Trim(string(b), `"`)
	if s == "" || s == "null" {
		*f = 0
		return nil
	}
	v, err := strconv.ParseFloat(s, 64)
	if err != nil {
		return err
	}
	*f = flexFloat(v)
	return nil
}

type awStockSnapshot struct {
	LatestTrade struct {
		Price float64 `json:"p"`
	} `json:"latestTrade"`
	LatestQuote struct {
		Ask float64 `json:"ap"`
		Bid float64 `json:"bp"`
	} `json:"latestQuote"`
	PrevDailyBar struct {
		Close float64 `json:"c"`
	} `json:"prevDailyBar"`
}

type awContract struct {
	Symbol         string    `json:"symbol"`
	ExpirationDate string    `json:"expiration_date"`
	StrikePrice    flexFloat `json:"strike_price"`
	Type           string    `json:"type"`
	OpenInterest   flexFloat `json:"open_interest"`
}

type awOptionSnapshot struct {
	LatestQuote struct {
		Ask float64 `json:"ap"`
		Bid float64 `json:"bp"`
	} `json:"latestQuote"`
	LatestTrade struct {
		Price float64 `json:"p"`
	} `json:"latestTrade"`
	ImpliedVolatility *float64 `json:"impliedVolatility"`
	Greeks            *struct {
		Delta *float64 `json:"delta"`
		Gamma *float64 `json:"gamma"`
		Theta *float64 `json:"theta"`
		Vega  *float64 `json:"vega"`
	} `json:"greeks"`
}

func (a *alpacaClient) Quote(symbol string) (*Quote, error) {
	body, err := a.get(alpacaDataBase, "/v2/stocks/"+url.PathEscape(symbol)+"/snapshot", url.Values{})
	if err != nil {
		if ue, ok := err.(*upstreamError); ok && ue.status == http.StatusNotFound {
			return nil, &upstreamError{status: http.StatusNotFound, msg: "symbol not found: " + symbol}
		}
		return nil, err
	}
	var snap awStockSnapshot
	if err := json.Unmarshal(body, &snap); err != nil {
		return nil, &upstreamError{status: http.StatusBadGateway, msg: "unexpected snapshot payload"}
	}
	if snap.LatestTrade.Price == 0 && snap.PrevDailyBar.Close == 0 {
		return nil, &upstreamError{status: http.StatusNotFound, msg: "no data for symbol: " + symbol}
	}
	last := snap.LatestTrade.Price
	if last == 0 {
		last = snap.PrevDailyBar.Close
	}
	return &Quote{
		Symbol:    symbol,
		Last:      last,
		Bid:       snap.LatestQuote.Bid,
		Ask:       snap.LatestQuote.Ask,
		PrevClose: snap.PrevDailyBar.Close,
		Change:    last - snap.PrevDailyBar.Close,
		Feed:      "iex",
		AsOf:      time.Now().UTC().Format(time.RFC3339),
	}, nil
}

// contracts pages through the trading API's option contracts endpoint,
// optionally filtered to one expiration.
func (a *alpacaClient) contracts(symbol, expiration string) ([]awContract, error) {
	var out []awContract
	pageToken := ""
	for page := 0; page < maxPages; page++ {
		params := url.Values{
			"underlying_symbols": {symbol},
			"status":             {"active"},
			"limit":              {"10000"},
		}
		if expiration != "" {
			params.Set("expiration_date", expiration)
		}
		if pageToken != "" {
			params.Set("page_token", pageToken)
		}
		body, err := a.get(alpacaTradingBase, "/v2/options/contracts", params)
		if err != nil {
			return nil, err
		}
		var wire struct {
			OptionContracts []awContract `json:"option_contracts"`
			NextPageToken   *string      `json:"next_page_token"`
		}
		if err := json.Unmarshal(body, &wire); err != nil {
			return nil, &upstreamError{status: http.StatusBadGateway, msg: "unexpected contracts payload"}
		}
		out = append(out, wire.OptionContracts...)
		if wire.NextPageToken == nil || *wire.NextPageToken == "" {
			break
		}
		pageToken = *wire.NextPageToken
	}
	return out, nil
}

func (a *alpacaClient) Expirations(symbol string) (*Expirations, error) {
	contracts, err := a.contracts(symbol, "")
	if err != nil {
		return nil, err
	}
	if len(contracts) == 0 {
		return nil, &upstreamError{status: http.StatusNotFound, msg: "no options for: " + symbol}
	}
	seen := make(map[string]bool)
	var dates []string
	for _, c := range contracts {
		if !seen[c.ExpirationDate] {
			seen[c.ExpirationDate] = true
			dates = append(dates, c.ExpirationDate)
		}
	}
	sort.Strings(dates)
	return &Expirations{Symbol: symbol, Expirations: dates}, nil
}

func (a *alpacaClient) Chain(symbol, expiration string) (*Chain, error) {
	contracts, err := a.contracts(symbol, expiration)
	if err != nil {
		return nil, err
	}
	if len(contracts) == 0 {
		return nil, &upstreamError{status: http.StatusNotFound, msg: "no chain for " + symbol + " " + expiration}
	}

	// Quotes/Greeks come from the market-data snapshots endpoint; contracts
	// provide strike/type/open interest. Join the two on the OCC symbol.
	snaps := make(map[string]awOptionSnapshot)
	pageToken := ""
	for page := 0; page < maxPages; page++ {
		params := url.Values{
			"feed":            {"indicative"},
			"limit":           {"1000"},
			"expiration_date": {expiration},
		}
		if pageToken != "" {
			params.Set("page_token", pageToken)
		}
		body, err := a.get(alpacaDataBase, "/v1beta1/options/snapshots/"+url.PathEscape(symbol), params)
		if err != nil {
			return nil, err
		}
		var wire struct {
			Snapshots     map[string]awOptionSnapshot `json:"snapshots"`
			NextPageToken *string                     `json:"next_page_token"`
		}
		if err := json.Unmarshal(body, &wire); err != nil {
			return nil, &upstreamError{status: http.StatusBadGateway, msg: "unexpected option snapshots payload"}
		}
		for sym, s := range wire.Snapshots {
			snaps[sym] = s
		}
		if wire.NextPageToken == nil || *wire.NextPageToken == "" {
			break
		}
		pageToken = *wire.NextPageToken
	}

	chain := &Chain{Symbol: symbol, Expiration: expiration, Feed: "indicative", Options: make([]ChainOption, 0, len(contracts))}
	for _, c := range contracts {
		co := ChainOption{
			Symbol:       c.Symbol,
			Type:         c.Type,
			Strike:       float64(c.StrikePrice),
			OpenInterest: int64(c.OpenInterest),
		}
		if s, ok := snaps[c.Symbol]; ok {
			co.Bid = s.LatestQuote.Bid
			co.Ask = s.LatestQuote.Ask
			co.Last = s.LatestTrade.Price
			co.IV = s.ImpliedVolatility
			if g := s.Greeks; g != nil {
				co.Delta, co.Gamma, co.Theta, co.Vega = g.Delta, g.Gamma, g.Theta, g.Vega
			}
		}
		chain.Options = append(chain.Options, co)
	}
	sort.Slice(chain.Options, func(i, j int) bool {
		if chain.Options[i].Strike != chain.Options[j].Strike {
			return chain.Options[i].Strike < chain.Options[j].Strike
		}
		return chain.Options[i].Type < chain.Options[j].Type
	})
	return chain, nil
}
