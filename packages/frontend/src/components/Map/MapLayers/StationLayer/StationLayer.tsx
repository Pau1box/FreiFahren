import { ExpressionSpecification } from 'maplibre-gl'
import React, { useEffect, useMemo } from 'react'
import { Layer, MapRef, Source, useMap } from 'react-map-gl/maplibre'

import { StationGeoJSON } from '../../../../utils/types'

const UBAHN_ICON = `/icons/ubahn.svg`
const SBAHN_ICON = `/icons/sbahn.svg`

interface StationLayerProps {
    stations: StationGeoJSON
    /* The network's own lowest zoom, because the label steps below are offsets from it. */
    minZoom: number
}

/*
 Zoom offsets from the network's minimum zoom, at which more labels and icons appear. They were
 tuned against Berlin, whose minimum zoom is the reference value 10, so the absolute levels that
 used to stand here are these offsets applied to it. A small network starts at a much closer zoom,
 where the absolute levels would have shown every label from the first frame.
*/
const LABEL_STEP = { secondary: 1.5, rest: 3 }
// The deepest zoom a network allows is its minimum plus four, so a fade out beyond that never runs.
const ICON_STEP = { secondary: 2, rest: 3, fadeOut: 4 }
class IconFactory {
    constructor(private map: MapRef | undefined) {}

    createImage(name: string, source: string) {
        const image = new Image(12, 12)

        image.src = source
        image.onload = () => {
            if (!(this.map?.hasImage(name) ?? false)) {
                this.map?.addImage(name, image)
            }
        }
    }
}

const quantile = (sortedValues: number[], probability: number): number =>
    sortedValues.length === 0 ? 0 : sortedValues[Math.floor(probability * (sortedValues.length - 1))]

/**
 * How many lines a station has to serve to be labelled early. A station's importance is in the data,
 * not in its name: the more lines meet there, the more people change trains there, which is why the
 * number of lines is the proxy. The thresholds come from the network's own distribution, so a small
 * tram network still highlights its busiest stops instead of highlighting none.
 */
const labelThresholds = (stations: StationGeoJSON): { primary: number; secondary: number } => {
    const lineCounts = stations.features.map((feature) => feature.properties.lineCount).sort((a, b) => a - b)

    return {
        primary: Math.max(2, quantile(lineCounts, 0.95)),
        secondary: Math.max(2, quantile(lineCounts, 0.8)),
    }
}

const StationLayer: React.FC<StationLayerProps> = ({ stations, minZoom }) => {
    const map = useMap()

    useEffect(() => {
        const currentMap = map.current
        const iconFactory = new IconFactory(currentMap)

        iconFactory.createImage('ubahn-icon', UBAHN_ICON)
        iconFactory.createImage('sbahn-icon', SBAHN_ICON)

        return () => {
            if (currentMap && currentMap.hasImage('ubahn-icon') && currentMap.hasImage('sbahn-icon')) {
                currentMap.removeImage('ubahn-icon')
                currentMap.removeImage('sbahn-icon')
            }
        }
    }, [map])

    const { primary, secondary } = useMemo(() => labelThresholds(stations), [stations])

    const isPrimaryStation: ExpressionSpecification = ['case', ['>=', ['get', 'lineCount'], primary], 1, 0]
    const isSecondaryStation: ExpressionSpecification = ['case', ['>=', ['get', 'lineCount'], secondary], 1, 0]

    return (
        <Source id="stationSource" type="geojson" data={stations}>
            <Layer
                id="stationLayer"
                type="circle"
                paint={{
                    'circle-radius': 2,
                    'circle-color': '#ffffff',
                    'circle-stroke-width': 1,
                    'circle-stroke-color': '#000000',
                }}
            />
            <Layer
                id="stationNameLayer"
                type="symbol"
                layout={{
                    'text-field': ['get', 'name'],
                    'text-size': 12,
                    'text-allow-overlap': true,
                    /*
                     The icon follows the station's mode rather than its line names. An empty string
                     leaves a station without an icon, which is what a tram stop or an unclassified
                     line should get instead of a borrowed one.
                    */
                    'icon-image': [
                        'match',
                        ['get', 'mode'],
                        'subway',
                        'ubahn-icon',
                        'light_rail',
                        'sbahn-icon',
                        'train',
                        'sbahn-icon',
                        '',
                    ],
                    'icon-anchor': 'bottom',
                    'text-offset': [0, 1],
                }}
                paint={{
                    'text-color': '#fff',
                    'text-halo-color': 'black',
                    'text-halo-width': 0.2,
                    'text-opacity': [
                        'step',
                        ['zoom'],
                        isPrimaryStation,
                        minZoom + LABEL_STEP.secondary,
                        isSecondaryStation,
                        minZoom + LABEL_STEP.rest,
                        1,
                    ],
                    'icon-opacity': [
                        'step',
                        ['zoom'],
                        isPrimaryStation,
                        minZoom + ICON_STEP.secondary,
                        isSecondaryStation,
                        minZoom + ICON_STEP.rest,
                        1,
                        minZoom + ICON_STEP.fadeOut,
                        0,
                    ],
                }}
            />
        </Source>
    )
}

export { StationLayer }
