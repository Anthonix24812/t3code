import { describe, expect, it } from "vite-plus/test";

import { newestRelease, upstreamNotice } from "./forkUpstream";

const release = (tag_name: string, draft = false) => ({
  tag_name,
  draft,
  html_url: `https://github.com/pingdotgg/t3code/releases/tag/${tag_name}`,
});

describe("upstreamNotice", () => {
  it("names a newer upstream release and the base this build uses", () => {
    expect(upstreamNotice("v0.1.10-nightly.20261113.4643", release("v0.1.10"))).toMatchObject({
      latestVersion: "0.1.10",
      baseVersion: "0.1.10-nightly.20261113.4643",
    });
  });

  it("stays quiet for the same, older, or draft releases", () => {
    expect(upstreamNotice("v0.1.10-nightly.20261113.4643", release("v0.1.9"))).toBeNull();
    expect(upstreamNotice("v0.1.10", release("v0.1.10"))).toBeNull();
    expect(upstreamNotice("v0.1.9", release("v0.2.0", true))).toBeNull();
    expect(upstreamNotice("v0.1.9", null)).toBeNull();
  });

  it("compares nightly builds with each other", () => {
    expect(
      upstreamNotice("v0.1.10-nightly.20261113.4643", release("v0.1.10-nightly.20261114.4700")),
    ).toMatchObject({ latestVersion: "0.1.10-nightly.20261114.4700" });
    expect(
      upstreamNotice("v0.1.10-nightly.20261114.4700", release("v0.1.10-nightly.20261113.4643")),
    ).toBeNull();
  });
});

describe("newestRelease", () => {
  it("takes the newest non-draft version tag and skips feeds and drafts", () => {
    expect(
      newestRelease([
        release("update-feed"),
        release("v0.1.11-nightly.20261115.4800", true),
        release("v0.1.10-nightly.20261113.4643"),
        release("v0.1.10-nightly.20261114.4700"),
        release("v0.1.9"),
      ])?.tag_name,
    ).toBe("v0.1.10-nightly.20261114.4700");
    expect(newestRelease([release("update-feed")])).toBeNull();
  });
});
