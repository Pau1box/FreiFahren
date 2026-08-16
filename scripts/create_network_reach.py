"""
Work out which other cities a network reaches, so a rider can find it under their own city's name.

Run it through the pipeline rather than directly:

    python3 scripts/build_network.py --network duesseldorf

A network is named after one city and often serves a dozen. The Rhine-Ruhr network is filed under
`duesseldorf` and stops in Dortmund, Essen, Duisburg and Bochum; someone in Dortmund scrolling a
list of forty cities has no reason to guess that. What this writes ends up in `network.json` as
`serves`, and the clients match it when a user searches the network list.

The test is whether a station of the built network lies inside the city's administrative boundary,
not how far the city centre is from the nearest station. Distance cannot answer this: Cologne's
line 4 ends in Leverkusen at a stop 8 km from the Leverkusen city centre, which no radius that
excludes Wuppertal would accept, and the nearest station to the centre of Bottrop is 3.8 km away in
Essen. The boundary is the thing being asked about, so the boundary is what gets used.

The reason this is generated from the stations rather than declared is that the claim goes stale
otherwise. `discover_networks.py` used to write the list into the YAML as a comment, computed from
route midpoints before the network was built, and by the time the networks in this repo existed
four of those comments were wrong: the Leipzig file still claimed Halle, which had since become its
own network, and the Rhine-Ruhr file claimed Wuppertal, Solingen and Remscheid, which it never
reached.

Optional, like the segments step and for the same reasons: it needs Overpass and shapely, and a
network without it is served without the extra search terms rather than not served at all.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from typing import Dict, Iterable, List, Tuple

from network_config import NetworkConfig, load_network_config
from overpass import query
# The same rule the discovery step names a network by, so the two cannot disagree about what a
# place is called: without it Cottbus is published as a city its own network additionally serves.
from place_names import clean_place_name

# Only places big enough that someone would look for them by name. Every German city above this
# size is a plausible search term, and going lower turns the list into every suburb a tram passes.
MIN_POPULATION = 50_000

# German cities are mapped as level 6 when they are a district of their own (Essen, Fürth) and as
# level 8 when they sit inside a district (Neuss, Bergisch Gladbach). Both are municipalities, which
# is the unit a rider means by "my city".
ADMIN_LEVELS = ("6", "8")

# Boundaries whose centre lies within this much of the network's box. The box already fits the
# network, and a city that only overlaps its edge still counts, so this is a small margin rather
# than a search radius.
BOX_MARGIN_DEGREES = 0.2

# Which places in the box are big enough to be worth listing. Asked of the place nodes rather than
# of the boundaries, because the population tag is reliable on the node and often absent on the
# relation: Dortmund's boundary carries none, and filtering boundaries by it lost six of the cities
# the Rhine-Ruhr network demonstrably stops in.
PLACES_QUERY = """
[out:json][timeout:180];
node["place"~"^(city|town)$"]["population"]({south},{west},{north},{east});
out tags center;
"""

# Only the boundaries of those places, by name. Downloading every municipality's geometry in a box
# the size of the Ruhr would be tens of megabytes off a donated server for the sake of a search
# term.
BOUNDARY_QUERY = """
[out:json][timeout:300];
relation
  ["boundary"="administrative"]
  ["admin_level"~"^({levels})$"]
  ["name"~"^({names})$"]
  ({south},{west},{north},{east});
out geom;
"""


class ReachUnavailable(RuntimeError):
    """Raised when the reach cannot be worked out, which is never fatal to a build."""


def population_of(tags: Dict[str, str]) -> int:
    """The population tag as a number, or 0 when it is missing or not one.

    OpenStreetMap carries values like `1 085 664` and `~30000`. A value this cannot read means the
    city is left out rather than the build stopping, because the tag is not ours to fix.
    """
    raw = tags.get("population", "")
    digits = "".join(character for character in raw if character.isdigit())
    return int(digits) if digits else 0


def outer_rings(element: dict) -> List[List[Tuple[float, float]]]:
    """The outer ways of one boundary relation as coordinate lists, in (longitude, latitude)."""
    rings = []
    for member in element.get("members", []):
        if member.get("type") != "way" or member.get("role") not in ("outer", ""):
            continue
        geometry = member.get("geometry") or []
        if len(geometry) >= 2:
            rings.append([(point["lon"], point["lat"]) for point in geometry])
    return rings


def city_areas(config: NetworkConfig, stations: Dict[str, dict]):
    """Every municipality in the network's box as one shapely geometry per city name."""
    try:
        from shapely.geometry import LineString
        from shapely.ops import polygonize, unary_union
    except ImportError as error:  # pragma: no cover - depends on the contributor's environment
        raise ReachUnavailable(
            "shapely is not installed. Install it, or build without this step and the network is "
            "served without the extra search terms."
        ) from error

    # The published bounds rather than the search box in the YAML: they fit the stations that were
    # actually built, which is what the question is about.
    box = config.resolve_bounds(stations)
    corners = {
        "south": box.south_west.latitude - BOX_MARGIN_DEGREES,
        "west": box.south_west.longitude - BOX_MARGIN_DEGREES,
        "north": box.north_east.latitude + BOX_MARGIN_DEGREES,
        "east": box.north_east.longitude + BOX_MARGIN_DEGREES,
    }

    # A name with a quote or a backslash in it would end the string literal in the next query and
    # turn a place name into part of the Overpass expression. No German city has one, which is
    # exactly why it is worth dropping rather than trusting.
    named = {
        element["tags"]["name"]
        for element in query(PLACES_QUERY.format(**corners))
        if element.get("tags", {}).get("name")
        and population_of(element["tags"]) >= MIN_POPULATION
        and not set('"\\') & set(element["tags"]["name"])
    }
    if not named:
        return {}

    # Queried by the name OpenStreetMap carries, kept under the name a rider would type. The
    # boundary of Cottbus is tagged "Cottbus - Chóśebuz", so matching on the shortened name would
    # find nothing at all.
    wanted = {clean_place_name(name) for name in named}
    payload = BOUNDARY_QUERY.format(
        levels="|".join(ADMIN_LEVELS),
        names="|".join(sorted(re.escape(name) for name in named)),
        **corners,
    )

    areas = {}
    for element in query(payload):
        name = clean_place_name(element.get("tags", {}).get("name", ""))
        if name not in wanted:
            continue
        rings = outer_rings(element)
        if not rings:
            continue
        # `polygonize` assembles the ways into rings for us. Doing it by hand means reimplementing
        # multipolygon assembly, and a boundary split into forty ways is the normal case, not the
        # exception. Holes come back as separate polygons and are unioned in, which over-includes an
        # enclave the size of a village and is not worth the code to avoid.
        polygons = list(polygonize(unary_union([LineString(ring) for ring in rings])))
        if not polygons:
            continue
        # A name can come back more than once, because a city mapped at level 6 is sometimes also
        # mapped at level 8. Both describe the same municipality, so they are merged rather than one
        # of them silently winning.
        shape = unary_union(polygons)
        areas[name] = unary_union([areas[name], shape]) if name in areas else shape
    return areas


def load_stations(config: NetworkConfig) -> Dict[str, dict]:
    path = config.backend_seed_dir / "StationsList.json"
    if not path.is_file():
        raise ReachUnavailable(f"{path} is missing. Run create_stations_list.py first.")
    with path.open(encoding="utf-8") as handle:
        return json.load(handle)


def cities_reached(config: NetworkConfig, stations: Dict[str, dict], areas) -> List[str]:
    """The names of the cities that contain at least one station, minus the network's own."""
    from shapely.geometry import Point

    points = [
        Point(station["coordinates"]["longitude"], station["coordinates"]["latitude"])
        for station in stations.values()
        if "coordinates" in station
    ]
    reached = sorted(
        name
        for name, area in areas.items()
        if name != config.name and any(area.contains(point) for point in points)
    )
    return reached


def write_reach(config: NetworkConfig, cities: Iterable[str]) -> None:
    """Leave the result where `build_network.py` picks it up when it writes `network.json`."""
    path = config.reach_cache_path
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        json.dump(list(cities), handle, ensure_ascii=False, indent=2)
        handle.write("\n")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--network", required=True, help="Network id, i.e. the name of a file in networks/")
    args = parser.parse_args()

    config = load_network_config(args.network)
    try:
        stations = load_stations(config)
        cities = cities_reached(config, stations, city_areas(config, stations))
    except ReachUnavailable as error:
        raise SystemExit(f"[FAIL] {error}") from error

    write_reach(config, cities)
    print(
        f"[DONE] {config.id} also reaches {len(cities)} city(s): {', '.join(cities) or 'none'}",
        file=sys.stderr,
    )


if __name__ == "__main__":
    main()
