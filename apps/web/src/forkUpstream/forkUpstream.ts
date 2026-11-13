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

export type UpstreamChannel = "stable" | "nightly";

const VERSION_TAG = /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/** The newest non-draft release with a version tag; other tags such as `update-feed` are skipped. */
export function newestRelease(releases: ReadonlyArray<UpstreamRelease>): UpstreamRelease | null {
  let newest: UpstreamRelease | null = null;
  for (const release of releases) {
    if (release.draft || !VERSION_TAG.test(release.tag_name)) continue;
    if (
      newest === null ||
      compareSemverVersions(stripV(release.tag_name), stripV(newest.tag_name)) > 0
    ) {
      newest = release;
    }
  }
  return newest;
}

const CHANNEL_KEY = "t3.forkUpstream.channel";
const readChannel = (): UpstreamChannel => {
  try {
    return localStorage.getItem(CHANNEL_KEY) === "nightly" ? "nightly" : "stable";
  } catch {
    return "stable";
  }
};

interface UpstreamState {
  readonly channel: UpstreamChannel;
  readonly notice: UpstreamNotice | null;
}

let state: UpstreamState = { channel: readChannel(), notice: null };
let started = false;
const listeners = new Set<() => void>();
const publish = (next: UpstreamState) => {
  state = next;
  for (const listener of listeners) listener();
};

async function fetchLatest(channel: UpstreamChannel): Promise<UpstreamRelease | null> {
  const base = `https://api.github.com/repos/${forkUpstream.upstream}/releases`;
  // `releases/latest` skips drafts and prereleases; nightlies need the list.
  const response = await fetch(channel === "stable" ? `${base}/latest` : `${base}?per_page=20`, {
    headers: { Accept: "application/vnd.github+json" },
  });
  if (!response.ok) return null;
  const body = (await response.json()) as UpstreamRelease | ReadonlyArray<UpstreamRelease>;
  return Array.isArray(body) ? newestRelease(body) : newestRelease([body as UpstreamRelease]);
}

async function check() {
  const channel = state.channel;
  try {
    const latest = await fetchLatest(channel);
    if (latest === null || channel !== state.channel) return;
    const notice = upstreamNotice(forkUpstream.baseTag, latest);
    if (notice?.latestVersion === state.notice?.latestVersion) return;
    publish({ channel, notice });
  } catch {
    // Offline or rate limited: keep the last answer and try again on the next poll.
  }
}

export function setUpstreamChannel(channel: UpstreamChannel) {
  try {
    localStorage.setItem(CHANNEL_KEY, channel);
  } catch {
    // Private mode: the choice lasts for this session only.
  }
  publish({ channel, notice: null });
  void check();
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

const SERVER_STATE: UpstreamState = { channel: "stable", notice: null };

export function useUpstreamState(): UpstreamState {
  return useSyncExternalStore(
    subscribe,
    () => state,
    () => SERVER_STATE,
  );
}

export const useUpstreamNotice = () => useUpstreamState().notice;

export const FORK_BASE_VERSION = stripV(forkUpstream.baseTag);
