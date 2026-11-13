import { CircleArrowUpIcon } from "lucide-react";

import { Button } from "../components/ui/button";
import { SidebarMenuButton, SidebarMenuItem } from "../components/ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { SettingsRow } from "../components/settings/settingsLayout";
import { FORK_BASE_VERSION, FORK_SYNC_URL, useUpstreamNotice } from "./forkUpstream";

const externalLink = (href: string) => <a href={href} target="_blank" rel="noreferrer noopener" />;

/** Fork: sidebar slot next to the update pill. */
export function SidebarForkUpstreamNotice() {
  const notice = useUpstreamNotice();
  if (!notice) return null;
  return (
    <SidebarMenuItem className="shrink-0">
      <Tooltip>
        <TooltipTrigger
          render={<SidebarMenuButton size="sm" render={externalLink(notice.syncUrl)} />}
        >
          <CircleArrowUpIcon />
          <span>Upstream T3 {notice.latestVersion} is out</span>
        </TooltipTrigger>
        <TooltipPopup side="top">
          This build is based on {notice.baseVersion}. Open the sync instructions.
        </TooltipPopup>
      </Tooltip>
    </SidebarMenuItem>
  );
}

/** Fork: Settings → About row. */
export function AboutForkUpstreamRow() {
  const notice = useUpstreamNotice();
  return (
    <SettingsRow
      title="Upstream"
      description={
        notice
          ? `Upstream T3 ${notice.latestVersion} is out; this build is based on ${notice.baseVersion}.`
          : `This fork is based on upstream T3 ${FORK_BASE_VERSION}.`
      }
      control={
        <Button size="sm" variant="outline" render={externalLink(notice?.syncUrl ?? FORK_SYNC_URL)}>
          Sync instructions
        </Button>
      }
    />
  );
}
