import { describe, expect, it } from "vitest";
import { getModelUpstreamId } from "../../open-sse/config/providerModels.js";
import { parseModel } from "../../open-sse/services/model.js";

describe("DeepSeek direct model aliases", () => {
  it("sends the supported GA model id for V4.1 Flash", () => {
    expect(parseModel("ds/deepseek-v4.1-flash").provider).toBe("deepseek");
    expect(getModelUpstreamId("deepseek", "deepseek-v4.1-flash")).toBe("deepseek-flash");
  });
});
