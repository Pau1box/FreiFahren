"""
Validate the generated data of one or all networks.

    python3 scripts/validate_network.py                  # every network in networks/
    python3 scripts/validate_network.py --network hamburg

This runs in CI on every pull request that touches `networks/` or generated network data. It is the
gate that keeps a new city from breaking the ones that already work, so prefer adding a check here
over describing a rule in prose.

Exits non zero when any error is found. Warnings are printed but do not fail the run: they flag data
that is unusual rather than broken, such as a station that is not on any line.
"""

from __future__ import annotations

import argparse
import filecmp
import json
import re
import sys
from typing import Any, Dict, List

from geo import haversine
from network_config import (
    GO_BACKEND_OPTIONAL_FILES,
    GO_BACKEND_REQUIRED_FILES,
    MAX_LINE_ID_LENGTH,
    MAX_NETWORK_DIAGONAL_KM,
    MAX_STATION_ID_LENGTH,
    Coordinates,
    NetworkConfig,
    NetworkConfigError,
    load_all_network_configs,
    load_network_config,
)
# The rule that decides what a place is called, shared with the step that generates the reach so
# the two cannot disagree about a bilingual name.
from place_names import clean_place_name

# Modes a client knows how to group and filter by. `unknown` is allowed but warned about.
KNOWN_MODES = frozenset({"subway", "light_rail", "tram", "train", "unknown"})

# A hop this many times the line's second longest hop is a jump rather than a long stretch. See
# validate_line_continuity. Across the German networks built so far the largest legitimate value is
# 2.4 (Munich's S2 between Petershausen and Röhrmoos), while Erfurt's broken line 6 sat at 45.
MAX_HOP_FACTOR = 8
# Below this, the factor above says nothing: a tram whose hops are 300 m reaches it after two
# kilometres, which an outer section can plausibly have.
MIN_SUSPICIOUS_HOP_KM = 5.0

COLOR_PATTERN = re.compile(r"^#[0-9a-f]{6}$")

# An engine station id is the routing engine's feed id, an underscore, then that feed's stop id, as
# in `de-DELFI_de:11000:900003103` or `de-VBN_000120545001`. The stop id's shape is the feed's own
# business, so only the prefix and a non empty remainder are checked.
ENGINE_ID_PATTERN = re.compile(r"^[A-Za-z0-9-]+_.+$")


class Report:
    """Errors and warnings collected while validating, so one run reports everything at once."""

    def __init__(self) -> None:
        self.errors: List[str] = []
        self.warnings: List[str] = []

    def error(self, message: str) -> None:
        self.errors.append(message)

    def warn(self, message: str) -> None:
        self.warnings.append(message)


def load_json(path: Any, report: Report) -> Any:
    if not path.is_file():
        report.error(f"{path} is missing. Run scripts/build_network.py first.")
        return None
    try:
        with path.open(encoding="utf-8") as handle:
            return json.load(handle)
    except json.JSONDecodeError as error:
        report.error(f"{path} is not valid JSON: {error}")
        return None


def validate_stations(stations: Dict[str, Any], config: NetworkConfig, report: Report) -> None:
    """Check every station against the schema limits and the network's declared geography."""
    if not stations:
        report.error(f"{config.id}: StationsList.json is empty")
        return

    for station_id, info in stations.items():
        where = f"{config.id}/{station_id}"

        if len(station_id) > MAX_STATION_ID_LENGTH:
            report.error(
                f"{where}: id is {len(station_id)} characters, the stations table allows "
                f"{MAX_STATION_ID_LENGTH}"
            )

        if not info.get("name"):
            report.error(f"{where}: has no name")

        coordinates = info.get("coordinates") or {}
        if "latitude" not in coordinates or "longitude" not in coordinates:
            report.error(f"{where}: has no coordinates")
            continue

        point = Coordinates(latitude=coordinates["latitude"], longitude=coordinates["longitude"])
        if config.bounds is not None and not config.bounds.contains(point):
            # An error rather than a warning: the bounds are what a client uses to decide which
            # network a user is in, so a station outside them is unreachable from the map.
            report.error(
                f"{where}: at {point.latitude}, {point.longitude} lies outside the declared bounds. "
                "Either the bounds in the network description are too tight or the station does not "
                "belong to this network."
            )

        lines = info.get("lines") or []
        if not lines:
            report.warn(f"{where}: is not on any line and will never be reportable")
        for line in lines:
            if len(line) > MAX_LINE_ID_LENGTH:
                report.error(
                    f"{where}: line '{line}' is {len(line)} characters, the lines table allows "
                    f"{MAX_LINE_ID_LENGTH}"
                )


def validate_lines(
    lines: Dict[str, List[str]], stations: Dict[str, Any], config: NetworkConfig, report: Report
) -> None:
    """Check that every line is usable and refers only to stations of the same network."""
    if not lines:
        report.error(f"{config.id}: LinesList.json is empty")
        return

    for line_id, station_ids in lines.items():
        where = f"{config.id}/{line_id}"

        if len(station_ids) < 2:
            report.error(f"{where}: has {len(station_ids)} stations, a line needs at least two")

        unknown = [station_id for station_id in station_ids if station_id not in stations]
        if unknown:
            report.error(f"{where}: refers to stations that are not in StationsList.json: {unknown}")

        duplicates = {sid for sid in station_ids if station_ids.count(sid) > 1}
        if duplicates:
            report.error(f"{where}: lists the same station more than once: {sorted(duplicates)}")

    # A station claiming a line the line does not claim back would silently disappear from the map.
    for station_id, info in stations.items():
        for line in info.get("lines") or []:
            if line in lines and station_id not in lines[line]:
                report.warn(
                    f"{config.id}/{station_id}: claims line '{line}', but the line's station order "
                    "does not contain it"
                )


def validate_line_continuity(
    lines: Dict[str, List[str]], stations: Dict[str, Any], config: NetworkConfig, report: Report
) -> None:
    """
    Find lines that are really two lines, joined because two systems use the same designation.

    Erfurt's first build had this: Gotha's trams sat inside the queried box and also run a line 6, so
    the two ended up in one list and the resulting line jumped 32 km in a single hop. Gotha is its
    own network now, see networks/gotha.yaml.

    The distance alone is not the signal, and neither is the distance next to the line's typical hop:
    a tram train like Kassel's RT1 runs 400 m apart downtown and 6 km apart out in the country, and
    it is one line all the way. What a joined line looks like is a single hop far longer than the
    next longest one, so that is what this compares.
    """
    for line_id, station_ids in lines.items():
        points = [
            stations[station_id]["coordinates"] for station_id in station_ids if station_id in stations
        ]
        if len(points) < 4:
            continue

        hops = sorted((haversine(first, second) / 1000 for first, second in zip(points, points[1:])), reverse=True)
        longest, second_longest = hops[0], hops[1]
        if longest >= MIN_SUSPICIOUS_HOP_KM and longest > MAX_HOP_FACTOR * second_longest:
            report.warn(
                f"{config.id}/{line_id}: jumps {longest:.0f} km between two neighbouring stations "
                f"while its next longest hop is {second_longest:.1f} km. Two systems in range of this "
                "network probably share the designation. Give the other one its own description in "
                "networks/."
            )


def validate_extent(stations: Dict[str, Any], config: NetworkConfig, report: Report) -> None:
    """
    Reject a network that covers an implausible area.

    With `bounds: auto` the bounds are derived from the stations, so the containment check above
    cannot fail. This replaces it: a network far larger than any real German transit area means the
    Overpass query pulled in a long distance service or matched a whole federal state.
    """
    bounds = config.resolve_bounds(stations)
    if bounds.diagonal_km > MAX_NETWORK_DIAGONAL_KM:
        report.error(
            f"{config.id}: spans {bounds.diagonal_km:.0f} km, more than the {MAX_NETWORK_DIAGONAL_KM:.0f} km "
            "a transit network plausibly covers. Check source.modes for a mode that also carries a "
            "long distance service, 'train' being the usual one, and restrict it to the city's own "
            "lines by giving it a reference pattern instead of 'auto'. Check source.osmArea too, in "
            "case it matched an area larger than the city."
        )
    if not bounds.contains(config.center):
        report.error(f"{config.id}: the declared center lies outside the area its stations cover")


def validate_line_metadata(
    metadata: Dict[str, Any], lines: Dict[str, List[str]], config: NetworkConfig, report: Report
) -> None:
    """Check the colour and mode every client renders lines with."""
    missing = sorted(set(lines) - set(metadata))
    if missing:
        report.error(f"{config.id}: LineMetadata.json has no entry for {missing}")

    for line_id, entry in metadata.items():
        where = f"{config.id}/{line_id}"
        if line_id not in lines:
            report.warn(f"{where}: has metadata but is not a line of this network")
            continue

        if not COLOR_PATTERN.match(str(entry.get("color", ""))):
            report.error(f"{where}: color '{entry.get('color')}' is not a lowercase six digit hex colour")

        # The contract promises this field is always there, because a client distinguishes "not a
        # ring" from "the server does not know". A missing one unmarshals to false in Go and reads
        # as false in the NLP service, so the ring handling of a whole network switches itself off
        # without anything failing.
        if not isinstance(entry.get("isCircular"), bool):
            report.error(f"{where}: isCircular is {entry.get('isCircular')!r}, it has to be true or false")

        mode = entry.get("mode")
        if mode not in KNOWN_MODES:
            report.error(f"{where}: mode '{mode}' is not one of {sorted(KNOWN_MODES)}")
        elif mode == "unknown":
            report.warn(
                f"{where}: has no mode, OpenStreetMap has no route relation for it. Clients will "
                "render it without a type. Check whether the line still exists."
            )


def validate_segments(
    segments: Dict[str, Any],
    lines: Dict[str, List[str]],
    stations: Dict[str, Any],
    metadata: Dict[str, Any],
    config: NetworkConfig,
    report: Report,
) -> None:
    """Check the track geometry the map is drawn from.

    Nothing checked this file before, which is how it came to disagree with `LineMetadata.json`
    about the colour of 63 lines: the map drew Bielefeld's line 1 in `blue` and Duesseldorf's lines
    in black while the line chips beside them used the palette colour. Both files are generated, so
    the disagreement was never going to be noticed by reading either one.

    The other checks are about what the backend does with `sid`. It is the only place the line and
    the two stations of a segment are recorded, split back apart on `.` and `:`, so a segment that
    names a station the network no longer has is a segment the risk colouring can never address.
    """
    features = segments.get("features")
    if not isinstance(features, list):
        report.error(f"{config.id}: segments.json has no feature list")
        return

    # Collected per line rather than reported per segment. A wrong colour is a property of the
    # line, so a city with a palette problem would otherwise bury every other finding under some
    # thousand identical lines.
    malformed: List[str] = []
    unknown_lines: Dict[str, int] = {}
    unknown_stations: Dict[str, str] = {}
    wrong_colour: Dict[str, str] = {}
    degenerate: List[str] = []

    for feature in features:
        properties = feature.get("properties", {})
        sid = str(properties.get("sid", ""))

        line_id, _, station_pair = sid.partition(".")
        first, _, second = station_pair.partition(":")
        if not line_id or not first or not second:
            malformed.append(sid)
            continue

        if line_id not in lines:
            unknown_lines[line_id] = unknown_lines.get(line_id, 0) + 1
        for station_id in (first, second):
            if station_id not in stations:
                unknown_stations[station_id] = sid

        expected = metadata.get(line_id, {}).get("color")
        if expected is not None and properties.get("line_color") != expected:
            wrong_colour[line_id] = str(properties.get("line_color"))

        coordinates = feature.get("geometry", {}).get("coordinates")
        if not isinstance(coordinates, list) or len(coordinates) < 2:
            degenerate.append(sid)

    rebuild = f"python scripts/build_network.py --network {config.id} --with-segments"
    if malformed:
        report.error(
            f"{config.id}: {len(malformed)} segment(s) have a sid that is not "
            f"'<line>.<stationA>:<stationB>', such as '{malformed[0]}'. The backend splits it apart "
            "on exactly those two characters to find the line and the two stations."
        )
    if unknown_lines:
        report.error(
            f"{config.id}: segments on {sorted(unknown_lines)}, which are not lines of this network. "
            f"Rebuild with {rebuild}"
        )
    if unknown_stations:
        example = sorted(unknown_stations)[0]
        report.error(
            f"{config.id}: {len(unknown_stations)} segment station id(s) are not in StationsList.json, "
            f"such as '{example}' in '{unknown_stations[example]}'. The risk colouring can never "
            f"address these segments. Rebuild with {rebuild}"
        )
    if wrong_colour:
        example = sorted(wrong_colour)[0]
        report.error(
            f"{config.id}: {len(wrong_colour)} line(s) have a line_color that LineMetadata.json "
            f"disagrees with, such as '{example}' at '{wrong_colour[example]}' against "
            f"'{metadata[example]['color']}'. The map is drawn from this file and the line chips "
            f"from that one, so the two have to agree. Rebuild with {rebuild}"
        )
    if degenerate:
        report.error(
            f"{config.id}: {len(degenerate)} segment(s) have fewer than two points and draw nothing, "
            f"such as '{degenerate[0]}'"
        )


def validate_stations_map(
    stations_map: Dict[str, Any], stations: Dict[str, Any], config: NetworkConfig, report: Report
) -> None:
    """
    Check the routing engine ids, which the backend hands to the engine without looking at them.

    Errors rather than warnings, although the file itself is optional. Once it exists the backend
    trusts it in both directions: `GenerateItineraries` sends a value straight to the engine as
    `fromPlace`, and `translateEngineStationId` hands a key back to the client as a station id. A key
    that names no station of this network therefore reaches the client as a stop it cannot resolve,
    and a value that is not an engine id produces a failed routing request. Neither is unusual data
    of the kind warnings are for, both are a broken file.

    Coverage is deliberately not checked. A station the engine does not know is left out on purpose
    and the backend answers "invalid station" for it, so a partial map is the normal outcome rather
    than a defect. See `scripts/README.md`.
    """
    if not stations_map:
        report.warn(f"{config.id}: stationsMap.prod.json is empty, this network cannot plan routes")
        return

    unknown = sorted(set(stations_map) - set(stations))
    if unknown:
        report.error(
            f"{config.id}: stationsMap.prod.json maps station ids that are not in StationsList.json: "
            f"{unknown[:10]}. Regenerate it with scripts/create_stations_map.py."
        )

    for station_id, engine_id in stations_map.items():
        if not isinstance(engine_id, str) or not ENGINE_ID_PATTERN.match(engine_id):
            report.error(
                f"{config.id}/{station_id}: '{engine_id}' is not an engine station id. Expected the "
                "engine's feed prefix and a stop id, as in 'de-DELFI_de:11000:900003103'."
            )

    # Two stations sharing one engine id make the reverse translation ambiguous: the backend returns
    # whichever of them the map iteration happens to reach first, so the same route can name
    # different stations between two calls.
    by_engine_id: Dict[str, List[str]] = {}
    for station_id, engine_id in stations_map.items():
        by_engine_id.setdefault(str(engine_id), []).append(station_id)
    for engine_id, station_ids in by_engine_id.items():
        if len(station_ids) > 1:
            report.warn(
                f"{config.id}: '{engine_id}' is mapped from {sorted(station_ids)}. The engine's "
                "answer will resolve to an arbitrary one of them."
            )


def validate_synonyms(stations: Dict[str, Any], config: NetworkConfig, report: Report) -> None:
    """
    Every station has to have an entry in the network's synonym list.

    The station extractor resolves a fuzzy match only through this list, so a station missing from
    it cannot be recognised in a message, and nothing logs a failure: the report is stored with no
    station at all. That is not hypothetical. `berlin.yaml` used to restrict the list to the stops
    of lines matching `^[MSU]`, which left 125 of Berlin's 619 stations unrecognisable, and it went
    unnoticed because there is nothing to see. This is the check that would have caught it.

    An entry for a station that no longer exists is only a warning: hand written synonyms are merged
    into the generated file and survive a rename, which costs a little fuzzy matching accuracy and
    loses nothing.
    """
    path = config.nlp_data_dir / "synonyms.json"
    synonyms = load_json(path, report)
    if synonyms is None:
        return

    names = {info["name"] for info in stations.values() if info.get("name")}
    missing = sorted(names - set(synonyms))
    if missing:
        report.error(
            f"{config.id}: {len(missing)} station(s) have no entry in synonyms.json, so a message "
            f"naming one of them resolves to no station: {missing[:5]}"
            f"{' ...' if len(missing) > 5 else ''}. "
            f"Run `python scripts/create_synonyms.py --network {config.id}`."
        )

    orphans = sorted(set(synonyms) - names)
    if orphans:
        report.warn(
            f"{config.id}: {len(orphans)} synonym entry(s) name a station this network no longer "
            f"has: {orphans[:5]}{' ...' if len(orphans) > 5 else ''}"
        )


def validate_seed_metadata(metadata: Dict[str, Any], config: NetworkConfig, report: Report) -> None:
    """
    `network.json` must describe the network its directory is named after, and say who it serves.

    The `serves` list is the one part of this file that is not a copy of the YAML: it is generated
    from the stations, and it is what lets a rider find the Rhine-Ruhr network by searching for
    Dortmund. It is checked because the claim used to live in a comment that nothing verified, and
    by the time forty networks existed four of those comments were wrong, the Leipzig file still
    naming Halle a year after Halle became its own network.

    What can be checked without asking OpenStreetMap again is the shape and the one contradiction
    that needs no lookup: a network does not "also serve" the city it is named after.
    """
    where = f"{config.id}: network.json"
    if metadata.get("id") != config.id:
        report.error(f"{where}: id is {metadata.get('id')!r}, it has to be {config.id!r}")
    if metadata.get("name") != config.name:
        report.error(f"{where}: name is {metadata.get('name')!r}, it has to be {config.name!r}")

    serves = metadata.get("serves")
    if serves is None:
        report.warn(
            f"{where}: no serves list. The network is served without the other cities it reaches, "
            f"so nobody can find it by searching for one. Rerun "
            f"`python scripts/build_network.py --network {config.id}`."
        )
        return
    if not isinstance(serves, list) or any(not isinstance(city, str) or not city for city in serves):
        report.error(f"{where}: serves is {serves!r}, it has to be a list of city names")
        return
    # Compared through the same cleaning the generator uses, so a bilingual name cannot slip past
    # it: OpenStreetMap calls Cottbus "Cottbus - Chóśebuz", which is not the string `config.name`
    # and is very much the same city.
    if clean_place_name(config.name) in {clean_place_name(city) for city in serves}:
        report.error(f"{where}: serves lists {config.name!r}, which is the network's own name")
    if len(set(serves)) != len(serves):
        report.error(f"{where}: serves has the same city twice: {sorted(serves)}")
    if serves != sorted(serves):
        report.error(f"{where}: serves is not sorted, so its diff churns on every rebuild")


def validate_go_backend_copy(config: NetworkConfig, report: Report) -> None:
    """
    The Go backend's copy of a network must be byte identical to the seed directory.

    `//go:embed` cannot reach outside its own module, so every generated file exists twice and
    `build_network.py` keeps the copies in step. Nothing else does, which is why this is checked
    rather than assumed: Berlin's Go copy once missed `isCircular` for months, and a network built
    before its segments were generated keeps serving the stale geometry from whichever copy was
    written last. A drifted copy is worse than a missing one, because both backends answer and they
    disagree.
    """
    source_dir = config.backend_seed_dir
    target_dir = config.go_backend_data_dir

    for name in GO_BACKEND_REQUIRED_FILES:
        source = source_dir / name
        target = target_dir / name
        if not source.is_file():
            report.error(f"{config.id}: {source} is missing, the network cannot be built")
        elif not target.is_file():
            report.error(
                f"{config.id}: {name} is missing from the Go backend's copy. "
                f"Run `python scripts/build_network.py --network {config.id}`."
            )
        elif not filecmp.cmp(source, target, shallow=False):
            report.error(
                f"{config.id}: {name} differs between the seed directory and the Go backend's copy. "
                f"Run `python scripts/build_network.py --network {config.id}`."
            )

    # Optional files are a missing feature when absent, but a drifted one is still a fault, and one
    # present on only one side means the two backends disagree about what the network offers.
    for name in GO_BACKEND_OPTIONAL_FILES:
        source = source_dir / name
        target = target_dir / name
        if source.is_file() and target.is_file():
            if not filecmp.cmp(source, target, shallow=False):
                report.error(
                    f"{config.id}: {name} differs between the seed directory and the Go backend's "
                    f"copy. Run `python scripts/build_network.py --network {config.id}`."
                )
        elif source.is_file() != target.is_file():
            present = "the seed directory" if source.is_file() else "the Go backend's copy"
            report.error(
                f"{config.id}: {name} exists in {present} only, so the two backends serve different "
                f"features. Run `python scripts/build_network.py --network {config.id}`."
            )


def validate_cross_network(loaded: Dict[str, Dict[str, Any]], report: Report) -> None:
    """
    Station ids must stay unique across all networks.

    The backend relies on this: `stations.id` is a global primary key, so two cities generating the
    same id would not merely collide, the second one would silently seed over the first. See
    `docs/MultiNetwork.md`.
    """
    owners: Dict[str, str] = {}
    for network_id, stations in loaded.items():
        for station_id in stations:
            if station_id in owners:
                report.error(
                    f"station id '{station_id}' is used by both '{owners[station_id]}' and "
                    f"'{network_id}'. Remove the plain 'ref' entry from the network's "
                    "stations.idSources so the OSM node id is used instead."
                )
            else:
                owners[station_id] = network_id


def validate(configs: List[NetworkConfig], report: Report) -> None:
    stations_by_network: Dict[str, Dict[str, Any]] = {}

    for config in configs:
        stations = load_json(config.backend_seed_dir / "StationsList.json", report)
        lines = load_json(config.backend_seed_dir / "LinesList.json", report)
        metadata = load_json(config.backend_seed_dir / "LineMetadata.json", report)
        if stations is None or lines is None or metadata is None:
            continue

        validate_stations(stations, config, report)
        validate_lines(lines, stations, config, report)
        validate_line_continuity(lines, stations, config, report)
        validate_line_metadata(metadata, lines, config, report)
        # Only with stations to derive them from. `validate_stations` has already reported an empty
        # or coordinate-less list as an error, and `resolve_bounds` raises on one rather than
        # returning something, which would end the run with a traceback and hide the findings for
        # every other network this run was meant to collect.
        if any("coordinates" in station for station in stations.values()):
            validate_extent(stations, config, report)
        validate_synonyms(stations, config, report)
        metadata_json = load_json(config.backend_seed_dir / "network.json", report)
        if metadata_json is not None:
            validate_seed_metadata(metadata_json, config, report)
        validate_go_backend_copy(config, report)

        # Both optional: a network without them is served without route planning or without risk
        # colours, which is a missing feature rather than a fault, so their absence is not a
        # finding. Once they exist the backend trusts them, so their contents are.
        stations_map_path = config.backend_seed_dir / "stationsMap.prod.json"
        if stations_map_path.is_file():
            stations_map = load_json(stations_map_path, report)
            if stations_map is not None:
                validate_stations_map(stations_map, stations, config, report)

        segments_path = config.backend_seed_dir / "segments.json"
        if segments_path.is_file():
            segments = load_json(segments_path, report)
            if segments is not None:
                validate_segments(segments, lines, stations, metadata, config, report)

        stations_by_network[config.id] = stations
        print(f"[INFO] {config.id}: {len(stations)} stations, {len(lines)} lines")

    validate_cross_network(stations_by_network, report)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--network", help="Validate only this network. Defaults to all of them.")
    args = parser.parse_args()

    try:
        configs = [load_network_config(args.network)] if args.network else load_all_network_configs()
    except NetworkConfigError as error:
        print(f"[FAIL] {error}", file=sys.stderr)
        raise SystemExit(1) from error

    # Cross network uniqueness can only be checked against all networks, so validating one in
    # isolation would miss exactly the failure that matters when a city is added.
    if args.network:
        print("[INFO] Validating one network, cross network id uniqueness is not checked")

    report = Report()
    validate(configs, report)

    for warning in report.warnings:
        print(f"[WARN] {warning}", file=sys.stderr)
    for error in report.errors:
        print(f"[FAIL] {error}", file=sys.stderr)

    if report.errors:
        print(f"\n{len(report.errors)} error(s), {len(report.warnings)} warning(s)", file=sys.stderr)
        raise SystemExit(1)
    print(f"\nOK, {len(report.warnings)} warning(s)")


if __name__ == "__main__":
    main()
