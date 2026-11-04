/** Vendored wire rules: CRM and external must match the S0 specification vectors. */
export class InboxError extends Error {
  constructor(public readonly status: number, public readonly code: string) {
    super(code);
  }
}
export type Json = null | boolean | number | string | Json[] | {
  [key: string]: Json;
};
const invalid = (): never => {
  throw new InboxError(422, "invalid_event");
};
const object = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const integer = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const keysWithin = (v: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(v).every((k) => keys.includes(k));

export function canonicalize(value: unknown, depth = 0): string {
  if (depth > 32) return invalid();
  if (
    value === null || typeof value === "string" || typeof value === "boolean"
  ) return JSON.stringify(value);
  if (typeof value === "number") {
    if (
      !Number.isFinite(value) ||
      (Number.isInteger(value) && !Number.isSafeInteger(value))
    ) return invalid();
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalize(v, depth + 1)).join(",")}]`;
  }
  if (!object(value)) return invalid();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return invalid();
  return `{${
    Object.keys(value).sort().map((k) =>
      `${JSON.stringify(k)}:${canonicalize(value[k], depth + 1)}`
    ).join(",")
  }}`;
}

export function projectEvent(value: unknown): Record<string, unknown> {
  if (!object(value)) return invalid();
  return Object.fromEntries(
    Object.entries(value).filter(([k]) =>
      k !== "replyToken" && k !== "deliveryContext"
    ),
  );
}

export async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)].map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}

function classification(
  event: Record<string, unknown>,
): "pending" | "quarantined_schema" | "withdrawn" {
  if (
    !text(event.webhookEventId) || event.webhookEventId.length > 255 ||
    !integer(event.timestamp) || !text(event.type)
  ) return invalid();
  if (event.source !== undefined && !object(event.source)) return invalid();
  const source = event.source as Record<string, unknown> | undefined;
  let known = keysWithin(event, [
    "webhookEventId",
    "timestamp",
    "type",
    "mode",
    "source",
    "message",
    "unsend",
  ]);
  if (
    event.mode !== undefined && event.mode !== "active" &&
    event.mode !== "standby"
  ) known = false;
  if (
    source &&
    (!keysWithin(source, ["type", "userId", "groupId", "roomId"]) ||
      !["user", "group", "room"].includes(String(source.type)))
  ) known = false;
  if (source) {
    for (
      const key of ["userId", "groupId", "roomId"]
    ) if (source[key] !== undefined && !text(source[key])) return invalid();
  }
  if (event.type === "unsend") {
    if (!object(event.unsend) || !text(event.unsend.messageId)) {
      return invalid();
    }
    return known && keysWithin(event.unsend, ["messageId"]) &&
        event.message === undefined
      ? "withdrawn"
      : "quarantined_schema";
  }
  if (event.type !== "message") return "quarantined_schema";
  if (!object(event.message) || !text(event.message.type)) return invalid();
  const m = event.message;
  if (m.type !== "text") return "quarantined_schema";
  if (!text(m.id) || typeof m.text !== "string") return invalid();
  known = known && event.unsend === undefined &&
    keysWithin(m, [
      "id",
      "type",
      "text",
      "quoteToken",
      "markAsReadToken",
      "quotedMessageId",
      "emojis",
      "mention",
    ]);
  for (const key of ["quoteToken", "markAsReadToken", "quotedMessageId"]) {
    if (m[key] !== undefined && !text(m[key])) return invalid();
  }
  if (m.emojis !== undefined) {
    if (!Array.isArray(m.emojis)) return invalid();
    for (const emoji of m.emojis) {
      if (
        !object(emoji) || !integer(emoji.index) || !integer(emoji.length) ||
        emoji.length === 0 || !text(emoji.productId) || !text(emoji.emojiId)
      ) return invalid();
      known = known &&
        keysWithin(emoji, ["index", "length", "productId", "emojiId"]);
    }
  }
  if (m.mention !== undefined) {
    if (
      !object(m.mention) || !Array.isArray(m.mention.mentionees) ||
      m.mention.mentionees.length < 1 || m.mention.mentionees.length > 20
    ) return invalid();
    known = known && keysWithin(m.mention, ["mentionees"]);
    for (const mention of m.mention.mentionees) {
      if (
        !object(mention) || !integer(mention.index) ||
        !integer(mention.length) || mention.length === 0 ||
        !["user", "all"].includes(String(mention.type))
      ) return invalid();
      if (
        mention.userId !== undefined &&
        (!text(mention.userId) || mention.type !== "user")
      ) return invalid();
      if (
        mention.isSelf !== undefined &&
        (typeof mention.isSelf !== "boolean" || mention.type !== "user")
      ) return invalid();
      known = known &&
        keysWithin(mention, ["index", "length", "type", "userId", "isSelf"]);
    }
  }
  return known && source?.type === "user" && text(source.userId)
    ? "pending"
    : "quarantined_schema";
}

export async function prepareInboxEvent(
  value: unknown,
  suppliedHash?: unknown,
) {
  const event = projectEvent(value);
  const canonical = canonicalize(event);
  const hash = await sha256(canonical);
  if (suppliedHash !== undefined && suppliedHash !== hash) {
    throw new InboxError(422, "invalid_event");
  }
  const status = classification(event);
  // Tokens participate in the conflict hash but never reach durable storage or a worker.
  const persisted = JSON.parse(canonical) as Record<string, unknown>;
  if (object(persisted.message)) {
    delete persisted.message.quoteToken;
    delete persisted.message.markAsReadToken;
  }
  return {
    event: persisted,
    canonical_event_hash_v1: hash,
    classification: status,
  };
}

export async function validateRecordArgs(args: Record<string, unknown>) {
  if (
    !text(args.p_request_id) ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .test(args.p_request_id) ||
    typeof args.p_delivery_raw_digest !== "string" ||
    !/^[a-f0-9]{64}$/.test(args.p_delivery_raw_digest) ||
    !Array.isArray(args.p_events)
  ) throw new InboxError(422, "invalid_request");
  if (args.p_events.length > 100) {
    throw new InboxError(413, "payload_too_large");
  }
  const events = [];
  for (const entry of args.p_events) {
    if (
      !object(entry) ||
      Object.keys(entry).sort().join(",") !== "canonical_event_hash_v1,event" ||
      !object(entry.event) || Object.hasOwn(entry.event, "replyToken") ||
      Object.hasOwn(entry.event, "deliveryContext") ||
      typeof entry.canonical_event_hash_v1 !== "string" ||
      !/^[a-f0-9]{64}$/.test(entry.canonical_event_hash_v1)
    ) return invalid();
    events.push(
      await prepareInboxEvent(entry.event, entry.canonical_event_hash_v1),
    );
  }
  return { ...args, p_events: events };
}

export function validateJobArgs(action: string, args: Record<string, unknown>) {
  if (action === "inbox.claim.v1") {
    if (
      !integer(args.p_limit) || args.p_limit < 1 || args.p_limit > 20 ||
      !integer(args.p_lease_seconds) || args.p_lease_seconds < 30 ||
      args.p_lease_seconds > 300
    ) throw new InboxError(422, "invalid_request");
  } else {
    const uuid = (v: unknown) =>
      typeof v === "string" &&
      /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(v);
    if (
      !uuid(args.p_job_id) || !uuid(args.p_lease_token) ||
      !integer(args.p_expected_version) || args.p_expected_version < 1 ||
      !["validated", "quarantined", "retry", "failed"].includes(
        String(args.p_outcome),
      ) ||
      args.p_error_code !== null &&
        !["schema_unknown", "temporary_unavailable", "attempts_exhausted"]
          .includes(String(args.p_error_code))
    ) throw new InboxError(422, "invalid_request");
  }
  return args;
}
