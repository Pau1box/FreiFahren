package networks

import (
	"fmt"
	"net/http"

	"github.com/FreiFahren/backend/data"
	_ "github.com/FreiFahren/backend/docs"
	"github.com/FreiFahren/backend/logger"
	"github.com/FreiFahren/backend/utils"
	"github.com/labstack/echo/v4"
)

// DefaultNetworkID is what a request without a network parameter resolves to.
// It exists only so that clients shipped before multi network support keep
// working; new client code always sends the parameter explicitly.
const DefaultNetworkID = "berlin"

// QueryParam is the name of the query parameter every scoped endpoint accepts.
const QueryParam = "network"

// maxNetworkIDLength is the longest network id that can exist, with room to
// spare. Anything longer is rejected before it reaches a lookup, a log line or
// the error message, so that a caller cannot have arbitrary amounts of its own
// input echoed back.
const maxNetworkIDLength = 64

// Resolve returns the network a request is scoped to.
//
// An unknown network is answered with 404 rather than an empty result, so that a
// client holding a stale network id learns why its map is blank.
func Resolve(c echo.Context) (string, error) {
	networkID := c.QueryParam(QueryParam)
	if networkID == "" {
		return DefaultNetworkID, nil
	}

	if len(networkID) > maxNetworkIDLength {
		return "", echo.NewHTTPError(http.StatusNotFound, map[string]string{
			"message": "Unknown network. Call GET /v0/networks for the list of available networks.",
		})
	}

	if !data.HasNetwork(networkID) {
		return "", echo.NewHTTPError(http.StatusNotFound, map[string]string{
			"message": fmt.Sprintf("Unknown network '%s'. Call GET /v0/networks for the list of available networks.", networkID),
		})
	}

	return networkID, nil
}

// ServesPredictions reports whether a network has enough history to serve
// historic and predicted reports. A beta network shows only reports people
// actually made, because predicting from no history invents inspectors that
// were never reported.
func ServesPredictions(networkID string) bool {
	network, ok := data.GetNetwork(networkID)
	return ok && network.Status == utils.NetworkStatusActive
}

// @Summary Get all networks
//
// @Description Retrieves every transit network this deployment serves, including the geography a client needs to position its map.
// @Description This is the entry point: a client calls it before anything else and scopes every following request to one of the returned ids.
//
// @Tags networks
//
// @Produce json
//
// @Success 200 {object} []utils.Network "Successfully retrieved the available networks."
//
// @Router /networks [get]
func GetNetworks(c echo.Context) error {
	logger.Log.Info().Msg("GET '/networks' UserAgent: " + c.Request().UserAgent())

	return c.JSON(http.StatusOK, data.GetNetworks())
}
