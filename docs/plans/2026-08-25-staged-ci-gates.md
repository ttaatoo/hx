# Staged CI Gates Implementation Plan

**Goal:** Reduce normal PR wait time without removing release-candidate
coverage.

**Scope:** Full CI triggers and artifact portability, benchmark and binary-size
triggers, workflow contract tests, and maintainer documentation.

**Assumptions:** GitHub merge queue is not configured. A `full-ci` label is the
candidate request on a draft PR. The `main` push remains the release proof.

**Risks:** A reused binary can contain CPU features that are not available on a
consumer runner. A skipped candidate workflow must not make a non-draft PR
appear eligible to merge.

## Task 1: Record the decision

Files:

- Create: `docs/adr/ADR-0002-staged-ci-gates.md`
- Create: this plan

Steps:

1. Record the alternatives and the `full-ci` candidate label decision.
2. Keep the release proof on the exact `main` commit.

Done when:

- The ADR explains the trigger and coverage contract.

## Task 2: Make Full CI portable and staged

Files:

- Modify: `.github/workflows/full-ci.yml`
- Modify: `.github/actions/full-ci-native/action.yml`
- Modify: `scripts/tests/test_full_ci.py`

Steps:

1. Build each reusable binary for an explicit platform target.
2. Run the expensive four-platform matrix only for `main`, manual dispatch, or
   a PR that requests `full-ci`.
3. Make a non-draft PR without that label fail its lightweight candidate gate.

Verification:

- `python3 -m unittest scripts.tests.test_full_ci -v`

## Task 3: Move optional checks to the candidate path

Files:

- Modify: `.github/workflows/bench.yml`
- Modify: `.github/workflows/binary-size.yml`
- Modify: `scripts/tests/test_binary_size.py`

Steps:

1. Run benchmarks on `main`, manual dispatch, or a requested candidate.
2. Run binary-size comparisons only for a requested candidate PR.

Verification:

- `python3 -m unittest scripts.tests.test_binary_size -v`

## Task 4: Update maintainer policy and verify

Files:

- Modify: `AGENTS.md`
- Modify: `CONTRIBUTING.md`
- Modify: `.github/pull_request_template.md`

Steps:

1. Document the draft, label, and exact-SHA candidate sequence.
2. Parse the changed workflows and run focused contract tests.
3. Build and exercise `./zig-out/bin/hx help` from this checkout.

Done when:

- The focused workflow tests pass, the workflows parse, and the binary runs.
