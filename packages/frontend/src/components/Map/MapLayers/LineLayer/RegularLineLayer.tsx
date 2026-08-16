import React, { useMemo } from 'react'
import { Layer, Source } from 'react-map-gl/maplibre'
import { useLineMetadata } from 'src/api/queries'
import { modesInNetwork } from 'src/utils/lineModes'

interface RegularLineLayerProps {
    lineSegments: GeoJSON.FeatureCollection<GeoJSON.LineString> | null
    isRiskLayerOpen: boolean
    /* The network's own lowest zoom, because the label fade below is an offset from it. */
    minZoom: number
}

/*
 Zoom offsets from the network's minimum zoom, over which the remaining line labels fade in. They
 were tuned against Berlin, whose minimum zoom is the reference value 10, so the absolute levels
 that used to stand here are these offsets applied to it. A small network starts at a much closer
 zoom, where the absolute levels would have shown every label from the first frame.
*/
const LABEL_FADE = { start: 0, end: 2 }

const RegularLineLayer: React.FC<RegularLineLayerProps> = ({ lineSegments, isRiskLayerOpen, minZoom }) => {
    const { data: lineMetadata } = useLineMetadata()

    /*
     Labelling every line at low zoom is unreadable, so only the network's most prominent mode keeps
     its labels there. Which mode that is comes from the data: a city without an underground shows
     its light rail instead.
    */
    const firstPriorityLines = useMemo(() => {
        const metadata = lineMetadata ?? {}
        const modes = modesInNetwork(metadata)

        if (modes.length === 0) return []

        const [mostProminentMode] = modes

        return Object.entries(metadata)
            .filter(([, line]) => line.mode === mostProminentMode)
            .map(([lineName]) => lineName)
    }, [lineMetadata])

    const neutralColor = '#13C184'

    if (!lineSegments) return null
    return (
        <Source id="line-data" type="geojson" data={lineSegments}>
            <Layer
                id="line-layer"
                type="line"
                beforeId="stationLayer"
                source="line-data"
                layout={{
                    'line-join': 'round',
                    'line-cap': 'round',
                }}
                paint={{
                    'line-color': ['case', isRiskLayerOpen, neutralColor, ['get', 'line_color']],
                    'line-width': 3,
                }}
            />
            <Layer
                id="label-layer"
                type="symbol"
                beforeId="stationLayer"
                source="line-data"
                layout={{
                    'text-field': ['get', 'line'],
                    'text-size': 13,
                    'symbol-placement': 'line',
                    'text-anchor': 'top',
                    'text-offset': [0, 1.5],
                    'text-keep-upright': true,
                    'text-optional': true,
                }}
                paint={{
                    'text-color': '#fff',
                    'text-opacity': [
                        'interpolate',
                        ['linear'],
                        ['zoom'],
                        minZoom + LABEL_FADE.start,
                        ['case', ['in', ['get', 'line'], ['literal', firstPriorityLines]], 1, 0],
                        minZoom + LABEL_FADE.end,
                        1,
                    ],
                }}
            />
        </Source>
    )
}

export { RegularLineLayer }
