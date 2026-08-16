package networks

import (
	"fmt"
	"net/http"
	"sort"
	"strings"

	"github.com/FreiFahren/backend/data"
	"github.com/labstack/echo/v4"
)

// HasStation reports whether the network contains the station id.
func HasStation(networkID, stationID string) bool {
	stations, ok := data.GetStationsList(networkID)
	if !ok {
		return false
	}
	_, found := stations[stationID]
	return found
}

// HasLine reports whether the network contains the line id.
func HasLine(networkID, lineID string) bool {
	lines, ok := data.GetLinesList(networkID)
	if !ok {
		return false
	}
	_, found := lines[lineID]
	return found
}

// UnknownReference answers a request that names stations or lines the network does
// not contain.
//
// With more than one network that is no longer a typo but the normal consequence of a
// client having the wrong city selected, so it is a client error. It is answered before
// the request is served, because every handler that skipped this check answered 200 with
// invented data: a report at coordinates 0,0, or a report count of zero that reads like
// a quiet station rather than like the wrong city.
func UnknownReference(networkID string, fields ...string) error {
	return echo.NewHTTPError(http.StatusUnprocessableEntity, map[string]string{
		"message":     fmt.Sprintf("Unknown %s for network '%s'", strings.Join(fields, ", "), networkID),
		"description": "Every station, direction and line has to belong to the requested network. Check the 'network' query parameter against GET /v0/networks.",
	})
}

// UnknownStations names the given station ids that the network does not contain, keyed
// by the parameter the caller passed them in as. An empty id is not a reference and is
// therefore never unknown.
func UnknownStations(networkID string, stationsByParam map[string]string) []string {
	unknown := make([]string, 0, len(stationsByParam))
	for param, stationID := range stationsByParam {
		if stationID != "" && !HasStation(networkID, stationID) {
			unknown = append(unknown, param)
		}
	}

	// Sorted, because iterating the map would otherwise name the same two parameters
	// in a different order on every request.
	sort.Strings(unknown)
	return unknown
}
