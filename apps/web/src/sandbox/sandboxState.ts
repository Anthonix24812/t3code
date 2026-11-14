import { SANDBOX_WS_METHODS } from "@t3tools/contracts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "@t3tools/client-runtime/state/runtime";

import { connectionAtomRuntime } from "../connection/runtime";

export const sandboxList = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:sandbox:list",
  tag: SANDBOX_WS_METHODS.list,
  staleTimeMs: 10_000,
  refreshIntervalMs: 30_000,
});

export const sandboxStop = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:sandbox:stop",
  tag: SANDBOX_WS_METHODS.stop,
});

export const sandboxDestroy = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:sandbox:destroy",
  tag: SANDBOX_WS_METHODS.destroy,
});
