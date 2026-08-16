"""
Routing over the track of one line, so that the geometry between two stations can be asked for.

Track downloaded from OpenStreetMap is not one tidy line. Ways are split at every junction and
every tagging change, a line's branches and its two directions are separate relations, and platform
ways come along as members of the route. What arrives is dozens to hundreds of disconnected
fragments, in no particular order.

Cutting a piece out of such a geometry does not work: "the distance along the line" is a position in
an arbitrary concatenation rather than a travel order, and picking the fragment that fits a pair of
stations best yields segments a few metres long between stations half a kilometre apart. Walking the
fragments as a graph gives the actual track, and picks the right prong of a fork for free, because
the shortest way from one station to the next is the way the train goes.

Everything here is in a metric CRS. `create_segments.py` reprojects before handing geometry over,
which is what lets the thresholds below be stated in metres.
"""

from __future__ import annotations

import heapq
from typing import Dict, Iterable, List, Optional, Sequence, Tuple, Union

from shapely.geometry import LineString, MultiLineString, Point

# How far a station may sit from the nearest piece of track before it counts as not being on the
# line at all. Platforms are tagged next to the rails rather than on them, and OSM puts a station
# node anywhere in the building, so a couple of hundred metres is normal.
MAX_STATION_OFFSET_METERS = 250.0

# How much further than the nearest one a piece of track may be and still count as the same place.
# A station at a junction lies on several fragments at once and needs all of them, but the radius
# has to stay far below the distance to the next station: with a generous absolute radius, two
# stations 250 metres apart each reach the other's track and the route between them collapses.
ANCHOR_SLACK_METERS = 25.0

# Two fragment ends within this distance are the same junction. OSM ways that meet share a node
# exactly, so this only absorbs the rounding of the reprojection into UTM.
NODE_TOLERANCE_METERS = 0.5

# Below this a piece of track is a rounding artefact rather than a piece of track.
MIN_PIECE_LENGTH_METERS = 1.0

Node = Tuple[int, int]
Edge = Tuple[Node, float, LineString]


def cut(line: LineString, distance: float) -> List[LineString]:
    """Cuts a line at a specified distance from its starting point."""
    if distance <= 0.0:
        return [LineString(), LineString(line)]
    elif distance >= line.length:
        return [LineString(line), LineString()]

    coords = list(line.coords)
    accumulated_distance = 0.0
    for i in range(len(coords) - 1):
        p1 = Point(coords[i])
        p2 = Point(coords[i + 1])
        seg_length = p1.distance(p2)
        accumulated_distance += seg_length
        if accumulated_distance == distance:
            return [LineString(coords[: i + 2]), LineString(coords[i + 1 :])]
        elif accumulated_distance > distance:
            ratio = (distance - (accumulated_distance - seg_length)) / seg_length
            x = coords[i][0] + ratio * (coords[i + 1][0] - coords[i][0])
            y = coords[i][1] + ratio * (coords[i + 1][1] - coords[i][1])
            cut_point = (x, y)
            return [
                LineString(coords[: i + 1] + [cut_point]),
                LineString([cut_point] + coords[i + 1 :]),
            ]
    return [LineString(line), LineString()]


def cut_line(line: LineString, start_distance: float, end_distance: float) -> LineString:
    """Returns the piece of a line between two distances along the line."""
    if start_distance >= end_distance:
        return LineString()
    first_cut = cut(line, start_distance)
    second_cut = cut(first_cut[1], end_distance - start_distance)
    return second_cut[0]


def iter_fragments(geometry: Union[LineString, MultiLineString]) -> List[LineString]:
    """The continuous pieces of a geometry, so one line and many are handled the same way."""
    if geometry.is_empty:
        return []
    if isinstance(geometry, LineString):
        return [geometry]
    if isinstance(geometry, MultiLineString):
        return [fragment for fragment in geometry.geoms if not fragment.is_empty]
    return []


def node_of(coordinate: Sequence[float]) -> Node:
    """The graph node a fragment end belongs to, snapped so that touching ends meet."""
    scale = 1.0 / NODE_TOLERANCE_METERS
    return (round(coordinate[0] * scale), round(coordinate[1] * scale))


def station_anchors(fragments: Sequence[LineString], point: Point) -> List[Tuple[int, float]]:
    """
    Where a station meets the track: every place within reach, as a fragment and a distance along it.

    Every fragment at that place rather than only the closest one, because a station sits at a
    junction as often as not, and the closest fragment there is whichever stub the platform happens
    to lean towards.

    A fragment can also pass the station more than once, since the two directions of a line are
    usually one continuous run of track out and back. `project` answers with a single position along
    the fragment, and if the two stations of a segment are matched to opposite directions, the route
    between them runs out to the terminus and back. The fragment is therefore clipped to a window
    around the station and each pass through that window becomes its own anchor.
    """
    offsets = [(index, point.distance(fragment)) for index, fragment in enumerate(fragments)]
    nearest = min((offset for _, offset in offsets), default=float("inf"))
    if nearest > MAX_STATION_OFFSET_METERS:
        return []

    reach = nearest + ANCHOR_SLACK_METERS
    window = point.buffer(reach)
    anchors: List[Tuple[int, float]] = []
    for index, offset in offsets:
        if offset > reach:
            continue
        fragment = fragments[index]
        passes = iter_fragments(fragment.intersection(window))
        if not passes:
            anchors.append((index, fragment.project(point)))
            continue
        for single_pass in passes:
            anchors.append((index, fragment.project(single_pass.interpolate(single_pass.project(point)))))
    return anchors


def split_fragment(
    fragment: LineString, distances: Iterable[float]
) -> Tuple[List[LineString], Dict[float, Node]]:
    """
    Break one fragment at the given distances along it, and say which node each distance became.

    Stations are cut into the graph rather than attached to it, so that a route starts and ends at
    the platform instead of at the nearest junction, which on a long fragment can be a kilometre off.

    The nodes are read back out of the resulting pieces rather than interpolated a second time, so
    that a station's node is by construction the node the piece beside it ends at. A cut too close
    to an end of the fragment is not made at all and the station joins that end instead, which is
    why the mapping is returned rather than left to the caller to derive.
    """
    requested = sorted(set(distances))
    interior = [
        distance
        for distance in requested
        if MIN_PIECE_LENGTH_METERS < distance < fragment.length - MIN_PIECE_LENGTH_METERS
    ]

    pieces: List[LineString] = []
    boundaries: List[Tuple[float, Node]] = [(0.0, node_of(fragment.coords[0]))]
    previous = 0.0
    for distance in [*interior, fragment.length]:
        piece = cut_line(fragment, previous, distance)
        if piece.is_empty or piece.length < MIN_PIECE_LENGTH_METERS:
            continue
        pieces.append(piece)
        boundaries.append((distance, node_of(piece.coords[-1])))
        previous = distance

    nodes = {
        distance: min(boundaries, key=lambda boundary: abs(boundary[0] - distance))[1]
        for distance in requested
    }
    return pieces, nodes


class TrackGraph:
    """
    The track of one line, with its stations cut in, ready to be routed over.

    Built once per line: the expensive part is snapping the stations and splitting the fragments,
    and every pair of neighbours reuses the result.
    """

    def __init__(self, geometry: Union[LineString, MultiLineString], stations: Dict[str, Point]):
        fragments = iter_fragments(geometry)
        anchors = {station_id: station_anchors(fragments, point) for station_id, point in stations.items()}
        self.unanchored = sorted(station_id for station_id, found in anchors.items() if not found)

        cuts: Dict[int, List[float]] = {}
        for found in anchors.values():
            for index, distance in found:
                cuts.setdefault(index, []).append(distance)

        pieces: List[LineString] = []
        nodes_per_fragment: Dict[int, Dict[float, Node]] = {}
        for index, fragment in enumerate(fragments):
            fragment_pieces, fragment_nodes = split_fragment(fragment, cuts.get(index, ()))
            pieces.extend(fragment_pieces)
            nodes_per_fragment[index] = fragment_nodes

        self.edges = self._build_edges(pieces)
        self.nodes = {
            station_id: [nodes_per_fragment[index][distance] for index, distance in found]
            for station_id, found in anchors.items()
        }

    @property
    def is_empty(self) -> bool:
        return not self.edges

    @staticmethod
    def _build_edges(pieces: Sequence[LineString]) -> Dict[Node, List[Edge]]:
        """The track as an undirected graph: piece ends are nodes, pieces are edges."""
        edges: Dict[Node, List[Edge]] = {}
        for piece in pieces:
            coords = list(piece.coords)
            start, end = node_of(coords[0]), node_of(coords[-1])
            if start == end:
                continue
            edges.setdefault(start, []).append((end, piece.length, piece))
            edges.setdefault(end, []).append((start, piece.length, LineString(coords[::-1])))
        return edges

    def route(self, station_id_a: str, station_id_b: str) -> Optional[LineString]:
        """
        The shortest run of track from one station to the other, as one line.

        Dijkstra rather than a breadth first walk: pieces differ in length by three orders of
        magnitude, so the route with the fewest pieces is not the shortest one.
        """
        targets = set(self.nodes.get(station_id_b, ()))
        sources = [node for node in self.nodes.get(station_id_a, ()) if node in self.edges]
        if not targets or not sources:
            return None

        best_cost = {source: 0.0 for source in sources}
        came_from: Dict[Node, Tuple[Node, LineString]] = {}
        queue = [(0.0, source) for source in sources]
        heapq.heapify(queue)
        visited = set()

        while queue:
            cost, node = heapq.heappop(queue)
            if node in visited:
                continue
            visited.add(node)

            if node in targets:
                return self._assemble(node, came_from)

            for neighbour, length, piece in self.edges.get(node, ()):
                if neighbour in visited:
                    continue
                candidate = cost + length
                if candidate < best_cost.get(neighbour, float("inf")):
                    best_cost[neighbour] = candidate
                    came_from[neighbour] = (node, piece)
                    heapq.heappush(queue, (candidate, neighbour))
        return None

    @staticmethod
    def _assemble(node: Node, came_from: Dict[Node, Tuple[Node, LineString]]) -> Optional[LineString]:
        """Walk the predecessors back to the source, stitching the pieces into one line."""
        coords: List[Tuple[float, float]] = []
        while node in came_from:
            node, piece = came_from[node]
            coords = list(piece.coords) + coords[1:]
        return LineString(coords) if len(coords) >= 2 else None
