// The Durable Object history a stage's deployed backend really has, when it was last deployed from
// another line (FAC-296 part 3).
//
// Cloudflare keeps a worker's Durable Objects across deploys and records the last migration tag it
// applied. A deploy must present that tag in its own history, and every class the deployed worker
// has must be exported, or explicitly deleted. dev-os's backend (`inferos-dev-workshop-backend`) was
// last deployed from the archived `main`, whose history diverges from this line's at v4:
//
//   both lines   v0 UserDurableObject + OverseerDurableObject, v1 AdminSettings, v2 PendingLogin,
//                v3 UserDirectoryDurableObject
//   archived     v4 SubjectPresenceDurableObject, v5 AuthoredWidgetBuildDurableObject
//   this line    v4 AdminAuditDurableObject
//
// Deploying this line's history there fails (the published tag "v5" isn't in it, and Wrangler then
// tries to create UserDurableObject again: error 10074). So a stage that names a deployed lineage
// gets that lineage's history plus one continuation, instead of this line's own:
//
//   v0..v5 exactly as the archived line declared them (already applied on the stage), then
//   v6: new_sqlite_classes AdminAuditDurableObject (what this line's v4 adds), and
//       deleted_classes SubjectPresenceDurableObject, AuthoredWidgetBuildDurableObject (which this
//       line neither exports nor binds).
//
// Calvin's decision of 2026-11-23: migrate dev-os in place, keeping the backend worker and its data.
// packages/workshop-backend/wrangler.jsonc is untouched: previews and every fresh deployment keep
// this line's own history. Only a stage's generated config carries a lineage.
//
// The deletion destroys the two classes' storage, and `wrangler rollback` never undoes it, so it is
// pinned here by name ({@link ARCHIVED_MAIN_DELETED_CLASSES}) and allowed only on the stages named in
// {@link LINEAGE_DELETION_STAGES}. Any other destructive migration is still refused (stage.ts).

import type { DurableObjectMigration } from "../release/manifest-lib.ts";

/** A deployed worker's Durable Object history from another line, and how it continues onto this one. */
export interface DeployedLineage {
  /** Short name, printed in the plan. */
  name: string;
  /** Where the history was read from. */
  source: string;
  /** The deployed worker's migrations, verbatim from the line that applied them, oldest first. */
  applied: readonly DurableObjectMigration[];
  /** The one migration that moves the deployed worker onto this line's classes. */
  continuation: DurableObjectMigration;
}

/**
 * The classes the archived line's backend created after the lines diverged, and that this line
 * neither exports nor binds. The continuation deletes exactly these, and nothing else.
 * - SubjectPresenceDurableObject: who is looking at an Operate subject now (presence).
 * - AuthoredWidgetBuildDurableObject: the isolated build of an authored widget (FAC-8 1c).
 */
export const ARCHIVED_MAIN_DELETED_CLASSES = [
  "SubjectPresenceDurableObject", "AuthoredWidgetBuildDurableObject",
] as const;

/** The stages allowed to apply {@link ARCHIVED_MAIN_DELETED_CLASSES}'s deletion, by name. */
export const LINEAGE_DELETION_STAGES: readonly string[] = ["dev"];

/**
 * The archived `main`'s workshop-backend history (`git show origin/main:packages/workshop-backend/
 * wrangler.jsonc`, last changed by e063a246c, "FAC-8 1c: compile widgets in isolated build DO"), and
 * its continuation onto this line.
 */
export const ARCHIVED_MAIN_BACKEND_LINEAGE: DeployedLineage = {
  name: "archived main",
  source: "origin/main:packages/workshop-backend/wrangler.jsonc",
  applied: [
    { tag: "v0", new_sqlite_classes: ["UserDurableObject", "OverseerDurableObject"] },
    { tag: "v1", new_sqlite_classes: ["AdminSettings"] },
    { tag: "v2", new_sqlite_classes: ["PendingLogin"] },
    { tag: "v3", new_sqlite_classes: ["UserDirectoryDurableObject"] },
    { tag: "v4", new_sqlite_classes: ["SubjectPresenceDurableObject"] },
    { tag: "v5", new_sqlite_classes: ["AuthoredWidgetBuildDurableObject"] },
  ],
  continuation: {
    tag: "v6",
    new_sqlite_classes: ["AdminAuditDurableObject"],
    deleted_classes: [...ARCHIVED_MAIN_DELETED_CLASSES],
  },
};

function sameMigration(a: DurableObjectMigration, b: DurableObjectMigration): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** The classes a run of migrations creates, after checking it only creates SQLite classes. */
function createdClasses(migrations: readonly DurableObjectMigration[], which: string): Set<string> {
  const classes = new Set<string>();
  for (const migration of migrations) {
    const extra = Object.keys(migration).filter((key) => key !== "tag" && key !== "new_sqlite_classes");
    if (extra.length > 0) {
      throw new Error(`${which} migration ${migration.tag} does ${extra.join(", ")}; a lineage can only ` +
          "bridge migrations that add SQLite classes, so declare this case by hand");
    }
    for (const name of migration.new_sqlite_classes ?? []) classes.add(name);
  }
  return classes;
}

function sameSet(a: ReadonlySet<string>, b: readonly string[] | undefined): boolean {
  return a.size === (b ?? []).length && (b ?? []).every((name) => a.has(name));
}

/**
 * The history a stage deploys the backend with: the lineage's applied migrations, then its
 * continuation. Checked against this line's own history (`own`), so a lineage that no longer
 * matches the package fails the run instead of a deploy:
 * - the lineage and this line share a prefix (v0..v3), migration for migration;
 * - after it, both sides only add SQLite classes, and none on both;
 * - the continuation adds exactly this line's classes after the prefix, deletes exactly the
 *   lineage's, and does nothing else, under a tag the lineage hasn't used.
 * A new migration on this line therefore fails here until the lineage declares its next step.
 */
export function continueLineage(own: readonly DurableObjectMigration[], lineage: DeployedLineage):
    DurableObjectMigration[] {
  const { applied, continuation } = lineage;
  let shared = 0;
  while (shared < own.length && shared < applied.length && sameMigration(own[shared], applied[shared])) shared++;
  if (shared === 0) throw new Error(`the ${lineage.name} lineage shares no migration with this line's history`);
  if (shared === applied.length) {
    throw new Error(`the ${lineage.name} lineage adds nothing after this line's history; drop the lineage`);
  }
  const deployedOnly = createdClasses(applied.slice(shared), lineage.name);
  const ownOnly = createdClasses(own.slice(shared), "this line's");
  const both = [...ownOnly].filter((name) => deployedOnly.has(name));
  if (both.length > 0) throw new Error(`both lines create ${both.join(", ")} after ${own[shared - 1].tag}`);

  const problems: string[] = [];
  if (applied.some((migration) => migration.tag === continuation.tag)) {
    problems.push(`its tag ${continuation.tag} is already in the lineage`);
  }
  const extra = Object.keys(continuation).filter((key) =>
    key !== "tag" && key !== "new_sqlite_classes" && key !== "deleted_classes");
  if (extra.length > 0) problems.push(`it also does ${extra.join(", ")}`);
  if (!sameSet(ownOnly, continuation.new_sqlite_classes)) {
    problems.push(`it must add exactly this line's ${[...ownOnly].join(", ") || "(nothing)"}`);
  }
  if (!sameSet(deployedOnly, continuation.deleted_classes as string[] | undefined)) {
    problems.push(`it must delete exactly the lineage's ${[...deployedOnly].join(", ")}`);
  }
  if (problems.length > 0) {
    throw new Error(`the ${lineage.name} lineage's continuation doesn't match this line's history: ` +
        `${problems.join("; ")}`);
  }
  return [...applied.map((migration) => structuredClone(migration)), structuredClone(continuation)];
}

/** One destructive step in a migration history: which package, tag, operation and classes. */
export interface DestructiveStep {
  pkgName: string;
  tag: string;
  operation: "deleted_classes" | "renamed_classes" | "transferred_classes";
  classes: string[];
}

/** The destructive steps in one package's history: deletes, renames and transfers. */
export function destructiveSteps(pkgName: string, migrations: readonly DurableObjectMigration[]): DestructiveStep[] {
  const steps: DestructiveStep[] = [];
  for (const migration of migrations) {
    for (const operation of ["deleted_classes", "renamed_classes", "transferred_classes"] as const) {
      const value = migration[operation];
      if (Array.isArray(value) && value.length > 0) {
        steps.push({ pkgName, tag: migration.tag, operation,
          classes: value.map((entry) => typeof entry === "string" ? entry : JSON.stringify(entry)) });
      }
    }
  }
  return steps;
}

/**
 * Whether one destructive step is the declared deletion this stage may apply: the backend's
 * lineage continuation, deleting exactly {@link ARCHIVED_MAIN_DELETED_CLASSES}, on a stage named in
 * {@link LINEAGE_DELETION_STAGES} whose lineage is the archived main's.
 */
export function isDeclaredDeletion(stageName: string, lineage: DeployedLineage | undefined,
    step: DestructiveStep): boolean {
  return LINEAGE_DELETION_STAGES.includes(stageName) &&
    lineage === ARCHIVED_MAIN_BACKEND_LINEAGE &&
    step.pkgName === "workshop-backend" &&
    step.operation === "deleted_classes" &&
    step.tag === lineage.continuation.tag &&
    sameSet(new Set<string>(ARCHIVED_MAIN_DELETED_CLASSES), step.classes);
}
