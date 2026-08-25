from __future__ import annotations

import pathlib
import unittest


class ReleaseWorkflowContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.repo_root = pathlib.Path(__file__).resolve().parents[2]

    def test_release_gate_is_bound_to_full_ci_workflow(self) -> None:
        workflow = (
            self.repo_root / ".github/workflows/release.yml"
        ).read_text()

        self.assertIn(
            "actions/workflows/full-ci.yml/runs?head_sha=${TARGET_SHA}&event=push",
            workflow,
        )
        self.assertIn('.path == ".github/workflows/full-ci.yml"', workflow)
        self.assertIn('.name == "Full CI"', workflow)
        self.assertIn('.name == "Ship gate"', workflow)
        self.assertIn("actions/runs/${run_id}/jobs", workflow)
        self.assertNotIn(
            "commits/${TARGET_SHA}/check-runs?check_name=Ship%20gate",
            workflow,
        )

    def test_dependabot_covers_the_conformance_npm_graph(self) -> None:
        config = (self.repo_root / ".github/dependabot.yml").read_text()

        self.assertIn("package-ecosystem: npm", config)
        self.assertIn("directory: /tests/e2e/conformance", config)


if __name__ == "__main__":
    unittest.main()
