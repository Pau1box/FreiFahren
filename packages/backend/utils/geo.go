package utils

import "math"

// earthRadiusKm is the mean radius. Every distance here is between two points of the same city, so
// the error of a spherical earth is far below the precision anything upstream needs.
const earthRadiusKm = 6371

func toRadians(degrees float64) float64 {
	return degrees * math.Pi / 180
}

// DistanceKm returns the great circle distance between two coordinates in kilometres.
//
// It lives in utils rather than next to one of its callers because two unrelated API packages need
// it: the distance endpoint measures how far a report is from the user, and the itinerary handler
// matches an engine stop to one of our stations by position.
func DistanceKm(firstLat, firstLon, secondLat, secondLon float64) float64 {
	deltaLat := toRadians(secondLat - firstLat)
	deltaLon := toRadians(secondLon - firstLon)

	a := math.Sin(deltaLat/2)*math.Sin(deltaLat/2) +
		math.Cos(toRadians(firstLat))*
			math.Cos(toRadians(secondLat))*
			math.Sin(deltaLon/2)*
			math.Sin(deltaLon/2)

	return earthRadiusKm * 2 * math.Atan2(math.Sqrt(a), math.Sqrt(1-a))
}
