/**
 * Fan-out sidecar files: `${dir}/${agentId}.json` records the canonical model an
 * agent currently holds plus the canonical models of its running children.
 * Advisory only: readers treat any failure (missing file, corrupt JSON) as no data.
 */
import { mkdirSync, writeFileSync, readFileSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

export interface SiblingHolders { canonicalRef: string; count: number }
export interface FanoutRecord { model: string; children?: Record<string, string> }

function readFanout(dir: string, agentId: string): FanoutRecord | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(dir, `${agentId}.json`), 'utf8'));
    if (parsed && typeof parsed === 'object' && typeof (parsed as FanoutRecord).model === 'string') {
      return parsed as FanoutRecord;
    }
  } catch {}
  return undefined;
}

/** Count one held canonical model into the grouped list. */
function bump(acc: Map<string, number>, canonicalRef: string | undefined) {
  if (typeof canonicalRef === 'string' && canonicalRef) acc.set(canonicalRef, (acc.get(canonicalRef) ?? 0) + 1);
}

export function writeFanout(dir: string, agentId: string, model: string, children: Record<string, string> = {}): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${join(dir, `${agentId}.json`)}.tmp`;
  writeFileSync(tmp, JSON.stringify({ model, children }), { encoding: 'utf8', mode: 0o600 } as const);
  renameSync(tmp, join(dir, `${agentId}.json`));
}

/** Live canonical models held by the parent and its other running children (excluding this agent). */
export function readSiblings(dir: string, agentId: string, parentId: string | undefined): SiblingHolders[] {
  if (!parentId) return [];
  const parent = readFanout(dir, parentId);
  if (!parent) return [];
  const counts = new Map<string, number>();
  bump(counts, parent.model);
  for (const [childId, childModel] of Object.entries(parent.children ?? {})) {
    if (childId === agentId) continue;
    bump(counts, childModel);
  }
  return [...counts].map(([canonicalRef, count]) => ({ canonicalRef, count }));
}

export function removeFanout(dir: string, agentId: string): void {
  try { unlinkSync(join(dir, `${agentId}.json`)); } catch { /* already absent */ }
}
