import { InferSelectModel } from 'drizzle-orm'

import { lines } from '../../db/schema/lines'
import { stations } from '../../db/schema/stations'

type StationRow = InferSelectModel<typeof stations>
type LineRow = InferSelectModel<typeof lines>

type StationId = StationRow['id']
type LineId = LineRow['id']

type Station = {
    name: StationRow['name']
    coordinates: { latitude: StationRow['lat']; longitude: StationRow['lng'] }
    lines: LineId[]
}

type Stations = Record<StationId, Station>
type Lines = Record<LineId, StationId[]>

/**
 * How a client renders a line, without knowing anything about the city it belongs to.
 *
 * `isCircular` matters because direction of travel means something different on a ring: naming a
 * terminus does not narrow down where a train is going.
 */
type LineMetadata = {
    color: LineRow['color']
    mode: LineRow['mode']
    isCircular: LineRow['isCircular']
}

type LinesMetadata = Record<LineId, LineMetadata>

export type { Lines, LineMetadata, LinesMetadata, Stations, StationId, LineId }
