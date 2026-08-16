package prediction

import (
	"bytes"
	"encoding/json"
	"os/exec"
	"sync"
	"time"

	"github.com/FreiFahren/backend/data"
	"github.com/FreiFahren/backend/database"
	"github.com/FreiFahren/backend/logger"
)

type SegmentRisk struct {
	Color string  `json:"color"`
	Risk  float64 `json:"risk"`
}

type RiskData struct {
	SegmentsRisk map[string]SegmentRisk `json:"segments_risk"`
}

type RiskInspector struct {
	StationId string   `json:"station_id"`
	Lines     []string `json:"lines"`
	Direction string   `json:"direction"`
	Timestamp string   `json:"timestamp"`
}

// RiskCache keeps one result per network, because a segment id is only
// meaningful inside the network it was computed for.
type RiskCache struct {
	data  map[string]*RiskData
	mutex sync.RWMutex
}

var Cache = &RiskCache{data: make(map[string]*RiskData)}

func (c *RiskCache) Get(networkID string) (*RiskData, bool) {
	c.mutex.RLock()
	defer c.mutex.RUnlock()
	riskData, ok := c.data[networkID]
	return riskData, ok && riskData != nil
}

func (c *RiskCache) set(networkID string, data *RiskData) {
	c.mutex.Lock()
	defer c.mutex.Unlock()
	c.data[networkID] = data
}

func ExecuteRiskModel(networkID string) (*RiskData, error) {
	// A network without segment geometry has nothing to colour, so the model is
	// skipped rather than run against a missing file.
	segments, ok := data.GetSegments(networkID)
	if !ok || len(segments) == 0 {
		logger.Log.Debug().Str("network", networkID).Msg("Skipping risk model, network has no segments")
		emptyRiskData := &RiskData{SegmentsRisk: map[string]SegmentRisk{}}
		Cache.set(networkID, emptyRiskData)
		return emptyRiskData, nil
	}

	endTime := time.Now().UTC()
	startTime := endTime.Add(-time.Hour)
	ticketInfoList, err := database.GetLatestTicketInspectors(networkID, startTime, endTime, "")
	if err != nil {
		logger.Log.Error().Err(err).Msg("Failed to get ticket inspectors")
		return nil, err
	}

	// Get stations list for line lookup
	stationsList, _ := data.GetStationsList(networkID)

	// Convert TicketInspector to RiskInspector
	riskInspectors := make([]RiskInspector, 0, len(ticketInfoList))
	for _, inspector := range ticketInfoList {
		var lines []string
		if inspector.Line.Valid && inspector.Line.String != "" {
			lines = []string{inspector.Line.String}
		} else {
			if station, ok := stationsList[inspector.StationId]; ok {
				lines = station.Lines
			} else {
				logger.Log.Warn().Msgf("Station %s not found in stations list", inspector.StationId)
				continue
			}
		}

		if len(lines) > 0 {
			direction := ""
			if inspector.DirectionId.Valid {
				direction = inspector.DirectionId.String
			}

			riskInspector := RiskInspector{
				StationId: inspector.StationId,
				Lines:     lines,
				Direction: direction,
				Timestamp: inspector.Timestamp.Format(time.RFC3339),
			}
			riskInspectors = append(riskInspectors, riskInspector)
		}
	}

	// Convert risk inspectors to JSON
	inspectorData, err := json.Marshal(riskInspectors)
	if err != nil {
		logger.Log.Error().Err(err).Msg("Failed to marshal inspector data")
		return nil, err
	}

	// Create command to run Python script
	cmd := exec.Command("python3", "api/prediction/risk_model.py", data.SegmentsPath(networkID))
	cmd.Dir = "."

	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	stdin, err := cmd.StdinPipe()
	if err != nil {
		logger.Log.Error().Err(err).Msg("Failed to create stdin pipe")
		return nil, err
	}

	// Start the risk model
	if err := cmd.Start(); err != nil {
		logger.Log.Error().Err(err).Msg("Failed to start Python script")
		return nil, err
	}

	if _, err := stdin.Write(inspectorData); err != nil {
		logger.Log.Error().Err(err).Msg("Failed to write to stdin")
		return nil, err
	}
	stdin.Close()
	logger.Log.Debug().Msgf("risk model started with data: %s", string(inspectorData))

	if err := cmd.Wait(); err != nil {
		logger.Log.Error().
			Err(err).
			Str("stderr", stderr.String()).
			Msg("Python script failed")
		return nil, err
	}

	// Unmarshal the output
	var riskData RiskData
	if err := json.Unmarshal(stdout.Bytes(), &riskData); err != nil {
		logger.Log.Error().Err(err).Msg("Failed to unmarshal Python output")
		return nil, err
	}
	logger.Log.Debug().Msgf("amount of segments generated: %d", len(riskData.SegmentsRisk))

	// Update cache with new data
	Cache.set(networkID, &riskData)
	return &riskData, nil
}
