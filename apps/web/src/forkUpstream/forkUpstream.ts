import { compareSemverVersions } from "@t3tools/shared/semver";
import { useSyncExternalStore } from "react";

import forkUpstream from "../../../../fork-upstream.json";

// Fork-only: tells the user when upstream T3 Code has a newer release than this fork's base. It
// only links to the sync instructions; it never installs official binaries over the fork.

// Same cadence as apps/desktop/src/updates/DesktopUpdates.ts (startup delay, then every 4 hours).
const STARTUP_DELAY_MS = 15_000;
const POLL_INTERVAL_MS = 4 * 60 * 60 * 1_000;

export interface UpstreamRelease {
  readonly tag_name: string;
  readonly html_url: string;
  readonly draft: boolean;
}

export interface UpstreamNotice {
  readonly latestVersion: string;
  readonly baseVersion: string;
  readonly releaseUrl: string;
  readonly syncUrl: string;
}

const stripV = (tag: string) => tag.replace(/^v/, "");

export const FORK_SYNC_URL = `https://github.com/${forkUpstream.fork}/blob/main/FORK.md#syncing-with-upstream`;

export function upstreamNotice(
  baseTag: string,
  latest: UpstreamRelease | null,
): UpstreamNotice | null {
  if (latest === null || latest.draft) return null;
  const latestVersion = stripV(latest.tag_name);
  const baseVersion = stripV(baseTag);
  if (compareSemverVersions(latestVersion, baseVersion) <= 0) return null;
  return { latestVersion, baseVersion, releaseUrl: latest.html_url, syncUrl: FORK_SYNC_URL };
}

let current: UpstreamNotice | null = null;
let started = false;
const listeners = new Set<() => void>();

async function check() {
  try {
    // `releases/latest` is the newest non-draft, non-prerelease release, so nightlies do not nag.
    const response = await fetch(
      `https://api.github.com/repos/${forkUpstream.upstream}/releases/latest`,
      { headers: { Accept: "application/vnd.github+json" } },
    );
    if (!response.ok) return;
    const next = upstreamNotice(forkUpstream.baseTag, (await response.json()) as UpstreamRelease);
    if (next?.latestVersion === current?.latestVersion) return;
    current = next;
    for (const listener of listeners) listener();
  } catch {
    // Offline or rate limited: keep the last answer and try again on the next poll.
  }
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (!started) {
    started = true;
    setTimeout(() => {
      void check();
      setInterval(() => void check(), POLL_INTERVAL_MS);
    }, STARTUP_DELAY_MS);
  }
  return () => listeners.delete(listener);
}

export function useUpstreamNotice(): UpstreamNotice | null {
  return useSyncExternalStore(
    subscribe,
    () => current,
    () => null,
  );
}

export const FORK_BASE_VERSION = stripV(forkUpstream.baseTag);
