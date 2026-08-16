"""
One place to talk to Overpass from.

Overpass is a free service on donated hardware and it says no regularly: `429 Too Many Requests` when
it is busy, `504 Gateway Timeout` when a query is expensive, and `406 Not Acceptable` when the caller
does not identify itself. Building one city hides that behind luck. Building sixty does not, which is
why every query in the pipeline goes through here.
"""

from __future__ import annotations

import sys
import time
from typing import List

import requests

from network_config import USER_AGENT

# Public instances, tried in order, the community's own first. They do not always agree: the same
# query for Mannheim's tram routes returned 20 lines from the first and 21 from the others within
# minutes, so which one answers decides what a city looks like. Falling through is therefore a last
# resort rather than an equivalent retry, which is what ATTEMPTS_PER_MIRROR is for.
MIRRORS = (
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
)

# A single 429 says the instance is busy, not that it is down. Trying it twice before moving on
# keeps a momentary refusal from silently handing the build to an instance with different data.
ATTEMPTS_PER_MIRROR = 2

# Retryable: the server is busy or the query took too long there. Anything else is our fault and
# retrying would only waste someone's capacity.
RETRYABLE_STATUS = frozenset({429, 502, 503, 504})

# Nine attempts with the wait capped at two minutes is a little under ten minutes of patience. Six
# attempts of pure doubling gave up after two and a half, which was too little: a busy afternoon on
# the public instances outlasts that easily, and losing a whole city's build to it means downloading
# everything again rather than waiting. The cap matters as much as the count, because unbounded
# doubling spends the later attempts asleep instead of trying.
MAX_ATTEMPTS = 9
BASE_BACKOFF_SECONDS = 5
MAX_BACKOFF_SECONDS = 120


class OverpassError(RuntimeError):
    """Raised when a query could not be answered by any mirror."""


def query(payload: str, timeout: int = 600, attempts: int = MAX_ATTEMPTS) -> List[dict]:
    """
    Run one Overpass query and return its elements.

    Attempts walk through the mirrors and back around, waiting longer each time. The wait is
    deliberate politeness, not just retry mechanics: hammering a rate limited instance is how a
    contributor gets the project's User-Agent blocked for everyone.

    `attempts` exists for the caller that can afford to come back later. Waiting out the full ladder
    occupies an instance for ten minutes, which is the right trade when giving up means downloading a
    whole city again, and the wrong one when the query is cheap to repeat and another step of the
    build needs that instance more.

    The mirror moves on for one of two reasons: this one has had its `ATTEMPTS_PER_MIRROR` tries, or
    it could not be reached at all. The second case is why this is a running index rather than
    arithmetic on the attempt number. A refused connection is not the momentary busy signal the
    repeat exists for, it means that instance is down, and asking it again answers nothing. With
    `attempts=2` it also meant both tries went to the same dead mirror and the caller never reached
    a working one, which is how a station map step gave up while two other instances were healthy.
    """
    last_error = "no attempt made"
    attempts = max(1, min(attempts, MAX_ATTEMPTS))
    mirror = 0
    tries_on_mirror = 0

    for attempt in range(attempts):
        url = MIRRORS[mirror % len(MIRRORS)]
        tries_on_mirror += 1
        try:
            response = requests.post(
                url, data={"data": payload}, timeout=timeout, headers={"User-Agent": USER_AGENT}
            )
        except requests.RequestException as error:
            last_error = f"{type(error).__name__}: {error}"
            mirror += 1
            tries_on_mirror = 0
        else:
            if response.status_code == 200:
                elements = response.json()["elements"]
                # Which mirror answered is worth knowing after the fact, because they do not all
                # serve the same snapshot: the same query for Mannheim's tram routes returned 49
                # relations from one and 51 from another minutes apart, and a Berlin station query
                # returned 276 `ref:IFOPT` references once and 1060 the next time. When a build
                # comes out short, this line is what says whether to blame the query or the day.
                print(f"[INFO] {len(elements)} elements from {url}", file=sys.stderr, flush=True)
                return elements
            last_error = f"HTTP {response.status_code} from {url}"
            if response.status_code not in RETRYABLE_STATUS:
                raise OverpassError(f"Overpass refused the query, {last_error}")
            # Busy rather than down, so the repeat this mirror is entitled to is worth spending.
            if tries_on_mirror >= ATTEMPTS_PER_MIRROR:
                mirror += 1
                tries_on_mirror = 0

        if attempt < attempts - 1:
            delay = min(BASE_BACKOFF_SECONDS * (2**attempt), MAX_BACKOFF_SECONDS)
            print(f"[WARN] {last_error}, retrying in {delay}s", file=sys.stderr, flush=True)
            time.sleep(delay)

    raise OverpassError(f"Overpass did not answer after {attempts} attempts, last error: {last_error}")
