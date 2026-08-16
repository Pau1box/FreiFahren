import 'maplibre-gl/dist/maplibre-gl.css'
import './Map.css'

import React, { lazy, Suspense, useCallback, useEffect, useMemo, useRef } from 'react'
import { LngLatBoundsLike, MapLayerMouseEvent, MapRef, ViewStateChangeEvent } from 'react-map-gl/maplibre'
import { useLineMetadata, useRiskData, useSegments, useStations } from 'src/api/queries'

import { useLocation } from '../../contexts/LocationContext'
import { useNetwork } from '../../contexts/NetworkContext'
import { sendAnalyticsEvent } from '../../hooks/useAnalytics'
import { convertStationsToGeoJSON, getNetworkZoomLevels } from '../../utils/mapUtils'
import { StationProperty } from '../../utils/types'
import { RegularLineLayer } from './MapLayers/LineLayer/RegularLineLayer'
import { RiskLineLayer } from './MapLayers/LineLayer/RiskLineLayer'
import { StationLayer } from './MapLayers/StationLayer/StationLayer'
import { LocationMarker } from './Markers/Classes/LocationMarker/LocationMarker'
import { MarkerContainer } from './Markers/MarkerContainer'

const Map = lazy(() => import('react-map-gl/maplibre'))

interface FreifahrenMapProps {
    isFirstOpen: boolean
    isRiskLayerOpen: boolean
    onRotationChange: (bearing: number) => void
    handleStationClick?: (station: StationProperty) => void
}
const GITHUB_ICON = `/icons/github.svg`
const INSTAGRAM_ICON = `/icons/instagram.svg`

const FreifahrenMap: React.FC<FreifahrenMapProps> = ({
    isFirstOpen,
    isRiskLayerOpen,
    onRotationChange,
    handleStationClick,
}) => {
    const { network } = useNetwork()

    const maxBounds: LngLatBoundsLike | undefined = useMemo(() => {
        if (network === null) return undefined

        return [
            { lng: network.bounds.southWest.longitude, lat: network.bounds.southWest.latitude },
            { lng: network.bounds.northEast.longitude, lat: network.bounds.northEast.latitude },
        ]
    }, [network])

    // A tram network a few kilometres across needs to start closer than a city wide rail network.
    const zoomLevels = useMemo(
        () => (network === null ? null : getNetworkZoomLevels(network.bounds)),
        [network]
    )

    const { data: lineSegments = null } = useSegments()

    const map = useRef<MapRef>(null)
    const clickTimer = useRef<number | null>(null)
    const { data: stations } = useStations()
    const { data: lineMetadata } = useLineMetadata()
    const stationGeoJSON = useMemo(
        () => convertStationsToGeoJSON(stations ?? {}, lineMetadata ?? {}),
        [stations, lineMetadata]
    )

    const { userPosition, initializeLocationTracking } = useLocation()

    useEffect(() => {
        if (!isFirstOpen) {
            initializeLocationTracking()
        }
    }, [isFirstOpen, initializeLocationTracking])

    // Follow a network switch: the map is still showing the previous city until it is told otherwise.
    useEffect(() => {
        if (network === null || zoomLevels === null) return

        map.current?.easeTo({
            center: { lng: network.center.longitude, lat: network.center.latitude },
            zoom: zoomLevels.initialZoom,
        })
    }, [network, zoomLevels])

    const { data: segmentRiskData } = useRiskData()

    const handleRotate = useCallback(
        (event: ViewStateChangeEvent) => {
            onRotationChange(event.viewState.bearing)
        },
        [onRotationChange]
    )

    const onSingleClick = (event: MapLayerMouseEvent) => {
        const currentMap = map.current
        if (!currentMap) return

        const targetElement = event.originalEvent.target
        if (targetElement instanceof HTMLElement) {
            if (
                targetElement.classList.contains('inspector-marker') ||
                (targetElement.parentElement?.classList.contains('inspector-marker') ?? false)
            ) {
                return
            }
        }

        const features = currentMap.queryRenderedFeatures(event.point, {
            layers: ['stationLayer', 'stationNameLayer'],
        })

        if (features.length > 0 && handleStationClick) {
            const [feature] = features
            const { properties } = feature

            if (typeof properties.name === 'string' && feature.geometry.type === 'Point') {
                let parsedLines: unknown
                try {
                    parsedLines = JSON.parse(properties.lines ?? '[]')
                } catch (error) {
                    parsedLines = []
                }
                const lines =
                    Array.isArray(parsedLines) && parsedLines.every((item) => typeof item === 'string')
                        ? (parsedLines as string[])
                        : []

                const station: StationProperty = {
                    name: properties.name,
                    lines,
                    coordinates: {
                        longitude: (feature.geometry.coordinates as [number, number])[0],
                        latitude: (feature.geometry.coordinates as [number, number])[1],
                    },
                }

                handleStationClick(station)
                sendAnalyticsEvent('InfoModal opened', { meta: { source: 'map', station_name: station.name } })
            }
        }
    }

    const handleMapClick = useCallback(
        (event: MapLayerMouseEvent) => {
            if (clickTimer.current) {
                clearTimeout(clickTimer.current)
                clickTimer.current = null
            }
            clickTimer.current = window.setTimeout(() => {
                onSingleClick(event)
            }, 200)
        },
        [handleStationClick] // eslint-disable-line react-hooks/exhaustive-deps
    )

    const handleMapDoubleClick = useCallback(() => {
        if (clickTimer.current) {
            clearTimeout(clickTimer.current)
            clickTimer.current = null
        }
    }, [])

    return (
        <div id="map-container" data-testid="map-container">
            {/* The map is positioned from the active network, so it waits for that network to be known. */}
            {network !== null && zoomLevels !== null ? (
                <Suspense fallback={<div>Loading...</div>}>
                    <Map
                        reuseMaps
                        data-testid="map"
                        ref={map}
                        id="map"
                        initialViewState={{
                            longitude: network.center.longitude,
                            latitude: network.center.latitude,
                            zoom: zoomLevels.initialZoom,
                        }}
                        maxZoom={zoomLevels.maxZoom}
                        minZoom={zoomLevels.minZoom}
                        maxBounds={maxBounds}
                        onRotate={handleRotate}
                        onClick={handleMapClick}
                        onDblClick={handleMapDoubleClick}
                        mapStyle={`https://api.jawg.io/styles/c52af8db-49f6-40b8-9197-568b7fd9a940.json?access-token=${
                            import.meta.env.VITE_JAWG_ACCESS_TOKEN
                        }`}
                    >
                        {!isFirstOpen ? <LocationMarker userPosition={userPosition} /> : null}
                        <MarkerContainer isFirstOpen={isFirstOpen} userPosition={userPosition} />
                        <StationLayer stations={stationGeoJSON} minZoom={zoomLevels.minZoom} />
                        <RegularLineLayer
                            lineSegments={lineSegments}
                            isRiskLayerOpen={isRiskLayerOpen}
                            minZoom={zoomLevels.minZoom}
                        />
                        {isRiskLayerOpen ? (
                            <RiskLineLayer preloadedRiskData={segmentRiskData} lineSegments={lineSegments} />
                        ) : null}
                    </Map>
                </Suspense>
            ) : null}
            <div className="fixed bottom-0 left-1.5 flex items-center gap-1 rounded px-1.5 py-0.5">
                <a href="https://github.com/FreiFahren/FreiFahren" target="_blank" rel="noopener noreferrer">
                    <img src={GITHUB_ICON} alt="GitHub" className="h-4 w-4 hover:underline" />
                </a>
                <a href="https://www.instagram.com/frei.fahren/" target="_blank" rel="noopener noreferrer">
                    <img src={INSTAGRAM_ICON} alt="Instagram" className="h-4 w-4 hover:underline" />
                </a>
            </div>
            <div
                className="fixed bottom-0 right-1.5 rounded px-1.5 py-0.5 text-gray-500 hover:underline"
                style={{ fontSize: 'var(--font-xxxs)' }}
            >
                <a
                    href="https://www.jawg.io/"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="no-underline hover:underline"
                >
                    © JawgMaps
                </a>{' '}
                |
                <a
                    href="https://www.openstreetmap.org/copyright"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="no-underline hover:underline"
                >
                    © OSM contributors
                </a>
            </div>
        </div>
    )
}

export { FreifahrenMap }
