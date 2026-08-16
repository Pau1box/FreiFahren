package data

import (
	"sync"
	"time"

	// The zone database is embedded so that a slim container without tzdata does not
	// silently push every network back onto UTC, which is exactly the bug this exists to fix.
	_ "time/tzdata"

	"github.com/FreiFahren/backend/logger"
)

var (
	locationCache     = make(map[string]*time.Location)
	locationCacheLock sync.Mutex
)

// NetworkLocation returns the clock the network's city runs on.
//
// Everything that reads a time of day has to go through it: the threshold curve models a day in
// the city, and the historic data is bucketed by hour and weekday. The process timezone must
// never enter that calculation, which is what network.json's timezone is for. The hono backend
// follows the same rule, see inNetworkTime in
// packages/hono-backend/src/modules/reports/reports-service.ts.
//
// An unknown network or an unusable zone falls back to UTC and is logged once instead of failing
// the request: a curve that is an hour off is a smaller failure than no reports at all.
func NetworkLocation(networkID string) *time.Location {
	locationCacheLock.Lock()
	defer locationCacheLock.Unlock()

	if location, ok := locationCache[networkID]; ok {
		return location
	}

	location := loadNetworkLocation(networkID)
	locationCache[networkID] = location
	return location
}

func loadNetworkLocation(networkID string) *time.Location {
	network, ok := GetNetwork(networkID)
	if !ok || network.Timezone == "" {
		logger.Log.Warn().Str("network", networkID).Msg("Network has no timezone, reading the time of day in UTC")
		return time.UTC
	}

	location, err := time.LoadLocation(network.Timezone)
	if err != nil {
		logger.Log.Warn().Err(err).
			Str("network", networkID).
			Str("timezone", network.Timezone).
			Msg("Unusable timezone, reading the time of day in UTC")
		return time.UTC
	}

	return location
}
