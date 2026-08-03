package main

import (
	"sync"
	"time"
)

type cacheEntry struct {
	body      []byte
	expiresAt time.Time
}

// ttlCache is a minimal in-memory cache for serialized JSON responses.
// It exists to keep the proxy inside Tradier's 60 req/min sandbox limit:
// every dashboard visitor hitting SPY resolves to one upstream call per TTL.
type ttlCache struct {
	mu      sync.RWMutex
	entries map[string]cacheEntry
}

func newTTLCache() *ttlCache {
	c := &ttlCache{entries: make(map[string]cacheEntry)}
	go c.evictLoop()
	return c
}

func (c *ttlCache) get(key string) ([]byte, bool) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	e, ok := c.entries[key]
	if !ok || time.Now().After(e.expiresAt) {
		return nil, false
	}
	return e.body, true
}

func (c *ttlCache) set(key string, body []byte, ttl time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.entries[key] = cacheEntry{body: body, expiresAt: time.Now().Add(ttl)}
}

func (c *ttlCache) evictLoop() {
	for range time.Tick(5 * time.Minute) {
		now := time.Now()
		c.mu.Lock()
		for k, e := range c.entries {
			if now.After(e.expiresAt) {
				delete(c.entries, k)
			}
		}
		c.mu.Unlock()
	}
}
