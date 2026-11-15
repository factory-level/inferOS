import {
  DEFAULT_GATEKEEPER_WRANGLER, OBSERVABILITY, defineGadgetsWorker, type DurableObjectMigration,
} from "@gadgets/scripts/worker-config";

/**
 * InferLab operations (FAC-235): a person's own InferOps connection. No `vars`: INFERLAB_AUTH_ORIGIN
 * and INFEROPS_COMPANY are set per deployment, and without both the vendor connects nobody. The
 * secret INFERLAB_EVENT_DESTINATIONS (FAC-236) turns on InferOps' event deliveries and their hooks.
 */
export default defineGadgetsWorker({
  name: "gatekeeper-inferlabops",
  entrypoint: ".wrangler/validate/src/worker.ts",
  compatibilityFlags: ["allow_irrevocable_stub_storage"],
  observability: OBSERVABILITY,
});

export const wrangler = DEFAULT_GATEKEEPER_WRANGLER;

/**
 * ConnectAttempt: one short-lived connect. OperationsAccount: one person's tokens. SubjectIndex:
 * which connection is whose, for the attention authority. ProjectGatekeeper: one Project facet.
 * ProjectEventDriver (v2, FAC-236): the deployment's one receiver of InferOps events and their hooks.
 */
export const migrations: DurableObjectMigration[] = [
  { tag: "v1", new_sqlite_classes: ["ConnectAttempt", "OperationsAccount", "SubjectIndex", "ProjectGatekeeper"] },
  { tag: "v2", new_sqlite_classes: ["ProjectEventDriver"] },
];
