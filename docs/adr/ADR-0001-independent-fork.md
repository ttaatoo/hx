# ADR-0001: Maintain hx as an independently evolved fork

## Status

Accepted

## Context

hx is derived from [vercel-labs/fx](https://github.com/vercel-labs/fx), but it
has its own product name, repository, providers, runtime behavior, and release
process. The project needs a clear maintenance model that does not imply that
hx is an official Vercel product or that the two projects have identical
behavior.

The last synchronization reference is upstream commit
[`c864c677722679c4d5fb9473f1e8c41e4156df94`](https://github.com/vercel-labs/fx/commit/c864c677722679c4d5fb9473f1e8c41e4156df94),
dated 2026-08-25. The decision must also preserve applicable upstream and
third-party attribution without making a file-by-file legal conclusion.

## Options Considered

1. **GitHub fork relationship** — Keep the repository as a GitHub fork of
   `vercel-labs/fx`. This makes provenance visible, but it keeps a platform
   relationship that can imply shared ownership or shared maintenance and does
   not define how hx-specific changes should diverge.
2. **Periodic upstream synchronization** — Maintain a regular merge or rebase
   schedule from upstream. This can reduce drift, but it creates ongoing
   coordination work and may repeatedly reintroduce behavior that hx has
   intentionally changed.
3. **Independent evolution** — Keep hx as its own repository and review
   upstream changes manually when they matter. This gives hx clear ownership
   and release control, but it requires deliberate review for security fixes
   and other upstream improvements.

## Decision

The user chose **independent evolution**. hx is maintained as an independently
evolved project derived from fx. It has no promise of periodic or automatic
upstream synchronization. The repository keeps applicable attribution and
links to upstream, while product, security, and release decisions remain with
the hx maintainers.

For upstream security review, maintainers fetch the optional `upstream` remote,
inspect changes after the recorded synchronization reference, and compare
those changes with upstream release notes and security advisories. Relevant
fixes are evaluated and ported manually.

## Consequences

### Positive

- hx can evolve its product, providers, runtime, and release process without an
  implied shared maintenance schedule.
- The repository name, package identity, attribution, and non-affiliation
  statement are explicit.
- The recorded reference gives maintainers a concrete starting point for
  upstream review.

### Negative

- Upstream improvements and fixes can require manual comparison and porting.
- hx can diverge from fx in behavior, documentation, and compatibility.

### Risks and Mitigations

- **Risk:** An upstream security fix is missed because synchronization is not
  automatic.
  **Mitigation:** Fetch upstream, inspect commits after the recorded reference,
  and review upstream release notes and security advisories before releases.
- **Risk:** Users confuse hx with an official Vercel product.
  **Mitigation:** Keep the independent lineage and non-affiliation statements
  in the README and NOTICE.

## References

- [vercel-labs/fx](https://github.com/vercel-labs/fx)
- [Last synchronization reference](https://github.com/vercel-labs/fx/commit/c864c677722679c4d5fb9473f1e8c41e4156df94)
- [fx security advisories](https://github.com/vercel-labs/fx/security/advisories)
- [hx repository](https://github.com/ttaatoo/hx)
- [NOTICE](../../NOTICE)
- [Third-party notices](../../THIRD_PARTY_NOTICES.md)
