// FAC-296 part 2: the spend guard a persistent stage turns on (scripts/stage, `agents`):
// ENABLE_CLOUDFLARE_LIMITS=true with DAILY_LLM_CALL_LIMIT. Each agent turn the overseer starts
// (overseer.ts, before runAgent) asks checkUsageAndBalance, which counts one call on the workspace
// owner's per-UTC-day counter (UserDurableObject.consumeDailyLlmCall) and refuses the turn once the
// day's calls are used up. This drives the real check against a real UserDurableObject.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { checkUsageAndBalance } from "../src/ai-gateway-billing/limits/usage-checker.js";
import { BINDING_WITHOUT_OWNER, chargeBindingCall } from "../src/ai-gateway-billing/limits/binding-charge.js";
import { LIMIT_ERROR_MESSAGES } from "@gadgets/workshop-shared/limits";

type Env = Parameters<typeof checkUsageAndBalance>[0];
type Stub = Parameters<typeof checkUsageAndBalance>[1];

const owner = () => env.TEST_USER.getByName(crypto.randomUUID()) as unknown as Stub;

describe("the stage's daily agent-turn limit (FAC-296)", () => {
  it("allows exactly DAILY_LLM_CALL_LIMIT turns a day per owner, then refuses with a reason", async () => {
    const limited = { ...env, ENABLE_CLOUDFLARE_LIMITS: "true", DAILY_LLM_CALL_LIMIT: "3" } as unknown as Env;
    const stub = owner();
    const results = [];
    for (let i = 0; i < 5; i++) results.push(await checkUsageAndBalance(limited, stub));
    expect(results.map(r => r.allowed)).toEqual([true, true, true, false, false]);
    expect(results.map(r => r.remaining)).toEqual([2, 1, 0, 0, 0]);
    expect(results[3]!.limit).toBe(3);
    // The overseer shows this reason and ends the turn (`usage_limit`) before any model call.
    expect(results[3]!.reason).toBeTruthy();
  });

  it("counts each owner separately", async () => {
    const limited = { ...env, ENABLE_CLOUDFLARE_LIMITS: "true", DAILY_LLM_CALL_LIMIT: "1" } as unknown as Env;
    const [a, b] = [owner(), owner()];
    expect((await checkUsageAndBalance(limited, a)).allowed).toBe(true);
    expect((await checkUsageAndBalance(limited, a)).allowed).toBe(false);
    expect((await checkUsageAndBalance(limited, b)).allowed).toBe(true);
  });

  it("without the stage's switch nothing is counted or refused", async () => {
    const open = { ...env, ENABLE_CLOUDFLARE_LIMITS: undefined, DAILY_LLM_CALL_LIMIT: "1" } as unknown as Env;
    const stub = owner();
    for (let i = 0; i < 3; i++) expect((await checkUsageAndBalance(open, stub)).allowed).toBe(true);
  });
});

// Fix round 1 (r1 and r2 on #520): a gadget's model binding calls the model outside any turn, so
// each platform-funded binding call counts on the same owner counter and is refused once it's used.
describe("model-binding calls count on the same daily limit (FAC-296)", () => {
  const users = env.TEST_USER as unknown as Parameters<typeof chargeBindingCall>[1];
  const limited = (n: number) =>
    ({ ...env, ENABLE_CLOUDFLARE_LIMITS: "true", DAILY_LLM_CALL_LIMIT: String(n) }) as unknown as Env;
  const ownerId = () => env.TEST_USER.newUniqueId().toString();
  const outcome = (p: Promise<void>) => p.then(() => "ok", (err: Error) => err.message);

  it("counts each platform-funded call and refuses the one over the limit, with the turn's reason", async () => {
    const binding = { ownerId: ownerId(), platformFunded: true };
    const results = [];
    for (let i = 0; i < 3; i++) results.push(await outcome(chargeBindingCall(limited(2), users, binding)));
    expect(results).toEqual(["ok", "ok", LIMIT_ERROR_MESSAGES.NO_CLOUDFLARE_TOKEN]);
  });

  it("shares the counter with agent turns", async () => {
    const id = ownerId();
    const stub = env.TEST_USER.get(env.TEST_USER.idFromString(id)) as unknown as Stub;
    expect((await checkUsageAndBalance(limited(2), stub)).allowed).toBe(true);
    expect(await outcome(chargeBindingCall(limited(2), users, { ownerId: id, platformFunded: true }))).toBe("ok");
    expect((await checkUsageAndBalance(limited(2), stub)).allowed).toBe(false);
    expect(await outcome(chargeBindingCall(limited(2), users, { ownerId: id, platformFunded: true })))
      .toBe(LIMIT_ERROR_MESSAGES.NO_CLOUDFLARE_TOKEN);
  });

  it("doesn't count a user's own-key model, or anything with the limits off", async () => {
    const id = ownerId();
    for (let i = 0; i < 3; i++) {
      expect(await outcome(chargeBindingCall(limited(1), users, { ownerId: id, platformFunded: false }))).toBe("ok");
    }
    const open = { ...env, ENABLE_CLOUDFLARE_LIMITS: undefined } as unknown as Env;
    for (let i = 0; i < 3; i++) {
      expect(await outcome(chargeBindingCall(open, users, { ownerId: id, platformFunded: true }))).toBe("ok");
    }
    // Nothing above was counted: the owner still has their one call.
    expect(await outcome(chargeBindingCall(limited(1), users, { ownerId: id, platformFunded: true }))).toBe("ok");
  });

  it("a binding with no recorded owner is refused while the limits are on (fail closed)", async () => {
    expect(await outcome(chargeBindingCall(limited(40), users, { platformFunded: true }))).toBe(BINDING_WITHOUT_OWNER);
    const open = { ...env, ENABLE_CLOUDFLARE_LIMITS: undefined } as unknown as Env;
    expect(await outcome(chargeBindingCall(open, users, { platformFunded: true }))).toBe("ok");
  });
});
