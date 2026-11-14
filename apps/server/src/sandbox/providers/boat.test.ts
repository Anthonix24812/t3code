import { describe, expect, it } from "@effect/vitest";

import { createBoatDriver } from "./boat.ts";
import { createBoatClient } from "./boatApi.ts";

interface Recorded {
  readonly method: string;
  readonly path: string;
  readonly headers: Record<string, string>;
  readonly body: Record<string, unknown> | undefined;
}

type Route = (request: Recorded) => Response | undefined;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const ndjson = (frames: ReadonlyArray<unknown>) =>
  new Response(frames.map((frame) => `${JSON.stringify(frame)}\n`).join(""), { status: 200 });

/** An in-memory stand-in for boat.dev: routes answer in order, every request is recorded. */
function fakeBoat(routes: ReadonlyArray<Route>) {
  const requests: Recorded[] = [];
  const fetch = (async (input: URL | string | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const request: Recorded = {
      method: init?.method ?? "GET",
      path: url.pathname.replace(/^\/api\/v1/, ""),
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    };
    requests.push(request);
    for (const route of routes) {
      const response = route(request);
      if (response) return response;
    }
    return json(404, {
      error: { code: "not_found", message: `${request.method} ${request.path}` },
    });
  }) as typeof globalThis.fetch;
  const driver = createBoatDriver({
    client: createBoatClient({ apiKey: "boat_test", baseUrl: "https://boat.test/api/v1", fetch }),
    sleep: async () => undefined,
  });
  return { driver, requests };
}

const on =
  (method: string, path: string | RegExp, respond: (request: Recorded) => Response) =>
  (request: Recorded) =>
    request.method === method &&
    (typeof path === "string" ? request.path === path : path.test(request.path))
      ? respond(request)
      : undefined;

const once = (route: Route): Route => {
  let used = false;
  return (request) => {
    if (used) return undefined;
    const response = route(request);
    if (response) used = true;
    return response;
  };
};

describe("Boat driver", () => {
  it("repeats a create whose response was lost with the same idempotency key", async () => {
    const { driver, requests } = fakeBoat([
      once(on("POST", "/sandboxes", () => json(502, { error: { message: "bad gateway" } }))),
      on("POST", "/sandboxes", () => json(201, { sandbox: { id: "bx_1" } })),
      on("PATCH", "/sandboxes/bx_1", () => json(200, {})),
    ]);

    const created = await driver.create({
      name: "t3-abc",
      size: "small",
      idempotencyKey: "key-1",
      ttlSeconds: 1500,
      accountEnvironment: true,
    });

    expect(created.id).toBe("bx_1");
    const creates = requests.filter((request) => request.path === "/sandboxes");
    expect(creates.map((request) => request.headers["idempotency-key"])).toEqual([
      "key-1",
      "key-1",
    ]);
    expect(creates[0]!.body).toEqual({
      monitoring: false,
      noEnv: false,
      ttlSeconds: 1500,
      type: "small",
    });
    expect(requests.at(-1)!.body).toEqual({ name: "t3-abc" });
    expect(requests[0]!.headers.authorization).toBe("Bearer boat_test");
  });

  it("does not repeat a create the API refused", async () => {
    const { driver, requests } = fakeBoat([
      on("POST", "/sandboxes", () =>
        json(403, { error: { code: "billing_required", message: "no" } }),
      ),
    ]);
    await expect(
      driver.create({
        name: "t3-abc",
        size: "small",
        idempotencyKey: "k",
        ttlSeconds: 60,
        accountEnvironment: false,
      }),
    ).rejects.toMatchObject({ status: 403, code: "billing_required" });
    expect(requests).toHaveLength(1);
    // Copied logins replace the account environment.
    expect(requests[0]!.body).toEqual({
      monitoring: false,
      noEnv: true,
      ttlSeconds: 60,
      type: "small",
    });
  });

  it("resumes at the current type when boat.dev refuses a smaller one, then waits for hydration", async () => {
    let gets = 0;
    const { driver, requests } = fakeBoat([
      on("GET", "/sandboxes/bx_1", () => {
        gets += 1;
        if (gets === 1)
          return json(200, { sandbox: { id: "bx_1", state: "archived", type: "large" } });
        return json(200, { sandbox: { id: "bx_1", state: "ready", hydrated: gets > 3 } });
      }),
      once(
        on("POST", "/sandboxes/bx_1/resume", () =>
          json(409, { error: { code: "type_too_small", message: "too small" } }),
        ),
      ),
      on("POST", "/sandboxes/bx_1/resume", () => json(200, {})),
    ]);

    await driver.resume("bx_1", { size: "small", ttlSeconds: 900 });

    const resumes = requests.filter((request) => request.path === "/sandboxes/bx_1/resume");
    expect(resumes.map((request) => request.body?.type)).toEqual(["small", "large"]);
    expect(gets).toBe(4);
  });

  it("stops by waiting for the archive and returns the latest snapshot", async () => {
    let state = "ready";
    const { driver } = fakeBoat([
      on("GET", "/sandboxes/bx_1", () => {
        const current = state;
        if (state === "archiving") state = "archived";
        return json(200, { sandbox: { id: "bx_1", state: current } });
      }),
      on("POST", "/sandboxes/bx_1/commands", () => ndjson([{ type: "exit", exitCode: 0 }])),
      on("POST", "/sandboxes/bx_1/stop", () => {
        state = "archiving";
        return json(202, { stopId: "stop_1" });
      }),
      on("GET", "/sandboxes/bx_1/snapshots/latest", () =>
        json(200, { snapshot: { id: "snap_9" } }),
      ),
    ]);

    await expect(driver.stop("bx_1")).resolves.toEqual({ snapshotId: "snap_9" });
  });

  it("confirms a delete with the sandbox id and treats a missing VM as deleted", async () => {
    const { driver, requests } = fakeBoat([
      on("DELETE", "/sandboxes/bx_gone", () => json(404, { error: { message: "gone" } })),
      on("GET", "/sandboxes/bx_gone", () => json(404, { error: { message: "gone" } })),
    ]);
    await driver.destroy("bx_gone");
    expect(requests[0]!.headers["x-ascii-confirm-delete"]).toBe("bx_gone");
    await expect(driver.status("bx_gone")).resolves.toBe("deleted");
  });

  it("keeps secrets out of the command text and drops login-shell noise", async () => {
    const { driver, requests } = fakeBoat([
      on("PUT", "/sandboxes/bx_1/files", () => json(200, {})),
      on("POST", "/sandboxes/bx_1/commands", () =>
        ndjson([
          { type: "started" },
          { type: "stdout", data: "Welcome to boat\n__t3_sandbox_command_output__\nhel" },
          { type: "stdout", data: "lo\n" },
          { type: "exit", exitCode: 0 },
        ]),
      ),
    ]);

    const result = await driver.exec("bx_1", {
      script: 'echo "$TOKEN" >/dev/null; echo hello',
      secretEnv: { TOKEN: "s3cret-value" },
    });

    expect(result).toEqual({ exitCode: 0, stdout: "hello\n", stderr: "" });
    const command = requests.find((request) => request.path.endsWith("/commands"))!;
    expect(JSON.stringify(command.body)).not.toContain("s3cret-value");
    const file = requests.find((request) => request.method === "PUT")!;
    expect(String(file.body?.path)).toMatch(/^\/tmp\/t3-sandbox-private\/.+\.sh$/);
    expect(Buffer.from(String(file.body?.content), "base64").toString()).toContain("s3cret-value");
  });

  it("retries a command boat.dev refused because the VM was still starting", async () => {
    const { driver, requests } = fakeBoat([
      once(
        on("POST", "/sandboxes/bx_1/commands", () =>
          json(409, { error: { code: "sandbox_starting", message: "starting" } }),
        ),
      ),
      on("POST", "/sandboxes/bx_1/commands", () => ndjson([{ type: "exit", exitCode: 3 }])),
    ]);
    await expect(driver.exec("bx_1", { script: "exit 3" })).resolves.toMatchObject({ exitCode: 3 });
    expect(requests).toHaveLength(2);
  });

  it("reports whether the plan can start a VM, or null when limits are unreadable", async () => {
    const refused = fakeBoat([on("GET", "/limits", () => json(200, { canStart: false }))]);
    await expect(refused.driver.limits()).resolves.toEqual({ canStart: false });
    const unreadable = fakeBoat([on("GET", "/limits", () => json(403, {}))]);
    await expect(unreadable.driver.limits()).resolves.toBeNull();
  });
});
