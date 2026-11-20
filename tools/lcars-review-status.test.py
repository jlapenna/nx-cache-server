"""Exercise the trusted workflow's inline jq against paginated GitHub reviews."""
import json
from pathlib import Path
import subprocess
import unittest


workflow = Path(__file__).resolve().parents[1] / ".github/workflows/lcars-review-status.yml"
query = workflow.read_text().split(' --arg head "$head" \x27', 1)[1].split("\x27 <<<", 1)[0]
base_event = {"id": "new", "createdAt": "2026-11-01T12:00:00Z"}


def review(state, event=None, verdict=None, submitted="2026-11-01T12:05:00Z"):
    lines = ["<!-- attempt-claim:g1:abc -->"]
    if event:
        lines.append(f"<!-- lcars-review:base-event {event} -->")
    if verdict:
        lines.append(f"<!-- lcars-review:{verdict} -->")
    return {"user": {"login": "agent-lcars[bot]"}, "commit_id": "head",
            "state": state, "body": "\n".join(lines), "submitted_at": submitted}


class ReviewStatus(unittest.TestCase):
    def test_retargeted_reviews(self):
        approved = review("APPROVED", "new")
        requested = review("CHANGES_REQUESTED")
        passed = review("COMMENTED", "new", "pass")
        cases = [
            ([review("CHANGES_REQUESTED", submitted=base_event["createdAt"]), passed], "success"),
            ([review("CHANGES_REQUESTED", "new"), requested, passed], "blocked"),
            ([approved, requested], "provisional_block"),
            ([approved, review("COMMENTED", verdict="block")], "comment_blocked"),
            ([approved, review("CHANGES_REQUESTED", submitted="2026-11-01T11:59:00Z")], "success"),
            ([review("CHANGES_REQUESTED", "old"), passed], "success"),
            ([review("CHANGES_REQUESTED", "new"), passed], "blocked"),
            ([review("APPROVED", "old")], "pending"),
            ([review("APPROVED", "old", submitted="2026-11-01T12:06:00Z")], "pending"),
            ([review("APPROVED")], "pending"),
        ]
        for reviews, expected in cases:
            with self.subTest(reviews=reviews):
                result = subprocess.check_output(
                    ["jq", "-r", "--argjson", "base_event", json.dumps(base_event),
                     "--arg", "head", "head", query],
                    input=json.dumps([reviews]), text=True,
                )
                self.assertEqual(result.strip(), expected)


if __name__ == "__main__":
    unittest.main()
