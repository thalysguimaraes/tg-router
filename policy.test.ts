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

test("lower pressure candidate swaps ahead of the preference winner", () => {
  const decision = decideRoute(input(snapshot(0.19, 67)));
  expect(decision.model).toBe("9router/cc/claude-fable-5-1");
  expect(decision.reason).toContain("Pressure swap: openai-codex/gpt-6-astra -> anthropic/claude-fable-5-1.");
});

test("highValue disables the pressure swap", () => {
  const decision = decideRoute(input(snapshot(0.19, 67), { task: { highValue: true } }));
  expect(decision.model).toBe("9router/cx/gpt-6-astra");
  expect(decision.reason).not.toContain("Pressure swap");
});

test("no swap when the preferred candidate is not meaningfully pressured", () => {
  const decision = decideRoute(input(snapshot(0.60, 67)));
  expect(decision.model).toBe("9router/cx/gpt-6-astra");
  expect(decision.reason).not.toContain("Pressure swap");
});

test("child boundary divides effective pressure by sibling count", () => {
  const decision = decideRoute(input(snapshot(0.60, 67), {
    boundary: "child",
    siblings: [{ canonicalRef: MODELS.astra, count: 2 }],
  }));
  expect(decision.model).toBe("9router/cc/claude-fable-5-1");
  expect(decision.reason).toContain("Pressure swap");
});

// A child inherits a floor from the parent's subagent role. Roles are no
// longer a user command: the floor raises vague or under-classified prompts
// and never lowers an explicit one.
const workerModel: RouteModel = {
  ref: "9router/ocg/union-alpha", canonicalRef: MODELS.union, gateway: true, authenticated: true,
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
