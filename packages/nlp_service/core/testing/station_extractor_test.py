import unittest

from nlp_service.core.dataloader import NetworkData, TicketInspector
from nlp_service.core.extractors.station_extractor import (
    build_station_lookup,
    find_station,
    find_stations_of_line,
    get_best_match,
)
from nlp_service.core.testing.seed_networks import load_seed_network


def network_with_lines(lines, stations_with_synonyms=None):
    return NetworkData(
        network_id='test',
        lines=lines,
        stations_with_synonyms=stations_with_synonyms or {},
        ring_lines=frozenset(),
        ring_line=None,
    )


def seed_network(network_id):
    network_data = load_seed_network(network_id)
    if network_data is None:
        raise unittest.SkipTest(
            f'Seed data for {network_id} is not available in this checkout'
        )
    return network_data


class TestFindStationsOfLine(unittest.TestCase):

    def test_exact_line(self):
        network_data = network_with_lines({'U8': ['Hermannstraße', 'Wittenau']})
        self.assertEqual(
            find_stations_of_line(network_data, 'U8'), ['Hermannstraße', 'Wittenau']
        )

    def test_mixed_case_line(self):
        # Frankfurt's EEx is a real line id. Upper casing it before the lookup used to return no
        # stations, which left nothing to match against and took the whole message down.
        network_data = network_with_lines({'EEx': ['Hauptbahnhof', 'Höchst']})
        self.assertEqual(
            find_stations_of_line(network_data, 'EEx'), ['Hauptbahnhof', 'Höchst']
        )
        self.assertEqual(
            find_stations_of_line(network_data, 'eex'), ['Hauptbahnhof', 'Höchst']
        )

    def test_unknown_line(self):
        network_data = network_with_lines({'U8': ['Hermannstraße']})
        self.assertEqual(find_stations_of_line(network_data, 'S1'), [])


class TestGetBestMatch(unittest.TestCase):

    def test_no_candidates(self):
        self.assertIsNone(get_best_match('hermannstraße', []))

    def test_match_above_threshold(self):
        self.assertEqual(
            get_best_match('hermannstrasse', ['hermannstraße', 'wittenau']),
            'hermannstraße',
        )


class TestBuildStationLookup(unittest.TestCase):
    """A station has to be resolvable whether or not the synonym file lists it.

    The candidates for the fuzzy match and their resolution used to come from two different places,
    so a station that the synonym file did not list was matched and then dropped, and the report was
    stored without a station.
    """

    def test_station_without_synonym_entry(self):
        network_data = network_with_lines(
            {'21': ['Marktstraße', 'Bersarinplatz']},
            {'Marktstraße': ['Markt Str.']},
        )
        lookup = build_station_lookup(network_data, '21')
        self.assertEqual(lookup['bersarinplatz'], 'Bersarinplatz')
        self.assertEqual(lookup['markt str.'], 'Marktstraße')

    def test_without_a_line_every_station_of_the_network_is_offered(self):
        network_data = network_with_lines({'21': ['Bersarinplatz']}, {})
        self.assertEqual(build_station_lookup(network_data), {'bersarinplatz': 'Bersarinplatz'})

    def test_berlin_tram_station(self):
        # Berlin excluded the stops of its numbered tram lines from the synonym file, which left 126
        # of its 619 stations unreportable.
        network_data = seed_network('berlin')
        self.assertEqual(build_station_lookup(network_data, '21')['marktstraße'], 'Marktstraße')
        self.assertEqual(build_station_lookup(network_data)['marktstraße'], 'Marktstraße')

    def test_berlin_synonym_still_resolves(self):
        network_data = seed_network('berlin')
        self.assertEqual(build_station_lookup(network_data)['alex'], 'Alexanderplatz')

    def test_halle_station(self):
        network_data = seed_network('halle')
        self.assertEqual(build_station_lookup(network_data, '5')['kröllwitz'], 'Kröllwitz')


class TestFindStationInSeedNetworks(unittest.TestCase):
    """The same on real messages, through the NER model and the fuzzy match."""

    def test_berlin_tram_station(self):
        network_data = seed_network('berlin')
        self.assertEqual(
            find_station(
                'kontrolle an der marktstraße', TicketInspector(line='21'), network_data
            ),
            'Marktstraße',
        )

    def test_halle_station(self):
        network_data = seed_network('halle')
        self.assertEqual(
            find_station(
                'kontrolle am weinberg campus', TicketInspector(line='5'), network_data
            ),
            'Weinberg Campus',
        )


if __name__ == '__main__':
    unittest.main()
