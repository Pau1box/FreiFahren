"""What a whole message turns into, for a line and a station that used to be lost on the way.

A numeric line was only recognised right behind the word "tram", and a station missing from the
synonym file was matched and then dropped. Both left the report incomplete without an error
anywhere, so these two messages are checked end to end.
"""

import unittest

from nlp_service.core.processor import extract_ticket_inspector_info
from nlp_service.core.testing.seed_networks import load_seed_network


def seed_network(network_id):
    network_data = load_seed_network(network_id)
    if network_data is None:
        raise unittest.SkipTest(
            f'Seed data for {network_id} is not available in this checkout'
        )
    return network_data


class TestReportExtraction(unittest.TestCase):

    def test_halle_numeric_line_with_direction(self):
        info = extract_ticket_inspector_info(
            'Kontrolle in der 5 Richtung Kröllwitz am Weinberg Campus',
            seed_network('halle'),
        )
        self.assertEqual(
            info,
            {
                'station': 'Weinberg Campus',
                'direction': 'Kröllwitz',
                'line': '5',
            },
        )

    def test_berlin_tram_line_and_station(self):
        info = extract_ticket_inspector_info(
            'Tram 21 Kontrolle an der Marktstraße', seed_network('berlin')
        )
        self.assertEqual(
            info,
            {
                'station': 'Marktstraße',
                'direction': None,
                'line': '21',
            },
        )


if __name__ == '__main__':
    unittest.main()
