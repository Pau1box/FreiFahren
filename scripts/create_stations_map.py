"""
Map a network's station ids to the routing engine's station ids.

Run it through the pipeline rather than directly:

    python3 scripts/build_network.py --network zuerich --with-station-map

The result, `stationsMap.prod.json`, is what the Go backend's itinerary feature routes with
(`packages/backend/api/itineraries/navigation.go`). A network without the file is served without
routing rather than failing, so a station that cannot be mapped is simply left out.

Three sources, in that order, each answering what the one before it could not:

1. **OpenStreetMap `ref:IFOPT`.** The tag carries the DELFI station id (DHID), which is exactly the
   id the engine's German feed is keyed by, so this is an identifier match rather than a name match.
   One Overpass query covers a whole network. Its weakness is coverage, which is a matter of what
   each federal state imported: Munich's stations carry it, Bremen's and Berlin's mostly do not.
2. **The transitous geocoder, asked by name.** One request per station, confirmed by distance.
   Slow and fuzzier, which is why it only runs for what step 1 did not answer.
3. **The same geocoder, asked by coordinate.** Step 2 has a blind spot that better queries do not
   close: the feed indexes a stop under its own town, so a suburb stop is unreachable by any query
   naming the city, and the endpoint always returns five hits by relevance, which in a dense area
   are five addresses. Asking what stops are near a point does not depend on the name at all. Of
   the 158 stations step 2 could not place, naming the city solved 5 and this solved 156.

Every id from step 1 is checked against the engine before it is kept, because the tag is a claim
about the DELFI id and the feed does not carry all of them at station level. What the check rejects
falls through to step 2 rather than being dropped. A request that never reaches the engine is not
an answer either way, so it is not treated as one: enough of them in a row stop the step rather than
let it write a file whose entries were never checked.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from datetime import datetime, timezone
from typing import Dict, List, NamedTuple, Optional, Tuple, cast

import requests

from geo import haversine
from network_config import USER_AGENT, Bounds, Coordinates, NetworkConfig, load_network_config
from overpass import OverpassError
from overpass import query as overpass_query

# The engine addresses a German stop as `<feed id>_<DHID>`. `de-DELFI` is transitous' nationwide
# DELFI feed, which covers every network in `networks/`, so this is a constant rather than a per
# network setting.
ENGINE_FEED_PREFIX = "de-DELFI_"

# A DHID reads `<country>:<municipality key>:<stop>[:<area>[:<platform>]]`. The engine resolves the
# three part station level; the deeper platform level it does not, so a platform's tag is truncated.
DHID_STATION_PARTS = 3

# How far from our merged station coordinate an IFOPT reference may sit. A merged station spans up
# to `mergeRadiusMeters` from its centre and the tagged node can be at the far end of a platform
# beyond that, so the search reaches further than the merge did.
SEARCH_MARGIN_METERS = 150.0

# Margin on the queried box. Stations sit inside it by construction; this only guards the edge.
BBOX_MARGIN_KM = 1.0

# How many verification failures in a row, with nothing verified yet, count as "wrong feed".
FEED_MISMATCH_STREAK = 10
# Transport failures in a row that mean the engine is down rather than one request being unlucky.
# Lower than the streak above on purpose: that one distinguishes two kinds of answer, this one is
# the absence of any answer, and continuing past it produces a file nobody checked.
ENGINE_UNREACHABLE_STREAK = 5

# Two candidates within this distance of each other count as equally close, and the object type
# decides between them. Below it the difference is tagging noise rather than a different place.
TYPE_TIEBREAK_METERS = 50.0

# The IFOPT query is one cheap request that can be repeated later, and while the fleet build runs it
# competes with the geometry downloads, which cannot. So it tries briefly and yields.
OSM_QUERY_ATTEMPTS = 2

# Exit code for "Overpass was busy, come back later", distinct from a real failure so a runner can
# requeue the network instead of treating it as broken. 75 is the conventional EX_TEMPFAIL.
EXIT_OVERPASS_BUSY = 75


# How far a geocoder hit may sit from our station before it counts as a different place. Wider than
# the IFOPT radius would start accepting the next stop along the line.
GEOCODER_MAX_DISTANCE_METERS = 500.0

# A best hit further than this is close enough to be accepted but far enough to be worth a second
# query without the city name. Half the acceptance radius: below it the answer is the platform we
# are looking at, above it we are usually looking at the stop next door.
GEOCODER_RETRY_DISTANCE_METERS = 250.0

GEOCODE_URL = "https://api.transitous.org/api/v1/geocode"
REVERSE_GEOCODE_URL = "https://api.transitous.org/api/v1/reverse-geocode"
STOPTIMES_URL = "https://api.transitous.org/api/v1/stoptimes"
# transitous is donated infrastructure and this is the only part of the pipeline that hits it once
# per station, so it waits between requests.
REQUEST_DELAY_SECONDS = 0.2


class Candidate(NamedTuple):
    """One OpenStreetMap object carrying a `ref:IFOPT`, reduced to what the match needs."""

    dhid: str
    name: str
    coordinates: Coordinates
    # Whether the object is the station itself rather than one of its platforms. Both carry the same
    # station id, so this only breaks ties.
    is_station: bool


def normalise_name(name: str) -> str:
    """
    Reduce a stop name to what two spellings of the same place have in common.

    OpenStreetMap, DELFI and the geocoder disagree on decoration rather than on places: `S+U
    Alexanderplatz Bhf`, `Alexanderplatz (Berlin)`, `Alexanderplatz`. Stripping the decoration is
    what lets a name confirm a match instead of merely suggesting one.
    """
    lowered = name.lower().replace("ß", "ss").replace("strasse", "str").replace("straße", "str")
    for noise in ("bahnhof", "bhf", "s+u ", "s ", "u ", "bf "):
        lowered = lowered.replace(noise, " ")
    return "".join(character for character in lowered if character.isalnum())


def station_dhid(raw: str) -> Optional[str]:
    """
    The station level DHID of a `ref:IFOPT` value, or `None` when the tag is not one.

    Truncating to three parts is what makes a platform's tag usable: `de:11000:900003103:1:50` and
    `de:11000:900003103:1` name the same station, and only the truncated form is a place the engine
    can route from.
    """
    parts = raw.strip().split(":")
    if len(parts) < DHID_STATION_PARTS or not parts[2]:
        return None
    return ":".join(parts[:DHID_STATION_PARTS])


def build_query(box: Bounds) -> str:
    """
    Overpass query for every public transport object in the box that carries a `ref:IFOPT`.

    Stations and platforms both, because whether a city tags the reference on the station node or
    only on its platform edges varies by mapper and either answers the same question.
    """
    scope = (
        f"({box.south_west.latitude},{box.south_west.longitude},"
        f"{box.north_east.latitude},{box.north_east.longitude})"
    )
    return f"""
[out:json][timeout:900];
(
  node["ref:IFOPT"]["public_transport"]{scope};
  node["ref:IFOPT"]["railway"]{scope};
  way["ref:IFOPT"]["public_transport"]{scope};
  way["ref:IFOPT"]["railway"]{scope};
  relation["ref:IFOPT"]["public_transport"]{scope};
);
out center tags;
"""


def parse_candidates(elements: List[dict]) -> List[Candidate]:
    """Keep the Overpass elements that carry both a usable DHID and a position."""
    candidates: List[Candidate] = []
    for element in elements:
        tags = element.get("tags", {})
        dhid = station_dhid(tags.get("ref:IFOPT", ""))
        if dhid is None:
            continue

        center = element.get("center", {})
        latitude = element.get("lat", center.get("lat"))
        longitude = element.get("lon", center.get("lon"))
        if latitude is None or longitude is None:
            continue

        candidates.append(
            Candidate(
                dhid=dhid,
                name=tags.get("name", ""),
                coordinates=Coordinates(latitude=latitude, longitude=longitude),
                is_station=tags.get("public_transport") in ("station", "stop_area")
                or tags.get("railway") in ("station", "halt"),
            )
        )
    return candidates


def names_match(wanted: str, other: str) -> bool:
    """
    Whether two normalised stop names describe the same place.

    Containment rather than equality, because one side routinely carries the other plus a qualifier
    (`Hauptbahnhof` against `Muenchen Hauptbahnhof`). The length floor keeps a short name like `Ost`
    from matching every stop that happens to contain it.
    """
    if not wanted or not other:
        return False
    if wanted == other:
        return True
    return (len(wanted) >= 5 and wanted in other) or (len(other) >= 5 and other in wanted)


def match_ifopt(station: dict, candidates: List[Candidate], radius: float) -> Optional[str]:
    """
    Pick the DHID belonging to one of our stations, or `None` when nothing convinces.

    The name ranks first, because it decides *whether* a candidate is this stop at all. Our stations
    are merged across modes, so the search radius is wide enough to contain several real stops, and
    without the name the nearest neighbouring one would win. Berlin's hand made map shows that
    failure: it had mapped Wannsee to the `Wannseebrücke` bus stop next door.

    Distance ranks second, ahead of the object type, because among candidates that are all this stop
    the distance decides *which* of them is meant. Preferring a station node cost us Lichtenberg: our
    station is the tram stop on Siegfriedstrasse, and the station node 209 m away won over the
    platform 51 m away purely for being the tidier object. The type only breaks a tie, where the two
    are equally close and the more stable object is the better bet.
    """
    wanted_name = normalise_name(station["name"])

    scored: List[Tuple[int, float, int, str]] = []
    for candidate in candidates:
        distance = haversine(
            station["coordinates"],
            {
                "latitude": candidate.coordinates.latitude,
                "longitude": candidate.coordinates.longitude,
            },
        )
        if distance > radius:
            continue
        # Sorted ascending, so the better option has to compare smaller. Distance is rounded into
        # buckets so that "equally close" is a real tie the type can then decide.
        scored.append(
            (
                0 if names_match(wanted_name, normalise_name(candidate.name)) else 1,
                round(distance / TYPE_TIEBREAK_METERS),
                0 if candidate.is_station else 1,
                candidate.dhid,
            )
        )

    if not scored:
        return None

    name_mismatch, _, not_a_station, dhid = min(scored)
    # A candidate that neither carries the station's name nor is a station node is a neighbouring
    # stop as easily as the right one. Dropping it costs a route; keeping it invents a wrong one.
    if name_mismatch and not_a_station:
        return None
    return dhid


def resolve_from_osm(stations: Dict[str, dict], config: NetworkConfig) -> Dict[str, str]:
    """
    Map as many stations as OpenStreetMap carries a DELFI reference for.

    The box is drawn around the stations themselves rather than around the network's configured
    area, because the two differ where it matters: Berlin's area is the city boundary, but its S1
    ends in Oranienburg and those stations need a reference just as much.
    """
    points = [Coordinates(**station["coordinates"]) for station in stations.values()]
    box = Bounds.around(points, margin_km=BBOX_MARGIN_KM)

    print(f"[INFO] Fetching IFOPT references for {config.name} from Overpass ...", file=sys.stderr, flush=True)
    candidates = parse_candidates(overpass_query(build_query(box), attempts=OSM_QUERY_ATTEMPTS))
    print(f"[STAT] IFOPT references in the box: {len(candidates)}", file=sys.stderr)

    radius = config.stations.merge_radius_meters + SEARCH_MARGIN_METERS
    resolved: Dict[str, str] = {}
    for station_id, station in stations.items():
        dhid = match_ifopt(station, candidates, radius)
        if dhid is not None:
            resolved[station_id] = f"{ENGINE_FEED_PREFIX}{dhid}"
    return resolved


def engine_resolves(session: requests.Session, engine_id: str) -> Optional[bool]:
    """
    Whether the engine knows this id as a stop it can route from, or `None` when it could not be asked.

    An IFOPT tag is only a claim about the DELFI id, and about one stop in eight the DELFI feed does
    not carry that id at station level. The backend hands the mapped id straight to the engine as
    `fromPlace`, so an id that does not resolve is worse than no entry at all: it turns a clear
    "unknown station" into a failed routing request. Asking once at build time is what keeps that
    out of the shipped file.

    The departure board is only the cheapest question that needs the id resolved; whether anything
    departs right now is irrelevant, only whether the engine recognises the stop at all.
    """
    probe_time = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    try:
        response = session.get(
            STOPTIMES_URL,
            params={"stopId": engine_id, "time": probe_time, "n": 1},
            timeout=20,
            headers={"User-Agent": USER_AGENT},
        )
    except requests.RequestException as error:
        # A failed request says nothing about the id, either way. Treating it as a pass would ship a
        # file that looks verified and fails at routing time, treating it as a failure would drop
        # routing everywhere during an outage, so the caller is told the question went unanswered.
        print(f"[WARN] Could not verify {engine_id}: {error}", file=sys.stderr)
        return None
    return response.status_code == 200


def drop_unroutable(session: requests.Session, mapping: Dict[str, str]) -> Dict[str, str]:
    """
    Keep only the entries the engine can actually route from.

    A whole network can fail here rather than a few stations, because not every region reaches the
    engine through the DELFI feed. Braunschweig arrives via `de-VBN`, whose stop ids are opaque
    numbers rather than DHIDs, so no IFOPT tag there can ever resolve. Once the first few in a row
    have failed, that is what is happening, and asking again for every remaining station only costs
    someone else's bandwidth to learn the same thing.
    """
    if not mapping:
        return {}

    print(f"[INFO] Verifying {len(mapping)} ids against the engine ...", file=sys.stderr)
    verified: Dict[str, str] = {}
    consecutive_failures = 0
    unanswered = 0
    for index, (station_id, engine_id) in enumerate(mapping.items(), start=1):
        resolved = engine_resolves(session, engine_id)
        if resolved is None:
            # The engine is unreachable, not disagreeing. Carrying on would write a file whose
            # entries were never checked, and the README promises every one of them was, so the
            # step stops instead and says which state the data is in.
            unanswered += 1
            if unanswered >= ENGINE_UNREACHABLE_STREAK:
                raise SystemExit(
                    f"[FAIL] {unanswered} verification requests in a row could not reach the engine. "
                    "Stopping rather than writing a stationsMap.prod.json whose ids were never "
                    "checked. The other outputs of this network are already written and valid, so "
                    "rerunning only this step is enough."
                )
            continue
        unanswered = 0
        if resolved:
            verified[station_id] = engine_id
            consecutive_failures = 0
        else:
            consecutive_failures += 1
            if consecutive_failures >= FEED_MISMATCH_STREAK and not verified:
                print(
                    f"\n[WARN] {consecutive_failures} ids in a row unknown to the engine,"
                    f" this network is not served from the DELFI feed. Falling back to the geocoder.",
                    file=sys.stderr,
                )
                return {}
        print(f"  ({index}/{len(mapping)})", end="\r", file=sys.stderr)
        time.sleep(REQUEST_DELAY_SECONDS)
    print(file=sys.stderr)
    return verified


def geocode_hits(
    session: requests.Session, text: str, station: dict, station_id: str
) -> List[Tuple[float, str]]:
    """Ask the geocoder once and return its stops as `(distance, engine id)`, nearest first."""
    try:
        response = session.get(
            GEOCODE_URL, params={"text": text}, timeout=20, headers={"User-Agent": USER_AGENT}
        )
        response.raise_for_status()
        results = response.json()
    except (requests.RequestException, ValueError) as error:
        print(f"[WARN] Geocoder failed for {station_id} ({station['name']}): {error}", file=sys.stderr)
        return []

    if not isinstance(results, list):
        return []

    hits = []
    for result in results:
        if not isinstance(result, dict) or result.get("type") != "STOP":
            continue
        if "lat" not in result or "lon" not in result or not result.get("id"):
            continue
        distance = haversine(
            station["coordinates"], {"latitude": result["lat"], "longitude": result["lon"]}
        )
        if distance <= GEOCODER_MAX_DISTANCE_METERS:
            hits.append((distance, cast(str, result["id"])))
    return sorted(hits)


def geocode_station(
    session: requests.Session, station_id: str, station: dict, config: NetworkConfig
) -> Optional[str]:
    """
    Ask the transitous geocoder for the engine id of one station.

    The query carries the mode hint from our id prefix and the city name, because geocoders index
    German stations under their type: a bare `Alexanderplatz` finds the square, `S+U Alexanderplatz
    (Berlin)` finds the station. Distance is the only check available when matching by name, so the
    nearest stop the geocoder considered relevant wins and anything further than
    `GEOCODER_MAX_DISTANCE_METERS` is not this station at all.

    The city name misleads the geocoder for the stations a network reaches beyond its own city, and
    those are exactly the ones a bounding box was drawn wide for. `S Flughafen BER (Berlin)` returns
    the Willy-Brandt-Platz stop 331 m away, because the airport is in Brandenburg; the same query
    without the city returns the station itself. So a distant best hit is retried without the city
    and the nearer of the two wins. The retry is conditional rather than always, because a second
    request per station would double what this asks of a donated service to fix a handful of stops.
    """
    name = station["name"].replace("straße", "str")
    prefix = config.stations.geocode_prefix(station_id)

    hits = geocode_hits(session, f"{prefix}{name} ({config.name})", station, station_id)
    if not hits or min(hits)[0] > GEOCODER_RETRY_DISTANCE_METERS:
        time.sleep(REQUEST_DELAY_SECONDS)
        hits += geocode_hits(session, f"{prefix}{name}", station, station_id)

    return best_hit(hits)


def resolve_from_geocoder(
    session: requests.Session, stations: Dict[str, dict], station_ids: List[str], config: NetworkConfig
) -> Dict[str, str]:
    """Fill the gaps OpenStreetMap left, one geocoder request per remaining station."""
    if not station_ids:
        return {}

    print(f"[INFO] Geocoding {len(station_ids)} stations without a usable reference ...", file=sys.stderr)
    resolved: Dict[str, str] = {}
    for index, station_id in enumerate(station_ids, start=1):
        engine_id = geocode_station(session, station_id, stations[station_id], config)
        if engine_id is not None:
            resolved[station_id] = engine_id
        print(f"  ({index}/{len(station_ids)})", end="\r", file=sys.stderr)
        time.sleep(REQUEST_DELAY_SECONDS)
    print(file=sys.stderr)
    return resolved


def best_hit(hits: List[Tuple[float, str]]) -> Optional[str]:
    """The stop to keep out of everything close enough, nearest first but a German feed first of all.

    The engine serves feeds from other countries and from operators that are not local transit, and
    they overlap us at exactly the places that draw everyone: stations and airports. Purely by
    distance, Munich Airport Terminal resolved to `MUC` in an Italian flight dataset, and seven
    main stations resolved to the long distance coach stop in front of them rather than to the
    station. Both are the right place on a map and the wrong answer for a journey, because routing
    from them offers only that operator's departures.

    A foreign feed is still better than nothing, and sometimes it is simply right: the Belgian and
    Austrian railway datasets carry German stations under correct German ids, which is how three
    stops on the line to Brussels are mapped. So this orders rather than filters.
    """
    if not hits:
        return None
    return min(hits, key=lambda hit: (not hit[1].startswith("de-"), hit[0]))[1]


def stop_near_position(
    session: requests.Session, station_id: str, station: dict
) -> Optional[str]:
    """
    Ask the engine which of its stops sits at our coordinate, ignoring names entirely.

    This is the last resort and it catches what the name based query cannot, which is a name the
    engine's index does not hold under that spelling. It is common in a network that spans several
    towns, because a stop is indexed under the town it is in rather than the one the network is
    named after: our `Berliner Straße` in the Rhine-Ruhr network is `Witten Berliner Str.` there,
    and no query built from our name and our network's city finds it.

    Only a stop within the same radius the geocoder is held to is accepted, so this stays a lookup
    rather than a guess.
    """
    coordinates = station["coordinates"]
    try:
        response = session.get(
            REVERSE_GEOCODE_URL,
            # `type=STOP` is not a convenience. The endpoint answers with five results whatever is
            # asked, sorted by relevance rather than distance, and in a built up area addresses and
            # shops fill all five before a stop appears. Ludwigshafen's `Amtsgericht` stop is 30 m
            # from our coordinate and was invisible without this.
            params={
                "place": f"{coordinates['latitude']},{coordinates['longitude']}",
                "type": "STOP",
            },
            timeout=20,
            headers={"User-Agent": USER_AGENT},
        )
        response.raise_for_status()
        results = response.json()
    except (requests.RequestException, ValueError) as error:
        print(f"[WARN] Reverse geocoder failed for {station_id} ({station['name']}): {error}", file=sys.stderr)
        return None

    if not isinstance(results, list):
        return None

    hits = []
    for result in results:
        if not isinstance(result, dict) or result.get("type") != "STOP":
            continue
        if "lat" not in result or "lon" not in result or not result.get("id"):
            continue
        distance = haversine(
            coordinates, {"latitude": result["lat"], "longitude": result["lon"]}
        )
        if distance <= GEOCODER_MAX_DISTANCE_METERS:
            hits.append((distance, cast(str, result["id"])))

    return best_hit(hits)


def resolve_from_position(
    session: requests.Session, stations: Dict[str, dict], station_ids: List[str]
) -> Dict[str, str]:
    """Fill what neither the tag nor the name could place, using the coordinate alone."""
    if not station_ids:
        return {}

    print(f"[INFO] Looking up {len(station_ids)} stations by position ...", file=sys.stderr)
    resolved: Dict[str, str] = {}
    for index, station_id in enumerate(station_ids, start=1):
        engine_id = stop_near_position(session, station_id, stations[station_id])
        if engine_id is not None:
            resolved[station_id] = engine_id
        print(f"  ({index}/{len(station_ids)})", end="\r", file=sys.stderr)
        time.sleep(REQUEST_DELAY_SECONDS)
    print(file=sys.stderr)
    return resolved


def build_stations_map(
    stations: Dict[str, dict], config: NetworkConfig, with_osm: bool, with_geocoder: bool
) -> Dict[str, str]:
    """Resolve every station to an engine id, leaving out the ones neither source knows."""
    stations_map = resolve_from_osm(stations, config) if with_osm else {}
    tagged = len(stations_map)

    with requests.Session() as session:
        stations_map = drop_unroutable(session, stations_map)
        from_osm = len(stations_map)
        if tagged > from_osm:
            print(f"[STAT] IFOPT ids the engine does not know: {tagged - from_osm}", file=sys.stderr)

        from_geocoder = 0
        from_position = 0
        if with_geocoder:
            remaining = [station_id for station_id in stations if station_id not in stations_map]
            by_name = resolve_from_geocoder(session, stations, remaining, config)
            stations_map.update(by_name)
            from_geocoder = len(by_name)

            # Last resort, and it earns its place: over the fleet it placed 100 of the 158 stations
            # the name based query had given up on, all of them within 40 m.
            remaining = [station_id for station_id in stations if station_id not in stations_map]
            by_position = resolve_from_position(session, stations, remaining)
            stations_map.update(by_position)
            from_position = len(by_position)

    total = len(stations)
    matched = len(stations_map)
    share = 100 * matched / total if total else 0
    # Three states per source, not a number that collapses two of them: a source that was switched
    # off is not the same finding as one that was asked and came back empty, and a log that prints 0
    # for both cannot tell a dead source from an unused one.
    if not with_osm:
        osm_report = "OpenStreetMap not queried"
    elif from_osm == 0:
        osm_report = "OpenStreetMap queried, nothing usable"
    else:
        osm_report = f"{from_osm} from OpenStreetMap"
    if not with_geocoder:
        engine_report = "engine not queried"
    else:
        engine_report = f"{from_geocoder} by name, {from_position} by position"
    print(
        f"[STAT] Mapped {matched}/{total} stations ({share:.0f}%): {osm_report}, {engine_report}",
        file=sys.stderr,
    )
    if matched < total:
        missing = [station_id for station_id in stations if station_id not in stations_map]
        print(f"[STAT] Unmapped: {', '.join(missing[:20])}", file=sys.stderr)

    # Keyed insertion order follows the stations list, so a rebuild produces the same file unless the
    # data changed. That keeps the diff readable when this is regenerated.
    return {station_id: stations_map[station_id] for station_id in stations if station_id in stations_map}


def main() -> None:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--network", required=True, help="Network id, i.e. the name of a file in networks/")
    # The two sources hit different services, so a build can be restricted to one of them when the
    # other is busy: Overpass is shared with the rest of the pipeline, transitous is not.
    sources = parser.add_mutually_exclusive_group()
    sources.add_argument(
        "--osm-only",
        action="store_true",
        help="Skip the geocoder and map only what OpenStreetMap carries a ref:IFOPT for",
    )
    sources.add_argument(
        "--geocoder-only",
        action="store_true",
        help="Skip Overpass entirely and resolve every station through the transitous geocoder",
    )
    args = parser.parse_args()

    config = load_network_config(args.network)

    stations_path = config.backend_seed_dir / "StationsList.json"
    if not stations_path.is_file():
        raise SystemExit(f"{stations_path} is missing. Run create_stations_list.py first.")
    with stations_path.open(encoding="utf-8") as handle:
        stations = cast(Dict[str, dict], json.load(handle))
    if not isinstance(stations, dict) or not stations:
        raise SystemExit(f"{stations_path} must contain a non empty object keyed by station id")

    try:
        stations_map = build_stations_map(
            stations, config, with_osm=not args.geocoder_only, with_geocoder=not args.osm_only
        )
    except OverpassError as error:
        # Not a failure of this network, only of this moment. Exiting distinctly lets a fleet runner
        # come back to it rather than shipping a map built from the geocoder alone.
        print(f"[WARN] Overpass is busy, {config.id} needs another try later: {error}", file=sys.stderr)
        raise SystemExit(EXIT_OVERPASS_BUSY) from error

    output_path = config.backend_seed_dir / "stationsMap.prod.json"
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open("w", encoding="utf-8") as handle:
        json.dump(stations_map, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
    print(f"[DONE] {output_path} written", file=sys.stderr)


if __name__ == "__main__":
    main()
