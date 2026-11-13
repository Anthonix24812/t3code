import type { ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveSandboxRunOn } from "./sandboxRunOn";

const provider = (instanceId: string, driver: string, enabled = true) =>
  ({
    instanceId,
    driver,
    enabled,
    models: [{ slug: `${instanceId}-model`, isDefault: true }],
  }) as unknown as ServerProvider;

describe("resolveSandboxRunOn", () => {
  it("is hidden until the server registers Boat instances", () => {
    expect(resolveSandboxRunOn([provider("claudeAgent", "claudeAgent")], "claudeAgent")).toBeNull();
    expect(
      resolveSandboxRunOn(
        [provider("claudeAgent", "claudeAgent"), provider("boatClaude", "acpRegistry", false)],
        "claudeAgent",
      ),
    ).toBeNull();
  });

  it("moves to the Boat instance of the current agent family and back", () => {
    const providers = [
      provider("claudeAgent", "claudeAgent"),
      provider("codex", "codex"),
      provider("boatClaude", "acpRegistry"),
      provider("boatCodex", "acpRegistry"),
    ];
    expect(resolveSandboxRunOn(providers, "codex")).toEqual({
      active: false,
      enter: { instanceId: "boatCodex", model: "boatCodex-model" },
      leave: null,
    });
    expect(resolveSandboxRunOn(providers, "boatCodex")).toEqual({
      active: true,
      enter: null,
      leave: { instanceId: "codex", model: "codex-model" },
    });
    expect(resolveSandboxRunOn(providers, "cursor")?.enter?.instanceId).toBe("boatClaude");
  });
});
