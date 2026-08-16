package test_distance

import (
	"fmt"
	"os"
	"reflect"
	"testing"

	"github.com/FreiFahren/backend/api/distance"
	"github.com/FreiFahren/backend/data"
)

func TestFindShortestDistance(t *testing.T) {
	os.Chdir("..")
	tests := []struct {
		name           string
		startStation   string
		userStation    string
		expectedLength int
	}{
		{"Station path should be 8 from Ernst Reuter Platz to Platz der Luftbrücke", "U-n29123764", "U-n1312931277", 8},
		// Was 23 until the line order stopped skipping stations on a branching line. The old order
		// made Ahrenshooper Straße a neighbour of Hackescher Markt, 8.2 km apart, and the search
		// crossed the city in one step through a pair of stations that no train runs between. The
		// 27 step route is four steps longer and 1.1 km shorter on the ground.
		{"S7 Ahrensfelde to Potsdam Hauptbahnof", "S-n1117011810", "S-BPDH", 27},
	}
	data.EmbedJSONFiles()

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			distances := distance.FindShortestDistance("berlin", tt.startStation, tt.userStation)
			fmt.Printf("Distances: %v\n", distances)
			if !reflect.DeepEqual(distances, tt.expectedLength) {
				t.Errorf("FindShortestPath(%s, %s) = %v; expected %v", tt.startStation, tt.userStation, distances, tt.expectedLength)
			}
		})
	}
}
