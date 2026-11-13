import type { ProviderInstanceId, ServerProvider } from "@t3tools/contracts";
import { resolveSandboxRunOn } from "@t3tools/client-runtime/sandbox-run-on";

export interface SandboxRunOnControl {
  readonly active: boolean;
  readonly enter: () => void;
  readonly leave: () => void;
}

export function sandboxRunOnControl(
  providers: ReadonlyArray<ServerProvider>,
  currentInstanceId: string | null,
  select: (instanceId: ProviderInstanceId, model: string) => void,
  onEnter?: () => void,
): SandboxRunOnControl | undefined {
  const target = resolveSandboxRunOn(providers, currentInstanceId);
  if (!target) return undefined;
  return {
    active: target.active,
    enter: () => {
      if (target.enter) select(target.enter.instanceId, target.enter.model);
      onEnter?.();
    },
    leave: () => target.leave && select(target.leave.instanceId, target.leave.model),
  };
}
