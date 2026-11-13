import { describe, expect, it } from "vite-plus/test";

import { upstreamNotice } from "./forkUpstream";

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
});
