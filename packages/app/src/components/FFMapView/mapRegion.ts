import { Network } from '../../api/client'

/**
 * A network never fills more detail than this, no matter how large its area is: the deepest zoom is a
 * property of the data we draw (stations and line segments), not of how big the city happens to be.
 */
const MAX_ZOOM_LEVEL = 13

/** MapLibre tiles are 512 px wide and cover the whole world at zoom 0. */
const TILE_SIZE = 512

type Viewport = { width: number; height: number }

/**
 * Latitude degrees shrink towards the poles on a Mercator map, so a bounding box is compared in
 * projected units rather than in raw degrees.
 */
const mercatorY = (latitude: number) => {
    const clamped = Math.max(Math.min(latitude, 85), -85)
    const radians = (clamped * Math.PI) / 180

    return (180 / Math.PI) * Math.log(Math.tan(Math.PI / 4 + radians / 2))
}

export type MapRegion = {
    center: [number, number]
    bounds: { ne: [number, number]; sw: [number, number] }
    minZoomLevel: number
    maxZoomLevel: number
    defaultZoomLevel: number
}

/**
 * Positions and constrains the map from the network itself. The lower zoom bound is the point where
 * the whole network still fits on screen: further out only adds empty map, and the bounds already
 * stop the user from panning away.
 */
export const getMapRegion = (network: Network, viewport: Viewport): MapRegion => {
    const { southWest, northEast } = network.bounds

    const spanX = Math.max(northEast.longitude - southWest.longitude, Number.EPSILON)
    const spanY = Math.max(mercatorY(northEast.latitude) - mercatorY(southWest.latitude), Number.EPSILON)

    const zoomToFit = (span: number, pixels: number) => Math.log2((360 * pixels) / (TILE_SIZE * span))
    // A network small enough to fit on screen past the detail limit would otherwise get a lower bound
    // above its upper one, which leaves the camera with no zoom range at all.
    const minZoomLevel = Math.min(zoomToFit(spanX, viewport.width), zoomToFit(spanY, viewport.height), MAX_ZOOM_LEVEL)

    return {
        center: [network.center.longitude, network.center.latitude],
        bounds: {
            ne: [northEast.longitude, northEast.latitude],
            sw: [southWest.longitude, southWest.latitude],
        },
        minZoomLevel,
        maxZoomLevel: MAX_ZOOM_LEVEL,
        // Two levels in from the full network is roughly the built up core, which is what people open
        // the app for. Never past the detail limit, in case a network is small enough to reach it.
        defaultZoomLevel: Math.min(minZoomLevel + 2, MAX_ZOOM_LEVEL),
    }
}
