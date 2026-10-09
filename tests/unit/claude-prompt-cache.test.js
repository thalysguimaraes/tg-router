import { describe, expect, it } from "vitest";
import { anchorClaudeCache, prepareClaudeRequest } from "../../open-sse/translator/formats/claude.js";

const marker = (ttl) => ({ type: "ephemeral", ...(ttl ? { ttl } : {}) });
const text = (value, cache_control) => ({
  type: "text",
  text: value,
  ...(cache_control ? { cache_control } : {}),
});
const body = (extra = {}) => ({
  model: "claude-sonnet-5",
  max_tokens: 100,
  system: [text("system")],
  messages: [
    { role: "user", content: [text("question")] },
    { role: "assistant", content: [text("answer")] },
  ],
  ...extra,
});

describe("Claude prompt cache", () => {
  it("preserves client markers and TTLs in prepare and passthrough paths", () => {
    const explicit = marker("5m");
    const input = body({
      system: [text("system", explicit)],
      messages: [
        { role: "user", content: [text("question", explicit)] },
        { role: "assistant", content: [text("answer")] },
      ],
    });

    const prepared = prepareClaudeRequest(structuredClone(input), "claude");
    expect(prepared.system[0].cache_control).toEqual(explicit);
    expect(prepared.messages[0].content[0].cache_control).toEqual(explicit);
    expect(prepared.messages[1].content[0].cache_control).toBeUndefined();

    const passthrough = anchorClaudeCache(structuredClone(input));
    expect(passthrough.system[0].cache_control).toEqual(explicit);
    expect(passthrough.messages[0].content[0].cache_control).toEqual(explicit);
    expect(passthrough.messages[1].content[0].cache_control).toBeUndefined();
  });

  it("trims over-budget client marks from earliest to latest four", () => {
    const input = body({
      system: [text("system", marker("5m"))],
      messages: [{
        role: "user",
        content: Array.from({ length: 5 }, (_, i) => text(`block ${i}`, marker(i === 4 ? "1h" : "5m"))),
      }],
    });
    const out = prepareClaudeRequest(input, "claude");

    expect(out.system[0].cache_control).toBeUndefined();
    expect(out.messages[0].content[0].cache_control).toBeUndefined();
    expect(out.messages[0].content.slice(1).map(block => block.cache_control)).toEqual([
      marker("5m"), marker("5m"), marker("5m"), marker("1h"),
    ]);
  });

  it("does not add or change markers for unmarked requests beyond router defaults", () => {
    const out = prepareClaudeRequest(body({
      tools: [{ name: "search", input_schema: { type: "object" } }],
    }), "claude");

    expect(out.system[0].cache_control).toEqual(marker("1h"));
    expect(out.tools[0].cache_control).toEqual(marker("1h"));
    expect(out.messages[1].content[0].cache_control).toEqual(marker());
    expect(out.messages[0].content[0].cache_control).toBeUndefined();
  });

  it("keeps only cacheable tool markers when deferred tools carry client marks", () => {
    const out = prepareClaudeRequest(body({
      tools: [
        { name: "cached", input_schema: {}, cache_control: marker("5m") },
        { name: "deferred", input_schema: {}, defer_loading: true, cache_control: marker("5m") },
      ],
    }), "claude");

    expect(out.tools[0].cache_control).toEqual(marker("5m"));
    expect(out.tools[1].cache_control).toBeUndefined();
  });
});
