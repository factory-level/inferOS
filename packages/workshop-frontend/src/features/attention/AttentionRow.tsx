import { Button } from "@cloudflare/kumo";
import { MapPin, Folder, File, Cube } from "@phosphor-icons/react";
import type { AttentionItem } from "@gadgets/workshop-shared/api";
import { formatRelativeTime } from "../../utils/formatRelativeTime";

/** What the row knows about its label: still loading, the record's name, or no longer available. */
export type AttentionLabel = { status: "loading" } | { status: "named"; label: string } | { status: "gone" };

const REASONS: Record<AttentionItem["reason"], string> = {
  review_requested: "Review requested",
};

const KindIcon = ({ kind }: { kind: AttentionItem["target"]["kind"] }) => {
  if (kind === "project/location") return <MapPin size={16} aria-hidden="true" />;
  if (kind === "project/project") return <Folder size={16} aria-hidden="true" />;
  if (kind === "knowledge/page") return <File size={16} aria-hidden="true" />;
  return <Cube size={16} aria-hidden="true" />;
};

type AttentionRowProps = {
  item: AttentionItem;
  label: AttentionLabel;
  opening: boolean;
  onOpen: (item: AttentionItem) => void;
  onPersonalChange: (item: AttentionItem, personal: AttentionItem["personal"]) => void;
};

/**
 * One item: the record's label, read with the viewer's own rights, the reason in plain words, its
 * age and whether it's unread. It shows no actor, source text or preview, because the item carries
 * none. A record the viewer can no longer see reads "No longer available", with no Open.
 */
export const AttentionRow = ({ item, label, opening, onOpen, onPersonalChange }: AttentionRowProps) => {
  const unread = item.personal === "unread";
  const dismissed = item.personal === "dismissed";
  const name = label.status === "named" ? label.label
    : label.status === "gone" ? "No longer available" : "Loading…";
  return (
    <li data-testid="attention-row" data-item-key={item.itemKey}
      className="flex min-w-0 items-center gap-3 px-3 py-3">
      <span className="shrink-0 text-kumo-subtle"><KindIcon kind={item.target.kind} /></span>
      <div className="min-w-0 flex-1">
        <p className={`truncate text-sm ${unread ? "font-semibold text-kumo-default" : "text-kumo-subtle"}`}>
          {name}
        </p>
        <p className="mt-0.5 text-xs text-kumo-subtle">
          {REASONS[item.reason]} · <time dateTime={item.createdAt}>{formatRelativeTime(new Date(item.createdAt))}</time>
          {dismissed && " · Dismissed"}
        </p>
      </div>
      {unread && <span role="img" aria-label="Unread" className="size-2 shrink-0 rounded-full bg-kumo-brand" />}
      <div className="flex shrink-0 items-center gap-1">
        {label.status === "named" && (
          <Button size="xs" variant="primary" loading={opening} onClick={() => onOpen(item)}>Open</Button>
        )}
        <Button size="xs" variant="ghost"
          onClick={() => onPersonalChange(item, unread ? "read" : "unread")}>
          {unread ? "Mark read" : "Mark unread"}
        </Button>
        <Button size="xs" variant="ghost"
          onClick={() => onPersonalChange(item, dismissed ? "read" : "dismissed")}>
          {dismissed ? "Restore" : "Dismiss"}
        </Button>
      </div>
    </li>
  );
};
