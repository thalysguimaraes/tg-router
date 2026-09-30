import { describe, expect, it, vi } from "vitest";
import { handleStreamingResponse } from "../../open-sse/handlers/chatCore/streamingHandler.js";
import { createStreamController } from "../../open-sse/utils/streamHandler.js";
import { cloakClaudeTools } from "../../open-sse/utils/claudeCloaking.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

vi.mock("@/lib/usageDb.js", () => ({
  saveRequestDetail: vi.fn().mockResolvedValue(undefined),
  saveRequestUsage: vi.fn().mockResolvedValue(undefined),
  appendRequestLog: vi.fn().mockResolvedValue(undefined),
  trackPendingRequest: vi.fn(),
}));

describe("Claude streaming handler tool names", () => {
  it.each(["shell_command", "code_exec_ide"])("restores %s through the actual handler and preserves the SSE payload", async (name) => {
    const body = { messages: [], tools: [{ name, input_schema: { type: "object", properties: {} } }] };
    const cloaked = cloakClaudeTools(body);
    const events = [
      { type: "message_start", message: { id: "msg_probe", type: "message", role: "assistant", content: [], usage: { input_tokens: 7, output_tokens: 0 } } },
      { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Check tools." } },
      { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "opaque-signature" } },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_probe", name: cloaked.body.tools[0].name, input: {} } },
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"value":"ok"}' } },
      { type: "content_block_stop", index: 1 },
      { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 12 } },
      { type: "message_stop" },
    ];
    const wire = new TextEncoder().encode(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""));
    const upstream = new ReadableStream({ start(controller) {
      for (let offset = 0; offset < wire.length; offset += 17) controller.enqueue(wire.slice(offset, offset + 17));
      controller.close();
    } });
    const result = await handleStreamingResponse({
      providerResponse: new Response(upstream, { headers: { "content-type": "text/event-stream" } }),
      provider: "claude", model: "claude-opus-5-5", sourceFormat: FORMATS.CLAUDE, targetFormat: FORMATS.CLAUDE,
      body, translatedBody: cloaked.body, toolNameMap: cloaked.toolNameMap, stream: true, requestStartTime: Date.now(),
      streamController: createStreamController(),
    });
    const output = await result.response.text();
    const actual = output.split("\n").filter(line => line.startsWith("data: {")).map(line => JSON.parse(line.slice(6)));
    const expected = structuredClone(events);
    expected[5].content_block.name = name;
    expect(actual).toEqual(expected);
    expect(output).not.toContain("data: [DONE]");
  });
});
