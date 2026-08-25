from __future__ import annotations

import re
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]
WORKFLOW_PATH = REPO_ROOT / ".github" / "workflows" / "full-ci.yml"
NATIVE_ACTION_PATH = REPO_ROOT / ".github" / "actions" / "full-ci-native" / "action.yml"
E2E_ACTION_PATH = REPO_ROOT / ".github" / "actions" / "full-ci-e2e" / "action.yml"
PLATFORMS = (
    ("linux-x86_64", "ubuntu-24.04"),
    ("linux-aarch64", "ubuntu-24.04-arm"),
    ("macos-x86_64", "macos-15-intel"),
    ("macos-aarch64", "macos-15"),
)
JOB_HEADER = re.compile(r"^  ([A-Za-z0-9_-]+):\s*$", re.M)


def workflow_jobs(text: str) -> dict[str, str]:
    jobs_start = text.index("\njobs:\n")
    matches = [m for m in JOB_HEADER.finditer(text) if m.start() > jobs_start]
    extracted: dict[str, str] = {}
    for index, match in enumerate(matches):
        end = matches[index + 1].start() if index + 1 < len(matches) else len(text)
        extracted[match.group(1)] = text[match.start() : end]
    return extracted


def job_needs(job_text: str) -> list[str]:
    lines = job_text.splitlines()
    for index, line in enumerate(lines):
        if not line.startswith("    needs:"):
            continue
        inline = line[len("    needs:") :].strip()
        if inline:
            return [inline]
        needed: list[str] = []
        for follow in lines[index + 1 :]:
            if follow.startswith("      - "):
                needed.append(follow[len("      - ") :].strip())
                continue
            break
        return needed
    return []


class FullCiWorkflowTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.workflow = WORKFLOW_PATH.read_text(encoding="utf-8")
        cls.native_action = NATIVE_ACTION_PATH.read_text(encoding="utf-8")
        cls.e2e_action = E2E_ACTION_PATH.read_text(encoding="utf-8")
        cls.jobs = workflow_jobs(cls.workflow)

    def test_full_ci_still_runs_on_every_push(self) -> None:
        self.assertIn("\n  push:\n", self.workflow)
        self.assertNotIn("branches: [main]", self.workflow)

    def test_job_names_match_release_gate_pollers(self) -> None:
        for name, _runner in PLATFORMS:
            self.assertIn(f"name: Native checks (ReleaseSafe, {name})", self.workflow)
            self.assertIn(
                f"name: E2E (ReleaseSafe, {name}, shard ${{{{ matrix.shard.label }}}})",
                self.workflow,
            )
        self.assertIn('"Native checks (ReleaseSafe, " + $target + ")"', self.workflow)
        self.assertIn(
            '"E2E (ReleaseSafe, " + $target + ", shard " + ($shard | tostring) + "/4)"',
            self.workflow,
        )

    def test_native_and_e2e_keep_all_four_platforms(self) -> None:
        for name, runner in PLATFORMS:
            native = self.jobs[f"native-{name}"]
            e2e = self.jobs[f"e2e-{name}"]
            self.assertIn(f"runs-on: {runner}", native)
            self.assertIn(f"runs-on: {runner}", e2e)
            self.assertIn('label: "1/4"', e2e)
            self.assertIn('label: "2/4"', e2e)
            self.assertIn('label: "3/4"', e2e)
            self.assertIn('label: "4/4"', e2e)
        self.assertNotIn("\n  native:\n", self.workflow)
        self.assertNotIn("\n  e2e:\n", self.workflow)

    def test_native_uploads_releasesafe_binary_and_keeps_zig_cache(self) -> None:
        self.assertIn("zig build -Doptimize=${{ inputs.optimize }}", self.native_action)
        self.assertIn(
            "zig build test -Doptimize=${{ inputs.optimize }}", self.native_action
        )
        self.assertIn("actions/upload-artifact@", self.native_action)
        self.assertIn(
            "name: hx-full-ci-${{ inputs.platform }}-${{ github.sha }}",
            self.native_action,
        )
        self.assertIn("path: zig-out/bin/hx", self.native_action)
        self.assertIn(
            "cache-key: full-ci-native-${{ inputs.platform }}-${{ inputs.optimize }}",
            self.native_action,
        )
        self.assertNotIn("use-cache: false", self.native_action)
        self.assertNotIn("github.run_id", self.native_action)
        self.assertNotIn("github.run_attempt", self.native_action)

    def test_e2e_reuses_native_binary_and_never_compiles(self) -> None:
        self.assertIn("actions/download-artifact@", self.e2e_action)
        self.assertIn(
            "d3f86a106a0bac45b974a628896c90dbdf5c8093 # v4.3.0",
            self.e2e_action,
        )
        self.assertIn(
            "name: hx-full-ci-${{ inputs.platform }}-${{ github.sha }}",
            self.e2e_action,
        )
        self.assertIn("path: zig-out/bin", self.e2e_action)
        self.assertIn("chmod +x zig-out/bin/hx", self.e2e_action)
        self.assertIn("FX_REQUIRE_TMUX", "\n".join(self.jobs[f"e2e-{n}"] for n, _ in PLATFORMS))
        self.assertIn("bun ci-shards.ts", self.e2e_action)
        self.assertIn("bun test --max-concurrency 1", self.e2e_action)
        self.assertIn("Retrying failed E2E file after resetting tmux", self.e2e_action)
        self.assertNotIn("setup-zig", self.e2e_action)
        self.assertNotIn("zig build", self.e2e_action)
        self.assertNotIn("use-cache: false", self.e2e_action)
        self.assertNotIn("github.run_id", self.e2e_action)
        self.assertNotIn("github.run_attempt", self.e2e_action)
        self.assertNotIn("timeout-minutes", self.e2e_action)
        self.assertNotIn("fetch-depth: 0", self.e2e_action)
        for name, _runner in PLATFORMS:
            self.assertNotIn("fetch-depth: 0", self.jobs[f"e2e-{name}"])
            self.assertNotIn("zig build", self.jobs[f"e2e-{name}"])
            self.assertNotIn("setup-zig", self.jobs[f"e2e-{name}"])

    def test_e2e_needs_only_its_own_platform_native_job(self) -> None:
        self.assertNotIn("needs: native\n", self.workflow)
        self.assertNotIn("needs:\n      - native\n", self.workflow)
        for name, _runner in PLATFORMS:
            needed = job_needs(self.jobs[f"e2e-{name}"])
            self.assertEqual([f"native-{name}"], needed)
            for other, _other_runner in PLATFORMS:
                if other == name:
                    continue
                self.assertNotIn(f"native-{other}", needed)


if __name__ == "__main__":
    unittest.main()
