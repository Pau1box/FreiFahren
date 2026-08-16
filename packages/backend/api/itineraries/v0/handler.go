package v0

import (
	"net/http"

	"github.com/FreiFahren/backend/api/itineraries"
	"github.com/FreiFahren/backend/api/networks"
	"github.com/FreiFahren/backend/logger"
	"github.com/labstack/echo/v4"
)

// @Summary Get route itineraries between two stations
//
// @Description Retrieves possible routes between two stations, including a safest itinerary based on risk prediction.
// @Description This endpoint calculates multiple itinerary options and enriches them with risk data from the risk prediction model.
// @Description The response includes both the safest itinerary and alternative itineraries, sorted by their calculated risk.
//
// @Tags transit
//
// @Accept json
// @Produce json
//
// @Param startStation query string true "Start station ID"
// @Param endStation query string true "End station ID"
// @Param network query string false "ID of the network (defaults to berlin)"
//
// @Success 200 {object} itineraries.ItinerariesResponse "Successfully retrieved route options"
// @Failure 400 {object} map[string]string "Bad Request: Missing station IDs, or a station the routing engine does not serve"
// @Failure 404 {object} map[string]string "Not Found: The specified network does not exist."
// @Failure 422 {object} map[string]string "Unprocessable Entity: One of the stations does not belong to the network."
// @Failure 502 {object} map[string]string "Bad Gateway: Failed to fetch route from engine"
// @Failure 500 {object} map[string]string "Internal Server Error: Failed to process route data"
//
// @Router /v0/transit/itineraries [get]
func GetItineraries(c echo.Context) error {
	logger.Log.Info().Msg("GET '/v0/transit/itineraries' UserAgent: " + c.Request().UserAgent())

	networkID, err := networks.Resolve(c)
	if err != nil {
		return err
	}

	startStation := c.QueryParam("startStation")
	endStation := c.QueryParam("endStation")

	if startStation == "" || endStation == "" {
		return c.JSON(http.StatusBadRequest, map[string]string{
			"error": "Missing startStation or endStation query parameter",
		})
	}

	// A station of another network is a client error and is told apart from a station of
	// this network that the routing engine does not serve, which is a gap in our data
	// rather than something the caller can fix.
	if unknown := networks.UnknownStations(networkID, map[string]string{
		"startStation": startStation,
		"endStation":   endStation,
	}); len(unknown) > 0 {
		return networks.UnknownReference(networkID, unknown...)
	}

	req := itineraries.ItineraryRequest{
		StartStation: startStation,
		EndStation:   endStation,
	}

	response, err := itineraries.GenerateItineraries(networkID, req)
	if err != nil {
		switch err.(type) {
		case *itineraries.ValidationError:
			return c.JSON(http.StatusBadRequest, map[string]string{
				"error": err.Error(),
			})
		case *itineraries.EngineError:
			return c.JSON(http.StatusBadGateway, map[string]string{
				"error": err.Error(),
			})
		default:
			logger.Log.Error().Err(err).Msg("Unexpected error in GetItineraries")
			return c.JSON(http.StatusInternalServerError, map[string]string{
				"error": "An unexpected error occurred",
			})
		}
	}

	return c.JSON(http.StatusOK, response)
}
