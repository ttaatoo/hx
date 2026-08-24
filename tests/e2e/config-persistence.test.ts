import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FX_BIN, runFx } from "../evals/eval-helpers";
import {
  SUPERGROK_FAST_MODEL,
  SUPERGROK_MODEL,
  writeE2eXaiProviders,
} from "./direct-provider-env";
import {
  composerContains,
  FAKE_GATEWAY_MODEL,
  fakeGatewayFinalText,
  fakeGatewayToolCall,
  hasEmptyComposer,
  startFakeGateway,
  TmuxSession,
  tmuxAvailable,
} from "./tmux-helpers";

const TIMEOUT = 20_000;
const NO_AUTH = {
  ANTHROPIC_API_KEY: "",
  FX_MODEL: undefined,
  NO_COLOR: "1",
};

const serialTest = test.serial;
const SELECTED_COMPLETION_SGR = "\x1b[1m\x1b[38;5;255m";

function selectedModelStageRow(paneEscapes: string, label: string): string | null {
  return paneEscapes.split("\n").find((line) => {
    const visible = line.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").trim();
    return line.includes(SELECTED_COMPLETION_SGR) && visible === label;
  }) ?? null;
}

async function waitForSelectedModelStage(
  active: TmuxSession,
  label: string,
  timeoutMs: number,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let last: string | null = null;
  while (Date.now() < deadline) {
    last = selectedModelStageRow(await active.capturePaneEscapes(), label);
    if (last !== null) return last;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for selected model option ${label}; last=${last}`);
}

async function disablePromptHistory(
  session: TmuxSession,
  settingsPath: string,
): Promise<void> {
  await session.sendText("/settings");
  await session.waitForText("←→ Change", TIMEOUT);
  for (let index = 0; index < 14; index += 1) {
    await session.sendKeys("Down");
  }
  await session.sendKeys("Left");
  const deadline = Date.now() + TIMEOUT;
  let enabled: unknown;
  while (Date.now() < deadline) {
    if (existsSync(settingsPath)) {
      enabled = JSON.parse(readFileSync(settingsPath, "utf8")).prompt_history?.enabled;
      if (enabled === false) break;
    }
    await Bun.sleep(25);
  }
  if (enabled !== false) throw new Error("Timed out disabling prompt history");
  await session.sendKeys("Escape");
  await session.waitForPane(
    (pane) => hasEmptyComposer(pane) && !pane.includes("←→ Change"),
    TIMEOUT,
  );
}

function tree(root: string, relative = ""): string[] {
  const path = relative ? join(root, relative) : root;
  const entries = readdirSync(path, { withFileTypes: true });
  const result: string[] = [];
  for (const entry of entries) {
    const child = relative ? join(relative, entry.name) : entry.name;
    result.push(child);
    if (entry.isDirectory()) result.push(...tree(root, child));
  }
  return result.sort();
}

function migrationSnapshotPath(home: string, field: string): string {
  const backups = join(home, ".hx", "backups");
  const name = `settings.json.preference-migration.${field}.json`;
  expect(readdirSync(backups)).toContain(name);
  return join(backups, name);
}

function clearedPaneWithoutAllowlistRules(pane: string): boolean {
  return (
    hasEmptyComposer(pane) &&
    !pane.includes("● Allowlist:") &&
    !pane.includes("user *")
  );
}

describe.skipIf(!tmuxAvailable())("config persistence", () => {
  let session: TmuxSession | null = null;
  let secondSession: TmuxSession | null = null;

  afterEach(async () => {
    await session?.kill();
    await secondSession?.kill();
    session = null;
    secondSession = null;
  });

  serialTest(
    "appearance settings persist independently across launches",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "fx-input-appearance-persistence-"));
      try {
        const home = join(root, "home");
        const workspace = join(root, "workspace");
        const stderrAPath = join(root, "stderr-a.log");
        const stderrBPath = join(root, "stderr-b.log");
        mkdirSync(join(home, ".hx"), { recursive: true, mode: 0o700 });
        mkdirSync(workspace);
        const workspaceRoot = realpathSync(workspace);

        session = await TmuxSession.create({
          cwd: workspaceRoot,
          env: { ...NO_AUTH, HOME: home },
          stderrPath: stderrAPath,
        });
        await session.waitForText("Run /help", TIMEOUT);
        await session.sendText("/appearance");
        await session.waitForText("Input appearance", TIMEOUT);
        expect(await session.capturePane()).toContain("lines  tint");
        expect(await session.capturePane()).toContain("minimal  legacy");
        await session.sendKeys("Escape");
        await session.waitForComposer(TIMEOUT);
        await session.sendText("/appearance input lines");
        await session.waitForText("● Input: switched to lines", TIMEOUT);
        await session.sendText("/appearance presentation normal");
        await session.waitForText("● Maxxing: switched to legacy", TIMEOUT);
        await session.waitForStableComposer(TIMEOUT);
        await session.sendText("/quit");
        await session.waitForSessionEnd(TIMEOUT);
        session = null;

        let stored = JSON.parse(readFileSync(join(home, ".hx", "settings.json"), "utf8"));
        expect(stored.input_appearance).toBe("lines");
        expect(stored.maxxing_mode).toBe("legacy");

        secondSession = await TmuxSession.create({
          cwd: workspaceRoot,
          env: { ...NO_AUTH, HOME: home },
          stderrPath: stderrBPath,
        });
        await secondSession.waitForText("Run /help", TIMEOUT);
        await secondSession.sendText("/appearance");
        await secondSession.waitForText("Input appearance", TIMEOUT);
        expect(await secondSession.capturePane()).toContain("lines  tint");
        expect(await secondSession.capturePane()).toContain("minimal  legacy");
        await secondSession.sendKeys("Escape");
        await secondSession.waitForComposer(TIMEOUT);
        await secondSession.sendText("/appearance input tint");
        await secondSession.waitForText("● Input: switched to tint", TIMEOUT);
        await secondSession.sendText("/appearance presentation minimal");
        await secondSession.waitForText("● Maxxing: switched to minimal", TIMEOUT);
        await secondSession.waitForStableComposer(TIMEOUT);
        await secondSession.sendText("/quit");
        await secondSession.waitForSessionEnd(TIMEOUT);
        secondSession = null;

        stored = JSON.parse(readFileSync(join(home, ".hx", "settings.json"), "utf8"));
        expect(stored.input_appearance).toBe("tint");
        expect(stored.maxxing_mode).toBe("minimal");
        expect(readFileSync(stderrAPath, "utf8")).toBe("");
        expect(readFileSync(stderrBPath, "utf8")).toBe("");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    60_000,
  );

  serialTest(
    "user preferences migrate globally and load in another project",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "fx-config-persistence-"));
      try {
        const home = join(root, "home");
        const workspaceA = join(root, "workspace-a");
        const workspaceB = join(root, "workspace-b");
        const stderrAPath = join(root, "stderr-a.log");
        const stderrBPath = join(root, "stderr-b.log");
        mkdirSync(join(home, ".hx"), { recursive: true, mode: 0o700 });
        mkdirSync(workspaceA);
        mkdirSync(workspaceB);
        writeE2eXaiProviders(home, {
          models: [SUPERGROK_MODEL, SUPERGROK_FAST_MODEL],
        });
        const workspaceARoot = realpathSync(workspaceA);
        const workspaceBRoot = realpathSync(workspaceB);
        const projectABytes = "{\"project_future\":{\"name\":\"a\"}}\n";
        const projectBBytes = "{\"project_future\":{\"name\":\"b\"}}\n";
        writeFileSync(join(workspaceA, ".fx.json"), projectABytes);
        writeFileSync(join(workspaceB, ".fx.json"), projectBBytes);
        writeFileSync(
          join(home, ".hx", "settings.json"),
          JSON.stringify({
            future_global: { nested: "preserve-me" },
            workspaces: {
              [workspaceARoot]: {
                model: "legacy/project-a",
                permission_mode: "ask",
                effort: "low",
                startup_scrollback: true,
                prompt_history: { enabled: true, future: "keep-a-history" },
                statusLine: {
                  sandbox: false,
                  context: false,
                  session: false,
                  workspace: false,
                  future: "keep-a-status",
                },
                future_workspace: { nested: "a" },
              },
              [workspaceBRoot]: {
                model: "legacy/project-b",
                permission_mode: "ask",
                effort: "high",
                startup_scrollback: true,
                prompt_history: { enabled: true, future: "keep-b-history" },
                statusLine: {
                  sandbox: false,
                  context: false,
                  session: false,
                  workspace: false,
                  future: "keep-b-status",
                },
                future_workspace: { nested: "b" },
              },
            },
          }) + "\n",
          { mode: 0o600 },
        );
        const catalogEnv = {
          ...NO_AUTH,
          HOME: home,
        };

        session = await TmuxSession.create({
          cwd: workspaceARoot,
          env: catalogEnv,
          stderrPath: stderrAPath,
        });
        await session.waitForText("Run /help", TIMEOUT);
        await session.sendKeys("BTab");
        await session.waitForText("auto ·", TIMEOUT);
        await session.pasteText(`/model ${SUPERGROK_MODEL} auto`);
        const beforeModelCommit = JSON.parse(
          readFileSync(join(home, ".hx", "settings.json"), "utf8"),
        );
        expect(beforeModelCommit).not.toHaveProperty("model");
        await session.sendKeys("Enter");
        await session.waitForText(`● Switched to ${SUPERGROK_MODEL}`, TIMEOUT);
        await session.sendText("/sandbox none");
        await session.waitForText("● Sandbox: switched to none", TIMEOUT);
        await session.sendText("/statusline sandbox");
        await session.waitForText("● Statusline: sandbox:", TIMEOUT);
        await session.sendText("/statusline context");
        await session.waitForText("● Statusline: context:", TIMEOUT);
        await session.sendText("/statusline session");
        await session.waitForText("● Statusline: session:", TIMEOUT);
        await session.sendText("/statusline workspace");
        await session.waitForText("● Statusline: workspace:", TIMEOUT);
        await session.sendText("/settings startup-scrollback off");
        await session.waitForText("startup_scrollback: off", TIMEOUT);
        await disablePromptHistory(session, join(home, ".hx", "settings.json"));
        await session.sendText("/quit");
        await session.waitForSessionEnd(TIMEOUT);
        session = null;

        const stored = JSON.parse(readFileSync(join(home, ".hx", "settings.json"), "utf8"));
        expect(stored.model).toBe(SUPERGROK_MODEL);
        expect(stored.permission_mode).toBe("auto");
        expect(stored.effort).toBe("auto");
        expect(stored.startup_scrollback).toBe(false);
        expect(stored.prompt_history).toMatchObject({ enabled: false });
        expect(stored.statusLine).toMatchObject({
          sandbox: true,
          context: true,
          session: true,
          workspace: true,
        });
        expect(stored.future_global).toEqual({ nested: "preserve-me" });
        for (const [workspaceRoot, futureWorkspace, historyFuture, statusFuture] of [
          [workspaceARoot, "a", "keep-a-history", "keep-a-status"],
          [workspaceBRoot, "b", "keep-b-history", "keep-b-status"],
        ] as const) {
          const override = stored.workspaces[workspaceRoot];
          expect(override).not.toHaveProperty("model");
          expect(override).not.toHaveProperty("permission_mode");
          expect(override).not.toHaveProperty("effort");
          expect(override).not.toHaveProperty("fast_mode");
          expect(override).not.toHaveProperty("startup_scrollback");
          expect(override.prompt_history).toEqual({ future: historyFuture });
          expect(override.statusLine).toEqual({ workspace: false, future: statusFuture });
          expect(override.future_workspace).toEqual({ nested: futureWorkspace });
        }
        expect(readFileSync(join(workspaceA, ".fx.json"), "utf8")).toBe(projectABytes);
        expect(readFileSync(join(workspaceB, ".fx.json"), "utf8")).toBe(projectBBytes);

        const migrationSnapshots = [
          "model",
          "permission_mode",
          "effort",
          "startup_scrollback",
          "prompt_history_enabled",
          "statusline_sandbox",
          "statusline_context",
          "statusline_session",
        ].map((field) => migrationSnapshotPath(home, field));
        for (const snapshotPath of migrationSnapshots) {
          expect(statSync(snapshotPath).mode & 0o777).toBe(0o600);
        }

        session = await TmuxSession.create({
          cwd: workspaceBRoot,
          env: catalogEnv,
          stderrPath: stderrBPath,
        });
        const startup = await session.waitForText("auto ·", TIMEOUT);
        expect(startup).toContain(SUPERGROK_MODEL);
        expect(startup).not.toContain("adaptive");
        await session.sendText("/settings");
        const pane = await session.waitForText("←→ Change", TIMEOUT);
        expect(pane).toContain(SUPERGROK_MODEL);
        expect(pane).toContain("Startup scrollback");
        expect(pane).toContain("Prompt history");
        await session.sendKeys("Escape");
        await session.waitForPane(
          (current) =>
            hasEmptyComposer(current) && !current.includes("←→ Change"),
          TIMEOUT,
        );
        await session.sendText("/statusline");
        const statusline = await session.waitForText("Sandbox  ", TIMEOUT);
        expect(statusline).toContain("Status line");
        expect(statusline).toContain("Sandbox");
        expect(statusline).toContain("Context");
        expect(statusline).toContain("Session");
        expect(statusline).toContain("off  on");
        await session.sendKeys("Escape");
        await session.waitForComposer(TIMEOUT);
        await session.sendText("/quit");
        await session.waitForSessionEnd(TIMEOUT);
        session = null;

        session = await TmuxSession.create({
          cwd: workspaceBRoot,
          env: {
            ...catalogEnv,
            FX_MODEL: SUPERGROK_FAST_MODEL,
          },
          stderrPath: stderrBPath,
        });
        await session.waitForText(SUPERGROK_FAST_MODEL, TIMEOUT);
        await session.sendText("/quit");
        await session.waitForSessionEnd(TIMEOUT);
        session = null;

        const afterOverride = JSON.parse(
          readFileSync(join(home, ".hx", "settings.json"), "utf8"),
        );
        expect(afterOverride.model).toBe(SUPERGROK_MODEL);
        expect(readFileSync(stderrAPath, "utf8")).toBe("");
        expect(readFileSync(stderrBPath, "utf8")).toBe("");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    120_000,
  );

  serialTest(
    "sandbox and unscoped allowlist stay local while explicit user rules cross projects",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "fx-config-permission-scopes-"));
      try {
        const home = join(root, "home");
        const workspaceA = join(root, "workspace-a");
        const workspaceB = join(root, "workspace-b");
        const stderrAPath = join(root, "stderr-a.log");
        const stderrBPath = join(root, "stderr-b.log");
        mkdirSync(join(home, ".hx"), { recursive: true, mode: 0o700 });
        mkdirSync(workspaceA);
        mkdirSync(workspaceB);
        const workspaceARoot = realpathSync(workspaceA);
        const workspaceBRoot = realpathSync(workspaceB);
        writeFileSync(
          join(home, ".hx", "settings.json"),
          JSON.stringify({
            permission: {
              " bash ": {
                " padded * ": "allow",
              },
            },
          }) + "\n",
          { mode: 0o600 },
        );

        session = await TmuxSession.create({
          cwd: workspaceARoot,
          env: { ...NO_AUTH, HOME: home },
          stderrPath: stderrAPath,
        });
        await session.waitForText("Run /help", TIMEOUT);
        await session.sendText("/sandbox none");
        await session.waitForText("● Sandbox: switched to none", TIMEOUT);
        await session.sendText('/allowlist add command "local-a *"');
        await session.waitForText("(scope=local)", TIMEOUT);
        await session.sendText('/allowlist user add command "user *"');
        await session.waitForText("(scope=user)", TIMEOUT);
        await session.sendText("/quit");
        await session.waitForSessionEnd(TIMEOUT);
        session = null;

        const afterA = JSON.parse(
          readFileSync(join(home, ".hx", "settings.json"), "utf8"),
        );
        expect(afterA.permission.bash["user *"]).toBe("allow");
        expect(afterA.workspaces[workspaceARoot].sandbox).toBe("none");
        expect(afterA.workspaces[workspaceARoot].permission.bash["local-a *"]).toBe(
          "allow",
        );
        expect(afterA.workspaces).not.toHaveProperty(workspaceBRoot);

        session = await TmuxSession.create({
          cwd: workspaceBRoot,
          env: { ...NO_AUTH, HOME: home },
          stderrPath: stderrBPath,
        });
        await session.waitForText("Run /help", TIMEOUT);
        await session.sendText("/sandbox");
        const sandbox = await session.waitForText("←→ Change", TIMEOUT);
        expect(sandbox).toContain("Sandbox");
        expect(sandbox).toContain("Command sandbox");
        expect(sandbox).toContain("os  none");
        expect(sandbox).not.toContain("✓");
        await session.sendKeys("Escape");
        await session.waitForComposer(TIMEOUT);
        await session.sendText("/allowlist view local");
        await session.waitForText(
          "● Allowlist: local persistent allow rules: (none)",
          TIMEOUT,
        );
        await session.sendText("/allowlist view user");
        await session.waitForText("user *", TIMEOUT);
        await session.sendText('/allowlist user remove command "padded *"');
        await session.waitForText("● Allowlist: removed command", TIMEOUT);
        await session.sendText("/clear");
        await session.waitForPane(
          clearedPaneWithoutAllowlistRules,
          TIMEOUT,
        );
        await session.sendText("/allowlist view effective");
        const inherited = await session.waitForText("user *", TIMEOUT);
        expect(inherited).toContain("● Allowlist: effective persistent allow rules:");

        await session.sendText('/allowlist add command "local-b *"');
        await session.waitForText("(scope=local)", TIMEOUT);
        await session.sendText("/allowlist view user");
        const shadowed = await session.waitForText(
          "user rules are shadowed by local settings",
          TIMEOUT,
        );
        expect(shadowed).toContain("user *");
        await session.sendText("/clear");
        await session.waitForPane(
          clearedPaneWithoutAllowlistRules,
          TIMEOUT,
        );
        await session.sendText("/allowlist view effective");
        const localEffective = await session.waitForText("local-b *", TIMEOUT);
        expect(localEffective).not.toContain("user *");

        await session.sendText('/allowlist user remove command "user *"');
        await session.waitForText("● Allowlist: removed command", TIMEOUT);
        await session.sendText("/quit");
        await session.waitForSessionEnd(TIMEOUT);
        session = null;

        const afterB = JSON.parse(
          readFileSync(join(home, ".hx", "settings.json"), "utf8"),
        );
        expect(afterB.permission).toEqual({});
        expect(afterB.workspaces[workspaceARoot].permission.bash["local-a *"]).toBe(
          "allow",
        );
        expect(afterB.workspaces[workspaceBRoot].permission.bash["local-b *"]).toBe(
          "allow",
        );
        expect(readFileSync(stderrAPath, "utf8")).toBe("");
        expect(readFileSync(stderrBPath, "utf8")).toBe("");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    90_000,
  );

  serialTest(
    "legacy output settings remain inert and output text follows prompt admission",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "fx-config-output-shadow-"));
      try {
        const home = join(root, "home");
        const workspace = join(root, "workspace");
        const stderrPath = join(root, "stderr.log");
        mkdirSync(join(home, ".hx"), { recursive: true, mode: 0o700 });
        mkdirSync(workspace);
        const workspaceRoot = realpathSync(workspace);
        const projectBytes =
          "{\"output_level\":{\"legacy\":true},\"future\":{\"keep\":true}}\n";
        writeFileSync(join(workspace, ".fx.json"), projectBytes);
        const unrelatedWorkspace = join(root, "unrelated-workspace");
        const settingsBytes =
          JSON.stringify({
            output_level: { legacy: true },
            startup_scrollback: true,
            workspaces: {
              [workspaceRoot]: {
                output_level: ["quiet", 7],
                future_workspace: { keep: true },
              },
              [unrelatedWorkspace]: {
                model: 123,
                future_workspace: { preserve: true },
              },
            },
          }) + "\n";
        writeFileSync(
          join(home, ".hx", "settings.json"),
          settingsBytes,
          { mode: 0o600 },
        );

        session = await TmuxSession.create({
          cwd: workspaceRoot,
          env: { ...NO_AUTH, HOME: home },
          stderrPath,
        });
        await session.waitForText("Run /help", TIMEOUT);
        await session.sendText("/output quiet");
        await session.waitForText("SuperGrok needs a subscription login", TIMEOUT);
        expect(composerContains(await session.capturePane(), "/output quiet")).toBe(
          true,
        );
        await session.sendKeys("C-u");
        await session.waitForPane(hasEmptyComposer, TIMEOUT);
        await session.sendText("/settings startup-scrollback off");
        await session.waitForText(
          "startup_scrollback: off (applies on next launch)",
          TIMEOUT,
        );
        await session.waitForStableComposer(TIMEOUT);
        await session.sendText("/quit");
        await session.waitForSessionEnd(TIMEOUT);
        session = null;

        const stored = JSON.parse(
          readFileSync(join(home, ".hx", "settings.json"), "utf8"),
        );
        expect(stored.output_level).toEqual({ legacy: true });
        expect(stored.startup_scrollback).toBe(false);
        expect(stored.workspaces[workspaceRoot]).toEqual({
          output_level: ["quiet", 7],
          future_workspace: { keep: true },
        });
        expect(stored.workspaces[unrelatedWorkspace]).toEqual({
          model: 123,
          future_workspace: { preserve: true },
        });
        expect(readFileSync(join(workspace, ".fx.json"), "utf8")).toBe(projectBytes);
        expect(readFileSync(stderrPath, "utf8")).toBe("");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    30_000,
  );


  serialTest(
    "Escape keeps the model picker dismissed until the model trigger restarts",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "fx-model-picker-dismissal-"));
      try {
        const home = join(root, "home");
        const workspace = join(root, "workspace");
        const stderrPath = join(root, "stderr.log");
        mkdirSync(join(home, ".hx"), { recursive: true, mode: 0o700 });
        mkdirSync(workspace);
        writeE2eXaiProviders(home);
        writeFileSync(
          join(home, ".hx", "settings.json"),
          JSON.stringify({ model: SUPERGROK_FAST_MODEL }) + "\n",
        );

        session = await TmuxSession.create({
          cwd: realpathSync(workspace),
          env: {
            ...NO_AUTH,
            HOME: home,
          },
          stderrPath,
        });
        await session.waitForText("Run /help", TIMEOUT);
        await session.sendLiteral("/model");
        await session.sendKeys("Enter");
        await session.waitForText(SUPERGROK_MODEL, TIMEOUT);

        await session.sendKeys("Escape");
        await session.waitForPane(
          (pane) =>
            composerContains(pane, "/model") &&
            !pane.includes(SUPERGROK_MODEL),
          TIMEOUT,
        );
        await session.sendLiteral("x");
        await session.waitForPane(
          (pane) =>
            composerContains(pane, "/model x") &&
            !pane.includes(SUPERGROK_MODEL),
          TIMEOUT,
        );

        await session.sendKeys("C-u");
        await session.sendLiteral("/model");
        await session.sendKeys("Enter");
        await session.waitForText(SUPERGROK_MODEL, TIMEOUT);

        await session.sendKeys("C-u");
        await session.sendText("/quit");
        await session.waitForSessionEnd(TIMEOUT);
        session = null;
        expect(readFileSync(stderrPath, "utf8")).toBe("");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    30_000,
  );

  test(
    "Fast command rejects a tag-only intrinsic Fast alias",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "fx-fast-unsupported-"));
      try {
        const home = join(root, "home");
        const workspace = join(root, "workspace");
        const stderrPath = join(root, "stderr.log");
        mkdirSync(join(home, ".hx"), { recursive: true, mode: 0o700 });
        mkdirSync(workspace);
        writeE2eXaiProviders(home);
        const settingsPath = join(home, ".hx", "settings.json");
        const initialSettings = JSON.stringify({
          model: SUPERGROK_MODEL,
          fast_mode: false,
        }) + "\n";
        writeFileSync(settingsPath, initialSettings, { mode: 0o600 });

        session = await TmuxSession.create({
          cwd: realpathSync(workspace),
          env: {
            ...NO_AUTH,
            HOME: home,
          },
          stderrPath,
        });
        await session.waitForText("Run /help", TIMEOUT);
        await session.sendText("/fast");
        const pane = await session.waitForText(
          "This model does not come with a fast mode.",
          TIMEOUT,
        );
        expect(pane).not.toContain("⚡︎");
        expect(readFileSync(settingsPath, "utf8")).toBe(initialSettings);

        await session.sendText("/quit");
        await session.waitForSessionEnd(TIMEOUT);
        session = null;
        expect(readFileSync(stderrPath, "utf8")).toBe("");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    30_000,
  );

  test(
    "settings reasoning effort changes without mutating the selected model",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "fx-settings-effort-"));
      try {
        const home = join(root, "home");
        const workspace = join(root, "workspace");
        const stderrPath = join(root, "stderr.log");
        const settingsPath = join(home, ".hx", "settings.json");
        mkdirSync(join(home, ".hx"), { recursive: true, mode: 0o700 });
        mkdirSync(workspace);
        writeE2eXaiProviders(home);
        writeFileSync(
          settingsPath,
          JSON.stringify({ model: SUPERGROK_MODEL, effort: "low" }) + "\n",
          { mode: 0o600 },
        );

        session = await TmuxSession.create({
          cwd: realpathSync(workspace),
          env: {
            ...NO_AUTH,
            HOME: home,
          },
          stderrPath,
        });
        await session.waitForText("Run /help", TIMEOUT);
        await session.sendText("/settings");
        await session.waitForText("←→ Change", TIMEOUT);
        await session.sendLiteral("reason");
        const effortSetting = await session.waitForText("Reasoning effort", TIMEOUT);
        expect(effortSetting).toContain("low");
        await session.sendKeys("Right");

        let stored = JSON.parse(readFileSync(settingsPath, "utf8"));
        const persistenceDeadline = Date.now() + TIMEOUT;
        while (stored.effort !== "medium" && Date.now() < persistenceDeadline) {
          await Bun.sleep(25);
          stored = JSON.parse(readFileSync(settingsPath, "utf8"));
        }
        expect(stored).toMatchObject({
          model: SUPERGROK_MODEL,
          effort: "medium",
        });
        expect(session.paneStatus()).toEqual({ dead: false, status: null });
        expect(await session.capturePane()).toContain("medium");

        await session.sendKeys("Escape");
        await session.waitForComposer(TIMEOUT);
        await session.sendText("/quit");
        await session.waitForSessionEnd(TIMEOUT);
        session = null;

        expect(readFileSync(stderrPath, "utf8")).toBe("");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    60_000,
  );

  test(
    "model picker selection persists when a matching skill exists",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "fx-model-picker-skill-"));
      try {
        const home = join(root, "home");
        const workspace = join(root, "workspace");
        const stderrPath = join(root, "stderr.log");
        const skillRoot = join(home, ".hx", "skills", "model-helper");
        mkdirSync(skillRoot, { recursive: true, mode: 0o700 });
        mkdirSync(workspace);
        writeE2eXaiProviders(home);
        writeFileSync(
          join(skillRoot, "SKILL.md"),
          "---\nname: model-helper\ndescription: model helper skill\n---\n\nModel helper body\n",
        );
        const workspaceRoot = realpathSync(workspace);

        session = await TmuxSession.create({
          cwd: workspaceRoot,
          env: {
            ...NO_AUTH,
            HOME: home,
          },
          stderrPath,
        });
        await session.waitForComposer(TIMEOUT);
        await session.pasteText(`/model ${SUPERGROK_FAST_MODEL} auto`);
        await session.sendKeys("Enter");
        await session.waitForText(`● Switched to ${SUPERGROK_FAST_MODEL}`, TIMEOUT);
        await session.waitForPane(
          (pane) =>
            hasEmptyComposer(pane) &&
            !pane.includes("model-helper"),
          TIMEOUT,
        );
        expect(await session.capturePane()).not.toContain("saved to user settings");

        const stored = JSON.parse(readFileSync(join(home, ".hx", "settings.json"), "utf8"));
        expect(stored.model).toBe(SUPERGROK_FAST_MODEL);
        expect(stored).not.toHaveProperty("fast_mode");

        const scrollback = await session.captureFullScrollbackEscapes();
        expect(scrollback).toContain(SUPERGROK_FAST_MODEL);
        expect(scrollback).toContain(`● Switched to ${SUPERGROK_FAST_MODEL}`);

        await session.sendText("/quit");
        await session.waitForSessionEnd(TIMEOUT);
        session = null;

        expect(readFileSync(stderrPath, "utf8")).toBe("");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    60_000,
  );

  serialTest(
    "settings persistence remains available when session storage is unavailable",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "fx-config-first-write-"));
      try {
        const home = join(root, "home");
        const workspace = join(root, "workspace");
        const stderrPath = join(root, "stderr.log");
        mkdirSync(join(home, ".hx"), { recursive: true, mode: 0o700 });
        writeFileSync(join(home, ".hx", "sessions"), "blocked\n", {
          mode: 0o600,
        });
        mkdirSync(workspace);
        const workspaceRoot = realpathSync(workspace);

        session = await TmuxSession.create({
          cwd: workspaceRoot,
          env: {
            ...NO_AUTH,
            HOME: home,
          },
          stderrPath,
        });
        await session.waitForText("Run /help", TIMEOUT);
        await session.sendText("/settings startup-scrollback off");
        await session.waitForText("startup_scrollback: off", TIMEOUT);
        await session.sendText("/quit");
        await session.waitForSessionEnd(TIMEOUT);
        session = null;

        expect(tree(home)).toEqual([
          ".hx",
          ".hx/history.jsonl",
          ".hx/history.lock",
          ".hx/sessions",
          ".hx/settings.json",
          ".hx/settings.lock",
        ]);
        expect(statSync(join(home, ".hx")).mode & 0o777).toBe(0o700);
        expect(statSync(join(home, ".hx", "history.jsonl")).mode & 0o777).toBe(0o600);
        expect(statSync(join(home, ".hx", "history.lock")).mode & 0o777).toBe(0o600);
        expect(statSync(join(home, ".hx", "settings.json")).mode & 0o777).toBe(0o600);
        expect(statSync(join(home, ".hx", "settings.lock")).mode & 0o777).toBe(0o600);
        expect(readFileSync(stderrPath, "utf8")).toBe("");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    30_000,
  );

  serialTest(
    "workspace statusline stays active when user settings cannot be saved",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "fx-statusline-write-failure-"));
      try {
        const home = join(root, "home");
        const workspace = join(root, "workspace-write-failure-visible");
        const settingsPath = join(home, ".hx", "settings.json");
        const externalSettings = join(root, "external-settings.json");
        const stderrPath = join(root, "stderr.log");
        mkdirSync(join(home, ".hx"), { recursive: true, mode: 0o700 });
        mkdirSync(workspace);
        writeFileSync(settingsPath, '{"statusLine":{"workspace":false}}\n', { mode: 0o600 });
        writeFileSync(externalSettings, '{"statusLine":{"workspace":false}}\n', { mode: 0o600 });

        session = await TmuxSession.create({
          cwd: realpathSync(workspace),
          env: { ...NO_AUTH, HOME: home },
          stderrPath,
        });
        await session.waitForText("Run /help", TIMEOUT);
        expect(await session.capturePane()).not.toContain("workspace-write-failure-visible");

        rmSync(settingsPath);
        symlinkSync(externalSettings, settingsPath);
        await session.sendText("/statusline workspace");
        await session.waitForText("active for this process but not saved to user settings", TIMEOUT);
        await session.waitForPane(
          (pane) => pane.includes("workspace-write-failure-visible"),
          TIMEOUT,
        );
        expect(JSON.parse(readFileSync(externalSettings, "utf8")).statusLine.workspace).toBe(false);

        await session.sendText("/quit");
        await session.waitForSessionEnd(TIMEOUT);
        session = null;
        expect(readFileSync(stderrPath, "utf8")).toBe("");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    30_000,
  );

  serialTest("config diagnostics preserve invalid, oversized, and unsafe primaries", async () => {
    const root = mkdtempSync(join(tmpdir(), "fx-config-diagnostics-"));
    try {
      const home = join(root, "home");
      const workspace = join(root, "workspace");
      mkdirSync(join(home, ".hx"), { recursive: true, mode: 0o700 });
      mkdirSync(workspace);
      const workspaceRoot = realpathSync(workspace);
      const settingsPath = join(home, ".hx", "settings.json");

      const malformed = "{bad\n";
      writeFileSync(settingsPath, malformed, { mode: 0o600 });
      const malformedStatus = await runFx(["status", "--json"], {
        cwd: workspaceRoot,
        env: { HOME: home },
      });
      expect(malformedStatus.code).toBe(0);
      expect(malformedStatus.stderr).toContain("malformed_settings");
      expect(readFileSync(settingsPath, "utf8")).toBe(malformed);

      const malformedStatusLine = "{\"statusLine\":{\"context\":1}}\n";
      writeFileSync(settingsPath, malformedStatusLine, { mode: 0o600 });
      const malformedStatusLineStatus = await runFx(["status", "--json"], {
        cwd: workspaceRoot,
        env: { HOME: home },
      });
      expect(malformedStatusLineStatus.code).toBe(0);
      expect(malformedStatusLineStatus.stderr).toContain("malformed_settings");
      expect(readFileSync(settingsPath, "utf8")).toBe(malformedStatusLine);

      const inertOutputSettings =
        JSON.stringify({
          output_level: { legacy: true },
          workspaces: {
            [workspaceRoot]: {
              output_level: ["quiet", 7],
            },
          },
        }) + "\n";
      writeFileSync(settingsPath, inertOutputSettings, { mode: 0o600 });
      const inertStatus = await runFx(["status", "--json"], {
        cwd: workspaceRoot,
        env: { HOME: home },
      });
      expect(inertStatus.code).toBe(0);
      expect(inertStatus.stderr).not.toContain("legacy_workspace_preferences");
      const inertDoctor = await runFx(["doctor", "--json"], {
        cwd: workspaceRoot,
        env: { HOME: home },
      });
      expect(inertDoctor.code).toBe(0);
      expect(inertDoctor.stdout).not.toContain("legacy_workspace_preferences");

      session = await TmuxSession.create({
        cwd: workspaceRoot,
        env: { ...NO_AUTH, HOME: home },
      });
      await session.waitForText("Run /help", TIMEOUT);
      expect(await session.capturePane()).not.toContain(
        "legacy_workspace_preferences",
      );
      await session.kill();
      session = null;

      expect(readFileSync(settingsPath, "utf8")).toBe(inertOutputSettings);

      const oversized = JSON.stringify({ padding: "x".repeat(65 * 1024) }) + "\n";
      writeFileSync(settingsPath, oversized, { mode: 0o600 });
      const oversizedDoctor = await runFx(["doctor", "--json"], {
        cwd: workspaceRoot,
        env: { HOME: home },
      });
      expect(oversizedDoctor.code).toBe(0);
      expect(oversizedDoctor.stdout).toContain("settings_too_large");
      expect(readFileSync(settingsPath, "utf8")).toBe(oversized);

      const external = join(root, "external-settings.json");
      writeFileSync(external, "{\"model\":\"external\"}\n", { mode: 0o600 });
      rmSync(settingsPath);
      symlinkSync(external, settingsPath);
      const unsafeStatus = await runFx(["status", "--json"], {
        cwd: workspaceRoot,
        env: { HOME: home },
      });
      expect(unsafeStatus.code).toBe(0);
      expect(unsafeStatus.stderr).toContain("durable_path_unsafe");
      expect(readFileSync(external, "utf8")).toBe("{\"model\":\"external\"}\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  serialTest(
    "concurrent global mutations preserve both values and unknown keys",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "fx-config-concurrent-"));
      try {
        const home = join(root, "home");
        const workspace = join(root, "workspace");
        mkdirSync(join(home, ".hx"), { recursive: true, mode: 0o700 });
        mkdirSync(workspace);
        const workspaceRoot = realpathSync(workspace);
        writeFileSync(
          join(home, ".hx", "settings.json"),
          JSON.stringify({
            future_global: { nested: "keep-global" },
            workspaces: {
              [workspaceRoot]: {
                future_workspace: {
                  nested: { keep: true },
                },
              },
            },
          }) + "\n",
          { mode: 0o600 },
        );
        writeFileSync(join(home, ".hx", "sessions"), "blocked\n", {
          mode: 0o600,
        });
        const env = {
          ...NO_AUTH,
          HOME: home,
        };

        [session, secondSession] = await Promise.all([
          TmuxSession.create({ cwd: workspaceRoot, env }),
          TmuxSession.create({ cwd: workspaceRoot, env }),
        ]);
        await Promise.all([
          session.waitForText("Run /help", TIMEOUT),
          secondSession.waitForText("Run /help", TIMEOUT),
        ]);
        await Promise.all([
          session.sendText("/settings startup-scrollback off"),
          secondSession.sendText("/statusline sandbox"),
        ]);
        await Promise.all([
          session.waitForText("startup_scrollback: off", TIMEOUT),
          secondSession.waitForText("● Statusline: sandbox:", TIMEOUT),
        ]);
        await Promise.all([
          session.sendText("/quit"),
          secondSession.sendText("/quit"),
        ]);
        await Promise.all([
          session.waitForSessionEnd(TIMEOUT),
          secondSession.waitForSessionEnd(TIMEOUT),
        ]);
        session = null;
        secondSession = null;

        const stored = JSON.parse(
          readFileSync(join(home, ".hx", "settings.json"), "utf8"),
        );
        expect(stored.future_global).toEqual({ nested: "keep-global" });
        expect(stored.startup_scrollback).toBe(false);
        expect(stored.statusLine).toMatchObject({ sandbox: true });
        expect(stored.workspaces[workspaceRoot]).toMatchObject({
          future_workspace: {
            nested: { keep: true },
          },
        });
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    45_000,
  );

  serialTest(
    "stale workspace mutations preserve an ordered remove and add",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "fx-workspace-concurrent-"));
      try {
        const home = join(root, "home");
        const workspace = join(root, "workspace");
        const added = join(root, "added");
        const launch = join(root, "launch");
        const stderrAPath = join(root, "stderr-a.log");
        const stderrBPath = join(root, "stderr-b.log");
        mkdirSync(join(home, ".hx"), { recursive: true, mode: 0o700 });
        mkdirSync(workspace);
        mkdirSync(added);
        mkdirSync(launch);
        const workspaceRoot = realpathSync(workspace);
        const addedRoot = realpathSync(added);
        const launchRoot = realpathSync(launch);
        const savedRoots = Array.from({ length: 15 }, (_, index) => {
          const path = join(root, `saved-${index}`);
          mkdirSync(path);
          return realpathSync(path);
        });
        writeFileSync(
          join(home, ".hx", "settings.json"),
          JSON.stringify({
            workspaces: {
              [workspaceRoot]: {
                additional_directories: savedRoots,
              },
            },
          }) + "\n",
          { mode: 0o600 },
        );
        writeFileSync(join(home, ".hx", "sessions"), "blocked\n", {
          mode: 0o600,
        });
        const env = {
          ...NO_AUTH,
          HOME: home,
        };

        [session, secondSession] = await Promise.all([
          TmuxSession.create({
            cwd: workspaceRoot,
            env,
            stderrPath: stderrAPath,
          }),
          TmuxSession.create({
            cmd: `${FX_BIN} --add-dir ${launchRoot}`,
            cwd: workspaceRoot,
            env,
            stderrPath: stderrBPath,
          }),
        ]);
        await Promise.all([
          session.waitForText("Run /help", TIMEOUT),
          secondSession.waitForText("Run /help", TIMEOUT),
        ]);

        await session.sendText(`/workspace remove ${savedRoots[0]}`);
        await session.waitForText("remove ", TIMEOUT);
        await session.waitForText("saved-14 saved=true", TIMEOUT);
        await secondSession.sendText(`/workspace add ${addedRoot}`);
        await secondSession.waitForText("add ", TIMEOUT);
        await secondSession.waitForText("launch saved=false", TIMEOUT);

        await Promise.all([
          session.sendText("/quit"),
          secondSession.sendText("/quit"),
        ]);
        await Promise.all([
          session.waitForSessionEnd(TIMEOUT),
          secondSession.waitForSessionEnd(TIMEOUT),
        ]);
        session = null;
        secondSession = null;

        const stored = JSON.parse(
          readFileSync(join(home, ".hx", "settings.json"), "utf8"),
        );
        expect(
          stored.workspaces[workspaceRoot].additional_directories,
        ).toEqual([...savedRoots.slice(1), addedRoot]);
        expect(readFileSync(stderrAPath, "utf8")).toBe("");
        expect(readFileSync(stderrBPath, "utf8")).toBe("");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    60_000,
  );

  serialTest(
    "workspace add rejects effective capacity without changing settings",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "fx-workspace-capacity-"));
      try {
        const home = join(root, "home");
        const workspace = join(root, "workspace");
        const added = join(root, "added");
        const launch = join(root, "launch");
        const stderrPath = join(root, "stderr.log");
        mkdirSync(join(home, ".hx"), { recursive: true, mode: 0o700 });
        mkdirSync(workspace);
        mkdirSync(added);
        mkdirSync(launch);
        const workspaceRoot = realpathSync(workspace);
        const addedRoot = realpathSync(added);
        const launchRoot = realpathSync(launch);
        const savedRoots = Array.from({ length: 15 }, (_, index) => {
          const path = join(root, `saved-${index}`);
          mkdirSync(path);
          return realpathSync(path);
        });
        const settingsPath = join(home, ".hx", "settings.json");
        const originalSettings =
          JSON.stringify({
            workspaces: {
              [workspaceRoot]: {
                additional_directories: savedRoots,
              },
            },
          }) + "\n";
        writeFileSync(settingsPath, originalSettings, { mode: 0o600 });
        writeFileSync(join(home, ".hx", "sessions"), "blocked\n", {
          mode: 0o600,
        });

        session = await TmuxSession.create({
          cmd: `${FX_BIN} --add-dir ${launchRoot}`,
          cwd: workspaceRoot,
          env: {
            ...NO_AUTH,
            HOME: home,
          },
          stderrPath,
        });
        await session.waitForText("Run /help", TIMEOUT);
        await session.sendText(`/workspace add ${addedRoot}`);
        await session.waitForText(
          "Workspace settings were not changed: additional directory limit reached",
          TIMEOUT,
        );
        await session.sendText("/quit");
        await session.waitForSessionEnd(TIMEOUT);
        session = null;

        expect(readFileSync(settingsPath, "utf8")).toBe(originalSettings);
        expect(readFileSync(stderrPath, "utf8")).toBe("");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    45_000,
  );

  serialTest(
    "workspace removal persists after an observed source disappears",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "fx-workspace-source-disappears-"));
      try {
        const home = join(root, "home");
        const workspace = join(root, "workspace");
        const shared = join(root, "shared");
        const savedLink = join(root, "saved-link");
        const stderrPath = join(root, "stderr.log");
        mkdirSync(join(home, ".hx"), { recursive: true, mode: 0o700 });
        mkdirSync(workspace);
        mkdirSync(shared);
        symlinkSync(shared, savedLink, "dir");
        const workspaceRoot = realpathSync(workspace);
        const settingsPath = join(home, ".hx", "settings.json");
        writeFileSync(
          settingsPath,
          JSON.stringify({
            workspaces: {
              [workspaceRoot]: { additional_directories: [savedLink] },
            },
          }) + "\n",
          { mode: 0o600 },
        );

        session = await TmuxSession.create({
          cwd: workspaceRoot,
          env: {
            ...NO_AUTH,
            HOME: home,
          },
          stderrPath,
        });
        await session.waitForText("Run /help", TIMEOUT);
        rmSync(savedLink);
        await session.sendText(`/workspace remove ${savedLink}`);
        await session.waitForText("additional directories: (none)", TIMEOUT);
        await session.sendText("/quit");
        await session.waitForSessionEnd(TIMEOUT);
        session = null;

        const stored = JSON.parse(readFileSync(settingsPath, "utf8"));
        expect(
          stored.workspaces?.[workspaceRoot]?.additional_directories,
        ).toBeUndefined();
        expect(readFileSync(stderrPath, "utf8")).toBe("");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    45_000,
  );

  serialTest(
    "workspace removal persists after an observed source retargets",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "fx-workspace-source-moves-"));
      try {
        const home = join(root, "home");
        const workspace = join(root, "workspace");
        const first = join(root, "first");
        const second = join(root, "second");
        const savedLink = join(root, "saved-link");
        const stderrPath = join(root, "stderr.log");
        mkdirSync(join(home, ".hx"), { recursive: true, mode: 0o700 });
        mkdirSync(workspace);
        mkdirSync(first);
        mkdirSync(second);
        symlinkSync(first, savedLink, "dir");
        const workspaceRoot = realpathSync(workspace);
        const firstRoot = realpathSync(first);
        const settingsPath = join(home, ".hx", "settings.json");
        writeFileSync(
          settingsPath,
          JSON.stringify({
            workspaces: {
              [workspaceRoot]: { additional_directories: [savedLink] },
            },
          }) + "\n",
          { mode: 0o600 },
        );

        session = await TmuxSession.create({
          cwd: workspaceRoot,
          env: {
            ...NO_AUTH,
            HOME: home,
          },
          stderrPath,
        });
        await session.waitForText("Run /help", TIMEOUT);
        rmSync(savedLink);
        symlinkSync(second, savedLink, "dir");
        await session.sendText(`/workspace remove ${firstRoot}`);
        await session.waitForText("additional directories: (none)", TIMEOUT);
        await session.sendText("/quit");
        await session.waitForSessionEnd(TIMEOUT);
        session = null;

        const stored = JSON.parse(readFileSync(settingsPath, "utf8"));
        expect(
          stored.workspaces?.[workspaceRoot]?.additional_directories,
        ).toBeUndefined();
        expect(readFileSync(stderrPath, "utf8")).toBe("");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    45_000,
  );

  serialTest(
    "workspace removal consumes a concurrent exact canonical replacement",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "fx-workspace-target-replaced-"));
      try {
        const home = join(root, "home");
        const workspace = join(root, "workspace");
        const target = join(root, "target");
        const unseenBefore = join(root, "unseen-before");
        const unseenAfter = join(root, "unseen-after");
        const targetLink = join(root, "target-link");
        const stderrPath = join(root, "stderr.log");
        mkdirSync(join(home, ".hx"), { recursive: true, mode: 0o700 });
        mkdirSync(workspace);
        mkdirSync(target);
        mkdirSync(unseenBefore);
        mkdirSync(unseenAfter);
        symlinkSync(target, targetLink, "dir");
        const workspaceRoot = realpathSync(workspace);
        const targetRoot = realpathSync(target);
        const unseenBeforeRoot = realpathSync(unseenBefore);
        const unseenAfterRoot = realpathSync(unseenAfter);
        const settingsPath = join(home, ".hx", "settings.json");
        writeFileSync(
          settingsPath,
          JSON.stringify({
            workspaces: {
              [workspaceRoot]: { additional_directories: [targetLink] },
            },
          }) + "\n",
          { mode: 0o600 },
        );

        session = await TmuxSession.create({
          cwd: workspaceRoot,
          env: {
            ...NO_AUTH,
            HOME: home,
          },
          stderrPath,
        });
        await session.waitForText("Run /help", TIMEOUT);
        writeFileSync(
          settingsPath,
          JSON.stringify({
            workspaces: {
              [workspaceRoot]: {
                additional_directories: [
                  unseenBeforeRoot,
                  targetRoot,
                  unseenAfterRoot,
                ],
              },
            },
          }) + "\n",
          { mode: 0o600 },
        );

        await session.sendText(`/workspace remove ${targetRoot}`);
        await session.waitForText("runtime_changed=true", TIMEOUT);
        const stored = JSON.parse(readFileSync(settingsPath, "utf8"));
        expect(stored.workspaces[workspaceRoot].additional_directories).toEqual([
          unseenBeforeRoot,
          unseenAfterRoot,
        ]);

        await session.sendText("/clear");
        await session.waitForPane(
          (pane) => hasEmptyComposer(pane) && !pane.includes(targetRoot),
          TIMEOUT,
        );
        await session.sendText("/workspace list");
        await session.waitForText(unseenBeforeRoot, TIMEOUT);
        await session.waitForText(unseenAfterRoot, TIMEOUT);
        const pane = await session.capturePaneGrid();
        expect(pane).not.toContain(targetRoot);
        await session.sendText("/quit");
        await session.waitForSessionEnd(TIMEOUT);
        session = null;

        expect(readFileSync(stderrPath, "utf8")).toBe("");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    45_000,
  );

  serialTest(
    "workspace removal prefers a concurrent canonical survivor before restart",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "fx-workspace-survivor-moves-"));
      try {
        const home = join(root, "home");
        const workspace = join(root, "workspace");
        const removed = join(root, "removed");
        const survivor = join(root, "survivor");
        const retarget = join(root, "retarget");
        const unseenBefore = join(root, "unseen-before");
        const unseenAfter = join(root, "unseen-after");
        const removedLink = join(root, "removed-link");
        const survivorLinkA = join(root, "survivor-link-a");
        const survivorLinkB = join(root, "survivor-link-b");
        const stderrAPath = join(root, "stderr-a.log");
        const stderrBPath = join(root, "stderr-b.log");
        mkdirSync(join(home, ".hx"), { recursive: true, mode: 0o700 });
        mkdirSync(workspace);
        mkdirSync(removed);
        mkdirSync(survivor);
        mkdirSync(retarget);
        mkdirSync(unseenBefore);
        mkdirSync(unseenAfter);
        symlinkSync(removed, removedLink, "dir");
        symlinkSync(survivor, survivorLinkA, "dir");
        symlinkSync(survivor, survivorLinkB, "dir");
        const workspaceRoot = realpathSync(workspace);
        const removedRoot = realpathSync(removed);
        const survivorRoot = realpathSync(survivor);
        const retargetRoot = realpathSync(retarget);
        const unseenBeforeRoot = realpathSync(unseenBefore);
        const unseenAfterRoot = realpathSync(unseenAfter);
        const settingsPath = join(home, ".hx", "settings.json");
        writeFileSync(
          settingsPath,
          JSON.stringify({
            workspaces: {
              [workspaceRoot]: {
                additional_directories: [removedLink, survivorLinkA, survivorLinkB],
              },
            },
          }) + "\n",
          { mode: 0o600 },
        );
        const env = {
          ...NO_AUTH,
          HOME: home,
        };

        session = await TmuxSession.create({
          cwd: workspaceRoot,
          env,
          stderrPath: stderrAPath,
        });
        await session.waitForText("Run /help", TIMEOUT);
        writeFileSync(
          settingsPath,
          JSON.stringify({
            workspaces: {
              [workspaceRoot]: {
                additional_directories: [
                  unseenBeforeRoot,
                  removedLink,
                  survivorLinkA,
                  survivorRoot,
                  survivorLinkB,
                  unseenAfterRoot,
                ],
              },
            },
          }) + "\n",
          { mode: 0o600 },
        );
        rmSync(survivorLinkA);
        rmSync(survivorLinkB);
        symlinkSync(retarget, survivorLinkA, "dir");
        symlinkSync(retarget, survivorLinkB, "dir");
        await session.sendText(`/workspace remove ${removedRoot}`);
        await session.waitForText("runtime_changed=true", TIMEOUT);
        await session.sendText("/quit");
        await session.waitForSessionEnd(TIMEOUT);
        session = null;

        const stored = JSON.parse(readFileSync(settingsPath, "utf8"));
        expect(stored.workspaces[workspaceRoot].additional_directories).toEqual([
          unseenBeforeRoot,
          survivorRoot,
          unseenAfterRoot,
        ]);
        rmSync(survivorLinkA);
        rmSync(survivorLinkB);

        secondSession = await TmuxSession.create({
          cwd: workspaceRoot,
          env,
          stderrPath: stderrBPath,
        });
        await secondSession.waitForText("Run /help", TIMEOUT);
        await secondSession.sendText("/workspace list");
        await secondSession.waitForText(unseenBeforeRoot, TIMEOUT);
        await secondSession.waitForText(survivorRoot, TIMEOUT);
        await secondSession.waitForText(unseenAfterRoot, TIMEOUT);
        const pane = await secondSession.capturePaneGrid();
        expect(pane).not.toContain(retargetRoot);
        await secondSession.sendText("/quit");
        await secondSession.waitForSessionEnd(TIMEOUT);
        secondSession = null;

        expect(readFileSync(stderrAPath, "utf8")).toBe("");
        expect(readFileSync(stderrBPath, "utf8")).toBe("");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    60_000,
  );

  serialTest(
    "workspace removal uses observed identity and preserves an unseen source",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "fx-workspace-source-retarget-"));
      try {
        const home = join(root, "home");
        const workspace = join(root, "workspace");
        const first = join(root, "first");
        const second = join(root, "second");
        const savedLink = join(root, "saved-link");
        const unseenLink = join(root, "unseen-link");
        const stderrPath = join(root, "stderr.log");
        mkdirSync(join(home, ".hx"), { recursive: true, mode: 0o700 });
        mkdirSync(workspace);
        mkdirSync(first);
        mkdirSync(second);
        symlinkSync(first, savedLink, "dir");
        const workspaceRoot = realpathSync(workspace);
        const firstRoot = realpathSync(first);
        const settingsPath = join(home, ".hx", "settings.json");
        writeFileSync(
          settingsPath,
          JSON.stringify({
            workspaces: {
              [workspaceRoot]: { additional_directories: [savedLink] },
            },
          }) + "\n",
          { mode: 0o600 },
        );

        session = await TmuxSession.create({
          cwd: workspaceRoot,
          env: {
            ...NO_AUTH,
            HOME: home,
          },
          stderrPath,
        });
        await session.waitForText("Run /help", TIMEOUT);

        symlinkSync(first, unseenLink, "dir");
        writeFileSync(
          settingsPath,
          JSON.stringify({
            workspaces: {
              [workspaceRoot]: {
                additional_directories: [savedLink, unseenLink],
              },
            },
          }) + "\n",
          { mode: 0o600 },
        );
        rmSync(savedLink);
        symlinkSync(second, savedLink, "dir");

        await session.sendText(`/workspace remove ${savedLink}`);
        await session.waitForText(firstRoot, TIMEOUT);
        await session.sendText("/quit");
        await session.waitForSessionEnd(TIMEOUT);
        session = null;

        const stored = JSON.parse(readFileSync(settingsPath, "utf8"));
        expect(stored.workspaces[workspaceRoot].additional_directories).toEqual([
          unseenLink,
        ]);
        expect(readFileSync(stderrPath, "utf8")).toBe("");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    45_000,
  );

  serialTest(
    "workspace add canonicalizes observed aliases before restart",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "fx-workspace-source-restart-"));
      try {
        const home = join(root, "home");
        const workspace = join(root, "workspace");
        const first = join(root, "first");
        const second = join(root, "second");
        const added = join(root, "added");
        const savedLink = join(root, "saved-link");
        const stderrAPath = join(root, "stderr-a.log");
        const stderrBPath = join(root, "stderr-b.log");
        mkdirSync(join(home, ".hx"), { recursive: true, mode: 0o700 });
        mkdirSync(workspace);
        mkdirSync(first);
        mkdirSync(second);
        mkdirSync(added);
        symlinkSync(first, savedLink, "dir");
        const workspaceRoot = realpathSync(workspace);
        const firstRoot = realpathSync(first);
        const secondRoot = realpathSync(second);
        const addedRoot = realpathSync(added);
        const settingsPath = join(home, ".hx", "settings.json");
        writeFileSync(
          settingsPath,
          JSON.stringify({
            workspaces: {
              [workspaceRoot]: {
                additional_directories: [savedLink, firstRoot],
              },
            },
          }) + "\n",
          { mode: 0o600 },
        );
        const env = {
          ...NO_AUTH,
          HOME: home,
        };

        session = await TmuxSession.create({
          cwd: workspaceRoot,
          env,
          stderrPath: stderrAPath,
        });
        await session.waitForText("Run /help", TIMEOUT);
        rmSync(savedLink);
        symlinkSync(second, savedLink, "dir");
        await session.sendText(`/workspace add ${addedRoot}`);
        await session.waitForText(addedRoot, TIMEOUT);
        await session.sendText("/quit");
        await session.waitForSessionEnd(TIMEOUT);
        session = null;

        const stored = JSON.parse(readFileSync(settingsPath, "utf8"));
        expect(stored.workspaces[workspaceRoot].additional_directories).toEqual([
          firstRoot,
          addedRoot,
        ]);
        rmSync(savedLink);

        secondSession = await TmuxSession.create({
          cwd: workspaceRoot,
          env,
          stderrPath: stderrBPath,
        });
        await secondSession.waitForText("Run /help", TIMEOUT);
        await secondSession.sendText("/workspace list");
        await secondSession.waitForText(firstRoot, TIMEOUT);
        await secondSession.waitForText(addedRoot, TIMEOUT);
        const pane = await secondSession.capturePaneGrid();
        expect(pane).not.toContain(secondRoot);
        await secondSession.sendText("/quit");
        await secondSession.waitForSessionEnd(TIMEOUT);
        secondSession = null;

        expect(readFileSync(stderrAPath, "utf8")).toBe("");
        expect(readFileSync(stderrBPath, "utf8")).toBe("");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    60_000,
  );

  serialTest(
    "workspace slash mutations persist across restart and remove cleanly",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "fx-workspace-slash-persistence-"));
      try {
        const home = join(root, "home");
        const workspace = join(root, "workspace");
        const shared = join(root, "shared project");
        const stderrAPath = join(root, "stderr-a.log");
        const stderrBPath = join(root, "stderr-b.log");
        mkdirSync(join(home, ".hx"), { recursive: true, mode: 0o700 });
        mkdirSync(workspace);
        mkdirSync(shared);
        const workspaceRoot = realpathSync(workspace);
        const sharedRoot = realpathSync(shared);
        const env = {
          ...NO_AUTH,
          HOME: home,
        };

        session = await TmuxSession.create({
          cwd: workspaceRoot,
          env,
          stderrPath: stderrAPath,
        });
        await session.waitForText("Run /help", TIMEOUT);
        await session.sendText(`/workspace add ${sharedRoot}`);
        await session.waitForPane(
          (pane) =>
            pane.replace(/\s+/g, "").includes(
              "saved_changed=trueruntime_changed=true",
            ),
          TIMEOUT,
        );
        await session.sendText("/quit");
        await session.waitForSessionEnd(TIMEOUT);
        session = null;

        const stored = JSON.parse(
          readFileSync(join(home, ".hx", "settings.json"), "utf8"),
        );
        expect(stored.workspaces[workspaceRoot].additional_directories).toEqual([
          sharedRoot,
        ]);

        secondSession = await TmuxSession.create({
          cwd: workspaceRoot,
          env,
          stderrPath: stderrBPath,
        });
        await secondSession.waitForText("Run /help", TIMEOUT);
        await secondSession.sendText("/workspace list");
        await secondSession.waitForText(sharedRoot, TIMEOUT);
        await secondSession.waitForPane(
          (pane) => pane.replaceAll("\n", "").includes("active=true"),
          TIMEOUT,
        );
        await secondSession.sendText(`/workspace remove ${sharedRoot}`);
        await secondSession.waitForText("additional directories: (none)", TIMEOUT);
        await secondSession.sendText("/quit");
        await secondSession.waitForSessionEnd(TIMEOUT);
        secondSession = null;

        const cleared = JSON.parse(
          readFileSync(join(home, ".hx", "settings.json"), "utf8"),
        );
        expect(cleared.workspaces?.[workspaceRoot]?.additional_directories).toBeUndefined();
        expect(readFileSync(stderrAPath, "utf8")).toBe("");
        expect(readFileSync(stderrBPath, "utf8")).toBe("");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    60_000,
  );

  serialTest(
    "workspace list marks a directory deleted during the session unavailable",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "fx-workspace-live-availability-"));
      try {
        const home = join(root, "home");
        const workspace = join(root, "workspace");
        const shared = join(root, "shared");
        const stderrPath = join(root, "stderr.log");
        mkdirSync(join(home, ".hx"), { recursive: true, mode: 0o700 });
        mkdirSync(workspace);
        mkdirSync(shared);
        const workspaceRoot = realpathSync(workspace);
        const sharedRoot = realpathSync(shared);
        const env = {
          ...NO_AUTH,
          HOME: home,
        };

        session = await TmuxSession.create({
          cwd: workspaceRoot,
          env,
          stderrPath,
        });
        await session.waitForText("Run /help", TIMEOUT);
        await session.sendText(`/workspace add ${sharedRoot}`);
        await session.waitForPane(
          (pane) =>
            pane.replace(/\s+/g, "").includes(
              `${sharedRoot}saved=truecommand_line=falseavailable=trueactive=true`,
            ),
          TIMEOUT,
        );

        rmSync(sharedRoot, { recursive: true });
        await session.sendText("/workspace list");
        await session.waitForPane(
          (pane) =>
            pane.replace(/\s+/g, "").includes(
              `${sharedRoot}saved=truecommand_line=falseavailable=falseactive=false`,
            ),
          TIMEOUT,
        );
        const scrollback = await session.captureFullScrollback();
        expect(scrollback.replace(/\s+/g, "")).toContain(
          `${sharedRoot}saved=truecommand_line=falseavailable=falseactive=false`,
        );

        await session.sendText("/quit");
        await session.waitForSessionEnd(TIMEOUT);
        session = null;
        expect(readFileSync(stderrPath, "utf8")).toBe("");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    60_000,
  );

  serialTest(
    "workspace list restores canonical access through a new symlinked ancestor",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "fx-workspace-restored-canonical-"));
      try {
        const home = join(root, "home");
        const workspace = join(root, "workspace");
        const realParent = join(root, "real-parent");
        const shared = join(realParent, "shared");
        const parentLink = join(root, "parent-link");
        const source = join(parentLink, "shared");
        const stderrPath = join(root, "stderr.log");
        const fixture = "RESTORED_CANONICAL_ROOT_FIXTURE";
        const instructionSentinel = "RESTORED_ROOT_AGENTS_MUST_NOT_LOAD";
        mkdirSync(join(home, ".hx"), { recursive: true, mode: 0o700 });
        mkdirSync(workspace);
        mkdirSync(shared, { recursive: true });
        writeFileSync(join(shared, "fixture.txt"), `${fixture}\n`);
        writeFileSync(join(shared, "AGENTS.md"), `${instructionSentinel}\n`);
        const workspaceRoot = realpathSync(workspace);
        const sharedRoot = realpathSync(shared);
        writeFileSync(
          join(home, ".hx", "settings.json"),
          JSON.stringify({
            sandbox: "none",
            permission_mode: "auto",
            permission: {},
            workspaces: {
              [workspaceRoot]: { additional_directories: [source] },
            },
          }),
        );

        const gateway = startFakeGateway([
          fakeGatewayToolCall("restored-root-read", "read_file", {
            path: join(source, "fixture.txt"),
            line_count: 10,
          }),
          fakeGatewayFinalText("RESTORED_CANONICAL_ROOT_COMPLETE"),
        ]);
        try {
          session = await TmuxSession.create({
            cwd: workspaceRoot,
            env: {
              HOME: home,
              ANTHROPIC_API_KEY: "fake-restored-root-key",
              FX_AUTO_UPGRADE: "0",
              ANTHROPIC_BASE_URL: gateway.baseUrl,
              GROK_CLI_CHAT_PROXY_BASE_URL: `${gateway.baseUrl}/v1`,
              FX_MODEL: FAKE_GATEWAY_MODEL,
            },
            stderrPath,
          });
          await session.waitForText("Run /help", TIMEOUT);

          symlinkSync(realParent, parentLink, "dir");
          await session.sendText("/workspace list");
          await session.waitForPane(
            (pane) =>
              pane.replace(/\s+/g, "").includes(
                `${sharedRoot}saved=truecommand_line=falseavailable=trueactive=true`,
              ),
            TIMEOUT,
          );

          await session.sendText("Read the restored workspace fixture once.");
          await session.waitForText("RESTORED_CANONICAL_ROOT_COMPLETE", TIMEOUT);
          expect(gateway.requests).toHaveLength(2);
          for (const request of gateway.requests) {
            expect(request.body).not.toContain(instructionSentinel);
            expect(request.body).not.toContain("target outside workspace");
            expect(request.body).not.toContain("Not executed");
          }
          expect(gateway.requests[1]!.body).toContain(fixture);
          expect(readFileSync(stderrPath, "utf8")).toBe("");
          expect(session.isAlive()).toBe(true);
          expect(session.isPaneAlive()).toBe(true);

          await session.sendText("/quit");
          await session.waitForSessionEnd(TIMEOUT);
          session = null;
        } finally {
          gateway.stop();
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    60_000,
  );

  serialTest(
    "workspace slash removal explains launch restoration and uses friendly errors",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "fx-workspace-launch-removal-"));
      try {
        const home = join(root, "home");
        const workspace = join(root, "workspace");
        const shared = join(root, "shared");
        const unknown = join(root, "unknown");
        const stderrPath = join(root, "stderr.log");
        mkdirSync(join(home, ".hx"), { recursive: true, mode: 0o700 });
        mkdirSync(workspace);
        mkdirSync(shared);
        mkdirSync(unknown);
        const workspaceRoot = realpathSync(workspace);
        const sharedRoot = realpathSync(shared);
        const unknownRoot = realpathSync(unknown);
        const env = {
          ...NO_AUTH,
          HOME: home,
        };

        session = await TmuxSession.create({
          cmd: `${FX_BIN} --add-dir ${sharedRoot}`,
          cwd: workspaceRoot,
          env,
          stderrPath,
        });
        await session.waitForText("Run /help", TIMEOUT);
        await session.sendText(`/workspace remove ${unknownRoot}`);
        await session.waitForText(
          "Workspace update rejected: directory is not configured as an additional workspace",
          TIMEOUT,
        );
        await session.sendText(`/workspace remove ${workspaceRoot}`);
        await session.waitForText(
          "the primary workspace cannot be added or removed",
          TIMEOUT,
        );
        let pane = await session.capturePaneGrid();
        expect(pane).not.toContain("PrimaryDirectory");

        await session.sendText(`/workspace remove ${sharedRoot}`);
        await session.waitForPane(
          (pane) =>
            pane.replaceAll("\n", "").includes("launch_flag_can_restore=true"),
          TIMEOUT,
        );
        await session.waitForText(
          "warning: repeating --add-dir can restore removed access on the next launch",
          TIMEOUT,
        );
        await session.waitForText("additional directories: (none)", TIMEOUT);
        pane = await session.capturePaneGrid();
        expect(pane).not.toContain("PrimaryDirectory");

        await session.sendText("/quit");
        await session.waitForSessionEnd(TIMEOUT);
        session = null;

        const settingsPath = join(home, ".hx", "settings.json");
        if (statSync(settingsPath, { throwIfNoEntry: false })) {
          const stored = JSON.parse(readFileSync(settingsPath, "utf8"));
          expect(
            stored.workspaces?.[workspaceRoot]?.additional_directories,
          ).toBeUndefined();
        }
        expect(readFileSync(stderrPath, "utf8")).toBe("");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    45_000,
  );
});
