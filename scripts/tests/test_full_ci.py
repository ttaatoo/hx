from __future__ import annotations

import re
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]
WORKFLOW_PATH = REPO_ROOT / ".github" / "workflows" / "full-ci.yml"
NATIVE_ACTION_PATH = REPO_ROOT / ".github" / "actions" / "full-ci-native" / "action.yml"
E2E_ACTION_PATH = REPO_ROOT / ".github" / "actions" / "full-ci-e2e" / "action.yml"
BENCHMARK_WORKFLOW_PATH = REPO_ROOT / ".github" / "workflows" / "bench.yml"
PLATFORMS = (
    ("linux-x86_64", "ubuntu-24.04", "x86_64-linux-gnu"),
    ("linux-aarch64", "ubuntu-24.04-arm", "aarch64-linux-gnu"),
    ("macos-x86_64", "macos-15-intel", "x86_64-macos"),
    ("macos-aarch64", "macos-15", "aarch64-macos"),
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
        cls.benchmark_workflow = BENCHMARK_WORKFLOW_PATH.read_text(encoding="utf-8")
        cls.jobs = workflow_jobs(cls.workflow)

    def test_full_ci_runs_for_main_and_requested_pr_candidates(self) -> None:
        self.assertIn("\n  push:\n    branches: [main]", self.workflow)
        self.assertIn("\n  pull_request:\n", self.workflow)
        self.assertIn(
            "types: [opened, reopened, synchronize, labeled, unlabeled, ready_for_review]",
            self.workflow,
        )

    def test_candidate_gate_requires_the_full_ci_label_for_non_draft_prs(self) -> None:
        candidate = self.jobs["candidate"]
        self.assertIn("name: Full CI candidate", candidate)
        self.assertIn("run_full: ${{ steps.decide.outputs.run_full }}", candidate)
        self.assertIn('"full-ci"', candidate)
        self.assertIn('"pull_request"', candidate)
        self.assertIn('"labeled"', candidate)
        self.assertIn('"unlabeled"', candidate)
        self.assertIn("PR_DRAFT:", candidate)
        self.assertIn("A non-draft PR must have the full-ci label", candidate)
        for name, _runner, _target in PLATFORMS:
            native = self.jobs[f"native-{name}"]
            self.assertIn("needs: candidate", native)
            self.assertIn("needs.candidate.outputs.run_full == 'true'", native)
        full_suite = self.jobs["full-suite"]
        self.assertIn("- candidate", full_suite)
        self.assertIn("needs.candidate.outputs.run_full == 'true'", full_suite)
        self.assertIn("needs.full-suite.result == 'success'", self.jobs["ship-gate"])

    def test_metadata_label_events_do_not_cancel_candidate_work(self) -> None:
        self.assertIn(
            "group: full-ci-${{ github.event.pull_request.number || github.ref }}-${{ (github.event.action == 'labeled' || github.event.action == 'unlabeled') && github.event.label.name != 'full-ci' && 'metadata' || 'candidate' }}",
            self.workflow,
        )

    def test_job_names_match_release_gate_pollers(self) -> None:
        for name, _runner, _target in PLATFORMS:
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
        for name, runner, target in PLATFORMS:
            native = self.jobs[f"native-{name}"]
            e2e = self.jobs[f"e2e-{name}"]
            self.assertIn(f"runs-on: {runner}", native)
            self.assertIn(f"target: {target}", native)
            self.assertIn(f"runs-on: {runner}", e2e)
            self.assertIn('label: "1/4"', e2e)
            self.assertIn('label: "2/4"', e2e)
            self.assertIn('label: "3/4"', e2e)
            self.assertIn('label: "4/4"', e2e)
        self.assertNotIn("\n  native:\n", self.workflow)
        self.assertNotIn("\n  e2e:\n", self.workflow)

    def test_native_uploads_releasesafe_binary_and_keeps_zig_cache(self) -> None:
        self.assertIn("target:", self.native_action)
        self.assertIn(
            "zig build -Dtarget=${{ inputs.target }} -Doptimize=${{ inputs.optimize }}",
            self.native_action,
        )
        self.assertIn(
            "zig build test -Dtarget=${{ inputs.target }} -Doptimize=${{ inputs.optimize }}",
            self.native_action,
        )
        self.assertIn("actions/upload-artifact@", self.native_action)
        self.assertIn(
            "name: hx-full-ci-${{ inputs.platform }}-${{ github.sha }}",
            self.native_action,
        )
        self.assertIn("zig-out/bin/hx", self.native_action)
        self.assertIn("zig-out/bin/mcp-stdio-dispatcher-driver", self.native_action)
        self.assertIn("zig-out/bin/terminal-client-fixture", self.native_action)
        self.assertIn(
            "cache-key: full-ci-native-${{ inputs.platform }}-${{ inputs.optimize }}",
            self.native_action,
        )
        self.assertNotIn("zig build-exe", self.native_action)
        self.assertIn("dynamically linked", self.native_action)
        self.assertNotIn("target: x86_64-linux\n", self.workflow)
        self.assertNotIn("target: aarch64-linux\n", self.workflow)
        self.assertNotIn("use-cache: false", self.native_action)
        self.assertNotIn("github.run_id", self.native_action)
        self.assertNotIn("github.run_attempt", self.native_action)
        build_zig = (REPO_ROOT / "build.zig").read_text(encoding="utf-8")
        self.assertIn('.name = "terminal-client-fixture"', build_zig)
        self.assertIn("src/terminal_client_fixture.zig", build_zig)
        self.assertIn(".optimize = .Debug", build_zig)
        self.assertIn("b.installArtifact(terminal_client_fixture)", build_zig)

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
        self.assertNotIn("path: .", self.e2e_action)
        self.assertIn("chmod +x zig-out/bin/hx", self.e2e_action)
        self.assertIn("zig-out/bin/mcp-stdio-dispatcher-driver", self.e2e_action)
        self.assertIn("zig-out/bin/terminal-client-fixture", self.e2e_action)
        self.assertIn(
            "FX_REQUIRE_TMUX",
            "\n".join(self.jobs[f"e2e-{n}"] for n, _, _ in PLATFORMS),
        )
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
        for name, _runner, _target in PLATFORMS:
            self.assertNotIn("fetch-depth: 0", self.jobs[f"e2e-{name}"])
            self.assertNotIn("zig build", self.jobs[f"e2e-{name}"])
            self.assertNotIn("setup-zig", self.jobs[f"e2e-{name}"])

    def test_e2e_needs_only_its_own_platform_native_job(self) -> None:
        self.assertNotIn("needs: native\n", self.workflow)
        self.assertNotIn("needs:\n      - native\n", self.workflow)
        for name, _runner, _target in PLATFORMS:
            needed = job_needs(self.jobs[f"e2e-{name}"])
            self.assertEqual([f"native-{name}"], needed)
            for other, _other_runner, _other_target in PLATFORMS:
                if other == name:
                    continue
                self.assertNotIn(f"native-{other}", needed)

    def test_benchmarks_run_for_main_or_requested_candidates(self) -> None:
        self.assertIn("\n  push:\n    branches: [main]", self.benchmark_workflow)
        self.assertIn("\n  pull_request:\n    types: [labeled, synchronize]", self.benchmark_workflow)
        self.assertIn(
            "contains(github.event.pull_request.labels.*.name, 'full-ci')",
            self.benchmark_workflow,
        )
        self.assertIn(
            "github.event.label.name == 'full-ci'",
            self.benchmark_workflow,
        )
        self.assertIn("'metadata' || 'candidate'", self.benchmark_workflow)


if __name__ == "__main__":
    unittest.main()
