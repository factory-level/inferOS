// One person's InferLab operations connection (FAC-235): their own tokens and who they are, kept in
// this account's own Durable Object storage and nowhere else. Tokens never cross the account's RPC
// boundary except as a short-lived access token for one InferOps call.
//
// Ported from the archived fork's data-connection gatekeeper (archive/main-2026-11-14, 24f5d885,
// inferops-credentials.ts): the CredentialCoordinator wiring, the once-only expiry notice and the revoke. Left
// behind: the wiki search budget, the stored workspace list (resolved live here instead), staged
// reconnects (v1 reconnects by disconnecting and connecting again) and the system credential lane.

import { DurableObject } from "cloudflare:workers";
import { skipRpcValidation, validateRpc } from "capnweb-validate";
import { notifyCredentialsExpiredOnce } from "@gadgets/gatekeeper-kit/credential-expiry";
import {
  CredentialCoordinator, type CredentialsWithIdentity, type RejectionVerdict,
} from "@gadgets/gatekeeper-kit/credentials";
import type { GatekeeperConnectCallback } from "@gadgets/workshop-shared/gatekeeper";
import { readConfig } from "./config";
import {
  type Company, type Grant, type Identity, InferOpsApiError, OTHER_COMPANY, apiRequest, companyOf,
  logout, refreshGrant,
} from "./inferops-api";

export const VENDOR_ID = "inferlab-ops";
const CALLBACK_KEY = "callback";
const IDENTITY_KEY = "identity";

/** What a facet or verifier gets for one call: a short-lived token and whose it is. */
export type CallCredentials = { token: string; tenantId: string; subject: string };

function originOrThrow(env: Cloudflare.Env): string {
  const config = readConfig(env);
  if ("off" in config) throw new Error(config.off);
  return config.origin;
}

function companyOrThrow(env: Cloudflare.Env): string {
  const config = readConfig(env);
  if ("off" in config) throw new Error(config.off);
  return config.tenantId;
}

/** The InferOps answer for a record the person can't see, or can't do this to: a definite no. */
export const isDefiniteNo = (error: unknown): boolean =>
  error instanceof InferOpsApiError && (error.status === 403 || error.status === 404);

@validateRpc()
export class OperationsAccount extends DurableObject<Cloudflare.Env> {
  // InferLab rotates the refresh token inside one session, so revoking a fenced-out mint would end
  // the session the winning connection uses: no `discardMint` (gatekeeper-kit USAGE, "Revoke
  // discarded token rotations").
  #coordinator = new CredentialCoordinator<Grant>(this.ctx.storage.kv, {
    expiresAt: grant => grant.accessExpiresAt || undefined,
    vendorId: VENDOR_ID,
  });

  #refresh = (current: Grant): Promise<Grant> => refreshGrant(originOrThrow(this.env), current);

  #notify = (): Promise<void> => notifyCredentialsExpiredOnce(
    this.ctx.storage.kv,
    this.ctx.storage.kv.get<Fetcher<GatekeeperConnectCallback>>(CALLBACK_KEY),
    VENDOR_ID);

  /** Installs the grant a connect produced, with the Workshop callback that owns the account. */
  @skipRpcValidation()
  async install(grant: Grant, identity: Identity, callback: Fetcher<GatekeeperConnectCallback>): Promise<void> {
    this.ctx.storage.kv.put(CALLBACK_KEY, callback);
    this.ctx.storage.kv.put(IDENTITY_KEY, identity);
    this.#coordinator.connect(grant);
  }

  /** Who connected, or null once revoked. */
  async identity(): Promise<Identity | null> {
    return this.ctx.storage.kv.get<Identity>(IDENTITY_KEY) ?? null;
  }

  /**
   * A short-lived access token for one call, refreshing first when it is about to expire. Refuses
   * a connection of another company than this deployment's. Throws `CredentialsExpiredError` once
   * InferLab has confirmed the session dead.
   */
  async getCredentials(): Promise<CredentialsWithIdentity<CallCredentials>> {
    const { creds, identity, generation } = await this.#coordinator.snapshot(this.#refresh, { notify: this.#notify });
    const who = this.#ownCompany();
    return { creds: { token: creds.accessToken, tenantId: who.tenantId, subject: who.subject }, identity, generation };
  }

  /** The account's verdict on a token InferOps rejected; see `CredentialCoordinator`. */
  async reportCredentialsRejected(identity: string): Promise<RejectionVerdict> {
    return this.#coordinator.adjudicateRejection(identity, { refresh: this.#refresh, notify: this.#notify });
  }

  /** The person's company and workspaces, read live with their own token. */
  async company(): Promise<Company> {
    const { creds } = await this.getCredentials();
    return companyOf(originOrThrow(this.env), creds.token);
  }

  /**
   * Whether this person can read `path` in `workspaceId` now, with their own token: a 200 is yes, a
   * 403 or 404 is a definite no. Anything else (an outage, a session InferLab has ended) throws,
   * since access can't be determined. Reads no data back to anyone.
   */
  async canRead(path: string, workspaceId: string): Promise<boolean> {
    const { creds } = await this.getCredentials();
    try {
      await apiRequest(originOrThrow(this.env), creds.token, path, { workspaceId });
      return true;
    } catch (error) {
      if (isDefiniteNo(error)) return false;
      throw error;
    }
  }

  /** Whether this person holds `permission` in `workspaceId` now, as InferOps' guard decides it. */
  async holds(permission: string, workspaceId: string): Promise<boolean> {
    const { creds } = await this.getCredentials();
    try {
      const answer = await apiRequest(originOrThrow(this.env), creds.token,
        `/auth/permissions?permissions=${encodeURIComponent(permission)}`, { workspaceId });
      const decisions = (answer as { decisions?: { permission?: unknown; allowed?: unknown }[] } | null)?.decisions;
      return Array.isArray(decisions) && decisions.some(d => d.permission === permission && d.allowed === true);
    } catch (error) {
      // No grant in that workspace: the guard refuses before deciding anything.
      if (isDefiniteNo(error)) return false;
      throw error;
    }
  }

  /**
   * Ends this connection: signs its own InferLab session out and deletes every token at once, so
   * nothing can read with it again, then drops it from its person's subject index.
   */
  async revoke(): Promise<void> {
    const current = this.#coordinator.stored();
    const identity = this.ctx.storage.kv.get<Identity>(IDENTITY_KEY);
    this.#coordinator.clear();
    await this.ctx.storage.deleteAll();
    if (identity) {
      const index = this.ctx.exports.SubjectIndex.get(this.ctx.exports.SubjectIndex.idFromName(subjectIndexName(identity)));
      await index.forget(this.ctx.id.toString());
    }
    const config = readConfig(this.env);
    if (current && !("off" in config)) await logout(config.origin, current.refreshToken);
  }

  /** The identity, refusing one of another company than this deployment's. */
  #ownCompany(): Identity {
    const identity = this.ctx.storage.kv.get<Identity>(IDENTITY_KEY);
    if (!identity) throw new Error("This InferLab operations connection is not connected.");
    if (identity.tenantId !== companyOrThrow(this.env)) {
      throw Object.assign(new Error(OTHER_COMPANY), { name: "Forbidden" });
    }
    return identity;
  }
}

/** The index name for a person: their stable subject, as the contract keys it. */
export function subjectIndexName(subject: { issuer: string; subject: string }): string {
  const part = (s: string) => encodeURIComponent(s).replaceAll("~", "%7E");
  return `subject~${part(subject.issuer)}~${part(subject.subject)}`;
}

/**
 * Which connection belongs to a person, by their stable subject: the one the attention authority
 * answers with. The most recent connection wins; revoking it removes it. Holds ids only.
 */
@validateRpc()
export class SubjectIndex extends DurableObject<Cloudflare.Env> {
  async remember(accountId: string): Promise<void> {
    this.ctx.storage.kv.put("account", accountId);
  }

  async forget(accountId: string): Promise<void> {
    if (this.ctx.storage.kv.get<string>("account") === accountId) this.ctx.storage.kv.delete("account");
  }

  async account(): Promise<string | null> {
    return this.ctx.storage.kv.get<string>("account") ?? null;
  }
}
