"""Line recognition, checked against the real line lists of two networks.

Berlin names most of its lines with a letter ("U8", "M10", "S41"), while the networks added since
name almost all of them with a bare number (Halle runs 1 to 16). Both have to work from the same
rule, and a number in a message is only a line where the sentence says so.
"""

import unittest

from nlp_service.core.extractors.line_extractor import find_line
from nlp_service.core.testing.seed_networks import load_seed_network


def seed_lines(network_id):
    network_data = load_seed_network(network_id)
    if network_data is None:
        raise unittest.SkipTest(
            f'Seed data for {network_id} is not available in this checkout'
        )
    return network_data.lines


class TestFindNumericLine(unittest.TestCase):
    """Halle, where every line but two is called by a bare number."""

    @classmethod
    def setUpClass(cls):
        cls.lines = seed_lines('halle')

    def test_article_and_direction(self):
        self.assertEqual(
            find_line('Kontrolleure in der 5 Richtung Kröllwitz', self.lines), '5'
        )

    def test_line_keyword(self):
        self.assertEqual(
            find_line('Zwei Kontrolleure in der Linie 3 Richtung Trotha', self.lines), '3'
        )

    def test_tram_keyword(self):
        self.assertEqual(find_line('Tram 16 am Hauptbahnhof', self.lines), '16')

    def test_article_alone(self):
        self.assertEqual(find_line('die 2 kommt gleich, alles voll Blau', self.lines), '2')

    def test_counted_number_is_not_a_line(self):
        # Halle has a line 3, but this message counts people.
        self.assertIsNone(find_line('3 Kontrolleure am Markt', self.lines))

    def test_time_is_not_a_line(self):
        # Halle has a line 12, but "12 Uhr" is a time.
        self.assertIsNone(find_line('seit 12 Uhr stehen sie am Riebeckplatz', self.lines))

    def test_bare_number_without_context(self):
        self.assertIsNone(find_line('sind bestimmt 7 gewesen', self.lines))


class TestFindLineInBerlin(unittest.TestCase):
    """Berlin, where the same rule may not cost the recognition of a lettered line."""

    @classmethod
    def setUpClass(cls):
        cls.lines = seed_lines('berlin')

    def test_lettered_line_needs_no_context(self):
        self.assertEqual(
            find_line('2x Hellblau U8 Hermannplatz Richtung Wittenau', self.lines), 'U8'
        )

    def test_line_written_with_a_space(self):
        self.assertEqual(find_line('S 41 Richtung Ostkreuz', self.lines), 'S41')

    def test_line_written_with_a_dash(self):
        self.assertEqual(find_line('S-41 Richtung Ostkreuz', self.lines), 'S41')

    def test_numeric_tram_with_context(self):
        # Berlin's numbered trams were unrecognisable before, the same as every line in Halle.
        self.assertEqual(
            find_line('Kontrolle in der 12 Richtung Pasedagplatz', self.lines), '12'
        )
        self.assertEqual(find_line('Tram 21 Marktstraße', self.lines), '21')

    def test_counted_number_is_not_a_line(self):
        # Berlin has a tram 12, so this is the case the numeric rule has to keep quiet on.
        self.assertIsNone(find_line('12 Kontrolleure am Bahnsteig', self.lines))
        self.assertIsNone(find_line('um 12 Uhr am Hermannplatz', self.lines))

    def test_two_lines_stay_ambiguous(self):
        # Neither of the two is the line of the report, so none is picked.
        self.assertIsNone(find_line('2bos mehringdamm am gleis u7/u6', self.lines))


class TestFindLineWithSeparators(unittest.TestCase):

    def test_slash_belongs_to_the_line_id(self):
        # Halle's 3E/16 is one line, and reading it as its part "16" would file the report on
        # another line. The whole word is therefore tried before its parts.
        lines = seed_lines('halle')
        self.assertEqual(find_line('3E/16 Richtung Trotha', lines), '3E/16')


if __name__ == '__main__':
    unittest.main()
