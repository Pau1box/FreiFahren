from flask import Flask, request, send_from_directory
from nlp_service.config.config import (
    DEFAULT_NETWORK_ID,
    REPORT_PASSWORD,
    chats_for_network,
    is_known_chat,
)
from nlp_service.services.telegram_adapter import (
    send_message,
    send_webapp_button,
)
from nlp_service.utils.logger import setup_logger
from nlp_service.services.telegram_adapter import nlp_bot
import os

logger = setup_logger()

flask_app = Flask(__name__)


def resolve_target_chats(payload):
    """The groups a report is announced in, derived from the network the report belongs to.

    A caller released before multi network support names no network, and per
    docs/MultiNetworkContract.md that means the default one.
    """
    network_id = payload.get("network") or DEFAULT_NETWORK_ID
    chat_ids = chats_for_network(network_id)
    if not chat_ids:
        logger.error("No Telegram chat is configured for network %s", network_id)
    return chat_ids


def announce_report(chat_ids, telegram_message, station_url) -> bool:
    """Post one report in every group of its network.

    Reports success as soon as one group has it: a second group that is misconfigured should not
    make a report that reached its audience look failed to the backend.
    """
    delivered = [
        send_message(chat_id, telegram_message, station_url, nlp_bot)
        for chat_id in chat_ids
    ]
    return any(delivered)


@flask_app.route("/report-inspector", methods=["POST"])
def report_inspector() -> tuple:
    """Handle inspector report submissions from the backend.

    Requires authentication via X-Password header.
    """
    # Check authentication
    provided_password = request.headers.get("X-Password")
    if provided_password != REPORT_PASSWORD:
        logger.warning("Unauthorized report-inspector request, invalid password")
        return {"status": "error", "message": "Unauthorized"}, 401

    line = request.json.get("line", None)
    station = request.json.get("station", None)
    direction = request.json.get("direction", None)
    message = request.json.get("message", None)
    stationId = request.json.get("stationId", None)

    chat_ids = resolve_target_chats(request.json)
    if not chat_ids:
        return {"status": "error", "message": "Unknown network"}, 400

    logger.info(
        f"Received a report from an inspector: Line: {line}, Station: {station}, Direction: {direction}, Message: {message}"
    )
    telegram_message = ""

    telegram_message += f"\n<b>Station</b>: {station}"
    if line:
        telegram_message += f"\n<b>Line</b>: {line}"
    if direction:
        telegram_message += f"\n<b>Richtung</b>: {direction}"
    if message:
        telegram_message += f"\n<b>Beschreibung</b>: hier einsehbar <a href='https://app.freifahren.org/station/{stationId}'>app.freifahren.org</a>"
    else:
        telegram_message += f"\n\nMehr Informationen auf <a href='https://app.freifahren.org/station/{stationId}'>app.freifahren.org</a>"

    station_url = f"https://app.freifahren.org/station/{stationId}"  # allow telegram to automatically create a preview card

    message_sent = announce_report(chat_ids, telegram_message, station_url)

    if message_sent:
        logger.info("Inspector report sent to Telegram")
        return {"status": "success", "message": "Report sent"}, 200
    else:
        logger.info("Failed to send message to Telegram")
        return {"status": "error", "message": "Failed to send message to Telegram"}, 500


@flask_app.route("/mini-app", methods=["GET"])
def serve_mini_app():
    """Serve the Telegram Mini App HTML file"""
    static_dir = os.path.join(os.path.dirname(os.path.dirname(__file__)), "static")
    return send_from_directory(static_dir, "mini_app.html")


@flask_app.route("/mini-app/report", methods=["POST"])
def handle_mini_app_data():
    """Handle data submitted from the Mini App.

    Requires authentication via X-Password header.
    """
    try:
        # Check authentication
        provided_password = request.headers.get("X-Password")
        if provided_password != REPORT_PASSWORD:
            logger.warning("Unauthorized mini-app/report request, invalid password")
            return {"status": "error", "message": "Unauthorized"}, 401

        # Parse the submitted data
        data = request.json
        line = data.get("line", "")
        station = data.get("station", "")
        direction = data.get("direction", "")
        message = data.get("message", "")
        stationId = data.get("stationId", "")

        chat_ids = resolve_target_chats(data)
        if not chat_ids:
            return {"status": "error", "message": "Unknown network"}, 400

        logger.info(f"Received Mini App data: {data}")

        # Format the report message
        telegram_message = ""
        telegram_message += f"\n<b>Station</b>: {station}"
        if line:
            telegram_message += f"\n<b>Line</b>: {line}"
        if direction:
            telegram_message += f"\n<b>Richtung</b>: {direction}"
        if message:
            telegram_message += f"\n<b>Beschreibung</b>: hier einsehbar <a href='https://app.freifahren.org/station/{stationId}'>app.freifahren.org</a>"
        else:
            telegram_message += f"\nMehr Informationen auf <a href='https://app.freifahren.org/station/{stationId}'>app.freifahren.org</a>"
        telegram_message += "\n\nDas ist eine Meldung aus der <b>Telegram Mini App</b>. \n"
        telegram_message += 'Um auch in Telegram zu melden: \nTippe auf mein Profilbild und dann auf "App öffnen"'

        # Send the message to the FreiFahren chats of the network
        station_url = f"https://app.freifahren.org/station/{stationId}"  # allow telegram to automatically create a preview card
        announce_report(chat_ids, telegram_message, station_url)

        return {"status": "success"}, 200

    except Exception as e:
        # The detail stays in the log: the caller has no use for it and an error message can carry
        # internals such as the backend URL.
        logger.error(f"Error handling Mini App data: {str(e)}")
        return {"status": "error", "message": "Failed to handle Mini App data"}, 500


@flask_app.route("/send-mini-app", methods=["POST"])
def send_mini_app():
    """
    Send a Mini App button to a chat.

    Requires authentication via X-Password header.

    This endpoint makes the official bot post a message with a button. Unauthenticated, it let
    anyone who could reach the service post arbitrary text under the bot's name, with a button
    pointing at an arbitrary URL, into any chat the bot is a member of. That is a ready made
    phishing primitive, so it is authenticated like the two report endpoints, the button always
    points at this service's own Mini App instead of at a caller supplied URL, and the target is
    limited to the groups the service is configured for rather than every chat the bot can reach.
    """
    try:
        provided_password = request.headers.get("X-Password")
        if provided_password != REPORT_PASSWORD:
            logger.warning("Unauthorized send-mini-app request, invalid password")
            return {"status": "error", "message": "Unauthorized"}, 401

        chat_id = request.json.get("chat_id")
        if not chat_id:
            return {"status": "error", "message": "chat_id is required"}, 400

        if not is_known_chat(chat_id):
            logger.warning(
                "Refusing to send a Mini App button to chat %s: it is not mapped to a network",
                chat_id,
            )
            return {"status": "error", "message": "Unknown chat"}, 400

        webapp_url = request.url_root + "mini-app"
        button_text = request.json.get("button_text", "Open Mini App")
        message_text = request.json.get(
            "message_text", "Click the button below to report inspectors:"
        )

        # Send the Mini App button
        send_webapp_button(chat_id, message_text, button_text, webapp_url)

        return {"status": "success"}, 200

    except Exception as e:
        logger.error(f"Error sending Mini App: {str(e)}")
        return {"status": "error", "message": "Failed to send Mini App"}, 500
