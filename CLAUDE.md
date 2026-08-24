# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Read `AGENTS.md` too. It is the authoritative, detailed rulebook: work-readiness proof, CI gates, PGSO corpus classification, permissions model, release flow, and "What Not To Do". This file summarizes commands and architecture.

## What this is

`hx` — a Unix-like coding agent CLI written in Zig 0.16+, forked from `vercel-labs/fx`. Linux and macOS only (x86_64, aarch64). No Node.js runtime for the main binary; Zig standard library only, no external dependencies.

## Commands

```bash
zig build                                # build → ./zig-out/bin/hx
zig build -Doptimize=ReleaseSafe         # release build
zig build test                           # run all Zig unit tests
zig build run                            # build and run
zig fmt src/                             # format (canonical check; CI enforces)
zig fmt --check src/                     # verify formatting

cd tests/e2e && bun install && bun test                # all e2e tests
cd tests/e2e && bun test cli.test.ts                   # one e2e file
cd tests/e2e && bun test tui-*.test.ts                 # TUI tests (needs tmux)

cd tests/evals && bun install && bun test              # LLM evals (needs ANTHROPIC_API_KEY; Grok matrix needs SuperGrok)

./benchmarks/startup.sh --quick          # startup latency benchmark (needs hyperfine)
```

- Zig unit tests live inside source files as `test "..." { ... }` blocks.
- e2e tests resolve the binary from `zig-out/bin/hx` — run `zig build` first.
- Development loop: focused tests only. The full suite runs in Full CI (`.github/workflows/full-ci.yml`) on 4 native runners. Do not run the complete deterministic suite locally as the default loop.

## Verification rule (critical)

Never declare work ready from passing tests alone. Build, then run `./zig-out/bin/hx` and drive one real interaction that exercises the change. Bare `hx` from `PATH` is always wrong for dev verification — use the freshly built binary. Full rules in `AGENTS.md` → "Declaring Work Ready".

## Architecture

`src/main.zig` is the composition root only. Do not add leaf feature logic there. Module ownership:

| Module | Owns | Must not |
|---|---|---|
| `src/core/` | contracts, runtimes, config, sessions, permissions, MCP, skills | — |
| `src/core/tooling/` | generic tool contracts and dispatch | — |
| `src/tools/` | built-in tool implementations | define default tool specs (those live in `src/core/tooling/tool_specs.zig` or `src/builtins/tools.zig`) |
| `src/ui/` | terminal rendering, event loop, input, transcript | own product state |
| `src/gateway/` | provider transport | absorb product-state logic |
| `src/acp/` | ACP (Agent Client Protocol) JSON-RPC 2.0 server | — |

Notable submodules: `src/core/app/` (bootstrap/entry/agent runtimes; `app_entry_runtime.zig` holds the `FX_BENCH=1` early-exit path), `src/core/permissions/permissions.zig` (permission policy — all sensitive tool behavior must go through it), `src/core/slash_commands/command_specs.zig` + `src/core/cli/cli_surface.zig` (command specs and dispatch), `src/core/terminal/engine.zig` (shared text-terminal engine for hosted sessions, replay, render tests).

### Adding a feature

Answer in order: which module owns it → typed contract → persistence → text and JSON output → docs and tests → PGSO corpus classification. Every `tests/e2e/*.test.ts` needs exactly one classification in `scripts/pgso/corpus.json` (training / verification-only / intentional exclusion); CI rejects missing or stale entries.

### Adding a command

1. Spec in `src/core/slash_commands/command_specs.zig`
2. Dispatch in `src/core/cli/cli_surface.zig`
3. Snapshot type for structured output
4. Text and JSON render from one snapshot via `src/core/output/output_contracts.zig`

## Zig 0.16 patterns (project conventions)

- I/O goes through `std.Io`, never `std.fs`/`std.io.getStdIn`. Use helpers in `src/core/shared/io.zig`: `io_mod.getIo()`, `getenv`, `milliTimestamp`, `readFileToEnd`, `realpathAlloc`, `sleep`. In test blocks use `std.testing.io` (`io_mod.getIo()` returns it in test builds).
- Allocators passed explicitly; `ArenaAllocator` for request-scoped work; document ownership of returned memory.
- Errors over `@panic`; `errdefer` for partial state.
- JSON serialize with `std.json.Stringify.value` + `std.Io.Writer.Allocating`; raw JSON string escaping via `writeJsonStr` in `src/acp/jsonrpc.zig`.
- `std.mem` renames: `trimStart`/`trimEnd`, `find`/`findScalar`. `ArrayList(T)` inits with `.empty`.
- Process spawn: `std.process.spawn(io, opts)` / `std.process.run(alloc, io, opts)`. Mutex: `std.Io.Mutex` with `.lockUncancelable(io)`.
- No `@import` with runtime-computed paths. No dependencies outside the Zig standard library without discussion.

## Config and state

- User config and runtime state: `~/.hx/`. Sessions: `~/.hx/sessions/<id>/` (global, portable across workspaces).
- Project `<workspace>/.fx.json` holds committed defaults only — accepts `sandbox`, `max_agent_steps`, `max_tool_result_bytes`, `context`. Profile keys (`model`, `permission_mode`, etc.) are ignored from project config.
- Precedence: env vars (`FX_MODEL`, `FX_PERMISSION_MODE`, `FX_MAX_AGENT_STEPS`) > `~/.hx/settings.json` workspace overrides > its top level > `.fx.json` > built-in defaults.
- Permission modes: `ask`, `auto`, `yolo`. Never bypass `src/core/permissions/permissions.zig` for new tools.

## Naming (rebrand)

Product name is `hx`; binary `hx`. Internal Zig modules and `FX_*` env vars keep the `fx`/`FX` spelling. Public docs and changelog say `hx`.

## Style

- `zig fmt` before commit. `snake_case` identifiers, `PascalCase` types, minimal `pub`.
- No emojis. No `--` double hyphens as dashes in docs — use an emdash or rewrite.
- CLI flags kebab-case (`--no-save`, `--json`).
- Every PR gets exactly one `type:` label; titles are clean imperative sentences without bracketed prefixes.
