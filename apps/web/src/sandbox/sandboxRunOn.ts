import {
  SANDBOX_AGENTS,
  isSandboxProviderInstanceId,
  sandboxProviderInstanceId,
  type ProviderInstanceId,
  type SandboxAgent,
  type ServerProvider,
} from "@t3tools/contracts";

// Fork: "Run on → Boat sandbox" switches the thread to the Boat provider instance of the same
// agent family; leaving it switches back to that family's local provider.
const AGENT_DRIVERS: Record<SandboxAgent, string> = {
  claude: "claudeAgent",
  codex: "codex",
  gemini: "gemini",
};

export interface SandboxRunOnTarget {
  readonly active: boolean;
  readonly enter: { readonly instanceId: ProviderInstanceId; readonly model: string } | null;
  readonly leave: { readonly instanceId: ProviderInstanceId; readonly model: string } | null;
}

const pick = (provider: ServerProvider | undefined) =>
  provider
    ? {
        instanceId: provider.instanceId,
        model:
          provider.models.find((model) => model.isDefault)?.slug ??
          provider.models[0]?.slug ??
          "default",
      }
    : null;

/** `null` hides the option: no Boat key, so the server registered no Boat instances. */
export function resolveSandboxRunOn(
  providers: ReadonlyArray<ServerProvider>,
  currentInstanceId: string | null,
): SandboxRunOnTarget | null {
  const sandboxProviders = providers.filter(
    (provider) => provider.enabled && isSandboxProviderInstanceId(provider.instanceId),
  );
  if (sandboxProviders.length === 0) return null;
  const current = providers.find((provider) => provider.instanceId === currentInstanceId);
  const active = currentInstanceId !== null && isSandboxProviderInstanceId(currentInstanceId);
  const agent = active
    ? SANDBOX_AGENTS.find((candidate) => sandboxProviderInstanceId(candidate) === currentInstanceId)
    : SANDBOX_AGENTS.find((candidate) => AGENT_DRIVERS[candidate] === current?.driver);
  const sandboxFor = (candidate: SandboxAgent | undefined) =>
    sandboxProviders.find(
      (provider) => provider.instanceId === sandboxProviderInstanceId(candidate ?? "claude"),
    ) ?? sandboxProviders[0];
  const localFor = (candidate: SandboxAgent | undefined) =>
    providers.find(
      (provider) =>
        provider.enabled &&
        !isSandboxProviderInstanceId(provider.instanceId) &&
        provider.driver === AGENT_DRIVERS[candidate ?? "claude"],
    ) ??
    providers.find(
      (provider) => provider.enabled && !isSandboxProviderInstanceId(provider.instanceId),
    );
  return {
    active,
    enter: active ? null : pick(sandboxFor(agent)),
    leave: active ? pick(localFor(agent)) : null,
  };
}

export interface SandboxRunOnControl {
  readonly active: boolean;
  readonly enter: () => void;
  readonly leave: () => void;
}

export function sandboxRunOnControl(
  providers: ReadonlyArray<ServerProvider>,
  currentInstanceId: string | null,
  select: (instanceId: ProviderInstanceId, model: string) => void,
): SandboxRunOnControl | undefined {
  const target = resolveSandboxRunOn(providers, currentInstanceId);
  if (!target) return undefined;
  return {
    active: target.active,
    enter: () => target.enter && select(target.enter.instanceId, target.enter.model),
    leave: () => target.leave && select(target.leave.instanceId, target.leave.model),
  };
}
