/// <reference types="@cloudflare/vitest-plugin/types" />

import type { ConnectAttempt } from "../src/worker.js";
import type { TestHooks } from "./worker.js";

declare global {
  namespace Cloudflare {
    interface Env {
      // Declared only in vitest.config.ts.
      CONNECT_ATTEMPT: DurableObjectNamespace<ConnectAttempt>;
      TEST_HOOKS: DurableObjectNamespace<TestHooks>;
    }
  }
}
