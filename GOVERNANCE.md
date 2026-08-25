# Governance

## Project status

`hx` is an experimental, open-source project. The repository is maintained by
one person at this time.

## Maintainer authority

[@ttaatoo](https://github.com/ttaatoo) is the current repository owner and
maintainer. The maintainer has final authority over:

- accepting or rejecting changes;
- repository settings, branch rules, and code ownership;
- security triage and coordinated disclosure;
- version numbers, release notes, and releases; and
- appointing another maintainer in a future public change.

This project does not name a second maintainer. A review request to `@ttaatoo`
is not independent two-person review.

## Decisions

- Use a pull request for code, documentation, and policy changes.
- Keep changes small and include evidence from the relevant tests and runtime.
- Discuss a large design or security change before implementation when practical.
- The maintainer may request changes, close a pull request, or merge it after
  the required checks pass.
- Public behavior and security claims must match the current source and tests.

## Releases

The maintainer decides when a release is suitable. A release must use the
repository release workflow and the checks required by
[`CONTRIBUTING.md`](CONTRIBUTING.md), including Full CI for the exact commit.
Release automation owns the release tag and publication steps after the
maintainer-controlled change is merged.

## Changes to this policy

The maintainer may update this document in a public pull request. A future
maintainer appointment must be recorded in a public repository change.
