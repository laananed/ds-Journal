import unittest
from copy import deepcopy

from app.ai.retirement_preflight import RetirementBlocked, classify_sources, plan_requests


class RetirementPreflightTests(unittest.TestCase):
    def test_mixed_sources_require_whole_request_removal(self):
        self.assertTrue(classify_sources([{'type': 'journal', 'id': 1},
                                          {'type': 'inbox', 'id': 2}]))

    def test_journal_only_is_retained(self):
        self.assertFalse(classify_sources([{'type': 'journal', 'id': 1}]))

    def test_unknown_or_malformed_sources_refuse_retirement(self):
        for sources in (None, [], {}, [{'type': 'unknown', 'id': 1}],
                        [{'type': 'inbox'}], [{'type': 'journal', 'id': True}],
                        [{'type': 'journal', 'id': 0}], [None]):
            with self.subTest(sources=sources), self.assertRaises(RetirementBlocked):
                classify_sources(sources)

    def test_plan_removes_whole_mixed_request_and_keeps_journal_request(self):
        rows = [
            {'id': 'mixed', 'status': 'ready', 'sources': [
                {'type': 'inbox', 'id': 2}, {'type': 'journal', 'id': 1}]},
            {'id': 'journal', 'status': 'applied', 'sources': [{'type': 'journal', 'id': 1}]},
        ]
        original = deepcopy(rows)
        self.assertEqual(plan_requests(rows), ['mixed'])
        self.assertEqual(rows, original)

    def test_inflight_unknown_or_unrecognized_status_refuses_all(self):
        for status in ('prepared', 'pending', 'unknown', 'unexpected'):
            with self.subTest(status=status), self.assertRaises(RetirementBlocked):
                plan_requests([{'id': 'x', 'status': status,
                                'sources': [{'type': 'inbox', 'id': 1}]}])

    def test_bad_later_source_refuses_instead_of_returning_partial_plan(self):
        with self.assertRaises(RetirementBlocked):
            plan_requests([{'id': 'x', 'status': 'ready', 'sources': [{'type': 'inbox', 'id': 1}]},
                           {'id': 'y', 'status': 'ready', 'sources': [{'type': 'other', 'id': 2}]}])


if __name__ == '__main__':
    unittest.main()
