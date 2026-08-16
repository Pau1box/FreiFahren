package itineraries

import (
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"net/url"
	"os"
	"sort"
	"strings"
	"time"

	"github.com/FreiFahren/backend/api/prediction"
	"github.com/FreiFahren/backend/data"
	"github.com/FreiFahren/backend/logger"
	"github.com/FreiFahren/backend/utils"
)

func calculateLegRisk(leg *Leg, riskData *prediction.RiskData) float64 {
	// Skip walking legs
	if leg.Mode == "WALK" {
		return 0
	}

	// set Regional Trains to max risk, as they always have an inspector
	if leg.Mode == "REGIONAL_RAIL" {
		return 100
	}

	line := leg.RouteShortName
	if line == nil {
		return 0
	}

	// Create a slice of all stops in order (from -> intermediate -> to)
	allStops := make([]Position, 0, len(leg.IntermediateStops)+2)
	allStops = append(allStops, leg.From)
	allStops = append(allStops, leg.IntermediateStops...)
	allStops = append(allStops, leg.To)

	var totalRisk float64
	var segmentCount int

	// Calculate risk for each consecutive pair of stops
	for i := 0; i < len(allStops)-1; i++ {
		// Get station IDs from the engines format
		fromID := ""
		if id := allStops[i].StopID; id != "" {
			if parts := strings.Split(id, ":"); len(parts) > 0 {
				fromID = parts[len(parts)-1]
			}
		}

		toID := ""
		if id := allStops[i+1].StopID; id != "" {
			if parts := strings.Split(id, ":"); len(parts) > 0 {
				toID = parts[len(parts)-1]
			}
		}

		if fromID == "" || toID == "" {
			continue
		}

		// Try both directions of the segment
		forwardKey := fmt.Sprintf("%s.%s:%s", *line, fromID, toID)
		reverseKey := fmt.Sprintf("%s.%s:%s", *line, toID, fromID)

		if risk, exists := riskData.SegmentsRisk[forwardKey]; exists {
			totalRisk += risk.Risk
			segmentCount++
			continue
		}

		if risk, exists := riskData.SegmentsRisk[reverseKey]; exists {
			totalRisk += risk.Risk
			segmentCount++
		}
	}

	if segmentCount > 0 {
		return totalRisk / float64(segmentCount)
	}
	return 0
}

func calculateItineraryRisk(itinerary *Itinerary, riskData *prediction.RiskData) float64 {
	var totalRisk float64
	var transitLegs int

	for i := range itinerary.Legs {
		risk := calculateLegRisk(&itinerary.Legs[i], riskData)
		totalRisk += risk
		if itinerary.Legs[i].Mode != "WALK" {
			transitLegs++
		}
	}

	if transitLegs > 0 {
		return totalRisk / float64(transitLegs)
	}
	return 0
}

// engineStationKey reduces an engine station id to the part that identifies the station, so that two
// ids for the same place compare equal.
//
// Two things differ between the id we stored and the one the engine hands back. The feed prefix:
// the same station arrives as `de-VBB_...` or `de-DELFI_...` depending on which feed answered. And
// the depth: a German station id (DHID) reads `<country>:<municipality>:<stop>` and the engine
// appends the area and the platform, as in `de-VBB_de:11000:900110521::4`.
//
// Regions whose feed does not use DHIDs at all carry an opaque id instead, `de-VBN_000120545001`,
// which has no colons to cut at. Those used to fall out of the translation entirely, which left
// Braunschweig and Bremen able to plan a route but with no station ids on its legs, and therefore
// no risk colours. Everything after the feed prefix is the key for them.
func engineStationKey(engineId string) string {
	if separator := strings.Index(engineId, "_"); separator >= 0 {
		engineId = engineId[separator+1:]
	}

	const stationLevelParts = 3
	parts := strings.Split(engineId, ":")
	if len(parts) >= stationLevelParts {
		return strings.Join(parts[:stationLevelParts], ":")
	}
	return engineId
}

// translateEngineStationId maps an engine stop id back to our station id, or returns the engine id
// unchanged when nothing matches.
//
// More than one of our stations can carry the same engine id: two stations the generator kept apart
// that the engine knows as one stop. The validator warns about those, sixteen across the networks
// built so far, but they are legitimate data rather than a fault to fix here. This used to return
// whichever one Go's map iteration reached first, so the same route could name a different station
// on every request. The position decides instead, and without one the lowest id wins, which is at
// least the same answer every time.
func translateEngineStationId(networkID, engineId string, latitude, longitude float64) string {
	stationsMap, _ := data.GetStationsMap(networkID)

	key := engineStationKey(engineId)
	var matched []string
	for freifahrenId, mappedEngineId := range stationsMap {
		if key == engineStationKey(mappedEngineId) {
			matched = append(matched, freifahrenId)
		}
	}

	switch len(matched) {
	case 0:
		return engineId
	case 1:
		return matched[0]
	}

	stationsList, _ := data.GetStationsList(networkID)
	sort.Strings(matched)
	best := matched[0]
	if latitude == 0 && longitude == 0 {
		return best
	}

	bestDistance := math.MaxFloat64
	for _, candidate := range matched {
		station, exists := stationsList[candidate]
		if !exists {
			continue
		}
		distance := utils.DistanceKm(latitude, longitude, station.Coordinates.Latitude, station.Coordinates.Longitude)
		if distance < bestDistance {
			best, bestDistance = candidate, distance
		}
	}
	return best
}

// stationMatchRadiusKm is how far an engine stop may sit from one of our stations and still be
// taken for it. A platform of the same stop is a few dozen metres away at most, so this is
// generous for the intended case while staying below the 250 m radius the generator merges
// stations at, which keeps two of our own stations from both being candidates in practice.
const stationMatchRadiusKm = 0.15

// stationIdNearPosition finds our station for an engine stop by position, and is the fallback for
// when the id does not translate.
//
// The id path only works where the ids share a structure we can cut down to the station, which is
// the case for the DHID feeds. A feed like de-VBN uses opaque numbers whose platform digits sit
// inside the number itself: the same stop arrives as ...545001 and ...545002, so the stop we
// stored matches only the platform we happened to store. Guessing which digits to strip would be
// a guess about one feed's numbering, and a wrong guess merges two stations silently.
//
// The position is feed independent and the engine sends it on every leg. An ambiguous result is
// dropped rather than resolved, so a stop between two of our stations keeps its engine id and the
// leg simply stays uncoloured, which is what happened before this fallback existed anyway.
func stationIdNearPosition(networkID string, latitude, longitude float64) (string, bool) {
	if latitude == 0 && longitude == 0 {
		return "", false
	}

	stationsList, _ := data.GetStationsList(networkID)

	var nearestId string
	var nearestDistance float64
	matches := 0
	for stationId, station := range stationsList {
		distance := utils.DistanceKm(latitude, longitude, station.Coordinates.Latitude, station.Coordinates.Longitude)
		if distance > stationMatchRadiusKm {
			continue
		}
		matches++
		if nearestId == "" || distance < nearestDistance {
			nearestId, nearestDistance = stationId, distance
		}
	}

	if matches != 1 {
		return "", false
	}
	return nearestId, true
}

func translateStationIds(networkID string, position *Position) {
	if position.StopID == "" {
		return
	}

	translated := translateEngineStationId(networkID, position.StopID, position.Lat, position.Lon)
	if translated != position.StopID {
		position.StopID = translated
		return
	}

	if nearby, found := stationIdNearPosition(networkID, position.Lat, position.Lon); found {
		position.StopID = nearby
	}
}

func translateStationName(networkID, stationId string, currentName string) string {
	// Get the stations list which contains the station details
	stationsList, _ := data.GetStationsList(networkID)

	// Look up the station in the list
	if station, exists := stationsList[stationId]; exists {
		return station.Name
	}

	// The routing engine disambiguates stop names across Germany by appending the city,
	// for example "Hauptbahnhof (Berlin)". Inside a single network that suffix is noise,
	// so it is stripped for the network we are actually serving instead of for Berlin only.
	if network, ok := data.GetNetwork(networkID); ok {
		return strings.ReplaceAll(currentName, " ("+network.Name+")", "")
	}

	return currentName
}

func removeRedundantWalkingLegs(itinerary *Itinerary) {
	// Filter out walking legs with same from and to stop ID
	filteredLegs := make([]Leg, 0)
	for _, leg := range itinerary.Legs {
		if leg.Mode == "WALK" && leg.From.StopID == leg.To.StopID {
			continue // Skip this leg
		}
		filteredLegs = append(filteredLegs, leg)
	}
	itinerary.Legs = filteredLegs
}

func translateResponseStations(networkID string, response *EngineResponse) {
	// Translate From and To station IDs
	translateStationIds(networkID, &response.From)
	translateStationIds(networkID, &response.To)

	// Translate station names using the translated IDs
	response.From.Name = translateStationName(networkID, response.From.StopID, response.From.Name)
	response.To.Name = translateStationName(networkID, response.To.StopID, response.To.Name)

	// Translate station IDs in all itineraries and remove redundant walking legs
	for i := range response.Itineraries {
		for j := range response.Itineraries[i].Legs {
			// Translate From and To station IDs in each leg
			translateStationIds(networkID, &response.Itineraries[i].Legs[j].From)
			translateStationIds(networkID, &response.Itineraries[i].Legs[j].To)

			// Translate station names using the translated IDs
			response.Itineraries[i].Legs[j].From.Name = translateStationName(
				networkID,
				response.Itineraries[i].Legs[j].From.StopID,
				response.Itineraries[i].Legs[j].From.Name,
			)
			response.Itineraries[i].Legs[j].To.Name = translateStationName(
				networkID,
				response.Itineraries[i].Legs[j].To.StopID,
				response.Itineraries[i].Legs[j].To.Name,
			)

			// Translate station IDs and names in intermediate stops
			for k := range response.Itineraries[i].Legs[j].IntermediateStops {
				stop := &response.Itineraries[i].Legs[j].IntermediateStops[k]
				translateStationIds(networkID, stop)
				stop.Name = translateStationName(networkID, stop.StopID, stop.Name)
			}
		}
	}
}

func translateToResponsePosition(pos Position) ResponsePosition {
	return ResponsePosition{
		BasePosition: BasePosition[any]{
			Name:               pos.Name,
			StopID:             pos.StopID,
			Lat:                pos.Lat,
			Lon:                pos.Lon,
			Departure:          pos.Departure,
			ScheduledDeparture: pos.ScheduledDeparture,
			Arrival:            pos.Arrival,
			ScheduledArrival:   pos.ScheduledArrival,
		},
	}
}

func translateToResponseLeg(leg *Leg) ResponseLeg {
	fromPos := translateToResponsePosition(leg.From)
	toPos := translateToResponsePosition(leg.To)

	// Convert intermediate stops
	intermediateStops := make([]ResponsePosition, len(leg.IntermediateStops))
	for i, stop := range leg.IntermediateStops {
		intermediateStops[i] = translateToResponsePosition(stop)
	}

	return ResponseLeg{
		BaseLeg: BaseLeg[ResponsePosition, LegGeometry]{
			Mode:               leg.Mode,
			From:               fromPos,
			To:                 toPos,
			Duration:           leg.Duration,
			StartTime:          leg.StartTime,
			EndTime:            leg.EndTime,
			ScheduledStartTime: leg.ScheduledStartTime,
			ScheduledEndTime:   leg.ScheduledEndTime,
			RouteShortName:     leg.RouteShortName,
			IntermediateStops:  intermediateStops,
			LegGeometry:        leg.LegGeometry,
		},
	}
}

func translateToResponseItinerary(itinerary *Itinerary) ResponseItinerary {
	responseLeg := make([]ResponseLeg, len(itinerary.Legs))
	for i, leg := range itinerary.Legs {
		responseLeg[i] = translateToResponseLeg(&leg)
	}

	return ResponseItinerary{
		BaseItinerary: BaseItinerary[ResponseLeg]{
			Duration:       itinerary.Duration,
			StartTime:      itinerary.StartTime,
			EndTime:        itinerary.EndTime,
			Transfers:      itinerary.Transfers,
			Legs:           responseLeg,
			CalculatedRisk: itinerary.CalculatedRisk,
		},
	}
}

// engineClient talks to the routing engine. The default client has no timeout at all, so
// an engine that accepts the connection and then stops answering would hold the request,
// and with it a connection of ours, for as long as it likes.
var engineClient = &http.Client{Timeout: 15 * time.Second}

func GenerateItineraries(networkID string, req ItineraryRequest) (*ItinerariesResponse, error) {
	// Get station IDs using the map
	// The caller has already rejected stations of another network, so a station missing
	// here is one of ours that has no engine id, which a client cannot do anything about.
	stationsMap, _ := data.GetStationsMap(networkID)
	startStationId, exists := stationsMap[req.StartStation]
	if !exists {
		return nil, &ValidationError{message: "The start station is not served by the routing engine"}
	}

	endStationId, exists := stationsMap[req.EndStation]
	if !exists {
		return nil, &ValidationError{message: "The end station is not served by the routing engine"}
	}

	// Construct the URL with query parameters
	engineURL := fmt.Sprintf("%s/plan", os.Getenv("ENGINE_URL"))
	currentTime := time.Now().UTC().Format(time.RFC3339)

	queryParams := url.Values{}
	queryParams.Set("time", currentTime)
	queryParams.Set("fromPlace", startStationId)
	queryParams.Set("toPlace", endStationId)
	queryParams.Set("arriveBy", "false")
	queryParams.Set("timetableView", "true")
	queryParams.Set("pedestrianProfile", "FOOT")
	queryParams.Set("preTransitModes", "WALK")
	queryParams.Set("postTransitModes", "WALK")
	queryParams.Set("directModes", "WALK")
	queryParams.Set("requireBikeTransport", "false")

	// Make request to the engine
	resp, err := engineClient.Get(engineURL + "?" + queryParams.Encode())
	if err != nil {
		logger.Log.Error().Err(err).Msg("Failed to fetch route from engine")
		return nil, &EngineError{message: "Failed to fetch route from engine"}
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, &EngineError{message: "Engine returned non-200 status code"}
	}

	// Decode engine response directly into our struct
	var engineResp EngineResponse
	if err := json.NewDecoder(resp.Body).Decode(&engineResp); err != nil {
		logger.Log.Error().Err(err).Msg("Failed to decode engine response")
		return nil, fmt.Errorf("failed to decode engine response: %w", err)
	}

	// translate and remove redundant walking legs
	translateResponseStations(networkID, &engineResp)
	for i := range engineResp.Itineraries {
		removeRedundantWalkingLegs(&engineResp.Itineraries[i])
	}

	// A network the engine has no timetable for, or two stations with no connection between
	// them, comes back without a single itinerary. That is an answer rather than a fault, and
	// it has to be returned before the scoring below: it would ask the risk model for a
	// network that has none, size a slice at minus one and read the safest itinerary out of
	// an empty slice.
	if len(engineResp.Itineraries) == 0 {
		return &ItinerariesResponse{
			RequestParameters:      engineResp.RequestParameters,
			DebugOutput:            engineResp.DebugOutput,
			From:                   translateToResponsePosition(engineResp.From),
			To:                     translateToResponsePosition(engineResp.To),
			SafestItinerary:        nil,
			AlternativeItineraries: []ResponseItinerary{},
		}, nil
	}

	// Get current risk data
	riskData, ok := prediction.Cache.Get(networkID)
	if !ok {
		var err error
		riskData, err = prediction.ExecuteRiskModel(networkID)
		if err != nil {
			logger.Log.Error().Err(err).Msg("Failed to get risk data")
			return nil, fmt.Errorf("failed to get risk data: %w", err)
		}
	}

	// Calculate risk for all itineraries
	var allItineraries []Itinerary
	var safestRouteIndex int
	var lowestRisk float64

	for i := range engineResp.Itineraries {
		engineResp.Itineraries[i].CalculatedRisk = calculateItineraryRisk(&engineResp.Itineraries[i], riskData)

		// Keep track of the safest route
		if i == 0 || engineResp.Itineraries[i].CalculatedRisk < lowestRisk {
			safestRouteIndex = i
			lowestRisk = engineResp.Itineraries[i].CalculatedRisk
		}

		allItineraries = append(allItineraries, engineResp.Itineraries[i])
	}

	// Filter out the safest route from alternative routes while preserving order
	// order is preserved as the engine already returns the itereraries by how good they are
	alternativeItineraries := make([]Itinerary, 0, len(allItineraries)-1)
	for i, itin := range allItineraries {
		if i != safestRouteIndex {
			alternativeItineraries = append(alternativeItineraries, itin)
		}
	}

	// Limit to top 10 itineraries in total (including safest route)
	maxTotal := 10
	if len(alternativeItineraries) > maxTotal-1 {
		alternativeItineraries = alternativeItineraries[:maxTotal-1]
	}

	// Construct final response
	safestItinerary := translateToResponseItinerary(&allItineraries[safestRouteIndex])
	response := &ItinerariesResponse{
		RequestParameters:      engineResp.RequestParameters,
		DebugOutput:            engineResp.DebugOutput,
		From:                   translateToResponsePosition(engineResp.From),
		To:                     translateToResponsePosition(engineResp.To),
		SafestItinerary:        &safestItinerary,
		AlternativeItineraries: make([]ResponseItinerary, len(alternativeItineraries)),
	}

	for i, itinerary := range alternativeItineraries {
		response.AlternativeItineraries[i] = translateToResponseItinerary(&itinerary)
	}

	return response, nil
}
