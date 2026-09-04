import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { writeFileAtomic } from "./atomic.ts";
import { DATA_DIR } from "./config.ts";

const FILE = join(DATA_DIR, "box-create-requests.json");
const KEY_RETENTION_MS = 24 * 60 * 60 * 1_000;
const MAX_REQUESTS = 4_096;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const BOT_ID = /^[A-Za-z0-9_-]{1,120}$/;
const BOX_ID = /^bx_[23456789abcdefghjkmnpqrstuvwxyz]{8}$/;

export interface BoxCreateRequest {
  botId: string;
  requestBody: string;
  idempotencyKey: string;
  createdAt: number;
  boxId?: string;
  /** The provider Box has its deterministic OpenMaus name. Until this is
   * true, deleting the bot would make an ambiguous or unnamed Box orphaned. */
  resolved?: true;
}

export interface BoxCreateAttempt {
  request: BoxCreateRequest;
  /** True only when this call wrote a brand-new provider key. This is
   * deliberately process-local provenance: a resumed key may resolve a Box
   * created by an earlier app run and must never authorize automatic cleanup. */
  startedNow: boolean;
}

let loaded = false;
let requests: BoxCreateRequest[] = [];

function isRequest(value: unknown): value is BoxCreateRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const request = value as Record<string, unknown>;
  return (
    typeof request.botId === "string"
    && BOT_ID.test(request.botId)
    && typeof request.requestBody === "string"
    && request.requestBody.length > 0
    && request.requestBody.length <= 1_024
    && typeof request.idempotencyKey === "string"
    && UUID.test(request.idempotencyKey)
    && typeof request.createdAt === "number"
    && Number.isFinite(request.createdAt)
    && request.createdAt > 0
    && (request.boxId === undefined || (typeof request.boxId === "string" && BOX_ID.test(request.boxId)))
    && (request.resolved === undefined || (request.resolved === true && typeof request.boxId === "string"))
  );
}

function recoveryStateError(detail: string, cause?: unknown): Error & { status: number } {
  return Object.assign(
    new Error(
      `Cloud computer creation is paused because its recovery state is ${detail}. `
      + "Check ascii.dev for an unnamed Box before repairing OpenMausBot's local state.",
    ),
    { status: 503, cause },
  );
}

function load(): void {
  if (loaded) return;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(FILE, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      loaded = true;
      return;
    }
    throw recoveryStateError("unreadable", error);
  }
  const file = raw as { version?: unknown; requests?: unknown };
  if (
    !file
    || typeof file !== "object"
    || Array.isArray(file)
    || file.version !== 1
    || !Array.isArray(file.requests)
    || file.requests.length > MAX_REQUESTS
    || !file.requests.every(isRequest)
  ) {
    throw recoveryStateError("invalid");
  }
  const identities = new Set<string>();
  const keys = new Set<string>();
  const botsWithKnownBoxes = new Set<string>();
  for (const request of file.requests) {
    const identity = `${request.botId}\0${request.requestBody}`;
    if (identities.has(identity) || keys.has(request.idempotencyKey)) throw recoveryStateError("invalid");
    if (request.boxId && botsWithKnownBoxes.has(request.botId)) throw recoveryStateError("invalid");
    identities.add(identity);
    keys.add(request.idempotencyKey);
    if (request.boxId) botsWithKnownBoxes.add(request.botId);
  }
  requests = file.requests;
  loaded = true;
}

function save(next: BoxCreateRequest[]): void {
  mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  try {
    writeFileAtomic(FILE, `${JSON.stringify({ version: 1, requests: next }, null, 2)}\n`, { mode: 0o600 });
  } catch (error) {
    throw recoveryStateError("unavailable", error);
  }
  requests = next;
}

/** Record the exact provider request before it leaves the process. A known
 * Box wins over a changed body: once a provider resource exists, recovering
 * and naming it is safer than issuing any second create request. */
export function beginBoxCreate(botId: string, requestBody: string): BoxCreateAttempt {
  if (!BOT_ID.test(botId)) throw new Error("invalid bot id for cloud computer creation");
  if (!requestBody || requestBody.length > 1_024) throw new Error("invalid cloud computer create request");
  load();

  const known = requests.find((request) => request.botId === botId && request.boxId);
  if (known) return { request: { ...known }, startedNow: false };

  const now = Date.now();
  const pending = requests.find((request) => request.botId === botId);
  if (pending) {
    if (pending.requestBody !== requestBody) {
      throw recoveryStateError("waiting for an earlier cloud computer request to be reconciled");
    }
    if (now - pending.createdAt >= KEY_RETENTION_MS) {
      // Once the provider forgets the idempotency key, retrying it (or using a
      // new key) may create a second billable Box. Absence cannot be inferred
      // from a lost response, so stop until the person checks the provider.
      throw recoveryStateError("older than ascii.dev's 24-hour retry window");
    }
    return { request: { ...pending }, startedNow: false };
  }

  const request: BoxCreateRequest = {
    botId,
    requestBody,
    idempotencyKey: randomUUID(),
    createdAt: now,
  };
  if (requests.length >= MAX_REQUESTS) {
    throw recoveryStateError("full");
  }
  save([...requests, request]);
  return { request: { ...request }, startedNow: true };
}

/** Persist the returned identity before the caller attempts to rename it. */
export function rememberCreatedBox(request: BoxCreateRequest, boxId: string): BoxCreateRequest {
  if (!BOX_ID.test(boxId)) throw new Error("ascii.dev returned an invalid cloud computer id");
  load();
  const current = requests.find((candidate) => (
    candidate.botId === request.botId
    && candidate.requestBody === request.requestBody
    && candidate.idempotencyKey === request.idempotencyKey
  ));
  if (!current) throw recoveryStateError("out of date");
  const completed = { ...current, boxId };
  // There can be an older rejected-TTL request for this bot. Once a Box is
  // known, it is the only recovery authority we need to retain.
  save([...requests.filter((candidate) => candidate.botId !== request.botId), completed]);
  return { ...completed };
}

/** Mark the recovery record safe only after the deterministic provider rename
 * succeeds. Keeping the resolved Box ID still lets a later retry recover from
 * an eventually-consistent account listing without blocking bot deletion. */
export function resolveBoxCreate(request: BoxCreateRequest): BoxCreateRequest {
  load();
  const current = requests.find((candidate) => (
    candidate.botId === request.botId
    && candidate.requestBody === request.requestBody
    && candidate.idempotencyKey === request.idempotencyKey
    && candidate.boxId === request.boxId
  ));
  if (!current?.boxId) throw recoveryStateError("out of date");
  const resolved: BoxCreateRequest = { ...current, resolved: true };
  save(requests.map((candidate) => candidate.idempotencyKey === current.idempotencyKey ? resolved : candidate));
  return { ...resolved };
}

/** Read-only deletion guard. Both a key-only request with an ambiguous
 * provider outcome and a known-but-not-yet-named Box must keep its bot owner. */
export function hasUnresolvedBoxCreate(botId: string): boolean {
  if (!BOT_ID.test(botId)) throw new Error("invalid bot id for cloud computer creation");
  load();
  return requests.some((request) => request.botId === botId && request.resolved !== true);
}

export function discardBoxCreate(request: BoxCreateRequest): void {
  load();
  const next = requests.filter((candidate) => candidate.idempotencyKey !== request.idempotencyKey);
  if (next.length !== requests.length) save(next);
}
