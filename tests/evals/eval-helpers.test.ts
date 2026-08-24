import { describe, expect, test } from "bun:test";
import { adaptRetiredGatewayTestEnv } from "../e2e/direct-provider-env";
import { buildEvalProcessEnv, shouldLoadDotEnv } from "./eval-helpers";

describe("eval helpers", () => {
  test("passes the selected eval model to fx through FX_MODEL", () => {
    const previous = process.env.FX_MODEL;
    process.env.FX_MODEL = "ambient/model";

    try {
      const env = buildEvalProcessEnv("/tmp/fx-eval-home-test", "selected/model");

      expect(env.FX_MODEL).toBe("selected/model");
      expect(env.HOME).toBe("/tmp/fx-eval-home-test");
      expect(env.NO_COLOR).toBe("1");
    } finally {
      if (previous === undefined) {
        delete process.env.FX_MODEL;
      } else {
        process.env.FX_MODEL = previous;
      }
    }
  });

  test("does not load repository dotenv files in a hermetic run", () => {
    expect(shouldLoadDotEnv({ FX_E2E_DISABLE_DOTENV: "1" })).toBe(false);
    expect(shouldLoadDotEnv({})).toBe(true);
  });

  test("strips retired gateway env keys without remapping them", () => {
    const env = adaptRetiredGatewayTestEnv({
      AI_GATEWAY_API_KEY: "gateway-key",
      VERCEL_OIDC_TOKEN: "oidc-token",
      FX_GATEWAY_BASE_URL: "http://127.0.0.1:9",
      FX_GATEWAY_CHAT_URL: "http://127.0.0.1:9/v3/ai/language-model",
      FX_E2E_GATEWAY_CHAT_URL: "http://127.0.0.1:9/v3/ai/language-model",
      FX_MODEL: "claude-sonnet-4-6",
    });
    expect(env.AI_GATEWAY_API_KEY).toBeUndefined();
    expect(env.VERCEL_OIDC_TOKEN).toBeUndefined();
    expect(env.FX_GATEWAY_CHAT_URL).toBeUndefined();
    expect(env.FX_GATEWAY_BASE_URL).toBeUndefined();
    expect(env.FX_E2E_GATEWAY_CHAT_URL).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(env.GROK_CLI_CHAT_PROXY_BASE_URL).toBeUndefined();
  });
});
