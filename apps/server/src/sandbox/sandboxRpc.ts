import { SANDBOX_WS_METHODS, SandboxError, type ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { SandboxProvisioner } from "./SandboxProvisioner.ts";

const unavailable = new SandboxError({
  message: "Boat sandboxes are not available on this server.",
});

/** Spread into ws.ts's handler map; each handler calls one provisioner method. */
export const sandboxRpcHandlers = (provisioner: Option.Option<SandboxProvisioner["Service"]>) => {
  const use = <A>(
    run: (service: SandboxProvisioner["Service"]) => Effect.Effect<A, SandboxError>,
  ) => Option.match(provisioner, { onNone: () => Effect.fail(unavailable), onSome: run });
  return {
    [SANDBOX_WS_METHODS.list]: (_input: object) => use((service) => service.list),
    [SANDBOX_WS_METHODS.stop]: (input: { readonly threadId: ThreadId }) =>
      use((service) => service.stop(input.threadId)),
    [SANDBOX_WS_METHODS.destroy]: (input: { readonly threadId: ThreadId }) =>
      use((service) => service.destroy(input.threadId)),
  };
};
