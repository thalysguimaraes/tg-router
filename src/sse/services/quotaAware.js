import { getUsageForProvider } from "open-sse/services/usage.js";
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy";

export const QUOTA_MARGIN_PERCENT = 5;
export const QUOTA_CACHE_MS = 60_000;
export const QUOTA_WAIT_MS = 400;

const usageCache = new Map();
const inFlight = new Map();

async function fetchUsage(connection) {
  const proxy = await resolveConnectionProxyConfig(connection.providerSpecificData || {});
  return getUsageForProvider(connection, {
    connectionProxyEnabled: proxy.connectionProxyEnabled === true,
    connectionProxyUrl: proxy.connectionProxyUrl || "",
    connectionNoProxy: proxy.connectionNoProxy || "",
    vercelRelayUrl: proxy.vercelRelayUrl || "",
    strictProxy: false,
  });
}

function cachedUsage(connection) {
  const now = Date.now();
  const cached = usageCache.get(connection.id);
  if (cached && cached.expiresAt > now) return Promise.resolve(cached.usage);
  const pendingEntry = inFlight.get(connection.id);
  if (pendingEntry && pendingEntry.startedAt + QUOTA_CACHE_MS > now) return pendingEntry.promise;
  const pending = fetchUsage(connection)
    .catch(() => null)
    .then((usage) => {
      if (inFlight.get(connection.id)?.promise === pending) {
        usageCache.set(connection.id, { usage, expiresAt: Date.now() + QUOTA_CACHE_MS });
      }
      return usage;
    })
    .finally(() => {
      if (inFlight.get(connection.id)?.promise === pending) inFlight.delete(connection.id);
    });
  inFlight.set(connection.id, { promise: pending, startedAt: now });
  return pending;
}

function remainingPercent(quota) {
  const value = quota?.remainingPercentage ?? quota?.remaining;
  return Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;
}

function quotaRank(usage, provider, model, now) {
  const codexPrefix = String(model || "").toLowerCase().includes("spark") ? "spark_" : "";
  const keys = provider === "codex"
    ? [`${codexPrefix}session`, `${codexPrefix}weekly`]
    : ["session (5h)", "weekly (7d)"];
  if (String(model || "").toLowerCase().includes("fable")) keys.push("weekly fable (7d)");
  const reported = keys.map((key) => usage?.quotas?.[key]).filter((quota) =>
    remainingPercent(quota) !== null
  );
  if (reported.some((quota) => remainingPercent(quota) <= QUOTA_MARGIN_PERCENT)) {
    return { known: true, blocked: true, pressure: -1 };
  }
  const windows = reported.filter((quota) =>
    Number.isFinite(Date.parse(quota?.resetAt)) && Date.parse(quota.resetAt) > now
  );
  if (!windows.length) return { known: false, blocked: false, pressure: -1 };
  // Match the adapter's pressure metric: min(remaining fraction / max(1, hours to reset)).
  const pressure = Math.min(...windows.map((quota) =>
    (remainingPercent(quota) / 100) / Math.max(1, (Date.parse(quota.resetAt) - now) / 3_600_000)
  ));
  return { known: true, blocked: false, pressure };
}

/**
 * Known eligible quota precedes unknown quota; unknown accounts retain priority order.
 * Accounts at or below the margin rank last instead of being dropped: when every account
 * is near exhaustion the request still reaches the provider, whose 429 drives modelLock.
 */
export async function rankQuotaAwareConnections(connections, model, waitMs = QUOTA_WAIT_MS) {
  if (!connections.length) return [];
  let timer;
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(null), waitMs); });
  const usage = await Promise.race([
    Promise.all(connections.map((connection) => cachedUsage(connection))),
    timeout,
  ]);
  clearTimeout(timer);
  // On a slow batch, preserve the original priority order for this request.
  if (!usage) return connections;
  const now = Date.now();
  return connections
    .map((connection, index) => ({ connection, index, rank: quotaRank(usage[index], connection.provider, model, now) }))
    .sort((a, b) =>
      Number(a.rank.blocked) - Number(b.rank.blocked) ||
      Number(b.rank.known) - Number(a.rank.known) ||
      b.rank.pressure - a.rank.pressure ||
      a.index - b.index
    )
    .map(({ connection }) => connection);
}
