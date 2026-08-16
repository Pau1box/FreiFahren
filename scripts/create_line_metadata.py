"""
Build `LineMetadata.json` for one network: the colour and the mode of every line.

Run it through the pipeline rather than directly:

    python3 scripts/build_network.py --network hamburg

Clients used to carry this per city in code, as a switch over Berlin's line names. That cannot scale
past one city, so it becomes data: the colour comes from the route's OpenStreetMap `colour` tag, the
mode from its `route` tag, and the network description can override colours for a network whose
branding is more consistent than its tagging.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections import Counter
from typing import Dict, List

from network_config import (
    Bounds,
    Coordinates,
    NetworkConfig,
    load_network_centers,
    load_network_config,
    nearest_network_id,
)
from overpass import query as overpass_query

# OSM `route` value to the mode name the API publishes. Clients group and filter by this instead of
# guessing from the line name, which is what tied them to Berlin's S/U/M convention.
MODE_BY_ROUTE = {
    "subway": "subway",
    "light_rail": "light_rail",
    "tram": "tram",
    "train": "train",
}


def read_route_cache(config: NetworkConfig) -> List[dict] | None:
    """
    The route relations the station step already downloaded, if this run has them.

    Reusing them is not only cheaper, it is the only way to stay consistent: the public Overpass
    mirrors serve different snapshots, so asking twice can answer twice differently, and a line that
    the station step saw but this one did not would ship without a mode. `build_network.py` clears
    the cache before every run, so what is read here always belongs to the current build.

    `None` means there is nothing to read, which is the normal case when this step is run on its own.
    """
    path = config.route_cache_path
    if not path.is_file():
        return None

    with path.open(encoding="utf-8") as handle:
        routes = json.load(handle)
    print(f"[INFO] Reusing {len(routes)} route relations from the station step", file=sys.stderr)
    # Already in the element shape the rest of this module works on, `{"id", "tags"}`, so the cached
    # and the queried path stay one code path from here on.
    return routes


def fetch_route_tags(config: NetworkConfig) -> List[dict]:
    """Every route relation of the network's modes, tags only. One query for all lines."""
    return overpass_query(
        rf"""
    [out:json][timeout:300];
    {config.source.area_preamble()}
    {config.source.route_union(config.source.scope())};
    out tags;
    """,
        timeout=300,
    )


def fetch_route_tags_in_box(config: NetworkConfig, bounds: Bounds, refs: List[str]) -> List[dict]:
    """
    Second pass for lines the area query missed.

    An area query only returns relations that OpenStreetMap considers inside the administrative
    boundary. A line running past the city limits, such as Berlin's S45 to the airport in
    Brandenburg, can fall outside it entirely. The station data already tells us where the network
    is, so those lines are looked up in that box instead.

    The box is wider than the network, which is the point, and that is also its risk: neighbouring
    systems reuse each other's line numbers. Duesseldorf and Cologne both have a `1`, a `7` and a
    `12`, and this query filters on the reference alone, so an unresolved Duesseldorf line could
    take Cologne's colour, mode and ring flag. `out center` asks for each relation's midpoint so
    the same nearest centre rule that separated the two systems can be applied to the answer.
    """
    ref_filter = "|".join(re.escape(ref) for ref in refs)
    box = (
        f"{bounds.south_west.latitude},{bounds.south_west.longitude},"
        f"{bounds.north_east.latitude},{bounds.north_east.longitude}"
    )
    elements = overpass_query(
        rf"""
    [out:json][timeout:300];
    {config.source.route_union(f"({box})", f'["ref"~"^({ref_filter})$"]')};
    out tags center;
    """,
        timeout=300,
    )
    centers = load_network_centers()
    return [element for element in elements if owns_relation(config, element, centers)]


def owns_relation(config: NetworkConfig, element: dict, centers: Dict[str, Coordinates]) -> bool:
    """Whether the relation sits closer to this network's centre than to any other network's.

    Without a midpoint there is nothing to judge by, and keeping the relation is the safer error: it
    only contributes tags to a line the network already has.
    """
    center = element.get("center")
    if center is None or not centers:
        return True

    midpoint = Coordinates(latitude=float(center["lat"]), longitude=float(center["lon"]))
    owner = nearest_network_id(midpoint, centers)
    if owner is not None and owner != config.id:
        print(
            f"[INFO] Ignoring route {element.get('tags', {}).get('ref')} for {config.id}, "
            f"it sits closest to {owner}",
            file=sys.stderr,
        )
        return False
    return True


def normalise_colour(value: str | None) -> str | None:
    """
    OpenStreetMap colours are inconsistent: `#F0D722`, `f0d722`, `red`, `#fff`.

    Only the two hex forms are accepted. A named colour is not worth a lookup table, and a wrong
    colour is worse than the network's default.
    """
    if not value:
        return None
    candidate = value.strip()
    if not candidate.startswith("#"):
        candidate = f"#{candidate}"
    if re.fullmatch(r"#[0-9a-fA-F]{6}", candidate):
        return candidate.lower()
    if re.fullmatch(r"#[0-9a-fA-F]{3}", candidate):
        return "#" + "".join(character * 2 for character in candidate[1:]).lower()
    return None


def create_line_metadata(elements: List[dict], lines: Dict[str, List[str]], config: NetworkConfig) -> dict:
    """
    Reduce the route relations to one entry per line the network actually has.

    A line usually has one relation per direction and often several per branch, so the tags are
    voted on rather than taken from whichever relation Overpass returned first.
    """
    colours: Dict[str, Counter] = {line: Counter() for line in lines}
    modes: Dict[str, Counter] = {line: Counter() for line in lines}
    circular: Dict[str, bool] = {line: False for line in lines}

    for element in elements:
        tags = element.get("tags", {})
        ref = tags.get("ref") or tags.get("name")
        if ref not in colours:
            continue

        colour = normalise_colour(tags.get("colour") or tags.get("color"))
        if colour is not None:
            colours[ref][colour] += 1

        mode = MODE_BY_ROUTE.get(tags.get("route", ""))
        if mode is not None:
            modes[ref][mode] += 1

        # One `roundtrip=yes` relation is enough: a ring is mapped as one relation per direction,
        # and a line is either a ring or it is not.
        if tags.get("roundtrip") == "yes":
            circular[ref] = True

    osm_colours = {
        line: (colours[line].most_common(1)[0][0] if colours[line] else None) for line in sorted(lines)
    }
    # Resolved together rather than one by one, so that lines with no colour anywhere can be given
    # distinct ones instead of all sharing the network default.
    resolved_colours = config.line_colors.resolve_all(osm_colours)
    missing_colour = [line for line, colour in osm_colours.items() if colour is None]

    metadata = {}
    for line in sorted(lines):
        metadata[line] = {
            "color": resolved_colours[line],
            # `unknown` rather than a guess: a client renders it as a neutral line instead of
            # filtering it into the wrong group.
            "mode": modes[line].most_common(1)[0][0] if modes[line] else "unknown",
            # Direction of travel means something different on a ring, because naming a terminus
            # does not narrow down where a train is going. Berlin's Ringbahn used to be the reason
            # for a hardcoded S41 and S42 in three different clients.
            "isCircular": circular[line],
        }

    if missing_colour:
        source = "the fallback palette" if config.line_colors.use_fallback_palette else "the network default"
        print(f"[WARN] No OpenStreetMap colour for {missing_colour}, using {source}", file=sys.stderr)
    return metadata


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--network", required=True, help="Network id, i.e. the name of a file in networks/")
    args = parser.parse_args()

    config: NetworkConfig = load_network_config(args.network)
    lines_path = config.backend_seed_dir / "LinesList.json"
    stations_path = config.backend_seed_dir / "StationsList.json"
    if not lines_path.is_file():
        raise SystemExit(f"{lines_path} is missing. Run create_lines_list.py first.")
    if not stations_path.is_file():
        raise SystemExit(f"{stations_path} is missing. Run create_stations_list.py first.")

    with lines_path.open(encoding="utf-8") as handle:
        lines = json.load(handle)
    with stations_path.open(encoding="utf-8") as handle:
        stations = json.load(handle)

    elements = read_route_cache(config)
    if elements is None:
        elements = fetch_route_tags(config)
    metadata = create_line_metadata(elements, lines, config)

    incomplete = [line for line, entry in metadata.items() if entry["mode"] == "unknown"]
    if incomplete:
        print(f"[INFO] Looking up {incomplete} outside the administrative area", file=sys.stderr)
        elements += fetch_route_tags_in_box(config, config.resolve_bounds(stations), incomplete)
        metadata = create_line_metadata(elements, lines, config)

    output_path = config.backend_seed_dir / "LineMetadata.json"
    with output_path.open("w", encoding="utf-8") as handle:
        json.dump(metadata, handle, ensure_ascii=False, indent=4)
        handle.write("\n")

    by_mode = Counter(entry["mode"] for entry in metadata.values())
    print(f"[DONE] {output_path} written for {len(metadata)} lines, modes {dict(by_mode)}", file=sys.stderr)


if __name__ == "__main__":
    main()
