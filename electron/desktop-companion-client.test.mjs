import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DESKTOP_COMPANION_FIELD,
  desktopCompanionAccess,
  desktopCompanionProxyTarget,
  normalizeTailscaleCompanionEndpoint,
  normalizeDesktopCompanionEndpoint,
  pairDesktopCompanion,
  startDesktopCompanionRelay,
  withDesktopCompanionAccess,
  withoutDesktopCompanionAccess,
} from "./desktop-companion-client.mjs";

const token = `omb_${"a".repeat(43)}`;
const deviceId = "123e4567-e89b-12d3-a456-426614174000";
const access = {
  endpoint: "http://host.example-tailnet.ts.net:8810",
  token,
  deviceId,
  serverName: "Office computer",
};

const servers = [];
const tempDirs = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
  for (const directory of tempDirs.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("desktop companion endpoint", () => {
  it("accepts managed HTTPS and cleartext only for Tailscale MagicDNS", () => {
    expect(normalizeTailscaleCompanionEndpoint("host.example-tailnet.ts.net")).toBe(
      "http://host.example-tailnet.ts.net:8810",
    );
    expect(normalizeTailscaleCompanionEndpoint("http://HOST.example-tailnet.ts.net:9910/")).toBe(
      "http://host.example-tailnet.ts.net:9910",
    );
    expect(normalizeDesktopCompanionEndpoint("https://c-opaque.openmausbot.com")).toBe(
      "https://c-opaque.openmausbot.com",
    );
    expect(normalizeDesktopCompanionEndpoint("c-opaque.openmausbot.com")).toBe(
      "https://c-opaque.openmausbot.com",
    );
    for (const endpoint of [
      "https://unrelated.example.com",
      "http://c-opaque.openmausbot.com",
      "http://10.0.0.4:8810",
      "http://host.local:8810",
      "https://10.0.0.4",
      "http://host.example-tailnet.ts.net/path",
      "https://c-opaque.openmausbot.com/path",
      "http://user@host.example-tailnet.ts.net",
      "http://host.example-tailnet.ts.net.evil.test",
      "https://c-opaque.openmausbot.com.evil.test",
    ]) {
      expect(normalizeDesktopCompanionEndpoint(endpoint), endpoint).toBe("");
    }
  });

  it("validates, adds, and removes the encrypted credential document field", () => {
    const hostedAccess = { ...access, endpoint: "https://c-opaque.openmausbot.com" };
    expect(desktopCompanionAccess({ [DESKTOP_COMPANION_FIELD]: hostedAccess })).toEqual(
      hostedAccess,
    );

    expect(desktopCompanionAccess({ [DESKTOP_COMPANION_FIELD]: access })).toEqual(access);
    expect(desktopCompanionAccess({ [DESKTOP_COMPANION_FIELD]: { ...access, token: "bad" } })).toBeNull();
    expect(withDesktopCompanionAccess({ existing: true }, access)).toEqual({
      existing: true,
      [DESKTOP_COMPANION_FIELD]: access,
    });
    expect(withoutDesktopCompanionAccess({ existing: true, [DESKTOP_COMPANION_FIELD]: access })).toEqual({
      existing: true,
    });
  });
});

describe("desktop companion pairing", () => {
  it("sends the six-digit pairing request and accepts a valid device credential", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ token, device: { id: deviceId }, serverName: "Office computer" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    await expect(
      pairDesktopCompanion({
        endpoint: "host.example-tailnet.ts.net",
        code: "123456",
        deviceName: "Laptop",
        requestId: "request-00000001",
        fetchImpl,
      }),
    ).resolves.toEqual(access);
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, options] = fetchImpl.mock.calls[0];
    expect(url).toBe("http://host.example-tailnet.ts.net:8810/api/pair");
    expect(options.headers).toEqual({ "content-type": "application/json" });
    expect(JSON.parse(options.body)).toEqual({
      code: "123456",
      deviceName: "Laptop",
      pairRequestId: "request-00000001",
    });
  });

  it("pairs through a managed HTTPS companion address", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ token, device: { id: deviceId }, serverName: "Office computer" }), {
        status: 201,
        headers: { "content-type": "application/json" },
      }),
    );
    const paired = await pairDesktopCompanion({
      endpoint: "https://c-opaque.openmausbot.com",
      code: "654321",
      deviceName: "Desktop client",
      requestId: "request-https-01",
      fetchImpl,
    });
    expect(paired).toEqual({ ...access, endpoint: "https://c-opaque.openmausbot.com" });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://c-opaque.openmausbot.com/api/pair",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("rejects bad codes and surfaces a sidecar error without returning secrets", async () => {
    await expect(
      pairDesktopCompanion({ endpoint: access.endpoint, code: "123", deviceName: "Laptop" }),
    ).rejects.toThrow("six-digit");
    await expect(
      pairDesktopCompanion({
        endpoint: access.endpoint,
        code: "123456",
        deviceName: "Laptop",
        fetchImpl: async () => new Response(JSON.stringify({ error: "Pairing window closed" }), { status: 403 }),
      }),
    ).rejects.toThrow("Pairing window closed");
  });
});

describe("desktop companion loopback relay", () => {
  it("pins absolute-form and network-path requests to the paired origin", () => {
    expect(desktopCompanionProxyTarget(access.endpoint, "http://evil.test/api/bots?x=1").href).toBe(
      `${access.endpoint}/api/bots?x=1`,
    );
    expect(desktopCompanionProxyTarget(access.endpoint, "//evil.test/api/events").href).toBe(
      `${access.endpoint}/api/events`,
    );
  });

  it("serves the UI only on loopback and never includes the bearer in the page", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "omb-desktop-client-"));
    tempDirs.push(directory);
    fs.writeFileSync(path.join(directory, "index.html"), "<h1>Remote client</h1>");
    const relay = await startDesktopCompanionRelay({ access, staticDir: directory, ports: [0] });
    servers.push(relay.server);
    const address = relay.server.address();
    const response = await fetch(`http://127.0.0.1:${address.port}/`);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Remote client");
    expect(html).not.toContain(token);
    const relayOrigin = `http://127.0.0.1:${address.port}`;
    const sameOrigin = await fetch(`${relayOrigin}/`, { headers: { origin: relayOrigin } });
    expect(sameOrigin.status).toBe(200);
    const foreignLoopbackOrigin = await fetch(`${relayOrigin}/`, {
      headers: { origin: "http://127.0.0.1:65534" },
    });
    expect(foreignLoopbackOrigin.status).toBe(403);
  });
});
