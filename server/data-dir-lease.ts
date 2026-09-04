import { randomUUID } from "node:crypto";
import { linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";

const LEASE_NAME = "openmausbot-server.lease";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

interface LeaseOwner {
  version: 1;
  pid: number;
  host: string;
  token: string;
  createdAt: number;
}

export interface DataDirLease {
  readonly ownerPid: number;
  /** Returns true for the release that removed the lease and false after the
   * same handle has already released it. */
  release(): boolean;
}

export class DataDirLeaseError extends Error {
  override readonly name = "DataDirLeaseError";
}

function leaseError(message: string, cause?: unknown): DataDirLeaseError {
  return Object.assign(new DataDirLeaseError(message), { cause });
}

function isLeaseOwner(value: unknown): value is LeaseOwner {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const owner = value as Record<string, unknown>;
  return owner.version === 1
    && Number.isInteger(owner.pid)
    && Number(owner.pid) > 0
    && Number(owner.pid) <= 0x7fffffff
    && typeof owner.host === "string"
    && owner.host.length > 0
    && owner.host.length <= 255
    && !/[\r\n\0]/.test(owner.host)
    && typeof owner.token === "string"
    && UUID.test(owner.token)
    && typeof owner.createdAt === "number"
    && Number.isFinite(owner.createdAt)
    && owner.createdAt > 0;
}

function readOwner(path: string): LeaseOwner | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    throw leaseError("OpenMausBot cannot read the data-directory lease; refusing to start to protect its state.", error);
  }
  let owner: unknown;
  try {
    owner = JSON.parse(raw);
  } catch (error) {
    throw leaseError("The OpenMausBot data-directory lease is invalid; refusing to start to protect its state.", error);
  }
  if (!isLeaseOwner(owner)) {
    throw leaseError("The OpenMausBot data-directory lease is invalid; refusing to start to protect its state.");
  }
  return owner;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === "ESRCH") return false;
    // EPERM means the pid exists but this account cannot signal it.
    if (code === "EPERM") return true;
    throw leaseError("OpenMausBot could not verify the data-directory lease owner; refusing to start.", error);
  }
}

function unlinkExact(path: string, message: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw leaseError(message, error);
  }
}

/** Exactly one contender may retire a given dead owner token. A crashed
 * reaper leaves its marker behind, which deliberately fails closed instead
 * of allowing two later contenders to remove a replacement live lease. */
function retireDeadOwner(leasePath: string, expected: LeaseOwner): boolean {
  const reaperPath = `${leasePath}.reap-${expected.token}`;
  try {
    writeFileSync(reaperPath, `${process.pid}\n`, { flag: "wx", mode: 0o600, flush: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "EEXIST") return false;
    throw leaseError("OpenMausBot could not safely recover the stale data-directory lease.", error);
  }
  try {
    const current = readOwner(leasePath);
    if (!current || current.token !== expected.token) return true;
    if (current.host !== hostname() || processIsAlive(current.pid)) return false;
    unlinkExact(leasePath, "OpenMausBot could not retire the stale data-directory lease.");
    return true;
  } finally {
    unlinkExact(reaperPath, "OpenMausBot could not finish stale-lease recovery.");
  }
}

/** Claim exclusive ownership of one persistent OpenMausBot data directory.
 *
 * Integration is intentionally one line at each end of server lifetime:
 * acquire during startup, then call the returned handle's release() from the
 * graceful-shutdown cleanup. The random token remains private in this module.
 */
export function acquireDataDirLease(dataDir: string): DataDirLease {
  if (typeof dataDir !== "string" || dataDir.trim().length === 0 || /[\r\n\0]/.test(dataDir)) {
    throw leaseError("OpenMausBot cannot lease an invalid data directory.");
  }
  try {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  } catch (error) {
    throw leaseError("OpenMausBot cannot create its data directory.", error);
  }

  const leasePath = join(dataDir, LEASE_NAME);
  const owner: LeaseOwner = {
    version: 1,
    pid: process.pid,
    host: hostname(),
    token: randomUUID(),
    createdAt: Date.now(),
  };
  // Publish a fully written owner record in one atomic hard-link operation.
  // A process killed between writing and linking leaves only an inert,
  // uniquely named candidate—not an ambiguous ownerless lease.
  const candidatePath = `${leasePath}.candidate-${owner.pid}-${owner.token}`;
  try {
    writeFileSync(candidatePath, `${JSON.stringify(owner)}\n`, { flag: "wx", mode: 0o600, flush: true });
  } catch (error) {
    throw leaseError("OpenMausBot cannot prepare its data-directory lease.", error);
  }

  let acquired = false;
  try {
    for (;;) {
      try {
        linkSync(candidatePath, leasePath);
        acquired = true;
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") {
          throw leaseError("OpenMausBot cannot acquire its data-directory lease.", error);
        }
      }

      const current = readOwner(leasePath);
      if (!current) continue;
      if (current.host !== owner.host) {
        throw leaseError("This OpenMausBot data directory is already owned by a process on another machine.");
      }
      if (processIsAlive(current.pid)) {
        throw leaseError(
          `OpenMausBot is already using this data directory (process ${current.pid}). Close the other instance first.`,
        );
      }
      if (!retireDeadOwner(leasePath, current)) {
        throw leaseError("A stale OpenMausBot data-directory lease is already being recovered; try again shortly.");
      }
    }
  } finally {
    unlinkExact(candidatePath, "OpenMausBot could not remove its lease candidate.");
  }

  if (!acquired) throw leaseError("OpenMausBot could not acquire its data-directory lease.");
  let released = false;
  return {
    ownerPid: owner.pid,
    release(): boolean {
      if (released) return false;
      const current = readOwner(leasePath);
      if (!current || current.pid !== owner.pid || current.host !== owner.host || current.token !== owner.token) {
        throw leaseError("OpenMausBot will not release a data-directory lease owned by another process.");
      }
      try {
        unlinkSync(leasePath);
      } catch (error) {
        throw leaseError("OpenMausBot could not release its data-directory lease.", error);
      }
      released = true;
      return true;
    },
  };
}
