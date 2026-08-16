import unittest
from unittest.mock import patch

from nlp_service.config.config import (
    CHAT_NETWORKS,
    chats_for_network,
    is_known_chat,
    parse_chat_networks,
)


class TestParseChatNetworks(unittest.TestCase):

    def test_multiple_chats(self):
        self.assertEqual(
            parse_chat_networks('-1001234:berlin, -1005678:hamburg'),
            {'-1001234': 'berlin', '-1005678': 'hamburg'},
        )

    def test_single_chat(self):
        self.assertEqual(parse_chat_networks('-1001234:berlin'), {'-1001234': 'berlin'})

    def test_trailing_comma_is_ignored(self):
        self.assertEqual(parse_chat_networks('-1001234:berlin,'), {'-1001234': 'berlin'})

    def test_missing_network_is_rejected(self):
        with self.assertRaises(ValueError):
            parse_chat_networks('-1001234')

    def test_empty_network_is_rejected(self):
        with self.assertRaises(ValueError):
            parse_chat_networks('-1001234:')

    def test_duplicate_chat_is_rejected(self):
        # Otherwise one of the two networks would silently win.
        with self.assertRaises(ValueError):
            parse_chat_networks('-1001234:berlin,-1001234:hamburg')


class TestChatLookups(unittest.TestCase):

    def setUp(self):
        chats = {'-1001234': 'berlin', '-1005678': 'berlin', '-1009999': 'hamburg'}
        patcher = patch.dict(CHAT_NETWORKS, chats, clear=True)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_all_groups_of_a_network(self):
        # Both Berlin groups are announced in, not just the first one.
        self.assertEqual(chats_for_network('berlin'), ['-1001234', '-1005678'])

    def test_single_group_of_a_network(self):
        self.assertEqual(chats_for_network('hamburg'), ['-1009999'])

    def test_network_without_a_group(self):
        self.assertEqual(chats_for_network('koeln'), [])

    def test_known_chat_accepts_the_telegram_integer(self):
        self.assertTrue(is_known_chat(-1001234))
        self.assertTrue(is_known_chat('-1001234'))

    def test_unknown_chat(self):
        self.assertFalse(is_known_chat(-4711))


if __name__ == '__main__':
    unittest.main()
