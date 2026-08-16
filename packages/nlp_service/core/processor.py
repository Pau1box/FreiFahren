from nlp_service.config.language_rules import check_for_spam
from nlp_service.utils.logger import setup_logger
from nlp_service.core.dataloader import (
    TicketInspector,
    get_network_data,
)
from nlp_service.core.extractors.line_extractor import (
    find_line,
)
from nlp_service.core.extractors.direction_extractor import (
    find_direction,
    format_text,
)
from nlp_service.core.extractors.station_extractor import (
    find_station,
)
from nlp_service.config.language_rules import (
    verify_direction,
    verify_line,
)

from nlp_service.utils.database import insert_ticket_info, fetch_id

logger = setup_logger()

def extract_ticket_inspector_info(unformatted_text, network_data):
    """
    Extracts ticket inspector information from the unformatted text.

    Everything is resolved against the data of one network: a line or station name is only
    meaningful inside the network it came from.
    """

    ticket_inspector = TicketInspector(station=None, direction=None, line=None)

    found_line = find_line(unformatted_text, network_data.lines)
    ticket_inspector.line = found_line

    # Get the direction
    text = format_text(unformatted_text)
    found_direction = find_direction(text, ticket_inspector, network_data)[0]
    ticket_inspector.direction = found_direction

    # Pass the text without direction to avoid finding the direction again
    text_without_direction = find_direction(text, ticket_inspector, network_data)[1]
    found_station = find_station(text_without_direction, ticket_inspector, network_data)
    ticket_inspector.station = found_station

    # With the found info we can cross check the direction and line
    if found_line or found_station or found_direction:
        verify_direction(ticket_inspector, text, network_data)
        verify_line(ticket_inspector, text, network_data)

        return ticket_inspector.__dict__
    else:
        return None

def process_new_message(timestamp, message_text, network_id):
    # Initial guards to avoid unnecessary processing
    if check_for_spam(message_text):
        logger.info("Message is not getting processed")
        return None

    network_data = get_network_data(network_id)
    info = extract_ticket_inspector_info(message_text, network_data)
    logger.info("Found information in the message: %s", info)

    if isinstance(info, dict) and any(
        info.get(key) for key in ["line", "station", "direction"]
    ):
        # Retrieve Ids from backend
        station_id = fetch_id(info.get("station"), "station", network_id)
        direction_id = fetch_id(info.get("direction"), "direction", network_id)

        insert_ticket_info(
            timestamp, info.get("line"), station_id, direction_id, network_id
        )
    else:
        logger.info("No valid information found in the message.")
