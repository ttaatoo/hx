# Security policy

`hx` is experimental software. Do not use it for work that needs a high-assurance
security boundary without an independent review.

## Supported versions

Only the latest release listed on the [GitHub Releases page](https://github.com/ttaatoo/hx/releases)
receives security fixes.

| Version | Support |
| --- | --- |
| Latest release | Security fixes and coordinated disclosure |
| Older releases | Not supported |
| Unreleased commits and local builds | Not supported |

The maintainer may backport a fix when practical. This is not a support promise.

## Report a vulnerability

Use the [private vulnerability report form](https://github.com/ttaatoo/hx/security/advisories/new)
on GitHub. If the form does not open or fails, open an [issue](https://github.com/ttaatoo/hx/issues/new)
that only says that the private vulnerability report form is unavailable. Do
not include vulnerability details in that issue or in any public issue, pull
request, discussion, or chat.

Include:

- the affected version, platform, and configuration;
- a short reproduction or proof of impact;
- the smallest useful log or trace, with secrets removed; and
- any deadline or planned disclosure date.

If a credential may be exposed, revoke it first. Use placeholders in the report.

## Response targets

These are targets, not a service-level agreement:

- acknowledge the report within 3 business days;
- provide an initial triage result within 10 business days; and
- provide an update at least every 10 business days while the report is active.

The fix and release date depend on severity, proof quality, and coordination with
the reporter. The maintainer may ask for more information before confirming a
vulnerability.

## Disclosure

Please do not publish a zero-day, exploit steps, or sensitive report contents.
The maintainer will coordinate a disclosure date with the reporter. A public
advisory may follow a fix or another agreed response. Reporter credit is given
only with the reporter's consent.

## Scope

This policy covers security issues in `hx`, its permission and sandbox behavior,
its local credential handling, and its provider or MCP authentication flows.
Issues in a provider, identity service, operating system, terminal emulator, or
third-party MCP server should also be reported to that service's owner.
