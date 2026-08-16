from datetime import datetime
import requests
from nlp_service.utils.logger import setup_logger
from nlp_service.config.config import BACKEND_URL, REPORT_PASSWORD

logger = setup_logger()

def insert_ticket_info(
    timestamp: datetime,
    line: str,
    station_id: str,
    direction_id: str,
    network_id: str,
):

    logger.info("Inserting ticket info into the database")

    # Prepare the JSON data payload. The network scopes the report: the backend rejects a station or
    # line that belongs to a different one, see docs/MultiNetworkContract.md.
    url = BACKEND_URL + "/v0/basics/inspectors"
    params = {"network": network_id}
    data = {
        "timestamp": timestamp.isoformat(),
        "line": line,
        "stationId": station_id,
        "directionId": direction_id,
        "author": 98111116,  # ASCII code for 'Bot' to identefy messages sent by the bot
        "message": None,
    }
    headers = {
        "Content-Type": "application/json",
        "X-Password": REPORT_PASSWORD,  # avoid rate limiting
    }

    # Timeout because this runs on the Telegram polling thread: a backend that never answers
    # would otherwise stop the bot from reading any further message.
    response = requests.post(url, json=data, headers=headers, params=params, timeout=30)

    if response.status_code != 200:
        logger.error(
            "Failed to send data to the url: %s. Status code: %s Response: %s",
            url,
            response.status_code,
            response.text,
        )
        logger.debug("Failed request data: %s", data)
        # The headers are deliberately not logged: they carry REPORT_PASSWORD, and the logger
        # writes DEBUG to app.log.
    else:
        logger.info("Data sent to the backend successfully")


def fetch_id(name, entity_type, network_id):
    if not name:
        return None

    url = f"{BACKEND_URL}/v0/stations/search"
    # Passed as params rather than interpolated: station names carry spaces and umlauts, and the
    # name comes from a Telegram message.
    params = {"name": name, "network": network_id}

    try:
        response = requests.get(url, params=params, timeout=10)
        response.raise_for_status()  # Raises an HTTPError for bad responses (4xx or 5xx)

        data = response.json()

        if data:
            station_id = next(iter(data.keys()))
            logger.info(f"Received {entity_type} id from the backend: {station_id}")
            return station_id
        else:
            logger.error(f"Unexpected response format from backend: {data}")
            return None

    except requests.exceptions.HTTPError as e:
        if e.response.status_code == 404:
            logger.info(
                f"{entity_type}: {name} not found: {e.response.json().get('error', 'No error message provided')}"
            )
        else:
            logger.error(f"HTTP error occurred: {e}")
        return None
    except requests.exceptions.RequestException as e:
        logger.error(f"Error fetching {entity_type} id: {e}")
        return None
    except ValueError as e:  # Includes JSONDecodeError
        logger.error(f"Error decoding JSON response: {e}")
        return None
