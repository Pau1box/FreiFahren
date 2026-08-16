import os
from typing import Dict, List, Optional

from dotenv import load_dotenv

load_dotenv()

NLP_BOT_TOKEN = os.getenv("NLP_BOT_TOKEN")


BACKEND_URL = os.getenv("BACKEND_URL")
# this password is to avoid rate limiting for the nlp service
REPORT_PASSWORD = os.getenv("REPORT_PASSWORD")
SENTRY_DSN = os.getenv("SENTRY_DSN")

# Server base URL for the Mini App
MINI_APP_SERVER_URL = os.getenv("MINI_APP_SERVER_URL")

# minimum message length to be processed, for the core/processor.py
MINIMUM_MESSAGE_LENGTH = 3

# The network a request falls back to when it does not name one, mirroring the backend default
# documented in docs/MultiNetworkContract.md.
DEFAULT_NETWORK_ID = "berlin"

CHAT_NETWORKS_VARIABLE = "FREIFAHREN_CHATS"
CHAT_NETWORKS_FORMAT = "<chat id>:<network id>, comma separated, e.g. '-1001234:berlin,-1005678:hamburg'"


def parse_chat_networks(raw: str) -> Dict[str, str]:
    """Parse FREIFAHREN_CHATS into a chat id to network id mapping.

    Raises ValueError on anything malformed: a bot that silently listens to the wrong set of chats
    would file reports into the wrong city.
    """
    mapping = {}
    for entry in raw.split(","):
        entry = entry.strip()
        if not entry:
            continue
        chat_id, separator, network_id = entry.rpartition(":")
        if not separator or not chat_id.strip() or not network_id.strip():
            raise ValueError(
                f"{CHAT_NETWORKS_VARIABLE} entry '{entry}' is malformed. Expected {CHAT_NETWORKS_FORMAT}"
            )
        chat_id = chat_id.strip()
        if chat_id in mapping:
            raise ValueError(
                f"{CHAT_NETWORKS_VARIABLE} maps chat {chat_id} to more than one network"
            )
        mapping[chat_id] = network_id.strip()
    return mapping


def _load_chat_networks() -> Dict[str, str]:
    raw = os.getenv(CHAT_NETWORKS_VARIABLE)
    if raw:
        return parse_chat_networks(raw)

    # Backwards compatibility: a deployment from before multi network support sets a single chat and
    # at most a network id, and has to keep working untouched.
    legacy_chat_id = os.getenv("FREIFAHREN_CHAT_ID")
    if legacy_chat_id:
        return {legacy_chat_id.strip(): os.getenv("NETWORK_ID", DEFAULT_NETWORK_ID)}

    return {}


# Chat id (as a string, the way Telegram reports it) to network id. Empty when the service is not
# configured; main.py refuses to start in that case.
CHAT_NETWORKS = _load_chat_networks()


def network_for_chat(chat_id) -> Optional[str]:
    return CHAT_NETWORKS.get(str(chat_id))


def is_known_chat(chat_id) -> bool:
    return str(chat_id) in CHAT_NETWORKS


def chats_for_network(network_id: str) -> List[str]:
    """Every group that belongs to a network, in configuration order.

    A network usually has one group, but nothing stops a city from running two. Announcing a report
    in all of them mirrors the reading side, which listens to all of them: a group whose members
    report would otherwise never see the reports that came in through the app.
    """
    return [
        chat_id
        for chat_id, chat_network_id in CHAT_NETWORKS.items()
        if chat_network_id == network_id
    ]
