import json
import os
import threading
from typing import Dict, FrozenSet, List, Optional

import requests

from nlp_service.config.config import BACKEND_URL
from nlp_service.utils.logger import setup_logger

logger = setup_logger()

# Two ring lines count as the same loop when this share of the larger one's stations is on both.
# Berlin's S41 and S42 sit near 0.97, two unrelated tram loops share next to nothing.
SAME_LOOP_SHARED_STATIONS = 0.7

"""
Data models
"""


class TicketInspector:
    def __init__(self, station=None, direction=None, line=None):
        self.station = station
        self.direction = direction
        self.line = line


class NetworkData:
    """Everything the extractors need about one transit network.

    Ids are only unique inside their network (docs/MultiNetworkContract.md), so nothing here may be
    shared between networks.
    """

    def __init__(
        self,
        network_id: str,
        lines: Dict[str, List[str]],
        stations_with_synonyms: Dict[str, List[str]],
        ring_lines: FrozenSet[str],
        ring_line: Optional[str],
    ):
        self.network_id = network_id
        self.lines = lines
        self.stations_with_synonyms = stations_with_synonyms
        # Every station the network serves. The synonym file is not the answer to this: it can be
        # missing a station and used to be the only way a matched name was resolved, which dropped
        # the station from the report without anything looking like an error.
        self.station_names = sorted(
            {name for names in lines.values() for name in names}
            | set(stations_with_synonyms)
        )
        self.ring_lines = ring_lines
        self.ring_line = ring_line


"""
Functions for loading and preparing stations and lines data
"""


def load_data(filename):
    logger.debug("loading data from file: %s", filename)

    base_dir = os.path.dirname(os.path.abspath(__file__))
    file_path = os.path.join(base_dir, filename)
    with open(file_path, "r") as f:
        return json.load(f)


def create_lines_with_station_names(lines_with_ids, stations):
    lines_with_names = {}
    for line, station_ids in lines_with_ids.items():
        station_names = []
        for station_id in station_ids:
            if station_id in stations:
                station_names.append(stations[station_id]["name"])
            else:
                logger.error(f"Station ID {station_id} not found in stations data")
                station_names.append(station_id)  # Fallback to ID if name not found
        lines_with_names[line] = station_names
    return lines_with_names


def read_ring_lines(line_metadata: Dict[str, dict]) -> FrozenSet[str]:
    """The lines that run in a circle, taken from the line metadata the backend serves.

    This used to be guessed from the station coordinates, on the reasoning that closing a loop costs
    one ordinary hop while a route from A to B has its ends as far apart as the route is long. The
    reasoning is sound and the measurement was not: it called Düsseldorf's tram 706 a ring, because
    its two ends happen to sit 3.3 km apart on a 13.7 km route, and it disagreed with the backend
    about Hamburg's U3, which circles and then branches out to Wandsbek-Gartenstadt.

    `isCircular` comes from `roundtrip=yes` in OpenStreetMap, so it is a statement by someone who
    knows the line rather than an inference from its shape, and taking it here is what keeps this
    service and the backend from calling different lines rings. See docs/MultiNetworkContract.md.
    """
    return frozenset(line for line, meta in line_metadata.items() if meta.get("isCircular"))


def pick_ring_line(ring_lines: FrozenSet[str], lines_with_ids: Dict[str, List[str]]) -> Optional[str]:
    """The line to report when a message names the ring without naming a line.

    Several lines usually serve the same loop in opposite directions (Berlin's S41 and S42, which
    differ only by a station the other one skips). A ring report carries no direction anyway, so any
    of them describes it equally well and the lowest id keeps the choice deterministic.

    A city can also have two loops that have nothing to do with each other. Then the word "Ring"
    does not identify a line, and returning one of them would file the report on a line the sender
    never rode. In that case nothing is picked and the report keeps its line empty.
    """
    if not ring_lines:
        return None

    ordered = sorted(ring_lines)
    stations = {line: set(lines_with_ids.get(line, [])) for line in ordered}
    reference = stations[ordered[0]]
    for line in ordered[1:]:
        shared = reference & stations[line]
        larger = max(len(reference), len(stations[line]))
        if larger == 0 or len(shared) / larger < SAME_LOOP_SHARED_STATIONS:
            logger.info("Ring lines %s do not share a loop, no line is assumed for 'Ring'", ordered)
            return None
    return ordered[0]


def build_network_data(
    network_id: str,
    lines_with_ids: Dict[str, List[str]],
    stations: dict,
    stations_with_synonyms: Dict[str, List[str]],
    line_metadata: Dict[str, dict],
) -> NetworkData:
    ring_lines = read_ring_lines(line_metadata)
    logger.info("Ring lines of network %s: %s", network_id, sorted(ring_lines))

    return NetworkData(
        network_id=network_id,
        lines=create_lines_with_station_names(lines_with_ids, stations),
        stations_with_synonyms=stations_with_synonyms,
        ring_lines=ring_lines,
        ring_line=pick_ring_line(ring_lines, lines_with_ids),
    )


def fetch_network_data(network_id: str) -> NetworkData:
    logger.info("Loading transit data for network %s", network_id)

    params = {"network": network_id}
    # Checked rather than parsed blindly: an unknown network answers 404 with a JSON body, and
    # taking that for a line list would build a network out of an error message.
    lines_response = requests.get(f"{BACKEND_URL}/v0/lines", params=params, timeout=30)
    lines_response.raise_for_status()
    lines_with_ids = lines_response.json()

    stations_response = requests.get(
        f"{BACKEND_URL}/v0/stations", params=params, timeout=30
    )
    stations_response.raise_for_status()
    stations = stations_response.json()

    # Which lines are rings comes from here rather than from the geometry, see read_ring_lines.
    metadata_response = requests.get(
        f"{BACKEND_URL}/v0/lines/metadata", params=params, timeout=30
    )
    metadata_response.raise_for_status()
    line_metadata = metadata_response.json()

    if not lines_with_ids or not stations or not line_metadata:
        raise Exception(f"Failed to load the stations and lines data for {network_id}")

    # Synonyms are generated per network by scripts/build_network.py.
    stations_with_synonyms = load_data(f"data/networks/{network_id}/synonyms.json")
    if not stations_with_synonyms:
        raise Exception(f"Failed to load the synonyms data for {network_id}")

    return build_network_data(
        network_id, lines_with_ids, stations, stations_with_synonyms, line_metadata
    )


"""
Registry
"""

_networks: Dict[str, NetworkData] = {}
# The Telegram poller and the Flask server run in different threads and both resolve networks.
_networks_lock = threading.Lock()


def get_network_data(network_id: str) -> NetworkData:
    """Return the data of one network, loading it from the backend the first time it is asked for.

    Deliberately not loaded at import time: that made every consumer, including the unit tests,
    depend on a running backend.
    """
    with _networks_lock:
        if network_id not in _networks:
            _networks[network_id] = fetch_network_data(network_id)
        return _networks[network_id]


def register_network_data(network_data: NetworkData) -> None:
    """Seed the registry with data that did not come from the backend, used by the tests."""
    with _networks_lock:
        _networks[network_data.network_id] = network_data
