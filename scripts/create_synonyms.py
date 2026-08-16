"""
Build `synonyms.json` for one network, the alternative station names the NLP service matches against.

Run it through the pipeline rather than directly:

    python3 scripts/build_network.py --network hamburg

The rules below are specific to German station names (Straße, Platz, Allee) and would need extending
for a network outside the German speaking area.
"""

from __future__ import annotations

import argparse
import json
from collections import OrderedDict
from pathlib import Path
from typing import Any, Dict, List, Set, Tuple

from network_config import load_network_config


def _handle_strasse(
    station_name: str, name_lower: str, synonyms: Set[str]
) -> Tuple[bool, str]:
    """Handles Straße/Strasse variations. Returns (matched, base_name).

    Example:
        station_name = "Afrikanische Straße"
        synonyms = set()
        _handle_strasse(station_name, station_name.lower(), synonyms)
        # synonyms: {'Afrikanische', 'Afrikanische Str.', 'Afrikanische Strasse'}
    """
    base = ""
    matched = False
    has_space = False
    if name_lower.endswith("straße"):
        base = station_name[:-6].strip()
        matched = True
        has_space = station_name[:-6].endswith(" ")
    elif name_lower.endswith(" strasse"):
        base = station_name[:-8].strip()
        matched = True
        has_space = True
    elif name_lower.endswith("strasse") and not name_lower.endswith(" strasse"):
        base = station_name[:-7].strip()
        matched = True
        has_space = station_name[:-7].endswith(" ")

    if matched and base:
        synonyms.add(base)
        if has_space:
            synonyms.add(f"{base} Str.")
            synonyms.add(f"{base} Strasse")
        else:
            synonyms.add(f"{base}str.")
            synonyms.add(f"{base}strasse")
    return matched, base


def _handle_platz(
    station_name: str, name_lower: str, synonyms: Set[str]
) -> Tuple[bool, str]:
    """Handles Platz variations. Returns (matched, base_name).

    Example:
        station_name = "Marienplatz"
        synonyms = set()
        _handle_platz(station_name, station_name.lower(), synonyms)
        # synonyms: {'Marienplz'}
    """
    base = ""
    matched = False
    if name_lower.endswith(" platz"):
        base = station_name[:-6].strip()
        matched = True
    elif name_lower.endswith("platz") and not name_lower.endswith(" platz"):
        base = station_name[:-5].strip()
        matched = True

    if matched and base:
        if len(base) > 2 or " " in base:
            synonyms.add(base)
        synonyms.add(f"{base}plz")
    return matched, base


def _handle_allee(
    station_name: str, name_lower: str, synonyms: Set[str]
) -> Tuple[bool, str]:
    """Handles Allee variations. Returns (matched, base_name).

    Example:
        station_name = "Grünbergallee"
        synonyms = set()
        _handle_allee(station_name, station_name.lower(), synonyms)
        # synonyms: {'Grünberg'}
    """
    base = ""
    matched = False
    if name_lower.endswith(" allee"):
        base = station_name[:-6].strip()
        matched = True
    elif name_lower.endswith("allee") and not name_lower.endswith(" allee"):
        base = station_name[:-5].strip()
        matched = True

    if matched and base:
        synonyms.add(base)
    return matched, base


def _handle_two_word_names(station_name: str, synonyms: Set[str]) -> None:
    """Handles two-word names, including the 'Am' prefix case.

    Examples:
        station_name = "Zwickauer Damm"
        synonyms = set()
        _handle_two_word_names(station_name, synonyms)
        # synonyms: {'Zwickauer'}

        station_name = "Am Wasserturm"
        synonyms = set()
        _handle_two_word_names(station_name, synonyms)
        # synonyms: {'Wasserturm'}
    """
    words = station_name.split()
    if len(words) == 2:
        first_word = words[0]
        second_word = words[1]
        if first_word.lower() == "am":
            if len(second_word) > 2:
                synonyms.add(second_word)
        elif len(first_word) > 2 and first_word.lower() not in ["alt", "neu"]:
            synonyms.add(first_word)


def generate_synonyms(station_name: str) -> List[str]:
    """
    Generates potential synonyms by applying various rules.
    """
    synonyms: Set[str] = set()
    original_name = station_name
    name_lower = station_name.lower()

    # Apply rules sequentially
    matched_strasse, _ = _handle_strasse(station_name, name_lower, synonyms)
    matched_platz, _ = _handle_platz(station_name, name_lower, synonyms)
    matched_allee, _ = _handle_allee(station_name, name_lower, synonyms)

    # Apply two-word rule only if others didn't match
    if not matched_strasse and not matched_platz and not matched_allee:
        _handle_two_word_names(station_name, synonyms)

    # Clean up
    synonyms.discard(original_name)
    final_synonyms = {s for s in synonyms if s}  # Remove empty strings

    # to make it easier to debug
    return sorted(list(final_synonyms))


def create_synonyms(stations: Dict[str, Dict[str, Any]]) -> "OrderedDict[str, List[str]]":
    """
    Map every station name of the network to its synonyms.

    Every station of the network is listed, only entries without a usable name are skipped. Keyed by
    name rather than by id, because that is what the NLP service matches a chat message against.

    This file is the gazetteer of the NLP service, not a list of nice to have spellings, so leaving a
    station out makes it unreportable rather than just harder to match. There used to be a network
    description option to restrict it to the stops of certain lines, and Berlin used it to keep its
    numbered tram stops out and the fuzzy matching quiet. The cost was invisible: a message naming
    one of 126 of Berlin's 619 stations was stored without a station. The option is gone rather than
    unused, so that nothing offers that trade again.
    """
    synonyms_map: Dict[str, List[str]] = {}

    for station_id, station_info in stations.items():
        if not isinstance(station_info, dict):
            print(f"Warning: skipping invalid station entry for id '{station_id}'")
            continue

        station_name = station_info.get("name")
        if not station_name or not isinstance(station_name, str):
            print(f"Warning: skipping station '{station_id}', it has no usable name")
            continue

        # Stored even when empty, so the NLP service knows the station exists.
        synonyms_map[station_name] = generate_synonyms(station_name)

    return OrderedDict(sorted(synonyms_map.items()))


def keep_existing_synonyms(
    generated: "OrderedDict[str, List[str]]", output_path: Path
) -> "OrderedDict[str, List[str]]":
    """Add the synonyms the file already has to the generated ones.

    Berlin's file carries entries no rule can produce, "Alex" for Alexanderplatz and "HBF" for
    Hauptbahnhof among them, added by hand over time. Writing the file from the rules alone drops
    them, and nothing about the result looks wrong afterwards. Stations that the network no longer
    has do disappear, because the generated names decide which entries exist.
    """
    if not output_path.is_file():
        return generated

    with output_path.open(encoding="utf-8") as handle:
        existing = json.load(handle)
    if not isinstance(existing, dict):
        raise SystemExit(f"{output_path} must contain an object keyed by station name")

    return OrderedDict(
        (name, sorted(set(synonyms) | set(existing.get(name, []))))
        for name, synonyms in generated.items()
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--network", required=True, help="Network id, i.e. the name of a file in networks/")
    args = parser.parse_args()

    config = load_network_config(args.network)
    stations_path = config.backend_seed_dir / "StationsList.json"
    if not stations_path.is_file():
        raise SystemExit(f"{stations_path} is missing. Run create_stations_list.py first.")

    with stations_path.open(encoding="utf-8") as handle:
        stations = json.load(handle)
    if not isinstance(stations, dict):
        raise SystemExit(f"{stations_path} must contain an object keyed by station id")

    output_path = config.nlp_data_dir / "synonyms.json"
    synonyms = keep_existing_synonyms(create_synonyms(stations), output_path)

    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open("w", encoding="utf-8") as handle:
        json.dump(synonyms, handle, ensure_ascii=False, indent=4)
    print(f"[DONE] {output_path} written with {len(synonyms)} stations")


if __name__ == "__main__":
    main()
