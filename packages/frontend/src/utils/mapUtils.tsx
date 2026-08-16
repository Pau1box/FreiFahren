import { lineModeOf, lineModeRank } from './lineModes'
import { LineMetadataList, NetworkBounds, StationProperty } from './types'

export const deg2rad = (deg: number): number => deg * (Math.PI / 180)
/**
 * Calculates the distance between two geographical points using the Haversine formula.
 *
 * @param {number} lat1 - The latitude of the first point in decimal degrees.
 * @param {number} lon1 - The longitude of the first point in decimal degrees.
 * @param {number} lat2 - The latitude of the second point in decimal degrees.
 * @param {number} lon2 - The longitude of the second point in decimal degrees.
 * @returns {number} The distance between the two points in kilometers.
 */
export const calculateDistance = (lat1: number, lon1: number, lat2: number, lon2: number) => {
    const R = 6371 // Radius of the earth in km
    const dLat = deg2rad(lat2 - lat1)
    const dLon = deg2rad(lon2 - lon1)
    const a =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(deg2rad(lat1)) * Math.cos(deg2rad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2)
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
    const distance = R * c // Distance in km

    return distance
}

/**
 * Subscribes to user's geolocation changes and executes callback functions based on the result.
 * @param {Function} onPositionChanged Callback that handles position data.
 * @param {Function} openAskForLocation Callback that handles failures in obtaining geolocation.
 * @param {Object} options Configuration options for geolocation. Default values are:
 * {
 *    enableHighAccuracy: true,
 *    timeout: 15 seconds,
 *    maximumAge: 15 seconds
 * }
 * @param {number} distanceThreshold The distance in meters that the user has to move before the location is updated.
 * @returns {Function} Unsubscribe function to stop watching position.
 */
export const watchPosition = async (
    onPositionChanged: (position: { lng: number; lat: number } | null) => void,
    options: object = {
        enableHighAccuracy: true,
        timeout: 10 * 1000,
        maximumAge: 15 * 1000,
    },
    distanceThreshold: number = 50
): Promise<() => void> => {
    let lastPosition: { lng: number; lat: number } | null = null
    const watchId = navigator.geolocation.watchPosition(
        (position) => {
            const newPosition = {
                lng: position.coords.longitude,
                lat: position.coords.latitude,
            }

            if (lastPosition) {
                const distance =
                    calculateDistance(lastPosition.lat, lastPosition.lng, newPosition.lat, newPosition.lng) * 1000 // Convert km to meters

                if (distance >= distanceThreshold) {
                    onPositionChanged(newPosition)
                    lastPosition = newPosition
                }
            } else {
                // First position update
                onPositionChanged(newPosition)
                lastPosition = newPosition
            }
        },
        () => {
            onPositionChanged(null)
        },
        options
    )

    return () => navigator.geolocation.clearWatch(watchId)
}

export const isPositionInBounds = (position: { lng: number; lat: number }, bounds: NetworkBounds): boolean =>
    position.lat >= bounds.southWest.latitude &&
    position.lat <= bounds.northEast.latitude &&
    position.lng >= bounds.southWest.longitude &&
    position.lng <= bounds.northEast.longitude

/**
 * Berlin's hand tuned levels (min 10, initial 11, max 14) for a network roughly 80 km across.
 * Keeping that ratio lets a small tram network start close enough to read its stops instead of
 * showing a mostly empty region.
 */
const ZOOM_REFERENCE_EXTENT_KM = 80
const ZOOM_REFERENCE_MIN = 10
const KM_PER_DEGREE = 111.32

const boundsExtentInKm = (bounds: NetworkBounds): number => {
    const latitudeSpan = (bounds.northEast.latitude - bounds.southWest.latitude) * KM_PER_DEGREE
    const centerLatitude = (bounds.northEast.latitude + bounds.southWest.latitude) / 2
    const longitudeSpan =
        (bounds.northEast.longitude - bounds.southWest.longitude) * KM_PER_DEGREE * Math.cos(deg2rad(centerLatitude))

    return Math.max(latitudeSpan, longitudeSpan)
}

export const getNetworkZoomLevels = (bounds: NetworkBounds): { minZoom: number; initialZoom: number; maxZoom: number } => {
    const extent = boundsExtentInKm(bounds)
    // Halving the extent is one zoom level, so the offset from the reference is a plain log2 ratio.
    const minZoom =
        extent > 0
            ? Math.min(14, Math.max(8, ZOOM_REFERENCE_MIN + Math.log2(ZOOM_REFERENCE_EXTENT_KM / extent)))
            : ZOOM_REFERENCE_MIN

    return { minZoom, initialZoom: minZoom + 1, maxZoom: minZoom + 4 }
}

/**
 * The mode a station is labelled with: the most prominent one among the lines that serve it, so an
 * interchange of an underground and a tram gets the underground icon.
 */
const dominantMode = (lines: string[], lineMetadata: LineMetadataList): string => {
    const modes = lines.map((line) => lineModeOf(lineMetadata, line)).filter((mode) => mode !== undefined)

    if (modes.length === 0) return 'unknown'

    return modes.reduce((mostProminent, mode) => (lineModeRank(mode) < lineModeRank(mostProminent) ? mode : mostProminent))
}

export const convertStationsToGeoJSON = (
    stationsData: { [key: string]: StationProperty },
    lineMetadata: LineMetadataList
) => ({
    type: 'FeatureCollection',
    features: Object.keys(stationsData).map((key) => ({
        type: 'Feature',
        properties: {
            name: stationsData[key].name,
            lines: stationsData[key].lines,
            mode: dominantMode(stationsData[key].lines, lineMetadata),
            // Label priority is derived from this rather than from a list of names, see StationLayer.
            lineCount: stationsData[key].lines.length,
        },
        geometry: {
            type: 'Point',
            coordinates: [stationsData[key].coordinates.longitude, stationsData[key].coordinates.latitude],
        },
    })),
})
