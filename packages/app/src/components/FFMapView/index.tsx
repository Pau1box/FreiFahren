import MapLibreGL, { Camera, CameraRef, MapView, UserLocation, UserTrackingMode } from '@maplibre/maplibre-react-native'
import { isNil } from 'lodash'
import { useEffect, useMemo, useRef } from 'react'
import { StyleSheet, useWindowDimensions } from 'react-native'
import DeviceInfo from 'react-native-device-info'

import { Report, useReports } from '../../api'
import { useLines, useRiskData, useSegments, useStations } from '../../api/queries'
import { useAppStore } from '../../app.store'
import { config } from '../../config'
import { useActiveNetwork } from '../../networks'
import { track } from '../../tracking'
import { FFView } from '../common/base'
import { LinesLayer } from './LinesLayer'
import { getMapRegion } from './mapRegion'
import { ReportsLayer } from './ReportsLayer'
import { RiskLayer } from './RiskLayer'
import { StationLayer } from './StationLayer'

// eslint-disable-next-line @typescript-eslint/no-floating-promises
MapLibreGL.setAccessToken(null)

const styles = StyleSheet.create({
    map: {
        flex: 1,
        alignSelf: 'stretch',
    },
})

// Workaround: Because Maplibre native does not have zIndex and layers are rendered
// in order of their creation. Thus, we need to force the order they are mounted
// independendly of the order the data loads in.
const useLayersToRender = () => {
    const { data: lines } = useLines()
    const { data: segments } = useSegments()
    const { data: riskData } = useRiskData()
    const { data: stations } = useStations()
    const { data: reports } = useReports()

    const hasLines = lines !== undefined
    const hasSegments = segments !== undefined
    const hasRiskData = riskData !== undefined
    const hasStations = stations !== undefined
    const hasReports = reports !== undefined

    /*
     Only what a layer actually draws may gate it. The risk layer is the sole consumer of the risk
     query, so a failing risk model must not take the reports, the stations or the user marker down
     with it. The ordering constraint is why every layer still waits for the ones drawn beneath it.
    */
    return {
        lines: hasLines,
        risk: hasLines && hasSegments && hasRiskData,
        stations: hasLines && hasSegments && hasStations,
        reports: hasLines && hasSegments && hasStations && hasReports,
        userLocation: hasLines && hasSegments && hasStations && hasReports,
    }
}

export const FFMapView = () => {
    const cameraRef = useRef<CameraRef>(null)
    const stations = useStations().data
    const { data: reports = [] } = useReports()

    const network = useActiveNetwork()
    const viewport = useWindowDimensions()
    const region = useMemo(
        () => (network === undefined ? undefined : getMapRegion(network, viewport)),
        [network, viewport]
    )

    const { layer, reportToShow, update: updateAppState } = useAppStore()

    const layersToRender = useLayersToRender()

    // Switching networks leaves the camera over the previous city, which the bounds alone do not fix.
    useEffect(() => {
        if (region === undefined) return

        cameraRef.current?.setCamera({
            centerCoordinate: region.center,
            zoomLevel: region.defaultZoomLevel,
            animationDuration: 700,
            animationMode: 'easeTo',
        })
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [network?.id])

    useEffect(() => {
        if (!isNil(reportToShow) && stations !== undefined) {
            const station = stations[reportToShow.stationId]

            if (station === undefined) {
                track({
                    name: 'Missing Station',
                    stationId: reportToShow.stationId,
                    version: DeviceInfo.getVersion(),
                    location: 'FFMapView',
                    exampleKnownStationId: Object.keys(stations)[0],
                })

                return
            }

            const { latitude, longitude } = station.coordinates

            cameraRef.current?.setCamera({
                centerCoordinate: [longitude, latitude],
                zoomLevel: 13,
                animationDuration: 700,
                animationMode: 'easeTo',
            })
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [reportToShow, stations === undefined])

    const onPressReport = (report: Report) => {
        track({ name: 'Report Tapped', station: report.stationId })
        updateAppState({ reportToShow: report })
    }

    // The camera takes its initial position once, at mount, so the map waits for the network.
    if (region === undefined) return null

    return (
        <FFView width="100%" height="100%">
            <MapView
                style={styles.map}
                logoEnabled={false}
                styleURL={config.MAP_STYLE_URL}
                compassEnabled={false}
                attributionEnabled={false}
                rotateEnabled={false}
            >
                <Camera
                    defaultSettings={{
                        centerCoordinate: region.center,
                        zoomLevel: region.defaultZoomLevel,
                    }}
                    maxBounds={region.bounds}
                    minZoomLevel={region.minZoomLevel}
                    maxZoomLevel={region.maxZoomLevel}
                    followUserMode={UserTrackingMode.Follow}
                    ref={cameraRef}
                />
                {layersToRender.lines && <LinesLayer />}
                {layersToRender.risk && <RiskLayer visible={layer === 'risk'} />}
                {layersToRender.stations && <StationLayer minZoom={region.minZoomLevel} />}
                {layersToRender.reports && <ReportsLayer reports={reports} onPressReport={onPressReport} />}
                {layersToRender.userLocation && <UserLocation visible animated />}
            </MapView>
        </FFView>
    )
}
