```
 ⠀⠀⠀⠀⠀⠀⣠⣾⣿⣿⣿⠀⠀⠀⠀⠀⠀⠀⠀
 ⠀⠀⠀⠀⠀⢰⣿⡿⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
 ⠀⠀⠀⣠⣶⣿⣿⣷⣶⡶⣶⣶⣆⠀⠀⠀⣴⣶⣶⠆
 ⠀⠀⠀⠉⢹⣿⣿⠉⠉⠀⠘⢿⣿⣧⣀⣾⣿⡿⠃⠀             Tiny, open, embeddable, native coding agent.
 ⠀⠀⠀⠀⣼⣿⡏⠀⠀⠀⠀⠀⠻⣿⣿⣿⠟⠀⠀⠀
 ⠀⠀⠀⢀⣿⣿⠃⠀⠀⠀⠀⢠⣦⠘⢿⣿⣷⡀⠀⠀             git clone && zig build
 ⠀⠀⠀⣸⣿⡟⠀⠀⠀⠀⣰⣿⣿⠗⠀⠻⣿⣿⣄⠀
 ⠀⠀⠀⣿⣿⠇⠀⠀⠀⠾⠿⠿⠋⠀⠀⠀⠘⠿⠿⠦             ⚠ Status: Experimental. Use at your own risk.
  ⠀⣸⣿⡿⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
 ⣿⣿⣿⠟⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
```

# hx

A Unix-like coding agent based on [vercel-labs/fx](https://github.com/vercel-labs/fx). Licensed under Apache-2.0. Thanks to the fx project and its contributors.

hx is a coding agent harness and CLI written in Zig, optimized for research and embeddability as part of larger systems.

It focuses on minimalism and performance across the board, from system prompt design to its tools, feature set, and 7.8 MiB binary.

For end users, its CLI output style and form factor aim to be closer to a Unix shell than a heavy "IDE in the terminal" TUI.

It's open source (Apache-2.0), model-agnostic, and suitable for both local and cloud inference.

hx runs on Linux and macOS (x86_64 and aarch64). It does not support Windows, WebAssembly, or in-browser hosts.

This is not official Vercel fx. Official fx is at https://fx.sh and [vercel-labs/fx](https://github.com/vercel-labs/fx).

## Install

This repository is a same-repo Homebrew tap (`ttaatoo/hx`). Formula only. No cask.

This tap is `ttaatoo/hx/hx` (coding agent), not the Helix editor.

```bash
brew tap ttaatoo/hx https://github.com/ttaatoo/hx
brew install ttaatoo/hx/hx
```

The stable formula downloads a prebuilt GitHub Release tarball (`hx-*.tar.gz`; no bottles, no Vercel CDN). Pushes to `main` create a tagged GitHub Release when the version in source has no GitHub Release yet.

If this repo is already tapped:

```bash
git -C "$(brew --repo ttaatoo/hx)" pull
brew install ttaatoo/hx/hx
```

To build the latest `main` from git with Homebrew's Zig 0.16:

```bash
brew install --HEAD ttaatoo/hx/hx
```

Or build from source with [Zig 0.16.0+](https://ziglang.org/download/):

```bash
git clone https://github.com/ttaatoo/hx.git
cd hx
zig build -Doptimize=ReleaseSafe
./zig-out/bin/hx
```

## Clone remotes

```bash
git clone https://github.com/ttaatoo/hx.git
cd hx
git remote add upstream https://github.com/vercel-labs/fx.git
```

- `origin` — [ttaatoo/hx](https://github.com/ttaatoo/hx)
- `upstream` — [vercel-labs/fx](https://github.com/vercel-labs/fx) (optional)

## Run hx

Sign in with SuperGrok / X Premium+ (default):

```bash
hx login grok
hx
```

Bare `hx login` starts SuperGrok. This uses subscriber quota, not an `XAI_API_KEY`.

Or use Anthropic Messages with `ANTHROPIC_API_KEY` and `~/.hx/providers.json`. Optional `ANTHROPIC_BASE_URL` can point at the official API or a Claude Code proxy. See [Providers](docs/direct-providers.md).

Codex (`hx login codex`) is optional and talks to OpenAI directly. There is no Vercel AI Gateway path: `hx login vercel`, `hx setup`, `hx teams`, and Gateway credits are not product commands.

Inside hx, `/provider` switches between SuperGrok, Anthropic, and Codex. `/model` lists the active provider's models.

Run hx from a project:

```bash
cd your_project
hx
```

The current directory becomes the primary workspace. Enter a prompt, or run `/help` to browse interactive commands.

Config lives in `~/.hx`. If `~/.hx` is missing, leftover `~/.fx` is copied in.

The status line hides the workspace path and Git branch by default. Enable the `Status line workspace` option in `/settings`, run `/statusline workspace`, or set it in `~/.hx/settings.json`:

```json
{
  "statusLine": {
    "workspace": true
  }
}
```

List saved sessions with `hx sessions`. Resume the latest session for the current workspace, or select an exact session ID, through the same command group:

```bash
hx session resume last
hx session resume --id <id>
```

Each interactive session names its terminal tab. The title prefers the session name, falls back to the workspace name, and keeps the active model as secondary context. Renaming or resuming a session updates the tab, and exiting clears the hx-owned title. Noninteractive commands do not emit terminal-title controls.

Run `/feedback` to open the feedback form. It does not create a diagnostic or change the clipboard.

Run `/trace` to create a private Markdown diagnostic with logs, session context, runtime state, permissions, and recent activity. On macOS, hx copies the `.md` file to the clipboard; on other platforms, it saves the file and prints its path. Review and redact the trace before sharing it.

Use `hx ask` for a single request:

```bash
hx ask "explain the changes in this repository"
```

hx starts in `auto` permission mode. Routine understood development actions run directly; unresolved sensitive actions receive one bounded automatic review. A blocked action may return an exact approval request that the agent can send to hx's real permission screen. Ordinary question text never grants permission.

JSON and quiet requests stay noninteractive by default. Add `--prompt-permissions` to allow the existing Y/N approval prompt when stdin is a TTY. Prompt text is written to stderr, so JSON stdout stays parseable and quiet stdout stays empty. Piped or redirected stdin remains noninteractive and fails instead of waiting for approval.

Inside a saved session, `/permissions remember <allow|deny> <tool-name> <arguments-json>` stores an exact confirmed rule without running the action. `/permissions` lists stable rule IDs, and `/permissions revoke <rule-id>` removes a stored rule even when its original workspace or file state has changed.

## Embed hx

Use `hx acp` to connect the native agent to editors and other Agent Client Protocol clients.

## Extend hx

Add reusable instructions with skills, connect external tools through MCP, or delegate independent work to subagents. Project instruction files may link within their scope, and read-only workspace or compatibility skill directories may link within their owning workspace or home; managed skills, `SKILL.md` files, resources, and escaping links remain no-follow. Skills installed via symlinks that resolve outside home or workspace (e.g. Nix store paths) are loaded when their resolved target is inside a directory listed in the `FX_SKILL_SYMLINK_AUTHORITIES` environment variable (colon-separated absolute paths). `hx status` and `hx doctor` report an invalid trusted MCP profile without starting its servers.

## Documentation

Official fx documentation remains at [fx.sh/docs](https://fx.sh/docs). This repository is [ttaatoo/hx](https://github.com/ttaatoo/hx).

## Build from source

Building hx requires [Zig 0.16.0+](https://ziglang.org/download/):

```bash
git clone https://github.com/ttaatoo/hx.git
cd hx
zig build -Doptimize=ReleaseSafe
./zig-out/bin/hx
```

Run the test suite with `zig build test`. See [CONTRIBUTING.md](CONTRIBUTING.md) for development and contribution guidelines.

## License

[Apache-2.0](LICENSE)

See [NOTICE](NOTICE) for attribution. This product is based on [vercel-labs/fx](https://github.com/vercel-labs/fx).

Third-party licenses and attributions are listed in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Credits

Interface sounds by [cuelume](https://github.com/Danilaa1/cuelume).
