"""
Build `StationsList.json` for one network from OpenStreetMap.

Run it through the pipeline rather than directly:

    python3 scripts/build_network.py --network hamburg

Everything city specific comes from `networks/<id>.yaml`. See `networks/README.md`.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections import defaultdict
from typing import Dict, List, Optional, Set, Tuple

from geo import haversine
from network_config import (
    MAX_LINE_ID_LENGTH,
    Coordinates,
    NetworkConfig,
    load_network_centers,
    load_network_config,
    nearest_network_id,
)
from overpass import query as overpass_query


def build_query(config: NetworkConfig) -> str:
    """
    Overpass query for every station node of the network's lines.

    When the network lists its lines explicitly we filter on them inside Overpass, which keeps the
    response small. When it discovers them (`lines: auto`) we take every route of the configured
    modes and filter afterwards, except where a mode carries a line pattern of its own: that one is
    filtered on the server too, because a mode like `train` otherwise returns the whole country.
    """
    if config.source.include_lines is None:
        line_filter = ""
    else:
        refs = "|".join(re.escape(line) for line in config.source.include_lines)
        line_filter = f'["ref"~"^({refs})$"]'

    return rf"""
[out:json][timeout:1200];

// The administrative area to search in
{config.source.area_preamble()}

// Route relations for the modes we want, one block per mode so a mode's own line rule applies
{config.source.route_union(config.source.scope(), line_filter)}->.routes;

// All member nodes (platforms, stop_positions, etc.)
(.routes; >>;)->.routeNodes;

// stop_area relations that contain any of those nodes
rel
  ["public_transport"="stop_area"]
  (bn.routeNodes)
  ->.stopAreas;

// All nodes inside those stop_areas (incl. station nodes)
(.stopAreas; >>;)->.stopNodes;

// For completeness, also pull any station node referenced directly
node.routeNodes["railway"="station"]->.directStations;
node.routeNodes["public_transport"="station"]->.directStationsPT;

(
  .routes;
  .stopAreas;
  .routeNodes;
  .stopNodes;
  .directStations;
  .directStationsPT;
);
out body;
"""


def fetch_elements(config: NetworkConfig) -> List[dict]:
    print(f"[INFO] Fetching {config.name} from Overpass ...", file=sys.stderr, flush=True)
    elements = overpass_query(build_query(config))
    print(f"[INFO] Received {len(elements)} elements", file=sys.stderr)
    return elements


def station_code(tags: Dict[str, str], node_id: int, config: NetworkConfig) -> str:
    """
    The id a station is known by, from the first configured tag that is present.

    The fallback is the OSM node id, which is unique across the whole planet. Which tags a network
    trusts before that is a per network decision, because not every `ref` is unique outside its own
    operator. See the note in `networks/hamburg.yaml`.
    """
    for source in config.stations.id_sources:
        value = tags.get(source)
        if value:
            return value
    return f"n{node_id}"


def owns_route(
    config: NetworkConfig,
    relation: dict,
    stations: Dict[int, dict],
    centers: Dict[str, Coordinates],
) -> bool:
    """
    Whether this network, rather than a neighbouring one, should carry the route.

    A `boundingBox` is a rectangle drawn around a system that is not rectangular, so neighbouring
    boxes overlap. Duesseldorf's reaches into Cologne's and Cologne's back into Duesseldorf's, and
    without this both would download the other's trams. The same station would then exist in two
    networks, which the station id is required to be unique across, and the seed would fail.

    The route goes to whichever network centre its stops sit closest to, which is the rule that
    separated the two systems in the first place. Networks defined by an administrative boundary
    skip this: their area already answers the question exactly.
    """
    if not centers:
        return True

    points = [
        Coordinates(**stations[member["ref"]]["coordinates"])
        for member in relation.get("members", [])
        if member["type"] == "node" and member["ref"] in stations
    ]
    if not points:
        # Nothing to judge by. Keeping it is the safer error: a route with no known stop contributes
        # no stations anyway.
        return True

    middle = Coordinates(
        latitude=sum(point.latitude for point in points) / len(points),
        longitude=sum(point.longitude for point in points) / len(points),
    )
    return nearest_network_id(middle, centers) == config.id


def build_dataset(elements: List[dict], config: NetworkConfig) -> Tuple[Dict[str, dict], List[dict]]:
    """
    Turn raw Overpass elements into `{stationId: {coordinates, lines, name}}`.

    Stations that end up serving none of the network's lines are dropped: they are stops that
    happened to sit inside the queried area.

    The tags of the route relations this network accepted come back alongside, because the later
    steps need the same relations and must not ask Overpass for them a second time. See
    `route_cache_path` for why.
    """
    # Only needed by networks that search a box, see `owns_route`.
    centers = load_network_centers() if config.source.osm_area is None else {}

    stations: Dict[int, dict] = {}
    node_to_lines: Dict[int, Set[str]] = defaultdict(set)
    station_to_members: Dict[int, Set[int]] = defaultdict(set)
    discovered_lines: Set[str] = set()
    accepted_routes: List[dict] = []
    overlong_refs: Set[str] = set()

    for element in elements:
        if element["type"] == "node":
            tags = element.get("tags", {})

            is_station = tags.get("railway") in (
                "station",
                "halt",
                "tram_stop",
                "platform",
            ) or tags.get("public_transport") in (
                "station",
                "stop_position",
                "platform",
            )
            if not is_station:
                continue

            stations[element["id"]] = {
                "code": station_code(tags, element["id"], config),
                "name": tags.get("name", ""),
                "coordinates": {"latitude": element["lat"], "longitude": element["lon"]},
            }

        elif element["type"] == "relation":
            tags = element.get("tags", {})
            if tags.get("public_transport") == "stop_area":
                member_nodes = [m["ref"] for m in element["members"] if m["type"] == "node"]
                station_nodes = [
                    m["ref"]
                    for m in element["members"]
                    if m["type"] == "node" and m.get("role") in ("station", "") and m["ref"] in stations
                ]
                if not station_nodes:
                    station_nodes = [node_id for node_id in member_nodes if node_id in stations]
                for station in station_nodes:
                    station_to_members[station].update(member_nodes)

            elif tags.get("type") == "route":
                if not config.source.accepts_route(tags):
                    continue
                ref = tags.get("ref") or tags.get("name")
                # A relation with no `ref` falls back to its name, and a name this long is a
                # description rather than a designation: Karlsruhe tags its depot runs as
                # "E Einsatzwagen Betriebshof West <> Rheinhafen". No line a passenger can board is
                # named that, and the id would not fit the database column either.
                if len(ref) > MAX_LINE_ID_LENGTH:
                    overlong_refs.add(ref)
                    continue
                if not owns_route(config, element, stations, centers):
                    continue
                discovered_lines.add(ref)
                # Id and tags, not tags alone: the segment step fetches a relation's geometry by id,
                # so dropping it here would send that step back to Overpass for the same relations.
                accepted_routes.append({"id": element["id"], "tags": tags})
                for member in element.get("members", []):
                    if member["type"] == "node":
                        node_to_lines[member["ref"]].add(ref)

    if overlong_refs:
        print(
            f"[WARN] Dropped {len(overlong_refs)} route(s) whose only designation is longer than "
            f"{MAX_LINE_ID_LENGTH} characters: {sorted(overlong_refs)}",
            file=sys.stderr,
        )

    accepted_lines = set(config.source.include_lines or discovered_lines) - set(config.source.exclude_lines)

    dataset: Dict[str, dict] = {}
    for station_id, station in stations.items():
        lines: Set[str] = set(node_to_lines.get(station_id, []))
        for member in station_to_members.get(station_id, []):
            lines.update(node_to_lines.get(member, []))
        lines &= accepted_lines
        if not lines:
            continue
        dataset[station["code"]] = {
            "coordinates": station["coordinates"],
            "lines": sorted(lines),
            "name": station["name"],
        }

    print(f"[STAT] Lines: {len(accepted_lines)} {sorted(accepted_lines)}", file=sys.stderr)
    print(f"[STAT] Stations kept: {len(dataset)}", file=sys.stderr)
    return dataset, [
        route
        for route in accepted_routes
        if (route["tags"].get("ref") or route["tags"].get("name")) in accepted_lines
    ]


def merge_proximate(data: Dict[str, dict], threshold: float) -> Dict[str, dict]:
    """
    Merge stations that are close enough for an inspector to walk between.

    OpenStreetMap models Berlin Hauptbahnhof as three separate stations (tram, S-Bahn, U-Bahn).
    For our purpose they are one place, because being checked on one platform tells you something
    about the others.
    """
    merged: Dict[str, dict] = {}
    used: Set[str] = set()
    ids = list(data.keys())

    for index, station_id in enumerate(ids):
        if station_id in used:
            continue
        group = [station_id]
        for other_id in ids[index + 1 :]:
            if other_id in used:
                continue
            if haversine(data[station_id]["coordinates"], data[other_id]["coordinates"]) <= threshold:
                group.append(other_id)
        used.update(group)
        # A named member represents the group, because the name is what a user reports and searches
        # by. OpenStreetMap leaves plenty of platform nodes unnamed next to the named stop they
        # belong to, and taking the first member regardless would throw that name away.
        representative = next((member for member in group if data[member]["name"]), group[0])
        merged[representative] = {
            "coordinates": {
                "latitude": sum(data[member]["coordinates"]["latitude"] for member in group) / len(group),
                "longitude": sum(data[member]["coordinates"]["longitude"] for member in group) / len(group),
            },
            "lines": sorted({line for member in group for line in data[member]["lines"]}),
            "name": data[representative]["name"],
        }

    print(f"[STAT] After merge (<{threshold} m): {len(merged)} stations", file=sys.stderr)
    return merged


def drop_unnamed(data: Dict[str, dict]) -> Dict[str, dict]:
    """
    Remove stations that carry no name, after the merge had its chance to supply one.

    A station without a name cannot be reported, searched or labelled on the map, so it is of no use
    to anyone downstream, and the validator rejects it. Chemnitz has eight such stops, mostly service
    platforms of the tram train that never got a name in OpenStreetMap.
    """
    named = {station_id: info for station_id, info in data.items() if info["name"]}
    dropped = len(data) - len(named)
    if dropped:
        print(f"[STAT] Dropped {dropped} station(s) without a name", file=sys.stderr)
    return named


def prefix_station_ids(data: Dict[str, dict], config: NetworkConfig) -> Dict[str, dict]:
    """Add the per network mode prefix, e.g. `SU-` for a station served by S-Bahn and U-Bahn."""
    return {
        f"{config.stations.prefix_for(info['lines'])}{station_id}": info for station_id, info in data.items()
    }


def create_stations_list(
    config: NetworkConfig, elements: Optional[List[dict]] = None
) -> Tuple[Dict[str, dict], List[dict]]:
    data, routes = build_dataset(elements if elements is not None else fetch_elements(config), config)
    data = merge_proximate(data, config.stations.merge_radius_meters)
    data = drop_unnamed(data)
    return prefix_station_ids(data, config), routes


def write_route_cache(config: NetworkConfig, routes: List[dict]) -> None:
    """
    Hand the route relations to the later steps of the build, as `{"id", "tags"}` each.

    The public Overpass mirrors do not all serve the same snapshot, and the difference is not
    academic: asking twice for every tram route around Mannheim returned 49 relations once and 51 a
    few minutes later, without lines 5A and 8 the first time. The line list came from one answer and
    the line metadata from the other, so both lines shipped with no mode at all.

    Querying once and passing the answer on removes the disagreement by construction, and halves
    the load we put on a service that is donated rather than bought.
    """
    path = config.route_cache_path
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        json.dump(routes, handle, ensure_ascii=False, indent=4)
    print(f"[DONE] {path} written for {len(routes)} route relations", file=sys.stderr)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--network", required=True, help="Network id, i.e. the name of a file in networks/")
    args = parser.parse_args()

    config = load_network_config(args.network)
    data, routes = create_stations_list(config)

    output_path = config.backend_seed_dir / "StationsList.json"
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open("w", encoding="utf-8") as handle:
        json.dump(data, handle, ensure_ascii=False, indent=4)
    print(f"[DONE] {output_path} written", file=sys.stderr)

    write_route_cache(config, routes)


if __name__ == "__main__":
    main()
