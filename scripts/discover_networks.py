"""
Discover every urban rail network in a country and write a `networks/<id>.yaml` for each.

    python3 scripts/discover_networks.py --country DE --write

Without `--write` it only prints what it found, which is the way to review the result before 60
files appear in the working tree.

The point is that the network list is derived rather than typed out. A hand written list of German
tram cities is wrong the moment a city opens or closes a line, and it silently omits whatever the
author forgot. Two Overpass queries answer it from the map itself:

  1. every `subway`, `light_rail` and `tram` route relation in the country,
  2. every populated place, so a network can be named after its largest city.

A network here is a connected transit system, not a municipality. Routes whose midpoints lie within
`CLUSTER_RADIUS_KM` of each other are one network, because that is what an interchange looks like
from above. Karlsruhe reaches Baden-Baden and Pforzheim on the same Stadtbahn, and splitting that by
city boundary would invent three networks where riders experience one.

`train` is deliberately not queried. In OpenStreetMap it carries every ICE and EC in the country as
well as most S-Bahn systems, so it can only be taken with a line rule. The generated file gets that
rule when the network's city has an S-Bahn, and `scripts/network_config.py` documents the syntax.
"""

from __future__ import annotations

import argparse
import json
import math
import re
import sys
import unicodedata
from collections import Counter, defaultdict
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import yaml

import overpass
from network_config import NETWORKS_DIR
from place_names import clean_place_name

# Routes closer than this to one another count as the same network. 25 km is wide enough to hold a
# city and its suburban branches together, and narrow enough to keep Cologne apart from the Ruhr.
CLUSTER_RADIUS_KM = 25.0

# How far outside the known route midpoints the search box reaches. A relation's midpoint sits in
# the middle of its route, so the network extends roughly half a line beyond it in every direction.
SEARCH_MARGIN_KM = 20.0

# Below this a cluster is a heritage or single line operation rather than an urban network.
MIN_ROUTES_PER_NETWORK = 3

# A place needs this many inhabitants to lend a network its name, so that a network is not named
# after the village its longest line happens to end in.
MIN_POPULATION = 20000

# Operators whose lines reach across the border into the country being discovered. Their networks
# belong to the neighbouring country, and a few stops on this side do not make them ours.
FOREIGN_OPERATORS = frozenset(
    {
        "Compagnie des Transports Strasbourgeois",
        "BVB",
    }
)

MODES = ("subway", "light_rail", "tram")

KM_PER_DEGREE = 111.32


def distance_km(a: Tuple[float, float], b: Tuple[float, float]) -> float:
    """Flat earth distance, which is accurate enough over the tens of kilometres used here."""
    lat_km = (a[0] - b[0]) * KM_PER_DEGREE
    lon_km = (a[1] - b[1]) * KM_PER_DEGREE * math.cos(math.radians((a[0] + b[0]) / 2))
    return math.hypot(lat_km, lon_km)


def fetch_routes(country: str) -> List[dict]:
    """Every urban rail route relation in the country, with the midpoint of each."""
    modes = "|".join(MODES)
    elements = overpass.query(
        f"""[out:json][timeout:900];
area["ISO3166-1"="{country}"]["admin_level"="2"]->.country;
relation["type"="route"]["route"~"^({modes})$"](area.country);
out tags center;"""
    )

    routes = []
    for element in elements:
        center = element.get("center")
        if center is None:
            continue
        tags = element.get("tags", {})
        routes.append(
            {
                "ref": tags.get("ref"),
                "route": tags.get("route"),
                "operator": tags.get("operator"),
                "lat": center["lat"],
                "lon": center["lon"],
            }
        )
    return routes


def fetch_places(country: str) -> List[dict]:
    """Cities and towns with a population figure, used only to name and centre a network."""
    elements = overpass.query(
        f"""[out:json][timeout:600];
area["ISO3166-1"="{country}"]["admin_level"="2"]->.country;
node["place"~"^(city|town)$"]["population"](area.country);
out tags center;"""
    )

    places = []
    for element in elements:
        tags = element.get("tags", {})
        name = tags.get("name")
        if not name:
            continue
        # Population is written with thousands separators often enough to be worth stripping.
        digits = re.sub(r"[^0-9]", "", tags.get("population", ""))
        if not digits:
            continue
        population = int(digits)
        if population < MIN_POPULATION:
            continue
        places.append({"name": name, "population": population, "lat": element["lat"], "lon": element["lon"]})
    return places


def cluster_routes(routes: List[dict]) -> List[List[dict]]:
    """
    Group routes into connected systems by single link clustering on their midpoints.

    Single link rather than a fixed grid, because a system is chained together: Duisburg is far from
    Dortmund, but every step in between is short, and riders can travel the whole way.
    """
    parent = list(range(len(routes)))

    def find(index: int) -> int:
        while parent[index] != index:
            parent[index] = parent[parent[index]]
            index = parent[index]
        return index

    def union(left: int, right: int) -> None:
        left_root, right_root = find(left), find(right)
        if left_root != right_root:
            parent[left_root] = right_root

    points = [(route["lat"], route["lon"]) for route in routes]
    for i in range(len(points)):
        for j in range(i + 1, len(points)):
            if distance_km(points[i], points[j]) <= CLUSTER_RADIUS_KM:
                union(i, j)

    grouped: Dict[int, List[dict]] = defaultdict(list)
    for index, route in enumerate(routes):
        grouped[find(index)].append(route)
    return list(grouped.values())


def slugify(name: str) -> str:
    """A network id: lowercase ASCII, which is what the id column and the URL parameter allow."""
    text = clean_place_name(name).lower()
    for umlaut, replacement in (("ä", "ae"), ("ö", "oe"), ("ü", "ue"), ("ß", "ss")):
        text = text.replace(umlaut, replacement)
    text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]+", "-", text).strip("-")


def name_cluster(cluster: List[dict], places: List[dict]) -> Optional[dict]:
    """The largest place near the cluster's centre, which is the city the network is known by."""
    center = (
        sum(route["lat"] for route in cluster) / len(cluster),
        sum(route["lon"] for route in cluster) / len(cluster),
    )
    nearby = [place for place in places if distance_km(center, (place["lat"], place["lon"])) <= CLUSTER_RADIUS_KM]
    if not nearby:
        return None
    return max(nearby, key=lambda place: place["population"])


def describe(cluster: List[dict], places: List[dict]) -> Optional[dict]:
    """Everything needed to write one network file, or None if the cluster is not a network."""
    usable = [route for route in cluster if route["operator"] not in FOREIGN_OPERATORS]
    if len(usable) < MIN_ROUTES_PER_NETWORK:
        return None

    city = name_cluster(usable, places)
    if city is None:
        return None

    lats = [route["lat"] for route in usable]
    lons = [route["lon"] for route in usable]
    margin_lat = SEARCH_MARGIN_KM / KM_PER_DEGREE
    margin_lon = SEARCH_MARGIN_KM / (KM_PER_DEGREE * math.cos(math.radians(city["lat"])))

    # Which other cities the system reaches, so the generated file can say so rather than pretending
    # a network named Duesseldorf stops at the city limits.
    served = sorted(
        {
            place["name"]
            for place in places
            if place["population"] >= 100000
            and min(distance_km((place["lat"], place["lon"]), (r["lat"], r["lon"])) for r in usable) <= 10
        }
    )

    return {
        "id": slugify(city["name"]),
        "name": clean_place_name(city["name"]),
        "center": {"latitude": round(city["lat"], 4), "longitude": round(city["lon"], 4)},
        "box": {
            "south": round(min(lats) - margin_lat, 4),
            "west": round(min(lons) - margin_lon, 4),
            "north": round(max(lats) + margin_lat, 4),
            "east": round(max(lons) + margin_lon, 4),
        },
        "modes": sorted({route["route"] for route in usable}),
        "route_count": len(usable),
        "served": served,
    }


# The timezone of the countries this can be pointed at without the result needing a correction by
# hand. Deliberately not a lookup by coordinate: that means another dependency and a data file, to
# answer a question that only has a wrong answer for countries nobody has run this against.
TIMEZONE_BY_COUNTRY = {
    "DE": "Europe/Berlin",
    "AT": "Europe/Vienna",
    "CH": "Europe/Zurich",
    "NL": "Europe/Amsterdam",
    "BE": "Europe/Brussels",
    "PL": "Europe/Warsaw",
    "CZ": "Europe/Prague",
    "DK": "Europe/Copenhagen",
    "FR": "Europe/Paris",
    "LU": "Europe/Luxembourg",
}

# What is written when the country is not in that table. It is not a valid IANA name, so loading the
# description fails with a clear message instead of the network quietly running on Berlin time and
# reporting its daily curve shifted by hours.
UNKNOWN_TIMEZONE = "SET_THIS_BY_HAND"


def render_yaml(network: dict, country: str) -> str:
    """Write the file by hand rather than through a YAML dumper, to keep the comments."""
    modes = "\n".join(f"        {mode}: auto" for mode in network["modes"])

    # Only worth saying when the system genuinely leaves its home city. Deliberately without the
    # names: what this knows is which places lie within 10 km of a route's midpoint, which is not
    # the same question as which cities the built network stops in, and writing an unchecked list
    # into a file nobody regenerates is how the Leipzig description came to claim Halle a year
    # after Halle became its own network. `create_network_reach.py` answers it from the stations
    # instead, and the answer is published in `network.json` as `serves`.
    others = [name for name in network["served"] if name != network["name"]]
    reach = (
        "\n# The network is the connected system, not the municipality: it reaches beyond the city"
        "\n# limits. Which cities exactly is generated into network.json when the network is built."
        if others
        else ""
    )

    return f"""# {network['name']}. Generated by scripts/discover_networks.py, then reviewed by hand.
#{reach}
# Discovered from {network['route_count']} OpenStreetMap route relations.

id: {network['id']}
name: {network['name']}
countryCode: {country}
timezone: {TIMEZONE_BY_COUNTRY.get(country, UNKNOWN_TIMEZONE)}
# Every generated network starts in beta. It shows only reports people actually made, never
# predicted ones, because there is no history to reason from yet.
status: beta

center:
    latitude: {network['center']['latitude']}
    longitude: {network['center']['longitude']}
# Derived from the generated stations, so the map fits the network that was actually built.
bounds: auto

source:
    # A box rather than a city boundary, because the system crosses municipal borders and no single
    # administrative area contains it. The corners come from the route midpoints found in
    # OpenStreetMap plus a margin, and the validator rejects a build that spans more than 200 km.
    boundingBox:
        southWest:
            latitude: {network['box']['south']}
            longitude: {network['box']['west']}
        northEast:
            latitude: {network['box']['north']}
            longitude: {network['box']['east']}
{modes and '    modes:' + chr(10) + modes}
    lines: auto

stations:
    mergeRadiusMeters: 250
    # No plain `ref` fallback: `ref` is only unique per operator, so trusting it risks colliding with
    # another network's station id. DS100 codes are unique across Germany and node ids by construction.
    idSources: [ref:ds100, railway:ref]
"""


def existing_networks() -> List[Tuple[str, Tuple[float, float]]]:
    """
    The id and centre of every network already described in `networks/`.

    Matched by position rather than by id, because a hand written file is free to be called
    `munich.yaml` while this script would name the same city `muenchen`. Writing the second file
    would give one city two networks, each with its own copy of the same stations.
    """
    found = []
    for path in sorted(NETWORKS_DIR.glob("*.yaml")):
        try:
            config = yaml.safe_load(path.read_text(encoding="utf-8"))
            center = config["center"]
            found.append((str(config["id"]), (float(center["latitude"]), float(center["longitude"]))))
        except (KeyError, TypeError, ValueError, yaml.YAMLError):
            print(f"[WARN] {path.name} could not be read, treating it as absent")
    return found


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--country", default="DE", help="ISO 3166-1 code of the country to search")
    parser.add_argument("--write", action="store_true", help="Write the files instead of only listing them")
    parser.add_argument("--cache", type=Path, help="Read and write the Overpass answers here, to avoid refetching")
    args = parser.parse_args()

    if args.cache is not None and args.cache.exists():
        cached = json.loads(args.cache.read_text(encoding="utf-8"))
        routes, places = cached["routes"], cached["places"]
        print(f"Using cached data: {len(routes)} routes, {len(places)} places")
    else:
        print("Querying OpenStreetMap, this takes a few minutes", flush=True)
        routes = fetch_routes(args.country)
        places = fetch_places(args.country)
        if args.cache is not None:
            args.cache.write_text(json.dumps({"routes": routes, "places": places}), encoding="utf-8")
        print(f"Found {len(routes)} routes and {len(places)} places")

    networks = [describe(cluster, places) for cluster in cluster_routes(routes)]
    networks = [network for network in networks if network is not None]
    networks.sort(key=lambda network: -network["route_count"])

    duplicates = [network_id for network_id, count in Counter(n["id"] for n in networks).items() if count > 1]
    if duplicates:
        raise SystemExit(f"[FAIL] two clusters produced the same id: {duplicates}. Adjust CLUSTER_RADIUS_KM.")

    known = existing_networks()

    def already_described(network: dict) -> Optional[str]:
        """The id of an existing network covering the same city, if there is one."""
        center = (network["center"]["latitude"], network["center"]["longitude"])
        for network_id, known_center in known:
            if distance_km(center, known_center) <= CLUSTER_RADIUS_KM:
                return network_id
        return None

    for network in networks:
        existing = already_described(network)
        marker = f"exists as {existing}" if existing else "new"
        print(f"{network['route_count']:4} routes  {network['id']:<24} {','.join(network['modes']):<26} {marker}")

    if not args.write:
        print(f"\n{len(networks)} networks found. Rerun with --write to create the files.")
        return

    if args.country not in TIMEZONE_BY_COUNTRY:
        print(
            f"[WARN] No timezone known for {args.country}. The files are written with "
            f"'{UNKNOWN_TIMEZONE}', which the network description rejects until it is filled in.",
            file=sys.stderr,
        )

    written = 0
    for network in networks:
        # Never overwrite or duplicate: berlin.yaml and hamburg.yaml carry hand written decisions
        # that no generator can reconstruct.
        if already_described(network) is not None:
            continue
        (NETWORKS_DIR / f"{network['id']}.yaml").write_text(
            render_yaml(network, args.country), encoding="utf-8"
        )
        written += 1
    print(f"\n{written} files written to {NETWORKS_DIR}, {len(networks) - written} left untouched.")


if __name__ == "__main__":
    sys.exit(main())
