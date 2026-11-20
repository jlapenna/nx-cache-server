"""Exercise the trusted workflow's inline jq against paginated GitHub reviews."""
import json
from pathlib import Path
import subprocess
import unittest


workflow = Path(__file__).resolve().parents[1] / ".github/workflows/lcars-review-status.yml"
query = workflow.read_text().split(' --arg head "$head" \x27', 1)[1].split("\x27 <<<", 1)[0]
changed_at = "2026-11-01T12:00:00Z"


def review(state, verdict=None, submitted="2026-11-01T12:05:00Z"):
    lines = ["<!-- attempt-claim:g1:abc -->"]
    if verdict:
        lines.append(f"<!-- lcars-review:{verdict} -->")
    return {"user": {"login": "agent-lcars[bot]"}, "commit_id": "head",
            "state": state, "body": "\n".join(lines), "submitted_at": submitted}


class ReviewStatus(unittest.TestCase):
    def test_retargeted_reviews(self):
        approved = review("APPROVED")
        requested = review("CHANGES_REQUESTED")
        passed = review("COMMENTED", verdict="pass")
        cases = [
            ([approved], "success"),
            ([passed], "success"),
            ([requested, passed], "blocked"),
            ([requested, approved], "success"),
            ([approved, review("COMMENTED", verdict="block")], "comment_blocked"),
            ([review("APPROVED", submitted=changed_at)], "pending"),
            ([review("CHANGES_REQUESTED", submitted="2026-11-01T11:59:00Z"), passed], "success"),
        ]
        for reviews, expected in cases:
            with self.subTest(reviews=reviews):
                result = subprocess.check_output(
                    ["jq", "-r", "--arg", "changed_at", changed_at,
                     "--arg", "head", "head", query],
                    input=json.dumps([reviews]), text=True,
                )
                self.assertEqual(result.strip(), expected)


if __name__ == "__main__":
    unittest.main()
