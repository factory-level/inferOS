import { cloudflareTest } from "@cloudflare/vitest-plugin";
import capnwebValidate from "capnweb-validate/vite";
import { defineConfig } from "vitest/config";
import deployed from "./cloudflare.config.ts";

const { compatibilityDate, compatibilityFlags } = deployed.worker;

/**
 * The workerd suite: the connection end to end against a fake InferOps faked at `fetch` (mock mode,
 * no network), with the connect attempt, accounts and Project facets driven through `TestHooks`
 * (__tests__/worker.ts). The `@validateRpc()` decorators are applied in-memory by the
 * capnweb-validate plugin.
 */
export default defineConfig({
  plugins: [
    capnwebValidate(),
    cloudflareTest({
      main: "./__tests__/worker.ts",
      miniflare: {
        compatibilityDate,
        compatibilityFlags,
        durableObjects: {
          CONNECT_ATTEMPT: { className: "ConnectAttempt", useSQLite: true },
          OPERATIONS_ACCOUNT: { className: "OperationsAccount", useSQLite: true },
          SUBJECT_INDEX: { className: "SubjectIndex", useSQLite: true },
          PROJECT_GATEKEEPER: { className: "ProjectGatekeeper", useSQLite: true },
          // The Project facet reads `ctx.props`, reachable only through `ctx.facets`, so tests drive
          // it from TestHooks, as the overseer does in production.
          TEST_HOOKS: { className: "TestHooks", useSQLite: true },
        },
        bindings: {
          INFERLAB_AUTH_ORIGIN: "http://localhost:23380",
          INFEROPS_COMPANY: "00000000-0000-4000-8000-000000000001",
          BASE_URL: "http://localhost:8787/gatekeeper/inferlab-ops",
        },
      },
    }),
  ],
  test: {
    include: ["__tests__/*.test.ts"],
    setupFiles: ["@gadgets/scripts/assert-workerd"],
  },
});
