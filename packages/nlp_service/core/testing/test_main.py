import unittest
import sys
import os

# root directory of the project
root_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
sys.path.insert(0, root_dir)

from nlp_service.core.testing.remove_direction_and_keyword_test import TestRemoveDirectionAndKeyword
from nlp_service.core.testing.check_for_spam_test import TestCheckForSpam
from nlp_service.core.testing.chat_networks_test import TestChatLookups, TestParseChatNetworks
from nlp_service.core.testing.station_extractor_test import (
    TestBuildStationLookup,
    TestFindStationInSeedNetworks,
    TestFindStationsOfLine,
    TestGetBestMatch,
)
from nlp_service.core.testing.line_extractor_test import (
    TestFindLineInBerlin,
    TestFindLineWithSeparators,
    TestFindNumericLine,
)
from nlp_service.core.testing.report_extraction_test import TestReportExtraction

red = '\033[91m'
reset = '\033[0m'
gray = '\033[90m'

total_tests = 344


class EmojiTestResult(unittest.TextTestResult):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)

    def wasSuccessful(self):
        # Check if there are any errors or failures
        return self.failures == [] and self.errors == []

    def printErrors(self):
        # Print out any errors or failures
        super().printErrors()
        if self.wasSuccessful():
            # Print a custom message with green text (ANSI escape code) and emojis if all tests pass
            print('\033[92mAll tests passed! 🎉🎉🎉\033[0m')


class EmojiTextTestRunner(unittest.TextTestRunner):
    def __init__(self, *args, **kwargs):
        # Ensure we use the EmojiTestResult class
        kwargs['resultclass'] = EmojiTestResult
        super().__init__(*args, **kwargs)


def create_test_suite():
    """The suite this file runs when it is executed directly, for the emoji runner below.

    CI does not call this. It runs `unittest discover`, which imports this module and collects the
    test classes it finds as attributes, so what makes a class run in CI is the import at the top of
    this file, not its line here. A class added to this suite without being imported above runs
    locally and stays silent in CI, which is the more expensive half of that pair to get wrong.

    `loadTestsFromTestCase` rather than `makeSuite`: the latter is gone as of Python 3.13, and CI
    still pins 3.9, so the difference only shows up on a current interpreter, where the whole file
    fails to run.
    """
    loader = unittest.TestLoader()
    test_suite = unittest.TestSuite()
    for test_case in (
        TestRemoveDirectionAndKeyword,
        TestCheckForSpam,
        TestParseChatNetworks,
        TestChatLookups,
        TestFindStationsOfLine,
        TestGetBestMatch,
        TestBuildStationLookup,
        TestFindStationInSeedNetworks,
        TestFindNumericLine,
        TestFindLineInBerlin,
        TestFindLineWithSeparators,
        TestReportExtraction,
    ):
        test_suite.addTest(loader.loadTestsFromTestCase(test_case))
    return test_suite


if __name__ == '__main__':
    suite = create_test_suite()
    runner = EmojiTextTestRunner(verbosity=2)
    runner.run(suite)
