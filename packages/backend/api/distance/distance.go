package distance

import (
	"container/list"
	"fmt"
	"math"
	"net/http"
	"sort"
	"sync"

	"github.com/FreiFahren/backend/api/networks"
	"github.com/FreiFahren/backend/data"
	_ "github.com/FreiFahren/backend/docs"
	"github.com/FreiFahren/backend/logger"
	utils "github.com/FreiFahren/backend/utils"
	"github.com/labstack/echo/v4"
)

type StationNode struct {
	id       string
	distance int
	line     string
}

// networkGraph is the station and line graph of one network, in the shape the
// shortest path search needs it.
//
// It is passed through the search rather than held in package level variables.
// With more than one network those variables were not just untidy: two requests
// for different cities would overwrite each other's graph mid search.
type networkGraph struct {
	stations   map[string]utils.StationListEntry
	stationIds []string
	lines      map[string][]string
}

type DistanceCache struct {
	cache map[string]int
	order []string
	mutex sync.RWMutex
}

var distanceCache = &DistanceCache{
	cache: make(map[string]int),
	order: make([]string, 0, 5000), // length of 5000 is enough as this will cover the most common cases of the 5800+ station combinations
}

func getCacheKey(networkID, stationId1, stationId2 string) string {
	// compare the lexigraphically smaller string first to avoid duplicate entries in the cache
	if stationId1 < stationId2 {
		return networkID + "/" + stationId1 + ":" + stationId2
	}
	return networkID + "/" + stationId2 + ":" + stationId1
}

func (distanceCache *DistanceCache) getDistanceFromCache(networkID, inspectorStationId, userStationId string) (int, bool) {
	distanceCache.mutex.RLock()
	defer distanceCache.mutex.RUnlock()
	distance, ok := distanceCache.cache[getCacheKey(networkID, inspectorStationId, userStationId)]
	return distance, ok
}

func (distanceCache *DistanceCache) setDistanceInCache(networkID, inspectorStationId, userStationId string, distance int) {
	logger.Log.Debug().Msg("Setting distance in cache")
	distanceCache.mutex.Lock()
	defer distanceCache.mutex.Unlock()

	key := getCacheKey(networkID, inspectorStationId, userStationId)

	if _, exists := distanceCache.cache[key]; !exists {
		if len(distanceCache.order) == 250 {
			delete(distanceCache.cache, distanceCache.order[0])
			distanceCache.order = distanceCache.order[1:] // remove the first element from the order slice
		}
		distanceCache.order = append(distanceCache.order, key)
	}

	distanceCache.cache[key] = distance
}

// @Summary Calculate shortest distance to a station
//
// @Description Returns the shortest number of stations between an inspector's station and a given user's latitude and longitude coordinates.
// @Description The distance calculation employs Dijkstra's algorithm to determine the minimal stops required to reach the nearest station from the given coordinates.
//
// @Tags transit
//
// @Accept  json
// @Produce  text/plain
//
// @Param   inspectorStationId   query   string  true   "The station Id of the inspector's current location."
// @Param   userStationId   query   string  true   "The station Id of the user's current location."
// @Param   network   query   string  false   "ID of the network (defaults to berlin)"
//
// @Success 200 {int} int "The shortest distance in terms of the number of station stops between the inspector's station and the user's location."
// @Failure 400 {object} map[string]string "Bad Request: One of the station id parameters is missing."
// @Failure 404 {object} map[string]string "Not Found: The specified network does not exist."
// @Failure 422 {object} map[string]string "Unprocessable Entity: One of the stations does not belong to the network."
// @Failure 500 "An error occurred in processing the request."
//
// @Router /transit/distance [get]
func GetStationDistance(c echo.Context) error {
	logger.Log.Info().Msg("GET '/transit/distance' UserAgent: " + c.Request().UserAgent())

	networkID, err := networks.Resolve(c)
	if err != nil {
		return err
	}

	inspectorStationId := c.QueryParam("inspectorStationId")
	userStationId := c.QueryParam("userStationId")

	if inspectorStationId == "" || userStationId == "" {
		return c.JSON(http.StatusBadRequest, map[string]string{
			"error": "Missing inspectorStationId or userStationId query parameter",
		})
	}

	// Both stations are checked before the shortcuts below, because two ids of another
	// network are equal to each other just as readily and would be answered with a
	// distance of 0 instead of with the mismatch that caused them.
	if unknown := networks.UnknownStations(networkID, map[string]string{
		"inspectorStationId": inspectorStationId,
		"userStationId":      userStationId,
	}); len(unknown) > 0 {
		return networks.UnknownReference(networkID, unknown...)
	}

	if userStationId == inspectorStationId {
		return c.String(http.StatusOK, "0")
	}

	// Check cache first
	if cachedDistance, found := distanceCache.getDistanceFromCache(networkID, inspectorStationId, userStationId); found {
		logger.Log.Info().Msg("Cache hit for distance calculation")
		return c.String(http.StatusOK, fmt.Sprintf("%d", cachedDistance))
	}

	graph, ok := loadNetworkGraph(networkID)
	if !ok {
		logger.Log.Error().Str("network", networkID).Msg("No transit data for network")
		return c.String(http.StatusInternalServerError, "No transit data for this network")
	}

	inspectorStationCoordinates := graph.stations[inspectorStationId].Coordinates
	userStationCoordinates := graph.stations[userStationId].Coordinates
	kmDistance := utils.DistanceKm(inspectorStationCoordinates.Latitude, inspectorStationCoordinates.Longitude, userStationCoordinates.Latitude, userStationCoordinates.Longitude)

	// If the user is less than 1 km away from the station, we just return 1 station distance
	if kmDistance < 1 {
		return c.String(http.StatusOK, "1")
	}

	distances := findShortestDistance(graph, inspectorStationId, userStationId)

	// Cache the result
	distanceCache.setDistanceInCache(networkID, inspectorStationId, userStationId, distances)

	return c.String(http.StatusOK, fmt.Sprintf("%d", distances))
}

func loadNetworkGraph(networkID string) (*networkGraph, bool) {
	logger.Log.Debug().Str("network", networkID).Msg("Reading and creating sorted stations list and lines list")

	stationsList, ok := data.GetStationsList(networkID)
	if !ok {
		return nil, false
	}

	linesList, ok := data.GetLinesList(networkID)
	if !ok {
		return nil, false
	}

	stationIds := make([]string, 0, len(stationsList))
	for id := range stationsList {
		stationIds = append(stationIds, id)
	}

	// Sorted to get a deterministic result, because the iteration order of a map is not guaranteed
	sort.Strings(stationIds)

	return &networkGraph{stations: stationsList, stationIds: stationIds, lines: linesList}, true
}

// ---- dijkstra

func GetAdjacentStationsId(graph *networkGraph, stationId string) []string {

	stationLines := graph.stations[stationId].Lines

	adjacentStations := make([]string, 0)

	// Get the adjacent stations for each line the station is on
	for _, line := range stationLines {
		currentStationId, err := getIndexOfStationId(stationId, graph.lines[line])

		if currentStationId == -1 && err != nil {
			logger.Log.Error().Err(err).Msg("Error getting the station Id")
		}

		// get the adjacent stations one station before and one station after the current station
		if currentStationId > 0 {
			adjacentStations = append(adjacentStations, graph.lines[line][currentStationId-1])
		}

		if currentStationId < len(graph.lines[line])-1 {
			adjacentStations = append(adjacentStations, graph.lines[line][currentStationId+1])
		}
	}

	// Remove duplicates
	adjacentStations = removeDuplicateAdjacentStations(adjacentStations)

	return adjacentStations
}

func initializeQueue(graph *networkGraph, startStation string) (*list.List, map[string]int, map[string]string) {
	logger.Log.Debug().Msg("Initializing queue")

	queue := list.New()
	distances := make(map[string]int)
	lines := make(map[string]string)

	// Initialize the distances and lines
	for _, id := range graph.stationIds {
		station := graph.stations[id]
		// if the station is the starting station, we set the distance to 0, and the line to the first line the station is on
		// otherwise, we set the distance to infinity for the rest of the stations
		if id == startStation {
			distances[id] = 0
			lines[id] = station.Lines[0]
		} else {
			distances[id] = math.MaxInt32
		}
		// when first beginning the for loop, the station.Lines list is empty, only until id == startStation (the starting node in the graph)
		if len(station.Lines) > 0 {
			queue.PushBack(StationNode{id, distances[id], station.Lines[0]})
		}
	}
	return queue, distances, lines
}

func findSmallestDistanceStation(queue *list.List) StationNode {

	var currentStation StationNode
	for firstQueueElement := queue.Front(); firstQueueElement != nil; firstQueueElement = firstQueueElement.Next() {
		station := firstQueueElement.Value.(StationNode)
		if currentStation.id == "" || station.distance < currentStation.distance {
			currentStation = station
		}
	}
	return currentStation
}

func removeStationFromQueue(queue *list.List, stationId string) {

	// here we remove the station from the queue,
	// but we don't need to remove any duplicate stations, as space complexity may come down but time complexity exponentially highly increase
	// also dijkstra works fine with duplicate stations in the queue because it will always choose the station with the smallest distance
	for firstQueueElement := queue.Front(); firstQueueElement != nil; firstQueueElement = firstQueueElement.Next() {
		if firstQueueElement.Value.(StationNode).id == stationId {
			queue.Remove(firstQueueElement)
			break
		}
	}
}

func updateDistances(graph *networkGraph, queue *list.List, currentStation StationNode, distances map[string]int, lines map[string]string) {

	for _, adjacentStationId := range GetAdjacentStationsId(graph, currentStation.id) {
		// each distance from one station to another is 1
		newDistance := currentStation.distance + 1

		if newDistance < distances[adjacentStationId] {

			distances[adjacentStationId] = newDistance
			lines[adjacentStationId] = graph.stations[adjacentStationId].Lines[0]
			queue.PushBack(StationNode{adjacentStationId, newDistance, graph.stations[adjacentStationId].Lines[0]})
		}
	}
}

// FindShortestDistance returns the number of stops between two stations of a
// network, or -1 if the network is unknown or the stations are not connected.
func FindShortestDistance(networkID string, startStation string, userStationId string) int {
	graph, ok := loadNetworkGraph(networkID)
	if !ok {
		logger.Log.Error().Str("network", networkID).Msg("No transit data for network")
		return -1
	}

	return findShortestDistance(graph, startStation, userStationId)
}

func findShortestDistance(graph *networkGraph, startStation string, userStationId string) int {
	logger.Log.Debug().Msg("Finding the shortest distance")

	endStation := userStationId

	// Initialize the queue, distances, lines and a map to keep track of visited stations
	visited := make(map[string]bool)
	queue, distances, lines := initializeQueue(graph, startStation)

	for queue.Len() > 0 {
		// Find the station in the queue with the smallest distance
		var currentStation = findSmallestDistanceStation(queue)

		// If the smallest distance is infinity or the integer had an overflow , we've reached the end of the list
		// and there are no possibilites to reach the end station
		// actually nearly impossible that we reach infinity, but if we add good penalty for changing lines, it could happen
		// this is a very rare case, but we need to handle it!!!
		if currentStation.distance == math.MaxInt32 || currentStation.distance < 0 {
			break
		}

		// If our current station is the end station, we can stop
		if currentStation.id == endStation {
			break
		}

		// Remove the current station from the queue and mark it as visited
		removeStationFromQueue(queue, currentStation.id)
		visited[currentStation.id] = true

		// Update the distances to the adjacent stations
		updateDistances(graph, queue, currentStation, distances, lines)
	}

	if distances[endStation] == math.MaxInt32 {
		return -1
	}
	return distances[endStation]
}
