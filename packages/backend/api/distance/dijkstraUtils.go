package distance

import (
	"fmt"
)

func getIndexOfStationId(stationId string, linesOfStation []string) (int, error) {

	for i, station := range linesOfStation {
		if station == stationId {
			return i, nil
		}
	}

	return -1, fmt.Errorf("station not found with the given Id: %v", stationId) // Return -1 if the stationId is not found in the array
}

func removeDuplicateAdjacentStations(elements []string) []string {

	visited := make(map[string]bool)
	uniqueElements := make([]string, 0)
	for _, element := range elements {
		if visited[element] {
			continue
		}
		visited[element] = true
		uniqueElements = append(uniqueElements, element)
	}
	return uniqueElements
}
