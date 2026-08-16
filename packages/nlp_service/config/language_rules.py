from nlp_service.config.config import MINIMUM_MESSAGE_LENGTH
from nlp_service.utils.logger import setup_logger
from nlp_service.core.extractors.station_extractor import (
    find_station,
    find_stations_of_line,
)

import re

logger = setup_logger()


"""
Preparation functions
"""

def check_for_spam(text):
    if len(text) < MINIMUM_MESSAGE_LENGTH:
        return True

    # if the message contains a question mark, we still don't need it to be processed
    if "?" in text:
        return True
    
    logger.debug("checking for spam")

    if len(text) > 250:
        return True

    if "http" in text:
        return True

    emoji_pattern = re.compile(
        "["
        "\U0001F600-\U0001F64F"  # emojis
        "]+",
        flags=re.UNICODE,
    )

    # Find all emojis in the text
    emojis = emoji_pattern.findall(text)
    # Split emojis into individual characters
    emojis = [char for emoji in emojis for char in emoji]

    if len(emojis) > 5:
        return True

    # If no spam indicators were found
    return False

def get_words_after_line(text, line):
    logger.debug("getting words after line")

    line_index = text.rfind(line)
    after_line = text[line_index + len(line) :].strip()
    return after_line.split()

def get_final_stations_of_line(line, network_data):
    logger.debug("getting final stations of line")

    stations_of_line = find_stations_of_line(network_data, line)
    if not stations_of_line:
        return []
    return [stations_of_line[0], stations_of_line[-1]]

def remove_direction_and_keyword(text, direction_keyword, direction):
    logger.debug(
        "removing direction and keyword for the keyword: %s and direction: %s",
        direction_keyword,
        direction,
    )

    replace_segment = f"{direction_keyword} {direction}".strip()
    if replace_segment in text:
        # If the exact match is found, replace it
        return text.replace(replace_segment, "").strip()
    else:
        # If only the direction_keyword is found, attempt to remove it and any trailing spaces
        replace_keyword_only = f"{direction_keyword}".strip()
        if replace_keyword_only in text:
            # Remove the keyword and any single trailing space (if present)
            text = text.replace(replace_keyword_only, "", 1).strip()
        return text

def set_ring_line_directionless(ticket_inspector, network_data):
    """A ring line returns to where it started, so its terminus says nothing about direction.

    Which lines those are comes from the backend's line metadata, see dataloader.read_ring_lines.
    """
    logger.debug("setting ring line directionless")

    if ticket_inspector.line in network_data.ring_lines:
        ticket_inspector.direction = None

    return ticket_inspector

def check_if_station_is_actually_direction(text, ticket_inspector, network_data):
    logger.debug("checking if station is actually direction")

    if ticket_inspector.direction is None or ticket_inspector.station is None:
        return ticket_inspector

    line = ticket_inspector.line
    final_stations_of_line = get_final_stations_of_line(line, network_data)

    line = line.lower()  # convert to lowercase because text is in lowercase
    after_line_words = get_words_after_line(text, line)

    if not after_line_words:
        return ticket_inspector

    # Get the word directly after the line
    found_station_after_line = find_station(
        after_line_words[0], ticket_inspector, network_data
    )

    if (
        not found_station_after_line
        or found_station_after_line not in final_stations_of_line
    ):
        return ticket_inspector

    # Remove the word after line from the text to find the new station
    text_without_direction = remove_direction_and_keyword(
        text, line, after_line_words[0]
    )
    new_station = find_station(text_without_direction, ticket_inspector, network_data)

    if new_station is None:
        return ticket_inspector

    ticket_inspector.direction = found_station_after_line
    ticket_inspector.station = new_station

    return ticket_inspector

def mentions_ring(text):
    logger.debug("checking whether the text names a ring line")

    # remove commas and dots from the text
    text = text.replace(",", "").replace(".", "")
    # split the text into individual words
    words = text.lower().split()
    # check if any word in the text matches the ring keywords
    for word in words:
        if word in ring_keywords:
            return True
    return False



"""
Verifiers
"""

def verify_direction(ticket_inspector, text, network_data):
    logger.debug("verifying direction")

    if ticket_inspector.line is None:
        return ticket_inspector

    set_ring_line_directionless(ticket_inspector, network_data)

    # if station is mentioned directly after the line, it is the direction
    # example 'U8 Hermannstraße' is most likely 'U8 Richtung Hermannstraße'
    check_if_station_is_actually_direction(text, ticket_inspector, network_data)

    return ticket_inspector

def verify_line(ticket_inspector, text, network_data):
    logger.debug("verifying line")

    # Someone naming the ring without a line can only mean a ring the network actually has, so this
    # stays quiet in a city without one and never invents a line from a German word alone.
    if ticket_inspector.line is None and mentions_ring(text.lower()):
        ticket_inspector.line = network_data.ring_line
    return ticket_inspector

"""
Language rules
"""

# German for a circular line. The words are language, not local knowledge: which line they refer to
# comes from the network data.
ring_keywords = [
    "ring",
    "ringbahn",
]

direction_keywords = [
    "nach",
    "richtung",
    "bis",
    "zu",
    "to",
    "towards",
    "direction",
    "ri",
    "richtig",
]