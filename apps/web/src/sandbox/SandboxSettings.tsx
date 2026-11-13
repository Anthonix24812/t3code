import {
  DEFAULT_SANDBOX_IDLE_MINUTES,
  DEFAULT_SANDBOX_MAX_CONCURRENT_VMS,
  SANDBOX_AGENT_LABELS,
  type EnvironmentId,
  type SandboxSize,
} from "@t3tools/contracts";

import { Button } from "../components/ui/button";
import { DraftInput } from "../components/ui/draft-input";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { SecretInput } from "../components/settings/SecretInput";
import { SettingsRow, SettingsSection } from "../components/settings/settingsLayout";
import { useEnvironmentSettings, useUpdateEnvironmentSettings } from "../hooks/useSettings";
import { useEnvironmentQuery } from "../state/query";
import { useAtomCommand } from "../state/use-atom-command";
import { sandboxDestroy, sandboxList, sandboxStop } from "./sandboxState";

const SIZES: ReadonlyArray<{ readonly value: SandboxSize; readonly label: string }> = [
  { value: "small", label: "Small" },
  { value: "default", label: "Default" },
  { value: "large", label: "Large" },
];

/** Fork: Settings → Environments → Boat sandbox. */
export function SandboxSettings({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const sandbox = useEnvironmentSettings(environmentId, (settings) => settings.sandbox);
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const { data, refresh } = useEnvironmentQuery(sandboxList({ environmentId, input: {} }));
  const stop = useAtomCommand(sandboxStop);
  const destroy = useAtomCommand(sandboxDestroy);
  const keyConfigured = typeof sandbox.boatApiKey === "string" && sandbox.boatApiKey.length > 0;

  return (
    <SettingsSection id="boat-sandbox" title="Boat sandbox">
      <SettingsRow
        title="boat.dev API key"
        description={
          keyConfigured || data?.configured
            ? "New threads can choose Run on → Boat sandbox. Each thread gets its own VM."
            : "Add a key to run threads on their own boat.dev VM. It stays on this server."
        }
        control={
          <SecretInput
            className="w-64"
            configured={keyConfigured}
            value=""
            placeholder="boat_…"
            aria-label="boat.dev API key"
            onCommit={(next) => updateSettings({ sandbox: { boatApiKey: next.trim() } })}
          />
        }
      />
      <SettingsRow
        title="Agent credentials"
        description="Agents on a VM get none of this machine's logins or keys. Add T3_SANDBOX_ENV_ANTHROPIC_API_KEY (or OPENAI_, GEMINI_…) to a Boat provider's environment in Settings → Providers."
      />
      <SettingsRow
        title="VM size"
        description="Applies to new VMs, and to stopped ones when they resume."
        control={
          <Select
            value={sandbox.size}
            onValueChange={(next) => {
              if (next !== null) updateSettings({ sandbox: { size: next as SandboxSize } });
            }}
            items={SIZES}
          >
            <SelectTrigger size="sm" className="w-32" aria-label="VM size">
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              {SIZES.map((size) => (
                <SelectItem key={size.value} value={size.value}>
                  {size.label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
      <SettingsRow
        title="Stop when idle"
        description="Minutes without a running turn before a VM is stopped and snapshotted. The next message resumes it. 0 never stops it."
        control={
          <DraftInput
            className="w-20"
            type="number"
            min={0}
            value={String(sandbox.idleMinutes)}
            aria-label="Idle minutes"
            onCommit={(next) => {
              const minutes = Number.parseInt(next, 10);
              updateSettings({
                sandbox: {
                  idleMinutes:
                    Number.isInteger(minutes) && minutes >= 0
                      ? Math.min(minutes, 24 * 60)
                      : DEFAULT_SANDBOX_IDLE_MINUTES,
                },
              });
            }}
          />
        }
      />
      <SettingsRow
        title="VMs per thread tree"
        description="The most Boat VMs a thread and the tasks it splits off may run at once."
        control={
          <DraftInput
            className="w-20"
            type="number"
            min={1}
            max={20}
            value={String(sandbox.maxConcurrentVms)}
            aria-label="VMs per thread tree"
            onCommit={(next) => {
              const limit = Number.parseInt(next, 10);
              updateSettings({
                sandbox: {
                  maxConcurrentVms:
                    Number.isInteger(limit) && limit >= 1
                      ? Math.min(limit, 20)
                      : DEFAULT_SANDBOX_MAX_CONCURRENT_VMS,
                },
              });
            }}
          />
        }
      />
      {(data?.sandboxes ?? []).map((record) => (
        <SettingsRow
          key={record.threadId}
          title={record.name}
          description={`${SANDBOX_AGENT_LABELS[record.agent]} · ${record.state}${record.error ? ` · ${record.error}` : ""}`}
          control={
            <div className="flex items-center gap-1">
              {record.state === "running" ? (
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() =>
                    void stop({ environmentId, input: { threadId: record.threadId } }).then(refresh)
                  }
                >
                  Stop
                </Button>
              ) : null}
              <Button
                size="xs"
                variant="destructive-outline"
                onClick={() =>
                  void destroy({ environmentId, input: { threadId: record.threadId } }).then(
                    refresh,
                  )
                }
              >
                Delete VM
              </Button>
            </div>
          }
        />
      ))}
    </SettingsSection>
  );
}
