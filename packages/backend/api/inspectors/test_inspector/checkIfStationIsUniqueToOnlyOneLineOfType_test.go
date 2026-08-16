package test_inspectors

import (
	"testing"

	"github.com/FreiFahren/backend/api/inspectors"
	"github.com/FreiFahren/backend/data"
	"github.com/FreiFahren/backend/utils"
	"github.com/stretchr/testify/assert"
)

func TestCheckIfStationIsUniqueToOneLineOfType(t *testing.T) {
	// The real metadata is the point of the test: the mode of a line has to come
	// from the network data, so a mocked table would test nothing.
	data.EmbedJSONFiles()

	cases := []struct {
		name      string
		networkID string
		station   utils.StationListEntry
		line      string
		expected  bool
	}{
		{
			name:      "Station uniquely served by one subway line",
			networkID: "berlin",
			station: utils.StationListEntry{
				Lines: []string{"U3"},
			},
			line:     "U3",
			expected: true,
		},
		{
			name:      "Station served by multiple subway lines",
			networkID: "berlin",
			station: utils.StationListEntry{
				Lines: []string{"U3", "U1"},
			},
			line:     "U3",
			expected: false,
		},
		{
			name:      "Station uniquely served by one light rail line",
			networkID: "berlin",
			station: utils.StationListEntry{
				Lines: []string{"S1"},
			},
			line:     "S1",
			expected: true,
		},
		{
			name:      "Station served by light rail and subway, unique in light rail",
			networkID: "berlin",
			station: utils.StationListEntry{
				Lines: []string{"S1", "U2"},
			},
			line:     "S1",
			expected: true,
		},
		{
			name:      "Station served by light rail and subway, not unique in light rail",
			networkID: "berlin",
			station: utils.StationListEntry{
				Lines: []string{"S1", "S3", "U2"},
			},
			line:     "S1",
			expected: false,
		},
		{
			name:      "Berlin trams share a mode regardless of their names",
			networkID: "berlin",
			station: utils.StationListEntry{
				Lines: []string{"M1", "12"},
			},
			line:     "M1",
			expected: false,
		},
		{
			name:      "Munich trams are numbers and still count as one mode",
			networkID: "munich",
			station: utils.StationListEntry{
				Lines: []string{"12", "27", "U3"},
			},
			line:     "12",
			expected: false,
		},
		{
			name:      "Munich S-Bahn is a train and does not group with the subway",
			networkID: "munich",
			station: utils.StationListEntry{
				Lines: []string{"S1", "U1", "U2"},
			},
			line:     "S1",
			expected: true,
		},
		{
			name:      "A line without a known mode is never unique",
			networkID: "berlin",
			station: utils.StationListEntry{
				Lines: []string{"S45"},
			},
			line:     "S45",
			expected: false,
		},
		{
			name:      "An unknown network yields no mode",
			networkID: "atlantis",
			station: utils.StationListEntry{
				Lines: []string{"U3"},
			},
			line:     "U3",
			expected: false,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			result := inspectors.CheckIfStationIsUniqueToOneLineOfType(tc.networkID, tc.station, tc.line)
			assert.Equal(t, tc.expected, result, "Expected and actual results should match")
		})
	}
}
