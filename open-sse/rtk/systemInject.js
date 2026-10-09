// Shared system-prompt injector: appends an instruction into the system message of
// the final request body, dispatching by format so it works for translated and
// native-passthrough flows. Used by caveman.js and ponytail.js.

import { FORMATS } from "../translator/formats.js";
import { OPENAI_BLOCK, CLAUDE_BLOCK, RESPONSES_ITEM } from "../translator/schema/blocks.js";
import { ROLE } from "../translator/schema/roles.js";

const SEP = "\n\n";

// Prompt injection changes the request body. A request carrying typed media is
// deliberately left byte-for-byte intact because the extra system block can
// interfere with multimodal request behavior.
// Keep this list limited to content discriminators. In particular, do not
// search the whole body for words such as "image" — tool schemas and ordinary
// text are allowed to contain those words.
const RESPONSES_INPUT_FILE = RESPONSES_ITEM.INPUT_FILE || "input_file";
const MEDIA_BLOCK_TYPES = new Set([
  OPENAI_BLOCK.IMAGE_URL,
  OPENAI_BLOCK.IMAGE,
  OPENAI_BLOCK.INPUT_AUDIO,
  OPENAI_BLOCK.AUDIO_URL,
  OPENAI_BLOCK.FILE,
  CLAUDE_BLOCK.IMAGE,
  CLAUDE_BLOCK.DOCUMENT,
  RESPONSES_ITEM.INPUT_IMAGE,
  RESPONSES_INPUT_FILE,
]);

export function injectSystemPrompt(body, format, prompt) {
  try {
    if (!body || !prompt) return;
    if (typeof body !== "object") return;

    // Caveman and ponytail are intentionally skipped for every known media
    // shape. This guard runs before format dispatch so it also covers native
    // passthrough bodies and wrappers such as Antigravity/Kiro.
    if (bodyHasMedia(body)) return;

    // Kiro wire shape is unique (conversationState) — handle directly.
    if (isKiroBody(body) || format === FORMATS.KIRO) {
      injectKiroSystem(body, prompt);
      return;
    }

    // Claude/Gemini own a dedicated system field, yet their bodies also carry
    // messages[]/contents[] — decide by format label before the shape sniff below.
    // Anthropic rejects a "system" role inside messages[] (no such input role).
    if (format === FORMATS.CLAUDE) {
      injectClaudeSystem(body, prompt);
      return;
    }
    if (format === FORMATS.GEMINI || format === FORMATS.GEMINI_CLI
      || format === FORMATS.VERTEX || format === FORMATS.ANTIGRAVITY) {
      // Antigravity wraps Gemini shape in body.request → injectGeminiSystem handles it
      injectGeminiSystem(body, prompt);
      return;
    }

    // Dispatch by actual wire shape for OpenAI-shaped formats.
    // instructions string takes precedence; messages[] means Chat; input[] means Responses.
    if (typeof body.instructions === "string") {
      injectInstructionsSystem(body, prompt);
      return;
    }
    if (Array.isArray(body.messages)) {
      injectChatSystem(body, prompt);
      return;
    }
    if (Array.isArray(body.input)) {
      // Responses input[]: empty array already normalized elsewhere; string stays untouched here
      injectResponsesInputSystem(body, prompt);
      return;
    }
    if (typeof body.input === "string") {
      // string input must stay untouched
      return;
    }

    // OpenAI-shaped but no array (e.g. empty body) — no-op
  } catch (_) {
    // fail-open
  }
}

// Scan only content-shaped subtrees. This catches media nested inside
// tool_result blocks without inspecting tools, schemas, arbitrary metadata, or
// serialized text that happens to mention an image.
export function bodyHasMedia(body) {
  const seen = new Set();
  const contentHasMedia = (value) => {
    if (!value || typeof value !== "object" || seen.has(value)) return false;
    seen.add(value);
    if (isMediaBlock(value)) return true;
    if (Array.isArray(value)) return value.some(contentHasMedia);
    return contentHasMedia(value.content) || contentHasMedia(value.parts);
  };
  const messagesHaveMedia = (messages) => messages.some((message) =>
    (Array.isArray(message?.images) && message.images.length > 0)
    || contentHasMedia(message?.content)
  );
  const responsesHaveMedia = (input) => input.some((item) =>
    isMediaBlock(item)
    || contentHasMedia(item?.content)
    || ((item?.type === RESPONSES_ITEM.FUNCTION_CALL_OUTPUT
      || item?.type === RESPONSES_ITEM.CUSTOM_TOOL_CALL_OUTPUT)
      && contentHasMedia(item.output))
  );
  const geminiTargetHasMedia = (target) => {
    const contents = Array.isArray(target?.contents) ? target.contents : [];
    return contents.some((content) => contentHasMedia(content?.parts))
      || contentHasMedia(target?.systemInstruction?.parts)
      || contentHasMedia(target?.system_instruction?.parts);
  };
  const kiroHasMedia = (state) => {
    if (!state || typeof state !== "object") return false;
    const turns = [
      ...(Array.isArray(state.history) ? state.history : []),
      state.currentMessage,
    ];
    return turns.some((turn) => {
      const user = turn?.userInputMessage;
      return (Array.isArray(user?.images) && user.images.length > 0)
        || contentHasMedia(user?.content)
        || contentHasMedia(user?.userInputMessageContext?.toolResults)
        || contentHasMedia(turn?.assistantResponseMessage?.content);
    });
  };

  if (Array.isArray(body?.messages) && messagesHaveMedia(body.messages)) return true;
  if (Array.isArray(body?.input) && responsesHaveMedia(body.input)) return true;
  if (geminiTargetHasMedia(body) || geminiTargetHasMedia(body?.request)) return true;
  return kiroHasMedia(body?.conversationState);
}

function isMediaBlock(value) {
  if (!value || typeof value !== "object") return false;
  return MEDIA_BLOCK_TYPES.has(value.type)
    || (value.inlineData && typeof value.inlineData === "object")
    || (value.fileData && typeof value.fileData === "object");
}

function isKiroBody(body) {
  if (!body || typeof body !== "object") return false;
  const cs = body.conversationState;
  if (!cs || typeof cs !== "object") return false;
  // A top-level `systemPrompt` used to be the marker, but the Kiro translator no
  // longer emits it (kiro.dev rejects the field), so gate on the turn shape.
  const historyTurn = Array.isArray(cs.history)
    && cs.history.some(it => it && (it.userInputMessage || it.assistantResponseMessage));
  return historyTurn || !!(cs.currentMessage && cs.currentMessage.userInputMessage);
}

// Exact idempotency: prompt present as its own SEP-delimited segment (or the
// whole string), not as a substring of unrelated text.
function hasPrompt(haystack, prompt) {
  if (!haystack || typeof haystack !== "string") return false;
  if (haystack === prompt) return true;
  return haystack.split(SEP).includes(prompt);
}

function dedupStringAppend(curr, prompt) {
  if (!curr) return prompt;
  if (hasPrompt(curr, prompt)) return curr;
  return `${curr}${SEP}${prompt}`;
}

// ---- OpenAI instructions string ----
function injectInstructionsSystem(body, prompt) {
  try {
    const curr = body.instructions;
    if (typeof curr !== "string") return;
    if (hasPrompt(curr, prompt)) return;
    const next = curr ? `${curr}${SEP}${prompt}` : prompt;
    try { body.instructions = next; } catch (_) { /* frozen/proxy fail-open */ }
  } catch (_) {}
}

// ---- Chat messages[] ----
function injectChatSystem(body, prompt) {
  try {
    const arr = body.messages;
    if (!Array.isArray(arr)) return;
    // Exact idempotency: scan existing system/developer content for full prompt
    if (containsPromptInMessages(arr, prompt)) return;
    let idx = -1;
    try { idx = arr.findIndex(m => m && (m.role === ROLE.SYSTEM || m.role === ROLE.DEVELOPER)); } catch (_) { return; }
    if (idx >= 0) {
      appendToChatMessage(arr[idx], prompt);
    } else {
      // create typed system message at index 0; fail-open on frozen/proxy
      try { arr.unshift({ role: ROLE.SYSTEM, content: prompt }); } catch (_) {}
    }
  } catch (_) {}
}

function containsPromptInMessages(arr, prompt) {
  try {
    for (const m of arr) {
      if (!m || (m.role !== ROLE.SYSTEM && m.role !== ROLE.DEVELOPER)) continue;
      const c = m.content;
      if (typeof c === "string" && hasPrompt(c, prompt)) return true;
      if (Array.isArray(c)) {
        for (const part of c) {
          if (part && typeof part.text === "string" && hasPrompt(part.text, prompt)) return true;
        }
      }
    }
  } catch (_) {}
  return false;
}

function appendToChatMessage(msg, prompt) {
  try {
    if (!msg || typeof msg !== "object") return;
    const c = msg.content;
    if (typeof c === "string") {
      const next = dedupStringAppend(c, prompt);
      if (next === c) return;
      // avoid partial mutation: try assignment, bail if setter throws
      try { msg.content = next; } catch (_) {}
      return;
    }
    if (Array.isArray(c)) {
      // already deduped at message level; but guard block-level too
      try {
        if (c.some(b => b && b.text === prompt)) return;
      } catch (_) {}
      try { c.push({ type: OPENAI_BLOCK.TEXT, text: prompt }); } catch (_) {}
      return;
    }
    try { msg.content = prompt; } catch (_) {}
  } catch (_) {}
}

// ---- Responses input[] ----
function injectResponsesInputSystem(body, prompt) {
  try {
    const arr = body.input;
    if (!Array.isArray(arr)) return;
    // instructions already handled above
    if (containsPromptInResponsesInput(arr, prompt)) return;
    // find system/developer message items only (type === message)
    let idx = -1;
    try {
      idx = arr.findIndex(m => m && m.type === RESPONSES_ITEM.MESSAGE && (m.role === ROLE.SYSTEM || m.role === ROLE.DEVELOPER));
    } catch (_) { return; }
    if (idx >= 0) {
      appendToResponsesMessage(arr[idx], prompt);
    } else {
      const msg = { type: RESPONSES_ITEM.MESSAGE, role: ROLE.SYSTEM, content: [{ type: RESPONSES_ITEM.INPUT_TEXT, text: prompt }] };
      try { arr.unshift(msg); } catch (_) {}
    }
  } catch (_) {}
}

function containsPromptInResponsesInput(arr, prompt) {
  try {
    for (const item of arr) {
      if (!item || item.type !== RESPONSES_ITEM.MESSAGE) continue;
      if (item.role !== ROLE.SYSTEM && item.role !== ROLE.DEVELOPER) continue;
      const c = item.content;
      if (typeof c === "string" && hasPrompt(c, prompt)) return true;
      if (Array.isArray(c)) {
        for (const part of c) {
          if (part && typeof part.text === "string" && hasPrompt(part.text, prompt)) return true;
        }
      }
    }
  } catch (_) {}
  return false;
}

function appendToResponsesMessage(msg, prompt) {
  try {
    if (!msg || typeof msg !== "object") return;
    const c = msg.content;
    if (typeof c === "string") {
      const next = dedupStringAppend(c, prompt);
      if (next === c) return;
      try { msg.content = next; } catch (_) {}
      return;
    }
    if (Array.isArray(c)) {
      try { if (c.some(b => b && b.text === prompt)) return; } catch (_) {}
      try { c.push({ type: RESPONSES_ITEM.INPUT_TEXT, text: prompt }); } catch (_) {}
      return;
    }
    try { msg.content = [{ type: RESPONSES_ITEM.INPUT_TEXT, text: prompt }]; } catch (_) {}
  } catch (_) {}
}

// ---- Claude ----
function injectClaudeSystem(body, prompt) {
  try {
    const sys = body.system;
    if (typeof sys === "string") {
      if (hasPrompt(sys, prompt)) return;
      const next = sys.length > 0 ? `${sys}${SEP}${prompt}` : prompt;
      try { body.system = next; } catch (_) {}
      return;
    }
    if (Array.isArray(sys)) {
      try { if (sys.some(b => b && b.text === prompt)) return; } catch (_) {}
      const block = { type: CLAUDE_BLOCK.TEXT, text: prompt };
      let lastCacheIdx = -1;
      try {
        for (let i = sys.length - 1; i >= 0; i--) {
          if (sys[i]?.cache_control) { lastCacheIdx = i; break; }
        }
      } catch (_) {}
      try {
        if (lastCacheIdx >= 0) sys.splice(lastCacheIdx, 0, block);
        else sys.push(block);
      } catch (_) {}
      return;
    }
    // absent/null
    try { body.system = prompt; } catch (_) {}
  } catch (_) {}
}

// ---- Gemini ----
function injectGeminiSystem(body, prompt) {
  try {
    let target = body;
    try {
      if (body.request && typeof body.request === "object") target = body.request;
    } catch (_) {}
    let useSnake = false;
    try { useSnake = Object.prototype.hasOwnProperty.call(target, "system_instruction"); } catch (_) {}
    const key = useSnake ? "system_instruction" : "systemInstruction";
    let sys;
    try { sys = target[key]; } catch (_) { sys = undefined; }
    if (sys && Array.isArray(sys.parts)) {
      try { if (sys.parts.some(p => p && p.text === prompt)) return; } catch (_) {}
      try { sys.parts.push({ text: prompt }); } catch (_) {}
      return;
    }
    try { target[key] = { parts: [{ text: prompt }] }; } catch (_) {}
  } catch (_) {}
}

// ---- Kiro ----
// The prompt is appended to the first user turn's content — the same place the
// Kiro translator already mirrors the system text via its contentPrefix.
//
// A top-level `systemPrompt` is deliberately NOT written: the kiro.dev gateway
// answers any body carrying that field with
//   400 {"message":"Improperly formed request.","reason":"REQUEST_BODY_INVALID"}
// The translator stopped emitting it in v0.5.59, but this injector kept adding
// it back, so every kr/ model failed whenever an RTK prompt (caveman, ponytail)
// was active.
function injectKiroSystem(body, prompt) {
  try {
    const cs = body.conversationState;
    let targetMsg = null;
    const hist = Array.isArray(cs?.history) ? cs.history : null;
    if (hist) {
      for (const item of hist) {
        if (item && item.userInputMessage) { targetMsg = item.userInputMessage; break; }
      }
    }
    if (!targetMsg && cs?.currentMessage?.userInputMessage) {
      targetMsg = cs.currentMessage.userInputMessage;
    }
    if (!targetMsg) return;

    const content = typeof targetMsg.content === "string" ? targetMsg.content : "";
    const next = dedupStringAppend(content, prompt);
    if (next === content) return; // already injected — idempotent across retries
    try { targetMsg.content = next; } catch (_) { /* frozen/proxy fail-open */ }
  } catch (_) {}
}
