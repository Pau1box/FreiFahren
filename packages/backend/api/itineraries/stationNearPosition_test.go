package itineraries

import (
	"os"
	"testing"

	"github.com/FreiFahren/backend/data"
	"github.com/FreiFahren/backend/logger"
)

// The network data is embedded but not parsed until the server asks for it, so the tests do here
// what the server does at startup.
func TestMain(m *testing.M) {
	logger.Init()
	data.EmbedJSONFiles()
	os.Exit(m.Run())
}

// The fallback runs against the embedded network data, so these use a real network. Braunschweig is
// the reason the fallback exists: its feed hands back opaque ids whose platform digits sit inside
// the number, so the id path cannot match them.
const fallbackTestNetwork = "braunschweig"

func TestStationIdNearPositionFindsTheStationItself(t *testing.T) {
	stationsList, _ := data.GetStationsList(fallbackTestNetwork)
	if len(stationsList) == 0 {
		t.Skipf("network %q is not built in this checkout", fallbackTestNetwork)
	}

	for stationId, station := range stationsList {
		found, ok := stationIdNearPosition(fallbackTestNetwork, station.Coordinates.Latitude, station.Coordinates.Longitude)
		if !ok {
			// Two stations closer together than the radius are ambiguous by design, which the
			// function reports rather than resolves. That is a correct answer, not a failure.
			continue
		}
		if found != stationId {
			t.Errorf("the coordinates of %q resolved to %q", stationId, found)
		}
	}
}

func TestStationIdNearPositionRejectsAPointOutsideTheNetwork(t *testing.T) {
	stationsList, _ := data.GetStationsList(fallbackTestNetwork)
	if len(stationsList) == 0 {
		t.Skipf("network %q is not built in this checkout", fallbackTestNetwork)
	}

	// Berlin Hauptbahnhof, some 200 km away from any station of this network.
	if found, ok := stationIdNearPosition(fallbackTestNetwork, 52.5251, 13.3694); ok {
		t.Errorf("a point outside the network resolved to %q", found)
	}
}

func TestStationIdNearPositionRejectsAMissingPosition(t *testing.T) {
	// The engine leaves lat and lon at zero when it has no position for a stop. Null island is not
	// in any network, but the check is explicit so the answer does not depend on the data.
	if found, ok := stationIdNearPosition(fallbackTestNetwork, 0, 0); ok {
		t.Errorf("a missing position resolved to %q", found)
	}
}
