from nlp_service.utils.logger import setup_logger
from typing import List, Optional, Set, Union

import re

logger = setup_logger()

# A dash or a slash can separate a prefix from its number ("S-41" for "S41") or belong to the line id
# itself (Halle runs a "3E/16"). Both spellings are tried rather than one of them being thrown away.
SEPARATORS = re.compile(r"[-/]")

# Words that name a line right before its id. Outside Berlin almost every line is called by a bare
# number (Halle 1 to 16, Erfurt 1 to 6), and a bare number in a chat message is far more often a
# time, a count or a house number than a line. So a purely numeric id is only accepted where the
# sentence marks it as a line, while an id like "U8" or "M10" carries that marker in itself.
LINE_KEYWORDS = frozenset({
    "linie",
    "linien",
    "line",
    "tram",
    "trambahn",
    "tramlinie",
    "straßenbahn",
    "strassenbahn",
    "bahn",
    "bus",
    "buslinie",
})

# German names a line with an article or a preposition: "in der 5", "die 16 kommt", "mit der 3".
# Weaker evidence than a keyword, which is why it does not count when the number is followed by what
# it counts or measures.
LINE_ARTICLES = frozenset({"der", "die", "den", "dem", "mit", "in"})

# Only a line has a direction, so a direction word right behind the number marks it as a line too.
# The vaguer keywords of the direction extractor ("nach", "bis", "zu") are left out on purpose,
# because "nach 5" and "bis 8" are times far more often than they are lines.
DIRECTION_MARKERS = frozenset({"richtung", "ri", "direction", "towards"})

# Nouns and units that turn the number in front of them into a quantity or a time, which is what
# makes "3 Kontrolleure" and "um 12 Uhr" stay unmatched in a city that has a line 3 and a line 12.
COUNTED_WORDS = frozenset({
    "uhr",
    "min",
    "minute",
    "minuten",
    "sekunden",
    "stunde",
    "stunden",
    "euro",
    "eur",
    "grad",
    "mal",
    "stück",
    "leute",
    "personen",
    "menschen",
    "männer",
    "frauen",
    "typen",
    "jungs",
    "kids",
    "kontrolleure",
    "kontrolletis",
    "beamte",
    "polizisten",
    "bullen",
    "westen",
    "wagen",
})

"""
Preparation functions
"""

def process_matches(matches_per_word):
    logger.debug("processing matches")

    # Decide what to return based on the collected matches
    if len(matches_per_word) == 1:
        return sorted(
            matches_per_word[list(matches_per_word.keys())[0]], key=len, reverse=True
        )[0]
    elif any(len(matches) > 1 for matches in matches_per_word.values()):
        for _word, matches in matches_per_word.items():
            if len(matches) > 1:
                return sorted(matches, key=len, reverse=True)[0]
    return None

def split_into_words(text: str) -> List[str]:
    logger.debug("splitting the text into words for the line search")

    # Commas and full stops end a sentence and are never part of a line id. Dashes and slashes are
    # kept, because they can be, and are handled per word in word_variants.
    return text.replace(",", " ").replace(".", " ").split()

def word_variants(word: str, next_word: Optional[str]) -> Set[str]:
    """Every spelling of the whole word that could be one line id, lower cased."""
    variants = {word.lower()}

    # "S-41" is a spelling of "S41", so the separator is dropped as well.
    if SEPARATORS.search(word):
        variants.add(SEPARATORS.sub("", word).lower())

    # When 's' or 'u' are followed by a number, combine them. German speakers write "S 41" and
    # "U 8" for what the line is called, so this is a spelling convention rather than knowledge
    # about any particular city, and it is harmless where no line is named that way.
    if word.lower() in ("s", "u") and next_word is not None:
        variants.add(word.lower() + next_word.lower())

    return variants

def separator_parts(word: str) -> List[str]:
    """The parts of a word that a dash or a slash separates, as separate words.

    Only used when the whole word is no line id: "U7/U6" names two lines and has to stay ambiguous,
    while Halle's "3E/16" is one line and must not be read as its part "16".
    """
    if not SEPARATORS.search(word):
        return []
    return [part for part in SEPARATORS.split(word) if part]

def context_words(word: Optional[str]) -> Set[str]:
    """The word and its parts, so "U-Bahn" is recognised as the keyword "Bahn" as well."""
    if word is None:
        return set()
    return {part.lower() for part in SEPARATORS.split(word) if part} | {word.lower()}

def is_meant_as_a_line(words: List[str], index: int) -> bool:
    """Whether the number at `index` is used as a line id rather than as a number.

    See LINE_KEYWORDS for why a numeric id needs this and a non numeric one does not.
    """
    previous_word = words[index - 1] if index > 0 else None
    next_word = words[index + 1] if index + 1 < len(words) else None
    before = context_words(previous_word)
    after = context_words(next_word)

    if after & COUNTED_WORDS:
        return False
    if before & LINE_KEYWORDS:
        return True
    if after & DIRECTION_MARKERS:
        return True
    return bool(before & LINE_ARTICLES)


def matching_lines(
    spellings: Set[str], sorted_lines: List[str], words: List[str], index: int
) -> List[str]:
    """The lines of the network that the word at `index` names, longest id first."""
    matches = []
    for line in sorted_lines:
        if line.lower() not in spellings:
            continue
        if line.isdigit() and not is_meant_as_a_line(words, index):
            continue
        matches.append(line)
    return matches


def find_line(text: str, lines: dict) -> Union[str, None]:
    logger.debug("finding the line")

    words = split_into_words(text)
    sorted_lines = sorted(lines.keys(), key=len, reverse=True)
    matches_per_word = {}

    for index, word in enumerate(words):
        next_word = words[index + 1] if index + 1 < len(words) else None

        matches = matching_lines(word_variants(word, next_word), sorted_lines, words, index)
        if matches:
            matches_per_word.setdefault(word.lower(), []).extend(matches)
            continue

        # The word as a whole is no line, so it may be several of them written back to back.
        for part in separator_parts(word):
            part_matches = matching_lines({part.lower()}, sorted_lines, words, index)
            if part_matches:
                matches_per_word.setdefault(part.lower(), []).extend(part_matches)

    return process_matches(matches_per_word)
