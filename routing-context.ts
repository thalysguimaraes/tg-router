import { createHash, createHmac } from 'node:crypto';

/** Semantic task assessment input. Deliberately free of quota, price, credential or roster data. */
export interface RoutingContext {
  schemaVersion: 1;
  taskGoal: string;
  currentUserRequest: string;
  previousPhase?: 'lightweight' | 'implementation' | 'review' | 'investigation' | 'planning';
  scope?: string;
  acceptanceCriteria?: string[];
  recentEvidence?: string[];
  boundary: 'user' | 'child' | 'phase' | 'compaction' | 'provider-failure';
  observations: {
    hasImages: boolean;
    toolsRequired: boolean;
    changedFilesCount?: number;
    confirmedQualityFailures: number;
  };
  truncated: boolean;
}

/** Sub-budget a caller must pass so classification never spends without admission. */
export interface ClassifierBudgetCheck {
  (estimatedUsd: number): { ok: true } | { ok: false; reason: string };
}

const MAX_STATE_BYTES = 24_576;

const REDACTION_PATTERNS: Array<[RegExp, string]> = [
  // Secrets: keyword followed by assignment consumes the assigned value
  // (quoted or bare) so neither key wording nor value leaks.
  [/\b(api[_-]?key|api[_-]?secret|secret|password|passwd|pwd|token|access[_-]?token|refresh[_-]?token|bearer|authorization|cookie|session[_-]?id|private[_-]?key|client[_-]?secret)\b\s*[:=]\s*(".*?"|'.*?'|`.*?`|[^\s,;)"']+)/gi, '$1=[REDACTED]'],
  // Prose form: secret keyword directly followed by a quoted value.
  [/\b(api[_-]?key|api[_-]?secret|secret|password|passwd|pwd|token|access[_-]?token|refresh[_-]?token|bearer|authorization|cookie|session[_-]?id|private[_-]?key|client[_-]?secret)\s+(".*?"|'[^']*')/gi, '$1 [REDACTED]'],
  // Env-style compound names (R2_SECRET_ACCESS_KEY=..., MY_APP_TOKEN=...). The
  // keyword regex above needs the keyword as a whole word; compound names
  // embed it. Found in a real session where a pasted .env slipped through.
  [/\b([A-Z][A-Z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL)[A-Z0-9_]*)\s*[=:]\s*(".*?"|'.*?'|[^\s,;)"']+)/g, '$1=[REDACTED]'],
  [/\b(sk|pk)-[A-Za-z0-9_-]{16,}/g, '[REDACTED-KEY]'],
  [/\bghp_[A-Za-z0-9]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '[REDACTED-KEY]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED-KEY]'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[REDACTED-JWT]'],
  // Bearer schemes.
  [/\bBearer\s+\S+/gi, 'Bearer [REDACTED]'],
  // 1Password references.
  [/\bop:\/\/[^\s"']+/g, 'op://[REDACTED]'],
  // Credentials in URLs.
  [/(\w+):\/\/[^/\s:@"]+:[^/\s@"]+@/g, '$1://[REDACTED]@'],
  // Home and repo absolute paths keep only the final two segments.
  [/(?:\/(?:Users|home)\/[\w.-]+)(?:\/[\w.-]+)*/g, '[PATH]'],
];

export function redactText(text: string): string {
  let value = text;
  for (const [pattern, replacement] of REDACTION_PATTERNS) value = value.replace(pattern, replacement);
  return value;
}

/**
 * Assemble a bounded, redacted RoutingContext from untrusted task text.
 * Truncation marks the context; a truncated assessment can never authorize a downgrade.
 */
export function buildRoutingContext(parts: {
  taskGoal: string;
  currentUserRequest: string;
  previousPhase?: RoutingContext['previousPhase'];
  scope?: string;
  acceptanceCriteria?: string[];
  recentEvidence?: string[];
  boundary: RoutingContext['boundary'];
  hasImages: boolean;
  toolsRequired: boolean;
  changedFilesCount?: number;
  confirmedQualityFailures: number;
}): RoutingContext {
  const goalBudget = 4000;
  const requestBudget = 4000;
  const evidenceBudget = 600;
  const perCriterionBudget = 400;
  const criterionCount = 10;
  const clip = (value: string, maxChars: number): { text: string; truncated: boolean } =>
    value.length <= maxChars ? { text: value, truncated: false } : { text: value.slice(0, maxChars), truncated: true };

  const goal = clip(redactText(parts.taskGoal), goalBudget);
  const request = clip(redactText(parts.currentUserRequest), requestBudget);
  const evidence = (parts.recentEvidence ?? []).slice(0, 6).map(entry => {
    const clipped = clip(redactText(entry), evidenceBudget);
    return { text: clipped.text, truncated: clipped.truncated };
  });
  const criteria = (parts.acceptanceCriteria ?? []).slice(0, criterionCount).map(entry => {
    const clipped = clip(redactText(entry), perCriterionBudget);
    return { text: clipped.text, truncated: clipped.truncated };
  });
  const scope = parts.scope === undefined ? undefined : clip(redactText(parts.scope), 1000);

  let context: RoutingContext = {
    schemaVersion: 1,
    taskGoal: goal.text,
    currentUserRequest: request.text,
    ...(parts.previousPhase ? { previousPhase: parts.previousPhase } : {}),
    ...(scope ? { scope: scope.text } : {}),
    ...(criteria.length ? { acceptanceCriteria: criteria.map(entry => entry.text) } : {}),
    ...(evidence.length ? { recentEvidence: evidence.map(entry => entry.text) } : {}),
    boundary: parts.boundary,
    observations: {
      hasImages: parts.hasImages,
      toolsRequired: parts.toolsRequired,
      ...(parts.changedFilesCount !== undefined ? { changedFilesCount: parts.changedFilesCount } : {}),
      confirmedQualityFailures: parts.confirmedQualityFailures,
    },
    truncated: goal.truncated || request.truncated || evidence.some(entry => entry.truncated) || criteria.some(entry => entry.truncated) || (parts.acceptanceCriteria?.length ?? 0) > criterionCount,
  };

  // Hard size ceiling: drop optional evidence first, then trim the goal.
  while (Buffer.byteLength(JSON.stringify(context), 'utf8') > MAX_STATE_BYTES) {
    const evidenceCount = context.recentEvidence?.length ?? 0;
    const criteriaCount = context.acceptanceCriteria?.length ?? 0;
    if (evidenceCount > 0) {
      context = { ...context, recentEvidence: context.recentEvidence!.slice(0, -1), truncated: true };
    } else if (criteriaCount > 1) {
      context = { ...context, acceptanceCriteria: context.acceptanceCriteria!.slice(0, -1), truncated: true };
    } else {
      context = { ...context, taskGoal: context.taskGoal.slice(0, Math.floor(context.taskGoal.length * 0.8)), truncated: true };
      if (context.taskGoal.length === 0) break;
    }
  }
  return context;
}

/** Schema + questions participate in the cache key: a rubric change invalidates cached assessments. */
export const JEV_SCHEMA_VERSION = 1;
export const JEV_QUESTION_SET_VERSION = 'jev-questions-1';

/** Keyed hash of the redacted state for caching and traces. Never reverses to the input. */
export function assessmentCacheKey(parts: {
  state: RoutingContext;
  schemaVersion: number;
  questionSetVersion: string;
  classifierModel: string;
  hmacKey: string;
}): string {
  const payload = JSON.stringify({
    s: parts.state,
    v: parts.schemaVersion,
    q: parts.questionSetVersion,
    m: parts.classifierModel,
  });
  return createHmac('sha256', parts.hmacKey).update(payload).digest('hex');
}

/** Cheap equality hash for tracing identical inputs without an HMAC key. */
export function questionHash(questions: unknown): string {
  return createHash('sha256').update(JSON.stringify(questions)).digest('hex').slice(0, 16);
}

export { MAX_STATE_BYTES };
