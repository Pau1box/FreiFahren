package inspectors

import (
	"bytes"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"sync"
	"time"

	"github.com/FreiFahren/backend/api/networks"
	"github.com/FreiFahren/backend/api/prediction"
	"github.com/FreiFahren/backend/data"
	"github.com/FreiFahren/backend/database"
	_ "github.com/FreiFahren/backend/docs"
	"github.com/FreiFahren/backend/logger"
	structs "github.com/FreiFahren/backend/utils"

	"github.com/labstack/echo/v4"
)

// miniAppNotificationInterval is how long the mini app chat of one network is
// left alone after a notification.
const miniAppNotificationInterval = 5 * time.Minute

// miniAppRateLimit keeps the last mini app notification per network. Every
// network has its own Telegram chat, so a report in one city must not silence
// the chat of another. The mutex is needed because the notification runs in a
// goroutine and echo serves requests in parallel.
type miniAppRateLimit struct {
	mutex sync.Mutex
	last  map[string]time.Time
}

var miniAppNotifications = &miniAppRateLimit{last: make(map[string]time.Time)}

// reserve claims the network's next notification, or reports that it is too soon.
//
// Checking and claiming happen under one lock on purpose. Two reports for the same city arriving
// together would otherwise both find the interval passed, because the claim only happened after the
// HTTP call to the mini app, which takes long enough for that to be the normal case rather than a
// rare one. The chat would then get both.
//
// The returned times are what `release` needs to undo the claim.
func (r *miniAppRateLimit) reserve(networkID string) (previous, claimed time.Time, allowed bool) {
	r.mutex.Lock()
	defer r.mutex.Unlock()

	previous = r.last[networkID]
	if time.Since(previous) < miniAppNotificationInterval {
		return time.Time{}, time.Time{}, false
	}

	claimed = time.Now()
	r.last[networkID] = claimed
	return previous, claimed, true
}

// release gives the claim back after a notification that did not go out, so a failing mini app does
// not cost the network its next five minutes. It leaves a claim someone else has since made alone.
func (r *miniAppRateLimit) release(networkID string, previous, claimed time.Time) {
	r.mutex.Lock()
	defer r.mutex.Unlock()

	if r.last[networkID].Equal(claimed) {
		r.last[networkID] = previous
	}
}

// IsTrustedReporter reports whether the request carries the shared password our own bots
// authenticate with, which lets them skip the spam check and the rate limit.
//
// An unset REPORT_PASSWORD authenticates nobody. Comparing the header against an empty
// variable used to be true for every anonymous request, which turned a missing deployment
// secret into an open door instead of a locked one. The comparison itself runs in constant
// time so that the password cannot be guessed byte by byte from the response time.
func IsTrustedReporter(c echo.Context) bool {
	expected := os.Getenv("REPORT_PASSWORD")
	if expected == "" {
		return false
	}

	provided := c.Request().Header.Get("X-Password")
	return subtle.ConstantTimeCompare([]byte(provided), []byte(expected)) == 1
}

func verifyRequest(c echo.Context) error {
	securityServiceURL := os.Getenv("SECURITY_MICROSERVICE_URL")
	if securityServiceURL == "" {
		return errors.New("security service configuration error")
	}

	// Collect headers from the incoming request
	headers := make(map[string]string)
	for key, values := range c.Request().Header {
		if len(values) > 0 {
			headers[key] = values[0]
		}
	}

	// Create payload with headers
	payload := map[string]interface{}{
		"headers": headers,
	}

	jsonData, err := json.Marshal(payload)
	if err != nil {
		return errors.New("failed to verify request")
	}

	// Create HTTP client with timeout
	client := &http.Client{
		Timeout: 5 * time.Second,
	}

	// Create POST request to security microservice
	req, err := http.NewRequest("POST", securityServiceURL+"/check", bytes.NewBuffer(jsonData))
	if err != nil {
		return errors.New("failed to verify request")
	}
	req.Header.Set("Content-Type", "application/json")

	// Make the request
	resp, err := client.Do(req)
	if err != nil {
		return errors.New("failed to verify request")
	}
	defer resp.Body.Close()

	// Parse response
	var result struct {
		Valid bool `json:"valid"`
	}

	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return errors.New("failed to verify request")
	}

	// Check if request is valid
	if !result.Valid {
		return errors.New("spam report detected")
	}

	return nil
}

// @Summary Submit ticket inspector data
//
// @Description Accepts a JSON payload with details about a ticket inspector's current location.
// @Description This endpoint validates the provided data, processes necessary computations for linking stations and lines,
// @Description inserts the data into the database, and triggers an update to the risk model used in operational analysis.
// @Description If the 'timestamp' field of the body is not provided, the current UTC time truncated to the nearest minute is used automatically.
// @Description The endpoint is rate limited per IP address, and reports classified as spam are rejected with 403.
//
// @Tags basics
//
// @Accept json
// @Produce json
//
// @Param inspectorData body structs.InspectorRequest true "Data about the inspector's location and activity, including an optional 'timestamp' in RFC3339 format"
// @Param network query string false "ID of the network (defaults to berlin)"
//
// @Success 200 {object} structs.ResponseData "Successfully processed and inserted the inspector data with computed linkages and risk model updates."
// @Failure 400 "Bad Request: Missing or incorrect parameters provided."
// @Failure 403 {object} map[string]string "Forbidden: The report was classified as spam."
// @Failure 404 {object} map[string]string "Not Found: The specified network does not exist."
// @Failure 422 {object} map[string]string "Unprocessable Entity: The report names a station, direction or line the network does not contain."
// @Failure 429 "Too Many Requests: The request has been rate limited."
// @Failure 500 "Internal Server Error: Error during data processing or database insertion."
//
// @Router /basics/inspectors [post]
func PostInspector(c echo.Context) error {
	logger.Log.Info().
		Msg("POST '/basics/Inspectors' UserAgent: " + c.Request().UserAgent())

	networkID, err := networks.Resolve(c)
	if err != nil {
		return err
	}

	// dont rate limit requests from the bot (password in header) or in dev mode
	if !IsTrustedReporter(c) && os.Getenv("STATUS") != "dev" {
		// Check if the request is valid
		if err := verifyRequest(c); err != nil {
			if err.Error() == "spam report detected" {
				logger.Log.Warn().
					Msg("Spam report blocked by security service")
				return c.JSON(http.StatusForbidden, map[string]string{
					"message": "Spam reports are not allowed, if you have an issue with us contact us and we can hash it out.",
				})
			}
			logger.Log.Error().
				Err(err).
				Msg("Error verifying request with security service")
			return c.JSON(http.StatusInternalServerError, map[string]string{
				"message": "Failed to verify request",
			})
		}
	}

	var req structs.InspectorRequest
	if err := c.Bind(&req); err != nil {
		logger.Log.Error().
			Err(err).
			Str("userAgent", c.Request().UserAgent()).
			Msg("Error binding request in postInspector")
		return c.NoContent(http.StatusInternalServerError)
	}
	logger.Log.Debug().Interface("Request", req).Msg("Request data")

	// Check if all parameters are empty
	if req.Line == "" && req.StationId == "" && req.DirectionId == "" {
		logger.Log.Error().
			Str("Line", req.Line).
			Str("Station", req.StationId).
			Str("Direction", req.DirectionId).
			Msg("At least one of 'line', 'station', or 'direction' must be provided")
		return c.NoContent(http.StatusBadRequest)
	}

	if unknownFields := unknownNetworkReferences(networkID, req); len(unknownFields) > 0 {
		logger.Log.Warn().
			Str("network", networkID).
			Strs("unknownFields", unknownFields).
			Msg("Report references data of another network")
		return networks.UnknownReference(networkID, unknownFields...)
	}

	dataToInsert, pointers, err := processRequestData(networkID, req)
	if err != nil {
		logger.Log.Error().Err(err).Msg("Error processing request data in postInspector")
		// todo: return error as soon as new release is deployed
		// return object from request
		return c.JSON(http.StatusOK, req)
	}

	if err := PostProcessInspectorData(networkID, dataToInsert, pointers); err != nil {
		logger.Log.Error().Err(err).Msg("Error filling missing columns in postInspector")
		return c.NoContent(http.StatusInternalServerError)
	}

	if err := database.InsertTicketInfo(
		networkID,
		pointers.TimestampPtr,
		pointers.AuthorPtr,
		pointers.MessagePtr,
		pointers.LinePtr,
		pointers.StationIdPtr,
		pointers.DirectionIdPtr,
	); err != nil {
		logger.Log.Error().Err(err).Msg("Error inserting ticket info in postInspector")
		return c.NoContent(http.StatusInternalServerError)
	}

	// Update risk model after successful report submission
	go func() {
		if _, err := prediction.ExecuteRiskModel(networkID); err != nil {
			logger.Log.Error().Err(err).Msg("Failed to update risk model after new report")
		}
	}()

	// Notify Telegram bot if there's no author (web app report)
	go func() {
		if pointers.AuthorPtr == nil {
			telegramEndpoint := os.Getenv("NLP_SERVICE_URL") + "/report-inspector"
			reportPassword := os.Getenv("REPORT_PASSWORD")
			if err := notifyOtherServiceAboutReport(networkID, telegramEndpoint, dataToInsert, "Telegram bot", reportPassword); err != nil {
				logger.Log.Error().Err(err).Msg("Error notifying Telegram bot about report in postInspector")
			}
		} else if *pointers.AuthorPtr == 77105110105 {
			previous, claimed, allowed := miniAppNotifications.reserve(networkID)
			if !allowed && os.Getenv("STATUS") != "dev" {
				logger.Log.Info().Str("network", networkID).Msg("Skipping Mini app notification, one went out recently")
				return
			}

			miniAppEndpoint := os.Getenv("NLP_SERVICE_URL") + "/mini-app/report"
			reportPassword := os.Getenv("REPORT_PASSWORD")
			if err := notifyOtherServiceAboutReport(networkID, miniAppEndpoint, dataToInsert, "Mini app", reportPassword); err != nil {
				logger.Log.Error().Err(err).Msg("Error notifying Mini app about report in postInspector")
				if allowed {
					miniAppNotifications.release(networkID, previous, claimed)
				}
			}
		}
	}()

	return c.JSON(http.StatusOK, dataToInsert)
}

// unknownNetworkReferences names the fields of a report that the requested
// network does not contain. With more than one network that is no longer a typo
// but the normal consequence of a client having the wrong city selected, so it
// is a client error rather than a server fault.
func unknownNetworkReferences(networkID string, req structs.InspectorRequest) []string {
	unknownFields := networks.UnknownStations(networkID, map[string]string{
		"stationId":   req.StationId,
		"directionId": req.DirectionId,
	})
	if req.Line != "" && !networks.HasLine(networkID, req.Line) {
		unknownFields = append(unknownFields, "line")
	}

	return unknownFields
}

func processRequestData(networkID string, req structs.InspectorRequest) (*structs.ResponseData, *structs.InsertPointers, error) {
	logger.Log.Debug().Msg("Processing ticket info for insertion")
	logger.Log.Info().Interface("Request", req).Msg("Request data")

	stations, _ := data.GetStationsList(networkID)

	response := &structs.ResponseData{}
	pointers := &structs.InsertPointers{}

	// Assign current or provided timestamp
	if req.Timestamp != (time.Time{}) {
		pointers.TimestampPtr = &req.Timestamp
		response.Timestamp = req.Timestamp
	} else {
		timestamp := time.Now().UTC().Truncate(time.Minute)
		pointers.TimestampPtr = &timestamp
		response.Timestamp = *pointers.TimestampPtr
	}

	// Assign line
	if req.Line != "" {
		pointers.LinePtr = &req.Line
		response.Line = req.Line
	}

	// Assign station
	if req.StationId != "" {
		pointers.StationIdPtr = &req.StationId
		response.Station = structs.Station{Id: req.StationId}

		if station, found := stations[req.StationId]; found {
			response.Station.Name = station.Name
		} else {
			logger.Log.Error().Str("stationId", req.StationId).Msg("Station not found")
			return nil, nil, errors.New("station not found")
		}
	}

	// Assign direction
	if req.DirectionId != "" {
		pointers.DirectionIdPtr = &req.DirectionId
		response.Direction = structs.Station{Id: req.DirectionId}

		if direction, found := stations[req.DirectionId]; found {
			response.Direction.Name = direction.Name
		}
	}

	// Assign author and message if present
	if req.Author != 0 {
		pointers.AuthorPtr = &req.Author
		response.Author = req.Author
	}
	if req.Message != "" {
		pointers.MessagePtr = &req.Message
		response.Message = req.Message
	}

	logger.Log.Info().Interface("Response", response).Msg("Response data")

	return response, pointers, nil
}

// notificationClient posts reports to the Telegram bot and the mini app. The default client
// has no timeout, so a service that stops answering would keep the goroutine, and the report
// it holds, alive for as long as the process runs.
var notificationClient = &http.Client{Timeout: 10 * time.Second}

func notifyOtherServiceAboutReport(networkID string, endpoint string, data *structs.ResponseData, serviceName string, password string) error {
	logger.Log.Debug().Str("service", serviceName).Str("network", networkID).Msg("Sending data")

	// The network picks the Telegram chat on the other side. Without it every report
	// would be announced in the chat of the default network.
	payload := map[string]string{
		"line":      data.Line,
		"station":   data.Station.Name,
		"direction": data.Direction.Name,
		"message":   data.Message,
		"stationId": data.Station.Id,
		"network":   networkID,
	}

	jsonData, err := json.Marshal(payload)
	if err != nil {
		logger.Log.Error().Err(err).Str("service", serviceName).Msg("Error marshalling data")
		return err
	}

	req, err := http.NewRequest("POST", endpoint, bytes.NewBuffer(jsonData))
	if err != nil {
		logger.Log.Error().Err(err).Str("service", serviceName).Msg("Error creating request")
		return err
	}

	req.Header.Set("Content-Type", "application/json")
	if password != "" {
		req.Header.Set("X-Password", password)
	}

	resp, err := notificationClient.Do(req)
	if err != nil {
		logger.Log.Error().Err(err).Str("service", serviceName).Msg("Error posting data")
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		errMsg := fmt.Sprintf("Non-OK response: %s", resp.Status)
		logger.Log.Error().Str("status", resp.Status).Str("service", serviceName).Msg(errMsg)
		return errors.New(errMsg)
	}

	logger.Log.Info().Str("service", serviceName).Msg("Successfully sent data")
	return nil
}
