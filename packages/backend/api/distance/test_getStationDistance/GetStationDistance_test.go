package test_distance

import (
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"

	"github.com/FreiFahren/backend/api/distance"
	"github.com/labstack/echo/v4"
	"github.com/stretchr/testify/assert"
)

func TestGetStationDistance(t *testing.T) {
	tests := []struct {
		name               string
		inspectorStationId string
		userStationId      string
		expectedStatus     int
		expectedStops      int
	}{
		{
			name:               "Valid coordinates",
			inspectorStationId: "U-n29833491",
			userStationId:      "S-BPDH",
			expectedStatus:     http.StatusOK,
			expectedStops:      8,
		},
		{
			name:               "Station of another network",
			inspectorStationId: "sss",
			userStationId:      "abc",
			expectedStatus:     http.StatusUnprocessableEntity,
			expectedStops:      -1,
		},
		{
			name:               "Same station",
			inspectorStationId: "U-n29833491",
			userStationId:      "U-n29833491",
			expectedStatus:     http.StatusOK,
			expectedStops:      0,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			// Create a new Echo instance
			e := echo.New()

			// Create a new HTTP request
			req := httptest.NewRequest(http.MethodGet, "/", nil)
			q := req.URL.Query()
			q.Add("inspectorStationId", tt.inspectorStationId)
			q.Add("userStationId", tt.userStationId)

			req.URL.RawQuery = q.Encode()

			// Create a new Echo context
			rec := httptest.NewRecorder()
			c := e.NewContext(req, rec)

			// A station that does not belong to the network is answered with an echo error
			// rather than by writing to the recorder, so the status is read off the error.
			err := distance.GetStationDistance(c)
			if httpError, ok := err.(*echo.HTTPError); ok {
				assert.Equal(t, tt.expectedStatus, httpError.Code)
				return
			}

			if assert.NoError(t, err) {
				assert.Equal(t, tt.expectedStatus, rec.Code)

				// Check the response body
				result := strings.TrimSpace(rec.Body.String())
				if rec.Code == http.StatusOK {
					stopsCount, err := strconv.Atoi(result)
					if err != nil {
						t.Fatalf("Error converting the response body to an integer: %v", err)
					}
					if tt.expectedStops == stopsCount {
						assert.Equal(t, tt.expectedStops, stopsCount)
					} else {
						t.Fatalf("Stops count: %v and expected count: %v \n", stopsCount, tt.expectedStops)
					}
				}
			}
		})
	}
}
