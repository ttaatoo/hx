import { afterEach, describe, expect, test } from "bun:test";
import {
  execFileSync,
  spawn as nodeSpawn,
  type ChildProcess,
} from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FX_BIN, runFx } from "../evals/eval-helpers";
import { adaptRetiredGatewayTestEnv, writeE2eGrokAuth } from "./direct-provider-env";
import {
  classifierEvidenceFromRequest,
  completionResponseForPath,
  fakeGatewayPermissionDecision,
  fakeGatewaySse,
  heldFakeGatewayFinalText,
  isVolatileTokenStatusRow,
  startDynamicFakeGateway,
  toolResultOutputFromBody,
  TmuxSession,
  tmuxAvailable,
} from "./tmux-helpers";

const TIMEOUT = 30_000;
const MODEL = "grok-4.6";
const COMMAND_APPROVAL_PROMPT = "Would you like to run the following command?";
const MANAGE_SUBAGENT_PROGRESS = "Managing subagent\n";

type GatewayRequest = {
  body: string;
  headers: Headers;
};

type IsolatedRoot = {
  root: string;
  home: string;
  workspace: string;
  hostileBin: string;
  profileMarker: string;
  commandMarkers: Record<string, string>;
};

type TerminalFixtureState = {
  pid: number;
  pgid: number;
  sid: number;
  tty_opened: boolean;
  tty_errno: number | null;
  tcsetpgrp_attempted: boolean;
  tcsetpgrp_succeeded: boolean;
};

type TerminalProcessRow = {
  pid: number;
  pgid: number;
  tpgid: number;
  stat: string;
  command: string;
};

const roots: string[] = [];
const gateways: Array<{ stop(): void }> = [];
const heldResponses: Array<ReturnType<typeof heldFakeGatewayFinalText>> = [];
let activeSession: TmuxSession | null = null;
let activeClient: AcpClient | null = null;

function heldFinalText() {
  const response = heldFakeGatewayFinalText();
  heldResponses.push(response);
  return response;
}

afterEach(async () => {
  for (const response of heldResponses.splice(0)) response.dispose();
  if (activeSession) {
    await activeSession.kill();
    activeSession = null;
  }
  if (activeClient) {
    await activeClient.close();
    activeClient = null;
  }
  for (const gateway of gateways.splice(0)) gateway.stop();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function sse(events: object[]) {
  return fakeGatewaySse(events);
}

function gatewayToolCall(toolName: string, input: object, toolCallId: string) {
  return sse([
    {
      type: "tool-call",
      toolCallId,
      toolName,
      input,
    },
    {
      type: "finish",
      finishReason: { unified: "tool-calls", raw: "tool-calls" },
    },
  ]);
}

function toolCall(
  command: string,
  options: Record<string, unknown> = {},
  toolCallId = "command_1",
) {
  return gatewayToolCall("terminal", { action: "exec", command, ...options }, toolCallId);
}

function permissionDecision(
  decision: "allow" | "ask" = "allow",
  toolCallId = "permission_decision_1",
) {
  return fakeGatewayPermissionDecision(decision, toolCallId, "deterministic test decision");
}

function classifierTrustContext(body: string): string {
  const evidence = classifierEvidenceFromRequest(body);
  const startMarker = "review_origin: ";
  const endMarker = "Normalized action evidence";
  const start = evidence.indexOf(startMarker);
  const end = evidence.indexOf(endMarker, start);
  if (start < 0 || end < 0) throw new Error("classifier trust context missing");
  return evidence.slice(start, end);
}

function subagentCreateCall(
  toolCallId: string,
  prompt: string,
  mode: "one_off" | "persistent" = "one_off",
) {
  return gatewayToolCall("subagent", {
    command: {
      create: {
        name: "bounded-child",
        mode,
        prompt,
      },
    },
  }, toolCallId);
}

function subagentInspectCall(toolCallId: string, childId: string) {
  return gatewayToolCall("subagent", {
    command: {
      inspect: {
        id: childId,
        sections: ["status", "configuration", "relationship"],
      },
    },
  }, toolCallId);
}

function toolCalls(command: string, callIds: string[]) {
  return sse([
    ...callIds.map((toolCallId) => ({
      type: "tool-call",
      toolCallId,
      toolName: "terminal",
      input: { action: "exec", command },
    })),
    {
      type: "finish",
      finishReason: { unified: "tool-calls", raw: "tool-calls" },
    },
  ]);
}

function twoEffectfulCommandBatch(first: string, second: string) {
  return sse([
    {
      type: "tool-call",
      toolCallId: "history_feedback_first",
      toolName: "terminal",
      input: { action: "exec", command: first },
    },
    {
      type: "tool-call",
      toolCallId: "history_feedback_second",
      toolName: "terminal",
      input: { action: "exec", command: second },
    },
    {
      type: "finish",
      finishReason: { unified: "tool-calls", raw: "tool-calls" },
    },
  ]);
}

function sessionIdFromHome(root: IsolatedRoot): string {
  const sessions = join(root.home, ".fx", "sessions");
  const ids = readdirSync(sessions, { withFileTypes: true })
    .filter((entry) => entry.name !== "latest" && entry.isDirectory())
    .map((entry) => entry.name);
  expect(ids).toHaveLength(1);
  return ids[0]!;
}

function latestTraceReportPath(root: IsolatedRoot): string {
  const reports = readdirSync(root.root)
    .filter((entry) => entry.startsWith("fx-trace-") && entry.endsWith(".md"))
    .map((entry) => {
      const path = join(root.root, entry);
      return { path, mtimeMs: statSync(path).mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  expect(reports.length).toBeGreaterThan(0);
  return reports[0]!.path;
}

function expectGroupedContinuationRequest(
  body: string,
  feedback: string,
) {
  const first = body.indexOf("first command completed");
  const second = body.indexOf("second command completed");
  const amendment = body.indexOf(feedback);
  expect(first).toBeGreaterThanOrEqual(0);
  expect(second).toBeGreaterThan(first);
  expect(amendment).toBeGreaterThan(second);
}

function requestMessages(body: string): Array<{
  role?: string;
  content?: unknown;
  tool_call_id?: string;
}> {
  const request = JSON.parse(body) as {
    prompt?: Array<{ role?: string; content?: unknown; tool_call_id?: string }>;
    messages?: Array<{ role?: string; content?: unknown; tool_call_id?: string }>;
  };
  return request.messages ?? request.prompt ?? [];
}

function toolResultText(body: string, toolCallId: string): string {
  const messages = requestMessages(body);
  const parts = messages.flatMap((message) =>
    Array.isArray(message.content) ? message.content : []
  ) as Array<Record<string, unknown>>;
  const result = parts.find((part) =>
    (part.type === "tool-result" && part.toolCallId === toolCallId) ||
    (part.type === "tool_result" && part.tool_use_id === toolCallId)
  );
  if (result) {
    const output = result.output as Record<string, unknown> | undefined;
    if (typeof output?.value === "string") return output.value;
    return contentText(result.content ?? result.output);
  }
  const toolMessage = messages.find((message) =>
    message.role === "tool" && message.tool_call_id === toolCallId
  );
  if (!toolMessage) throw new Error(`Missing tool result for ${toolCallId}`);
  return contentText(toolMessage.content);
}

function hasToolResult(body: string, toolCallId: string): boolean {
  try {
    return toolResultText(body, toolCallId).length >= 0;
  } catch {
    return false;
  }
}

function expectOrdinaryToolResults(body: string, callIds: string[]) {
  const results = callIds.map((id) => toolResultText(body, id));
  expect(results).toHaveLength(callIds.length);
  for (const result of results) {
    expect(result).toEqual(expect.stringContaining("exit_code=0"));
  }
  expect(results.join("\n")).not.toContain("Repeated identical tool call blocked");
}

function completedToolCallIds(body: string): string[] {
  const messages = requestMessages(body);
  const ids: string[] = [];
  for (const message of messages) {
    if (message.role === "tool" && typeof message.tool_call_id === "string") {
      ids.push(message.tool_call_id);
      continue;
    }
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content as Array<Record<string, unknown>>) {
      if (part.type === "tool-result" && typeof part.toolCallId === "string") {
        ids.push(part.toolCallId);
      } else if (part.type === "tool_result" && typeof part.tool_use_id === "string") {
        ids.push(part.tool_use_id);
      }
    }
  }
  return ids;
}

function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(contentText).join("");
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return [
      contentText(object.text),
      contentText(object.value),
      contentText(object.content),
      contentText(object.output),
    ].join("");
  }
  return "";
}

function promptText(body: string): string {
  return requestMessages(body).map((message) => contentText(message.content)).join("\n");
}

function latestPromptText(body: string): string {
  return contentText(requestMessages(body).at(-1)?.content);
}

function currentUserText(body: string): string {
  return contentText(
    requestMessages(body).findLast((message) => message.role === "user")?.content,
  );
}

function occurrenceCount(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

function expectNoParentDeliveries(body: string) {
  expect(promptText(body)).not.toContain("<subagent_deliveries");
}

function parentDeliveryEnvelope(text: string): string {
  const start = text.indexOf("<subagent_deliveries");
  expect(start).toBeGreaterThanOrEqual(0);
  const end = text.indexOf("</subagent_deliveries>", start);
  expect(end).toBeGreaterThanOrEqual(start);
  return text.slice(start, end + "</subagent_deliveries>".length);
}

function parentDeliveryIds(body: string): string[] {
  const text = promptText(body);
  if (!text.includes("<subagent_deliveries")) return [];
  return parentDeliveryEnvelope(text)
    .split("\n")
    .filter((line) => line.startsWith("- "))
    .map((line) =>
      String((JSON.parse(line.slice(2)) as { id?: unknown }).id ?? "")
    );
}

function persistedPayloadText(payload: unknown): string {
  if (!payload || typeof payload !== "object") return JSON.stringify(payload);
  const message = (payload as { message?: unknown }).message;
  if (!message || typeof message !== "object") return JSON.stringify(payload);
  const wire = message as { encoding?: unknown; data?: unknown };
  if (wire.encoding !== "base64" || typeof wire.data !== "string") {
    return JSON.stringify(payload);
  }
  return Buffer.from(wire.data, "base64").toString("utf8");
}

function findPersistedDeliveryIds(
  root: IsolatedRoot,
  childId: string,
  payload: string,
): string[] {
  const path = join(root.home, ".fx", "sessions", childId, "subagent", "communication.json");
  if (!existsSync(path)) return [];
  const record = JSON.parse(readFileSync(
    path,
    "utf8",
  )) as {
    ledger: {
      deliveries: Array<{ id: string; payload?: unknown }>;
    };
  };
  return record.ledger.deliveries
    .filter((item) => persistedPayloadText(item.payload ?? item).includes(payload))
    .map((item) => item.id);
}

function findPersistedDeliveryId(
  root: IsolatedRoot,
  childId: string,
  payload: string,
): string | null {
  const matches = findPersistedDeliveryIds(root, childId, payload);
  if (matches.length > 1) {
    throw new Error(`Expected one persisted delivery child=${childId} payload=${payload}`);
  }
  return matches[0] ?? null;
}

async function waitForPersistedDeliveryId(
  root: IsolatedRoot,
  childId: string,
  payload: string,
): Promise<string> {
  const deadline = Date.now() + TIMEOUT;
  while (Date.now() < deadline) {
    const id = findPersistedDeliveryId(root, childId, payload);
    if (id) return id;
    await Bun.sleep(20);
  }
  throw new Error(`Timed out waiting for persisted delivery child=${childId} payload=${payload}`);
}

async function waitForPersistedDeliveryIds(
  root: IsolatedRoot,
  childId: string,
  payload: string,
): Promise<string[]> {
  const deadline = Date.now() + TIMEOUT;
  while (Date.now() < deadline) {
    const ids = findPersistedDeliveryIds(root, childId, payload);
    if (ids.length > 0) return ids;
    await Bun.sleep(20);
  }
  throw new Error(`Timed out waiting for persisted delivery child=${childId} payload=${payload}`);
}

type PendingSubagentApproval = {
  id: string;
  label: string;
  rootId: string;
  workId: string;
};

async function waitForPendingSubagentApproval(
  root: IsolatedRoot,
  childId: string,
): Promise<PendingSubagentApproval> {
  const id = await waitForPersistedDeliveryId(
    root,
    childId,
    "terminal.exec /usr/bin/touch",
  );
  const communicationPath = join(
    root.home,
    ".fx",
    "sessions",
    childId,
    "subagent",
    "communication.json",
  );
  const stored = JSON.parse(readFileSync(communicationPath, "utf8")) as {
    ledger: { approvals: Array<Record<string, unknown>> };
  };
  const approval = stored.ledger.approvals.find((entry) => entry.id === id);
  if (!approval) throw new Error(`Missing approval child=${childId} id=${id}`);
  return {
    id,
    label: String(approval.label ?? ""),
    rootId: String(approval.root_id ?? ""),
    workId: String(approval.work_id ?? ""),
  };
}

async function waitForTraceSlice(
  tracePath: string,
  offset: number,
  label: string,
  predicate: (trace: string) => boolean,
  timeoutMs = TIMEOUT,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let trace = "";
  while (Date.now() < deadline) {
    if (existsSync(tracePath)) {
      trace = readFileSync(tracePath, "utf8").slice(offset);
    }
    if (predicate(trace)) return trace;
    await Bun.sleep(25);
  }
  throw new Error(`Timed out waiting for ${label}.\nTrace:\n${trace}`);
}

function subagentState(root: IsolatedRoot, childId: string): string | null {
  const path = join(root.home, ".fx", "sessions", childId, "subagent", "control.json");
  if (!existsSync(path)) return null;
  const record = JSON.parse(readFileSync(path, "utf8")) as { state?: string };
  return record.state ?? null;
}

async function waitForSubagentIdle(root: IsolatedRoot, childId: string): Promise<void> {
  const deadline = Date.now() + TIMEOUT;
  while (Date.now() < deadline) {
    if (subagentState(root, childId) === "idle") return;
    await Bun.sleep(20);
  }
  throw new Error(`Timed out waiting for child idle child=${childId} state=${subagentState(root, childId)}`);
}

async function waitForSubagentIdleOrInterruptedAfterHostExit(
  root: IsolatedRoot,
  childId: string,
): Promise<void> {
  const deadline = Date.now() + TIMEOUT;
  let state = subagentState(root, childId);
  while (Date.now() < deadline) {
    if (state === "idle" || state === "interrupted") return;
    await Bun.sleep(20);
    state = subagentState(root, childId);
  }
  throw new Error(
    `Timed out waiting for child idle or interrupted after host exit child=${childId} state=${state}`,
  );
}

function expectParentDelivery(
  body: string,
  childId: string,
  eventId: string,
  payload: string,
) {
  const text = promptText(body);
  expect(occurrenceCount(text, "<subagent_deliveries")).toBe(1);
  const envelope = parentDeliveryEnvelope(text);
  expect(envelope).toContain(`"source_id":"${childId}"`);
  expect(occurrenceCount(envelope, `"id":"${eventId}"`)).toBe(1);
  expect(envelope).toContain(payload);
}

function expectParentDeliveries(
  body: string,
  childId: string,
  eventIds: string[],
  payload: string,
) {
  const text = promptText(body);
  expect(occurrenceCount(text, "<subagent_deliveries")).toBe(1);
  const envelope = parentDeliveryEnvelope(text);
  expect(eventIds.length).toBeGreaterThan(0);
  expect(envelope.split("\n").filter((line) => line.startsWith("- "))).toHaveLength(
    eventIds.length,
  );
  for (const eventId of eventIds) {
    expect(occurrenceCount(envelope, `"id":"${eventId}"`)).toBe(1);
  }
  expect(occurrenceCount(envelope, `"source_id":"${childId}"`)).toBe(eventIds.length);
  expect(occurrenceCount(envelope, payload)).toBe(eventIds.length);
}

function expectParentDeliveriesOrNone(
  body: string,
  childId: string,
  eventIds: string[],
  payload: string,
) {
  if (eventIds.length > 0) {
    expectParentDeliveries(body, childId, eventIds, payload);
  } else {
    expectNoParentDeliveries(body);
  }
}

function expectOrderedParentDeliveries(
  body: string,
  childId: string,
  expected: Array<{ eventId: string; payload: string }>,
) {
  const text = promptText(body);
  expect(occurrenceCount(text, "<subagent_deliveries")).toBe(1);
  const envelope = parentDeliveryEnvelope(text);
  let offset = 0;
  for (const delivery of expected) {
    expect(occurrenceCount(envelope, `"id":"${delivery.eventId}"`)).toBe(1);
    const index = envelope.indexOf(`"id":"${delivery.eventId}"`, offset);
    expect(index).toBeGreaterThanOrEqual(offset);
    const lineEnd = envelope.indexOf("\n", index);
    expect(envelope.slice(index, lineEnd)).toContain(`"source_id":"${childId}"`);
    expect(envelope.slice(index, lineEnd)).toContain(delivery.payload);
    offset = lineEnd;
  }
}

type ParentMessagePart = {
  logical_message_id: string;
  offset: number;
  end_offset: number;
  total_bytes: number;
  more: boolean;
  content: string;
};

function parentMessagePart(
  body: string,
  childId: string,
  eventId: string,
): ParentMessagePart {
  const text = promptText(body);
  expect(occurrenceCount(text, "<subagent_deliveries")).toBe(1);
  const envelope = parentDeliveryEnvelope(text);
  const line = envelope.split("\n").find((value) => value.startsWith("- "));
  expect(line).toBeDefined();
  const delivery = JSON.parse(line!.slice(2)) as {
    id: string;
    source_id: string;
    payload: { message: ParentMessagePart };
  };
  expect(delivery.id).toBe(eventId);
  expect(delivery.source_id).toBe(childId);
  expect(delivery.payload.message.logical_message_id).toBe(eventId);
  expect(Buffer.byteLength(delivery.payload.message.content, "utf8")).toBe(
    delivery.payload.message.end_offset - delivery.payload.message.offset,
  );
  expect(delivery.payload.message.more).toBe(
    delivery.payload.message.end_offset < delivery.payload.message.total_bytes,
  );
  return delivery.payload.message;
}

function sessionIds(root: IsolatedRoot): string[] {
  const sessions = join(root.home, ".fx", "sessions");
  return readdirSync(sessions)
    .filter((id) =>
      id !== "latest" &&
      statSync(join(sessions, id)).isDirectory()
    )
    .sort();
}

function onlyParentSessionId(root: IsolatedRoot, excludedIds: string[]): string {
  const excluded = new Set(excludedIds);
  const parents = sessionIds(root).filter((id) => !excluded.has(id));
  expect(parents).toHaveLength(1);
  return parents[0]!;
}

function expectParentHistoryClean(
  root: IsolatedRoot,
  parentSessionId: string,
  forbidden: string[],
) {
  const sessionDir = join(root.home, ".fx", "sessions", parentSessionId);
  for (const name of ["session.json", "events.jsonl"]) {
    const path = join(sessionDir, name);
    if (!existsSync(path)) continue;
    const text = readFileSync(path, "utf8");
    expect(text).not.toContain("<subagent_deliveries");
    for (const marker of forbidden) expect(text).not.toContain(marker);
  }
}

function expectHumanUnreadIndependent(
  root: IsolatedRoot,
  childId: string,
  eventId: string,
) {
  const record = JSON.parse(readFileSync(
    join(root.home, ".fx", "sessions", childId, "subagent", "communication.json"),
    "utf8",
  )) as {
    ledger: {
      deliveries: Array<{ id: string; sequence: number }>;
      cursors: Array<{
        consumer_id: string;
        target_id: string;
        projection?: string;
        acknowledged_sequence: number;
      }>;
    };
  };
  const delivery = record.ledger.deliveries.find((item) => item.id === eventId);
  expect(delivery).toBeDefined();
  const modelCursor = record.ledger.cursors.find((cursor) =>
    cursor.consumer_id === "parent-model" && cursor.projection === "parent_turn"
  );
  expect(modelCursor).toBeDefined();
  expect(modelCursor!.acknowledged_sequence).toBeGreaterThanOrEqual(delivery!.sequence);
  expect(record.ledger.cursors.some((cursor) => cursor.consumer_id === "human")).toBe(false);
}

function finalText(text: string) {
  return sse([
    { type: "text-delta", id: "answer_1", delta: text },
    {
      type: "finish",
      finishReason: { unified: "stop", raw: "stop" },
      usage: {
        inputTokens: { total: 3 },
        outputTokens: { total: 5 },
      },
    },
  ]);
}

function startFakeGateway(
  responses: Array<Response | ((body: string) => Response | Promise<Response>)>,
  options: {
    classifierDecision?: "allow" | "ask";
    classifierResponses?: Array<Response | (() => Response | Promise<Response>)>;
  } = {},
) {
  const requests: GatewayRequest[] = [];
  const classifierRequests: GatewayRequest[] = [];
  const classifierResponses = [...(options.classifierResponses ?? [])];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/v1/models") {
        return Response.json({
          data: [{ id: MODEL, type: "language", tags: ["tool-use"] }],
        });
      }
      if (req.method !== "POST") return new Response("not found", { status: 404 });
      const body = await req.text();
      if (body.includes("\"permission_decision\"")) {
        classifierRequests.push({ body, headers: req.headers });
        const classifierResponse = classifierResponses.shift();
        if (classifierResponse) {
          return typeof classifierResponse === "function"
            ? await classifierResponse()
            : classifierResponse;
        }
        return permissionDecision(options.classifierDecision ?? "allow");
      }
      requests.push({ body, headers: req.headers });
      const response = responses.shift();
      if (!response) return new Response("unexpected request", { status: 500 });
      const resolved = typeof response === "function" ? await response(body) : response;
      return completionResponseForPath(url.pathname, resolved);
    },
  });
  const gateway = {
    baseUrl: `http://127.0.0.1:${server.port}`,
    chatUrl: `http://127.0.0.1:${server.port}/v3/ai/language-model`,
    requests,
    classifierRequests,
    stop() {
      server.stop(true);
    },
  };
  gateways.push(gateway);
  return gateway;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function writeTerminalOwnershipFixture(path: string) {
  writeFileSync(path, `#!/usr/bin/env python3
import json
import os
import signal
import sys
import time

state_path = sys.argv[1]
release_path = sys.argv[2]
tty_fd = None
state = {
    "pid": os.getpid(),
    "pgid": os.getpgrp(),
    "sid": os.getsid(0),
    "tty_opened": False,
    "tty_errno": None,
    "tcsetpgrp_attempted": False,
    "tcsetpgrp_succeeded": False,
}

try:
    tty_fd = os.open("/dev/tty", os.O_RDWR)
    state["tty_opened"] = True
    signal.signal(signal.SIGTTOU, signal.SIG_IGN)
    state["tcsetpgrp_attempted"] = True
    os.tcsetpgrp(tty_fd, state["pgid"])
    state["tcsetpgrp_succeeded"] = True
except OSError as error:
    state["tty_errno"] = error.errno
finally:
    if tty_fd is not None:
        os.close(tty_fd)

pending_path = state_path + ".pending"
with open(pending_path, "w", encoding="utf-8") as handle:
    json.dump(state, handle, sort_keys=True)
    handle.flush()
    os.fsync(handle.fileno())
os.replace(pending_path, state_path)

print("TTY_SESSION_STDOUT_BEGIN", flush=True)
print("TTY_SESSION_STDERR", file=sys.stderr, flush=True)
deadline = time.monotonic() + 20
while not os.path.exists(release_path) and time.monotonic() < deadline:
    time.sleep(0.02)
if not os.path.exists(release_path):
    sys.exit(124)
print("TTY_SESSION_STDOUT_END", flush=True)
`);
  chmodSync(path, 0o755);
}

async function waitForTerminalFixture(path: string): Promise<TerminalFixtureState> {
  const deadline = Date.now() + TIMEOUT;
  while (Date.now() < deadline) {
    if (existsSync(path)) {
      try {
        return JSON.parse(readFileSync(path, "utf8")) as TerminalFixtureState;
      } catch {}
    }
    await Bun.sleep(20);
  }
  throw new Error(`Timed out waiting for terminal fixture state at ${path}`);
}

async function waitForPath(path: string): Promise<void> {
  const deadline = Date.now() + TIMEOUT;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    await Bun.sleep(20);
  }
  throw new Error(`Timed out waiting for path at ${path}`);
}

async function waitForGatewayRequestCount(
  gateway: { requests: GatewayRequest[] },
  count: number,
): Promise<void> {
  const deadline = Date.now() + TIMEOUT;
  while (Date.now() < deadline) {
    if (gateway.requests.length >= count) return;
    await Bun.sleep(20);
  }
  throw new Error(`Timed out waiting for ${count} Gateway requests`);
}

function paneTty(session: TmuxSession): string {
  return execFileSync(
    "tmux",
    ["display-message", "-t", session.name, "-p", "#{pane_tty}"],
    { encoding: "utf8" },
  ).trim();
}

function terminalProcessRows(ttyPath: string): TerminalProcessRow[] {
  const tty = ttyPath.replace(/^\/dev\//, "");
  let output = "";
  try {
    output = execFileSync(
      "ps",
      ["-t", tty, "-o", "pid=,pgid=,tpgid=,stat=,command="],
      { encoding: "utf8" },
    );
  } catch (error: any) {
    output = error?.stdout?.toString?.() ?? "";
  }
  return output.split("\n").flatMap((line) => {
    const match = line.match(
      /^\s*(\d+)\s+(-?\d+)\s+(-?\d+)\s+(\S+)\s+(.*)$/,
    );
    if (!match) return [];
    return [{
      pid: Number(match[1]),
      pgid: Number(match[2]),
      tpgid: Number(match[3]),
      stat: match[4]!,
      command: match[5]!,
    }];
  });
}

function foregroundFxRow(
  ttyPath: string,
  binary: string,
): TerminalProcessRow & { sid: number } {
  const row = terminalProcessRows(ttyPath).find((entry) =>
    entry.command.includes(binary) &&
    !entry.command.includes("__fx_foreground_session__")
  );
  expect(row).toBeDefined();
  expect(row!.pgid).toBe(row!.tpgid);
  expect(row!.stat).not.toContain("T");
  const sid = Number(execFileSync(
    "python3",
    ["-c", "import os,sys; print(os.getsid(int(sys.argv[1])))", String(row!.pid)],
    { encoding: "utf8" },
  ).trim());
  return { ...row!, sid };
}

function toolResultValue(body: string, toolCallId: string): string {
  return toolResultOutputFromBody(body, toolCallId);
}

function expectTraceOrder(trace: string, markers: string[]) {
  let offset = 0;
  for (const marker of markers) {
    const index = trace.indexOf(marker, offset);
    if (index < offset) {
      throw new Error(`Missing ordered trace marker ${JSON.stringify(marker)} after byte ${offset}`);
    }
    offset = index + marker.length;
  }
}

function createIsolatedRoot(baseDir = tmpdir()): IsolatedRoot {
  const root = realpathSync(mkdtempSync(join(baseDir, "fx-command-permissions-e2e-")));
  const home = join(root, "home");
  const workspace = join(root, "workspace");
  const hostileBin = join(root, "hostile-bin");
  const profileMarker = join(root, "hostile-profile-used");
  const commandMarkers: Record<string, string> = {};
  mkdirSync(join(home, ".fx"), { recursive: true });
  mkdirSync(workspace, { recursive: true });
  mkdirSync(hostileBin, { recursive: true });
  writeE2eGrokAuth(home);
  writeFileSync(
    join(home, ".fx", "settings.json"),
    JSON.stringify({ sandbox: "none", permission: {}, maxxing_mode: "legacy" }),
  );
  writeFileSync(join(home, ".profile"), `printf profile > ${JSON.stringify(profileMarker)}\n`);
  writeFileSync(join(home, ".zprofile"), `printf zprofile > ${JSON.stringify(profileMarker)}\n`);
  writeFileSync(join(workspace, "line\nname"), "");
  writeFileSync(join(workspace, "\x1bname"), "");
  for (const name of ["pwd", "ls", "wc", "printf", "git"]) {
    const script = join(hostileBin, name);
    const marker = join(root, `hostile-${name}-used`);
    commandMarkers[name] = marker;
    writeFileSync(
      script,
      `#!/bin/sh\nprintf used > ${JSON.stringify(marker)}\nexit 99\n`,
    );
    chmodSync(script, 0o755);
  }
  roots.push(root);
  return {
    root,
    home,
    workspace: realpathSync(workspace),
    hostileBin,
    profileMarker,
    commandMarkers,
  };
}

function hostilePath(root: IsolatedRoot) {
  return `${root.hostileBin}:${process.env.PATH ?? "/usr/bin:/bin"}`;
}

function installClipboardFixture(root: IsolatedRoot, script: string) {
  for (const command of ["pbcopy", "xclip", "osascript"]) {
    const path = join(root.hostileBin, command);
    writeFileSync(path, script);
    chmodSync(path, 0o755);
  }
}

function installUrlOpenerFixture(root: IsolatedRoot, script: string) {
  for (const command of ["open", "xdg-open"]) {
    const path = join(root.hostileBin, command);
    writeFileSync(path, script);
    chmodSync(path, 0o755);
  }
}

function gatewayEnv(
  root: IsolatedRoot,
  gateway: ReturnType<typeof startFakeGateway>,
  extra: Record<string, string | undefined> = {},
) {
  return {
    HOME: root.home,
    AI_GATEWAY_API_KEY: "fake-command-permission-key",
    VERCEL_OIDC_TOKEN: undefined,
    FX_GATEWAY_BASE_URL: gateway.baseUrl,
    FX_GATEWAY_CHAT_URL: gateway.chatUrl,
    FX_MODEL: MODEL,
    FX_AUTO_UPGRADE: "0",
    FX_DIRECT_SECRET: "must-not-be-inherited",
    NO_COLOR: "1",
    ...extra,
    FX_PERMISSION_MODE: extra.FX_PERMISSION_MODE ?? "yolo",
  };
}

function definedEnv(env: Record<string, string | undefined>) {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

async function launchPermissionResumeHarness(initialResponses: Response[]) {
  const root = createIsolatedRoot();
  const settingsPath = join(root.home, ".fx", "settings.json");
  const markerPath = join(root.workspace, "must-not-exist");
  const initialStderrPath = join(root.root, "permission-resume-initial-stderr.log");
  const resumedStderrPath = join(root.root, "permission-resume-resumed-stderr.log");
  writeFileSync(initialStderrPath, "");
  writeFileSync(resumedStderrPath, "");

  const initialGateway = startFakeGateway(initialResponses);
  const initialSession = await TmuxSession.create({
    cmd: FX_BIN,
    cwd: root.workspace,
    env: gatewayEnv(root, initialGateway, { FX_PERMISSION_MODE: undefined }),
    stderrPath: initialStderrPath,
    width: 120,
    height: 40,
  });
  activeSession = initialSession;

  return {
    root,
    settingsPath,
    markerPath,
    initialGateway,
    initialSession,
    initialStderrPath,
    resumedStderrPath,
    readSettings() {
      return JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
    },
    async resume(responses: Response[]) {
      await initialSession.sendText("/quit");
      await initialSession.waitForSessionEnd(TIMEOUT);
      if (activeSession === initialSession) activeSession = null;

      const gateway = startFakeGateway(responses);
      const session = await TmuxSession.create({
        cmd: `${FX_BIN} resume last`,
        cwd: root.workspace,
        env: gatewayEnv(root, gateway, { FX_PERMISSION_MODE: undefined }),
        stderrPath: resumedStderrPath,
        width: 120,
        height: 40,
      });
      activeSession = session;
      return { gateway, session };
    },
  };
}

function expectUserProfileTrace(tracePath: string) {
  const trace = readFileSync(tracePath, "utf8");
  expect(trace).toContain(
    "terminal.exec authority=shell_allowed source=yolo " +
      "route=approved_shell environment=user",
  );
  expect(trace).toContain("sandbox explicit command environment=user shell=");
  expect(trace).not.toContain("authority=direct_only route=direct_read_only");
}

function expectNoCommandArtifacts(root: IsolatedRoot) {
  const sessions = join(root.home, ".fx", "sessions");
  if (!existsSync(sessions)) return;
  const files = Bun.spawnSync(["find", sessions, "-type", "f"], {
    stdout: "pipe",
    stderr: "pipe",
  }).stdout.toString().trim().split("\n").filter(Boolean);
  const legacyArtifacts = files.filter((path) =>
    path.includes("/logs/commands/") && path.endsWith(".log")
  );
  expect(legacyArtifacts).toEqual([]);
}

function commandReplayFiles(root: IsolatedRoot): string[] {
  const sessions = join(root.home, ".fx", "sessions");
  if (!existsSync(sessions)) return [];
  const result = Bun.spawnSync(
    ["find", sessions, "-type", "f", "-name", "fx-command-replay-*"],
    { stdout: "pipe", stderr: "pipe" },
  );
  expect(result.exitCode).toBe(0);
  return result.stdout.toString().trim().split("\n").filter(Boolean);
}

function expectNoHostileExecutables(root: IsolatedRoot) {
  for (const marker of Object.values(root.commandMarkers)) {
    expect(existsSync(marker)).toBe(false);
  }
}

function largeEffectfulCommand(marker: string) {
  const command = [
    ...Array.from(
      { length: 84 },
      (_, index) => `# large lifecycle ${index.toString().padStart(3, "0")} ${"x".repeat(720)}`,
    ),
    `printf '%s\\n' FX_LARGE_RUN_COMMAND_DONE > ${marker}`,
  ].join("\n");
  expect(Buffer.byteLength(command)).toBeGreaterThan(57 * 1024);
  return command;
}

async function expectSavedTerminalExec(
    root: IsolatedRoot,
    sessionId: string,
    command: string,
    background = false,
    status: "success" | "failure" = "success",
) {
  const result = await runFx(
    ["session", "--id", sessionId, "--json"],
    { cwd: root.workspace, env: { HOME: root.home } },
  );
  expect(result.code).toBe(0);
  const detail = JSON.parse(result.stdout) as any;
  const step = detail.history
    .flatMap((turn: any) => turn.execution?.tool_steps ?? [])
    .find((entry: any) => entry.tool_calls?.some((call: any) => call.name === "terminal"));
  expect(step).toBeDefined();
  const call = step.tool_calls.find((entry: any) => entry.name === "terminal");
  expect(JSON.parse(call.arguments_json)).toEqual(
    expect.objectContaining({
      action: "exec",
      command,
      ...(background ? { background: true } : {}),
    }),
  );
  expect(step.tool_results).toContainEqual(
    expect.objectContaining({ tool_call_id: call.id, tool_name: "terminal", status }),
  );
}

function normalizeVolatileStatusRows(grid: string[]): string[] {
  return grid.map((line) =>
    /^• Streaming \([^)]*\)$/.test(line) ||
      isVolatileTokenStatusRow(line)
      ? "<status>"
      : line
  );
}

test("volatile token status rows normalize before transcript grid comparison", () => {
  expect(normalizeVolatileStatusRows(["  (↑10 ↓5)"])).toEqual(["<status>"]);
  expect(normalizeVolatileStatusRows(["  0s (↑10 ↓5)"])).toEqual(["<status>"]);
});

describe("effect-aware command permissions", () => {
  test.skipIf(!tmuxAvailable())(
    "TUI control completes the same two-command batch with normal approvals",
    async () => {
      const root = createIsolatedRoot();
      const firstCommand = "touch history-feedback-first.txt && printf 'first command completed\\n'";
      const secondCommand = "touch history-feedback-second.txt && printf 'second command completed\\n'";
      const gateway = startFakeGateway([
        twoEffectfulCommandBatch(firstCommand, secondCommand),
        finalText("history feedback control complete"),
      ]);
      const stderrPath = join(root.root, "stderr.log");
      writeFileSync(stderrPath, "");

      activeSession = await TmuxSession.create({
        cmd: FX_BIN,
        cwd: root.workspace,
        env: gatewayEnv(root, gateway, {
          FX_PERMISSION_MODE: "ask",
        }),
        stderrPath,
        width: 100,
        height: 28,
      });
      await activeSession.waitForComposer(TIMEOUT);
      await activeSession.sendText("Run the prepared two-command control fixture.");
      await activeSession.waitForText(COMMAND_APPROVAL_PROMPT, TIMEOUT);
      await activeSession.sendKeys("1");
      await activeSession.waitForPane(
        (pane) => pane.includes(COMMAND_APPROVAL_PROMPT) &&
          pane.includes("history-feedback-second.txt"),
        10_000,
      );
      await activeSession.sendKeys("1");
      await activeSession.waitForText("history feedback control complete", TIMEOUT);

      expect(gateway.requests).toHaveLength(2);
      expect(existsSync(join(root.workspace, "history-feedback-first.txt"))).toBe(true);
      expect(existsSync(join(root.workspace, "history-feedback-second.txt"))).toBe(true);
      expect(readFileSync(stderrPath, "utf8")).toBe("");
    },
    TIMEOUT,
  );

  test.skipIf(!tmuxAvailable())(
    "TUI yolo executes pwd through the default user profile without prompting",
    async () => {
      const root = createIsolatedRoot();
      const gateway = startFakeGateway([toolCall("pwd"), finalText("direct complete")]);
      const tracePath = join(root.root, "trace.log");
      const stderrPath = join(root.root, "stderr.log");
      writeFileSync(stderrPath, "");

      activeSession = await TmuxSession.create({
        cmd: FX_BIN,
        cwd: root.workspace,
        env: gatewayEnv(root, gateway, {
          PATH: hostilePath(root),
          FX_PERMISSION_MODE: "yolo",
          FX_TRACE_LOG: tracePath,
          FX_TRACE_SCOPES: "core",
        }),
        stderrPath,
        width: 120,
        height: 40,
      });
      await activeSession.waitForComposer(TIMEOUT);
      await activeSession.sendText("Run pwd once.");
      const pane = await activeSession.waitForText("direct complete", TIMEOUT);

      expect(pane).not.toContain(COMMAND_APPROVAL_PROMPT);
      expect(gateway.requests).toHaveLength(2);
      expect(gateway.requests[1].body).toContain(root.workspace);
      expectUserProfileTrace(tracePath);
      expect(readFileSync(stderrPath, "utf8")).toBe("");
      expect(existsSync(root.profileMarker)).toBe(true);
      expectNoHostileExecutables(root);
      expectNoCommandArtifacts(root);
    },
    TIMEOUT,
  );

  test.skipIf(!tmuxAvailable())(
    "TUI Minimal keeps command output exclusive to Ctrl-O through resize and resume",
    async () => {
      const root = createIsolatedRoot();
      const stderrPath = join(root.root, "minimal-command-output-stderr.log");
      const resumedStderrPath = join(root.root, "minimal-command-output-resumed-stderr.log");
      writeFileSync(
        join(root.home, ".fx", "settings.json"),
        JSON.stringify({
          sandbox: "none",
          permission_mode: "yolo",
          permission: {},
          maxxing_mode: "minimal",
        }),
      );
      writeFileSync(stderrPath, "");
      writeFileSync(resumedStderrPath, "");

      const scripts = [
        {
          name: "fxc110-fast.sh",
          body: "#!/bin/sh\nprintf 'FXC110_FAST_STDOUT\\n'\n",
        },
        {
          name: "fxc110-stream.sh",
          body:
            "#!/bin/sh\nprintf 'FXC110_STREAM_STDOUT\\n'\nsleep 1\nprintf 'FXC110_STREAM_STDERR\\n' >&2\nsleep 1\n",
        },
        {
          name: "fxc110-failed.sh",
          body: "#!/bin/sh\nprintf 'FXC110_FAILED_STDERR\\n' >&2\nexit 7\n",
        },
      ];
      for (const script of scripts) {
        const path = join(root.workspace, script.name);
        writeFileSync(path, script.body);
        chmodSync(path, 0o755);
      }

      const calls = [
        { id: "fxc110-fast", command: "./fxc110-fast.sh" },
        { id: "fxc110-stream", command: "./fxc110-stream.sh" },
        { id: "fxc110-failed", command: "./fxc110-failed.sh" },
      ];
      const gateway = startFakeGateway([
        sse([
          ...calls.map((call) => ({
            type: "tool-input-start",
            id: call.id,
            toolName: "terminal",
          })),
          {
            type: "text-delta",
            id: "fxc110-provider-bridge",
            delta: "FXC110_PROVIDER_BRIDGE",
          },
          ...calls.map((call) => ({
            type: "tool-call",
            toolCallId: call.id,
            toolName: "terminal",
            input: { action: "exec", command: call.command },
          })),
          {
            type: "finish",
            finishReason: { unified: "tool-calls", raw: "tool-calls" },
          },
        ]),
        finalText("FXC110_COMPLETE"),
      ]);
      const outputRows = [
        "│ FXC110_FAST_STDOUT",
        "│ FXC110_STREAM_STDOUT",
        "│ FXC110_STREAM_STDERR",
        "│ FXC110_FAILED_STDERR",
      ];
      const expectNoOutputRows = (text: string) => {
        for (const row of outputRows) expect(text).not.toContain(row);
      };

      activeSession = await TmuxSession.create({
        cmd: FX_BIN,
        cwd: root.workspace,
        env: gatewayEnv(root, gateway, {
          FX_PERMISSION_MODE: "yolo",
          FX_TRACE_LOG: join(root.root, "minimal-command-output-trace.log"),
          FX_TRACE_SCOPES: "core,agent,tool,session,command_output",
        }),
        stderrPath,
        width: 120,
        height: 36,
      });
      await activeSession.waitForComposer(TIMEOUT);
      await activeSession.sendText("Run the prepared command matrix.");
      await activeSession.waitForText("Running ./fxc110-stream.sh", TIMEOUT);
      await Bun.sleep(250);
      const running = await activeSession.captureFullScrollback();
      expect(running).toContain("Running ./fxc110-stream.sh");
      expectNoOutputRows(running);

      await activeSession.waitForText("1 failed", TIMEOUT);
      const completed = await activeSession.captureFullScrollback();
      expect(completed).toContain("3 tool calls");
      expect(completed).toContain("1 failed");
      for (const script of scripts) expect(completed).toContain(script.name);
      expectNoOutputRows(completed);

      await activeSession.sendKeys("C-o");
      await activeSession.waitForText("Review · ←/→ switch · ctrl o close", TIMEOUT);
      await activeSession.sendKeys("Right");
      await activeSession.waitForText("FXC110_FAILED_STDERR", TIMEOUT);
      const full = await activeSession.capturePane();
      expect(full).toContain("FXC110_FAST_STDOUT");
      expect(full).toContain("FXC110_STREAM_STDOUT");
      expect(full).toContain("FXC110_STREAM_STDERR");
      expect(full).toContain("FXC110_FAILED_STDERR");

      await activeSession.sendKeys("C-o");
      await activeSession.waitForText("3 tool calls", TIMEOUT);
      expectNoOutputRows(await activeSession.captureFullScrollback());
      await activeSession.resizeWindow(64, 28);
      expectNoOutputRows(await activeSession.captureFullScrollback());

      await activeSession.kill();
      activeSession = null;
      activeSession = await TmuxSession.create({
        cmd: `${FX_BIN} --resume-last`,
        cwd: root.workspace,
        env: gatewayEnv(root, gateway, {
          FX_PERMISSION_MODE: "yolo",
        }),
        stderrPath: resumedStderrPath,
        width: 88,
        height: 32,
      });
      await activeSession.waitForComposer(TIMEOUT);
      await activeSession.waitForText("3 tool calls", TIMEOUT);
      expectNoOutputRows(await activeSession.captureFullScrollback());

      await activeSession.sendKeys("C-o");
      await activeSession.waitForText("Review · ←/→ switch · ctrl o close", TIMEOUT);
      await activeSession.sendKeys("Right");
      await activeSession.waitForText("FXC110_FAILED_STDERR", TIMEOUT);
      let resumedFull = await activeSession.capturePane();
      await activeSession.sendHexBytes(["1b", "5b", "35", "7e"]);
      await Bun.sleep(100);
      resumedFull += `\n${await activeSession.capturePane()}`;
      expect(resumedFull).toContain("FXC110_FAST_STDOUT");
      expect(resumedFull).toContain("FXC110_STREAM_STDOUT");
      expect(resumedFull).toContain("FXC110_STREAM_STDERR");
      expect(resumedFull).toContain("FXC110_FAILED_STDERR");
      expect(gateway.requests).toHaveLength(2);
      expect(gateway.classifierRequests).toHaveLength(0);
      expect(readFileSync(stderrPath, "utf8")).toBe("");
      expect(readFileSync(resumedStderrPath, "utf8")).toBe("");
    },
    90_000,
  );

  test.skipIf(!tmuxAvailable())(
    "TUI user-profile printf keeps compact output bounded and Ctrl-O complete",
    async () => {
      const root = createIsolatedRoot();
      const tracePath = join(root.root, "direct-printf-trace.log");
      const stderrPath = join(root.root, "direct-printf-stderr.log");
      const resumedStderrPath = join(root.root, "direct-printf-resumed-stderr.log");
      const losslessRows = Array.from(
        { length: 7 },
        (_, index) => `DIRECT_LOSSLESS_${String(index + 1).padStart(2, "0")}`,
      );
      const losslessFormat =
        Array.from({ length: losslessRows.length - 1 }, () => "%s\\n").join("") + "%s";
      const losslessCommand = `printf '${losslessFormat}' ${
        losslessRows.map((row) => JSON.stringify(row)).join(" ")
      }`;
      const lossyRows = [
        "DIRECT_PADDED",
        "DIRECT_LITERAL_</stdout>",
        "DIRECT_LOSSY_03",
        "DIRECT_LOSSY_04",
        "DIRECT_LOSSY_05",
        "DIRECT_LOSSY_06",
        "DIRECT_LOSSY_07",
        "DIRECT_TRAILING",
      ];
      const lossyFormat = "  %s  \\n\\n%s\\n%s\\n%s\\n%s\\n%s\\n%s\\n%s   ";
      const lossyCommand = `printf '${lossyFormat}' ${
        lossyRows.map((row) => JSON.stringify(row)).join(" ")
      }`;
      const gateway = startFakeGateway([
        toolCall(losslessCommand, {}, "direct_printf_lossless"),
        finalText("DIRECT_LOSSLESS_DONE"),
        toolCall(lossyCommand, {}, "direct_printf_lossy"),
        finalText("DIRECT_LOSSY_DONE"),
      ]);
      writeFileSync(stderrPath, "");
      writeFileSync(resumedStderrPath, "");
      const commandOutputText = (text: string): string =>
        text.split("\n").filter((line) => line.trimStart().startsWith("│ ")).join("\n");
      const expectCommandHeaderImmediatelyBefore = (text: string, output: string): void => {
        const lines = text.split("\n");
        const outputIndex = lines.findIndex((line) => line.includes(output));
        expect(outputIndex).toBeGreaterThan(0);
        expect(lines[outputIndex - 1]).toContain("● Ran");
      };
      const toolResultValue = (body: string, toolCallId: string): string =>
        toolResultOutputFromBody(body, toolCallId);

      activeSession = await TmuxSession.create({
        cmd: FX_BIN,
        cwd: root.workspace,
        env: gatewayEnv(root, gateway, {
          PATH: hostilePath(root),
          FX_PERMISSION_MODE: "yolo",
          FX_TRACE_LOG: tracePath,
          FX_TRACE_SCOPES: "core,tool,session,command_output",
        }),
        stderrPath,
        width: 72,
        height: 30,
      });
      await activeSession.waitForComposer(TIMEOUT);
      await activeSession.sendText("Run the lossless direct printf fixture.");
      await activeSession.waitForText("DIRECT_LOSSLESS_DONE", TIMEOUT);
      await activeSession.waitForPane(
        (pane) => pane.includes("DIRECT_LOSSLESS_DONE") && !pane.includes("Streaming ("),
        TIMEOUT,
      );

      const losslessCompact = await activeSession.captureFullScrollback();
      const losslessCompactOutput = commandOutputText(losslessCompact);
      for (const row of losslessRows.slice(0, 5)) {
        expect(losslessCompactOutput).toContain(`│ ${row}`);
      }
      expect(losslessCompactOutput).not.toContain(losslessRows[5]!);
      expect(losslessCompactOutput).not.toContain(losslessRows[6]!);
      expect(losslessCompactOutput).toContain("│ … 2 lines more (ctrl o to view)");
      expectCommandHeaderImmediatelyBefore(losslessCompact, `│ ${losslessRows[0]}`);
      expect(commandReplayFiles(root)).toEqual([]);
      const losslessGrid = await activeSession.capturePaneGrid();

      await activeSession.sendKeys("C-o");
      await activeSession.waitForText("Review · ←/→ switch · ctrl o close", TIMEOUT);
      await activeSession.sendKeys("Right");
      await activeSession.waitForText(losslessRows[6]!, TIMEOUT);
      const losslessFull = await activeSession.capturePane();
      const losslessFullOutput = commandOutputText(losslessFull);
      for (const row of losslessRows) expect(losslessFullOutput).toContain(`│ ${row}`);
      expect(losslessFullOutput).not.toContain("<stdout>");
      expect(losslessFullOutput).not.toContain("</stdout>");
      expect(losslessFullOutput).not.toContain("lines more (ctrl o");
      await activeSession.sendKeys("C-o");
      await activeSession.waitForText("DIRECT_LOSSLESS_DONE", TIMEOUT);
      expect(normalizeVolatileStatusRows(await activeSession.capturePaneGrid())).toEqual(
        normalizeVolatileStatusRows(losslessGrid),
      );

      await activeSession.sendText("Run the lossy direct printf fixture.");
      await activeSession.waitForText("DIRECT_LOSSY_DONE", TIMEOUT);
      await activeSession.waitForPane(
        (pane) => pane.includes("DIRECT_LOSSY_DONE") && !pane.includes("Streaming ("),
        TIMEOUT,
      );
      const lossyCompact = await activeSession.captureFullScrollback();
      const lossyCompactOutput = commandOutputText(lossyCompact);
      expect(lossyCompactOutput).toContain("│   DIRECT_PADDED");
      expect(lossyCompactOutput).toContain(`│ ${lossyRows[1]}`);
      expect(lossyCompactOutput).toContain(`│ ${lossyRows[2]}`);
      expect(lossyCompactOutput).toContain(`│ ${lossyRows[3]}`);
      expect(lossyCompactOutput).not.toContain(lossyRows[4]!);
      expect(lossyCompactOutput).not.toContain(lossyRows[7]!);
      expect(lossyCompactOutput).toContain("│ … 4 lines more (ctrl o to view)");
      expectCommandHeaderImmediatelyBefore(lossyCompact, "│   DIRECT_PADDED");
      expect(commandReplayFiles(root)).toHaveLength(1);
      const lossyGrid = await activeSession.capturePaneGrid();

      await activeSession.sendKeys("C-o");
      await activeSession.waitForText("Review · ←/→ switch · ctrl o close", TIMEOUT);
      await activeSession.sendKeys("Right");
      await activeSession.sendHexBytes(["1b", "5b", "36", "7e"]);
      await activeSession.waitForText(lossyRows[7]!, TIMEOUT);
      const lossyFull = await activeSession.capturePane();
      const lossyFullOutput = commandOutputText(lossyFull);
      for (const row of lossyRows) expect(lossyFullOutput).toContain(row);
      expect(lossyFullOutput.match(/^│ DIRECT_LITERAL_<\/stdout>$/gm)).toHaveLength(1);
      expect(lossyFullOutput).not.toContain("<stdout>");
      expect(lossyFullOutput).not.toContain("exit_code=0");
      await activeSession.sendKeys("C-o");
      await activeSession.waitForText("DIRECT_LOSSY_DONE", TIMEOUT);
      expect(normalizeVolatileStatusRows(await activeSession.capturePaneGrid())).toEqual(
        normalizeVolatileStatusRows(lossyGrid),
      );

      expect(gateway.requests).toHaveLength(4);
      const losslessModelResult = toolResultValue(
        gateway.requests[1]!.body,
        "direct_printf_lossless",
      );
      expect(losslessModelResult).toContain(losslessRows[6]!);
      expect(losslessModelResult).not.toContain("command_output_replay");
      const lossyModelResult = toolResultValue(
        gateway.requests[3]!.body,
        "direct_printf_lossy",
      );
      expect(lossyModelResult).toContain(lossyRows[1]!);
      expect(lossyModelResult).not.toContain("  DIRECT_PADDED  ");
      expect(lossyModelResult).not.toContain("DIRECT_TRAILING   ");
      expect(lossyModelResult).not.toContain("command_output_replay");
      expectUserProfileTrace(tracePath);
      expect(existsSync(root.profileMarker)).toBe(true);
      expectNoHostileExecutables(root);
      expectNoCommandArtifacts(root);
      expect(readFileSync(stderrPath, "utf8")).toBe("");

      const sessionId = sessionIdFromHome(root);
      const publicSession = await runFx(
        ["session", "--id", sessionId, "--json"],
        { cwd: root.workspace, env: { HOME: root.home } },
      );
      expect(publicSession.code).toBe(0);
      expect(publicSession.stdout).not.toContain("command_output_replay");
      expect(publicSession.stdout).not.toContain("command_replay");
      expect(publicSession.stdout).not.toContain("command_process_presentation");
      expect(publicSession.stdout).not.toContain("process_presentation");
      expect(publicSession.stdout).not.toContain("fx-command-replay-");

      await activeSession.sendText("/quit");
      expect(await activeSession.waitForSessionEnd(TIMEOUT)).toBe(true);
      await activeSession.kill();
      activeSession = null;

      const resumedGateway = startFakeGateway([]);
      activeSession = await TmuxSession.create({
        cmd: `${FX_BIN} --resume-last`,
        cwd: root.workspace,
        env: gatewayEnv(root, resumedGateway),
        stderrPath: resumedStderrPath,
        width: 72,
        height: 30,
      });
      await activeSession.waitForText("│ … 4 lines more (ctrl o to view)", TIMEOUT);
      const resumedCompact = await activeSession.capturePane();
      const resumedCompactOutput = commandOutputText(resumedCompact);
      expect(resumedCompactOutput).toContain(lossyRows[1]!);
      expect(resumedCompactOutput).not.toContain(lossyRows[7]!);
      expectCommandHeaderImmediatelyBefore(resumedCompact, "│   DIRECT_PADDED");
      await activeSession.sendKeys("C-o");
      await activeSession.waitForText("Review · ←/→ switch · ctrl o close", TIMEOUT);
      await activeSession.sendKeys("Right");
      await activeSession.sendHexBytes(["1b", "5b", "36", "7e"]);
      await activeSession.waitForText(lossyRows[7]!, TIMEOUT);
      const resumedFull = await activeSession.capturePane();
      const resumedFullOutput = commandOutputText(resumedFull);
      for (const row of lossyRows) expect(resumedFullOutput).toContain(row);
      expect(resumedFullOutput.match(/^│ DIRECT_LITERAL_<\/stdout>$/gm)).toHaveLength(1);
      expect(resumedFullOutput).not.toContain("<stdout>");
      expect(resumedGateway.requests).toHaveLength(0);
      expect(readFileSync(resumedStderrPath, "utf8")).toBe("");
    },
    90_000,
  );

  test.skipIf(!tmuxAvailable())(
    "TUI user-profile output preserves compact scrollback across slash commands",
    async () => {
      const root = createIsolatedRoot();
      const stderrPath = join(root.root, "output-setting-removal-stderr.log");
      const commandRows = Array.from(
        { length: 7 },
        (_, index) => `FXC29_COMMAND_${String(index + 1).padStart(2, "0")}`,
      );
      const responseRows = Array.from(
        { length: 10 },
        (_, index) => `FXC29_RESPONSE_${String(index + 1).padStart(2, "0")}`,
      );
      const command = `printf '${Array.from({ length: 7 }, () => "%s\\n").join("")}' ${
        commandRows.map((row) => JSON.stringify(row)).join(" ")
      }`;
      const gateway = startFakeGateway([
        toolCall(command, {}, "fxc29_compact_output"),
        finalText(responseRows.join("\n")),
      ]);
      const settingsPath = join(root.home, ".fx", "settings.json");
      writeFileSync(
        settingsPath,
        JSON.stringify({
          sandbox: "none",
          permission: {},
          maxxing_mode: "legacy",
          output_level: { legacy: true },
          workspaces: {
            [root.workspace]: { output_level: ["quiet", 7] },
          },
        }),
      );
      writeFileSync(stderrPath, "");

      activeSession = await TmuxSession.create({
        cmd: FX_BIN,
        cwd: root.workspace,
        env: gatewayEnv(root, gateway, { FX_PERMISSION_MODE: "yolo" }),
        stderrPath,
        width: 90,
        height: 30,
        minimumHistoryLines: 1_000,
      });
      await activeSession.waitForComposer(TIMEOUT);
      await activeSession.sendText("/output quiet");
      await activeSession.waitForText(responseRows.at(-1)!, TIMEOUT);
      expect(promptText(gateway.requests[0]!.body)).toContain("/output quiet");
      expect(gateway.requests).toHaveLength(2);
      const compact = await activeSession.captureFullScrollback();
      for (const row of commandRows.slice(0, 5)) expect(compact).toContain(`│ ${row}`);
      expect(compact).not.toContain(commandRows[5]!);
      expect(compact).not.toContain(commandRows[6]!);
      expect(compact).toContain("│ … 2 lines more (ctrl o to view)");

      await activeSession.sendKeys("C-o");
      await activeSession.waitForText("Review · ←/→ switch · ctrl o close", TIMEOUT);
      await activeSession.sendKeys("Right");
      await activeSession.waitForText(commandRows.at(-1)!, TIMEOUT);
      const full = await activeSession.capturePane();
      for (const row of commandRows) expect(full).toContain(`│ ${row}`);
      await activeSession.sendKeys("C-o");
      await activeSession.waitForText(responseRows.at(-1)!, TIMEOUT);

      const extractResponses = (scrollback: string) =>
        [...scrollback.matchAll(/FXC29_RESPONSE_\d{2}/g)].map((match) => match[0]);
      const beforeSlashCommands = await activeSession.captureFullScrollback();
      expect(extractResponses(beforeSlashCommands)).toEqual(responseRows);

      await activeSession.sendText("/sound on");
      await activeSession.waitForText("● Sound: on", TIMEOUT);
      await activeSession.sendText("/settings");
      await activeSession.waitForText("←→ Change", TIMEOUT);
      await activeSession.sendKeys("Escape");
      await activeSession.waitForPane(
        (pane) => !pane.includes("←→ Change"),
        TIMEOUT,
      );
      await activeSession.waitForText(responseRows.at(-1)!, TIMEOUT);

      const afterSlashCommands = await activeSession.captureFullScrollback();
      expect(extractResponses(afterSlashCommands)).toEqual(responseRows);
      expect(afterSlashCommands.indexOf("● Sound: on")).toBeGreaterThan(
        afterSlashCommands.indexOf(responseRows.at(-1)!),
      );
      expect(afterSlashCommands).toContain(`│ ${commandRows[0]}`);
      expect(JSON.parse(readFileSync(settingsPath, "utf8")).output_level).toEqual({
        legacy: true,
      });
      expect(readFileSync(stderrPath, "utf8")).toBe("");

      await activeSession.sendText("/quit");
      expect(await activeSession.waitForSessionEnd(TIMEOUT)).toBe(true);
      await activeSession.kill();
      activeSession = null;
    },
    60_000,
  );

  test.skipIf(!tmuxAvailable())(
    "TUI yolo completes more than twenty-five serial user-profile commands when unlimited",
    async () => {
      const root = createIsolatedRoot();
      const gateway = startFakeGateway([
        ...Array.from(
          { length: 26 },
          (_, index) => toolCall("pwd", {}, `command_${index + 1}`),
        ),
        finalText("unlimited direct commands complete"),
      ]);
      const stderrPath = join(root.root, "stderr.log");
      writeFileSync(stderrPath, "");

      activeSession = await TmuxSession.create({
        cmd: FX_BIN,
        cwd: root.workspace,
        env: gatewayEnv(root, gateway, {
          PATH: hostilePath(root),
          FX_PERMISSION_MODE: "yolo",
        }),
        stderrPath,
        width: 120,
        height: 40,
      });
      await activeSession.waitForComposer(TIMEOUT);
      await activeSession.sendText("Run pwd until you can answer.");
      await activeSession.waitForText("unlimited direct commands complete", TIMEOUT);

      const scrollback = await activeSession.captureFullScrollback();
      expect(scrollback).not.toContain(
        "Agent step limit reached; continue with a follow-up prompt if needed.",
      );
      expect(gateway.requests).toHaveLength(27);
      expect(readFileSync(stderrPath, "utf8")).toBe("");
      expect(existsSync(root.profileMarker)).toBe(true);
      expectNoHostileExecutables(root);
      expectNoCommandArtifacts(root);

      await activeSession.sendText("/quit");
      expect(await activeSession.waitForSessionEnd()).toBe(true);
      await activeSession.kill();
      activeSession = null;
    },
    TIMEOUT,
  );

  test.skipIf(!tmuxAvailable())(
    "TUI creates a private Markdown trace without a feedback CTA",
    async () => {
      const root = createIsolatedRoot();
      const gateway = startFakeGateway([]);
      const stderrPath = join(root.root, "trace-report-stderr.log");
      const clipboardPath = join(root.root, "trace-clipboard-path.txt");
      installClipboardFixture(
        root,
        '#!/bin/sh\nfor arg in "$@"; do last="$arg"; done\nprintf "%s" "$last" > "$FX_TRACE_CLIPBOARD_OUTPUT"\n',
      );
      writeFileSync(stderrPath, "");

      activeSession = await TmuxSession.create({
        cmd: FX_BIN,
        cwd: root.workspace,
        env: gatewayEnv(root, gateway, {
          PATH: hostilePath(root),
          TMPDIR: root.root,
          FX_TRACE_CLIPBOARD_OUTPUT: clipboardPath,
        }),
        stderrPath,
        width: 120,
        height: 40,
      });
      await activeSession.waitForComposer(TIMEOUT);
      await activeSession.sendText("/trace");
      await activeSession.waitForText(
        process.platform === "darwin"
          ? "Trace copied to clipboard"
          : "Trace saved at",
        TIMEOUT,
      );

      const escapes = await activeSession.capturePaneEscapes();
      expect(escapes).not.toContain("Trace:");
      expect(escapes).not.toContain("Report issue");
      expect(escapes).not.toContain("fx.sh/feedback");
      expect(escapes).not.toContain("github.com");
      const reportPath = latestTraceReportPath(root);
      const report = readFileSync(reportPath, "utf8");
      expect(report).toContain("# fx trace");
      expect(report).toContain("## Summary");
      expect(report).toContain(root.workspace);
      expect(statSync(reportPath).mode & 0o077).toBe(0);
      if (process.platform === "darwin") {
        expect(readFileSync(clipboardPath, "utf8")).toBe(reportPath);
      } else {
        expect(existsSync(clipboardPath)).toBe(false);
      }
      expect(readFileSync(stderrPath, "utf8")).toBe("");

      await activeSession.sendText("/quit");
      expect(await activeSession.waitForSessionEnd()).toBe(true);
      await activeSession.kill();
      activeSession = null;
    },
    TIMEOUT,
  );

  test.skipIf(!tmuxAvailable())(
    "TUI feedback opens fx.sh without creating a trace or touching the clipboard",
    async () => {
      const root = createIsolatedRoot();
      const gateway = startFakeGateway([]);
      const stderrPath = join(root.root, "feedback-stderr.log");
      const openerPath = join(root.root, "feedback-opened-url.txt");
      const clipboardMarker = join(root.root, "feedback-clipboard-used.txt");
      installUrlOpenerFixture(
        root,
        '#!/bin/sh\nprintf "%s" "$1" > "$FX_FEEDBACK_OPEN_OUTPUT"\n',
      );
      installClipboardFixture(
        root,
        '#!/bin/sh\nprintf used > "$FX_FEEDBACK_CLIPBOARD_MARKER"\n',
      );
      writeFileSync(stderrPath, "");

      activeSession = await TmuxSession.create({
        cmd: FX_BIN,
        cwd: root.workspace,
        env: gatewayEnv(root, gateway, {
          PATH: hostilePath(root),
          TMPDIR: root.root,
          FX_FEEDBACK_OPEN_OUTPUT: openerPath,
          FX_FEEDBACK_CLIPBOARD_MARKER: clipboardMarker,
        }),
        stderrPath,
        width: 120,
        height: 40,
      });
      await activeSession.waitForComposer(TIMEOUT);
      await activeSession.sendText("/feedback");
      await activeSession.waitForText("Opened https://fx.sh/feedback.", TIMEOUT);

      expect(readFileSync(openerPath, "utf8")).toBe("https://fx.sh/feedback");
      expect(existsSync(clipboardMarker)).toBe(false);
      expect(
        readdirSync(root.root).filter((entry) => entry.startsWith("fx-trace-")),
      ).toHaveLength(0);
      const escapes = await activeSession.capturePaneEscapes();
      expect(escapes).not.toContain("Feedback:");
      expect(escapes).not.toContain("github.com");
      expect(readFileSync(stderrPath, "utf8")).toBe("");

      await activeSession.sendText("/quit");
      expect(await activeSession.waitForSessionEnd()).toBe(true);
      await activeSession.kill();
      activeSession = null;
    },
    TIMEOUT,
  );

  test.skipIf(!tmuxAvailable())(
    "TUI yolo returns every repeated user-profile command result to the model",
    async () => {
      const root = createIsolatedRoot();
      const callIds = Array.from({ length: 10 }, (_, index) => `command_${index + 1}`);
      const gateway = startFakeGateway([
        toolCalls("pwd", callIds),
        finalText("repetition batch complete"),
      ]);
      const tracePath = join(root.root, "trace.log");
      const stderrPath = join(root.root, "stderr.log");
      writeFileSync(stderrPath, "");

      activeSession = await TmuxSession.create({
        cmd: FX_BIN,
        cwd: root.workspace,
        env: gatewayEnv(root, gateway, {
          PATH: hostilePath(root),
          FX_PERMISSION_MODE: "yolo",
          FX_TRACE_LOG: tracePath,
          FX_TRACE_SCOPES: "core",
        }),
        stderrPath,
        width: 120,
        height: 40,
      });
      await activeSession.waitForComposer(TIMEOUT);
      await activeSession.sendText("Run pwd until you can answer.");
      const pane = await activeSession.waitForText("repetition batch complete", TIMEOUT);

      expect(pane).not.toContain(COMMAND_APPROVAL_PROMPT);
      expect(pane).not.toContain("Guarding repeated");
      expect(gateway.requests).toHaveLength(2);
      expectOrdinaryToolResults(gateway.requests[1].body, callIds);
      expect(gateway.requests[1].body).not.toContain("Agent stopped:");
      expect(readFileSync(stderrPath, "utf8")).toBe("");
      expect(existsSync(root.profileMarker)).toBe(true);
      expectNoHostileExecutables(root);
      expectNoCommandArtifacts(root);
    },
    TIMEOUT,
  );

  test(
    "hx ask yolo returns repeated user-profile command results to the model",
    async () => {
      const root = createIsolatedRoot();
      const callIds = ["direct_1", "direct_2", "direct_3"];
      const gateway = startFakeGateway([
        toolCalls("pwd", callIds),
        finalText("direct repetition complete"),
      ]);

      const result = await runFx(["ask", "--yolo", "Run pwd until you can answer."], {
        cwd: root.workspace,
        env: gatewayEnv(root, gateway, {
          PATH: hostilePath(root),
        }),
        timeoutMs: TIMEOUT,
      });

      expect(result.code).toBe(0);
      expect(result.stdout).toContain("direct repetition complete");
      expect(result.stderr).toContain("Running pwd");
      expect(gateway.requests).toHaveLength(2);
      expectOrdinaryToolResults(gateway.requests[1].body, callIds);
      expect(gateway.requests[1].body).not.toContain("Agent stopped:");
      expect(existsSync(root.profileMarker)).toBe(true);
      expectNoHostileExecutables(root);
      expectNoCommandArtifacts(root);
    },
    TIMEOUT,
  );
  test(
    "hx ask yolo completes more than ten serial user-profile commands when unlimited",
    async () => {
      const root = createIsolatedRoot();
      const gateway = startFakeGateway([
        ...Array.from(
          { length: 11 },
          (_, index) => toolCall("pwd", {}, `direct_${index + 1}`),
        ),
        finalText("direct unlimited complete"),
      ]);

      const result = await runFx(["ask", "--yolo", "Run pwd until you can answer."], {
        cwd: root.workspace,
        env: gatewayEnv(root, gateway, {
          PATH: hostilePath(root),
        }),
        timeoutMs: TIMEOUT,
      });

      expect(result.code).toBe(0);
      expect(result.stdout).toContain("direct unlimited complete");
      expect(result.stderr).toContain("Running pwd");
      expect(gateway.requests).toHaveLength(12);
      expect(existsSync(root.profileMarker)).toBe(true);
      expectNoHostileExecutables(root);
      expectNoCommandArtifacts(root);
    },
    TIMEOUT,
  );
  test(
    "hx ask yolo executes pwd through the default user profile without an artifact",
    async () => {
      const root = createIsolatedRoot();
      const gateway = startFakeGateway([toolCall("pwd"), finalText("ask direct complete")]);
      const tracePath = join(root.root, "trace.log");
      const result = await runFx(
        ["ask", "--yolo", "--quiet", "--json", "--no-save", "Run pwd once."],
        {
          cwd: root.workspace,
          env: gatewayEnv(root, gateway, {
            PATH: hostilePath(root),
            FX_TRACE_LOG: tracePath,
            FX_TRACE_SCOPES: "core",
          }),
          timeoutMs: TIMEOUT,
        },
      );

      expect(result.code).toBe(0);
      expect(result.stderr).toContain("Running pwd");
      expect(result.stderr).toContain(root.workspace);
      expect(result.stderr.toLowerCase()).not.toContain("error");
      const json = JSON.parse(result.stdout.trim()) as any;
      expect(json.tool_calls).toHaveLength(1);
      expect(json.tool_calls[0].name).toBe("terminal");
      expect(json.tool_calls[0].status).toBe("success");
      expect(json.tool_calls[0].command_result.command).toBe("pwd");
      expect(json.tool_calls[0].command_result.cwd).toBe(root.workspace);
      expect(json.tool_calls[0].command_result.output_file).toBeNull();
      expectUserProfileTrace(tracePath);
      expect(existsSync(root.profileMarker)).toBe(true);
      expectNoHostileExecutables(root);
      expectNoCommandArtifacts(root);
    },
    TIMEOUT,
  );
  test(
    "hx ask projects hostile ls filenames through the default user profile",
    async () => {
      const root = createIsolatedRoot();
      const gateway = startFakeGateway([toolCall("ls"), finalText("ask ls complete")]);
      const tracePath = join(root.root, "trace.log");
      const result = await runFx(
        ["ask", "--yolo", "--quiet", "--json", "--no-save", "List this directory."],
        {
          cwd: root.workspace,
          env: gatewayEnv(root, gateway, {
            FX_TRACE_LOG: tracePath,
            FX_TRACE_SCOPES: "core",
          }),
          timeoutMs: TIMEOUT,
        },
      );

      expect(result.code).toBe(0);
      expect(gateway.requests).toHaveLength(2);
      expect(gateway.requests[1].body).toContain("\\u001bname");
      expect(gateway.requests[1].body).toContain("line\\nname");
      expect(gateway.requests[1].body).not.toContain("\x1b");
      expect(gateway.requests[1].body).not.toContain("\\x1b");
      expectUserProfileTrace(tracePath);
      expect(existsSync(root.profileMarker)).toBe(true);
      expectNoHostileExecutables(root);
      expectNoCommandArtifacts(root);
    },
    TIMEOUT,
  );
  test(
    "hx ask preserves quoted shell metacharacters through the user profile",
    async () => {
      const root = createIsolatedRoot();
      const gateway = startFakeGateway([
        toolCall("printf '%s' '<'"),
        finalText("quoted direct complete"),
      ]);
      const tracePath = join(root.root, "trace.log");
      const result = await runFx(
        ["ask", "--yolo", "--quiet", "--json", "--no-save", "Print a literal less-than sign."],
        {
          cwd: root.workspace,
          env: gatewayEnv(root, gateway, {
            PATH: hostilePath(root),
            FX_TRACE_LOG: tracePath,
            FX_TRACE_SCOPES: "core",
          }),
          timeoutMs: TIMEOUT,
        },
      );

      expect(result.code).toBe(0);
      expect(result.stderr).toContain("Running printf '%s' '<'");
      expect(gateway.requests).toHaveLength(2);
      expect(gateway.requests[1].body).toContain("<stdout>\\n<\\n</stdout>");
      expectUserProfileTrace(tracePath);
      expect(existsSync(root.profileMarker)).toBe(true);
      expectNoHostileExecutables(root);
      expectNoCommandArtifacts(root);
    },
    TIMEOUT,
  );
  test(
    "hx ask keeps parser hardening cases approval-bearing",
    async () => {
      const commands = [
        "wc -c < input.txt",
        "printf x\r|wc -c",
        "printf x | wc -c | wc -c | wc -c | wc -c | wc -c | wc -c | wc -c | wc -c",
      ];

      for (const command of commands) {
        const root = createIsolatedRoot();
        writeFileSync(join(root.workspace, "input.txt"), "bounded");
        const gateway = startFakeGateway([toolCall(command)]);
        const result = await runFx(
          ["ask", "--json", "--no-save", "Run the requested inspection."],
          {
            cwd: root.workspace,
            env: gatewayEnv(root, gateway, {
              PATH: hostilePath(root),
              FX_PERMISSION_MODE: "ask",
            }),
            timeoutMs: TIMEOUT,
          },
        );

        expect(result.code).toBe(1);
        expect(result.stderr).toContain("permission required");
        expect(result.stderr).toContain("noninteractive_permission_prompt_unavailable");
        expect(gateway.requests).toHaveLength(1);
        expect(existsSync(root.profileMarker)).toBe(false);
        expectNoHostileExecutables(root);
        expectNoCommandArtifacts(root);
      }
    },
    TIMEOUT,
  );
  test(
    "hx ask blocks approval-bearing commands before side effects",
    async () => {
      const root = createIsolatedRoot();
      const marker = join(root.workspace, "must-not-exist");
      const gateway = startFakeGateway([toolCall("touch must-not-exist")]);
      const result = await runFx(
        ["ask", "--json", "--no-save", "Create the marker."],
        {
          cwd: root.workspace,
          env: gatewayEnv(root, gateway, {
            PATH: hostilePath(root),
            FX_PERMISSION_MODE: "ask",
          }),
          timeoutMs: TIMEOUT,
        },
      );

      expect(result.code).toBe(1);
      expect(existsSync(marker)).toBe(false);
      expect(result.stderr).toContain("permission required");
      expect(result.stderr).toContain("noninteractive_permission_prompt_unavailable");
      expect(existsSync(root.profileMarker)).toBe(false);
      expectNoHostileExecutables(root);
    },
    TIMEOUT,
  );
  test(
    "hx ask blocks hostile git before any executable or repository access",
    async () => {
      const root = createIsolatedRoot();
      const gateway = startFakeGateway([
        toolCall("git status"),
        finalText("git inspection complete"),
      ]);
      const result = await runFx(
        ["ask", "--json", "--no-save", "Inspect repository status."],
        {
          cwd: root.workspace,
          env: gatewayEnv(root, gateway, {
            PATH: hostilePath(root),
            FX_PERMISSION_MODE: "ask",
          }),
          timeoutMs: TIMEOUT,
        },
      );

      expect(result.code).toBe(1);
      expect(result.stderr).toContain("permission required");
      expect(result.stderr).toContain("noninteractive_permission_prompt_unavailable");
      expect(existsSync(root.profileMarker)).toBe(false);
      expectNoHostileExecutables(root);
      expectNoCommandArtifacts(root);
    },
    TIMEOUT,
  );
  test(
    "ACP completes more than twenty-five serial terminal calls when unlimited",
    async () => {
      const root = createIsolatedRoot();
      writeFileSync(
        join(root.home, ".fx", "settings.json"),
        JSON.stringify({
          sandbox: "none",
          permission: { bash: { pwd: "allow" } },
          maxxing_mode: "legacy",
        }),
      );
      const gateway = startFakeGateway([
        ...Array.from(
          { length: 26 },
          (_, index) => toolCall("pwd", { profile: "clean" }, `acp_${index + 1}`),
        ),
        finalText("acp unlimited complete"),
      ]);
      activeClient = AcpClient.create(root.workspace, gatewayEnv(root, gateway, {
        PATH: hostilePath(root),
      }));
      await startAcpSession(activeClient);
      const messages = await runAcpPrompt(activeClient, "Run pwd until you can answer.");
      await activeClient.close();

      expect(JSON.stringify(messages)).toContain("acp unlimited complete");
      expect(gateway.requests).toHaveLength(27);
      expect(activeClient.stderr).toBe("");
      expect(existsSync(root.profileMarker)).toBe(false);
      expectNoHostileExecutables(root);
      expectNoCommandArtifacts(root);
      activeClient = null;
    },
    TIMEOUT,
  );
  test(
    "ACP blocks redirected output before creating a file",
    async () => {
      const root = createIsolatedRoot();
      const marker = join(root.workspace, "must-not-exist");
      const gateway = startFakeGateway([
        toolCall("printf x > must-not-exist"),
        finalText("acp denial complete"),
      ]);
      activeClient = AcpClient.create(root.workspace, gatewayEnv(root, gateway, {
        PATH: hostilePath(root),
      }));
      await startAcpSession(activeClient);
      const messages = await runAcpPrompt(activeClient, "Create redirected output.");
      await activeClient.close();

      const serialized = JSON.stringify(messages);
      expect(serialized).toContain("request_permission");
      expect(serialized).toContain("user_denied");
      expect(existsSync(marker)).toBe(false);
      expect(existsSync(root.profileMarker)).toBe(false);
      expectNoHostileExecutables(root);
      expect(activeClient.stderr).toBe("");
      activeClient = null;
    },
    TIMEOUT,
  );
});

class AcpClient {
  private buffer = "";
  private lines: string[] = [];
  private waiters: Array<(line: string) => void> = [];
  private closed = false;
  private stderrChunks: Buffer[] = [];

  private constructor(private proc: ChildProcess) {
    proc.stdout!.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString();
      const parts = this.buffer.split("\n");
      this.buffer = parts.pop() ?? "";
      for (const line of parts) {
        if (!line.trim()) continue;
        const waiter = this.waiters.shift();
        if (waiter) waiter(line);
        else this.lines.push(line);
      }
    });
    proc.stderr!.on("data", (chunk: Buffer) => this.stderrChunks.push(chunk));
    proc.on("close", () => {
      this.closed = true;
    });
  }

  static create(cwd: string, env: Record<string, string | undefined>) {
    return new AcpClient(nodeSpawn(FX_BIN, ["acp"], {
      cwd,
      env: definedEnv(adaptRetiredGatewayTestEnv({ ...process.env, ...env, NO_COLOR: "1" })),
      stdio: ["pipe", "pipe", "pipe"],
    }));
  }

  get stderr() {
    return Buffer.concat(this.stderrChunks).toString();
  }

  send(message: object) {
    this.proc.stdin!.write(`${JSON.stringify(message)}\n`);
  }

  async readLine(timeoutMs = TIMEOUT): Promise<any> {
    const line = await new Promise<string>((resolve, reject) => {
      const buffered = this.lines.shift();
      if (buffered) {
        resolve(buffered);
        return;
      }
      const timer = setTimeout(() => reject(new Error("ACP read timeout")), timeoutMs);
      this.waiters.push((value) => {
        clearTimeout(timer);
        resolve(value);
      });
    });
    const message = JSON.parse(line);
    if (message.method === "session/request_permission" && message.id !== undefined) {
      this.send({
        jsonrpc: "2.0",
        id: message.id,
        result: { outcome: { outcome: "selected", optionId: "reject_once" } },
      });
    }
    return message;
  }

  async request(method: string, params: object, id: number) {
    this.send({ jsonrpc: "2.0", id, method, params });
    return this.readLine();
  }

  async close() {
    if (this.closed) return;
    this.proc.stdin!.end();
    this.proc.kill("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (!this.closed) this.proc.kill("SIGKILL");
  }
}

async function startAcpSession(client: AcpClient, modeId: "ask" | "code" = "ask") {
  await client.request("initialize", { protocolVersion: 1 }, 1);
  await client.request("session/new", { mcpServers: [] }, 2);
  await client.readLine();
  await client.request("session/set_mode", { modeId }, 3);
}

async function runAcpPrompt(client: AcpClient, text: string) {
  const id = 10;
  client.send({
    jsonrpc: "2.0",
    id,
    method: "session/prompt",
    params: { prompt: [{ type: "text", text }] },
  });
  const messages: any[] = [];
  while (true) {
    const message = await client.readLine();
    if (message.id === id && message.result) return messages;
    messages.push(message);
  }
}
