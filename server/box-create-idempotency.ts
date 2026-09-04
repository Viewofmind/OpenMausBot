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

export interface BoxCreateRequest {
  botId: string;
  requestBody: string;
  idempotencyKey: string;
  createdAt: number;
  boxId?: string;
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
    && (request.boxId === undefined
      || (typeof request.boxId === "string" && request.boxId.length > 0 && request.boxId.length <= 255))
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
export function beginBoxCreate(botId: string, requestBody: string): BoxCreateRequest {
  if (!BOT_ID.test(botId)) throw new Error("invalid bot id for cloud computer creation");
  if (!requestBody || requestBody.length > 1_024) throw new Error("invalid cloud computer create request");
  load();

  const known = requests.find((request) => request.botId === botId && request.boxId);
  if (known) return { ...known };

  const now = Date.now();
  const exact = requests.find((request) => request.botId === botId && request.requestBody === requestBody);
  if (exact && now - exact.createdAt < KEY_RETENTION_MS) return { ...exact };

  // ascii.dev retains keys for 24 hours. Past that boundary a fresh key is
  // the only meaningful retry; entries with a returned Box ID never expire.
  const next = requests.filter((request) => (
    request.boxId !== undefined || now - request.createdAt < KEY_RETENTION_MS
  ));
  const request: BoxCreateRequest = {
    botId,
    requestBody,
    idempotencyKey: randomUUID(),
    createdAt: now,
  };
  const withoutExact = next.filter((candidate) => (
    candidate.botId !== botId || candidate.requestBody !== requestBody
  ));
  if (withoutExact.length >= MAX_REQUESTS) {
    throw recoveryStateError("full");
  }
  save([...withoutExact, request]);
  return { ...request };
}

/** Persist the returned identity before the caller attempts to rename it. */
export function rememberCreatedBox(request: BoxCreateRequest, boxId: string): BoxCreateRequest {
  if (!boxId || boxId.length > 255) throw new Error("ascii.dev returned an invalid cloud computer id");
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

export function discardBoxCreate(request: BoxCreateRequest): void {
  load();
  const next = requests.filter((candidate) => candidate.idempotencyKey !== request.idempotencyKey);
  if (next.length !== requests.length) save(next);
}
