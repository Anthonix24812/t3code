import type { TunnelReply, TunnelRequest } from "./SandboxAcpBridge.ts";

/** Turns an MCP Streamable HTTP answer (JSON, or SSE `data:` events) into its JSON-RPC messages. */
export function parseMcpHttpBody(contentType: string | null, text: string): ReadonlyArray<unknown> {
  if (!text.trim()) return [];
  if (contentType?.includes("text/event-stream")) {
    const messages: unknown[] = [];
    for (const event of text.split(/\r?\n\r?\n/)) {
      const data = event
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (data) messages.push(JSON.parse(data));
    }
    return messages;
  }
  const parsed: unknown = JSON.parse(text);
  return Array.isArray(parsed) ? parsed : [parsed];
}

/**
 * Sends a VM agent's MCP message to this thread's T3 MCP session. The thread-scoped credential is
 * added here and never sent to the VM, and T3's own access rules (modes, live caller) still apply.
 */
export async function forwardToT3Mcp(
  session: { readonly endpoint: string; readonly authorization: string },
  frame: TunnelRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<TunnelReply> {
  const response = await fetchImpl(session.endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: session.authorization,
      ...(frame.sessionId ? { "Mcp-Session-Id": frame.sessionId } : {}),
      ...(frame.protocolVersion ? { "Mcp-Protocol-Version": frame.protocolVersion } : {}),
    },
    body: JSON.stringify(frame.message),
  });
  const text = await response.text();
  const sessionId = response.headers.get("mcp-session-id") ?? frame.sessionId;
  if (!response.ok && response.status !== 202) {
    return { sessionId, messages: [], error: `T3 MCP answered ${response.status}.` };
  }
  return { sessionId, messages: parseMcpHttpBody(response.headers.get("content-type"), text) };
}

export interface SandboxToolContext {
  /** Opens a GitHub issue in the project's repository with this machine's GitHub login. */
  readonly createIssue: (input: {
    readonly title: string;
    readonly body: string;
    readonly labels: ReadonlyArray<string>;
  }) => Promise<string>;
  readonly capacity: () => Promise<{ readonly running: number; readonly limit: number }>;
}

const SANDBOX_MCP_INSTRUCTIONS = [
  "You run on a disposable Boat VM. Your T3 thread lives on the user's machine, which mirrors your",
  "working tree after every turn, so commits, pushes and pull requests happen there through T3's",
  "pull request tools. To split work into tasks, call the t3 server's delegate_task with",
  'isolation "worktree" and a Boat sandbox provider (boatClaude, boatCodex or boatGemini): each task',
  "gets its own branch, its own VM and its own thread. Check sandbox_capacity first; a thread tree",
  "may only run a few VMs at once. Use github_issue_create to file follow-ups as issues.",
].join(" ");

const TOOLS = [
  {
    name: "github_issue_create",
    description:
      "Open an issue in this project's GitHub repository, for follow-up work or a task you split off. Returns the issue URL.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", minLength: 1, maxLength: 256 },
        body: { type: "string", maxLength: 65536 },
        labels: { type: "array", items: { type: "string" }, maxItems: 10 },
      },
      required: ["title"],
    },
  },
  {
    name: "sandbox_capacity",
    description:
      "How many Boat VMs this thread tree runs now and the most it may run at once. Check before delegating tasks to Boat sandboxes.",
    inputSchema: { type: "object", properties: {} },
  },
];

const result = (id: unknown, value: unknown) => ({ jsonrpc: "2.0", id, result: value });
const text = (value: string) => ({ content: [{ type: "text", text: value }] });

/** A small MCP server answered on this machine for the agents on Boat VMs. */
export async function handleSandboxMcp(
  frame: TunnelRequest,
  context: SandboxToolContext,
): Promise<TunnelReply> {
  const message = frame.message as {
    id?: unknown;
    method?: string;
    params?: { name?: string; arguments?: Record<string, unknown>; protocolVersion?: string };
  };
  if (message.id === undefined) return { messages: [] };
  switch (message.method) {
    case "initialize":
      return {
        messages: [
          result(message.id, {
            protocolVersion: message.params?.protocolVersion ?? "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "t3-sandbox", version: "1" },
            instructions: SANDBOX_MCP_INSTRUCTIONS,
          }),
        ],
      };
    case "ping":
      return { messages: [result(message.id, {})] };
    case "tools/list":
      return { messages: [result(message.id, { tools: TOOLS })] };
    case "tools/call": {
      const args = message.params?.arguments ?? {};
      try {
        if (message.params?.name === "github_issue_create") {
          const title = typeof args.title === "string" ? args.title.trim() : "";
          if (!title) throw new Error("An issue needs a title.");
          const url = await context.createIssue({
            title: title.slice(0, 256),
            body: typeof args.body === "string" ? args.body.slice(0, 65_536) : "",
            labels: Array.isArray(args.labels)
              ? args.labels
                  .filter((label): label is string => typeof label === "string")
                  .slice(0, 10)
              : [],
          });
          return { messages: [result(message.id, text(`Opened ${url}`))] };
        }
        if (message.params?.name === "sandbox_capacity") {
          const { running, limit } = await context.capacity();
          return {
            messages: [result(message.id, text(`${running} of ${limit} Boat VMs are running.`))],
          };
        }
        throw new Error(`Unknown tool ${String(message.params?.name)}.`);
      } catch (error) {
        return {
          messages: [
            result(message.id, {
              ...text(error instanceof Error ? error.message : String(error)),
              isError: true,
            }),
          ],
        };
      }
    }
    default:
      return {
        messages: [
          {
            jsonrpc: "2.0",
            id: message.id,
            error: { code: -32601, message: `Unknown method ${String(message.method)}.` },
          },
        ],
      };
  }
}
