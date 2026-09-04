import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

type Scenario = "lost-response" | "restart-after-5xx" | "in-progress" | "recovered-box";

describe("Box create idempotency", () => {
  let api: Server;
  let scenario: Scenario = "lost-response";
  let allowRecovery = false;
  let acceptedKey = "";
  let createCount = 0;
  let failDesktop = false;
  const createKeys: string[] = [];
  const renameBodies: unknown[] = [];
  const deletedBoxes: string[] = [];

  const boxId = () => scenario === "lost-response"
    ? "bx_23456789"
    : scenario === "recovered-box"
      ? "bx_jkmnpqrs"
      : "bx_abcdefgh";

  beforeAll(async () => {
    api = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://box.test");
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        res.setHeader("content-type", "application/json");
        if (url.pathname === "/api/box/v1/boxes" && req.method === "GET") {
          return res.end(JSON.stringify({ ok: true, boxes: [] }));
        }
        if (url.pathname === "/api/box/v1/boxes" && req.method === "POST") {
          createCount += 1;
          const key = String(req.headers["idempotency-key"] ?? "");
          createKeys.push(key);
          expect(JSON.parse(raw)).toEqual({ ttlSeconds: 8 * 60 * 60, noEnv: true });
          if (!acceptedKey) acceptedKey = key;
          if (key !== acceptedKey) {
            res.writeHead(409);
            return res.end(JSON.stringify({ ok: false, code: "idempotency_key_reused" }));
          }

          if (scenario === "lost-response" && createCount === 1) {
            // The provider accepted the create, but the response disappeared.
            req.socket.destroy();
            return;
          }
          if (scenario === "restart-after-5xx" && !allowRecovery) {
            res.writeHead(503);
            return res.end(JSON.stringify({ ok: false, message: "accepted but response unavailable" }));
          }
          if (scenario === "in-progress" && createCount <= 3) {
            res.writeHead(409);
            return res.end(JSON.stringify({ ok: false, code: "idempotency_in_progress" }));
          }
          res.writeHead(201);
          return res.end(JSON.stringify({ ok: true, box: { id: boxId(), state: "ready" } }));
        }
        if (url.pathname === `/api/box/v1/boxes/${boxId()}` && req.method === "PATCH") {
          renameBodies.push(JSON.parse(raw));
          return res.end(JSON.stringify({ ok: true, box: { id: boxId(), state: "ready" } }));
        }
        if (url.pathname === `/api/box/v1/boxes/${boxId()}` && req.method === "GET") {
          return res.end(JSON.stringify({ ok: true, box: { id: boxId(), state: "ready" } }));
        }
        if (url.pathname.endsWith("/commands") && req.method === "POST") {
          return res.end(JSON.stringify({ ok: true, exitCode: 0, stdout: "ready", stderr: "" }));
        }
        if (url.pathname.endsWith("/desktop") && req.method === "POST") {
          if (failDesktop) {
            res.writeHead(503);
            return res.end(JSON.stringify({ ok: false, message: "desktop temporarily unavailable" }));
          }
          return res.end(JSON.stringify({ ok: true, desktopUrl: "https://desktop.example/session" }));
        }
        if (url.pathname === `/api/box/v1/boxes/${boxId()}` && req.method === "DELETE") {
          deletedBoxes.push(boxId());
          res.writeHead(202);
          return res.end(JSON.stringify({ ok: true }));
        }
        res.writeHead(404).end(JSON.stringify({ ok: false, message: `unexpected ${req.method} ${url.pathname}` }));
      });
    });
    await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
    const port = (api.address() as AddressInfo).port;
    vi.stubEnv("OMB_BOX_API", `http://127.0.0.1:${port}/api/box/v1`);
  });

  beforeEach(() => {
    allowRecovery = false;
    acceptedKey = "";
    createCount = 0;
    failDesktop = false;
    createKeys.length = 0;
    renameBodies.length = 0;
    deletedBoxes.length = 0;
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await new Promise<void>((resolve) => api.close(() => resolve()));
  });

  it("retries a lost response with the same key and renames the recovered Box", async () => {
    scenario = "lost-response";
    vi.resetModules();
    const { provisionBox } = await import("./box.ts");

    const result = await provisionBox({ box: { token: "box_test" } } as any, "lost-response-bot", "Lost Response");

    expect(result.boxId).toBe("bx_23456789");
    expect(createKeys).toHaveLength(2);
    expect(createKeys[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(new Set(createKeys).size).toBe(1);
    expect(renameBodies).toEqual([{ name: expect.stringMatching(/^ogb-[0-9a-f]{12}-lostres-[0-9a-f]{6}$/) }]);
  });

  it("reuses the durable key after a 5xx and module restart", async () => {
    scenario = "restart-after-5xx";
    vi.resetModules();
    let { provisionBox } = await import("./box.ts");

    await expect(
      provisionBox({ box: { token: "box_test" } } as any, "restart-5xx-bot", "Restart Recovery"),
    ).rejects.toThrow(/accepted but response unavailable/);
    expect(createKeys).toHaveLength(2);
    expect(new Set(createKeys).size).toBe(1);

    allowRecovery = true;
    vi.resetModules();
    ({ provisionBox } = await import("./box.ts"));
    const result = await provisionBox(
      { box: { token: "box_test" } } as any,
      "restart-5xx-bot",
      "Restart Recovery",
    );

    expect(result.boxId).toBe("bx_abcdefgh");
    expect(createKeys).toHaveLength(3);
    expect(new Set(createKeys).size).toBe(1);
    expect(renameBodies).toEqual([{ name: expect.stringMatching(/^ogb-[0-9a-f]{12}-restart-[0-9a-f]{6}$/) }]);
  });

  it("waits for an in-progress idempotent create and keeps the same key", async () => {
    scenario = "in-progress";
    vi.resetModules();
    const { provisionBox } = await import("./box.ts");

    const result = await provisionBox({ box: { token: "box_test" } } as any, "in-progress-bot", "In Progress");

    expect(result.boxId).toBe("bx_abcdefgh");
    expect(createKeys).toHaveLength(4);
    expect(new Set(createKeys).size).toBe(1);
  });

  it("never deletes a Box recovered from a previous provisioning attempt", async () => {
    scenario = "recovered-box";
    vi.resetModules();
    let { provisionBox } = await import("./box.ts");

    const first = await provisionBox({ box: { token: "box_test" } } as any, "recovered-bot", "Recovered");
    expect(first.boxId).toBe("bx_jkmnpqrs");
    expect(createCount).toBe(1);

    failDesktop = true;
    vi.resetModules();
    ({ provisionBox } = await import("./box.ts"));
    await expect(
      provisionBox({ box: { token: "box_test" } } as any, "recovered-bot", "Recovered"),
    ).rejects.toThrow(/desktop link could not be created/);

    expect(createCount).toBe(1);
    expect(deletedBoxes).toEqual([]);
  });

  it("fails closed when an ambiguous request has outlived the provider key", async () => {
    scenario = "restart-after-5xx";
    const startedAt = Date.now();
    const now = vi.spyOn(Date, "now").mockReturnValue(startedAt);
    try {
      vi.resetModules();
      let { provisionBox } = await import("./box.ts");
      await expect(
        provisionBox({ box: { token: "box_test" } } as any, "expired-5xx-bot", "Expired Recovery"),
      ).rejects.toThrow(/accepted but response unavailable/);
      expect(createKeys).toHaveLength(2);

      now.mockReturnValue(startedAt + 24 * 60 * 60 * 1_000 + 1);
      allowRecovery = true;
      vi.resetModules();
      ({ provisionBox } = await import("./box.ts"));
      await expect(
        provisionBox({ box: { token: "box_test" } } as any, "expired-5xx-bot", "Expired Recovery"),
      ).rejects.toThrow(/older than ascii\.dev's 24-hour retry window/i);

      expect(createKeys).toHaveLength(2);
    } finally {
      now.mockRestore();
    }
  });
});
