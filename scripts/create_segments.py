"""
Build `segments.json` for one network, the track geometry between consecutive stations.

Run it through the pipeline rather than directly:

    python3 scripts/build_network.py --network hamburg --with-segments

Needs the optional geospatial dependencies (geopandas, shapely), which is why it is an opt in step
rather than part of the default build.

The result feeds the Go backend's risk colouring. A network without it is served without those
colours instead of failing, so a city is usable before its geometry has been generated.

Two decisions shape this file, the third lives in `track_graph.py`:

Everything is measured in metres, not in degrees of latitude and longitude. Shapely is a planar
library: it happily projects a station onto a line in EPSG:4326, but a degree of longitude is only
about two thirds of a degree of latitude in Germany, so "the nearest point" comes out skewed and
every threshold means a different distance depending on which way the track runs. The geometry is
therefore reprojected to the network's UTM zone before any of it is measured, and back to EPSG:4326
on the way out.

The station order comes from `LinesList.json`, which already holds each line in travel order, rather
than from the distance along the downloaded geometry. Track for a real line is never one tidy line
string, so "distance along the line" is not a travel order at all: it concatenates disconnected
pieces in whatever order they arrived and pairs up stations that are nowhere near each other.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys
from typing import Any, Dict, List, Optional, Sequence, Tuple, Union

import geopandas as gpd
from shapely.geometry import LineString, MultiLineString, Point
from shapely.ops import linemerge

import overpass
from network_config import NetworkConfig, load_network_config
from track_graph import MAX_STATION_OFFSET_METERS, TrackGraph

# Track between neighbouring stations that is far longer than the straight line between them means
# the route went around the block or through a depot, not that the track is curvy. The allowance
# keeps short hops, where a terminus loop legitimately multiplies the distance, from being dropped.
MAX_DETOUR_FACTOR = 3.0
MIN_DETOUR_ALLOWANCE_METERS = 800.0

# ... and track far shorter than the straight line is not a connection between the two stations at
# all, only a fragment that happens to lie between them.
MIN_LENGTH_RATIO = 0.7


def read_route_cache(config: NetworkConfig) -> Optional[List[Dict[str, Any]]]:
    """
    The route relations the station step already downloaded, if this run has them.

    `None` means there is nothing to read, which is the normal case when this step is run on its
    own. No check on age or completeness: `build_network.py` clears the cache before every run, so
    what is here belongs to the current build, and that is the only guarantee worth relying on.
    """
    path = config.route_cache_path
    if not path.is_file():
        return None

    with path.open(encoding="utf-8") as handle:
        relations = json.load(handle)
    print(f"[INFO] Reusing {len(relations)} route relations from the station step", flush=True)
    return relations


def fetch_route_relations(config: NetworkConfig) -> List[Dict[str, Any]]:
    """
    Every route relation of the network, from Overpass. One query for all lines.

    Only used when this step runs on its own. Resolving the administrative area is what makes an
    Overpass query expensive, not the filtering afterwards, so asking per line and then a second
    time for the colours meant Berlin paid for that lookup 94 times over.
    """
    query = rf"""
    [out:json][timeout:600];
    {config.source.area_preamble("area")}
    {config.source.route_union(config.source.scope("area"))};
    out tags;
    """
    return overpass.query(query, timeout=600)


def group_by_line(config: NetworkConfig, relations: List[Dict[str, Any]]) -> Dict[str, List[Dict[str, Any]]]:
    """
    Sort route relations under the line they belong to.

    `accepts_route` and the `ref or name` key are what the station step uses to decide the same
    question, and the answers have to agree: a relation this step accepted but that one did not
    would draw track for a line that is in no list, and the other way round leaves a line of the
    list without track. It also keeps a heritage operation signed like a service line, Chemnitz's
    Parkeisenbahn, from contributing its track to that line.

    Applied to the cached relations too, even though the station step already filtered them, so
    that both sources go through one path and cannot diverge.
    """
    grouped: Dict[str, List[Dict[str, Any]]] = {}
    for relation in relations:
        tags = relation.get("tags", {})
        if not config.source.accepts_route(tags):
            continue
        grouped.setdefault(tags.get("ref") or tags.get("name"), []).append(relation)
    return grouped


def load_route_relations(config: NetworkConfig) -> Dict[str, List[Dict[str, Any]]]:
    """
    The network's route relations, grouped by line, from the build cache or from Overpass.

    The cache is preferred because it is the only way to stay consistent with the rest of the
    build, not merely the cheaper one. The public mirrors serve different snapshots, so asking a
    second time can answer differently: Berlin's S45 is in `LinesList.json` with 14 stations and had
    13 segments in the committed file, but a fresh query for this step returned no relation for it
    at all. Rebuilding from that answer would have dropped the line's geometry without a word.
    """
    relations = read_route_cache(config)
    if relations is None:
        print(f"[INFO] No build cache, asking Overpass for {config.name} route relations", flush=True)
        relations = fetch_route_relations(config)
    return group_by_line(config, relations)


def way_geometry(element: Dict[str, Any]) -> Optional[LineString]:
    """One OSM way as a line, or None when it carries too few points to be one."""
    points = element.get("geometry") or []
    if element.get("type") != "way" or len(points) < 2:
        return None
    return LineString([(point["lon"], point["lat"]) for point in points])


def merge_ways(line_id: str, ways: List[LineString]) -> Union[LineString, MultiLineString]:
    """
    The track of one line, as few continuous pieces as the ways allow.

    Merging is not required for the routing, but it turns a run of ways into one fragment and so
    keeps the graph small.
    """
    if not ways:
        print(f"[WARN] No way geometry for line {line_id}", file=sys.stderr)
        return LineString()
    return linemerge(ways)


def fetch_network_geometry(
    config: NetworkConfig, relations_by_line: Dict[str, List[Dict[str, Any]]]
) -> Optional[Dict[str, Union[LineString, MultiLineString]]]:
    """
    The track of every line of the network, in one query. `None` when Overpass would not answer it.

    All the relation ids are known before any geometry is fetched, so there is no reason to ask
    once per line: that repeated the cost of resolving the relations for each of them and turned one
    city into forty requests. Asking once is also the smaller favour to ask of a donated service,
    which matters more than our own runtime.

    The relations come back with their member lists and the ways with their coordinates, so which
    way belongs to which line is decided here rather than by the server. `None` rather than an
    exception, because the caller has a working fallback and a city is worth more than the saving.
    """
    relation_ids = sorted({relation["id"] for relations in relations_by_line.values() for relation in relations})
    if not relation_ids:
        return {}

    query = rf"""
    [out:json][timeout:900];
    relation(id:{",".join(str(relation_id) for relation_id in relation_ids)})->.routes;
    .routes out body;
    way(r.routes);
    out geom;
    """
    try:
        elements = overpass.query(query, timeout=900)
    except overpass.OverpassError as error:
        print(f"[WARN] Network wide geometry query failed, falling back to one per line: {error}", file=sys.stderr)
        return None

    ways_by_id: Dict[int, LineString] = {}
    way_ids_by_relation: Dict[int, List[int]] = {}
    for element in elements:
        if element.get("type") == "relation":
            way_ids_by_relation[element["id"]] = [
                member["ref"] for member in element.get("members", ()) if member.get("type") == "way"
            ]
            continue
        geometry = way_geometry(element)
        if geometry is not None:
            ways_by_id[element["id"]] = geometry

    geometry_by_line: Dict[str, Union[LineString, MultiLineString]] = {}
    for line_id, relations in relations_by_line.items():
        # By way id, so that a way shared by two relations of the same line is taken once.
        way_ids = {
            way_id
            for relation in relations
            for way_id in way_ids_by_relation.get(relation["id"], ())
        }
        geometry_by_line[line_id] = merge_ways(line_id, [ways_by_id[i] for i in sorted(way_ids) if i in ways_by_id])
    return geometry_by_line


def fetch_line_geometry(
    line_id: str, relations: Sequence[Dict[str, Any]]
) -> Union[LineString, MultiLineString]:
    """
    Fetch the OSM ways carrying one line. The fallback for when the network wide query fails.

    Every relation of the line is downloaded, not just the first. A line is tagged once per
    direction and again per branch or short turn, and any single one of those covers only part of
    the route, so taking the first leaves the outer half of a line without geometry. The relations
    overlap, which costs nothing here: the routing walks whatever track it is given.
    """
    if not relations:
        print(f"[WARN] No relation found for line {line_id}", file=sys.stderr)
        return LineString()

    # By relation id and without the area filter, so a line that leaves the city keeps the rest of
    # its track. `out geom` already attaches the coordinates to each way, so the member nodes are
    # not requested: asking for them returned ten times as many elements for an identical result.
    relation_ids = ",".join(str(relation["id"]) for relation in relations)
    geom_query = rf"""
    [out:json][timeout:360];
    relation(id:{relation_ids});
    way(r);
    out geom;
    """
    elements = overpass.query(geom_query, timeout=360)
    return merge_ways(line_id, [geometry for geometry in map(way_geometry, elements) if geometry is not None])


def read_line_colors(path: Path) -> Dict[str, str]:
    """The colour of each line, read from the metadata the backend serves.

    Deriving it here a second time from the OSM tags looked equivalent and was not. The metadata
    step normalises the tag, resolves disagreement between a line's relations and falls back to a
    generated palette when OpenStreetMap has no usable colour, none of which this step did: it took
    `relations[0]` and passed the raw tag through. The two therefore disagreed wherever the tag was
    a colour name or absent, and the map is drawn from this file while the line chips are drawn from
    the metadata, so a line came out `blue` in Bielefeld and black in Duesseldorf while its chip was
    the palette colour. One source or the map contradicts the legend.
    """
    return {line: meta["color"] for line, meta in load_json(path).items()}


def create_segments(
    line_id: str,
    geometry: Union[LineString, MultiLineString],
    stations: Sequence[Tuple[str, Point]],
    line_color: str,
) -> List[Dict[str, Any]]:
    """
    Cut the line's geometry into one segment per pair of neighbouring stations.

    `stations` is in travel order and `geometry` is in a metric CRS. A route that is implausibly
    long or short for the distance between its two stations is dropped rather than drawn: the map
    colours these segments by risk, and a segment through the wrong streets misinforms where a
    missing one merely leaves a gap.
    """
    graph = TrackGraph(geometry, dict(stations))
    if graph.is_empty:
        print(f"[WARN] No usable geometry for line {line_id}, skipping its segments", file=sys.stderr)
        return []
    if graph.unanchored:
        print(
            f"[WARN] {len(graph.unanchored)} of {len(stations)} stations of line {line_id} are more "
            f"than {MAX_STATION_OFFSET_METERS:.0f} m from its track",
            file=sys.stderr,
        )

    segments: List[Dict[str, Any]] = []
    for (station_id_a, point_a), (station_id_b, point_b) in zip(stations, stations[1:]):
        track = graph.route(station_id_a, station_id_b)
        direct_distance = point_a.distance(point_b)
        where = f"between {station_id_a} and {station_id_b} on line {line_id}"

        if track is None:
            print(f"[WARN] No track {where}", file=sys.stderr)
            continue
        if track.length < MIN_LENGTH_RATIO * direct_distance:
            print(
                f"[WARN] Track {where} is only {track.length:.0f} m for {direct_distance:.0f} m of "
                "distance, skipping",
                file=sys.stderr,
            )
            continue
        if track.length > max(MAX_DETOUR_FACTOR * direct_distance, MIN_DETOUR_ALLOWANCE_METERS):
            print(
                f"[WARN] Implausible detour {where}: {track.length:.0f} m of track for "
                f"{direct_distance:.0f} m of distance, skipping",
                file=sys.stderr,
            )
            continue

        segments.append(
            {
                "geometry": track,
                "sid": f"{line_id}.{station_id_a}:{station_id_b}",
                "line_color": line_color,
            }
        )
    return segments


def load_json(path: Path) -> Dict[str, Any]:
    with path.open(encoding="utf-8") as handle:
        return json.load(handle)


def metric_station_points(stations_json: Dict[str, Any]) -> Tuple[Any, Dict[str, Point]]:
    """
    Every station as a point in one metric CRS, plus that CRS.

    Derived from the stations themselves, so a network anywhere in the world gets the UTM zone it
    actually sits in rather than one hardcoded for Germany.
    """
    stations = gpd.GeoDataFrame(
        [
            {
                "station_id": station_id,
                "geometry": Point(info["coordinates"]["longitude"], info["coordinates"]["latitude"]),
            }
            for station_id, info in stations_json.items()
        ],
        geometry="geometry",
        crs="EPSG:4326",
    )
    metric_crs = stations.estimate_utm_crs()
    return metric_crs, dict(zip(stations["station_id"], stations.to_crs(metric_crs).geometry))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--network", required=True, help="Network id, i.e. the name of a file in networks/")
    args = parser.parse_args()

    config = load_network_config(args.network)
    stations_path = config.backend_seed_dir / "StationsList.json"
    lines_path = config.backend_seed_dir / "LinesList.json"
    metadata_path = config.backend_seed_dir / "LineMetadata.json"
    for path, producer in (
        (stations_path, "create_stations_list.py"),
        (lines_path, "create_lines_list.py"),
        (metadata_path, "create_line_metadata.py"),
    ):
        if not path.is_file():
            raise SystemExit(f"{path} is missing. Run {producer} first.")

    lines_json = load_json(lines_path)
    line_colors = read_line_colors(metadata_path)
    metric_crs, metric_points = metric_station_points(load_json(stations_path))

    relations_by_line = load_route_relations(config)
    print(f"[INFO] Found relations for {len(relations_by_line)} lines", flush=True)

    geometry_by_line = fetch_network_geometry(config, relations_by_line)
    if geometry_by_line is not None:
        print(f"[INFO] Fetched the track of {len(geometry_by_line)} lines in one query", flush=True)

    segments_list: List[Dict[str, Any]] = []
    expected_total = 0
    lines_without_segments: List[str] = []

    for line_id, station_ids in lines_json.items():
        print(f"[INFO] Processing line {line_id}", flush=True)
        if len(station_ids) < 2:
            print(f"[WARN] Line {line_id} has fewer than two stations, skipping", file=sys.stderr)
            continue
        missing = [station_id for station_id in station_ids if station_id not in metric_points]
        if missing:
            raise SystemExit(f"[FAIL] Stations {missing} of line {line_id} are not in StationsList.json")

        relations = relations_by_line.get(line_id, [])
        if geometry_by_line is not None:
            geometry = geometry_by_line.get(line_id, LineString())
            if not relations:
                print(f"[WARN] No relation found for line {line_id}", file=sys.stderr)
        else:
            try:
                geometry = fetch_line_geometry(line_id, relations)
            except overpass.OverpassError as error:
                # One line that Overpass will not answer, after every mirror and every retry, must
                # not cost the other forty. A city with a line missing is still a usable city, and
                # the line can be filled in by running the script again.
                print(f"[WARN] Giving up on line {line_id}: {error}", file=sys.stderr)
                lines_without_segments.append(line_id)
                expected_total += len(station_ids) - 1
                continue
        geometry = gpd.GeoSeries([geometry], crs="EPSG:4326").to_crs(metric_crs).iloc[0]
        stations = [(station_id, metric_points[station_id]) for station_id in station_ids]

        if line_id not in line_colors:
            raise SystemExit(f"[FAIL] Line {line_id} is in LinesList.json but not in LineMetadata.json")
        line_segments = create_segments(line_id, geometry, stations, line_colors[line_id])
        expected_total += len(station_ids) - 1
        if not line_segments:
            lines_without_segments.append(line_id)
        print(f"[INFO] Line {line_id}: {len(line_segments)}/{len(station_ids) - 1} segments", flush=True)
        segments_list.extend(line_segments)

    if not segments_list:
        raise SystemExit("[FAIL] No segments could be built for any line")

    # GeoJSON content under a .json name, because that is the name the Go backend embeds. Back in
    # EPSG:4326, which is what every consumer of the file expects.
    output_path = config.backend_seed_dir / "segments.json"
    output_path.parent.mkdir(parents=True, exist_ok=True)
    segments_gdf = gpd.GeoDataFrame(segments_list, geometry="geometry", crs=metric_crs).to_crs("EPSG:4326")
    segments_gdf.to_file(output_path, driver="GeoJSON")

    coverage = 100.0 * len(segments_list) / expected_total if expected_total else 0.0
    print(f"[DONE] Saved {len(segments_list)}/{expected_total} segments ({coverage:.1f}%) to {output_path}")
    if lines_without_segments:
        print(f"[WARN] Lines without any segment: {', '.join(lines_without_segments)}", file=sys.stderr)


if __name__ == "__main__":
    main()
