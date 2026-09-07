import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  agentBrowserFrame,
  agentBrowserIntegration,
  browserEngineEncryptionKey,
  browserEngineStatus,
  browserSessionId,
  installAgentBrowserBinary,
  isMusl,
  pinnedBinaryPath,
  resolveAgentBrowserBinary,
} from "./browser-engine.ts";
import { AGENT_BROWSER_VERSION, agentBrowserReleaseUrl, resolveAgentBrowserReleaseAsset } from "./browser-engine-release.ts";
import { removeTempDir } from "./testing/cleanup.ts";

const posix = process.platform !== "win32";
const scratch: string[] = [];
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});
afterEach(async () => {
  vi.mocked(spawn).mockReset();
  for (const dir of scratch.splice(0)) await removeTempDir(dir);
});

describe("finding the browser engine", () => {
  it("prefers the explicit path, then the pinned download, then PATH, and reports why when nothing is there", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "omb-engine-"));
    scratch.push(dataDir);
    const pinned = pinnedBinaryPath(dataDir);
    const name = process.platform === "win32" ? "agent-browser.exe" : "agent-browser";
    const pathDir = join(dataDir, "bin");
    const pathBinary = join(pathDir, name);
    const override = join(dataDir, "override", name);
    const files = new Set<string>();
    const exists = (p: string) => files.has(p);
    const env = { PATH: [join(dataDir, "empty"), pathDir].join(delimiter) };

    expect(resolveAgentBrowserBinary({ dataDir, env, exists })).toBeNull();
    expect(browserEngineStatus({ dataDir, env, exists })).toMatchObject({ kind: "unavailable", installable: true });

    files.add(pathBinary);
    expect(resolveAgentBrowserBinary({ dataDir, env, exists })).toBe(pathBinary);
    files.add(pinned);
    expect(resolveAgentBrowserBinary({ dataDir, env, exists })).toBe(pinned);
    files.add(override);
    expect(resolveAgentBrowserBinary({ dataDir, env: { ...env, OMB_AGENT_BROWSER_PATH: override }, exists })).toBe(override);
    // an override that does not exist is an error, not a silent fallback
    expect(resolveAgentBrowserBinary({ dataDir, env: { ...env, OMB_AGENT_BROWSER_PATH: join(dataDir, "missing", name) }, exists })).toBeNull();
    expect(browserEngineStatus({ dataDir, env, exists })).toMatchObject({ kind: "ready", binaryPath: pinned, version: AGENT_BROWSER_VERSION });
  });

  it("knows every target Vercel publishes, and picks the musl build on Alpine", () => {
    for (const [platform, arch] of [["darwin", "arm64"], ["darwin", "x64"], ["linux", "x64"], ["linux", "arm64"], ["win32", "x64"]] as const) {
      const asset = resolveAgentBrowserReleaseAsset(platform, arch);
      expect(asset, `${platform}-${arch}`).not.toBeNull();
      expect(asset?.sha256).toMatch(/^[0-9a-f]{64}$/u);
      expect(agentBrowserReleaseUrl(asset!)).toContain(`/v${AGENT_BROWSER_VERSION}/`);
    }
    expect(resolveAgentBrowserReleaseAsset("linux", "x64", true)?.target).toBe("linux-musl-x64");
    expect(resolveAgentBrowserReleaseAsset("freebsd", "x64")).toBeNull();
    expect(isMusl("linux", (p) => p === "/lib/ld-musl-x86_64.so.1")).toBe(true);
    expect(isMusl("linux", () => false)).toBe(false);
    expect(isMusl("darwin", () => true)).toBe(false);
  });
});

describe("installing the browser engine", () => {
  it("downloads the pinned asset, verifies size and digest, and only then names the file", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "omb-engine-install-"));
    scratch.push(dataDir);
    const body = Buffer.from("#!/bin/sh\necho agent-browser\n");
    const asset = { target: "linux-x64", asset: "agent-browser-linux-x64", sha256: createHash("sha256").update(body).digest("hex"), bytes: body.length };
    const fetched: string[] = [];
    const installed = await installAgentBrowserBinary({
      dataDir,
      platform: "linux",
      asset,
      fetchImpl: async (input) => {
        fetched.push(String(input));
        return new Response(body);
      },
    });
    expect(installed).toBe(pinnedBinaryPath(dataDir, "linux"));
    expect(fetched[0]).toBe(agentBrowserReleaseUrl(asset));
    expect(readFileSync(installed, "utf8")).toContain("agent-browser");
    if (posix) expect(statSync(installed).mode & 0o111).not.toBe(0);
  });

  it("refuses a download whose bytes do not match the pin, and leaves nothing behind", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "omb-engine-bad-"));
    scratch.push(dataDir);
    const asset = { target: "linux-x64", asset: "agent-browser-linux-x64", sha256: "a".repeat(64), bytes: 5 };
    await expect(installAgentBrowserBinary({ dataDir, platform: "linux", asset, fetchImpl: async () => new Response(Buffer.from("hello")) })).rejects.toThrow(/SHA-256/u);
    await expect(installAgentBrowserBinary({ dataDir, platform: "linux", asset, fetchImpl: async () => new Response(Buffer.from("hi")) })).rejects.toThrow(/pinned size/u);
    expect(() => statSync(pinnedBinaryPath(dataDir, "linux"))).toThrow();
  });
});

describe("what a bot gets", () => {
  it("mounts agent-browser's MCP server with the core tools, an isolated auto-restored session, and WebMCP off", () => {
    const spec = agentBrowserIntegration({ binaryPath: "/x/agent-browser", session: "bot-1", encryptionKey: "k".repeat(64), env: { PATH: "/usr/bin" } });
    expect(spec.command).toBe("/x/agent-browser");
    expect(spec.args).toEqual(["mcp", "--tools", "core", "--no-webmcp"]);
    expect(spec.env).toMatchObject({ AGENT_BROWSER_SESSION: "bot-1", AGENT_BROWSER_RESTORE: "bot-1", AGENT_BROWSER_RESTORE_SAVE: "auto", AGENT_BROWSER_HEADLESS: "1", PATH: "/usr/bin" });
    expect(spec.env.AGENT_BROWSER_ENCRYPTION_KEY).toBe("k".repeat(64));
    expect(agentBrowserIntegration({ binaryPath: "/x", session: "s", encryptionKey: "k", headless: false }).env.AGENT_BROWSER_HEADLESS).toBeUndefined();
  });

  it("keeps saved state separate for different bots and never saves guest state", () => {
    const spec = (session: string, persistent = true) => agentBrowserIntegration({ binaryPath: "/x", session, encryptionKey: "k", persistent });
    expect(spec("bot-a").env.AGENT_BROWSER_RESTORE).not.toBe(spec("bot-b").env.AGENT_BROWSER_RESTORE);
    const first = browserSessionId("bot-a", "guest");
    const second = browserSessionId("bot-a", "guest");
    expect(first).toMatch(/^guest-[a-f0-9-]+$/u);
    expect(first).not.toBe(second);
    expect(spec(first, false).env).toMatchObject({ AGENT_BROWSER_RESTORE: first, AGENT_BROWSER_RESTORE_SAVE: "never" });
  });

  it("names sessions after the shared profile, else the bot, in shell-safe form", () => {
    expect(browserSessionId("bot-a", "")).toBe("bot-bot-a");
    expect(browserSessionId("bot-a", "work partition/1")).toBe("work_partition_1");
    expect(browserSessionId("b", "x".repeat(200))).toHaveLength(96);
  });

  it("makes one encryption key per data dir, private, and reuses it", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "omb-engine-key-"));
    scratch.push(dataDir);
    const key = browserEngineEncryptionKey(dataDir);
    expect(key).toMatch(/^[0-9a-f]{64}$/u);
    expect(browserEngineEncryptionKey(dataDir)).toBe(key);
    if (posix) expect(statSync(join(dataDir, "browser-engine-key")).mode & 0o777).toBe(0o600);
    // a corrupted key file is replaced, never reused
    writeFileSync(join(dataDir, "browser-engine-key"), "garbage\n");
    const fresh = browserEngineEncryptionKey(dataDir);
    expect(fresh).toMatch(/^[0-9a-f]{64}$/u);
    expect(fresh).not.toBe(key);
    mkdirSync(join(dataDir, "unused"));
  });
});


describe("agentBrowserFrame", () => {
  /** Use a real Node child on every OS, not an unlaunchable Windows shebang.
   * Only the executable is substituted; arguments, env and file IO are real. */
  async function fakeBinary(body: string): Promise<string> {
    const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    vi.mocked(spawn).mockImplementationOnce((_binary, args, options) => {
      expect(_binary).toBe("fixture-agent-browser");
      expect(args?.[0]).toBe("screenshot");
      return actual.spawn(process.execPath, ["-e", body, ...args ?? []], options);
    });
    return "fixture-agent-browser";
  }

  it("returns the picture the browser wrote, base64 encoded", async () => {
    // `screenshot <path>` is argument 2; the CLI writes the file there.
    const binaryPath = await fakeBinary('require("node:fs").writeFileSync(process.argv[2], "PNGDATA")');
    const frame = await agentBrowserFrame({ binaryPath, env: { AGENT_BROWSER_SESSION: "bot-1" } });
    expect(frame.format).toBe("png");
    expect(Buffer.from(frame.png, "base64").toString()).toBe("PNGDATA");
    expect(existsSync(vi.mocked(spawn).mock.calls[0]![1]![1]!)).toBe(false);
  });

  it("carries the mount's session env, so it pictures the bot's own browser", async () => {
    const binaryPath = await fakeBinary('require("node:fs").writeFileSync(process.argv[2], process.env.AGENT_BROWSER_SESSION)');
    const frame = await agentBrowserFrame({ binaryPath, env: { AGENT_BROWSER_SESSION: "profile-x" } });
    expect(Buffer.from(frame.png, "base64").toString()).toBe("profile-x");
  });

  it("fails with the browser's own reason when the capture fails", async () => {
    const binaryPath = await fakeBinary('process.stderr.write("no open page"); process.exitCode = 3');
    await expect(agentBrowserFrame({ binaryPath, env: {} })).rejects.toThrow(/no open page/);
  });

  it("fails rather than inventing a picture the browser never wrote", async () => {
    const binaryPath = await fakeBinary("process.exitCode = 0");
    await expect(agentBrowserFrame({ binaryPath, env: {} })).rejects.toThrow(/did not write/);
  });

  it("gives up on a hung browser instead of holding the turn open", async () => {
    const binaryPath = await fakeBinary("setTimeout(() => {}, 5000)");
    await expect(agentBrowserFrame({ binaryPath, env: {}, timeoutMs: 150 })).rejects.toThrow(/in time/);
  });
});
