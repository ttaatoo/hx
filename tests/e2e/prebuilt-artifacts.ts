import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { REPO_ROOT } from "../evals/eval-helpers";

export const MCP_DISPATCHER_DRIVER = resolve(
  REPO_ROOT,
  "zig-out/bin/mcp-stdio-dispatcher-driver",
);

export const TERMINAL_CLIENT_FIXTURE = resolve(
  REPO_ROOT,
  "zig-out/bin/terminal-client-fixture",
);

export function mcpDispatcherPrefix(): string[] {
  if (existsSync(MCP_DISPATCHER_DRIVER)) {
    return [MCP_DISPATCHER_DRIVER];
  }
  return ["zig", "build", "run-mcp-stdio-dispatcher-e2e", "--"];
}
