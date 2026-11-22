// The daily limit at the model-binding boundary (FAC-296 part 2, fix round 1).
//
// With ENABLE_CLOUDFLARE_LIMITS on, an agent turn is counted before it starts (overseer.ts,
// checkUsageAndBalance). A gadget holding a language- or decision-model binding calls the model
// itself, outside any turn, so each of those calls is counted here, on the same counter: the
// binding's workspace owner's per-UTC-day count (UserDurableObject.consumeDailyLlmCall), against the
// same DAILY_LLM_CALL_LIMIT. Once the day's calls are used, the call is refused with the reason a
// refused turn gives. Only calls the platform pays for are counted: a model a user added with their
// own key costs the platform nothing and isn't. With the limits off, nothing is counted or refused.

import { LIMIT_ERROR_MESSAGES } from "@gadgets/workshop-shared/limits";
import { isCloudflareLimitsEnabled } from "../config.js";
import { getDailyLlmCallLimit } from "./config.js";
import type { UserDurableObject } from "../../user.js";

/** Why a binding made before the limits can't be counted. Shown to the gadget's caller. */
export const BINDING_WITHOUT_OWNER =
  "This model binding can't be counted against a daily limit: bind the model again.";

/**
 * Counts one platform-funded binding call against the owner's daily limit, or throws when the day's
 * calls are used up. `ownerId` is the workspace owner's UserDurableObject id, recorded on the binding
 * when it was made; a binding without one fails closed while the limits are on.
 */
export async function chargeBindingCall(
  env: Cloudflare.Env,
  users: DurableObjectNamespace<UserDurableObject> | (() => DurableObjectNamespace<UserDurableObject>),
  binding: { ownerId?: string; platformFunded: boolean },
): Promise<void> {
  if (!isCloudflareLimitsEnabled(env) || !binding.platformFunded) return;
  if (!binding.ownerId) throw new Error(BINDING_WITHOUT_OWNER);
  // Resolved only when a call is counted: a deployment without the limits never touches it.
  const namespace = typeof users === "function" ? users() : users;
  const owner = namespace.get(namespace.idFromString(binding.ownerId));
  const quota = await owner.consumeDailyLlmCall(getDailyLlmCallLimit(env));
  if (!quota.withinLimits) throw new Error(LIMIT_ERROR_MESSAGES.NO_CLOUDFLARE_TOKEN);
}
