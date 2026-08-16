"""
What a place is called, for the three steps that have to agree about it.

Its own module rather than a function in one of them, because the validator runs in CI with nothing
installed but PyYAML, and importing it from a script that talks to Overpass would drag `requests`
into a check that needs no network at all.
"""

from __future__ import annotations


def clean_place_name(name: str) -> str:
    """
    The city name without its second language.

    OpenStreetMap writes officially bilingual places as "Cottbus - Chóśebuz". Both halves are the
    same city, and a network id built from both is unreadable. It also matters when comparing:
    without this the reach step publishes Cottbus as a city its own network additionally serves,
    because the two strings are not equal.
    """
    return name.split(" - ")[0].strip()
