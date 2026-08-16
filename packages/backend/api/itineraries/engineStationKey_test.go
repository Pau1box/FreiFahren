package itineraries

import "testing"

// The engine and our stored map name the same station differently, and how they differ depends on
// the feed the region arrives through. These are real ids: a Berlin station as we store it and as
// the engine returns it, a Munich one, and a Braunschweig one from a feed that does not use DHIDs.
func TestEngineStationKey(t *testing.T) {
	cases := []struct {
		name     string
		engineId string
		expected string
	}{
		{"stored DHID", "de-DELFI_de:11000:900003103", "de:11000:900003103"},
		{"engine DHID with platform", "de-VBB_de:11000:900003103::4", "de:11000:900003103"},
		{"engine DHID with area", "de-DELFI_de:09162:6:1", "de:09162:6"},
		{"opaque id of a feed without DHIDs", "de-VBN_000120545001", "000120545001"},
		{"no feed prefix", "de:11000:900003103", "de:11000:900003103"},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			if actual := engineStationKey(testCase.engineId); actual != testCase.expected {
				t.Errorf("engineStationKey(%q) = %q, want %q", testCase.engineId, actual, testCase.expected)
			}
		})
	}
}

// The point of the key: the same station survives a different feed and a platform suffix, and a
// different station does not collide with it.
func TestEngineStationKeyMatchesAcrossFeeds(t *testing.T) {
	stored := engineStationKey("de-DELFI_de:11000:900003103")
	fromEngine := engineStationKey("de-VBB_de:11000:900003103::4")
	if stored != fromEngine {
		t.Errorf("the same station did not match across feeds: %q vs %q", stored, fromEngine)
	}

	other := engineStationKey("de-VBB_de:11000:900110521::4")
	if stored == other {
		t.Errorf("two different stations produced the same key %q", stored)
	}
}
