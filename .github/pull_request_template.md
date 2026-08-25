## Summary

<!-- State what changed and why. Keep the scope narrow. -->

## Type label

Choose exactly one `type:` label in the PR metadata:

- [ ] `type: bug`
- [ ] `type: feature`
- [ ] `type: improvement`
- [ ] `type: docs`
- [ ] `type: maintenance`
- [ ] `type: release`
- [ ] `type: security`

## Verification

- [ ] I ran the focused test or check for the changed path.
- [ ] I ran `zig fmt --check src/` when the change touches Zig source.
- [ ] I built the current checkout with `zig build`.
- [ ] I ran `./zig-out/bin/hx` and exercised the changed path with a real
      terminal or CLI interaction. I checked the exit status and stderr.
- [ ] Full CI passed for the exact current commit on all required runners. If
      it has not passed, this PR remains a draft.

## Security

- [ ] I did not add secrets, tokens, passwords, or private data.
- [ ] I reviewed permission, command, filesystem, MCP, OAuth, provider, and
      sandbox impact when this change touches those boundaries.
- [ ] I updated [`docs/security/threat-model.md`](../docs/security/threat-model.md)
      when the trust boundary, mitigation, or residual risk changed.
- [ ] I did not publish zero-day details. I used [`SECURITY.md`](../SECURITY.md)
      for any private vulnerability report.

## Documentation

- [ ] I updated the relevant help text, README, or documentation for a
      user-facing behavior change.
- [ ] I added or updated tests and E2E corpus ownership when the product path
      changed.

## Scope check

- [ ] This PR does not include unrelated changes.
- [ ] I preserved existing user and other-agent changes.
