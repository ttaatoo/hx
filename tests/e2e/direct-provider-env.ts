import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const FAKE_DIRECT_MODEL = "openai/gpt-5";
export const SUPERGROK_MODEL = "grok-4.6";
export const SUPERGROK_FAST_MODEL = "grok-code-fast-1";
export const SUPERGROK_MODELS = [SUPERGROK_MODEL, SUPERGROK_FAST_MODEL] as const;

export const E2E_GROK_AUTH = {
  version: 1,
  access_token: "grok-e2e-access",
  refresh_token: "grok-e2e-refresh",
  expires_at_ms: 4_102_444_800_000,
  client_id: "b1a00492-073a-47ea-816f-4c329264a828",
} as const;

function isLoopbackUrl(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const host = new URL(value).hostname;
    return host === "127.0.0.1" || host === "localhost" || host === "[::1]";
  } catch {
    return false;
  }
}

function originOf(value: string): string {
  try {
    return new URL(value).origin;
  } catch {
    return value;
  }
}

function ensureFxDir(home: string): string {
  const fxDir = join(home, ".hx");
  mkdirSync(fxDir, { recursive: true, mode: 0o700 });
  chmodSync(fxDir, 0o700);
  return fxDir;
}

export function writeE2eGrokAuth(home: string): string {
  const fxDir = ensureFxDir(home);
  const path = join(fxDir, "grok-auth.json");
  writeFileSync(path, `${JSON.stringify(E2E_GROK_AUTH)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

export function shouldWriteE2eGrokAuth(
  env: Record<string, string | undefined>,
): boolean {
  if (env.FX_E2E_NO_GROK_AUTH === "1") return false;
  if (env.FX_SKIP_ONBOARDING === "0") return false;
  return typeof env.HOME === "string" && env.HOME.length > 0;
}

function isUnwritableHome(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "EACCES" ||
    (error as NodeJS.ErrnoException | undefined)?.code === "EPERM";
}

function writeE2eGrokAuthIfPossible(home: string): boolean {
  try {
    writeE2eGrokAuth(home);
    return true;
  } catch (error) {
    if (isUnwritableHome(error)) return false;
    throw error;
  }
}

export function maybeWriteE2eGrokAuth(
  env: Record<string, string | undefined>,
): void {
  if (!shouldWriteE2eGrokAuth(env) || !env.HOME) return;
  const path = join(env.HOME, ".hx", "grok-auth.json");
  if (!existsSync(path)) writeE2eGrokAuthIfPossible(env.HOME);
}

export function ensureTuiSupergrokHome(
  home: string | undefined,
  env: Record<string, string | undefined> = {},
): void {
  if (!home || env.FX_E2E_NO_GROK_AUTH === "1" || env.FX_SKIP_ONBOARDING === "0") {
    return;
  }
  const wantsLoopbackChat = isLoopbackUrl(env.GROK_CLI_CHAT_PROXY_BASE_URL) ||
    isLoopbackUrl(env.FX_E2E_GATEWAY_CHAT_URL) ||
    isLoopbackUrl(env.FX_GATEWAY_CHAT_URL);
  if (!wantsLoopbackChat) return;
  if (!writeE2eGrokAuthIfPossible(home)) return;
  if (!existsSync(join(home, ".hx", "providers.json"))) {
    try {
      writeE2eXaiProviders(home);
    } catch (error) {
      if (isUnwritableHome(error)) return;
      throw error;
    }
  }
}

function readProviders(home: string): {
  providers: Record<string, Record<string, unknown>>;
} {
  const path = join(home, ".hx", "providers.json");
  if (!existsSync(path)) return { providers: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as {
      providers?: Record<string, Record<string, unknown>>;
    };
    return { providers: parsed.providers ?? {} };
  } catch {
    return { providers: {} };
  }
}

function writeProviders(
  home: string,
  providers: Record<string, Record<string, unknown>>,
): void {
  const fxDir = ensureFxDir(home);
  writeFileSync(
    join(fxDir, "providers.json"),
    `${JSON.stringify({ providers })}\n`,
    { mode: 0o600 },
  );
}

export function writeE2eAnthropicProviders(
  home: string,
  baseUrl: string | undefined,
  model?: string,
): void {
  const current = readProviders(home);
  const models = new Set<string>([
    FAKE_DIRECT_MODEL,
    "claude-opus-4-6",
    "claude-sonnet-4-6",
  ]);
  if (model && model.trim().length > 0) models.add(model.trim());
  current.providers.anthropic = {
    api: "anthropic-messages",
    baseUrl: baseUrl && baseUrl.length > 0 ? baseUrl : "https://api.anthropic.com",
    apiKey: "$ANTHROPIC_API_KEY",
    models: [...models].map((id) => ({ id })),
  };
  writeProviders(home, current.providers);
}

export function writeE2eXaiProviders(
  home: string,
  options: {
    models?: readonly string[];
    baseUrl?: string;
  } = {},
): void {
  writeE2eGrokAuth(home);
  const current = readProviders(home);
  const models = options.models ?? SUPERGROK_MODELS;
  current.providers.xai = {
    api: "openai-completions",
    ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
    models: [...models].map((id) => ({ id })),
  };
  writeProviders(home, current.providers);
}

export function adaptRetiredGatewayTestEnv(
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const next: Record<string, string | undefined> = { ...env };
  const chatUrl = next.FX_E2E_GATEWAY_CHAT_URL ?? next.FX_GATEWAY_CHAT_URL;
  const loopback = isLoopbackUrl(chatUrl) || isLoopbackUrl(next.FX_E2E_GATEWAY_MODELS_URL);
  const remapping = loopback || !!(next.AI_GATEWAY_API_KEY && chatUrl);
  if (remapping) {
    if (!next.ANTHROPIC_API_KEY && next.AI_GATEWAY_API_KEY) {
      next.ANTHROPIC_API_KEY = next.AI_GATEWAY_API_KEY;
    }
    if (chatUrl && !next.ANTHROPIC_BASE_URL) {
      next.ANTHROPIC_BASE_URL = originOf(chatUrl);
    }
    if (chatUrl && !next.GROK_CLI_CHAT_PROXY_BASE_URL) {
      next.GROK_CLI_CHAT_PROXY_BASE_URL = `${originOf(chatUrl)}/v1`;
    }
  }
  delete next.AI_GATEWAY_API_KEY;
  delete next.VERCEL_OIDC_TOKEN;
  delete next.FX_E2E_GATEWAY_CHAT_URL;
  delete next.FX_E2E_GATEWAY_MODELS_URL;
  delete next.FX_E2E_GATEWAY_CREDITS_URL;
  delete next.FX_GATEWAY_CHAT_URL;
  delete next.FX_GATEWAY_BASE_URL;
  const model = next.FX_MODEL?.trim() ?? "";
  const wantsAnthropicCatalog =
    model === FAKE_DIRECT_MODEL ||
    model.startsWith("claude-") ||
    model.startsWith("anthropic/");
  if (
    next.HOME &&
    next.ANTHROPIC_API_KEY &&
    wantsAnthropicCatalog &&
    next.FX_E2E_NO_GROK_AUTH !== "1" &&
    !existsSync(join(next.HOME, ".hx", "providers.json"))
  ) {
    writeE2eAnthropicProviders(next.HOME, next.ANTHROPIC_BASE_URL, model);
  }
  if (remapping) maybeWriteE2eGrokAuth(next);
  return next;
}
