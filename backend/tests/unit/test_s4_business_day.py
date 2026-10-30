from datetime import date, datetime, timezone
import unittest

from app.ritual.dates import business_date


class BusinessDateTests(unittest.TestCase):
    def test_boundary_uses_shanghai_time(self):
        self.assertEqual(business_date(datetime(2026, 10, 29, 19, 59, 59, tzinfo=timezone.utc)), date(2026, 10, 29))
        self.assertEqual(business_date(datetime(2026, 10, 29, 20, 0, tzinfo=timezone.utc)), date(2026, 10, 30))

    def test_naive_datetime_is_rejected(self):
        with self.assertRaises(ValueError):
            business_date(datetime(2026, 10, 30, 4))

    def test_year_boundary(self):
        self.assertEqual(business_date(datetime(2025, 12, 31, 19, 59, tzinfo=timezone.utc)), date(2025, 12, 31))


if __name__ == '__main__':
    unittest.main()
