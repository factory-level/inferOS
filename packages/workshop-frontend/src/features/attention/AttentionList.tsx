import { Button, SkeletonLine, useKumoToastManager } from "@cloudflare/kumo";
import { useEffect, useState } from "react";
import type { AttentionItem } from "@gadgets/workshop-shared/api";
import { useAuthenticatedApi } from "../../AuthContext";
import { rpcFailureDescription } from "../../rpcErrors";
import { AttentionRow, type AttentionLabel } from "./AttentionRow";
import { useAttentionItems } from "./attentionStore";
import { goToInferWork } from "./goToInferWork";

type Labels = { keys: string; labels: (string | null)[] } | { keys: string; failed: true };

/**
 * Home's "Needs attention": the person's own items, each labelled with their own InferLab rights.
 * Loading, empty, error and unavailable are each drawn deliberately: a failure to read the list or
 * its labels shows an error with Retry, never an empty list. Open asks the server for the link
 * (validated there against this deployment's InferWork origins) and only then leaves; the page
 * never builds a link or navigates on its own.
 */
export const AttentionList = () => {
  const { authenticatedApi } = useAuthenticatedApi();
  const { snapshot, refresh, setPersonal } = useAttentionItems(authenticatedApi);
  const toasts = useKumoToastManager();
  const [showDismissed, setShowDismissed] = useState(false);
  const [opening, setOpening] = useState<string | null>(null);
  const [labelRetry, setLabelRetry] = useState(0);
  const [labels, setLabels] = useState<Labels>();

  const items = snapshot.status === "ready" ? snapshot.items : [];
  const dismissedCount = items.filter(item => item.personal === "dismissed").length;
  const shown = showDismissed ? items : items.filter(item => item.personal !== "dismissed");
  const keys = shown.map(item => item.itemKey).join("\n");

  useEffect(() => {
    if (!keys) return;
    let active = true;
    authenticatedApi.describeAttentionItems(keys.split("\n")).then(result => {
      if (active) setLabels({ keys, labels: result });
    }, () => {
      if (active) setLabels({ keys, failed: true });
    });
    return () => { active = false; };
  }, [authenticatedApi, keys, labelRetry]);

  const current = labels?.keys === keys ? labels : undefined;
  const labelFor = (index: number): AttentionLabel => {
    if (!current || "failed" in current) return { status: "loading" };
    const label = current.labels[index];
    return label ? { status: "named", label } : { status: "gone" };
  };

  const open = async (item: AttentionItem) => {
    setOpening(item.itemKey);
    try {
      const { url } = await authenticatedApi.openAttentionItem(item.itemKey);
      if (item.personal === "unread") await setPersonal(item.itemKey, "read").catch(() => {});
      goToInferWork(url);
    } catch (error) {
      toasts.add({ title: "Couldn’t open this", description: rpcFailureDescription(error), variant: "error" });
      refresh();
    } finally {
      setOpening(null);
    }
  };

  const changePersonal = (item: AttentionItem, personal: AttentionItem["personal"]) => {
    setPersonal(item.itemKey, personal).catch(error => {
      toasts.add({ title: "Couldn’t update this item", description: rpcFailureDescription(error), variant: "error" });
    });
  };

  const failed = snapshot.status === "error" || (current !== undefined && "failed" in current);

  return (
    <section aria-labelledby="attention-heading" className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-3">
        <h2 id="attention-heading" className="text-sm font-semibold text-kumo-default">Needs attention</h2>
        {dismissedCount > 0 && !failed && (
          <Button size="xs" variant="ghost" aria-pressed={showDismissed}
            onClick={() => setShowDismissed(value => !value)}>
            {showDismissed ? "Hide dismissed" : `Show dismissed (${dismissedCount})`}
          </Button>
        )}
      </div>
      <div className="rounded-lg border border-kumo-line bg-kumo-base">
        {failed ? (
          <div role="alert" className="flex items-center justify-between gap-3 px-3 py-3 text-sm text-kumo-subtle">
            Couldn’t check what needs your attention.
            <Button size="xs" variant="secondary" onClick={() => {
              refresh();
              setLabelRetry(value => value + 1);
            }}>Retry</Button>
          </div>
        ) : snapshot.status === "loading" ? (
          <div role="status" aria-label="Loading what needs your attention" className="flex flex-col gap-3 px-3 py-4">
            <SkeletonLine minWidth={60} maxWidth={90} />
            <SkeletonLine minWidth={40} maxWidth={70} />
          </div>
        ) : shown.length === 0 ? (
          <p role="status" className="px-3 py-4 text-sm text-kumo-subtle">Nothing needs your attention.</p>
        ) : (
          <ul aria-label="Needs attention" className="divide-y divide-kumo-line">
            {shown.map((item, index) => (
              <AttentionRow key={item.itemKey} item={item} label={labelFor(index)}
                opening={opening === item.itemKey} onOpen={open} onPersonalChange={changePersonal} />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
};
