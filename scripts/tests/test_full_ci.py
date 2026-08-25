from __future__ import annotations

import pathlib
import unittest


REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]
WORKFLOW_PATH = REPO_ROOT / ".github" / "workflows" / "full-ci.yml"
PLATFORMS = (
    ("linux-x86_64", "ubuntu-24.04"),
    ("linux-aarch64", "ubuntu-24.04-arm"),
    ("macos-x86_64", "macos-15-intel"),
    ("macos-aarch64", "macos-15"),
)


def workflow_job(text: str, job_id: str) -> str:
    start = text.index(f"\n  {job_id}:\n")
    next_starts = []
    for other in ("native", "e2e", "full-suite", "ship-gate"):
        if other == job_id:
            continue
        needle = f"\n  {other}:\n"
        idx = text.find(needle, start + 1)
        if idx != -1:
            next_starts.append(idx)
    end = min(next_starts) if next_starts else len(text)
    return text[start:end]


class FullCiWorkflowTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.workflow = WORKFLOW_PATH.read_text(encoding="utf-8")
        cls.native = workflow_job(cls.workflow, "native")
        cls.e2e = workflow_job(cls.workflow, "e2e")

    def test_full_ci_still_runs_on_every_push(self) -> None:
        self.assertIn("\n  push:\n", self.workflow)
        self.assertNotIn("branches: [main]", self.workflow)

    def test_job_names_match_release_gate_pollers(self) -> None:
        self.assertIn(
            "name: Native checks (${{ matrix.optimize }}, ${{ matrix.platform.name }})",
            self.workflow,
        )
        self.assertIn(
            "name: E2E (${{ matrix.optimize }}, ${{ matrix.platform.name }}, shard ${{ matrix.shard.label }})",
            self.workflow,
        )
        self.assertIn('"Native checks (ReleaseSafe, " + $target + ")"', self.workflow)
        self.assertIn(
            '"E2E (ReleaseSafe, " + $target + ", shard " + ($shard | tostring) + "/4)"',
            self.workflow,
        )

    def test_native_and_e2e_keep_all_four_platforms(self) -> None:
        for name, runner in PLATFORMS:
            self.assertIn(f"name: {name}", self.native)
            self.assertIn(f"runner: {runner}", self.native)
            self.assertIn(f"name: {name}", self.e2e)
            self.assertIn(f"runner: {runner}", self.e2e)
        self.assertIn('label: "1/4"', self.e2e)
        self.assertIn('label: "2/4"', self.e2e)
        self.assertIn('label: "3/4"', self.e2e)
        self.assertIn('label: "4/4"', self.e2e)

    def test_native_uploads_releasesafe_binary_and_keeps_zig_cache(self) -> None:
        self.assertIn("zig build -Doptimize=${{ matrix.optimize }}", self.native)
        self.assertIn("zig build test -Doptimize=${{ matrix.optimize }}", self.native)
        self.assertIn("actions/upload-artifact@", self.native)
        self.assertIn(
            "name: hx-full-ci-${{ matrix.platform.name }}-${{ github.sha }}",
            self.native,
        )
        self.assertIn("path: zig-out/bin/hx", self.native)
        self.assertIn(
            "cache-key: full-ci-native-${{ matrix.platform.name }}-${{ matrix.optimize }}",
            self.native,
        )
        self.assertNotIn("use-cache: false", self.native)
        self.assertNotIn("github.run_id", self.native)
        self.assertNotIn("github.run_attempt", self.native)

    def test_e2e_reuses_native_binary_and_never_compiles(self) -> None:
        self.assertIn("needs: native", self.e2e)
        self.assertIn("actions/download-artifact@", self.e2e)
        self.assertIn(
            "name: hx-full-ci-${{ matrix.platform.name }}-${{ github.sha }}",
            self.e2e,
        )
        self.assertIn("path: zig-out/bin", self.e2e)
        self.assertIn("chmod +x zig-out/bin/hx", self.e2e)
        self.assertIn("FX_REQUIRE_TMUX", self.e2e)
        self.assertIn("bun ci-shards.ts", self.e2e)
        self.assertIn("bun test --max-concurrency 1", self.e2e)
        self.assertIn("Retrying failed E2E file after resetting tmux", self.e2e)
        self.assertNotIn("setup-zig", self.e2e)
        self.assertNotIn("zig build", self.e2e)
        self.assertNotIn("use-cache: false", self.e2e)
        self.assertNotIn("github.run_id", self.e2e)
        self.assertNotIn("github.run_attempt", self.e2e)


if __name__ == "__main__":
    unittest.main()
