"""
Loading and validating a network description.

A network is one self contained transit system, described by a single YAML file in `networks/`.
Everything the data pipeline needs to know about a city lives there, so adding a city is a file
rather than an edit to the scripts.

This module reads those files. The objects it produces and the limits it checks against live in
`network_schema.py`, and are re exported here, so a caller only ever needs this module.

See `networks/README.md` for the format and `docs/MultiNetwork.md` for why networks exist.
"""

from __future__ import annotations

import re
import sys
from typing import Any, Dict, List, Optional, Tuple
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import yaml

from network_schema import (
    BACKEND_SEED_DIR,
    BOUNDS_MARGIN_KM,
    BUILD_CACHE_DIR,
    FALLBACK_PALETTE,
    GO_BACKEND_DATA_DIR,
    GO_BACKEND_OPTIONAL_FILES,
    GO_BACKEND_REQUIRED_FILES,
    KM_PER_DEGREE_LATITUDE,
    MAX_LINE_ID_LENGTH,
    MAX_NETWORK_DIAGONAL_KM,
    MAX_NETWORK_ID_LENGTH,
    MAX_STATION_ID_LENGTH,
    NETWORK_ID_PATTERN,
    NETWORKS_DIR,
    POSIX_EQUIVALENTS,
    NLP_DATA_DIR,
    REPO_ROOT,
    SUPPORTED_MODES,
    UNSUPPORTED_REGEX_ESCAPES,
    USER_AGENT,
    Bounds,
    Coordinates,
    LineColors,
    ModePrefix,
    ModeRule,
    NetworkConfig,
    NetworkConfigError,
    SourceConfig,
    StationsConfig,
    _distance_km,
)


def _require(mapping: Dict[str, Any], key: str, context: str) -> Any:
    if key not in mapping:
        raise NetworkConfigError(f"{context}: missing required key '{key}'")
    return mapping[key]


def _parse_coordinates(raw: Any, context: str) -> Coordinates:
    if not isinstance(raw, dict):
        raise NetworkConfigError(f"{context}: expected a mapping with latitude and longitude")
    latitude = float(_require(raw, "latitude", context))
    longitude = float(_require(raw, "longitude", context))
    if not -90 <= latitude <= 90:
        raise NetworkConfigError(f"{context}: latitude {latitude} is out of range")
    if not -180 <= longitude <= 180:
        raise NetworkConfigError(f"{context}: longitude {longitude} is out of range")
    return Coordinates(latitude=latitude, longitude=longitude)


def _parse_bounds(raw: Any, context: str) -> Bounds:
    """A south west and north east corner, checked to be the right way round."""
    if not isinstance(raw, dict):
        raise NetworkConfigError(f"{context}: expected southWest and northEast")

    bounds = Bounds(
        south_west=_parse_coordinates(_require(raw, "southWest", context), f"{context}.southWest"),
        north_east=_parse_coordinates(_require(raw, "northEast", context), f"{context}.northEast"),
    )
    if bounds.south_west.latitude >= bounds.north_east.latitude:
        raise NetworkConfigError(f"{context}: south west latitude must be south of north east")
    if bounds.south_west.longitude >= bounds.north_east.longitude:
        raise NetworkConfigError(f"{context}: south west longitude must be west of north east")
    return bounds


def _parse_mode_rules(raw: Any, context: str) -> List[ModeRule]:
    """
    Read `source.modes`, in either of its two forms.

    A plain list stays the common case, because most networks want every route of the modes they
    name. The mapping form exists for the networks where one OSM mode carries both the city's trains
    and the country's, and it reads as the exception it is:

        modes:
            subway: auto
            train: '^S[0-9]+$'

    The pattern is matched by Overpass, not by us, so it has to be a POSIX extended regex.
    """
    if isinstance(raw, list) and raw:
        entries = [(mode, "auto") for mode in raw]
    elif isinstance(raw, dict) and raw:
        entries = list(raw.items())
    else:
        raise NetworkConfigError(
            f"{context}: expected a non empty list of modes, or a mapping of mode to 'auto' or a "
            "line reference pattern"
        )

    rules: List[ModeRule] = []
    for mode, rule in entries:
        mode = str(mode)
        if mode not in SUPPORTED_MODES:
            raise NetworkConfigError(
                f"{context}: unsupported mode '{mode}', expected any of {sorted(SUPPORTED_MODES)}"
            )
        if mode in {existing.mode for existing in rules}:
            raise NetworkConfigError(f"{context}: mode '{mode}' is listed twice")

        if rule == "auto":
            pattern = None
        elif isinstance(rule, str):
            unsupported = UNSUPPORTED_REGEX_ESCAPES.search(rule)
            if unsupported:
                raise NetworkConfigError(
                    f"{context}.{mode}: '{unsupported.group()}' is not understood by Overpass, which "
                    f"matches POSIX extended regular expressions. Use {POSIX_EQUIVALENTS}."
                )
            try:
                pattern = re.compile(rule)
            except re.error as error:
                raise NetworkConfigError(f"{context}.{mode}: invalid regular expression, {error}") from error
        else:
            raise NetworkConfigError(
                f"{context}.{mode}: expected 'auto' or a regular expression matching the line "
                "reference, e.g. '^S[0-9]+$'"
            )
        rules.append(ModeRule(mode=mode, ref_pattern=pattern))

    return rules


def _parse_source(raw: Any, context: str) -> SourceConfig:
    if not isinstance(raw, dict):
        raise NetworkConfigError(f"{context}: expected a mapping")

    mode_rules = _parse_mode_rules(_require(raw, "modes", context), f"{context}.modes")

    lines = raw.get("lines", "auto")
    include_lines: Optional[List[str]] = None
    exclude_lines: List[str] = []
    if lines == "auto":
        pass
    elif isinstance(lines, dict) and ("include" in lines or "exclude" in lines):
        if "include" in lines:
            include_lines = [str(line) for line in lines["include"]]
            if not include_lines:
                raise NetworkConfigError(f"{context}.lines.include: expected a non empty list")
            too_long = [line for line in include_lines if len(line) > MAX_LINE_ID_LENGTH]
            if too_long:
                raise NetworkConfigError(
                    f"{context}.lines.include: {too_long} exceed the {MAX_LINE_ID_LENGTH} character limit"
                )
        if "exclude" in lines:
            exclude_lines = [str(line) for line in lines["exclude"]]
            if not exclude_lines:
                raise NetworkConfigError(f"{context}.lines.exclude: expected a non empty list")
            # Listing a line in both says two opposite things about it, and silently letting one win
            # would make the network depend on which check runs first.
            both = sorted(set(exclude_lines) & set(include_lines or []))
            if both:
                raise NetworkConfigError(f"{context}.lines: {both} are both included and excluded")
    else:
        raise NetworkConfigError(
            f"{context}.lines: expected either 'auto' or a mapping with 'include', 'exclude' or both"
        )

    # Exactly one of the two, because they answer the same question and a network that gave both
    # would leave the reader guessing which one the build actually used.
    raw_area = raw.get("osmArea")
    raw_box = raw.get("boundingBox")
    if (raw_area is None) == (raw_box is None):
        raise NetworkConfigError(f"{context}: expected exactly one of 'osmArea' and 'boundingBox'")

    search_box = _parse_bounds(raw_box, f"{context}.boundingBox") if raw_box is not None else None

    return SourceConfig(
        osm_area=str(raw_area) if raw_area is not None else None,
        admin_level=str(raw.get("adminLevel", "^[4-6]$")),
        search_box=search_box,
        mode_rules=mode_rules,
        include_lines=include_lines,
        exclude_lines=exclude_lines,
    )


def _parse_stations(raw: Any, context: str) -> StationsConfig:
    if not isinstance(raw, dict):
        raise NetworkConfigError(f"{context}: expected a mapping")

    id_sources = raw.get("idSources", ["ref:ds100", "railway:ref"])
    if not isinstance(id_sources, list) or not id_sources:
        raise NetworkConfigError(f"{context}.idSources: expected a non empty list")

    prefixes: List[ModePrefix] = []
    for index, rule in enumerate(raw.get("modePrefixes", [])):
        rule_context = f"{context}.modePrefixes[{index}]"
        if not isinstance(rule, dict):
            raise NetworkConfigError(f"{rule_context}: expected a mapping with 'match' and 'letter'")
        letter = str(_require(rule, "letter", rule_context))
        if len(letter) != 1:
            raise NetworkConfigError(f"{rule_context}.letter: expected exactly one character")
        try:
            pattern = re.compile(str(_require(rule, "match", rule_context)))
        except re.error as error:
            raise NetworkConfigError(f"{rule_context}.match: invalid regular expression, {error}") from error
        prefixes.append(ModePrefix(pattern=pattern, letter=letter))

    raw_geocode_letters = raw.get("geocodePrefixLetters")
    if raw_geocode_letters is not None and not isinstance(raw_geocode_letters, list):
        raise NetworkConfigError(f"{context}.geocodePrefixLetters: expected a list of single letters")

    return StationsConfig(
        merge_radius_meters=float(raw.get("mergeRadiusMeters", 250)),
        id_sources=[str(source) for source in id_sources],
        mode_prefixes=prefixes,
        geocode_prefix_letters=(
            [str(letter) for letter in raw_geocode_letters] if raw_geocode_letters is not None else None
        ),
    )


COLOR_PATTERN = re.compile(r"^#[0-9a-fA-F]{6}$")


def _parse_line_colors(raw: Any, context: str) -> LineColors:
    if not isinstance(raw, dict):
        raise NetworkConfigError(f"{context}: expected a mapping")

    # Lowercased rather than rejected. The pattern accepts either case, everything downstream emits
    # lowercase and `validate_network.py` requires it, so an override written as '#007734' in capitals
    # used to build cleanly and fail at the last step of the run that used it.
    default = str(raw.get("default", "#000000")).lower()
    if not COLOR_PATTERN.match(default):
        raise NetworkConfigError(f"{context}.default: expected a six digit hex colour like '#007734'")

    overrides: List[Tuple[re.Pattern[str], str]] = []
    for index, rule in enumerate(raw.get("overrides", [])):
        rule_context = f"{context}.overrides[{index}]"
        if not isinstance(rule, dict):
            raise NetworkConfigError(f"{rule_context}: expected a mapping with 'match' and 'color'")
        color = str(_require(rule, "color", rule_context)).lower()
        if not COLOR_PATTERN.match(color):
            raise NetworkConfigError(f"{rule_context}.color: expected a six digit hex colour like '#007734'")
        try:
            pattern = re.compile(str(_require(rule, "match", rule_context)))
        except re.error as error:
            raise NetworkConfigError(f"{rule_context}.match: invalid regular expression, {error}") from error
        overrides.append((pattern, color))

    # On by default. A network that wants one house colour for everything, as a monochrome map
    # would, turns it off and gets `default` for every uncoloured line.
    use_fallback_palette = bool(raw.get("useFallbackPalette", True))

    return LineColors(default=default, overrides=overrides, use_fallback_palette=use_fallback_palette)


def parse_network_config(raw: Dict[str, Any], context: str) -> NetworkConfig:
    if not isinstance(raw, dict):
        raise NetworkConfigError(f"{context}: expected a mapping at the top level")

    network_id = str(_require(raw, "id", context))
    if not NETWORK_ID_PATTERN.match(network_id):
        raise NetworkConfigError(
            f"{context}.id: '{network_id}' must be lowercase letters, digits and dashes, "
            "because it appears in API requests and directory names"
        )
    if len(network_id) > MAX_NETWORK_ID_LENGTH:
        raise NetworkConfigError(f"{context}.id: exceeds the {MAX_NETWORK_ID_LENGTH} character limit")

    status = str(raw.get("status", "beta"))
    if status not in ("active", "beta"):
        raise NetworkConfigError(f"{context}.status: expected 'active' or 'beta', got '{status}'")

    country_code = str(_require(raw, "countryCode", context))
    if len(country_code) != 2:
        raise NetworkConfigError(f"{context}.countryCode: expected a two letter ISO 3166-1 code")

    # Checked against the real zone database rather than only for being a string. Both backends
    # convert report timestamps into this zone to build the daily curve and the hour buckets, so a
    # name nothing recognises does not fail anywhere, it silently moves a city's rush hour.
    timezone = str(_require(raw, "timezone", context))
    try:
        ZoneInfo(timezone)
    except (ZoneInfoNotFoundError, ValueError) as error:
        raise NetworkConfigError(
            f"{context}.timezone: '{timezone}' is not an IANA time zone name like 'Europe/Berlin'"
        ) from error

    bounds_raw = _require(raw, "bounds", context)
    bounds: Optional[Bounds]
    if bounds_raw == "auto":
        bounds = None
    else:
        bounds = _parse_bounds(bounds_raw, f"{context}.bounds")

    center = _parse_coordinates(_require(raw, "center", context), f"{context}.center")
    if bounds is not None and not bounds.contains(center):
        raise NetworkConfigError(f"{context}.center: lies outside the declared bounds")

    return NetworkConfig(
        id=network_id,
        name=str(_require(raw, "name", context)),
        country_code=country_code,
        timezone=timezone,
        status=status,
        center=center,
        bounds=bounds,
        source=_parse_source(_require(raw, "source", context), f"{context}.source"),
        stations=_parse_stations(raw.get("stations", {}), f"{context}.stations"),
        line_colors=_parse_line_colors(raw.get("lineColors", {}), f"{context}.lineColors"),
    )


def load_network_config(network_id: str) -> NetworkConfig:
    """Load `networks/<network_id>.yaml`."""
    path = NETWORKS_DIR / f"{network_id}.yaml"
    if not path.is_file():
        available = ", ".join(sorted(config.stem for config in NETWORKS_DIR.glob("*.yaml"))) or "none"
        raise NetworkConfigError(f"No network description at {path}. Available: {available}")

    with path.open(encoding="utf-8") as handle:
        raw = yaml.safe_load(handle)

    config = parse_network_config(raw, path.name)
    if config.id != network_id:
        raise NetworkConfigError(f"{path.name}: declares id '{config.id}' but the file is named '{network_id}.yaml'")
    return config


def load_all_network_configs() -> List[NetworkConfig]:
    return [load_network_config(path.stem) for path in sorted(NETWORKS_DIR.glob("*.yaml"))]


def nearest_network_id(point: Coordinates, centers: Dict[str, Coordinates]) -> Optional[str]:
    """The network whose centre is closest to a point, or None when no networks are described."""
    if not centers:
        return None
    return min(centers, key=lambda network_id: _distance_km(point, centers[network_id]))


def load_network_centers() -> Dict[str, Coordinates]:
    """
    The declared centre of every network.

    Needed because a `boundingBox` is a rectangle around a system that is not rectangular, and
    neighbouring boxes therefore overlap: Duesseldorf's reaches into Cologne's and back. Whoever is
    nearest owns the line, which is the same rule that separated the two systems in the first place.

    Read straight from the YAML rather than through `load_network_config`, so that one malformed
    file cannot stop every other network from building.
    """
    centers: Dict[str, Coordinates] = {}
    for path in sorted(NETWORKS_DIR.glob("*.yaml")):
        try:
            raw = yaml.safe_load(path.read_text(encoding="utf-8"))
            center = raw["center"]
            centers[str(raw["id"])] = Coordinates(
                latitude=float(center["latitude"]), longitude=float(center["longitude"])
            )
        except (KeyError, TypeError, ValueError, yaml.YAMLError) as error:
            # Loud, because the consequence of a missing centre is not a missing network but a wrong
            # one. Whoever is nearest owns an overlapping line, so a Cologne file that fails to parse
            # does not stop Cologne being built, it hands Cologne's trams to Duesseldorf, whose build
            # then succeeds and looks right.
            print(f"[WARN] Ignoring {path.name} while reading network centres: {error}", file=sys.stderr)
            continue
    return centers
