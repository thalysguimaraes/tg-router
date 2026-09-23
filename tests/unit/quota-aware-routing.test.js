import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
  getSettings: vi.fn(),
  resolveConnectionProxyConfig: vi.fn(),
  getUsageForProvider: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  getProviderConnections: mocks.getProviderConnections,
  getSettings: mocks.getSettings,
  getProxyPools: vi.fn(),
  validateApiKey: vi.fn(),
  updateProviderConnection: vi.fn(),
}));
vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: mocks.resolveConnectionProxyConfig,
  pickProxyPoolId: vi.fn(),
}));
vi.mock("@/shared/constants/providers.js", () => ({
  FREE_PROVIDERS: {},
  resolveProviderId: (provider) => provider,
}));
vi.mock("open-sse/services/usage.js", () => ({ getUsageForProvider: mocks.getUsageForProvider }));
vi.mock("@/sse/utils/logger.js", () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn() }));

let getProviderCredentials;
const accounts = [
  { id: "a", provider: "claude", priority: 1, accessToken: "a" },
  { id: "b", provider: "claude", priority: 2, accessToken: "b" },
];
const window = (remainingPercentage, hours) => ({
  remainingPercentage,
  resetAt: new Date(Date.now() + hours * 3_600_000).toISOString(),
});
const usage = (session, weekly, fable) => ({
  quotas: {
    "session (5h)": window(session, 5),
    "weekly (7d)": window(weekly, 168),
    "weekly fable (7d)": window(fable, 168),
  },
});

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  ({ getProviderCredentials } = await import("@/sse/services/auth.js"));
  mocks.getProviderConnections.mockResolvedValue(accounts.map((account) => ({ ...account })));
  mocks.getSettings.mockResolvedValue({ providerStrategies: { claude: { fallbackStrategy: "quota-aware" } } });
  mocks.resolveConnectionProxyConfig.mockResolvedValue({});
});

describe("quota-aware account selection", () => {
  it("prefers the account with the nearer weekly reset when pressure is higher", async () => {
    mocks.getUsageForProvider.mockImplementation(async (connection) => ({ quotas: {
      "session (5h)": window(80, 5),
      "weekly (7d)": window(50, connection.id === "a" ? 168 : 24),
    } }));
    expect((await getProviderCredentials("claude", null, "claude-sonnet-4"))?.connectionId).toBe("b");
  });

  it("skips an exhausted five-hour account", async () => {
    mocks.getUsageForProvider.mockImplementation(async (connection) =>
      connection.id === "a" ? usage(5, 80, 80) : usage(80, 80, 80));
    expect((await getProviderCredentials("claude", null, "claude-sonnet-4"))?.connectionId).toBe("b");
  });

  it("still serves from the best account when every account is below the margin", async () => {
    mocks.getUsageForProvider.mockImplementation(async (connection) =>
      connection.id === "a" ? usage(3, 80, 80) : usage(80, 4, 80));
    expect((await getProviderCredentials("claude", null, "claude-sonnet-4"))?.connectionId).toBe("a");
  });

  it("uses the fable window only for fable models", async () => {
    mocks.getUsageForProvider.mockImplementation(async (connection) =>
      connection.id === "a" ? usage(80, 80, 0) : usage(80, 80, 80));
    expect((await getProviderCredentials("claude", null, "claude-sonnet-4"))?.connectionId).toBe("a");
    expect((await getProviderCredentials("claude", null, "claude-fable-4"))?.connectionId).toBe("b");
    expect(mocks.getUsageForProvider).toHaveBeenCalledTimes(2);
  });

  it("keeps priority order when usage is unavailable", async () => {
    mocks.getUsageForProvider.mockRejectedValue(new Error("usage unavailable"));
    expect((await getProviderCredentials("claude", null, "claude-sonnet-4"))?.connectionId).toBe("a");
  });

  it("ranks a known account before unknown quota while preserving unknown priority order", async () => {
    mocks.getProviderConnections.mockResolvedValue([...accounts, { id: "c", provider: "claude", priority: 3 }]);
    mocks.getUsageForProvider.mockImplementation(async (connection) =>
      connection.id === "c" ? usage(80, 80, 80) : { message: "unavailable" });
    expect((await getProviderCredentials("claude", null, "claude-sonnet-4"))?.connectionId).toBe("c");
  });

  it("uses Codex session and weekly quota fields", async () => {
    mocks.getProviderConnections.mockResolvedValue(accounts.map((account) => ({ ...account, provider: "codex" })));
    mocks.getSettings.mockResolvedValue({ providerStrategies: { codex: { fallbackStrategy: "quota-aware" } } });
    mocks.getUsageForProvider.mockImplementation(async (connection) => ({ quotas: {
      session: { remaining: connection.id === "a" ? 5 : 80, resetAt: window(80, 5).resetAt },
      weekly: { remaining: 80, resetAt: window(80, 168).resetAt },
    } }));
    expect((await getProviderCredentials("codex", null, "gpt-5.5"))?.connectionId).toBe("b");
  });

  it("excludes a model-locked account before quota ranking", async () => {
    mocks.getProviderConnections.mockResolvedValue([
      { ...accounts[0], "modelLock_claude-sonnet-4": new Date(Date.now() + 60_000).toISOString() },
      { ...accounts[1] },
    ]);
    mocks.getUsageForProvider.mockResolvedValue(usage(80, 80, 80));
    expect((await getProviderCredentials("claude", null, "claude-sonnet-4"))?.connectionId).toBe("b");
    expect(mocks.getUsageForProvider).toHaveBeenCalledTimes(1);
  });

  it("falls back to priority when usage exceeds the short deadline", async () => {
    mocks.getUsageForProvider.mockImplementation(() => new Promise(() => {}));
    expect((await getProviderCredentials("claude", null, "claude-sonnet-4"))?.connectionId).toBe("a");
  });
});
