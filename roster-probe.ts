/**
 * Capability probe for a candidate model.
 *
 * Vetting a model is not reading a catalog row: it is running the model and
 * seeing whether it survives the things this router requires. A candidate is
 * unroutable for tool work until `goValidated` lists it, and this probe is what
 * earns that entry.
 *
 * Four checks, each a real gateway call, each mapping to a routing guard:
 *   instruction  — follows an exact-output instruction (rejection: none, but a
 *                  model that fails this is not a worker)
 *   tools        — emits a well-formed tool call         (`validated.tools`)
 *   reasoning    — accepts a reasoning/effort hint without erroring
 *                                                        (`validated.reasoning`)
 *   longContext  — answers a needle question at ~32k of filler, proving the
 *                  advertised context is usable, not just declared
 *
 * Deliberately cheap and deliberately not a benchmark: it answers "is this
 * model wired up correctly for our transport", never "is it smart". Quality
 * tiers stay a reviewed human decision.
 */
import { isObjectGuard } from './type-guards';

export const PROBE_CHECKS = ['instruction', 'tools', 'reasoning', 'longContext', 'effortHint'] as const;
export type ProbeCheck = (typeof PROBE_CHECKS)[number];

export interface ProbeCheckResult {
  check: ProbeCheck;
  pass: boolean;
  detail: string;
  elapsedMs: number;
  promptTokens?: number;
  completionTokens?: number;
}

export interface ProbeResult {
  model: string;
  probedAt: string;
  checks: ProbeCheckResult[];
  /** True only when every check passed. Tool + reasoning are what gate Go routing. */
  routable: boolean;
  /** Suggested settings entries; applying them is a separate, explicit act. */
  suggests: { goValidated: boolean; goVisionValidated: boolean };
  /** False means the router must not send `reasoning_effort` to this model. */
  acceptsEffortHint: boolean;
}

export interface ProbeOptions {
  baseUrl: string;
  apiKey: string;
  /** Wire model id as the gateway expects it, e.g. `ocg/glm-5.3-flash`. */
  wireModel: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  now?: () => number;
}

interface Completion {
  content: string;
  toolCalls: Array<{ name: string; args: string }>;
  finish?: string;
  reasoningTokens?: number;
  promptTokens?: number;
  completionTokens?: number;
}

const WEATHER_TOOL = {
  type: 'function',
  function: {
    name: 'get_weather',
    description: 'Get the current weather for a city.',
    parameters: {
      type: 'object',
      properties: { city: { type: 'string', description: 'City name' } },
      required: ['city'],
    },
  },
};

function parseCompletion(body: unknown): Completion | undefined {
  if (!isObjectGuard(body)) return undefined;
  const choices = body.choices;
  if (!Array.isArray(choices) || !choices.length) return undefined;
  const choice = choices[0];
  if (!isObjectGuard(choice)) return undefined;
  const message = isObjectGuard(choice.message) ? choice.message : undefined;
  const rawCalls = message && Array.isArray(message.tool_calls) ? message.tool_calls : [];
  const toolCalls: Completion['toolCalls'] = [];
  for (const raw of rawCalls) {
    if (!isObjectGuard(raw)) continue;
    const fn = isObjectGuard(raw.function) ? raw.function : undefined;
    if (typeof fn?.name === 'string') toolCalls.push({ name: fn.name, args: typeof fn.arguments === 'string' ? fn.arguments : '' });
  }
  const usage = isObjectGuard(body.usage) ? body.usage : undefined;
  return {
    content: typeof message?.content === 'string' ? message.content : '',
    toolCalls,
    ...(typeof choice.finish_reason === 'string' ? { finish: choice.finish_reason } : {}),
    ...(isObjectGuard(usage?.completion_tokens_details) && typeof usage.completion_tokens_details.reasoning_tokens === 'number'
      ? { reasoningTokens: usage.completion_tokens_details.reasoning_tokens } : {}),
    ...(typeof usage?.prompt_tokens === 'number' ? { promptTokens: usage.prompt_tokens } : {}),
    ...(typeof usage?.completion_tokens === 'number' ? { completionTokens: usage.completion_tokens } : {}),
  };
}

export async function probeModel(options: ProbeOptions): Promise<ProbeResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 60_000;
  const now = options.now ?? (() => Date.now());
  const call = async (body: Record<string, unknown>): Promise<{ completion?: Completion; error?: string; fatal?: boolean; shapeRejected?: boolean }> => {
    try {
      const res = await fetchImpl(`${options.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${options.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: options.wireModel, ...body }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      // The gateway may append an SSE terminator to a non-stream response.
      const raw = (await res.text()).replace(/\s*data:\s*\[DONE\]\s*$/, '');
      // An unsupported model id makes the upstream reject the whole ACCOUNT,
      // and 9Router then 401s every model on it for a cooldown window. Treat
      // any auth/unsupported signal as fatal and stop probing immediately
      // rather than spending the rest of the checks degrading a live provider.
      // 401/403 and a rejected request body both trigger an account-wide
      // cooldown at the gateway, so both must stop the run.
      if (res.status === 401 || res.status === 403 || /not supported|ModelError/i.test(raw)) {
        return { error: `unsupported-or-auth (http-${res.status})`, fatal: true };
      }
      if (res.status === 400 && /unknown field|invalid request body/i.test(raw)) {
        return { error: `request-shape-rejected (http-400)`, fatal: true, shapeRejected: true };
      }
      if (!res.ok) return { error: `http-${res.status}` };
      const completion = parseCompletion(JSON.parse(raw));
      return completion ? { completion } : { error: 'unparseable-response' };
    } catch (error) {
      const name = error instanceof Error ? error.name : 'Unknown';
      return { error: name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : name };
    }
  };

  const checks: ProbeCheckResult[] = [];
  let aborted: string | undefined;
  const run = async (check: ProbeCheck, body: Record<string, unknown>, judge: (c: Completion) => { pass: boolean; detail: string }) => {
    if (aborted) { checks.push({ check, pass: false, detail: `skipped: ${aborted}`, elapsedMs: 0 }); return; }
    const startedAt = now();
    const { completion, error, fatal } = await call(body);
    const elapsedMs = now() - startedAt;
    if (fatal) aborted = error ?? 'provider rejected the model';
    if (!completion) { checks.push({ check, pass: false, detail: error ?? 'no response', elapsedMs }); return; }
    const verdict = judge(completion);
    // A truncated response is a probe-budget artefact, not a model failure.
    // Reasoning models spend completion tokens on reasoning_content first.
    if (!verdict.pass && completion.content.trim() === '' && completion.finish === 'length') {
      verdict.detail = `inconclusive: response truncated at max_tokens${completion.reasoningTokens ? ` after ${completion.reasoningTokens} reasoning tokens` : ''}`;
    }
    checks.push({ check, ...verdict, elapsedMs, ...(completion.promptTokens !== undefined ? { promptTokens: completion.promptTokens } : {}), ...(completion.completionTokens !== undefined ? { completionTokens: completion.completionTokens } : {}) });
  };

  await run('instruction',
    { messages: [{ role: 'user', content: 'Reply with exactly the word READY and nothing else.' }], max_tokens: 512 },
    c => ({ pass: /^\W*ready\W*$/i.test(c.content.trim()), detail: c.content.trim().slice(0, 60) || '(empty)' }));

  await run('tools',
    { messages: [{ role: 'user', content: 'What is the weather in Lisbon? Use the tool.' }], tools: [WEATHER_TOOL], tool_choice: 'auto', max_tokens: 128 },
    c => {
      const call = c.toolCalls.find(t => t.name === 'get_weather');
      if (!call) return { pass: false, detail: `no tool call (finish=${c.finish ?? '?'}, content="${c.content.trim().slice(0, 40)}")` };
      let city: unknown;
      try { const parsed: unknown = JSON.parse(call.args || '{}'); city = isObjectGuard(parsed) ? parsed.city : undefined; } catch { return { pass: false, detail: 'tool arguments are not valid JSON' }; }
      return typeof city === 'string' && /lisbon|lisboa/i.test(city)
        ? { pass: true, detail: `get_weather(city=${city})` }
        : { pass: false, detail: `tool called with unexpected arguments: ${call.args.slice(0, 60)}` };
    });

  // Reasoning is asked WITHOUT an effort hint. Sending `reasoning_effort` to a
  // Go model made the upstream reject the body ("unknown field \"thinking\"")
  // with a 400, which 9Router turns into an account cooldown, which then failed
  // the following check too. That measured our own request shape, not the
  // model. Hint support is probed separately and is not a routing gate.
  await run('reasoning',
    { messages: [{ role: 'user', content: 'A bat and ball cost 1.10 together. The bat costs 1.00 more than the ball. What does the ball cost? Reply with only the number.' }], max_tokens: 2048 },
    c => ({ pass: /0?\.0?5\b/.test(c.content), detail: c.content.trim().replace(/\s+/g, ' ').slice(0, 60) || '(empty)' }));

  // ~32k tokens of filler with one needle. Proves the transport carries a large
  // prompt and the model still attends to it.
  const needle = 'The access code for warehouse seven is PELICAN-4417.';
  const filler = Array.from({ length: 1600 }, (_, i) => `Line ${i}: routine inventory record, nothing of note.`).join('\n');
  await run('longContext',
    { messages: [{ role: 'user', content: `${filler}\n${needle}\n${filler}\n\nWhat is the access code for warehouse seven? Reply with only the code.` }], max_tokens: 512 },
    c => ({ pass: /PELICAN-4417/i.test(c.content), detail: c.content.trim().slice(0, 60) || '(empty)' }));

  // Effort-hint support is informational: knowing the upstream rejects
  // `reasoning_effort` tells the router not to send it, and must never be the
  // reason a model looks unroutable. Runs last so a rejection cannot cascade.
  if (aborted) {
    checks.push({ check: 'effortHint', pass: false, detail: `skipped: ${aborted}`, elapsedMs: 0 });
  } else {
    const startedAt = now();
    const { completion, error, shapeRejected } = await call({ messages: [{ role: 'user', content: 'Reply with exactly: OK' }], reasoning_effort: 'medium', max_tokens: 512 });
    checks.push({
      check: 'effortHint',
      pass: !!completion,
      detail: completion ? 'accepts reasoning_effort' : shapeRejected ? 'upstream rejects reasoning_effort; router must omit it' : (error ?? 'no response'),
      elapsedMs: now() - startedAt,
    });
  }

  const by = (check: ProbeCheck) => checks.find(c => c.check === check)?.pass === true;
  return {
    model: options.wireModel,
    probedAt: new Date(now()).toISOString(),
    checks,
    // effortHint is informational and excluded from routability.
    routable: checks.filter(c => c.check !== 'effortHint').every(c => c.pass),
    // Go routing needs tools + reasoning specifically (see policy rejection rules).
    suggests: { goValidated: by('tools') && by('reasoning'), goVisionValidated: false },
    acceptsEffortHint: by('effortHint'),
  };
}
