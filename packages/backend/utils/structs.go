package utils

import (
	"database/sql"
	"time"
)

type Station struct {
	Id          string      `json:"id"`
	Name        string      `json:"name"`
	Coordinates Coordinates `json:"coordinates"`
	Lines       []string    `json:"lines"`
}

type Coordinates struct {
	Latitude  float64 `json:"latitude"`
	Longitude float64 `json:"longitude"`
}

// Network describes one self contained transit system. Center and bounds are
// what a client positions and constrains its map with, so that no client has to
// hardcode the geography of a city.
//
// Serves lists the other cities the network reaches, generated from the stations
// it was built with. A network is named after one city and often serves a dozen:
// the Rhine-Ruhr network is filed under duesseldorf and stops in Dortmund, Essen
// and Duisburg, which nobody scrolling a list of cities would guess. It is never
// null, so a client can filter on it without a nil check.
type Network struct {
	ID          string        `json:"id"`
	Name        string        `json:"name"`
	CountryCode string        `json:"countryCode"`
	Timezone    string        `json:"timezone"`
	Center      Coordinates   `json:"center"`
	Bounds      NetworkBounds `json:"bounds"`
	Status      NetworkStatus `json:"status"`
	Serves      []string      `json:"serves"`
}

type NetworkBounds struct {
	SouthWest Coordinates `json:"southWest"`
	NorthEast Coordinates `json:"northEast"`
}

type NetworkStatus string

const (
	NetworkStatusActive NetworkStatus = "active"
	// A beta network has no history worth reasoning from, so it is served
	// without historic or predicted reports.
	NetworkStatusBeta NetworkStatus = "beta"
)

// LineMetadataEntry carries the colour, mode and shape of a line, so that no client
// has to infer any of them from the line name.
//
// IsCircular has no omitempty: a client distinguishes "not a ring" from "the server
// does not know", and Berlin's S41 is not the only ring line in Germany.
type LineMetadataEntry struct {
	Color      string `json:"color"`
	Mode       string `json:"mode"`
	IsCircular bool   `json:"isCircular"`
}

// LineModeUnknown is the mode of a line OpenStreetMap has no route relation for.
// It is the absence of an answer, not a kind of transport, so nothing may be
// derived from two lines sharing it.
const LineModeUnknown = "unknown"

// TicketInspector and TicketInspectorResponse are two different structs to avoid issues when sening null values to the frontend

// Is used to create a JSON reponse to the frontend
type TicketInspectorResponse struct {
	Timestamp  time.Time `json:"timestamp"`
	Station    Station   `json:"station"`
	Direction  Station   `json:"direction"`
	Line       string    `json:"line"` // String is used so that it can easily be handled by the frontend
	IsHistoric bool      `json:"isHistoric"`
	Message    string    `json:"message,omitempty"`
}

// Is used within the backend primarily to fetch from the database
type TicketInspector struct {
	Timestamp   time.Time      `json:"timestamp"`
	StationId   string         `json:"station_id"`
	Line        sql.NullString `json:"line"`         // NullString is used to handle NULL values from the database
	DirectionId sql.NullString `json:"direction_id"` // NullString is used to handle NULL values from the database
	IsHistoric  bool           `json:"isHistoric"`
	Author      sql.NullInt64  `json:"author"`  // NullInt64 is used to handle NULL BigInt values from the database
	Message     sql.NullString `json:"message"` // NullString is used to handle NULL Text values from the database
}

// Is used when posting a new inspector
type InspectorRequest struct {
	Timestamp   time.Time `json:"timestamp"`
	Line        string    `json:"line"`
	StationId   string    `json:"stationId"`
	DirectionId string    `json:"directionId"`
	Author      int64     `json:"author,omitempty"` // is always null or 98111116 (ASCII for "BOT") when getting data from the telegram bot
	Message     string    `json:"message,omitempty"`
}

// InsertPointers holds pointers to the fields necessary for inserting data into the database.
type InsertPointers struct {
	TimestampPtr   *time.Time
	AuthorPtr      *int64
	MessagePtr     *string
	LinePtr        *string
	StationIdPtr   *string
	DirectionIdPtr *string
}

// When sending the response of what was posted
type ResponseData struct {
	Timestamp time.Time `json:"timestamp"`
	Line      string    `json:"line"`
	Station   Station   `json:"station"`
	Direction Station   `json:"direction"`
	Author    int64     `json:"author,omitempty"`
	Message   string    `json:"message,omitempty"`
}

type StationListEntry struct {
	Name        string           `json:"name"`
	Coordinates CoordinatesEntry `json:"coordinates"`
	Lines       []string         `json:"lines"`
}

type CoordinatesEntry struct {
	Latitude  float64 `json:"latitude"`
	Longitude float64 `json:"longitude"`
}

type GeoJSONCRS struct {
	Type       string                 `json:"type"`
	Properties map[string]interface{} `json:"properties"`
}

// SegmentProperties documents what a segment carries. Nothing decodes through it, `/lines/segments`
// serves the generated bytes as they are, so this type exists for the Swagger definition alone. It
// listed a `line` that no segments.json has ever had, Berlin's included: the line is already the
// part of `sid` before the dot, as in `S1.S-30:S-BLEN`.
type SegmentProperties struct {
	Sid       string `json:"sid"`
	LineColor string `json:"line_color"`
}

type SegmentGeometry struct {
	Type        string      `json:"type"`
	Coordinates [][]float64 `json:"coordinates"`
}

type SegmentFeature struct {
	Type       string            `json:"type"`
	Properties SegmentProperties `json:"properties"`
	Geometry   SegmentGeometry   `json:"geometry"`
}

type SegmentsCollection struct {
	Type     string           `json:"type"`
	Name     string           `json:"name"`
	CRS      GeoJSONCRS       `json:"crs"`
	Features []SegmentFeature `json:"features"`
}
