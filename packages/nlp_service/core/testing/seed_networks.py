"""Build NetworkData from the seed files in the repository instead of from the backend.

The seed data is exactly what the backend serves for a fresh deployment, so the accuracy tests can
use it directly and stay runnable without a backend, a database or a network connection.
"""

import json
import os
from typing import Optional

from nlp_service.core.dataloader import NetworkData, build_network_data, load_data

SEED_DIRECTORY = os.path.abspath(
    os.path.join(
        os.path.dirname(__file__),
        "..",
        "..",
        "..",
        "hono-backend",
        "src",
        "db",
        "seed",
        "networks",
    )
)


def seed_data_available(network_id: str) -> bool:
    return os.path.isdir(os.path.join(SEED_DIRECTORY, network_id))


def load_seed_network(network_id: str) -> Optional[NetworkData]:
    """Return the network built from the seed files, or None when they are not checked out."""
    if not seed_data_available(network_id):
        return None

    def read(name):
        with open(os.path.join(SEED_DIRECTORY, network_id, name)) as f:
            return json.load(f)

    return build_network_data(
        network_id,
        read("LinesList.json"),
        read("StationsList.json"),
        load_data(f"data/networks/{network_id}/synonyms.json"),
        read("LineMetadata.json"),
    )
