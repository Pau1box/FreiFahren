from nlp_service.utils.logger import setup_logger
from nlp_service.core.NER.TransportInformationRecognizer import (
    TextProcessor,
)

from typing import Dict, List, Optional
from fuzzywuzzy import process

logger = setup_logger()

"""
Preparation functions
"""

def find_stations_of_line(network_data, line: str) -> List[str]:
    """The stations of a line, matched without regard to case.

    Line ids are printed on the vehicle and are not all upper case: Frankfurt has an "EEx".
    Upper casing the name before the lookup silently returned no stations for those lines.
    """
    if line in network_data.lines:
        return network_data.lines[line]

    for known_line, stations in network_data.lines.items():
        if known_line.lower() == line.lower():
            return stations

    logger.warning("Line %s is not part of network %s", line, network_data.network_id)
    return []


def build_station_lookup(network_data, line: Optional[str] = None) -> Dict[str, str]:
    """Every spelling a message may use, mapped to the station name it stands for.

    Candidates and their resolution have to come from one place. They used to come from two: the
    station names of the line were offered to the fuzzy match, while the match was resolved through
    the synonym file alone. A station missing from that file was therefore matched and then thrown
    away, and the report was stored without a station, without anything looking like an error.
    """
    logger.debug("Building the station lookup for the line: %s", line)

    stations = (
        find_stations_of_line(network_data, line)
        if line is not None
        else network_data.station_names
    )

    lookup: Dict[str, str] = {}
    for station in stations:
        # setdefault: where two stations share a spelling, the first one wins, and the order of
        # station_names and of a line's stations is stable, so the same message keeps its answer.
        lookup.setdefault(station.lower(), station)
        for synonym in network_data.stations_with_synonyms.get(station, []):
            lookup.setdefault(synonym.lower(), station)

    return lookup

def get_best_match(text, items, threshold=75):
    logger.debug("getting the best match")

    # Nothing to match against, which happens for a line the network has no stations for.
    # extractOne answers None there, and unpacking that used to take the whole message down.
    if not items:
        return None

    match = process.extractOne(text, items)
    if match is None:
        return None

    best_match, score = match
    if score >= threshold:
        return best_match
    return None

"""
Extraction functions
"""

def find_station(text, ticket_inspector, network_data, threshold=75):
    logger.debug("finding the station")

    stations = build_station_lookup(network_data, ticket_inspector.line)

    # Use the NER Model to get the unrecognized stations from the text
    ner_results = TextProcessor.process_text(text)
    logger.info("NER results: %s", ner_results)

    for ner_result in ner_results:
        # Get the fuzzy match of the NER result with the stations
        best_match = get_best_match(ner_result, list(stations), threshold)
        if best_match:
            # Catch secret direction, as the next station
            # This is triggered when the direction could not be found via direction keywords
            if ticket_inspector.direction is None and len(ner_results) > 1:
                direction_match = get_best_match(ner_results[1], list(stations), threshold)
                if direction_match:
                    ticket_inspector.direction = stations[direction_match]
            return stations[best_match]
    return None