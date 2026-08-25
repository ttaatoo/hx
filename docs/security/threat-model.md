# hx threat model

Status: current product boundary summary. `hx` is experimental. This document
describes limits and controls; it is not a security guarantee.

## Scope and assumptions

The model covers the local `hx` process, its child processes, its profile and
workspace files, and network calls to providers and MCP services.

Security goals:

- keep command and file effects visible and subject to user policy;
- avoid sending credentials to an unintended endpoint;
- keep provider and MCP trust boundaries clear; and
- fail closed when a local policy can make that decision.

The user controls the host, workspace, profile, provider accounts, model choice,
and MCP configuration. Workspace files, project instructions, skills, model
output, tool output, MCP responses, and provider responses are untrusted input.
The operating system, terminal emulator, browser, identity service, provider,
and network are external dependencies.

## Trust boundaries and controls

| Area | Trust boundary and threat | Mitigations | Residual risk |
| --- | --- | --- | --- |
| Terminal | `hx` writes to the user's terminal and reads terminal input. The terminal emulator, clipboard, escape-sequence handling, and other terminal programs are outside `hx` control. Model text and command output are untrusted. | Inline rendering and explicit alternate-screen owners limit terminal state changes. The runtime restores terminal modes during normal shutdown. `/trace` is private until the user reviews it. | A malicious output stream may affect a terminal emulator or trick a user into pasting a command. An emulator or host bug is outside this project. |
| Filesystem | The workspace and `~/.hx` profile contain user data. A project may contain hostile instructions, skills, symlinks, or configuration. Agent file tools can read and write within their admitted scope. | File targets are resolved and checked against workspace access and permission policy. Project `.fx.json` cannot define runnable MCP commands, URLs, environment, or secrets. Profile files use private paths and platform file permissions. | An approved tool or a command running with `sandbox=none` can reach any file allowed to the user. Path, symlink, host, and time-of-check failures can still cause data loss or disclosure. |
| Command execution | Shell commands and terminal children run with the user's identity, environment, and working directory. Their output returns to `hx` and may return to the model. | `ask`, `auto`, and `yolo` permission modes; configured denies; exact grants; approval for unknown, destructive, credential-bearing, public, and overwrite effects; bounded output and process cleanup; and an OS sandbox where available. | A model can request a dangerous command. A user-approved command can delete or exfiltrate data. Classification and process cleanup cannot make arbitrary host programs safe. |
| MCP | Local stdio servers and remote HTTP servers are external programs or services. A server can read request data, return resources or prompts, and perform tool effects with its own privileges. | Runnable MCP config is loaded from trusted `~/.hx/mcp.json`. Project config cannot add servers. Child sessions receive an immutable, permission-filtered MCP view. Required-server failures block use; optional failures degrade capability. Health output is bounded and secret-free. | A local server can access the user's host. A remote server can retain or exfiltrate data, return false instructions, or change behavior. MCP is not a sandbox for the server. |
| OAuth | The browser, loopback callback, authorization server, token endpoint, and resource server are external. A successful grant gives access to the provider or MCP account. | Supported flows use HTTPS for remote endpoints, exact state checks, and PKCE where the flow supports it. MCP OAuth checks resource and issuer relationships and confines HTTP to loopback callbacks. Redirect targets are checked before token exchange. | A compromised issuer, browser, endpoint, local process, or user approval can expose a token. TLS and provider identity remain external trust decisions. |
| Provider data | Prompts, workspace content, tool output, and account context may cross the network to the selected provider or configured endpoint. The provider controls its model, logs, retention, and data location. | Direct provider transport uses HTTPS or loopback for configured base URLs. The request binds the selected credential to the selected provider. Users can review provider and `baseUrl` settings before use. | HTTPS does not prove that a custom endpoint is an official provider. `hx` cannot enforce provider retention, training, residency, or model behavior. Model output is untrusted. |
| Credentials | API keys, OAuth access and refresh tokens, provider sessions, and environment variables are sensitive. They exist in the profile, platform keychain, process memory, and provider requests. | macOS uses Keychain where available; other platforms use a private profile file. Credentials are zeroed before owned buffers are freed, and status output avoids secret values. Project config is not a credential store. | A compromised host or account, shell environment, crash dump, copied profile, malicious tool, or redacted trace mistake can expose a credential. Zeroing one buffer does not erase copies. |
| Sandbox and `yolo` | `sandbox=os` uses a host OS sandbox when that backend is available. `sandbox=none` provides no command isolation. On hosts without the OS backend, automatic resolution may be `none`. `yolo` disables permission checks and uses an effective sandbox of `none` for the current run. | The sandbox setting is independent from permission mode. The UI warns when `yolo` is enabled. The effective `yolo` backend does not rewrite the saved sandbox setting. The macOS profile denies by default and grants workspace, temporary, process, and outbound network access. | This is defense in depth, not a VM or a multi-tenant boundary. `none`, unavailable OS sandbox support, broad profile grants, network access, and `yolo` leave the host exposed to approved or malicious commands. |

## Non-goals

`hx` does not claim to:

- protect a host that is already compromised or has a malicious administrator;
- provide malware detection or a complete data-loss prevention system;
- guarantee provider privacy, retention, residency, or model correctness;
- prevent every prompt-injection or social-engineering attack;
- make a terminal emulator secure; or
- provide high-assurance isolation between users, tenants, or arbitrary local
  MCP servers.

## User controls

Users should use `ask` for sensitive work, select `sandbox=os` when it is
available, review commands and file targets, audit MCP and provider settings,
and revoke credentials after a suspected exposure. Treat `yolo`, `sandbox=none`,
custom provider endpoints, and third-party MCP servers as high-trust choices.

The maintainer should update this document when a change adds a capability,
crosses a trust boundary, changes a mitigation, or introduces a new residual
risk. Report a suspected security issue through [`SECURITY.md`](../../SECURITY.md).
