import { CircleLayer, ShapeSource, SymbolLayer } from '@maplibre/maplibre-react-native'
import { useTheme } from '@shopify/restyle'
import { useMemo } from 'react'
import DeviceInfo from 'react-native-device-info'

import { useStations } from '../../api/queries'
import { Theme } from '../../theme'
import { track } from '../../tracking'
import { filterNullish } from '../../utils'

/**
 * How many lines call at a station stands in for how important it is. Interchanges are what people
 * orient themselves by, and unlike a list of famous names it holds in every city the backend serves.
 */
const useStationsAsGeoJSON = () => {
    const { data: stations } = useStations()

    if (!stations) return null

    return {
        type: 'FeatureCollection',
        features: Object.keys(stations)
            .map((key) => {
                const station = stations[key]

                if (station === undefined) {
                    track({
                        name: 'Missing Station',
                        stationId: key,
                        version: DeviceInfo.getVersion(),
                        location: 'useStationsAsGeoJSON',
                        exampleKnownStationId: Object.keys(stations)[0],
                    })

                    return null
                }

                return {
                    type: 'Feature',
                    properties: {
                        name: station.name,
                        lines: station.lines,
                        lineCount: station.lines.length,
                    },
                    geometry: {
                        type: 'Point',
                        coordinates: [station.coordinates.longitude, station.coordinates.latitude],
                    },
                }
            })
            .filter(filterNullish),
    }
}

/**
 * Two label tiers, taken as quantiles of how many lines the network's stations serve. A fixed count
 * would show everything in a city where four lines meet everywhere and nothing in a city with two.
 */
const useLabelThresholds = () => {
    const { data: stations } = useStations()

    return useMemo(() => {
        const lineCounts = Object.values(stations ?? {})
            .map((station) => station?.lines.length ?? 0)
            .sort((a, b) => a - b)

        if (lineCounts.length === 0) return { major: 2, secondary: 2 }

        const quantile = (share: number) => lineCounts[Math.floor((lineCounts.length - 1) * share)]

        /*
         A network where almost every stop serves a single line has a quantile of 1, which would make
         every station major and stack all labels on top of each other from the first frame. Below two
         lines a station is not an interchange, so two is the floor.
        */
        return { major: Math.max(2, quantile(0.95)), secondary: Math.max(2, quantile(0.75)) }
    }, [stations])
}

/*
 Zoom offsets from the network's own lowest zoom, at which more labels appear. They were tuned
 against Berlin, so the absolute levels that used to stand here are these offsets applied to it. A
 small network starts at a much closer zoom, where the absolute levels showed every label at once.
*/
const LABEL_STEP = { secondary: 1.5, rest: 3 }

type StationLayerProps = {
    /** The network's own lowest zoom, because the label steps above are offsets from it. */
    minZoom: number
}

export const StationLayer = ({ minZoom }: StationLayerProps) => {
    const stationsGeoJSON = useStationsAsGeoJSON()
    const { major, secondary } = useLabelThresholds()
    const theme = useTheme<Theme>()

    if (!stationsGeoJSON) return null

    return (
        <ShapeSource id="stationSource" shape={stationsGeoJSON as GeoJSON.FeatureCollection}>
            <CircleLayer
                id="stationLayer"
                style={{
                    circleRadius: 2,
                    circleColor: '#ffffff',
                    circleStrokeWidth: 1,
                    circleStrokeColor: '#000000',
                }}
            />
            <SymbolLayer
                id="stationNameLayer"
                style={{
                    textField: ['get', 'name'],
                    textColor: theme.colors.fg,
                    textAnchor: 'bottom',
                    textSize: 12,
                    textOffset: [0, -0.8],
                    textHaloColor: '#000000',
                    textHaloWidth: 1,
                    textOpacity: [
                        'step',
                        ['zoom'],
                        ['case', ['>=', ['get', 'lineCount'], major], 1, 0],
                        minZoom + LABEL_STEP.secondary,
                        ['case', ['>=', ['get', 'lineCount'], secondary], 1, 0],
                        minZoom + LABEL_STEP.rest,
                        1,
                    ],
                }}
            />
        </ShapeSource>
    )
}
