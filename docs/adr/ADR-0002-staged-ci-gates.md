# ADR-0002: Stage costly CI checks

## Status

Accepted

## Context

Full CI runs four native platforms and four isolated E2E shards per platform.
Running that matrix on every feature-branch push makes normal PR feedback wait
for hosted macOS capacity. The project still needs the full matrix for a
release candidate and for the exact commit on `main`.

## Options Considered

1. **Keep Full CI on every push**: This keeps one simple rule, but it makes
   every small PR revision wait for release-level coverage.
2. **Remove native platforms or E2E coverage**: This lowers run time, but it
   weakens the release proof.
3. **Stage the gates**: Run the fast Linux CI on every PR revision. Run the
   complete matrix only for a requested candidate, manual dispatch, and
   `main`.

## Decision

Use staged gates.

- Standard PR CI remains the fast, always-on gate.
- A draft PR requests its complete candidate run with the `full-ci` label.
  Later revisions with that label run the candidate again.
- A non-draft PR without the label fails a lightweight candidate gate.
- Full CI continues to run for the exact `main` commit and on manual dispatch.
- Benchmarks run for `main`, manual dispatch, and requested candidates.
  Binary-size comparisons run only for requested candidate PRs.
- The complete candidate matrix keeps all four native platforms and all E2E
  shards.

## Consequences

### Positive

- Normal PR revisions avoid hosted macOS queue time.
- The final candidate still has the complete native and E2E proof.
- The release workflow still observes a Full CI Ship gate for the exact
  `main` commit.

### Negative

- Maintainers must apply the `full-ci` label before a draft PR is made ready.
- A candidate run can still take time when hosted macOS capacity is limited.

### Risks and Mitigations

- **Risk:** A reused artifact contains CPU features that a consumer runner
  cannot execute.
  **Mitigation:** Build artifacts for an explicit platform target and exercise
  them in the E2E consumer jobs.
- **Risk:** A candidate check is skipped by mistake.
  **Mitigation:** A non-draft PR without `full-ci` fails its candidate gate,
  and the documented release proof remains an exact `main` Full CI run.

## References

- [`full-ci.yml`](../../.github/workflows/full-ci.yml)
- [`ci.yml`](../../.github/workflows/ci.yml)
- [`bench.yml`](../../.github/workflows/bench.yml)
- [`binary-size.yml`](../../.github/workflows/binary-size.yml)
- [`AGENTS.md`](../../AGENTS.md)
