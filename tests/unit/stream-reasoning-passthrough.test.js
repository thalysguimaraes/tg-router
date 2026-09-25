import { describe, it, expect } from "vitest";
import { createSSEStream } from "../../open-sse/utils/stream.js";

// Cerebras and other OpenAI-compatible upstreams stream reasoning as `delta.reasoning`
// (not `reasoning_content`). Passthrough must forward those chunks as they arrive;
// dropping them leaves the client silent for the whole reasoning phase.
async function passthrough(lines) {
  const stream = createSSEStream({ mode: "passthrough", provider: "cerebras", model: "gpt-oss-120b" });
  const enc = new TextEncoder();
  const source = new ReadableStream({
    start(controller) {
      for (const line of lines) controller.enqueue(enc.encode(line));
      controller.close();
    },
  });
  const out = await new Response(source.pipeThrough(stream)).text();
  return out.split("\n").filter((l) => l.startsWith("data:") && l !== "data: [DONE]").map((l) => JSON.parse(l.slice(5)));
}

const chunk = (delta, extra = {}) =>
  `data: ${JSON.stringify({ id: "chatcmpl-abcdef123", object: "chat.completion.chunk", created: 1, choices: [{ index: 0, delta, ...extra }] })}\n\n`;

describe("passthrough reasoning deltas", () => {
  it("forwards delta.reasoning chunks instead of dropping them", async () => {
    const events = await passthrough([
      chunk({ role: "assistant" }),
      chunk({ reasoning: "Think " }),
      chunk({ reasoning: "harder." }),
      chunk({ content: "pong" }),
    ]);
    expect(events.map((e) => e.choices[0].delta.reasoning).filter(Boolean)).toEqual(["Think ", "harder."]);
  });

  it("still drops empty deltas", async () => {
    const events = await passthrough([chunk({ role: "assistant" }), chunk({ reasoning: "" }), chunk({})]);
    expect(events).toHaveLength(1);
  });
});
