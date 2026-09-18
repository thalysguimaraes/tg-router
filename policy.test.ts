import { describe, expect, test } from "bun:test";
import { MODELS, PRESSURE_SWAP_RATIO, pressure, decideRoute, childFloorFor, type QuotaSnapshot, type RouteInput, type RouteModel } from "./policy";

const NOW = Date.parse("2026-09-16T12:00:00Z");
const HOUR = 3_600_000;

const snapshot = (remainingFraction: number, hoursToReset: number): QuotaSnapshot => ({
  observedAt: NOW - 1_000,
  state: "healthy",
  windows: [{ id: "session", remainingFraction, resetsAt: NOW + hoursToReset * HOUR }],
});

const model = (name: "astra" | "fable", quota: QuotaSnapshot): RouteModel => ({
  ref: name === "astra" ? "9router/cx/gpt-6-astra" : "9router/cc/claude-fable-5-1",
  canonicalRef: MODELS[name],
  gateway: true,
  authenticated: true,
  contextWindow: 400_000,
  supportsTools: true,
  supportsImages: false,
  quota,
});

const input = (quota: QuotaSnapshot, overrides: Partial<RouteInput> = {}): RouteInput => ({
  prompt: "plan the migration",
  now: NOW,
  contextTokens: 50_000,
  boundary: "user",
  models: [model("astra", quota), model("fable", snapshot(0.92, 132))],
  ...overrides,
});

test("pressure is remaining fraction normalized by hours to reset", () => {
  expect(pressure(snapshot(0.19, 67), NOW)).toBeCloseTo(0.19 / 67, 10);
  expect(pressure(undefined, NOW)).toBe(-1);
  expect(pressure({ observedAt: NOW, windows: [{ id: "x" }] }, NOW)).toBe(-1);
  expect(PRESSURE_SWAP_RATIO).toBe(0.5);
});

test("within a cost class, the candidate with meaningfully more headroom wins", () => {
  // Astra 0.19/67h vs Fable 0.92/132h: Fable has ~2.5x the headroom per hour.
  const decision = decideRoute(input(snapshot(0.19, 67)));
  expect(decision.model).toBe("9router/cc/claude-fable-5-1");
  expect(decision.reason).toContain("Headroom:");
});

test("highValue lets a reserve window count at full headroom but does not change class order", () => {
  const decision = decideRoute(input(snapshot(0.19, 67), { task: { highValue: true } }));
  // Headroom still decides within the premium class; highValue only stops the reserve halving.
  expect(decision.model).toBe("9router/cc/claude-fable-5-1");
});

test("small headroom differences fall through to the reviewed preference order", () => {
  const decision = decideRoute(input(snapshot(0.60, 67)));
  expect(decision.model).toBe("9router/cx/gpt-6-astra");
  expect(decision.reason).not.toContain("Headroom:");
});

test("sibling children holding a provider dilute its headroom", () => {
  const decision = decideRoute(input(snapshot(0.60, 67), {
    boundary: "child",
    siblings: [{ canonicalRef: MODELS.astra, count: 2 }],
  }));
  expect(decision.model).toBe("9router/cc/claude-fable-5-1");
  expect(decision.reason).toContain("Headroom:");
});

test("the allocator never crosses a cost class upward, whatever the slack", () => {
  // A mechanical task with a drained worker and a wide-open premium model:
  // the worker still wins because premium is never spent on cheap-class work.
  const drainedWorker: RouteModel = {
    ref: "9router/ocg/deepseek-v4.1-flash", canonicalRef: MODELS.deepseek, gateway: true, authenticated: true,
    contextWindow: 200_000, supportsTools: true, supportsImages: false, validated: { tools: true, reasoning: true },
    quota: { observedAt: NOW - 1_000, state: "reserve", windows: [{ id: "weekly", remainingFraction: 0.12, reserveFraction: 0.15, resetsAt: NOW + 60 * HOUR }] },
  };
  const decision = decideRoute({
    prompt: "rename the variable tmp to buffer", now: NOW, contextTokens: 5_000, boundary: "user",
    models: [drainedWorker, model("fable", snapshot(0.95, 132))],
  });
  expect(decision.tier).toBe("mechanical");
  expect(decision.model).toBe(drainedWorker.ref);
  expect(decision.reason).toContain("soft reserve");
});

test("a subscription route beats a paid route in the same class", () => {
  const paidSol: RouteModel = {
    ref: "openrouter/openai/gpt-5.6-sol", canonicalRef: "openrouter/openai/gpt-5.6-sol", authenticated: true,
    contextWindow: 400_000, supportsTools: true, supportsImages: false, payg: true,
    qualityTiers: ["mechanical", "bounded", "execution"],
    quota: { observedAt: NOW - 1_000, state: "healthy", windows: [{ id: "cash", remainingFraction: 1 }] },
  };
  const subSol: RouteModel = {
    ref: "9router/cx/gpt-5.6-sol", canonicalRef: MODELS.sol, gateway: true, authenticated: true,
    contextWindow: 400_000, supportsTools: true, supportsImages: false,
    quota: { observedAt: NOW - 1_000, state: "healthy", windows: [{ id: "weekly", remainingFraction: 0.3, resetsAt: NOW + 100 * HOUR }] },
  };
  const decision = decideRoute({
    prompt: "review this diff", now: NOW, contextTokens: 5_000, boundary: "user",
    models: [paidSol, subSol, model("astra", snapshot(0.5, 100))],
    paidFallback: { authorized: true, budgetReserved: true, allowedModels: [paidSol.ref] },
  });
  expect(decision.model).not.toBe(paidSol.ref);
});

// A child inherits a floor from the parent's subagent role. Roles are no
// longer a user command: the floor raises vague or under-classified prompts
// and never lowers an explicit one.
const workerModel: RouteModel = {
  ref: "9router/ocg/glm-5.3-flash", canonicalRef: MODELS.glm, gateway: true, authenticated: true,
  contextWindow: 200_000, supportsTools: true, supportsImages: false, validated: { tools: true, reasoning: true },
  quota: { observedAt: NOW - 1_000, state: "healthy", windows: [{ id: "daily", remainingFraction: 0.9 }] },
};
const childInput = (prompt: string, floor: RouteInput["childFloor"]): RouteInput => ({
  prompt, now: NOW, contextTokens: 5_000, boundary: "child", childFloor: floor,
  models: [model("astra", snapshot(0.8, 100)), workerModel],
});

test("a vague prompt takes the child floor's tier and phase", () => {
  expect(childFloorFor("plan")).toEqual({ tier: "complex", phase: "planning" });
  const planner = decideRoute(childInput("here is what we have so far", childFloorFor("plan")));
  expect(planner.tier).toBe("complex");
  expect(planner.phase).toBe("planning");
  const worker = decideRoute(childInput("here is what we have so far", childFloorFor("task")));
  expect(worker.tier).toBe("bounded");
  expect(worker.phase).toBe("implementation");
  expect(worker.model).toBe(workerModel.ref);
});

test("the child floor raises an under-classified prompt but never lowers an explicit one", () => {
  const raised = decideRoute(childInput("rename the variable", childFloorFor("pesquisa")));
  expect(raised.tier).toBe("complex");
  const kept = decideRoute(childInput("plan the migration architecture", childFloorFor("task")));
  expect(kept.tier).toBe("complex");
  expect(kept.phase).toBe("planning");
});

test("unknown subagent roles yield no floor", () => {
  expect(childFloorFor("default")).toBeUndefined();
  expect(childFloorFor(undefined)).toBeUndefined();
});
