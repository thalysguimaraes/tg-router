// Mine omp sessions into a labeled routing corpus.
// One row per substantive user turn: prompt, model that answered, how the turn
// ended, whether the user manually changed model right after (a strong signal
// the router got it wrong), and the outcome of the turn.
import { readdirSync, statSync, createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';

const ROOT = join(process.env.HOME, '.omp/agent/sessions');
const files = [];
for (const dir of readdirSync(ROOT)) {
  const p = join(ROOT, dir);
  let st; try { st = statSync(p); } catch { continue; }
  if (!st.isDirectory()) continue;
  for (const f of readdirSync(p)) if (f.endsWith('.jsonl')) files.push(join(p, f));
}

const CONTINUE = /^(continue|continuar|continua|prossiga|prosseguir|siga|segue|sim|ok|okay|certo|pode seguir|pode continuar|vai em frente|go ahead|proceed|resume|keep going|do it|yes|yep|yeah|go|go, go, go)[.!?\s]*$/i;
const text = (content) => Array.isArray(content) ? content.filter(c => c?.type === 'text').map(c => c.text ?? '').join('\n') : typeof content === 'string' ? content : '';
const canonical = (m) => (m ?? '').replace(/^9router\/(cc|cx|ocg)\//, (_, p) => ({ cc: 'anthropic/', cx: 'openai-codex/', ocg: 'opencode-go/' })[p]).replace(/^anthropic\/anthropic\//, 'anthropic/');

const rows = [];
let sessions = 0, skippedSmall = 0;
for (const file of files) {
  const st = statSync(file);
  if (st.size < 2000) { skippedSmall++; continue; }
  sessions++;
  const rl = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  let header = {};
  let currentModel;
  let pendingUser;            // {prompt, at, model, changedBefore}
  let assistantAfter = 0, toolCalls = 0, lastStop, lastModel, errorTurns = 0;
  let modelChangeSinceUser = false;
  const flush = (nextUserAt) => {
    if (!pendingUser) return;
    rows.push({
      session: header.id, cwd: header.cwd, child: !!header.parentSession, modelRole: header.modelRole ?? null,
      at: pendingUser.at, prompt: pendingUser.prompt, promptLen: pendingUser.prompt.length,
      modelAtPrompt: canonical(pendingUser.model), modelAnswered: canonical(lastModel),
      assistantTurns: assistantAfter, toolCalls, errorTurns, lastStop,
      userSwitchedModelAfter: modelChangeSinceUser,
      continuation: CONTINUE.test(pendingUser.prompt.trim()),
    });
    pendingUser = undefined; assistantAfter = 0; toolCalls = 0; errorTurns = 0; lastStop = undefined; modelChangeSinceUser = false;
  };
  for await (const line of rl) {
    let e; try { e = JSON.parse(line); } catch { continue; }
    if (e.type === 'session') { header = e; continue; }
    if (e.type === 'model_change') { if (pendingUser && assistantAfter > 0) modelChangeSinceUser = true; currentModel = e.model; continue; }
    if (e.type !== 'message') continue;
    const m = e.message; if (!m) continue;
    if (m.role === 'user') {
      const t = text(m.content).trim();
      if (!t || t.startsWith('/')) continue;
      flush(e.timestamp);
      pendingUser = { prompt: t.slice(0, 4000), at: e.timestamp, model: currentModel };
    } else if (m.role === 'assistant') {
      assistantAfter++;
      lastModel = m.provider && m.model ? `${m.provider}/${m.model}` : currentModel;
      lastStop = m.stopReason;
      if (m.stopReason === 'error') errorTurns++;
      if (Array.isArray(m.content)) toolCalls += m.content.filter(c => c?.type === 'toolCall' || c?.type === 'tool_use').length;
    }
  }
  flush();
}
const out = join(process.env.HOME, '.omp/agent/personal-router/session-corpus.jsonl');
const { writeFileSync } = await import('node:fs');
writeFileSync(out, rows.map(r => JSON.stringify(r)).join('\n') + '\n', { mode: 0o600 });
console.log(JSON.stringify({ files: files.length, sessions, skippedSmall, rows: rows.length, out }));
