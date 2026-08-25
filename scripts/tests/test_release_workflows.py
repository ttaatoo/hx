from __future__ import annotations

import pathlib
import re
import subprocess
import unittest


class ReleaseWorkflowContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.repo_root = pathlib.Path(__file__).resolve().parents[2]
        cls.release_workflow = (
            cls.repo_root / ".github/workflows/release.yml"
        ).read_text(encoding="utf-8")

    def test_release_gate_is_bound_to_full_ci_workflow(self) -> None:
        workflow = self.release_workflow

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

    def test_missing_github_release_is_not_treated_as_published(self) -> None:
        workflow = self.release_workflow

        self.assertNotIn('[ -n "$RELEASE_JSON" ]', workflow)
        self.assertIn(
            '.id | (type == "number" or type == "string")',
            workflow,
        )
        self.assertIn('.draft == true', workflow)
        self.assertIn(
            "refusing to clobber even with force",
            workflow,
        )

        exists_expr = self._release_exists_jq_expr(workflow)
        draft_expr = self._release_draft_jq_expr(workflow)
        cases = (
            ("", "missing"),
            ('{"message":"Not Found"}', "missing"),
            ('{"draft":true}', "missing"),
            ('{"id":1,"draft":true}', "draft"),
            ('{"id":"42","draft":true}', "draft"),
            ('{"id":1,"draft":false}', "published"),
            ('{"id":1}', "published"),
        )
        for payload, expected in cases:
            with self.subTest(payload=payload, expected=expected):
                self.assertEqual(
                    expected,
                    self._classify_release_json(exists_expr, draft_expr, payload),
                )

    def test_dependabot_covers_the_conformance_npm_graph(self) -> None:
        config = (self.repo_root / ".github/dependabot.yml").read_text()

        self.assertIn("package-ecosystem: npm", config)
        self.assertIn("directory: /tests/e2e/conformance", config)

    @staticmethod
    def _release_exists_jq_expr(workflow: str) -> str:
        match = re.search(
            r"""jq -e '(?P<expr>\.id \| \(type == "number" or type == "string"\))'""",
            workflow,
        )
        if match is None:
            raise AssertionError("release existence jq expression is missing")
        return match.group("expr")

    @staticmethod
    def _release_draft_jq_expr(workflow: str) -> str:
        match = re.search(r"jq -e '(?P<expr>\.draft == true)'", workflow)
        if match is None:
            raise AssertionError("release draft jq expression is missing")
        return match.group("expr")

    @staticmethod
    def _classify_release_json(
        exists_expr: str, draft_expr: str, payload: str
    ) -> str:
        exists = subprocess.run(
            ["jq", "-e", exists_expr],
            input=payload,
            capture_output=True,
            text=True,
            check=False,
        )
        if exists.returncode != 0:
            return "missing"
        draft = subprocess.run(
            ["jq", "-e", draft_expr],
            input=payload,
            capture_output=True,
            text=True,
            check=False,
        )
        if draft.returncode == 0:
            return "draft"
        return "published"


if __name__ == "__main__":
    unittest.main()
