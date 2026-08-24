import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createServer } from "node:net";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { platform, tmpdir } from "node:os";
import { join, sep } from "node:path";
import {
  REPO_ROOT,
  runFx,
} from "../evals/eval-helpers";

const TIMEOUT = 15_000;
const NO_GATEWAY_AUTH = {
  AI_GATEWAY_API_KEY: undefined,
  VERCEL_OIDC_TOKEN: undefined,
};
const MISSING_AUTH_MESSAGE =
  "This model uses SuperGrok / X Premium+. Run hx login grok. This uses subscription quota, not an XAI_API_KEY.";

function maxLineWidth(text: string): number {
  return Math.max(...text.split(/\r?\n/).map((line) => Bun.stringWidth(line)));
}

function sourceVersion(): string {
  const source = readFileSync(join(REPO_ROOT, "src/main.zig"), "utf8");
  const match = source.match(/pub const version = "([^"]+)";/);
  if (!match) throw new Error("src/main.zig version declaration not found");
  return match[1];
}

function doctorSessionDiagnosticsLimit(): number {
  const source = readFileSync(
    join(REPO_ROOT, "src/core/cli/doctor_runtime.zig"),
    "utf8",
  );
  const match = source.match(/const default_session_diagnostics_limit: usize = (\d+);/);
  if (!match) throw new Error("doctor session diagnostics limit not found");
  return Number(match[1]);
}

function snapshotTree(root: string): string[] {
  const entries: string[] = [];
  const visit = (path: string, relative: string): void => {
    const info = lstatSync(path);
    entries.push(
      `${relative}|${info.isDirectory() ? "dir" : "file"}|${info.mode & 0o777}|${info.size}`,
    );
    if (!info.isDirectory()) return;
    for (const name of readdirSync(path).sort()) {
      visit(join(path, name), relative ? join(relative, name) : name);
    }
  };
  visit(root, "");
  return entries;
}

function writeLegacySession(
  home: string,
  workspaceRoot: string,
  sessionId: string,
  opts: {
    createdAtMs?: number;
    updatedAtMs?: number;
    historyLen?: number;
  } = {},
): void {
  const sessionDir = join(home, ".hx", "sessions", sessionId);
  mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
  chmodSync(join(home, ".hx"), 0o700);
  chmodSync(join(home, ".hx", "sessions"), 0o700);
  chmodSync(sessionDir, 0o700);
  const historyLen = opts.historyLen ?? 0;
  writeFileSync(
    join(sessionDir, "session.json"),
    JSON.stringify({
      schema_version: 2,
      id: sessionId,
      created_at_ms: opts.createdAtMs ?? 1,
      updated_at_ms: opts.updatedAtMs ?? 2,
      workspace_root: workspaceRoot,
      conversation_language: "en",
      history_len: historyLen,
      history: historyLen > 0 ? [{ role: "user", content: "saved" }] : [],
      total_input_tokens: 0,
      total_output_tokens: 0,
    }) + "\n",
    { mode: 0o600 },
  );
}

describe("cli: help", () => {
  test(
    "hx help exits 0 and renders the complete navigation page",
    async () => {
      const r = await runFx(["help"]);
      expect(r.code).toBe(0);
      expect(r.stderr).toBe("");
      expect(r.stdout).not.toContain("\x1b[");
      expect(r.stdout).not.toContain("\x1b]2;");
      expect(r.stdout).toStartWith(
        `hx v${sourceVersion()}\nFast, native coding agent for the terminal.\n`,
      );
      expect(r.stdout).toContain("Commands:\n");
      expect(r.stdout).toContain("Run one noninteractive request");
      expect(r.stdout).toContain("login [grok|codex]");
      expect(r.stdout).not.toContain("credits|balance");
      expect(r.stdout).not.toContain("Vercel");
      expect(r.stdout).not.toContain("Gateway");
      expect(r.stdout).toContain("Flags:\n");
      expect(r.stdout).toContain("--context-limit <spec>");
      expect(r.stdout).toContain("Set name=bytes|off; repeatable");
      expect(r.stdout).toContain("--add-dir <path>");
      expect(r.stdout).toContain("-c, --continue");
      expect(r.stdout).toContain("-r");
      expect(r.stdout).toContain("Open the saved-session picker");
      expect(r.stdout).not.toContain("-c, -r, --continue");
      expect(r.stdout).toContain("--resume [last|<id>]");
      expect(r.stdout).toContain("--resume-last");
      expect(r.stdout).toContain("session resume [last|id]");
      expect(r.stdout).toContain("-v, --version");
      expect(r.stdout).not.toContain("Must appear before the command");
      expect(r.stdout).toContain("Examples:\n");
      expect(r.stdout).toContain("https://github.com/ttaatoo/hx");
      expect(r.stdout).toContain("run `/feedback` inside hx");
      expect(r.stdout).not.toContain("  Work      ");
      expect(r.stdout).not.toContain("\n\n\nRun `hx <command> --help`");
    },
    TIMEOUT,
  );

  test(
    "fx --help exits 0",
    async () => {
      const r = await runFx(["--help"]);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("ask");
    },
    TIMEOUT,
  );

  test(
    "fx -h exits 0",
    async () => {
      const r = await runFx(["-h"]);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("ask");
    },
    TIMEOUT,
  );

  test(
    "hx ask help renders documented options through both aliases",
    async () => {
      const env = {
        ...NO_GATEWAY_AUTH,
        FX_DISABLE_KEYCHAIN: "1",
      };
      const expected = `hx ask

Run one noninteractive request

Usage:
  hx ask [--auto|--yolo] [--image PATH] [--json] [--quiet] [--prompt-permissions] [--no-save] [--no-color] [--resume <last|id>|--resume-id <id>] [--continue-recovery] [--] <prompt>

Options:
  --auto                Automatically review unresolved permission requests
  --yolo                Disable permission checks and command sandboxing
  --image PATH          Attach an image file; repeat for multiple images
  --json                Emit machine-readable JSON instead of text
  --quiet               Suppress assistant output
  --prompt-permissions  Prompt for Y/N permission approval when stdin is a TTY
  --no-save             Do not save the session; incompatible with --resume and --resume-id
  --no-color            Render TTY output without colors or hyperlinks
  --resume <last|id>    Continue the last session or a session by id
  --resume-id <id>      Continue a session by exact id
  --continue-recovery   Resume the paused model response in the selected session
  --                    Treat every following argument as prompt text

The prompt may be passed as arguments or piped on stdin when no prompt args are given.
TTY stdout uses the Minimal transcript presentation; redirected stdout emits raw assistant Markdown.
Operational progress and diagnostics are written to stderr. JSON output keeps raw Markdown in \`output\`.
With --prompt-permissions, JSON and quiet requests may prompt on stderr only when stdin is a TTY.
`;

      for (const alias of ["--help", "-h"]) {
        const result = await runFx(["ask", alias], { env });
        expect(result.code).toBe(0);
        expect(result.stderr).toBe("");
        expect(result.stdout).toBe(expected);
      }
    },
    TIMEOUT,
  );

  test(
    "hx session help documents inspect resume migrate and recover",
    async () => {
      for (const args of [
        ["session", "--help"],
        ["session", "resume", "--help"],
      ]) {
        const r = await runFx(args);
        expect(r.code).toBe(0);
        expect(r.stderr).toBe("");
        expect(r.stdout).toContain("Inspect, resume, migrate, or recover saved sessions");
        expect(r.stdout).toContain("session <last|id>|--id <id>");
        expect(r.stdout).toContain("session resume [last|<id>]");
        expect(r.stdout).toContain("session migrate <id>|--id <id>");
        expect(r.stdout).toContain("session recover <id>|--id <id>");
      }
    },
    TIMEOUT,
  );

  test(
    "hx acp help documents accepted options",
    async () => {
      for (const alias of ["--help", "-h"]) {
        const r = await runFx(["acp", alias]);
        expect(r.code).toBe(0);
        expect(r.stderr).toBe("");
        expect(r.stdout).toContain(
          "Usage:\n  hx acp [--model <id>] [--log-file <path>]",
        );
        expect(r.stdout).toContain("--model <id>");
        expect(r.stdout).toContain("--log-file <path>");
      }
    },
    TIMEOUT,
  );

  test(
    "hx replay help describes golden output",
    async () => {
      const r = await runFx(["replay", "--help"]);
      expect(r.code).toBe(0);
      expect(r.stderr).toBe("");
      expect(r.stdout).toContain("--golden <path>");
      expect(r.stdout).toContain("Write the final rendered grid to a file");
      expect(r.stdout).not.toContain("Compare output against a golden file");
    },
    TIMEOUT,
  );

  test(
    "hx acp rejects unknown options and missing option values",
    async () => {
      for (const args of [["--bogus"], ["--model"], ["--log-file"]]) {
        const result = await runFx(["acp", ...args]);
        expect(result.code).toBe(1);
        expect(result.stdout).toBe("");
        expect(result.stderr).toBe(
          "usage: hx acp [--model <id>] [--log-file <path>]\n",
        );
      }
    },
    TIMEOUT,
  );

  for (const alias of ["help", "--help", "-h"]) {
    test(
      `fx ${alias} respects COLUMNS=60`,
      async () => {
        const r = await runFx([alias], { env: { COLUMNS: "60" } });
        expect(r.code).toBe(0);
        expect(r.stderr).toBe("");
        expect(r.stdout).toContain("Commands:");
        expect(r.stdout).toContain("ask");
        expect(r.stdout).toContain("login");
        expect(r.stdout).toContain("status");
        expect(r.stdout).toContain("doctor");
        expect(maxLineWidth(r.stdout)).toBeLessThanOrEqual(60);
      },
      TIMEOUT,
    );
  }

  for (const alias of ["help", "--help", "-h"]) {
    test(
      `fx ${alias} --record rejects the interactive-only modifier`,
      async () => {
        const r = await runFx([alias, "--record"]);
        expect(r.code).not.toBe(0);
        expect(r.stderr).toContain(
          "usage: hx --record is only supported for interactive startup",
        );
      },
      TIMEOUT,
    );
  }
});

describe("cli: version", () => {
  for (const alias of ["--version", "-v"]) {
    test(
      `fx ${alias} prints the source version`,
      async () => {
        const r = await runFx([alias]);
        expect(r.code).toBe(0);
        expect(r.stdout).toBe(`${sourceVersion()}\n`);
        expect(r.stderr).toBe("");
      },
      TIMEOUT,
    );
  }
});

describe("cli: status", () => {
  test(
    "status and doctor expose the MCP profile error that blocks ask startup",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "fx-e2e-mcp-config-diagnostic-"));
      const home = join(root, "home");
      const workspace = join(root, "workspace");
      const fxDir = join(home, ".hx");
      mkdirSync(fxDir, { recursive: true, mode: 0o700 });
      mkdirSync(workspace);
      writeFileSync(join(fxDir, "mcp.json"), "{invalid json", { mode: 0o600 });
      writeFileSync(
        join(fxDir, "providers.json"),
        JSON.stringify({
          providers: {
            anthropic: {
              api: "anthropic-messages",
              baseUrl: "https://api.anthropic.com",
              apiKey: "$ANTHROPIC_API_KEY",
              models: [{ id: "claude-opus-4-6" }],
            },
          },
        }) + "\n",
        { mode: 0o600 },
      );

      try {
        const env = {
          ...NO_GATEWAY_AUTH,
          HOME: realpathSync(home),
          ANTHROPIC_API_KEY: "mcp-config-diagnostic-key",
          FX_DISABLE_KEYCHAIN: "1",
          FX_AUTO_UPGRADE: "0",
          FX_MODEL: "claude-opus-4-6",
        };
        const cwd = realpathSync(workspace);
        const before = snapshotTree(home);

        const statusText = await runFx(["status"], { cwd, env });
        const statusJsonResult = await runFx(["status", "--json"], { cwd, env });
        const doctorText = await runFx(["doctor"], { cwd, env });
        const doctorJsonResult = await runFx(["doctor", "--json"], { cwd, env });
        const ask = await runFx(
          ["ask", "--json", "--no-save", "Do nothing."],
          { cwd, env },
        );

        for (const result of [statusText, statusJsonResult, doctorText, doctorJsonResult]) {
          expect(result.code).toBe(0);
          expect(result.stderr).toBe("");
        }
        expect(statusText.stdout).toContain(
          "[status] mcp_config_error=McpConfigInvalidJson\n",
        );
        expect(JSON.parse(statusJsonResult.stdout)).toMatchObject({
          kind: "status",
          mcp_config_error: "McpConfigInvalidJson",
        });
        expect(doctorText.stdout).toContain(
          "[fail] mcp_config: failed to load ~/.hx/mcp.json: McpConfigInvalidJson\n",
        );
        const doctorJson = JSON.parse(doctorJsonResult.stdout);
        expect(doctorJson.fail_count).toBe(1);
        expect(
          doctorJson.checks.filter(
            (check: { name: string }) => check.name === "mcp_config",
          ),
        ).toEqual([
          {
            name: "mcp_config",
            status: "fail",
            detail: "failed to load ~/.hx/mcp.json: McpConfigInvalidJson",
          },
        ]);
        expect(ask.code).toBe(1);
        expect(ask.stderr).toBe("");
        expect(JSON.parse(ask.stdout)).toMatchObject({
          exit_code: 1,
          error: "McpConfigInvalidJson",
        });
        expect(snapshotTree(home)).toEqual(before);

        writeFileSync(join(fxDir, "mcp.json"), '{"mcp":{}}\n', { mode: 0o600 });
        const validBefore = snapshotTree(home);
        const validStatus = await runFx(["status", "--json"], { cwd, env });
        const validDoctor = await runFx(["doctor", "--json"], { cwd, env });
        expect(validStatus.code).toBe(0);
        expect(validDoctor.code).toBe(0);
        expect(JSON.parse(validStatus.stdout)).not.toHaveProperty("mcp_config_error");
        expect(
          JSON.parse(validDoctor.stdout).checks.some(
            (check: { name: string }) => check.name === "mcp_config",
          ),
        ).toBe(false);
        expect(snapshotTree(home)).toEqual(validBefore);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test(
    "status and doctor share the missing auth snapshot",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "fx-e2e-status-noauth-"));
      try {
        const env = {
          ...NO_GATEWAY_AUTH,
          HOME: realpathSync(root),
          FX_DISABLE_KEYCHAIN: "1",
        };
        const status = await runFx(["status", "--json"], { env });
        const doctor = await runFx(["doctor", "--json"], { env });

        expect(status.code).toBe(0);
        expect(doctor.code).toBe(0);
        const statusJson = JSON.parse(status.stdout.trim());
        const doctorJson = JSON.parse(doctor.stdout.trim());
        expect(statusJson).toMatchObject({
          auth: "missing",
          auth_refreshable: false,
          auth_help: MISSING_AUTH_MESSAGE,
          sandbox: platform() === "darwin" ? "os" : "none",
        });
        expect(doctorJson).toMatchObject({
          auth: "missing",
          auth_refreshable: false,
        });
        expect(doctorJson.checks).toContainEqual({
          name: "auth",
          status: "fail",
          detail: MISSING_AUTH_MESSAGE,
        });
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test(
    "hx status --json returns valid status JSON",
    async () => {
      const r = await runFx(["status", "--json"]);
      expect(r.code).toBe(0);
      const json = JSON.parse(r.stdout.trim());
      expect(json.kind).toBe("status");
      expect(json).toHaveProperty("model");
      expect(json).toHaveProperty("workspace");
      expect(json).toHaveProperty("permission_mode");
      expect(json).toHaveProperty("history_turns");
      expect(json).toHaveProperty("agent_step_limit");
      expect(json.update_channel).toBe("stable");
      expect(json.build_channel).toBe("stable");
      expect(json.build_revision).toMatch(/^[0-9a-f]{12}$/);
    },
    TIMEOUT,
  );

  test(
    "hx status reports a persisted dev update channel",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "fx-e2e-update-channel-"));
      try {
        const home = join(root, "home");
        const workspace = join(root, "workspace");
        mkdirSync(join(home, ".hx"), { recursive: true, mode: 0o700 });
        mkdirSync(workspace);
        writeFileSync(
          join(home, ".hx", "settings.json"),
          '{"update_channel":"dev"}\n',
          { mode: 0o600 },
        );

        const result = await runFx(["status", "--json"], {
          cwd: realpathSync(workspace),
          env: { ...NO_GATEWAY_AUTH, HOME: home },
        });
        expect(result.code).toBe(0);
        expect(JSON.parse(result.stdout.trim())).toMatchObject({
          kind: "status",
          update_channel: "dev",
          build_channel: "stable",
        });
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test(
    "hx upgrade help documents release channels",
    async () => {
      const result = await runFx(["upgrade", "--help"]);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("--channel <stable|dev>");
      expect(result.stdout).toContain("Select and remember the release channel");
    },
    TIMEOUT,
  );

  test(
    "hx status and models use Anthropic keys and SuperGrok OAuth",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "fx-e2e-direct-providers-"));
      try {
        const home = join(root, "home");
        const workspace = join(root, "workspace");
        mkdirSync(join(home, ".hx"), { recursive: true, mode: 0o700 });
        mkdirSync(workspace);
        writeFileSync(
          join(home, ".hx", "providers.json"),
          JSON.stringify({
            providers: {
              anthropic: {
                api: "anthropic-messages",
                baseUrl: "https://api.anthropic.com",
                apiKey: "$ANTHROPIC_API_KEY",
                models: [{ id: "claude-opus-4-6" }, { id: "claude-sonnet-4-6" }],
              },
              xai: {
                api: "openai-completions",
                models: [{ id: "grok-4.6" }, { id: "grok-code-fast-1" }],
              },
            },
          }) + "\n",
          { mode: 0o600 },
        );
        writeFileSync(
          join(home, ".hx", "grok-auth.json"),
          JSON.stringify({
            version: 1,
            access_token: "grok-e2e-access",
            refresh_token: "grok-e2e-refresh",
            expires_at_ms: 4102444800000,
            client_id: "b1a00492-073a-47ea-816f-4c329264a828",
          }) + "\n",
          { mode: 0o600 },
        );

        const env = {
          ...NO_GATEWAY_AUTH,
          HOME: realpathSync(home),
          ANTHROPIC_API_KEY: "sk-ant-e2e-test",
          FX_MODEL: "claude-opus-4-6",
        };
        const cwd = realpathSync(workspace);

        const status = await runFx(["status", "--json"], { cwd, env });
        expect(status.code).toBe(0);
        const statusJson = JSON.parse(status.stdout.trim());
        expect(statusJson.kind).toBe("status");
        expect(statusJson.model).toBe("claude-opus-4-6");
        expect(statusJson.model_source).toBe("Anthropic Messages");
        expect(statusJson.auth).toBe("direct provider API key");

        const models = await runFx(["models", "--json"], { cwd, env });
        expect(models.code).toBe(0);
        const modelsJson = JSON.parse(models.stdout.trim());
        expect(modelsJson.kind).toBe("models");
        expect(modelsJson.ids).toEqual([
          "claude-opus-4-6",
          "claude-sonnet-4-6",
          "grok-4.6",
          "grok-code-fast-1",
        ]);

        const provider = await runFx(["provider", "xai"], { cwd, env });
        expect(provider.code).toBe(0);
        expect(provider.stdout).toMatch(/Provider set to SuperGrok|SuperGrok is already selected/);

        const xaiStatus = await runFx(["status", "--json"], {
          cwd,
          env: { ...env, FX_MODEL: undefined },
        });
        expect(xaiStatus.code).toBe(0);
        const xaiJson = JSON.parse(xaiStatus.stdout.trim());
        expect(xaiJson.model).toBe("grok-4.6");
        expect(xaiJson.model_source).toBe("SuperGrok");
        expect(xaiJson.auth).toBe("SuperGrok subscription");

        const credits = await runFx(["credits"], { cwd, env });
        expect(credits.code).not.toBe(0);
        expect(credits.stderr).toContain("unknown subcommand: credits");
        expect(credits.stderr).not.toContain("Vercel");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test(
    "hx status --json defaults permission mode to auto",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "fx-e2e-permission-default-"));
      try {
        const home = join(root, "home");
        const workspace = join(root, "workspace");
        mkdirSync(home);
        mkdirSync(workspace);

        const r = await runFx(["status", "--json"], {
          cwd: realpathSync(workspace),
          env: {
            ...NO_GATEWAY_AUTH,
            HOME: realpathSync(home),
            FX_PERMISSION_MODE: undefined,
          },
        });
        expect(r.code).toBe(0);
        const json = JSON.parse(r.stdout.trim());
        expect(json.permission_mode).toBe("auto");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test(
    "status and doctor apply an exact FX_MAX_AGENT_STEPS override",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "fx-e2e-agent-step-limit-"));
      try {
        const home = join(root, "home");
        const workspace = join(root, "workspace");
        mkdirSync(home);
        mkdirSync(workspace);
        const env = {
          ...NO_GATEWAY_AUTH,
          HOME: realpathSync(home),
          FX_MAX_AGENT_STEPS: "3",
        };

        const status = await runFx(["status", "--json"], {
          cwd: realpathSync(workspace),
          env,
          timeoutMs: TIMEOUT,
        });
        expect(status.code).toBe(0);
        expect(JSON.parse(status.stdout.trim()).agent_step_limit).toBe(3);

        const doctor = await runFx(["doctor", "--json"], {
          cwd: realpathSync(workspace),
          env,
          timeoutMs: TIMEOUT,
        });
        expect(doctor.code).toBe(0);
        const startup = JSON.parse(doctor.stdout.trim()).checks.find(
          (check: { name: string }) => check.name === "startup",
        );
        expect(startup.detail).toContain("agent_step_limit=3");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test(
    "project profile-only settings are ignored before parsing and profile overrides win",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "fx-e2e-profile-config-"));
      try {
        const home = join(root, "home");
        const workspace = join(root, "workspace");
        mkdirSync(join(home, ".hx"), { recursive: true });
        mkdirSync(workspace);
        const homeRoot = realpathSync(home);
        const workspaceRoot = realpathSync(workspace);
        const env = {
          ...NO_GATEWAY_AUTH,
          HOME: homeRoot,
          FX_MODEL: undefined,
          FX_PERMISSION_MODE: undefined,
          FX_MAX_AGENT_STEPS: undefined,
        };

        writeFileSync(
          join(home, ".hx", "settings.json"),
          JSON.stringify({
            model: "anthropic/claude-sonnet-4.6",
            permission_mode: "auto",
          }) + "\n",
        );
        writeFileSync(
          join(workspace, ".fx.json"),
          JSON.stringify({
            model: 123,
            permission_mode: "danger",
            permission: { bash: true },
            statusLine: 7,
            max_agent_steps: 7,
          }) + "\n",
        );

        const status = await runFx(["status", "--json"], {
          cwd: workspaceRoot,
          env,
          timeoutMs: TIMEOUT,
        });
        expect(status.code).toBe(0);
        const first = JSON.parse(status.stdout.trim());
        expect(first.model).toBe("anthropic/claude-sonnet-4.6");
        expect(first.permission_mode).toBe("auto");
        expect(first.agent_step_limit).toBe(7);
        expect(status.stderr).toContain(
          "hx: config project: ignored_project_user_only_setting; key=model",
        );
        expect(status.stderr).toContain(
          "hx: config project: ignored_project_user_only_setting; key=permission_mode",
        );
        expect(status.stderr).toContain(
          "hx: config project: ignored_project_user_only_setting; key=permission",
        );
        expect(status.stderr).toContain(
          "hx: config project: ignored_project_user_only_setting; key=statusLine",
        );
        expect(status.stderr).not.toContain("danger");

        writeFileSync(
          join(home, ".hx", "settings.json"),
          JSON.stringify({
            model: "anthropic/claude-sonnet-4.6",
            permission_mode: "auto",
            workspaces: {
              [workspaceRoot]: {
                max_agent_steps: 4,
              },
            },
          }) + "\n",
        );

        const overridden = await runFx(["status", "--json"], {
          cwd: workspaceRoot,
          env,
          timeoutMs: TIMEOUT,
        });
        expect(overridden.code).toBe(0);
        const second = JSON.parse(overridden.stdout.trim());
        expect(second.model).toBe("anthropic/claude-sonnet-4.6");
        expect(second.permission_mode).toBe("auto");
        expect(second.agent_step_limit).toBe(4);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test(
    "special settings files fail closed without blocking CLI startup",
    async () => {
      if (platform() === "win32") return;
      const root = mkdtempSync(join(tmpdir(), "fx-e2e-config-special-"));
      try {
        const home = join(root, "home");
        const workspace = join(root, "workspace");
        const fxDir = join(home, ".hx");
        mkdirSync(fxDir, { recursive: true, mode: 0o700 });
        mkdirSync(workspace);
        chmodSync(fxDir, 0o700);

        const env = {
          ...NO_GATEWAY_AUTH,
          HOME: home,
          FX_DISABLE_KEYCHAIN: "1",
          FX_SKIP_ONBOARDING: "1",
          FX_SOUND: "0",
        };

        expect(spawnSync("mkfifo", [join(fxDir, "settings.json")]).status).toBe(0);
        const user = await runFx(["status", "--json"], {
          cwd: workspace,
          env,
          timeoutMs: 10_000,
        });
        expect(user.code).toBe(0);
        expect(JSON.parse(user.stdout)).toMatchObject({ kind: "status" });
        expect(user.stderr).toContain("hx: config user: durable_path_unsafe");

        rmSync(join(fxDir, "settings.json"));
        expect(spawnSync("mkfifo", [join(workspace, ".fx.json")]).status).toBe(0);
        const project = await runFx(["status", "--json"], {
          cwd: workspace,
          env,
          timeoutMs: 10_000,
        });
        expect(project.code).toBe(0);
        expect(JSON.parse(project.stdout)).toMatchObject({ kind: "status" });
        expect(project.stderr).toContain("hx: config project: durable_path_unsafe");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );
});

describe("cli: usage", () => {
  test(
    "hx usage reads rolling local facts without credentials or profile mutation",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "fx-e2e-usage-"));
      try {
        const home = join(root, "home");
        const fxDir = join(home, ".hx");
        mkdirSync(fxDir, { recursive: true, mode: 0o700 });
        chmodSync(fxDir, 0o700);
        const now = Date.now();
        const records = [
          {
            schema_version: 1,
            kind: "coverage",
            started_at_ms: now - 40 * 24 * 60 * 60 * 1000,
          },
          {
            schema_version: 1,
            kind: "generation",
            fact: {
              id: "gen_01ARZ3NDEKTSV4RRFFQ69G5FAV",
              created_at_ms: now - 60 * 60 * 1000,
              model: "provider/a",
              input_tokens: 15,
              output_tokens: 3,
              cache_read_tokens: 5,
              cache_write_tokens: 1,
              reasoning_tokens: 2,
              total_cost: 0.25,
            },
          },
          {
            schema_version: 1,
            kind: "generation",
            fact: {
              id: "gen_01ARZ3NDEKTSV4RRFFQ69G5FAW",
              created_at_ms: now - 2 * 24 * 60 * 60 * 1000,
              model: "provider/b",
              input_tokens: 10,
              output_tokens: 2,
              cache_read_tokens: 0,
              cache_write_tokens: 0,
              reasoning_tokens: null,
              total_cost: 0.1,
            },
          },
        ];
        const usagePath = join(fxDir, "usage.jsonl");
        writeFileSync(
          usagePath,
          records.map((record) => JSON.stringify(record)).join("\n") + "\n",
          { mode: 0o600 },
        );
        chmodSync(usagePath, 0o600);
        const before = readFileSync(usagePath, "utf8");
        const entriesBefore = readdirSync(fxDir).sort();
        const env = {
          ...NO_GATEWAY_AUTH,
          HOME: realpathSync(home),
          FX_DISABLE_KEYCHAIN: "1",
        };

        const text = await runFx(["usage"], { env });
        expect(text.code).toBe(0);
        expect(text.stderr).toBe("");
        expect(text.stdout).toContain("Usage (30 days)");
        expect(text.stdout).toContain("Total tokens  30");
        expect(text.stdout.indexOf("provider/a")).toBeLessThan(
          text.stdout.indexOf("provider/b"),
        );

        const json = await runFx(
          ["usage", "--json", "--period", "24h"],
          { env },
        );
        expect(json.code).toBe(0);
        expect(json.stderr).toBe("");
        const report = JSON.parse(json.stdout);
        expect(report).toMatchObject({
          kind: "usage",
          schema_version: 1,
          period: "24h",
          completeness: "complete",
          totals: {
            total_tokens: 18,
            input_tokens: 15,
            output_tokens: 3,
            request_count: 1,
          },
        });
        expect(report.models.map((model: { model: string }) => model.model))
          .toEqual(["provider/a"]);
        expect(readFileSync(usagePath, "utf8")).toBe(before);
        expect(readdirSync(fxDir).sort()).toEqual(entriesBefore);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test(
    "hx usage preserves known totals when the ledger is incomplete",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "fx-e2e-usage-incomplete-"));
      try {
        const home = join(root, "home");
        const fxDir = join(home, ".hx");
        mkdirSync(fxDir, { recursive: true, mode: 0o700 });
        const now = Date.now();
        const records = [
          {
            schema_version: 1,
            kind: "coverage",
            started_at_ms: now - 40 * 24 * 60 * 60 * 1000,
          },
          {
            schema_version: 1,
            kind: "generation",
            fact: {
              id: "gen_01ARZ3NDEKTSV4RRFFQ69G5FAV",
              created_at_ms: now - 2,
              model: "provider/model",
              input_tokens: 4,
              output_tokens: 2,
              cache_read_tokens: 0,
              cache_write_tokens: 0,
              reasoning_tokens: 1,
              total_cost: 0.01,
            },
          },
          {
            schema_version: 1,
            kind: "incident",
            occurred_at_ms: now - 1,
            completeness: "incomplete",
          },
        ];
        writeFileSync(
          join(fxDir, "usage.jsonl"),
          records.map((record) => JSON.stringify(record)).join("\n") + "\n",
          { mode: 0o600 },
        );
        writeFileSync(join(fxDir, "usage.lock"), "", { mode: 0o600 });
        const env = {
          ...NO_GATEWAY_AUTH,
          HOME: realpathSync(home),
          FX_DISABLE_KEYCHAIN: "1",
        };

        const text = await runFx(["usage"], { env });
        expect(text.code).toBe(0);
        expect(text.stdout).toContain("Known totals may be incomplete.");
        expect(text.stdout).toContain("Total tokens  6");

        const json = await runFx(["usage", "--json"], { env });
        expect(json.code).toBe(0);
        expect(JSON.parse(json.stdout)).toMatchObject({
          completeness: "incomplete",
          totals: { total_tokens: 6, spend: 0.01 },
        });
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test(
    "hx usage distinguishes empty, invalid, corrupt, and unsafe local state",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "fx-e2e-usage-states-"));
      try {
        const home = realpathSync(root);
        const env = { ...NO_GATEWAY_AUTH, HOME: home, FX_DISABLE_KEYCHAIN: "1" };
        const empty = await runFx(["usage", "--json"], { env });
        expect(empty.code).toBe(0);
        expect(JSON.parse(empty.stdout)).toMatchObject({
          coverage: { status: "not_started" },
          totals: null,
        });
        expect(existsSync(join(home, ".hx"))).toBe(false);

        const invalid = await runFx(
          ["usage", "--period", "session", "--json"],
          { env },
        );
        expect(invalid.code).toBe(1);
        expect(JSON.parse(invalid.stdout)).toMatchObject({
          kind: "usage",
          code: "InvalidUsageArgs",
        });

        const fxDir = join(home, ".hx");
        mkdirSync(fxDir, { mode: 0o700 });
        chmodSync(fxDir, 0o700);
        writeFileSync(
          join(fxDir, "usage.jsonl"),
          `${JSON.stringify({
            schema_version: 1,
            kind: "coverage",
            started_at_ms: Date.now() - 1,
          })}\n`,
          { mode: 0o600 },
        );
        if (platform() !== "win32") {
          chmodSync(fxDir, 0o755);
          const entries = readdirSync(fxDir);
          const unsafeDirectory = await runFx(["usage", "--json"], { env });
          expect(unsafeDirectory.code).toBe(1);
          expect(JSON.parse(unsafeDirectory.stdout)).toMatchObject({
            kind: "usage",
            code: "PrivateStatePermissionsUnsupported",
          });
          expect(lstatSync(fxDir).mode & 0o777).toBe(0o755);
          expect(readdirSync(fxDir)).toEqual(entries);
          chmodSync(fxDir, 0o700);
        }
        writeFileSync(join(fxDir, "usage.jsonl"), "{\"broken\":true}\n", {
          mode: 0o600,
        });
        writeFileSync(join(fxDir, "usage.lock"), "", { mode: 0o600 });
        const corrupt = await runFx(["usage", "--json"], { env });
        expect(corrupt.code).toBe(1);
        expect(JSON.parse(corrupt.stdout)).toMatchObject({
          kind: "usage",
          code: "InvalidUsageStore",
        });

        if (platform() !== "win32") {
          rmSync(join(fxDir, "usage.jsonl"));
          const fifo = spawnSync("mkfifo", [join(fxDir, "usage.jsonl")]);
          expect(fifo.status).toBe(0);
          const special = await runFx(["usage", "--json"], { env });
          expect(special.code).toBe(1);
          expect(JSON.parse(special.stdout)).toMatchObject({
            kind: "usage",
            code: "DurablePathUnsafe",
          });

          rmSync(join(fxDir, "usage.jsonl"));
          const socketPath = join(fxDir, "usage.jsonl");
          const server = createServer();
          await new Promise<void>((resolve, reject) => {
            server.once("error", reject);
            server.listen(socketPath, () => {
              server.off("error", reject);
              resolve();
            });
          });
          try {
            const socket = await runFx(["usage", "--json"], { env });
            expect(socket.code).toBe(1);
            expect(JSON.parse(socket.stdout)).toMatchObject({
              kind: "usage",
              code: "DurablePathUnsafe",
            });
          } finally {
            await new Promise<void>((resolve) => server.close(() => resolve()));
          }
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test(
    "hx usage preserves known totals but fails closed when recovery storage is unsafe",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "fx-e2e-usage-recovery-"));
      try {
        const home = join(root, "home");
        const fxDir = join(home, ".hx");
        mkdirSync(fxDir, { recursive: true, mode: 0o700 });
        chmodSync(fxDir, 0o700);
        writeFileSync(
          join(fxDir, "usage.jsonl"),
          [
            {
              schema_version: 1,
              kind: "coverage",
              started_at_ms: Date.now() - 40 * 24 * 60 * 60 * 1000,
            },
            {
              schema_version: 1,
              kind: "generation",
              fact: {
                id: "gen_01ARZ3NDEKTSV4RRFFQ69G5FAV",
                created_at_ms: Date.now() - 1,
                model: "provider/model",
                input_tokens: 4,
                output_tokens: 2,
                cache_read_tokens: 0,
                cache_write_tokens: 0,
                reasoning_tokens: 1,
                total_cost: 0.01,
              },
            },
          ].map((record) => JSON.stringify(record)).join("\n") + "\n",
          { mode: 0o600 },
        );
        writeFileSync(join(fxDir, "usage.lock"), "", { mode: 0o600 });
        const outside = join(root, "outside");
        writeFileSync(outside, "not a session directory");
        symlinkSync(outside, join(fxDir, "sessions"));

        const result = await runFx(["usage", "--json"], {
          env: {
            ...NO_GATEWAY_AUTH,
            HOME: realpathSync(home),
            FX_DISABLE_KEYCHAIN: "1",
          },
        });
        expect(result.code).toBe(0);
        expect(result.stderr).toBe("");
        expect(JSON.parse(result.stdout)).toMatchObject({
          kind: "usage",
          coverage: { status: "full" },
          completeness: "incomplete",
          totals: { total_tokens: 6, spend: 0.01 },
        });
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );
});

describe("cli: permissions", () => {
  test(
    "hx permissions --json returns valid permissions JSON",
    async () => {
      const r = await runFx(["permissions", "--json"]);
      expect(r.code).toBe(0);
      const json = JSON.parse(r.stdout.trim());
      expect(json.kind).toBe("permissions");
      expect(json).toHaveProperty("mode");
      expect(json).toHaveProperty("grant_count");
      expect(json.grant_scope).toBe("session");
      expect(json.runtime_grants_available).toBe(false);
      expect(json.rules_scope).toBe("persistent_config");
      expect(Array.isArray(json.rules)).toBe(true);
      expect(Array.isArray(json.grants)).toBe(true);
    },
    TIMEOUT,
  );
});

describe("cli: doctor", () => {
  test(
    "hx doctor --json returns valid doctor JSON",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "fx-e2e-doctor-json-"));
      try {
        const home = join(root, "home");
        const workspace = join(root, "workspace");
        mkdirSync(home);
        mkdirSync(workspace);

        const r = await runFx(["doctor", "--json"], {
          cwd: realpathSync(workspace),
          env: {
            ...NO_GATEWAY_AUTH,
            HOME: realpathSync(home),
          },
          timeoutMs: TIMEOUT,
        });
        expect(r.code).toBe(0);
        const json = JSON.parse(r.stdout.trim());
        expect(json.kind).toBe("doctor");
        expect(Array.isArray(json.checks)).toBe(true);
        expect(json).toHaveProperty("ok_count");
        expect(json).toHaveProperty("warn_count");
        expect(json).toHaveProperty("fail_count");
        expect(json.checks).toContainEqual({
          name: "auth",
          status: "fail",
          detail: MISSING_AUTH_MESSAGE,
        });
        for (const check of json.checks) {
          expect(check).toHaveProperty("name");
          expect(check).toHaveProperty("status");
          expect(check).toHaveProperty("detail");
          expect(["ok", "warn", "fail"]).toContain(check.status);
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test(
    "hx doctor --json leaves an empty home unchanged",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "fx-e2e-doctor-no-create-"));
      try {
        const home = join(root, "home");
        const workspace = join(root, "workspace");
        mkdirSync(home);
        mkdirSync(workspace);

        const r = await runFx(["doctor", "--json"], {
          cwd: realpathSync(workspace),
          env: {
            ...NO_GATEWAY_AUTH,
            HOME: realpathSync(home),
          },
          timeoutMs: TIMEOUT,
        });

        expect(r.code).toBe(0);
        expect(JSON.parse(r.stdout.trim()).kind).toBe("doctor");
        expect(existsSync(join(home, ".hx"))).toBe(false);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test(
    "hx doctor --json bounds session diagnostics without summary cache",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "fx-e2e-doctor-bounded-"));
      try {
        const home = join(root, "home");
        const workspace = join(root, "workspace");
        mkdirSync(home);
        mkdirSync(workspace);
        const workspaceRoot = realpathSync(workspace);
        const limit = doctorSessionDiagnosticsLimit();
        const sessionCount = limit + 32;
        for (let i = 0; i < sessionCount; i += 1) {
          writeLegacySession(
            home,
            workspaceRoot,
            `doctor-bounded-${String(i).padStart(3, "0")}`,
            { updatedAtMs: i + 1 },
          );
        }

        expect(existsSync(join(home, ".hx", "sessions", "summary.json"))).toBe(false);

        const r = await runFx(["doctor", "--json"], {
          cwd: workspaceRoot,
          env: {
            ...NO_GATEWAY_AUTH,
            HOME: home,
          },
          timeoutMs: TIMEOUT,
        });

        expect(r.code).toBe(0);
        expect(r.stderr).toBe("");
        expect(r.stdout.length).toBeLessThan(64 * 1024);
        const json = JSON.parse(r.stdout.trim());
        expect(json.kind).toBe("doctor");
        expect(json.checks.length).toBeLessThan(sessionCount);
        expect(json.checks).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              name: "session",
              status: "warn",
              detail: expect.stringContaining(
                `truncated after ${limit} session director`,
              ),
            }),
            expect.objectContaining({
              name: "sessions",
              status: "warn",
              detail: expect.stringContaining(
                "unavailable without a full session scan",
              ),
            }),
          ]),
        );
        expect(
          json.checks.some((check: { detail: string }) =>
            check.detail.includes(`${sessionCount} saved session(s)`),
          ),
        ).toBe(false);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );
});

describe("cli: logout", () => {
  test(
    "hx logout leaves an active API key unchanged when no login exists",
    async () => {
      const home = mkdtempSync(join(tmpdir(), "fx-e2e-logout-no-login-"));
      const apiToken = "logout-existing-api-key";
      try {
        const env = {
          HOME: realpathSync(home),
          VERCEL_OIDC_TOKEN: undefined,
          AI_GATEWAY_API_KEY: apiToken,
          FX_DISABLE_KEYCHAIN: "1",
        };
        const logout = await runFx(["logout"], { env });
        const status = await runFx(["status", "--json"], { env });

        expect(logout.code).toBe(0);
        expect(logout.stdout).toBe("No SuperGrok login session found.\n");
        expect(logout.stderr).toBe("");
        expect(JSON.parse(status.stdout)).toMatchObject({
          auth: "missing",
          auth_refreshable: false,
        });
        expect(logout.stdout).not.toContain(apiToken);
        expect(status.stdout).not.toContain(apiToken);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );
});

describe("cli: setup", () => {
  test(
    "fx setup is not a product command",
    async () => {
      const r = await runFx(["setup"], {
        env: { ...NO_GATEWAY_AUTH, FX_DISABLE_KEYCHAIN: "1" },
      });
      expect(r.code).not.toBe(0);
      expect(r.stdout).toBe("");
      expect(r.stderr).toContain("unknown subcommand: setup");
      expect(r.stderr).not.toContain("AI Gateway");
      expect(r.stderr).not.toContain("Vercel");
    },
    TIMEOUT,
  );
});

// The file backend is only selected off macOS, so these run on Linux CI.
describe("cli: stored key file backend", () => {
  test.skipIf(platform() === "darwin")(
    "a 0600 key file resolves, and a loosened one is refused rather than reported absent",
    async () => {
      const home = mkdtempSync(join(tmpdir(), "fx-stored-key-file-"));
      const fxDir = join(home, ".hx");
      mkdirSync(fxDir, { recursive: true, mode: 0o700 });
      chmodSync(fxDir, 0o700);
      const keyPath = join(fxDir, "api-key");
      writeFileSync(keyPath, "vca_file_backend_key", { mode: 0o600 });
      chmodSync(keyPath, 0o600);
      const env = { ...NO_GATEWAY_AUTH, HOME: realpathSync(home) };

      try {
        const readable = await runFx(["status", "--json"], { env });
        expect(readable.code).toBe(0);
        const readableJson = JSON.parse(readable.stdout);
        expect(readableJson.auth).toBe("missing");
        expect(readableJson.auth_help).toBe(MISSING_AUTH_MESSAGE);
        expect(readable.stdout).not.toContain("vca_file_backend_key");

        chmodSync(keyPath, 0o644);
        const refused = await runFx(["status", "--json"], { env });
        expect(refused.code).toBe(0);
        const refusedJson = JSON.parse(refused.stdout);
        expect(refusedJson.auth).toBe("missing");
        expect(refusedJson.auth_help).toBe(MISSING_AUTH_MESSAGE);

        rmSync(keyPath);
        const absent = await runFx(["status", "--json"], { env });
        const absentJson = JSON.parse(absent.stdout);
        expect(absentJson.auth).toBe("missing");
        expect(absentJson.auth_help).toBe(MISSING_AUTH_MESSAGE);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );
});

describe("cli: read-only no-create matrix", () => {
  const probes = [
    { args: ["status", "--json"], code: 0, kind: "status" },
    { args: ["sessions", "--json"], code: 0, kind: "sessions", count: 0 },
    { args: ["session", "last", "--json"], code: 1, error: "no saved sessions" },
    { args: ["session", "--id", "missing.valid-id", "--json"], code: 1, error: "record not found" },
    { args: ["background", "--json"], code: 0, kind: "background", count: 0 },
    { args: ["background", "999999", "--json"], code: 1, error: "no persisted records" },
    { args: ["doctor", "--json"], code: 0, kind: "doctor" },
  ] as const;

  for (const probe of probes) {
    test(
      `${probe.args.join(" ")} leaves an empty home unchanged`,
      async () => {
        const root = mkdtempSync(join(tmpdir(), "fx-e2e-no-create-"));
        try {
          const home = join(root, "home");
          const workspace = join(root, "workspace");
          mkdirSync(home);
          mkdirSync(workspace);
          const before = snapshotTree(home);

          const result = await runFx([...probe.args], {
            cwd: realpathSync(workspace),
            env: {
              ...NO_GATEWAY_AUTH,
              HOME: realpathSync(home),
              FX_E2E_FAIL_ON_DURABLE_MUTATION: "1",
            },
            timeoutMs: TIMEOUT,
          });

          expect(result.code).toBe(probe.code);
          if ("kind" in probe) {
            const output = JSON.parse(result.stdout);
            expect(output.kind).toBe(probe.kind);
            if ("count" in probe) expect(output.count).toBe(probe.count);
          } else {
            const output = JSON.parse(result.stdout);
            expect(output.error).toContain(probe.error);
            expect(result.stderr).toBe("");
          }
          expect(snapshotTree(home)).toEqual(before);
          expect(existsSync(join(home, ".hx"))).toBe(false);
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      },
      TIMEOUT,
    );
  }
});

describe("cli: missing durable home", () => {
  test(
    "read-only commands tolerate a nonexistent HOME",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "fx-e2e-missing-home-path-"));
      const home = join(root, "missing-home");
      const workspace = join(root, "workspace");
      try {
        mkdirSync(workspace);
        const cwd = realpathSync(workspace);
        const env = {
          ...NO_GATEWAY_AUTH,
          HOME: home,
          FX_AUTO_UPGRADE: "0",
          FX_DISABLE_KEYCHAIN: "1",
        };

        const status = await runFx(["status", "--json"], {
          cwd,
          env,
          timeoutMs: TIMEOUT,
        });
        expect(status.code).toBe(0);
        expect(status.stderr).toBe("");
        expect(JSON.parse(status.stdout).kind).toBe("status");
        expect(existsSync(home)).toBe(false);

        const listed = await runFx(["sessions", "--json"], {
          cwd,
          env,
          timeoutMs: TIMEOUT,
        });
        expect(listed.code).toBe(0);
        expect(JSON.parse(listed.stdout)).toEqual({
          kind: "sessions",
          count: 0,
          sessions: [],
        });
        expect(existsSync(home)).toBe(false);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test(
    "session commands fail precisely while doctor remains available without HOME",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "fx-e2e-no-home-"));
      try {
        const workspace = join(root, "workspace");
        mkdirSync(workspace);
        const cwd = realpathSync(workspace);
        const env = {
          ...NO_GATEWAY_AUTH,
          HOME: undefined,
        };

        for (const args of [
          ["sessions", "--json"],
          ["session", "last", "--json"],
          ["session", "--id", "missing.valid-id", "--json"],
          ["session", "migrate", "--id", "missing.valid-id", "--json"],
        ]) {
          const result = await runFx(args, { cwd, env, timeoutMs: TIMEOUT });
          expect(result.code).toBe(1);
          expect(result.stderr).toBe("");
          expect(JSON.parse(result.stdout)).toEqual(
            expect.objectContaining({
              code: "HomeNotSet",
            }),
          );
        }

        const doctor = await runFx(["doctor", "--json"], {
          cwd,
          env,
          timeoutMs: TIMEOUT,
        });
        expect(doctor.code).toBe(0);
        expect(JSON.parse(doctor.stdout).checks).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              name: "state",
              detail: expect.stringContaining("HomeNotSet"),
            }),
          ]),
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );
});

describe("cli: sessions", () => {
  test(
    "hx sessions --json returns valid sessions JSON",
    async () => {
      const home = mkdtempSync(join(tmpdir(), "fx-e2e-sessions-empty-"));
      try {
        const r = await runFx(["sessions", "--json"], { env: { HOME: home } });
        expect(r.code).toBe(0);
        const json = JSON.parse(r.stdout.trim());
        expect(json.kind).toBe("sessions");
        expect(json).toHaveProperty("count");
        expect(Array.isArray(json.sessions)).toBe(true);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test(
    "hx sessions text shows named, unnamed, and renamed sessions",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "fx-e2e-session-names-"));
      try {
        const home = join(root, "home");
        const workspace = join(root, "workspace");
        const sessionsDir = join(home, ".hx", "sessions");
        mkdirSync(sessionsDir, { recursive: true, mode: 0o700 });
        mkdirSync(workspace);
        chmodSync(join(home, ".hx"), 0o700);
        chmodSync(sessionsDir, 0o700);
        const workspaceRoot = realpathSync(workspace);
        const named = {
          id: "named-session",
          workspace_root: workspaceRoot,
          origin_workspace_root: workspaceRoot,
          title: "Investigate cache misses",
          preview: null,
          display_metadata_present: true,
          created_at_ms: 1,
          updated_at_ms: 3,
          conversation_language: "en",
          history_len: 2,
        };
        const unnamed = {
          ...named,
          id: "unnamed-session",
          title: null,
          display_metadata_present: false,
          updated_at_ms: 2,
          history_len: 0,
        };
        const scriptOnly = {
          ...named,
          id: "script-only-session",
          title: "Review landing page",
          updated_at_ms: 1_700_000_000_123,
          conversation_language: "und-Latn",
          history_len: 1,
        };
        const indexPath = join(sessionsDir, "index.json");
        writeFileSync(
          indexPath,
          JSON.stringify({
            schema_version: 3,
            sessions: [scriptOnly, named, unnamed],
          }),
          { mode: 0o600 },
        );

        const first = await runFx(["sessions"], {
          cwd: workspaceRoot,
          env: { HOME: home, ...NO_GATEWAY_AUTH },
          timeoutMs: TIMEOUT,
        });
        expect(first.code).toBe(0);
        expect(first.stderr).toBe("");
        expect(first.stdout).toContain(
          " - Investigate cache misses\n   id=named-session | 2 turns | English | updated 1970-01-01 00:00:00.003 UTC",
        );
        expect(first.stdout).toContain(
          " - Untitled session\n   id=unnamed-session | 0 turns | English | updated 1970-01-01 00:00:00.002 UTC",
        );
        expect(first.stdout).toContain(
          " - Review landing page\n   id=script-only-session | 1 turn | Latin script | updated 2023-11-14 22:13:20.123 UTC",
        );
        expect(first.stdout).not.toContain("updated_at_ms");
        expect(first.stdout).not.toContain("language=");

        const structured = await runFx(["sessions", "--json"], {
          cwd: workspaceRoot,
          env: { HOME: home, ...NO_GATEWAY_AUTH },
          timeoutMs: TIMEOUT,
        });
        expect(structured.code).toBe(0);
        expect(structured.stderr).toBe("");
        expect(JSON.parse(structured.stdout).sessions[0]).toMatchObject({
          id: "script-only-session",
          updated_at_ms: 1_700_000_000_123,
          conversation_language: "und-Latn",
        });

        writeFileSync(
          indexPath,
          JSON.stringify({
            schema_version: 3,
            sessions: [
              scriptOnly,
              { ...named, title: "Investigate cache hits" },
              unnamed,
            ],
          }),
          { mode: 0o600 },
        );
        const renamed = await runFx(["sessions"], {
          cwd: workspaceRoot,
          env: { HOME: home, ...NO_GATEWAY_AUTH },
          timeoutMs: TIMEOUT,
        });
        expect(renamed.code).toBe(0);
        expect(renamed.stderr).toBe("");
        expect(renamed.stdout).toContain(
          " - Investigate cache hits\n   id=named-session | 2 turns | English",
        );
        expect(renamed.stdout).not.toContain("Investigate cache misses");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test(
    "session listing pages a 9001-entry index without scanning session directories",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "fx-e2e-session-pages-"));
      try {
        const home = join(root, "home");
        const workspace = join(root, "workspace");
        const sessionsDir = join(home, ".hx", "sessions");
        mkdirSync(sessionsDir, { recursive: true, mode: 0o700 });
        mkdirSync(workspace);
        chmodSync(join(home, ".hx"), 0o700);
        chmodSync(sessionsDir, 0o700);
        const workspaceRoot = realpathSync(workspace);
        const sessions = Array.from({ length: 9_001 }, (_, index) => {
          const id = `indexed-session-${index.toString().padStart(5, "0")}`;
          return {
            id,
            workspace_root: workspaceRoot,
            origin_workspace_root: workspaceRoot,
            title: id,
            preview: `${id} preview`,
            display_metadata_present: true,
            created_at_ms: 20_000 - index,
            updated_at_ms: 20_000 - index,
            conversation_language: "en",
            history_len: 0,
          };
        });
        writeFileSync(
          join(sessionsDir, "index.json"),
          JSON.stringify({ schema_version: 3, sessions }),
          { mode: 0o600 },
        );

        const first = await runFx(["sessions", "--json"], {
          cwd: workspaceRoot,
          env: { HOME: home, ...NO_GATEWAY_AUTH },
          timeoutMs: TIMEOUT,
        });
        expect(first.code).toBe(0);
        expect(Buffer.byteLength(first.stdout)).toBeLessThan(100_000);
        const firstJson = JSON.parse(first.stdout) as {
          count: number;
          has_more: boolean;
          next_cursor: string;
          sessions: Array<{ id: string; history_len: number }>;
        };
        expect(firstJson.count).toBe(100);
        expect(firstJson.has_more).toBe(true);
        expect(firstJson.sessions).toHaveLength(100);
        expect(firstJson.sessions[0]).toMatchObject({
          id: "indexed-session-00000",
          history_len: 0,
        });
        expect(firstJson.sessions[99].id).toBe("indexed-session-00099");

        const second = await runFx(
          ["sessions", "--json", "--cursor", firstJson.next_cursor],
          {
            cwd: workspaceRoot,
            env: { HOME: home, ...NO_GATEWAY_AUTH },
            timeoutMs: TIMEOUT,
          },
        );
        expect(second.code).toBe(0);
        const secondJson = JSON.parse(second.stdout) as {
          count: number;
          has_more: boolean;
          sessions: Array<{ id: string }>;
        };
        expect(secondJson.count).toBe(100);
        expect(secondJson.has_more).toBe(true);
        expect(secondJson.sessions[0].id).toBe("indexed-session-00100");
        expect(secondJson.sessions[99].id).toBe("indexed-session-00199");

        const one = await runFx(["sessions", "--json", "--limit", "1"], {
          cwd: workspaceRoot,
          env: { HOME: home, ...NO_GATEWAY_AUTH },
          timeoutMs: TIMEOUT,
        });
        expect(one.code).toBe(0);
        expect(JSON.parse(one.stdout)).toMatchObject({
          count: 1,
          has_more: true,
          sessions: [{ id: "indexed-session-00000" }],
        });

        const invalid = await runFx(["sessions", "--limit", "0"], {
          cwd: workspaceRoot,
          env: { HOME: home, ...NO_GATEWAY_AUTH },
          timeoutMs: TIMEOUT,
        });
        expect(invalid.code).not.toBe(0);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test(
    "session lists use projections without opening unreadable event logs",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "fx-e2e-session-projections-"));
      try {
        const home = join(root, "home");
        const workspace = join(root, "workspace");
        mkdirSync(home);
        mkdirSync(workspace);
        const workspaceRoot = realpathSync(workspace);
        const fixture = spawnSync(
          "python3",
          [
            join(REPO_ROOT, "benchmarks", "session_list_fixture.py"),
            "--home",
            home,
            "--workspace",
            workspaceRoot,
            "--sessions",
            "2",
            "--log-size",
            "4096",
            "--deny-event-read",
          ],
          { encoding: "utf8" },
        );
        expect(fixture.status).toBe(0);

        const before = snapshotTree(join(home, ".hx"));
        const listed = await runFx(["sessions", "--json"], {
          cwd: workspaceRoot,
          env: { HOME: home },
          timeoutMs: TIMEOUT,
        });
        expect(listed.code).toBe(0);
        expect(JSON.parse(listed.stdout)).toEqual({
          kind: "sessions",
          count: 2,
          sessions: [
            {
              id: "benchmark-session-01",
              title: "Benchmark session 01",
              preview: "Benchmark session 01 preview",
              workspace_root: workspaceRoot,
              origin_workspace_root: workspaceRoot,
              created_at_ms: 1001,
              updated_at_ms: 2001,
              history_len: 1,
              conversation_language: "en",
            },
            {
              id: "benchmark-session-00",
              title: "Benchmark session 00",
              preview: "Benchmark session 00 preview",
              workspace_root: workspaceRoot,
              origin_workspace_root: workspaceRoot,
              created_at_ms: 1000,
              updated_at_ms: 2000,
              history_len: 0,
              conversation_language: "en",
            },
          ],
        });
        expect(snapshotTree(join(home, ".hx"))).toEqual(before);

        const latest = await runFx(["session", "last", "--json"], {
          cwd: workspaceRoot,
          env: { HOME: home },
          timeoutMs: TIMEOUT,
        });
        expect(latest.code).toBe(0);
        expect(JSON.parse(latest.stdout)).toEqual({
          kind: "session_summary",
          id: "benchmark-session-01",
          title: "Benchmark session 01",
          preview: "Benchmark session 01 preview",
          workspace_root: workspaceRoot,
          origin_workspace_root: workspaceRoot,
          created_at_ms: 1001,
          updated_at_ms: 2001,
          history_len: 1,
          conversation_language: "en",
        });
        expect(snapshotTree(join(home, ".hx"))).toEqual(before);

        const detail = await runFx(
          ["session", "--id", "benchmark-session-00", "--json"],
          {
            cwd: workspaceRoot,
            env: { HOME: home },
            timeoutMs: TIMEOUT,
          },
        );
        expect(detail.code).not.toBe(0);
        expect(detail.stderr).toContain("AccessDenied");
        expect(snapshotTree(join(home, ".hx"))).toEqual(before);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test(
    "workspace-scoped session discovery filters list and last by cwd",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "fx-e2e-workspace-sessions-"));
      try {
        const home = join(root, "home");
        const workspaceA = join(root, "workspace-a");
        const workspaceB = join(root, "workspace-b");
        mkdirSync(home);
        mkdirSync(workspaceA);
        mkdirSync(workspaceB);
        const workspaceARoot = realpathSync(workspaceA);
        const workspaceBRoot = realpathSync(workspaceB);

        writeLegacySession(home, workspaceARoot, "workspace-a-older", {
          updatedAtMs: 20,
        });
        writeLegacySession(home, workspaceARoot, "workspace-a-latest", {
          updatedAtMs: 40,
        });
        writeLegacySession(home, workspaceBRoot, "workspace-b-newest", {
          updatedAtMs: 80,
        });

        const listA = await runFx(["sessions", "--json"], {
          cwd: workspaceARoot,
          env: { HOME: home, ...NO_GATEWAY_AUTH },
          timeoutMs: TIMEOUT,
        });
        expect(listA.code).toBe(0);
        const jsonA = JSON.parse(listA.stdout);
        expect(jsonA.kind).toBe("sessions");
        expect(jsonA.count).toBe(2);
        expect(jsonA.sessions.map((session: { id: string }) => session.id))
          .toEqual(["workspace-a-latest", "workspace-a-older"]);

        const lastA = await runFx(["session", "last", "--json"], {
          cwd: workspaceARoot,
          env: { HOME: home, ...NO_GATEWAY_AUTH },
          timeoutMs: TIMEOUT,
        });
        expect(lastA.code).toBe(0);
        expect(JSON.parse(lastA.stdout).id).toBe("workspace-a-latest");

        const listB = await runFx(["sessions", "--json"], {
          cwd: workspaceBRoot,
          env: { HOME: home, ...NO_GATEWAY_AUTH },
          timeoutMs: TIMEOUT,
        });
        expect(listB.code).toBe(0);
        const jsonB = JSON.parse(listB.stdout);
        expect(jsonB.count).toBe(1);
        expect(jsonB.sessions.map((session: { id: string }) => session.id))
          .toEqual(["workspace-b-newest"]);

        const exactForeign = await runFx(
          ["session", "--id", "workspace-b-newest", "--json"],
          {
            cwd: workspaceARoot,
            env: { HOME: home, ...NO_GATEWAY_AUTH },
            timeoutMs: TIMEOUT,
          },
        );
        expect(exactForeign.code).toBe(0);
        expect(JSON.parse(exactForeign.stdout).id).toBe("workspace-b-newest");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test(
    "session discovery reports corrupt records and distinguishes an unreadable latest session",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "fx-e2e-corrupt-sessions-"));
      try {
        const home = join(root, "home");
        const workspace = join(root, "workspace");
        mkdirSync(home);
        mkdirSync(workspace);
        const workspaceRoot = realpathSync(workspace);
        writeLegacySession(home, workspaceRoot, "readable-session", {
          updatedAtMs: 30,
        });
        for (const [id, contents] of [
          ["invalid-json", "{"],
          ["truncated", '{"schema_version":2,"id":"truncated"}'],
        ] as const) {
          const directory = join(home, ".hx", "sessions", id);
          mkdirSync(directory, { recursive: true, mode: 0o700 });
          writeFileSync(join(directory, "session.json"), contents, {
            mode: 0o600,
          });
        }

        const listed = await runFx(["sessions", "--json"], {
          cwd: workspaceRoot,
          env: { HOME: home, ...NO_GATEWAY_AUTH },
          timeoutMs: TIMEOUT,
        });
        expect(listed.code).toBe(0);
        expect(JSON.parse(listed.stdout)).toMatchObject({
          kind: "sessions",
          count: 1,
          skipped_invalid: 2,
          sessions: [{ id: "readable-session" }],
        });

        rmSync(join(home, ".hx", "sessions", "readable-session"), {
          recursive: true,
          force: true,
        });
        const latest = await runFx(["session", "last", "--json"], {
          cwd: workspaceRoot,
          env: { HOME: home, ...NO_GATEWAY_AUTH },
          timeoutMs: TIMEOUT,
        });
        expect(latest.code).toBe(1);
        expect(latest.stderr).toBe("");
        expect(JSON.parse(latest.stdout)).toMatchObject({
          error: expect.stringContaining("saved sessions are unreadable"),
        });
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test(
    "profile-wide session discovery recovers sessions after a workspace rename",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "fx-e2e-renamed-workspace-"));
      try {
        const home = join(root, "home");
        const original = join(root, "workspace-before");
        const renamed = join(root, "workspace-after");
        mkdirSync(home);
        mkdirSync(original);
        const originalRoot = realpathSync(original);
        writeLegacySession(home, originalRoot, "renamed-workspace-session", {
          updatedAtMs: 40,
        });
        renameSync(original, renamed);
        const renamedRoot = realpathSync(renamed);

        const scoped = await runFx(["sessions", "--json"], {
          cwd: renamedRoot,
          env: { HOME: home, ...NO_GATEWAY_AUTH },
          timeoutMs: TIMEOUT,
        });
        expect(JSON.parse(scoped.stdout)).toMatchObject({ count: 0, sessions: [] });

        const recovered = await runFx(["sessions", "--all", "--json"], {
          cwd: renamedRoot,
          env: { HOME: home, ...NO_GATEWAY_AUTH },
          timeoutMs: TIMEOUT,
        });
        expect(recovered.code).toBe(0);
        expect(JSON.parse(recovered.stdout)).toMatchObject({
          count: 1,
          sessions: [
            {
              id: "renamed-workspace-session",
              workspace_root: originalRoot,
            },
          ],
        });
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test(
    "hx sessions --json ignores malformed and oversized list caches",
    async () => {
      for (const cached of ["{", "x".repeat(4 * 1024 * 1024 + 1)]) {
        const root = mkdtempSync(join(tmpdir(), "fx-e2e-sessions-cache-"));
        try {
          const home = join(root, "home");
          const workspace = join(root, "workspace");
          mkdirSync(join(home, ".hx", "sessions"), { recursive: true });
          mkdirSync(workspace, { recursive: true });
          writeFileSync(join(home, ".hx", "sessions", "list.json"), cached);

          const r = await runFx(["sessions", "--json"], {
            cwd: realpathSync(workspace),
            env: { HOME: home },
            timeoutMs: TIMEOUT,
          });
          expect(r.code).toBe(0);
          expect(JSON.parse(r.stdout.trim())).toEqual({
            kind: "sessions",
            count: 0,
            sessions: [],
          });
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      }
    },
    TIMEOUT,
  );

  test(
    "exact session flags address special-token and 255-byte IDs literally",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "fx-e2e-session-exact-ids-"));
      try {
        const home = join(root, "home");
        const workspace = join(root, "workspace");
        mkdirSync(home);
        mkdirSync(workspace);
        const workspaceRoot = realpathSync(workspace);
        const ids = [
          "last",
          "migrate",
          "--json",
          "--allow-large",
          "x".repeat(255),
        ];
        for (const id of ids) writeLegacySession(home, workspaceRoot, id);

        for (const id of ids) {
          const result = await runFx(
            ["session", "--id", id, "--json"],
            {
              cwd: workspaceRoot,
              env: { HOME: home },
              timeoutMs: TIMEOUT,
            },
          );
          expect(result.code).toBe(0);
          expect(JSON.parse(result.stdout).id).toBe(id);
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test(
    "expected json failures emit machine-readable stdout",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "fx-e2e-json-errors-"));
      try {
        const home = join(root, "home");
        const workspace = join(root, "workspace");
        mkdirSync(home);
        mkdirSync(workspace);
        const workspaceRoot = realpathSync(workspace);
        const cases: Array<{
          args: string[];
          kind: string;
          expectedError?: string;
        }> = [
          { args: ["session", "last", "--json"], kind: "session" },
          {
            args: ["ask", "--json"],
            kind: "ask",
            expectedError: "MissingPrompt",
          },
          {
            args: ["ask", "--json", "--no-save", "--resume", "last", "hello"],
            kind: "ask",
            expectedError: "InvalidAskArgs",
          },
        ];

        for (const item of cases) {
          const result = await runFx(item.args, {
            cwd: workspaceRoot,
            env: { HOME: home, ...NO_GATEWAY_AUTH },
            timeoutMs: TIMEOUT,
          });
          expect(result.code).toBe(1);
          expect(result.stdout.trim().length).toBeGreaterThan(0);
          const parsed = JSON.parse(result.stdout.trim());
          expect(parsed.kind ?? item.kind).toBe(item.kind);
          expect(typeof parsed.error).toBe("string");
          if (item.expectedError) expect(parsed.error).toBe(item.expectedError);
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );
});

describe("cli: removed delegated-task commands", () => {
  test(
    "fx task and fx tasks are unknown commands",
    async () => {
      for (const command of ["task", "tasks"]) {
        const result = await runFx([command], { env: NO_GATEWAY_AUTH });
        expect(result.code).toBe(1);
        expect(`${result.stdout}\n${result.stderr}`).toContain("unknown subcommand");
      }
    },
    TIMEOUT,
  );

  test(
    "legacy tasks files are ignored by ordinary session loading",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "fx-e2e-legacy-tasks-ignored-"));
      try {
        const home = join(root, "home");
        const workspace = join(root, "workspace");
        mkdirSync(home, { recursive: true });
        mkdirSync(workspace, { recursive: true });
        const workspaceRoot = realpathSync(workspace);
        writeLegacySession(home, workspaceRoot, "legacy-tasks-session");
        const tasksDir = join(home, ".hx", "sessions", "legacy-tasks-session", "tasks");
        mkdirSync(tasksDir, { recursive: true });
        writeFileSync(join(tasksDir, "unreadable-legacy-shape.json"), "not json\n");

        const result = await runFx(
          ["session", "--id", "legacy-tasks-session", "--json"],
          {
            cwd: workspaceRoot,
            env: { HOME: home, ...NO_GATEWAY_AUTH },
            timeoutMs: TIMEOUT,
          },
        );
        expect(result.code).toBe(0);
        expect(JSON.parse(result.stdout).id).toBe("legacy-tasks-session");
        expect(existsSync(join(tasksDir, "unreadable-legacy-shape.json"))).toBe(true);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );
});

describe("cli: background", () => {
  test(
    "hx background --json returns valid background JSON",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "fx-e2e-background-empty-"));
      try {
        const home = join(root, "home");
        const workspace = join(root, "workspace");
        mkdirSync(home, { recursive: true });
        mkdirSync(workspace, { recursive: true });

        const r = await runFx(["background", "--json"], {
          cwd: workspace,
          env: { HOME: home },
        });
        expect(r.code).toBe(0);
        const json = JSON.parse(r.stdout.trim());
        expect(json.kind).toBe("background");
        expect(json).toHaveProperty("count");
        expect(Array.isArray(json.records)).toBe(true);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test(
    "hx background --json revalidates saved workspace background records",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "fx-e2e-background-"));
      try {
        const home = join(root, "home");
        const workspace = join(root, "workspace");
        const logs = join(root, "logs");
        mkdirSync(home, { recursive: true });
        mkdirSync(workspace, { recursive: true });
        mkdirSync(logs, { recursive: true });

        const workspaceRoot = realpathSync(workspace);
        const liveLog = join(logs, "live.log");
        const staleLog = join(logs, "stale.log");
        writeFileSync(liveLog, "ready on http://localhost:48976\n");
        writeFileSync(staleLog, "started once\n");

        writeBackgroundSession({
          home,
          sessionId: "session-live",
          workspaceRoot,
          updatedAt: 20,
          record: {
            id: 1,
            pid: String(process.pid),
            command: "npm run dev",
            cwd: workspaceRoot,
            logPath: realpathSync(liveLog),
            expectUrl: true,
            state: "running",
          },
        });
        writeBackgroundSession({
          home,
          sessionId: "session-stale",
          workspaceRoot,
          updatedAt: 10,
          record: {
            id: 2,
            pid: "not-a-pid",
            command: "npm run dev",
            cwd: workspaceRoot,
            logPath: realpathSync(staleLog),
            expectUrl: true,
            state: "running",
          },
        });

        const r = await runFx(["background", "--json"], {
          cwd: workspaceRoot,
          env: { HOME: home },
          timeoutMs: TIMEOUT,
        });
        expect(r.code).toBe(0);
        const json = JSON.parse(r.stdout.trim());
        expect(json.kind).toBe("background");
        expect(json.count).toBe(2);

        const records = json.records as BackgroundRecordJson[];
        const live = records.find((record) => record.log_path === realpathSync(liveLog));
        expect(live).toBeTruthy();
        expect(live?.command).toBe("npm run dev");
        expect(live?.state).toBe("stale");
        expect(live?.server_url).toBeNull();
        expect(live?.diagnostic).toContain("no process identity token");

        const stale = records.find((record) => record.log_path === realpathSync(staleLog));
        expect(stale).toBeTruthy();
        expect(stale?.state).toBe("stale");
        expect(stale?.diagnostic).toContain("pid is missing or invalid");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test(
    "hx background exact json reports corrupt records instead of hiding them as missing",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "fx-e2e-background-corrupt-"));
      try {
        const home = join(root, "home");
        const workspace = join(root, "workspace");
        const logs = join(root, "logs");
        mkdirSync(home, { recursive: true });
        mkdirSync(workspace, { recursive: true });
        mkdirSync(logs, { recursive: true });

        const workspaceRoot = realpathSync(workspace);
        const logPath = join(logs, "corrupt.log");
        writeFileSync(logPath, "started\n");
        writeBackgroundSession({
          home,
          sessionId: "background-corrupt",
          workspaceRoot,
          updatedAt: 20,
          record: {
            id: 1,
            pid: "not-a-pid",
            command: "npm run dev",
            cwd: workspaceRoot,
            logPath: realpathSync(logPath),
            expectUrl: false,
            state: "running",
          },
        });
        const recordPath = join(
          home,
          ".hx",
          "sessions",
          "background-corrupt",
          "background",
          "1.json",
        );
        writeFileSync(recordPath, "{broken", { mode: 0o600 });

        const result = await runFx(["background", "1", "--json"], {
          cwd: workspaceRoot,
          env: { HOME: home, ...NO_GATEWAY_AUTH },
          timeoutMs: TIMEOUT,
        });
        expect(result.code).toBe(1);
        expect(result.stderr).toBe("");
        const json = JSON.parse(result.stdout.trim());
        expect(json.kind).toBe("background");
        expect(json.code).toBe("InvalidBackgroundRecord");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );
});

type BackgroundRecordJson = {
  log_path: string;
  command: string;
  state: string;
  server_url?: string | null;
  diagnostic?: string | null;
};

function writeBackgroundSession(args: {
  home: string;
  sessionId: string;
  workspaceRoot: string;
  updatedAt: number;
  record: {
    id: number;
    pid: string;
    command: string;
    cwd: string;
    logPath: string;
    expectUrl: boolean;
    state: string;
  };
}): void {
  const sessionDir = join(args.home, ".hx", "sessions", args.sessionId);
  const backgroundDir = join(sessionDir, "background");
  mkdirSync(backgroundDir, { recursive: true, mode: 0o700 });
  chmodSync(sessionDir, 0o700);
  chmodSync(backgroundDir, 0o700);
  writeFileSync(
    join(sessionDir, "session.json"),
    JSON.stringify({
      schema_version: 1,
      id: args.sessionId,
      created_at_ms: 1,
      updated_at_ms: args.updatedAt,
      workspace_root: args.workspaceRoot,
      conversation_language: "en",
      history_len: 0,
      history: [],
    }),
    { mode: 0o600 },
  );
  writeFileSync(
    join(backgroundDir, `${args.record.id}.json`),
    JSON.stringify({
      schema_version: 1,
      id: args.record.id,
      started_at_ms: 1,
      updated_at_ms: args.updatedAt,
      pid: args.record.pid,
      command: args.record.command,
      cwd: args.record.cwd,
      log_path: args.record.logPath,
      expect_url: args.record.expectUrl,
      server_url: null,
      exit_code: null,
      state: args.record.state,
      diagnostic: null,
    }),
    { mode: 0o600 },
  );
}

describe("cli: replay failures", () => {
  test(
    "hx replay --json preserves structured failures for missing and malformed tapes",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "fx-e2e-replay-json-errors-"));
      try {
        const missing = await runFx(["replay", join(root, "missing.fxtape"), "--json"]);
        expect(missing.code).toBe(1);
        expect(missing.stderr).toBe("");
        expect(JSON.parse(missing.stdout.trim())).toMatchObject({
          kind: "replay",
          code: "FileNotFound",
        });

        const malformedPath = join(root, "malformed.fxtape");
        writeFileSync(malformedPath, "not a tape");
        const malformed = await runFx(["replay", malformedPath, "--json"]);
        expect(malformed.code).toBe(1);
        expect(malformed.stderr).toBe("");
        expect(JSON.parse(malformed.stdout.trim())).toMatchObject({
          kind: "replay",
        });
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );
});

describe("cli: ask input validation", () => {
  test(
    "hx ask rejects invalid UTF-8 stdin before a model turn or session effects",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "fx-e2e-ask-invalid-utf8-"));
      const home = join(root, "home");
      const workspace = join(root, "workspace");
      mkdirSync(home);
      mkdirSync(workspace);

      try {
        const result = await runFx(["ask", "--json", "--no-save"], {
          cwd: realpathSync(workspace),
          env: {
            ...NO_GATEWAY_AUTH,
            HOME: realpathSync(home),
            FX_DISABLE_KEYCHAIN: "1",
          },
          stdin: Uint8Array.from([0xff, 0xfe, 0x80, 0x68, 0x69]),
          timeoutMs: TIMEOUT,
        });

        expect(result.code).toBe(1);
        expect(result.stderr).toBe("");
        expect(JSON.parse(result.stdout.trim())).toMatchObject({
          exit_code: 1,
          error: "InvalidPromptText",
        });
        expect(existsSync(join(home, ".hx"))).toBe(false);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test(
    "hx ask stdin resource overflow has distinct text and JSON errors",
    async () => {
      const oversized = Buffer.alloc(8 * 1024 * 1024 + 1, 0x78);

      const textResult = await runFx(["ask", "--auto", "--no-save"], {
        env: { ...NO_GATEWAY_AUTH, FX_DISABLE_KEYCHAIN: "1" },
        stdin: oversized,
        timeoutMs: 60_000,
      });
      expect(textResult.code).toBe(1);
      expect(textResult.stdout).toBe("");
      expect(textResult.stderr).toBe(
        "hx ask: prompt exceeds the local input safety limit\n",
      );

      const jsonResult = await runFx(["ask", "--json", "--auto", "--no-save"], {
        env: { ...NO_GATEWAY_AUTH, FX_DISABLE_KEYCHAIN: "1" },
        stdin: oversized,
        timeoutMs: 60_000,
      });
      expect(jsonResult.code).toBe(1);
      expect(jsonResult.stderr).toBe("");
      expect(jsonResult.stdout).toBe(
        '{"output":"","exit_code":1,"model":"","session_id":"","steps":0,"tool_calls":[],"error":"PromptResourceLimitExceeded"}\n',
      );
    },
    120_000,
  );
});

describe("cli: session", () => {
  test(
    "hx session with no id exits non-zero or shows usage",
    async () => {
      const r = await runFx(["session"]);
      expect(r.code).not.toBe(0);
    },
    TIMEOUT,
  );
});

describe("cli: interactive startup", () => {
  test(
    "interactive startup without TTY exits one",
    async () => {
      const cases = [
        [],
        ["resume", "last"],
        ["--resume"],
        ["session", "resume", "last"],
        ["session", "resume", "--id", "session.v3"],
      ];

      for (const args of cases) {
        const home = realpathSync(mkdtempSync(join(tmpdir(), "fx-e2e-no-tty-")));
        try {
          const r = await runFx(args, { env: { HOME: home } });
          expect(r.code).toBe(1);
          expect(r.stdout).toBe("");
          expect(r.stderr).toBe("hx requires an interactive terminal (TTY).\n");
          expect(readdirSync(home)).toEqual([]);
        } finally {
          rmSync(home, { recursive: true, force: true });
        }
      }
    },
    TIMEOUT,
  );
});

describe("cli: pr", () => {
  test(
    "hx pr without SuperGrok auth exits non-zero",
    async () => {
      const home = mkdtempSync(join(tmpdir(), "fx-e2e-noauth-"));
      try {
        const r = await runFx(["pr"], {
          env: { ...NO_GATEWAY_AUTH, HOME: home, FX_DISABLE_KEYCHAIN: "1" },
        });
        expect(r.code).not.toBe(0);
        expect(r.stderr).toContain(MISSING_AUTH_MESSAGE);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );
});

describe("cli: issue", () => {
  test(
    "hx issue without SuperGrok auth exits non-zero",
    async () => {
      const home = mkdtempSync(join(tmpdir(), "fx-e2e-noauth-"));
      try {
        const r = await runFx(["issue"], {
          env: { ...NO_GATEWAY_AUTH, HOME: home, FX_DISABLE_KEYCHAIN: "1" },
        });
        expect(r.code).not.toBe(0);
        expect(r.stderr).toContain(MISSING_AUTH_MESSAGE);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );
});

describe("cli: error handling", () => {
  test(
    "hx ask rejects unknown options before a model turn",
    async () => {
      const rejected = await runFx(["ask", "--definitely-unknown"], {
        env: { ...NO_GATEWAY_AUTH, FX_DISABLE_KEYCHAIN: "1" },
      });
      expect(rejected.code).toBe(1);
      expect(rejected.stderr).toContain("usage: hx ask");
    },
    TIMEOUT,
  );

  test(
    "hx ask with no prompt exits 1",
    async () => {
      const r = await runFx(["ask"]);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("missing prompt");
    },
    TIMEOUT,
  );

  test(
    "fx unknown-command exits 1",
    async () => {
      const r = await runFx(["unknown-command"]);
      expect(r.code).toBe(1);
    },
    TIMEOUT,
  );

  test(
    "hx ask explains no-save resume conflicts before a model turn",
    async () => {
      const env = { ...NO_GATEWAY_AUTH, FX_DISABLE_KEYCHAIN: "1" };
      for (const args of [
        ["ask", "--no-save", "--resume", "last", "hello"],
        ["ask", "--resume-id", "session.v3", "--no-save", "hello"],
      ]) {
        const rejected = await runFx(args, { env });
        expect(rejected.code).toBe(1);
        expect(rejected.stdout).toBe("");
        expect(rejected.stderr).toContain(
          "hx ask: --no-save cannot be used with --resume or --resume-id",
        );
        expect(rejected.stderr).toContain(
          "usage: hx ask [--auto|--yolo] [--image PATH] [--json] [--quiet] [--prompt-permissions] [--no-save]",
        );
      }
    },
    TIMEOUT,
  );
});

describe("cli: workspace access", () => {
  test(
    "workspace launch modifiers preserve ask help and report friendly option errors",
    async () => {
      const enabled = {
        ...NO_GATEWAY_AUTH,
      };

      const help = await runFx(
        ["--add-dir", "/tmp/shared", "ask", "--help"],
        { env: enabled },
      );
      expect(help.code).toBe(0);
      expect(help.stdout.startsWith("hx ask\n\n")).toBe(true);
      expect(help.stderr).toBe("");

      const missing = await runFx(["--add-dir"], { env: enabled });
      expect(missing.code).toBe(1);
      expect(missing.stderr).toContain("--add-dir requires a directory path");
      expect(missing.stderr).not.toContain("MissingAddDirectoryValue");

      const duplicate = await runFx(
        ["--no-additional-dirs", "--no-additional-dirs"],
        { env: enabled },
      );
      expect(duplicate.code).toBe(1);
      expect(duplicate.stderr).toContain(
        "--no-additional-dirs may only be specified once",
      );
      expect(duplicate.stderr).not.toContain(
        "DuplicateAdditionalDirectorySuppression",
      );
    },
    TIMEOUT,
  );

  test(
    "workspace commands persist per-primary roots and track availability",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "fx-workspace-access-cli-"));
      try {
        const home = join(root, "home");
        const workspace = join(root, "workspace");
        const shared = join(root, "shared");
        const unknown = join(root, "unknown");
        const missing = join(root, "missing");
        mkdirSync(join(home, ".hx"), { recursive: true, mode: 0o700 });
        chmodSync(join(home, ".hx"), 0o700);
        mkdirSync(workspace);
        mkdirSync(shared);
        mkdirSync(unknown);
        const workspaceRoot = realpathSync(workspace);
        const sharedRoot = realpathSync(shared);
        const unknownRoot = realpathSync(unknown);
        const baseEnv = {
          ...NO_GATEWAY_AUTH,
          HOME: realpathSync(home),
        };

        const added = await runFx(
          ["workspace", "add", sharedRoot, "--json"],
          { cwd: workspaceRoot, env: baseEnv },
        );
        expect(added.code).toBe(0);
        const addedJson = JSON.parse(added.stdout.trim());
        expect(addedJson).toMatchObject({
          kind: "workspace",
          action: "add",
          changed: true,
          limit: 16,
          path: sharedRoot,
        });
        expect(addedJson.additional_directories).toEqual([
          {
            path: sharedRoot,
            saved: true,
            command_line: false,
            available: true,
            active: true,
          },
        ]);

        const stored = JSON.parse(
          readFileSync(join(home, ".hx", "settings.json"), "utf8"),
        );
        expect(stored.workspaces[workspaceRoot].additional_directories).toEqual([
          sharedRoot,
        ]);

        for (const path of [unknownRoot, missing]) {
          const unknownRemoval = await runFx(
            ["workspace", "remove", path, "--json"],
            { cwd: workspaceRoot, env: baseEnv },
          );
          expect(unknownRemoval.code).toBe(1);
          expect(JSON.parse(unknownRemoval.stdout.trim())).toEqual({
            kind: "workspace",
            error: "directory is not configured as an additional workspace",
            code: "UnknownAdditionalDirectory",
          });
        }

        const removed = await runFx(
          ["workspace", "remove", sharedRoot, "--json"],
          { cwd: workspaceRoot, env: baseEnv },
        );
        expect(removed.code).toBe(0);
        expect(JSON.parse(removed.stdout.trim())).toMatchObject({
          action: "remove",
          changed: true,
          launch_flag_can_restore: false,
          additional_directories: [],
        });

        const readded = await runFx(
          ["workspace", "add", sharedRoot, "--json"],
          { cwd: workspaceRoot, env: baseEnv },
        );
        expect(readded.code).toBe(0);

        const active = await runFx(["workspace", "--json"], {
          cwd: workspaceRoot,
          env: {
            ...baseEnv,
          },
        });
        expect(active.code).toBe(0);
        expect(JSON.parse(active.stdout.trim())).toMatchObject({
          action: "list",
          changed: false,
          additional_directories: [{ path: sharedRoot, active: true }],
        });

        rmSync(sharedRoot, { recursive: true, force: true });
        const unavailable = await runFx(["workspace", "list", "--json"], {
          cwd: workspaceRoot,
          env: {
            ...baseEnv,
          },
        });
        expect(unavailable.code).toBe(0);
        expect(JSON.parse(unavailable.stdout.trim()).additional_directories).toEqual([
          {
            path: sharedRoot,
            saved: true,
            command_line: false,
            available: false,
            active: false,
          },
        ]);

        const unavailableRemoved = await runFx(
          ["workspace", "remove", `${sharedRoot}${sep}`, "--json"],
          { cwd: workspaceRoot, env: baseEnv },
        );
        expect(unavailableRemoved.code).toBe(0);
        expect(JSON.parse(unavailableRemoved.stdout.trim())).toMatchObject({
          action: "remove",
          changed: true,
          additional_directories: [],
        });
        const removedSettings = JSON.parse(
          readFileSync(join(home, ".hx", "settings.json"), "utf8"),
        );
        expect(
          removedSettings.workspaces?.[workspaceRoot]?.additional_directories,
        ).toBeUndefined();

        mkdirSync(sharedRoot);
        const restored = await runFx(
          ["workspace", "add", sharedRoot, "--json"],
          { cwd: workspaceRoot, env: baseEnv },
        );
        expect(restored.code).toBe(0);

        const cleared = await runFx(["workspace", "clear", "--json"], {
          cwd: workspaceRoot,
          env: baseEnv,
        });
        expect(cleared.code).toBe(0);
        expect(JSON.parse(cleared.stdout.trim())).toMatchObject({
          action: "clear",
          changed: true,
          additional_directories: [],
        });
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    30_000,
  );

  test(
    "workspace commands mutate persisted aliases by workspace identity",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "fx-workspace-alias-cli-"));
      try {
        const home = join(root, "home");
        const workspace = join(root, "workspace");
        const shared = join(root, "shared");
        const sharedLink = join(root, "shared-link");
        const missing = join(root, "missing");
        const realParent = join(root, "real-parent");
        const parentLink = join(root, "parent-link");
        mkdirSync(join(home, ".hx"), { recursive: true, mode: 0o700 });
        chmodSync(join(home, ".hx"), 0o700);
        mkdirSync(workspace);
        mkdirSync(shared);
        mkdirSync(realParent);
        symlinkSync(shared, sharedLink, "dir");
        symlinkSync(realParent, parentLink, "dir");
        const workspaceRoot = realpathSync(workspace);
        const sharedRoot = realpathSync(shared);
        const settingsPath = join(home, ".hx", "settings.json");
        const baseEnv = {
          ...NO_GATEWAY_AUTH,
          HOME: realpathSync(home),
        };

        writeFileSync(
          settingsPath,
          JSON.stringify({
            workspaces: {
              [workspaceRoot]: {
                additional_directories: [
                  `${sharedRoot}${sep}.`,
                  sharedLink,
                ],
              },
            },
          }) + "\n",
          { mode: 0o600 },
        );

        const unchanged = await runFx(
          ["workspace", "add", sharedRoot, "--json"],
          { cwd: workspaceRoot, env: baseEnv },
        );
        expect(unchanged.code).toBe(0);
        expect(JSON.parse(unchanged.stdout.trim())).toMatchObject({
          action: "add",
          changed: true,
          saved_changed: true,
          runtime_changed: false,
        });

        const removedAvailable = await runFx(
          ["workspace", "remove", sharedRoot, "--json"],
          { cwd: workspaceRoot, env: baseEnv },
        );
        expect(removedAvailable.code).toBe(0);
        expect(JSON.parse(removedAvailable.stdout.trim())).toMatchObject({
          action: "remove",
          changed: true,
          additional_directories: [],
        });
        let stored = JSON.parse(readFileSync(settingsPath, "utf8"));
        expect(
          stored.workspaces?.[workspaceRoot]?.additional_directories,
        ).toBeUndefined();

        writeFileSync(
          settingsPath,
          JSON.stringify({
            workspaces: {
              [workspaceRoot]: {
                additional_directories: [
                  `${missing}${sep}.`,
                  join(missing, "child", ".."),
                ],
              },
            },
          }) + "\n",
          { mode: 0o600 },
        );
        const removedUnavailable = await runFx(
          ["workspace", "remove", missing, "--json"],
          { cwd: workspaceRoot, env: baseEnv },
        );
        expect(removedUnavailable.code).toBe(0);
        expect(JSON.parse(removedUnavailable.stdout.trim())).toMatchObject({
          action: "remove",
          changed: true,
          additional_directories: [],
        });
        stored = JSON.parse(readFileSync(settingsPath, "utf8"));
        expect(
          stored.workspaces?.[workspaceRoot]?.additional_directories,
        ).toBeUndefined();

        const realMissing = join(realParent, "missing");
        const linkedMissing = join(parentLink, "missing");
        writeFileSync(
          settingsPath,
          JSON.stringify({
            workspaces: {
              [workspaceRoot]: {
                additional_directories: [realMissing, linkedMissing],
              },
            },
          }) + "\n",
          { mode: 0o600 },
        );
        const removedLinkedPrefix = await runFx(
          ["workspace", "remove", linkedMissing, "--json"],
          { cwd: workspaceRoot, env: baseEnv },
        );
        expect(removedLinkedPrefix.code).toBe(0);
        expect(JSON.parse(removedLinkedPrefix.stdout.trim())).toMatchObject({
          action: "remove",
          changed: true,
          additional_directories: [],
        });
        stored = JSON.parse(readFileSync(settingsPath, "utf8"));
        expect(
          stored.workspaces?.[workspaceRoot]?.additional_directories,
        ).toBeUndefined();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    30_000,
  );
});
