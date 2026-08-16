package lines

import (
	"net/http"
	"strings"
	"time"

	"github.com/FreiFahren/backend/api/networks"
	"github.com/FreiFahren/backend/caching"
	"github.com/FreiFahren/backend/data"
	"github.com/FreiFahren/backend/database"
	_ "github.com/FreiFahren/backend/docs"
	"github.com/FreiFahren/backend/logger"
	"github.com/FreiFahren/backend/utils"
	"github.com/labstack/echo/v4"
)

// @Summary Get all lines
//
// @Description Retrieves information about all available transit lines.
// @Description This endpoint returns a list of all transit lines and their associated stations.
//
// @Tags lines
//
// @Produce json
//
// @Param network query string false "ID of the network (defaults to berlin)"
//
// @Success 200 {object} map[string][]string "Successfully retrieved all lines data."
// @Success 304 "Not Modified: The ETag matches the If-None-Match header."
// @Failure 404 {object} map[string]string "Not Found: The specified network does not exist."
// @Failure 500 "Internal Server Error: Error retrieving lines data."
//
// @Router /lines [get]
func GetAllLines(c echo.Context) error {
	logger.Log.Info().Msg("GET '/lines' UserAgent: " + c.Request().UserAgent())

	networkID, err := networks.Resolve(c)
	if err != nil {
		return err
	}

	if cache, exists := caching.GlobalCacheManager.Get(caching.NetworkKey("lines", networkID)); exists {
		return cache.ETagMiddleware()(func(c echo.Context) error {
			return nil
		})(c)
	}

	linesList, _ := data.GetLinesList(networkID)
	return c.JSON(http.StatusOK, linesList)
}

// @Summary Get the metadata of all lines
//
// @Description Retrieves the colour and mode of every line in the network.
// @Description Clients use this instead of deriving either from the line name, which is a per city convention rather than a fact.
//
// @Tags lines
//
// @Produce json
//
// @Param network query string false "ID of the network (defaults to berlin)"
//
// @Success 200 {object} map[string]utils.LineMetadataEntry "Successfully retrieved the line metadata."
// @Success 304 "Not Modified: The ETag matches the If-None-Match header."
// @Failure 404 {object} map[string]string "Not Found: The specified network does not exist."
//
// @Router /lines/metadata [get]
func GetLineMetadata(c echo.Context) error {
	logger.Log.Info().Msg("GET '/lines/metadata' UserAgent: " + c.Request().UserAgent())

	networkID, err := networks.Resolve(c)
	if err != nil {
		return err
	}

	// Clients send If-None-Match on this endpoint like on every other list, and the metadata is as
	// static as the lines themselves, so it answers 304 instead of resending the whole table.
	if cache, exists := caching.GlobalCacheManager.Get(caching.NetworkKey("lines-metadata", networkID)); exists {
		return cache.ETagMiddleware()(func(c echo.Context) error {
			return nil
		})(c)
	}

	lineMetadata, _ := data.GetLineMetadata(networkID)
	return c.JSON(http.StatusOK, lineMetadata)
}

// @Summary Get a single line
//
// @Description Retrieves information about a specific transit line.
// @Description This endpoint returns the details of a single line, including all its stations, based on the provided line name.
//
// @Tags lines
//
// @Produce json
//
// @Param lineName path string true "Name of the line (e.g., S1, U2)"
// @Param network query string false "ID of the network (defaults to berlin)"
//
// @Success 200 {object} map[string][]string "Successfully retrieved the specified line data."
// @Failure 404 {object} string "Line not found: The specified line does not exist."
// @Failure 500 "Internal Server Error: Error retrieving line data."
//
// @Router /lines/{lineName} [get]
func GetSingleLine(c echo.Context) error {
	logger.Log.Info().Msg("GET '/lines/:lineName' UserAgent: " + c.Request().UserAgent())

	networkID, err := networks.Resolve(c)
	if err != nil {
		return err
	}

	lineName := c.Param("lineName")
	lines, _ := data.GetLinesList(networkID)

	if line, ok := lines[lineName]; ok {
		return c.JSON(http.StatusOK, line)
	}

	// Upper casing the name used to be the whole lookup, on the assumption that a line id is all
	// capitals. Frankfurt's Ebbelwei-Express is called EEx, so the assumption costs that line a 404.
	// A case insensitive second pass keeps the convenience without the assumption.
	for id, line := range lines {
		if strings.EqualFold(id, lineName) {
			return c.JSON(http.StatusOK, line)
		}
	}

	return c.JSON(http.StatusNotFound, "Line not found: The specified line does not exist.")
}

// @Summary Get line statistics
//
// @Description Retrieves statistics for a specific line at a specific station.
// @Description This endpoint returns the number of reports for the specified line at the given station within the given time range.
//
// @Tags lines
//
// @Produce json
//
// @Param lineId path string true "ID of the line"
// @Param stationId path string true "ID of the station"
// @Param start query string false "Start time for the statistics (format: RFC3339)"
// @Param end query string false "End time for the statistics (format: RFC3339)"
// @Param network query string false "ID of the network (defaults to berlin)"
//
// @Success 200 {object} statistics.Statistics "Successfully retrieved line statistics."
// @Failure 400 {object} error "Bad Request: Invalid time format."
// @Failure 404 {object} map[string]string "Not Found: The specified network does not exist."
// @Failure 422 {object} map[string]string "Unprocessable Entity: The station or line does not belong to the network."
// @Failure 500 {object} error "Internal Server Error: Failed to get number of reports."
//
// @Router /lines/{lineId}/{stationId}/statistics [get]
func GetLineStatistics(c echo.Context) error {
	logger.Log.Info().Msg("GET '/lines/:lineId/:stationId/statistics' UserAgent: " + c.Request().UserAgent())

	networkID, err := networks.Resolve(c)
	if err != nil {
		return err
	}

	lineId := c.Param("lineId")
	stationId := c.Param("stationId")
	start := c.QueryParam("start")
	end := c.QueryParam("end")

	// Counting reports for a station or line of another network is always zero, which
	// reads like a quiet station instead of like the wrong city.
	unknownFields := networks.UnknownStations(networkID, map[string]string{"stationId": stationId})
	if lineId != "" && !networks.HasLine(networkID, lineId) {
		unknownFields = append(unknownFields, "lineId")
	}
	if len(unknownFields) > 0 {
		return networks.UnknownReference(networkID, unknownFields...)
	}

	startTime, endTime := utils.GetTimeRange(start, end, 7*24*time.Hour)

	numberOfReports, err := database.GetNumberOfReports(networkID, stationId, lineId, startTime, endTime)
	if err != nil {
		return c.JSON(http.StatusInternalServerError, map[string]string{"error": "Internal Server Error: Failed to get number of reports."})
	}

	return c.JSON(http.StatusOK, map[string]int{"numberOfReports": numberOfReports})
}

// @Summary Get all segments
//
// @Description Retrieves information about all available transit segments.
// @Description A segment is the geojson lineString part of a line between two stations.
//
// @Tags lines
//
// @Produce json
//
// @Param network query string false "ID of the network (defaults to berlin)"
//
// @Success 200 {object} utils.SegmentsCollection "GeoJSON segments data"
// @Success 304 "Not Modified"
// @Failure 404 {object} map[string]string "Not Found: The specified network does not exist."
// @Failure 500 {object} error "Internal Server Error: Error retrieving segments data."
//
// @Router /lines/segments [get]
func GetAllSegments(c echo.Context) error {
	logger.Log.Info().Msg("GET '/lines/segments' UserAgent: " + c.Request().UserAgent())

	networkID, err := networks.Resolve(c)
	if err != nil {
		return err
	}

	if cache, exists := caching.GlobalCacheManager.Get(caching.NetworkKey("segments", networkID)); exists {
		return cache.ETagMiddleware()(func(c echo.Context) error {
			return nil
		})(c)
	}

	// Fallback if cache doesn't exist. A network without segment geometry gets an
	// empty collection, so a client can render it instead of failing on an empty body.
	segments, _ := data.GetSegments(networkID)
	if len(segments) == 0 {
		segments = emptySegmentsCollection
	}
	return c.JSONBlob(http.StatusOK, segments)
}

var emptySegmentsCollection = []byte(`{"type":"FeatureCollection","features":[]}`)
