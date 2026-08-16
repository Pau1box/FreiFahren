package data

import (
	"embed"
	"encoding/json"
	"fmt"
	"io/fs"
	"path"
	"sort"
	"sync"

	"github.com/FreiFahren/backend/logger"
	utils "github.com/FreiFahren/backend/utils"
)

//go:embed all:networks
var embeddedNetworks embed.FS

// NetworkData holds everything the API serves for a single transit network.
// Segments and StationsMap stay empty for networks that ship without them,
// which is the normal state for a network that was just added.
type NetworkData struct {
	Network      utils.Network
	LinesList    map[string][]string
	StationsList map[string]utils.StationListEntry
	LineMetadata map[string]utils.LineMetadataEntry
	StationsMap  map[string]string
	Segments     []byte
}

var (
	networks   map[string]*NetworkData
	networkIds []string
	dataLock   sync.RWMutex
)

func EmbedJSONFiles() {
	dataLock.Lock()
	defer dataLock.Unlock()

	entries, err := fs.ReadDir(embeddedNetworks, "networks")
	if err != nil {
		logger.Log.Panic().Err(err).Msg("Failed to read embedded networks directory")
	}

	networks = make(map[string]*NetworkData, len(entries))
	networkIds = make([]string, 0, len(entries))

	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}

		networkData, err := readNetworkDir(path.Join("networks", entry.Name()))
		if err != nil {
			logger.Log.Panic().Err(err).Str("network", entry.Name()).Msg("Failed to read network data")
		}

		networks[networkData.Network.ID] = networkData
		networkIds = append(networkIds, networkData.Network.ID)
	}

	// Sorted so that GET /networks answers in a stable order across restarts.
	sort.Strings(networkIds)

	logger.Log.Info().Strs("networks", networkIds).Msg("Loaded network data")
}

func readNetworkDir(dir string) (*NetworkData, error) {
	networkBytes, err := embeddedNetworks.ReadFile(path.Join(dir, "network.json"))
	if err != nil {
		return nil, fmt.Errorf("reading network.json: %w", err)
	}

	networkData := &NetworkData{}
	if err := json.Unmarshal(networkBytes, &networkData.Network); err != nil {
		return nil, fmt.Errorf("parsing network.json: %w", err)
	}
	if networkData.Network.ID == "" {
		return nil, fmt.Errorf("network.json in %s has no id", dir)
	}
	// A network built before the reach step existed, or one where it could not
	// run, has no serves key. Serving null there would make every client handle a
	// case that means the same as the empty list.
	if networkData.Network.Serves == nil {
		networkData.Network.Serves = []string{}
	}

	if err := readRequiredJSON(dir, "StationsList.json", &networkData.StationsList); err != nil {
		return nil, err
	}
	if err := readRequiredJSON(dir, "LinesList.json", &networkData.LinesList); err != nil {
		return nil, err
	}
	if err := readRequiredJSON(dir, "LineMetadata.json", &networkData.LineMetadata); err != nil {
		return nil, err
	}

	// The remaining files back features that only exist for networks with a
	// routing engine and a segment geometry, so their absence is not an error.
	if err := readOptionalJSON(dir, "stationsMap.prod.json", &networkData.StationsMap); err != nil {
		return nil, err
	}
	networkData.StationsMap = ensureStationsMap(networkData.StationsMap)

	segments, err := embeddedNetworks.ReadFile(path.Join(dir, "segments.json"))
	if err != nil {
		logger.Log.Info().Str("network", networkData.Network.ID).Msg("No segments.json, network is served without segment geometry")
	} else {
		networkData.Segments = segments
	}

	return networkData, nil
}

func readRequiredJSON(dir, name string, target interface{}) error {
	byteValue, err := embeddedNetworks.ReadFile(path.Join(dir, name))
	if err != nil {
		return fmt.Errorf("reading %s: %w", name, err)
	}
	if err := json.Unmarshal(byteValue, target); err != nil {
		return fmt.Errorf("parsing %s: %w", name, err)
	}
	return nil
}

func readOptionalJSON(dir, name string, target interface{}) error {
	byteValue, err := embeddedNetworks.ReadFile(path.Join(dir, name))
	if err != nil {
		logger.Log.Info().Str("dir", dir).Str("file", name).Msg("Optional network file missing, using empty value")
		return nil
	}
	if err := json.Unmarshal(byteValue, target); err != nil {
		return fmt.Errorf("parsing %s: %w", name, err)
	}
	return nil
}

func ensureStationsMap(stationsMap map[string]string) map[string]string {
	if stationsMap == nil {
		return map[string]string{}
	}
	return stationsMap
}

// SegmentsPath is the on disk location of a network's segment geometry,
// relative to the backend root. The risk model is a separate Python process and
// therefore cannot read the embedded copy.
func SegmentsPath(networkID string) string {
	return path.Join("data", "networks", networkID, "segments.json")
}

// GetNetworks returns the metadata of every served network, ordered by id.
func GetNetworks() []utils.Network {
	dataLock.RLock()
	defer dataLock.RUnlock()

	result := make([]utils.Network, 0, len(networkIds))
	for _, id := range networkIds {
		result = append(result, networks[id].Network)
	}
	return result
}

// GetNetwork returns the metadata of a single network.
func GetNetwork(networkID string) (utils.Network, bool) {
	dataLock.RLock()
	defer dataLock.RUnlock()

	networkData, ok := networks[networkID]
	if !ok {
		return utils.Network{}, false
	}
	return networkData.Network, true
}

func HasNetwork(networkID string) bool {
	dataLock.RLock()
	defer dataLock.RUnlock()

	_, ok := networks[networkID]
	return ok
}

func GetSegments(networkID string) ([]byte, bool) {
	dataLock.RLock()
	defer dataLock.RUnlock()

	networkData, ok := networks[networkID]
	if !ok {
		return nil, false
	}
	return networkData.Segments, true
}

func GetLinesList(networkID string) (map[string][]string, bool) {
	dataLock.RLock()
	defer dataLock.RUnlock()

	networkData, ok := networks[networkID]
	if !ok {
		return nil, false
	}
	return networkData.LinesList, true
}

func GetStationsList(networkID string) (map[string]utils.StationListEntry, bool) {
	dataLock.RLock()
	defer dataLock.RUnlock()

	networkData, ok := networks[networkID]
	if !ok {
		return nil, false
	}
	return networkData.StationsList, true
}

func GetLineMetadata(networkID string) (map[string]utils.LineMetadataEntry, bool) {
	dataLock.RLock()
	defer dataLock.RUnlock()

	networkData, ok := networks[networkID]
	if !ok {
		return nil, false
	}
	return networkData.LineMetadata, true
}

// GetStationsMap maps the freifahren station id to the engine station id.
func GetStationsMap(networkID string) (map[string]string, bool) {
	dataLock.RLock()
	defer dataLock.RUnlock()

	networkData, ok := networks[networkID]
	if !ok {
		return nil, false
	}
	return networkData.StationsMap, true
}
