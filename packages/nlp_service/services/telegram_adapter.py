from nlp_service.config.config import (
    NLP_BOT_TOKEN,
    MINI_APP_SERVER_URL,
    is_known_chat,
    network_for_chat,
)
from nlp_service.utils.logger import setup_logger
from nlp_service.core.processor import process_new_message

from telebot import TeleBot
from telebot.types import (
    WebAppInfo,
    InlineKeyboardMarkup,
    InlineKeyboardButton,
    LinkPreviewOptions,
)

import pytz
from datetime import datetime
import traceback

logger = setup_logger()

nlp_bot = TeleBot(NLP_BOT_TOKEN)

# Rate limiting state
last_telegram_notification = None

# Chats that are not configured, remembered so that a bot added to a busy group does not fill the
# log with the same line for every message. Capped because the set grows with whoever adds the bot
# somewhere: past the cap it is cleared and those chats are logged once more, which is a repeated
# log line every few thousand strange chats rather than a set that only ever grows.
reported_unknown_chats = set()
MAX_REPORTED_UNKNOWN_CHATS = 1000


def note_unknown_chat(chat_id) -> None:
    """Log a chat that is not mapped to a network, once per chat."""
    if chat_id in reported_unknown_chats:
        return

    if len(reported_unknown_chats) >= MAX_REPORTED_UNKNOWN_CHATS:
        reported_unknown_chats.clear()

    reported_unknown_chats.add(chat_id)
    logger.warning(
        "Ignoring messages from chat %s: it is not mapped to a network", chat_id
    )


def bot_error_handler(exception):
    logger.error(f"NLP Bot Error: {str(exception)}")
    logger.error(traceback.format_exc())


# Register error handler for the bot
nlp_bot.logger = logger
nlp_bot.exception_handler = bot_error_handler


def send_message(
    chat_id: str, text: str, preview_url: str, bot, parse_mode: str = "HTML"
) -> bool:
    """Send a message to a Telegram chat with link preview.

    Args:
        chat_id (str): The ID of the user or chat.
        text (str): The message content to send.
        preview_url (str): URL for link preview generation.
        bot: Telegram bot instance to use for sending.
        parse_mode (str): Message parsing mode (default: HTML).
    """
    try:
        lp_opts = LinkPreviewOptions(
            url=preview_url, prefer_large_media=True, show_above_text=False
        )

        bot.send_message(
            chat_id, text, parse_mode=parse_mode, link_preview_options=lp_opts
        )
        return True
    except Exception as e:
        logger.error(f"Failed to send message to user {chat_id}: {e}")
        return False


def send_webapp_button(
    chat_id: str, text: str, button_text: str, webapp_url: str
) -> None:
    """Send a message with a button that opens a Mini App.

    Args:
        chat_id (str): The ID of the user or chat.
        text (str): The message text to accompany the button.
        button_text (str): The text displayed on the button.
        webapp_url (str): The URL of the Mini App.
    """
    try:
        markup = InlineKeyboardMarkup()
        markup.add(
            InlineKeyboardButton(text=button_text, web_app=WebAppInfo(url=webapp_url))
        )
        nlp_bot.send_message(chat_id, text, reply_markup=markup)
    except Exception as e:
        logger.error(f"Failed to send webapp button to chat {chat_id}: {e}")


# Handler for the /start command
@nlp_bot.message_handler(commands=["start"])
def handle_start_command(message):
    """Handle the /start command by sending a welcome message with the Mini App button.

    In a group this follows the same rule as any other message: a group that is not mapped to a
    network gets no answer, so the bot stays silent where it was never meant to run. A private chat
    is different, because that is where a user opens the bot to report through the Mini App, and it
    is never part of the group configuration.
    """
    if message.chat.type != "private" and not is_known_chat(message.chat.id):
        note_unknown_chat(message.chat.id)
        return

    logger.info(f"Start command received from chat id: {message.chat.id}")

    # Send welcome message with Mini App button
    chat_id = message.chat.id
    welcome_text = "Willkommen 👋 Nutze den Button unten um Kontrolleure zu melden:\n\n Welcome 👋 Use the button below to report inspectors:"
    button_text = "Kontrolleure melden / Report inspectors"

    # Use the configured server URL from config
    webapp_url = f"{MINI_APP_SERVER_URL}/mini-app"

    # Send the Mini App button
    send_webapp_button(chat_id, welcome_text, button_text, webapp_url)


# message handler for the nlp bot
@nlp_bot.message_handler(content_types=["text", "photo"])
def get_info(message):
    logger.info("------------------------")
    logger.info("MESSAGE RECEIVED")

    # One group per network. A message from anywhere else cannot be attributed to a network, and
    # guessing one would file the report into the wrong city.
    network_id = network_for_chat(message.chat.id)
    if network_id is None:
        note_unknown_chat(message.chat.id)
        return

    utc = pytz.UTC
    timestamp = datetime.fromtimestamp(message.date, utc).replace(
        second=0, microsecond=0
    )

    text = (
        message.text
        if message.content_type == "text"
        else (message.caption or "Image without description")
    )

    process_new_message(timestamp, text, network_id)
