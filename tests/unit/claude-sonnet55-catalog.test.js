import { describe, expect, it } from "vitest";
import { getProviderModels, isValidModel } from "../../open-sse/config/providerModels.js";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";
import { MODEL_PRICING } from "../../open-sse/providers/pricing.js";
import { CLI_TOOLS } from "../../src/shared/constants/cliTools.js";

describe("Claude Sonnet 5.5", () => {
  it("is available through the Claude Code provider without removing Sonnet 5", () => {
    const models = getProviderModels("cc");
    expect(models).toContainEqual(expect.objectContaining({ id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5" }));
    expect(isValidModel("cc", "claude-sonnet-5-5")).toBe(true);
    expect(isValidModel("cc", "claude-sonnet-5")).toBe(true);
  });

  it("uses the published context, thinking and base pricing", () => {
    expect(getCapabilitiesForModel("claude", "claude-sonnet-5-5")).toMatchObject({
      vision: true,
      reasoning: true,
      thinkingFormat: "claude-adaptive",
      contextWindow: 1000000,
      maxOutput: 128000,
    });
    expect(MODEL_PRICING["claude-sonnet-5-5"]).toMatchObject({
      input: 2,
      output: 10,
      cached: 0.2,
      cache_creation: 2.5,
    });
  });

  it("offers Sonnet 5.5 as the default Claude Code Sonnet mapping", () => {
    const sonnet = CLI_TOOLS.claude.defaultModels.find((model) => model.id === "sonnet");
    expect(sonnet?.defaultValue).toBe("cc/claude-sonnet-5-5");
  });
});
