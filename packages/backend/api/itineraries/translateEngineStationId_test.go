package itineraries

import (
	"testing"

	"github.com/FreiFahren/backend/data"
)

// Munich has six engine ids that two of our stations share, which the validator warns about. This
// is one of them: the engine knows one stop where we keep a tram stop and an S-Bahn station apart.
const (
	ambiguousNetwork  = "munich"
	ambiguousEngineId = "de-DELFI_de:09162:1"
)

func ambiguousCandidates(t *testing.T) []string {
	t.Helper()

	stationsMap, _ := data.GetStationsMap(ambiguousNetwork)
	if len(stationsMap) == 0 {
		t.Skipf("network %q has no station map in this checkout", ambiguousNetwork)
	}

	var candidates []string
	for freifahrenId, engineId := range stationsMap {
		if engineId == ambiguousEngineId {
			candidates = append(candidates, freifahrenId)
		}
	}
	if len(candidates) < 2 {
		t.Skipf("%q is no longer ambiguous in this checkout", ambiguousEngineId)
	}
	return candidates
}

// Without a position there is nothing to choose by, but the answer still has to be the same one
// every time. It used to come from Go's map iteration, so the same route could name a different
// station on every request.
func TestTranslateEngineStationIdIsStableWithoutAPosition(t *testing.T) {
	ambiguousCandidates(t)

	first := translateEngineStationId(ambiguousNetwork, ambiguousEngineId, 0, 0)
	for attempt := 0; attempt < 20; attempt++ {
		if again := translateEngineStationId(ambiguousNetwork, ambiguousEngineId, 0, 0); again != first {
			t.Fatalf("the same lookup answered %q and then %q", first, again)
		}
	}
}

// With a position, the station nearest to it wins. Asking from each candidate's own coordinates has
// to return that candidate, whichever one it is.
func TestTranslateEngineStationIdPrefersTheNearestCandidate(t *testing.T) {
	candidates := ambiguousCandidates(t)
	stationsList, _ := data.GetStationsList(ambiguousNetwork)

	for _, candidate := range candidates {
		station, exists := stationsList[candidate]
		if !exists {
			t.Fatalf("%q is mapped but not in the station list", candidate)
		}
		resolved := translateEngineStationId(
			ambiguousNetwork, ambiguousEngineId, station.Coordinates.Latitude, station.Coordinates.Longitude,
		)
		if resolved != candidate {
			t.Errorf("asking from %q resolved to %q", candidate, resolved)
		}
	}
}
