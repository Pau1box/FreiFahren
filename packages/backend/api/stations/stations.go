package stations

import (
	"net/http"
	"strings"

	"github.com/FreiFahren/backend/api/networks"
	"github.com/FreiFahren/backend/caching"
	"github.com/FreiFahren/backend/data"
	_ "github.com/FreiFahren/backend/docs"
	"github.com/FreiFahren/backend/logger"
	"github.com/FreiFahren/backend/utils"
	"github.com/labstack/echo/v4"
)

// @Summary Get all stations
//
// @Description Retrieves information about all available stations.
// @Description This endpoint returns a list of all stations and their details.
//
// @Tags stations
//
// @Produce json
//
// @Param network query string false "ID of the network (defaults to berlin)"
//
// @Success 200 {object} map[string]utils.Station
// @Success 304 "Not Modified: The ETag matches the If-None-Match header."
// @Failure 404 {object} map[string]string "Not Found: The specified network does not exist."
// @Failure 500 "Internal Server Error: Error retrieving stations data."
//
// @Router /stations [get]
func GetAllStations(c echo.Context) error {
	logger.Log.Info().Msg("GET '/stations' UserAgent: " + c.Request().UserAgent())

	networkID, err := networks.Resolve(c)
	if err != nil {
		return err
	}

	if cache, exists := caching.GlobalCacheManager.Get(caching.NetworkKey("stations", networkID)); exists {
		return cache.ETagMiddleware()(func(c echo.Context) error {
			return nil
		})(c)
	}

	stations, _ := data.GetStationsList(networkID)
	return c.JSON(http.StatusOK, stations)
}

// @Summary Get a single station by ID
//
// @Description Retrieves information about a specific station based on its ID.
// @Description This endpoint returns the details of a single station.
//
// @Tags stations
//
// @Produce json
//
// @Param stationId path string true "ID of the station"
// @Param network query string false "ID of the network (defaults to berlin)"
//
// @Success 200 {object} utils.StationListEntry "Successfully retrieved the specified station data."
// @Failure 404 {object} map[string]string "Station not found: The specified station does not exist."
//
// @Router /stations/{stationId} [get]
func GetSingleStation(c echo.Context) error {
	logger.Log.Info().Msg("GET '/stations/:stationId' UserAgent: " + c.Request().UserAgent())

	networkID, err := networks.Resolve(c)
	if err != nil {
		return err
	}

	stationId := c.Param("stationId")
	stations, _ := data.GetStationsList(networkID)

	if station, ok := stations[stationId]; ok {
		return c.JSON(http.StatusOK, station)
	}

	return c.JSON(http.StatusNotFound, "Station not found: The specified station does not exist.")
}

// @Summary Search for a station by name
//
// @Description Searches for a station using the provided name and returns the matching station information.
// @Description This endpoint is case and whitespace insensitive. Station names are not unique, so when several stations carry the name the one with the lowest id is returned.
//
// @Tags stations
//
// @Produce json
//
// @Param name query string true "Name of the station to search for"
// @Param network query string false "ID of the network (defaults to berlin)"
//
// @Success 200 {object} map[string]utils.StationListEntry "Successfully found and retrieved the station data."
// @Failure 400 {object} map[string]string "Bad Request: Missing station name parameter."
// @Failure 404 {object} map[string]string "Station not found: No station matches the provided name."
//
// @Router /stations/search [get]
func SearchStation(c echo.Context) error {
	logger.Log.Info().Msg("GET '/stations/search' UserAgent: " + c.Request().UserAgent())

	networkID, err := networks.Resolve(c)
	if err != nil {
		return err
	}

	name := c.QueryParam("name")
	if name == "" {
		return c.JSON(http.StatusBadRequest, map[string]string{"error": "Bad Request: Missing station name parameter."})
	}

	stations, _ := data.GetStationsList(networkID)
	normalizedName := strings.ToLower(strings.TrimSpace(name))

	// A station name is not unique: 56 names are shared by more than one station across the
	// networks, 33 of them in Duesseldorf alone. Returning the first match of a map iteration
	// answered the same search with a different station on every request, so the lowest id
	// wins instead, which is at least the same answer every time.
	var matchedId string
	for id, station := range stations {
		if strings.ToLower(strings.TrimSpace(station.Name)) != normalizedName {
			continue
		}
		if matchedId == "" || id < matchedId {
			matchedId = id
		}
	}

	if matchedId != "" {
		return c.JSON(http.StatusOK, map[string]utils.StationListEntry{matchedId: stations[matchedId]})
	}

	return c.JSON(http.StatusNotFound, map[string]string{"error": "Station not found: No station matches the provided name."})
}
