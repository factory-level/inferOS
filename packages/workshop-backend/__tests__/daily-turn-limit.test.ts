// FAC-296 part 2: the spend guard a persistent stage turns on (scripts/stage, `agents`):
// ENABLE_CLOUDFLARE_LIMITS=true with DAILY_LLM_CALL_LIMIT. Each agent turn the overseer starts
// (overseer.ts, before runAgent) asks checkUsageAndBalance, which counts one call on the workspace
// owner's per-UTC-day counter (UserDurableObject.consumeDailyLlmCall) and refuses the turn once the
// day's calls are used up. This drives the real check against a real UserDurableObject.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { checkUsageAndBalance } from "../src/ai-gateway-billing/limits/usage-checker.js";

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
