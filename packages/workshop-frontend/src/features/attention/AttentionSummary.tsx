import { Badge } from "@cloudflare/kumo";
import { BellSimple } from "@phosphor-icons/react";
import SidebarItem from "../../components/AppShell/SidebarItem";
import { useAuthenticatedApi } from "../../AuthContext";
import { attentionUnreadCount, useAttentionItems } from "./attentionStore";

/** The sidebar's way to Home's "Needs attention", with the count of unread, undismissed items. */
export const AttentionSummary = ({ collapsed }: { collapsed: boolean }) => {
  const { authenticatedApi } = useAuthenticatedApi();
  const { snapshot } = useAttentionItems(authenticatedApi);
  const count = attentionUnreadCount(snapshot);
  return (
    <SidebarItem
      to="/"
      label="Needs attention"
      icon={<BellSimple size={14} weight="regular" />}
      trailing={count > 0 ? (
        <span role="img" className="inline-flex shrink-0"
          aria-label={`${count} ${count === 1 ? "item needs" : "items need"} your attention`}>
          <Badge variant="blue">{count}</Badge>
        </span>
      ) : null}
      collapsed={collapsed}
    />
  );
};
