import { useSyncExternalStore } from "react";
import type { RpcStub } from "capnweb";
import type { AttentionItem, AttentionPersonalState, AuthenticatedApi } from "@gadgets/workshop-shared/api";

/** What the person's attention list is right now. A failure is never shown as an empty list. */
export type AttentionSnapshot =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; items: AttentionItem[] };

type Api = RpcStub<AuthenticatedApi> | AuthenticatedApi;

/** How often a visible list checks again, so status changes and revoked targets show up. */
export const ATTENTION_REFRESH_MS = 60_000;

class AttentionStore {
  #snapshot: AttentionSnapshot = { status: "loading" };
  #listeners = new Set<() => void>();
  #generation = 0;
  #timer: ReturnType<typeof setInterval> | undefined;

  constructor(private api: Api) {}

  getSnapshot = (): AttentionSnapshot => this.#snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    if (this.#listeners.size === 1) this.#start();
    return () => {
      this.#listeners.delete(listener);
      if (this.#listeners.size === 0) this.#stop();
    };
  };

  /** Read the list again. A later read always wins over an earlier one still in flight. */
  refresh = (): void => {
    const generation = ++this.#generation;
    void this.api.getAttentionItems().then(items => {
      if (generation === this.#generation) this.#set({ status: "ready", items });
    }, () => {
      if (generation === this.#generation) this.#set({ status: "error" });
    });
  };

  /**
   * Set the person's own state for one item. It changes nothing in InferLab. Shown at once, then
   * read again, so another tab's change or a revoked target settles to what the server says.
   */
  setPersonal = async (itemKey: string, personal: AttentionPersonalState): Promise<void> => {
    const current = this.#snapshot;
    if (current.status === "ready") {
      this.#set({ status: "ready", items: current.items.map(item =>
        item.itemKey === itemKey ? { ...item, personal } : item) });
    }
    try {
      await this.api.setAttentionState(itemKey, personal);
    } finally {
      this.refresh();
    }
  };

  #set(snapshot: AttentionSnapshot): void {
    this.#snapshot = snapshot;
    for (const listener of this.#listeners) listener();
  }

  #onFocus = (): void => {
    if (document.visibilityState === "visible") this.refresh();
  };

  #start(): void {
    this.refresh();
    this.#timer = setInterval(this.refresh, ATTENTION_REFRESH_MS);
    window.addEventListener("focus", this.#onFocus);
    document.addEventListener("visibilitychange", this.#onFocus);
  }

  #stop(): void {
    clearInterval(this.#timer);
    this.#timer = undefined;
    window.removeEventListener("focus", this.#onFocus);
    document.removeEventListener("visibilitychange", this.#onFocus);
  }
}

// One store per signed-in API, so the sidebar badge and the Home list share one read.
const stores = new WeakMap<object, AttentionStore>();

const storeFor = (api: Api): AttentionStore => {
  let store = stores.get(api);
  if (!store) {
    store = new AttentionStore(api);
    stores.set(api, store);
  }
  return store;
};

/** The person's attention items, kept current, and the two things they can do to their own state. */
export const useAttentionItems = (api: Api) => {
  const store = storeFor(api);
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
  return { snapshot, refresh: store.refresh, setPersonal: store.setPersonal };
};

/** The items counted on the badge: unread and not dismissed. */
export const attentionUnreadCount = (snapshot: AttentionSnapshot): number =>
  snapshot.status === "ready" ? snapshot.items.filter(item => item.personal === "unread").length : 0;
