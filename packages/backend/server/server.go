package server

import (
	"encoding/json"
	"net/http"
	"time"

	"github.com/FreiFahren/backend/api/distance"
	"github.com/FreiFahren/backend/api/feedback"
	"github.com/FreiFahren/backend/api/inspectors"
	itinerariesV0 "github.com/FreiFahren/backend/api/itineraries/v0"
	"github.com/FreiFahren/backend/api/lines"
	"github.com/FreiFahren/backend/api/networks"
	"github.com/FreiFahren/backend/api/prediction"
	predictionV0 "github.com/FreiFahren/backend/api/prediction/v0"
	predictionV1 "github.com/FreiFahren/backend/api/prediction/v1"
	"github.com/FreiFahren/backend/api/stations"
	statisticsV0 "github.com/FreiFahren/backend/api/stations/statistics/v0"
	"github.com/FreiFahren/backend/caching"
	"github.com/FreiFahren/backend/data"
	"github.com/FreiFahren/backend/database"
	"github.com/FreiFahren/backend/logger"
	"github.com/labstack/echo/v4"
	"github.com/labstack/echo/v4/middleware"
	cron "github.com/robfig/cron/v3"
	echoSwagger "github.com/swaggo/echo-swagger"
	"golang.org/x/time/rate"
)

// maxRequestBody is the largest body any endpoint accepts.
const maxRequestBody = "32K"

// newWriteRateLimiter throttles the endpoints that write rows, per IP address.
//
// Reports and feedback arrive at human speed, so a burst of a few is generous for a real
// client while keeping a single one from filling the table. Our own bots are exempt: they
// forward the reports of a whole Telegram group from one address, which would otherwise
// look exactly like the abuse this is here to stop.
func newWriteRateLimiter() echo.MiddlewareFunc {
	return middleware.RateLimiterWithConfig(middleware.RateLimiterConfig{
		Skipper: inspectors.IsTrustedReporter,
		Store: middleware.NewRateLimiterMemoryStoreWithConfig(middleware.RateLimiterMemoryStoreConfig{
			Rate:      rate.Limit(1),
			Burst:     10,
			ExpiresIn: 3 * time.Minute,
		}),
	})
}

// router is the part of *echo.Echo and *echo.Group that registers a route, so
// that the same helper works for the versioned groups and the unversioned root.
type router interface {
	Match(methods []string, path string, handler echo.HandlerFunc, middleware ...echo.MiddlewareFunc) []*echo.Route
}

// get registers a read route for GET and HEAD. Echo answers an unregistered
// method with 405, and a HEAD is a GET whose body the client does not want:
// net/http drops the body for us, so the handler stays untouched and clients
// can probe an endpoint without downloading it.
func get(r router, path string, handler echo.HandlerFunc) {
	r.Match([]string{http.MethodGet, http.MethodHead}, path, handler)
}

// registerNetworkCaches fills one cache per network and endpoint. The network is
// part of every cache name, otherwise one network would be served the cached
// response, and the ETag, of whichever network filled the cache first.
func registerNetworkCaches() {
	for _, network := range data.GetNetworks() {
		if segments, ok := data.GetSegments(network.ID); ok && len(segments) > 0 {
			caching.GlobalCacheManager.Register(caching.NetworkKey("segments", network.ID), segments, caching.CacheConfig{
				MaxAgeInSeconds:   31536000, // 1 year
				ContentTypeInMIME: "application/json",
			})
		}

		linesList, _ := data.GetLinesList(network.ID)
		linesBytes, err := json.Marshal(linesList)
		if err != nil {
			logger.Log.Error().Err(err).Str("network", network.ID).Msg("Error marshaling lines data for cache")
			continue
		}
		caching.GlobalCacheManager.Register(caching.NetworkKey("lines", network.ID), linesBytes, caching.CacheConfig{
			MaxAgeInSeconds:   31536000, // 1 year
			ContentTypeInMIME: "application/json",
		})

		lineMetadata, _ := data.GetLineMetadata(network.ID)
		metadataBytes, err := json.Marshal(lineMetadata)
		if err != nil {
			logger.Log.Error().Err(err).Str("network", network.ID).Msg("Error marshaling line metadata for cache")
			continue
		}
		caching.GlobalCacheManager.Register(caching.NetworkKey("lines-metadata", network.ID), metadataBytes, caching.CacheConfig{
			MaxAgeInSeconds:   31536000, // 1 year
			ContentTypeInMIME: "application/json",
		})

		stationsList, _ := data.GetStationsList(network.ID)
		stationsBytes, err := json.Marshal(stationsList)
		if err != nil {
			logger.Log.Error().Err(err).Str("network", network.ID).Msg("Error marshaling stations data for cache")
			continue
		}
		caching.GlobalCacheManager.Register(caching.NetworkKey("stations", network.ID), stationsBytes, caching.CacheConfig{
			MaxAgeInSeconds:   31536000, // 1 year
			ContentTypeInMIME: "application/json",
		})
	}
}

func SetupServer() *echo.Echo {
	logger.Init()

	data.EmbedJSONFiles()

	// Create a new connection pool, for concurrency
	database.CreatePool()

	c := cron.New()

	// Schedule a job to backup the database every day at midnight
	_, err := c.AddFunc("0 0 * * *", func() {
		database.BackupDatabase()
	})
	if err != nil {
		logger.Log.Error().Msg("Could not schedule backup job")
		logger.Log.Error().Str("Error", err.Error()).Send()
	}

	// Round the older timestamps
	_, err = c.AddFunc("*/5 * * * *", func() {
		database.RoundOldTimestamp()
	})
	if err != nil {
		logger.Log.Error().Msg("Could not schedule timestamp rounding job")
		logger.Log.Error().Str("Error", err.Error()).Send()
	}

	// Add cron job to update risk model every 5 minutes
	_, err = c.AddFunc("*/5 * * * *", func() {
		for _, network := range data.GetNetworks() {
			if _, err := prediction.ExecuteRiskModel(network.ID); err != nil {
				logger.Log.Error().Err(err).Str("network", network.ID).Msg("Failed to execute risk model in cron job")
			}
		}
	})
	if err != nil {
		logger.Log.Error().Msg("Could not schedule risk model update job")
		logger.Log.Error().Str("Error", err.Error()).Send()
	}

	c.Start()

	logger.Log.Info().Msg("Server is running...")

	// Initialize Echo instance
	e := echo.New()
	e.Use(middleware.Recover())

	// A report and a feedback message are both a handful of short strings, so anything
	// past this is not a request we serve. Without a limit echo reads whatever the caller
	// sends into memory before a handler ever looks at it.
	e.Use(middleware.BodyLimit(maxRequestBody))

	e.Use(middleware.CORSWithConfig(middleware.CORSConfig{
		AllowOrigins: []string{"*"},
		AllowMethods: []string{http.MethodGet, http.MethodHead, http.MethodPost, http.MethodPut, http.MethodDelete},
		AllowHeaders: []string{
			echo.HeaderOrigin,
			echo.HeaderContentType,
			echo.HeaderAccept,
			"If-None-Match",
			"If-Modified-Since",
			"baggage",
			"sentry-trace",
		},
		ExposeHeaders: []string{"ETag", "Last-Modified"},
	}))

	get(e, "/", func(c echo.Context) error {
		return c.String(http.StatusOK, "API")
	})

	// GET only: echo-swagger answers every other method with 405 itself.
	e.GET("/swagger/*", echoSwagger.WrapHandler)

	// Ensure the required table exists
	database.CreateReportsTable()
	database.CreateFeedbackTable()

	caching.InitCacheManager()
	registerNetworkCaches()

	// One limiter for every writing route, so that a client cannot get a fresh budget by
	// switching between the versioned and the unversioned path of the same endpoint.
	writeLimiter := newWriteRateLimiter()

	// Create API version groups
	v0 := e.Group("/v0")
	v1 := e.Group("/v1")
	latest := e // Routes without version prefix will point to latest version

	// V0 Routes
	v0.POST("/basics/inspectors", inspectors.PostInspector, writeLimiter)
	get(v0, "/basics/inspectors", inspectors.GetTicketInspectorsInfo)

	get(v0, "/networks", networks.GetNetworks)

	get(v0, "/lines", lines.GetAllLines)
	get(v0, "/lines/metadata", lines.GetLineMetadata)
	get(v0, "/lines/segments", lines.GetAllSegments)
	get(v0, "/lines/:lineName", lines.GetSingleLine)
	get(v0, "/lines/:lineId/:stationId/statistics", lines.GetLineStatistics)

	get(v0, "/stations", stations.GetAllStations)
	get(v0, "/stations/:stationId", stations.GetSingleStation)
	get(v0, "/stations/:stationId/statistics", statisticsV0.GetStationStatistics)
	get(v0, "/stations/search", stations.SearchStation)

	get(v0, "/transit/distance", distance.GetStationDistance)
	get(v0, "/transit/itineraries", itinerariesV0.GetItineraries)

	get(v0, "/risk-prediction/segment-colors", predictionV0.GetRiskSegments)

	v0.POST("/feedback", feedback.PostFeedback, writeLimiter)

	// V1 Routes
	get(v1, "/risk-prediction/segment-colors", predictionV1.GetRiskSegments)

	// Latest Routes
	latest.POST("/basics/inspectors", inspectors.PostInspector, writeLimiter)
	get(latest, "/basics/inspectors", inspectors.GetTicketInspectorsInfo)

	get(latest, "/networks", networks.GetNetworks)

	get(latest, "/lines", lines.GetAllLines)
	get(latest, "/lines/metadata", lines.GetLineMetadata)
	get(latest, "/lines/segments", lines.GetAllSegments)
	get(latest, "/lines/:lineName", lines.GetSingleLine)
	get(latest, "/lines/:lineId/:stationId/statistics", lines.GetLineStatistics)

	get(latest, "/stations", stations.GetAllStations)
	get(latest, "/stations/:stationId", stations.GetSingleStation)
	get(latest, "/stations/:stationId/statistics", statisticsV0.GetStationStatistics)
	get(latest, "/stations/search", stations.SearchStation)

	get(latest, "/transit/distance", distance.GetStationDistance)
	get(latest, "/transit/itineraries", itinerariesV0.GetItineraries)

	get(latest, "/risk-prediction/segment-colors", predictionV1.GetRiskSegments)

	latest.POST("/feedback", feedback.PostFeedback, writeLimiter)

	return e
}
