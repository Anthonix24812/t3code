// @effect-diagnostics extendsNativeError:off - a Promise client ported from dum-e; the provisioner maps its errors to SandboxError.
// Ported from dum-e packages/api/src/services/boat-api.ts. The key and fetch are injected instead
// of read from process.env, so the key can come from settings and tests can fake the API.

const DEFAULT_BOAT_API_BASE_URL = "https://boat.dev/api/v1";
const BOAT_CONTROL_TIMEOUT_MS = 60_000;

export type BoatSandboxState =
  | "archived"
  | "archiving"
  | "cancelled"
  | "cloning"
  | "error"
  | "idle"
  | "init"
  | "provisioned"
  | "provisioning"
  | "ready"
  | "running"
  | "updating";

export type BoatSandboxType = "default" | "large" | "small" | "xlarge";

export interface BoatSandboxInfo {
  archiveAfter?: string | null;
  error?: string | null;
  // False while a resumed or forked sandbox still copies its snapshot onto the disk.
  hydrated?: boolean;
  id: string;
  memoryGB?: number;
  state: BoatSandboxState;
  stop?: { error: string | null; id: string; status: string } | null;
  subdomain?: string | null;
  type?: BoatSandboxType;
  vcpu?: number;
}

export interface BoatCommandStatus {
  command: string | null;
  exitCode: number | null;
  known: boolean;
  running: boolean;
  signal: string | null;
  status: "exited" | "lost" | "running";
}

interface BoatErrorEnvelope {
  code?: string;
  error?: { code?: string; details?: { retryable?: boolean }; message?: string };
  message?: string;
  requestId?: string;
}

export class BoatApiError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly retryable: boolean | null;
  readonly requestId: string | null;
  constructor(
    message: string,
    status: number,
    code: string | null,
    retryable: boolean | null,
    requestId: string | null,
  ) {
    super(message);
    this.name = "BoatApiError";
    this.status = status;
    this.code = code;
    this.retryable = retryable;
    this.requestId = requestId;
  }
}

export interface BoatRequestOptions {
  body?: unknown;
  headers?: Record<string, string>;
  // Path template for errors, so sandbox ids and queries stay out of grouping.
  operation: string;
  query?: Record<string, number | string | undefined>;
  signal?: AbortSignal | undefined;
}

export interface BoatClientConfig {
  readonly apiKey: string;
  readonly baseUrl?: string | undefined;
  readonly fetch?: typeof fetch;
}

export interface BoatClient {
  request<T>(method: string, path: string, options: BoatRequestOptions): Promise<T>;
  // Reads a newline-delimited JSON response, such as streamed and attached command output.
  stream<T>(method: string, path: string, options: BoatRequestOptions): AsyncGenerator<T>;
}

const resolveBoatBaseUrl = (configured?: string) =>
  (
    configured?.trim() ||
    process.env.BOAT_API_BASE_URL?.trim() ||
    DEFAULT_BOAT_API_BASE_URL
  ).replace(/\/$/, "");

export function createBoatClient(config: BoatClientConfig): BoatClient {
  const apiKey = config.apiKey.trim();
  if (!apiKey) throw new Error("A boat.dev API key must be configured to use Boat sandboxes.");
  const baseUrl = resolveBoatBaseUrl(config.baseUrl);
  const fetchImpl = config.fetch ?? fetch;

  async function send(method: string, path: string, options: BoatRequestOptions) {
    const url = new URL(`${baseUrl}${path}`);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    const response = await fetchImpl(url, {
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      headers: {
        Authorization: `Bearer ${apiKey}`,
        ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
        ...options.headers,
      },
      method,
      signal: options.signal ?? AbortSignal.timeout(BOAT_CONTROL_TIMEOUT_MS),
    });
    if (response.ok) return response;

    const text = await response.text().catch(() => "");
    let envelope: BoatErrorEnvelope = {};
    try {
      envelope = JSON.parse(text) as BoatErrorEnvelope;
    } catch {
      // Non-JSON gateway errors keep the HTTP status as the primary signal.
    }
    throw new BoatApiError(
      envelope.error?.message ??
        envelope.message ??
        `boat.dev ${options.operation} returned ${response.status}.`,
      response.status,
      envelope.error?.code ?? envelope.code ?? null,
      envelope.error?.details?.retryable ?? null,
      envelope.requestId ?? null,
    );
  }

  return {
    async request<T>(method: string, path: string, options: BoatRequestOptions) {
      const response = await send(method, path, options);
      const text = await response.text();
      return (text ? JSON.parse(text) : {}) as T;
    },
    async *stream<T>(method: string, path: string, options: BoatRequestOptions) {
      const response = await send(method, path, options);
      if (!response.body) return;
      const decoder = new TextDecoder();
      const reader = (response.body as ReadableStream<Uint8Array>).getReader();
      let buffer = "";
      for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
        buffer += decoder.decode(chunk.value, { stream: true });
        for (let index = buffer.indexOf("\n"); index >= 0; index = buffer.indexOf("\n")) {
          const line = buffer.slice(0, index).trim();
          buffer = buffer.slice(index + 1);
          if (line) yield JSON.parse(line) as T;
        }
      }
      const rest = (buffer + decoder.decode()).trim();
      if (rest) yield JSON.parse(rest) as T;
    },
  };
}
