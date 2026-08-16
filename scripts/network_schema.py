"""
The shape of a network description: the constants it is bounded by and the objects it parses into.

Split out of `network_config.py`, which reads and validates the YAML. Keeping the shape separate
from the reading keeps either file small enough to hold in your head, and it is the half that other
scripts refer to when they talk about a network.

See `networks/README.md` for the format and `docs/MultiNetwork.md` for why networks exist.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import yaml

REPO_ROOT = Path(__file__).resolve().parent.parent
NETWORKS_DIR = REPO_ROOT / "networks"

# Where the generated artefacts go. The build writes them directly to the packages that consume
# them, which is the step the old README asked contributors to do by hand.
BACKEND_SEED_DIR = REPO_ROOT / "packages" / "hono-backend" / "src" / "db" / "seed" / "networks"
NLP_DATA_DIR = REPO_ROOT / "packages" / "nlp_service" / "core" / "data" / "networks"

# The Go backend serves the same files, but compiles them in via `//go:embed`, which cannot reach
# outside its own module. A second copy is therefore unavoidable; the build keeps it in sync so the
# two cannot drift apart. They already had: the Go copy was missing `isCircular` for months.
GO_BACKEND_DATA_DIR = REPO_ROOT / "packages" / "backend" / "data" / "networks"

# Scratch space for one build: what a step queried from Overpass and the next step needs as well.
# Nothing here is published, and a stale copy is never read, see `NetworkConfig.route_cache_path`.
BUILD_CACHE_DIR = REPO_ROOT / "scripts" / ".build-cache"

# The files the Go backend embeds. `segments.json` and `stationsMap.prod.json` are optional there,
# so they are synced only when the network has them.
GO_BACKEND_REQUIRED_FILES = ("network.json", "StationsList.json", "LinesList.json", "LineMetadata.json")
GO_BACKEND_OPTIONAL_FILES = ("segments.json", "stationsMap.prod.json")

# Distinct colours for lines that OpenStreetMap gives none. Chosen to stay apart from one another
# and to read on both a light and a dark map, not to match any operator's branding.
FALLBACK_PALETTE = (
    "#1f77b4",
    "#d62728",
    "#2ca02c",
    "#ff7f0e",
    "#9467bd",
    "#8c564b",
    "#17becf",
    "#e377c2",
    "#7f7f7f",
    "#bcbd22",
)

# `networks.id` and `stations.id` are varchar columns in the backend schema. Generating data that
# does not fit them would only fail much later, at seed time.
MAX_NETWORK_ID_LENGTH = 32
MAX_STATION_ID_LENGTH = 16
MAX_LINE_ID_LENGTH = 16

NETWORK_ID_PATTERN = re.compile(r"^[a-z0-9][a-z0-9-]*$")

# Overpass and the transitous geocoder both expect callers to identify themselves. Overpass answers
# 406 Not Acceptable without a User-Agent, which is not an obvious failure mode.
USER_AGENT = "FreiFahren-network-builder/1.0 (+https://github.com/FreiFahren)"

# OSM `route` values the pipeline knows how to read.
SUPPORTED_MODES = frozenset({"subway", "light_rail", "tram", "train"})

KM_PER_DEGREE_LATITUDE = 111.32

# How far `bounds: auto` reaches beyond the outermost station.
BOUNDS_MARGIN_KM = 5.0

# A network wider than this is almost certainly wrong: the Overpass query pulled in a long distance
# service, or the area name matched a whole federal state. The largest legitimate German network,
# Berlin's, spans about 90 km.
MAX_NETWORK_DIAGONAL_KM = 200.0


class NetworkConfigError(ValueError):
    """Raised when a network description is missing, malformed or self contradictory."""


@dataclass(frozen=True)
class Coordinates:
    latitude: float
    longitude: float


@dataclass(frozen=True)
class Bounds:
    south_west: Coordinates
    north_east: Coordinates

    def contains(self, point: Coordinates) -> bool:
        return (
            self.south_west.latitude <= point.latitude <= self.north_east.latitude
            and self.south_west.longitude <= point.longitude <= self.north_east.longitude
        )

    @property
    def diagonal_km(self) -> float:
        """Rough south west to north east distance, used as a sanity check on generated bounds."""
        return _distance_km(self.south_west, self.north_east)

    @classmethod
    def around(cls, points: List[Coordinates], margin_km: float = BOUNDS_MARGIN_KM) -> "Bounds":
        """
        The smallest box containing every point, plus a margin.

        This is what `bounds: auto` produces. The margin exists so a client's map does not clip the
        outermost station, and so a station added to OpenStreetMap next month does not immediately
        fall outside what the network declares.
        """
        if not points:
            raise NetworkConfigError("cannot compute bounds without any coordinates")

        latitudes = [point.latitude for point in points]
        longitudes = [point.longitude for point in points]

        latitude_margin = margin_km / KM_PER_DEGREE_LATITUDE
        # A degree of longitude shrinks towards the poles, so the margin is scaled by the latitude it
        # is applied at. Without this a northern network gets a visibly narrower margin.
        mean_latitude = (min(latitudes) + max(latitudes)) / 2
        longitude_margin = margin_km / (KM_PER_DEGREE_LATITUDE * max(math.cos(math.radians(mean_latitude)), 0.1))

        return cls(
            south_west=Coordinates(
                latitude=round(min(latitudes) - latitude_margin, 6),
                longitude=round(min(longitudes) - longitude_margin, 6),
            ),
            north_east=Coordinates(
                latitude=round(max(latitudes) + latitude_margin, 6),
                longitude=round(max(longitudes) + longitude_margin, 6),
            ),
        )


def _distance_km(a: Coordinates, b: Coordinates) -> float:
    """Great circle distance. Duplicated from geo.py in metres, kept here to avoid a cycle."""
    earth_radius_km = 6371.0
    lat1, lon1, lat2, lon2 = map(math.radians, (a.latitude, a.longitude, b.latitude, b.longitude))
    h = math.sin((lat2 - lat1) / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2
    return 2 * earth_radius_km * math.asin(math.sqrt(h))


@dataclass(frozen=True)
class ModePrefix:
    """One letter added to a station id when the station serves a line matching `pattern`."""

    pattern: re.Pattern[str]
    letter: str


# Perl style shorthand classes. Overpass matches POSIX extended regular expressions, where `\d` is
# not a digit but an undefined escape: the query parses, runs and quietly matches nothing. A rule
# that filters nothing is worse than a rejected one, because the download it was meant to bound
# happens anyway.
UNSUPPORTED_REGEX_ESCAPES = re.compile(r"(?<!\\)\\[dDwWsSbB]")

POSIX_EQUIVALENTS = "[0-9] for digits, [A-Za-z0-9_] for word characters, [[:space:]] for whitespace"


def _escape_overpass_string(value: str) -> str:
    """
    Make a value safe to paste into a double quoted Overpass QL string.

    Regexes from a network description can carry backslashes (`^RB\\.[0-9]+$`), and Overpass QL reads
    a backslash inside a quoted string as an escape character: it strips one before the regex engine
    ever sees the pattern. Doubling them is what keeps an escaped dot from silently becoming "any
    character" on the server.
    """
    return value.replace("\\", "\\\\").replace('"', '\\"')


@dataclass(frozen=True)
class ModeRule:
    """
    One OSM `route` value, plus which of its lines belong to the network.

    `ref_pattern` is `None` for `auto`, meaning every route of that mode. It exists because a mode
    does not always mean one operator: München and Nürnberg tag their S-Bahn as `route=train`, the
    same value every ICE and RE passing through carries. Taking `train` wholesale drags in stations
    from the other end of the country, so those networks restrict the mode by line reference instead.

    The pattern is a POSIX extended regex, because Overpass matches it as well as we do.
    """

    mode: str
    ref_pattern: Optional[re.Pattern[str]]

    def accepts_line(self, ref: str) -> bool:
        return self.ref_pattern is None or self.ref_pattern.search(ref) is not None

    @property
    def overpass_filter(self) -> str:
        """The tag filters selecting exactly this mode's routes."""
        tags = f'["type"="route"]["route"="{_escape_overpass_string(self.mode)}"]'
        if self.ref_pattern is not None:
            tags += f'["ref"~"{_escape_overpass_string(self.ref_pattern.pattern)}"]'
        return tags


@dataclass(frozen=True)
class SourceConfig:
    # Exactly one of these is set. `osm_area` names an administrative boundary, `search_box` gives
    # the corners of a box to search in.
    osm_area: Optional[str]
    admin_level: str
    search_box: Optional["Bounds"]
    mode_rules: List[ModeRule]
    # `None` means discover every line of the configured modes from OpenStreetMap.
    include_lines: Optional[List[str]]
    # References to drop even though the modes accept them. Empty for almost every network, see
    # `accepts_line`.
    exclude_lines: List[str]

    @property
    def modes(self) -> List[str]:
        return [rule.mode for rule in self.mode_rules]

    def area_preamble(self, name: str = "a") -> str:
        """
        The Overpass statement that defines the search area, or nothing when searching a box.

        Kept next to `scope` so the two cannot disagree: a query either declares an area and then
        refers to it, or declares nothing and carries the box in the scope.
        """
        if self.osm_area is None:
            return ""
        return (
            f'area["name"="{self.osm_area}"]["boundary"="administrative"]'
            f'["admin_level"~"{self.admin_level}"]->.{name};'
        )

    def scope(self, name: str = "a") -> str:
        """
        The clause that restricts a query to the network's area.

        A named administrative boundary is the better choice when one exists, because it follows the
        real city limits. It does not exist for every network: the Ruhr area is a single contiguous
        system spanning a dozen cities, and no one boundary contains it. Those networks give a box
        instead.
        """
        if self.osm_area is None:
            if self.search_box is None:
                raise NetworkConfigError("source has neither osmArea nor boundingBox")
            box = self.search_box
            return (
                f"({box.south_west.latitude},{box.south_west.longitude},"
                f"{box.north_east.latitude},{box.north_east.longitude})"
            )
        return f"(area.{name})"

    def accepts_line(self, ref: str, mode: Optional[str] = None) -> bool:
        """
        Whether a route with this reference counts as a line of the network.

        `mode` is the route's OSM `route` value. It is optional only for callers that have no route
        at hand; passing it is what keeps a `train` restricted to the S lines from accepting an ICE
        that Overpass returned for another mode.

        `exclude_lines` is the escape hatch for a heritage operation that `accepts_route` cannot
        recognise because OpenStreetMap does not tag it as one. It is deliberately a list of exact
        references and not a pattern: naming the one line it drops is what keeps it from quietly
        growing into a second, invisible line filter.
        """
        if ref in self.exclude_lines:
            return False
        if self.include_lines is not None and ref not in self.include_lines:
            return False
        if mode is None:
            return any(rule.accepts_line(ref) for rule in self.mode_rules)
        return any(rule.mode == mode and rule.accepts_line(ref) for rule in self.mode_rules)

    def accepts_route(self, tags: Dict[str, str]) -> bool:
        """
        Whether a route relation belongs to the network, judged by all of its tags.

        On top of the reference and the mode this drops heritage and leisure operations, which
        OpenStreetMap marks as `usage=tourism` or `service=tourism`. They run on tram tracks and are
        tagged like a tram, but nobody is checked for a ticket on them in the sense this app is
        about. Chemnitz's Parkeisenbahn would otherwise become a line called "PEC".
        """
        if tags.get("usage") == "tourism" or tags.get("service") == "tourism":
            return False

        ref = tags.get("ref") or tags.get("name")
        if ref is None:
            return False
        return self.accepts_line(ref, tags.get("route"))

    def route_union(self, scope: str, extra_filter: str = "") -> str:
        """
        An Overpass union selecting the network's route relations, one block per mode.

        A single `route~"^(subway|train)$"` filter cannot say "every subway, but only the S lines out
        of the trains", so the query gets one block per mode and the reference filter reaches the
        server. That is the whole point of the split: without it a network that needs `train`
        downloads every long distance route in the country before anything is filtered locally.

        `scope` is the area or bounding box clause, e.g. `(area.a)`. `extra_filter` is ANDed into
        every block, for callers that also want one specific line.
        """
        blocks = "\n".join(
            f"  relation{rule.overpass_filter}{extra_filter}{scope};" for rule in self.mode_rules
        )
        return f"(\n{blocks}\n)"


@dataclass(frozen=True)
class StationsConfig:
    merge_radius_meters: float
    id_sources: List[str]
    mode_prefixes: List[ModePrefix]
    # Which id prefix letters may appear in a geocoder query. `None` allows all of them.
    geocode_prefix_letters: Optional[List[str]]

    def geocode_prefix(self, station_id: str) -> str:
        """
        The station type hint prepended to a geocoder query, e.g. `S+U ` for `SU-BHBF`.

        Geocoders index German stations under their type, so `S+U Alexanderplatz` matches where a
        bare `Alexanderplatz` finds the square instead of the station.
        """
        letters = list(station_id.split("-")[0]) if "-" in station_id else []
        if self.geocode_prefix_letters is not None:
            letters = [letter for letter in letters if letter in self.geocode_prefix_letters]
        return f"{'+'.join(letters)} " if letters else ""

    def prefix_for(self, lines: List[str]) -> str:
        """
        Build the id prefix for a station from the lines it serves.

        Letters appear in the order the rules are declared, so a station on an S-Bahn, a U-Bahn and a
        tram becomes `SUM-`, matching what Berlin's data has always looked like.
        """
        letters = "".join(
            rule.letter for rule in self.mode_prefixes if any(rule.pattern.search(line) for line in lines)
        )
        return f"{letters}-" if letters else ""


@dataclass(frozen=True)
class LineColors:
    """
    How a line's colour is decided when drawing its track geometry.

    OpenStreetMap carries a `colour` tag for most routes, so that is the default source. Overrides
    exist for networks whose branding is more consistent than their OSM tagging, Berlin being the
    example: every S-Bahn line is drawn in one green there, whatever the individual relation says.
    """

    default: str
    overrides: List[Tuple[re.Pattern[str], str]]
    # Whether a line with no colour anywhere gets one from FALLBACK_PALETTE instead of `default`.
    use_fallback_palette: bool

    def resolve(self, line_id: str, osm_colour: Optional[str]) -> str:
        for pattern, colour in self.overrides:
            if pattern.search(line_id):
                return colour
        return osm_colour or self.default

    def resolve_all(self, osm_colours: Dict[str, Optional[str]]) -> Dict[str, str]:
        """
        The colour of every line at once, so that lines without one can still be told apart.

        Not every network tags its colours. Bielefeld's four Stadtbahn lines carry none, and giving
        them all the same default paints four indistinguishable lines on the map and four identical
        chips in the report form, which is worse than an invented colour.

        Lines that need a fallback are therefore handed distinct colours from a fixed palette, in
        sorted order so the result is the same on every rebuild. Adding a line to such a network can
        shift the others, which is acceptable: nothing derives meaning from the value, and a network
        that gains a line is being redrawn anyway.
        """
        resolved: Dict[str, str] = {}
        needs_fallback: List[str] = []

        for line_id in sorted(osm_colours):
            colour = self.resolve(line_id, osm_colours[line_id])
            if osm_colours[line_id] is None and self.use_fallback_palette and not self._has_override(line_id):
                needs_fallback.append(line_id)
            else:
                resolved[line_id] = colour

        for index, line_id in enumerate(needs_fallback):
            resolved[line_id] = FALLBACK_PALETTE[index % len(FALLBACK_PALETTE)]
        return resolved

    def _has_override(self, line_id: str) -> bool:
        return any(pattern.search(line_id) for pattern, _ in self.overrides)


@dataclass(frozen=True)
class NetworkConfig:
    id: str
    name: str
    country_code: str
    timezone: str
    status: str
    center: Coordinates
    # `None` means `bounds: auto`, i.e. computed from the generated stations. Explicit bounds exist
    # for the two networks whose values clients already ship, so those values do not drift.
    bounds: Optional[Bounds]
    source: SourceConfig
    stations: StationsConfig
    line_colors: LineColors

    @property
    def backend_seed_dir(self) -> Path:
        return BACKEND_SEED_DIR / self.id

    @property
    def nlp_data_dir(self) -> Path:
        return NLP_DATA_DIR / self.id

    @property
    def go_backend_data_dir(self) -> Path:
        return GO_BACKEND_DATA_DIR / self.id

    @property
    def route_cache_path(self) -> Path:
        """
        Where one build step leaves the route relation tags for the next.

        Not published anywhere: it is scratch space for a single run of `build_network.py`, which is
        why it lives outside the three data directories and is ignored by git.
        """
        return BUILD_CACHE_DIR / self.id / "routes.json"

    @property
    def reach_cache_path(self) -> Path:
        """
        Where `create_network_reach.py` leaves the other cities this network serves.

        Scratch space like the routes above: the published copy is the `serves` list in
        `network.json`, and this only has to survive from the step that computes it to the step that
        writes that file.
        """
        return BUILD_CACHE_DIR / self.id / "reach.json"

    def resolve_bounds(self, stations: Dict[str, Any]) -> Bounds:
        """
        The bounds to publish: the declared ones, or a box around the generated stations.

        Computing them is the default for a new city. Declaring 60 bounding boxes by hand invites
        exactly the mistake `hamburg.yaml` made on its first attempt, where the city limits cut off a
        line's outer half.
        """
        if self.bounds is not None:
            return self.bounds
        return Bounds.around(
            [
                Coordinates(
                    latitude=info["coordinates"]["latitude"], longitude=info["coordinates"]["longitude"]
                )
                for info in stations.values()
            ]
        )

    def to_seed_metadata(self, bounds: Bounds, serves: List[str]) -> Dict[str, Any]:
        """
        The subset the backend seeds into the `networks` table.

        `serves` is the other cities the network reaches, generated by `create_network_reach.py`.
        It is written even when empty, because "we checked and it serves only its own city" and "we
        never checked" are different answers and a client that filters by it should not have to
        guess which one it is looking at.
        """
        return {
            "id": self.id,
            "name": self.name,
            "countryCode": self.country_code,
            "timezone": self.timezone,
            "status": self.status,
            "serves": serves,
            "center": {"latitude": self.center.latitude, "longitude": self.center.longitude},
            "bounds": {
                "southWest": {
                    "latitude": bounds.south_west.latitude,
                    "longitude": bounds.south_west.longitude,
                },
                "northEast": {
                    "latitude": bounds.north_east.latitude,
                    "longitude": bounds.north_east.longitude,
                },
            },
        }
