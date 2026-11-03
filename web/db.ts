import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  BatchWriteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  type QueryCommandInput,
} from "@aws-sdk/lib-dynamodb";
import { fail, identifier } from "./validate";

export function setting(
  name: string,
  fallback: number,
  min = 1,
  max = 1_000_000,
): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < min || value > max)
    throw new Error(`Invalid ${name}`);
  return value;
}
export const config = {
  questionCap: setting("QUESTION_CAP", 200),
  questionsPerMinute: setting("QUESTION_RATE", 5),
  votesPerMinute: setting("VOTE_RATE", 30),
  readsPerMinute: setting("READ_RATE", 60),
  cookiesPerIp: setting("COOKIE_IP_RATE", 120),
  writesPerIp: setting("WRITE_IP_RATE", 300),
  globalWrites: setting("WRITE_GLOBAL_RATE", 300),
  windowMs: setting("RATE_WINDOW_MS", 60_000),
  modelBudget: setting("MODEL_CALL_BUDGET", 100, 0),
  closingReserve: setting("CLOSING_CALL_RESERVE", 6, 0),
  runCalls: 6,
  leaseMs: setting("WORK_LEASE_MS", 90_000, 1000),
  audienceUrl: process.env.AUDIENCE_URL || "http://127.0.0.1:3000",
};

/*
 * Storage: one DynamoDB table (BACKSTAGE_TABLE, default "backstage") keyed by
 * string `pk` and `sk`. Credentials and region come from the AWS SDK chain
 * (AWS_PROFILE, AWS_REGION). DYNAMODB_ENDPOINT points at DynamoDB Local.
 *
 *   pk              sk                       item
 *   SESSIONS        S#<id>                   session row (below)
 *   SESSION#<id>    NOTES                    talking points
 *   META            LIVE | WORKER | LEASE    one-live guard, agent worker, the single work lease
 *   VISITOR#<id>    META                     browser cookie identity
 *   GEN#<gen>       Q#<id>                   question, its vote count and agent reply
 *   GEN#<gen>       V#<visitor>#<question>   one browser's vote
 *   GEN#<gen>       W#<id>                   work lease record
 *   GEN#<gen>       REC                      latest recommendation
 *   GEN#<gen>       A#<time>#<rand>          activity entry (expires by TTL)
 *
 * Every item carries a version `v`. `transaction(fn)` reads through a
 * write buffer, then commits all changed items in one TransactWriteItems call,
 * each conditioned on the version it was read at. A conflicting writer makes
 * the commit fail and `fn` runs again from fresh reads. Within this process
 * transactions also run one at a time, as they did under SQLite.
 */

export type Item = Record<string, unknown> & { pk: string; sk: string };
const table = () => process.env.BACKSTAGE_TABLE || "backstage";
const globalStore = globalThis as typeof globalThis & {
  backstageDynamo?: DynamoDBDocumentClient;
  backstageTxQueue?: Promise<unknown>;
};
function client(): DynamoDBDocumentClient {
  return (globalStore.backstageDynamo ??= DynamoDBDocumentClient.from(
    new DynamoDBClient(
      process.env.DYNAMODB_ENDPOINT
        ? { endpoint: process.env.DYNAMODB_ENDPOINT }
        : {},
    ),
    { marshallOptions: { removeUndefinedValues: true } },
  ));
}

const keyOf = (pk: string, sk: string) => `${pk}\u0000${sk}`;
type Entry = { orig: Item | null; cur: Item | null };
const clone = <T>(value: T): T => structuredClone(value);

class Tx {
  private entries = new Map<string, Entry>();
  readonly afterCommit: (() => Promise<void>)[] = [];
  constructor(readonly writable: boolean) {}

  private remember(item: Item | null, pk: string, sk: string) {
    const key = keyOf(pk, sk);
    const existing = this.entries.get(key);
    if (existing) return existing;
    const entry = { orig: item, cur: item };
    this.entries.set(key, entry);
    return entry;
  }
  async get(pk: string, sk: string): Promise<Item | undefined> {
    let entry = this.entries.get(keyOf(pk, sk));
    if (!entry) {
      const { Item: item } = await client().send(
        new GetCommand({
          TableName: table(),
          Key: { pk, sk },
          ConsistentRead: true,
        }),
      );
      entry = this.remember((item as Item) ?? null, pk, sk);
    }
    return entry.cur ? clone(entry.cur) : undefined;
  }
  /** Items under `pk` whose sort key starts with `prefix`, in sort-key order. */
  async query(
    pk: string,
    prefix: string,
    options: { descending?: boolean; limit?: number } = {},
  ): Promise<Item[]> {
    const fetched: Item[] = [];
    let start: QueryCommandInput["ExclusiveStartKey"];
    do {
      const page = await client().send(
        new QueryCommand({
          TableName: table(),
          KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
          ExpressionAttributeValues: { ":pk": pk, ":prefix": prefix },
          ConsistentRead: true,
          ScanIndexForward: !options.descending,
          Limit: options.limit,
          ExclusiveStartKey: start,
        }),
      );
      fetched.push(...((page.Items ?? []) as Item[]));
      start = options.limit ? undefined : page.LastEvaluatedKey;
    } while (start);
    const seen = new Set<string>();
    const items: Item[] = [];
    for (const item of fetched) {
      const entry = this.remember(item, item.pk, item.sk);
      seen.add(keyOf(item.pk, item.sk));
      if (entry.cur) items.push(entry.cur);
    }
    // Items this transaction created are visible to its own queries.
    for (const [key, entry] of this.entries)
      if (
        !seen.has(key) &&
        entry.cur &&
        entry.cur.pk === pk &&
        entry.cur.sk.startsWith(prefix)
      )
        items.push(entry.cur);
    items.sort((a, b) =>
      a.sk < b.sk ? -1 : a.sk > b.sk ? 1 : 0,
    );
    if (options.descending) items.reverse();
    return clone(
      options.limit ? items.slice(0, options.limit) : items,
    );
  }
  private requireWritable() {
    if (!this.writable) throw new Error("Writes need a transaction.");
  }
  /** Creates an item that must not exist yet, or replaces one this transaction read. */
  put(item: Item) {
    this.requireWritable();
    const key = keyOf(item.pk, item.sk);
    const entry = this.entries.get(key) ?? { orig: null, cur: null };
    entry.cur = clone(item);
    this.entries.set(key, entry);
  }
  /** Changes an existing item (or `init` when it is missing). Returns the result. */
  async update(
    pk: string,
    sk: string,
    change: (item: Item) => Record<string, unknown>,
    init?: Record<string, unknown>,
  ): Promise<Item> {
    this.requireWritable();
    const current = (await this.get(pk, sk)) ?? (init && { ...init, pk, sk });
    if (!current) throw new Error(`Missing item ${pk} ${sk}`);
    const next = { ...current, ...change(current), pk, sk } as Item;
    this.entries.get(keyOf(pk, sk))!.cur = clone(next);
    return next;
  }
  async remove(pk: string, sk: string) {
    this.requireWritable();
    await this.get(pk, sk);
    this.entries.get(keyOf(pk, sk))!.cur = null;
  }
  async commit() {
    const writes = [];
    for (const entry of this.entries.values()) {
      if (entry.cur === entry.orig) continue;
      const version = (entry.orig?.v as number | undefined) ?? 0;
      const guard = entry.orig
        ? {
            ConditionExpression: "v = :v",
            ExpressionAttributeValues: { ":v": version },
          }
        : { ConditionExpression: "attribute_not_exists(pk)" };
      if (entry.cur)
        writes.push({
          Put: {
            TableName: table(),
            Item: { ...entry.cur, v: version + 1 },
            ...guard,
          },
        });
      else if (entry.orig)
        writes.push({
          Delete: {
            TableName: table(),
            Key: { pk: entry.orig.pk, sk: entry.orig.sk },
            ...guard,
          },
        });
    }
    if (writes.length > 100)
      throw new Error("Transaction touches more than 100 items.");
    if (writes.length)
      await client().send(new TransactWriteCommand({ TransactItems: writes }));
  }
}

const current = new AsyncLocalStorage<Tx>();
/** The enclosing transaction, or a read-only view for plain reads. */
function tx(): Tx {
  return current.getStore() ?? new Tx(false);
}
export const store = {
  get: (pk: string, sk: string) => tx().get(pk, sk),
  query: (
    pk: string,
    prefix: string,
    options?: { descending?: boolean; limit?: number },
  ) => tx().query(pk, prefix, options),
  put: (item: Item) => tx().put(item),
  update: (
    pk: string,
    sk: string,
    change: (item: Item) => Record<string, unknown>,
    init?: Record<string, unknown>,
  ) => tx().update(pk, sk, change, init),
  remove: (pk: string, sk: string) => tx().remove(pk, sk),
  /** Runs after the enclosing transaction commits; failures are logged only. */
  afterCommit: (fn: () => Promise<void>) => tx().afterCommit.push(fn),
};

/** Another writer got there first: a version check failed or items were locked. */
function conflicted(error: unknown) {
  const e = error as {
    name?: string;
    CancellationReasons?: { Code?: string }[];
  };
  if (e?.name !== "TransactionCanceledException")
    return e?.name === "TransactionConflictException";
  return (e.CancellationReasons ?? []).some(
    (r) =>
      r.Code === "ConditionalCheckFailed" || r.Code === "TransactionConflict",
  );
}
const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** Runs `fn` atomically, retrying it on write conflicts. Nested calls join the enclosing transaction. */
export async function transaction<T>(fn: () => Promise<T>): Promise<T> {
  if (current.getStore()?.writable) return fn();
  const run = async () => {
    for (let attempt = 0; ; attempt++) {
      const t = new Tx(true);
      try {
        const value = await current.run(t, fn);
        await t.commit();
        for (const after of t.afterCommit)
          after().catch((error) =>
            console.error("Backstage cleanup failed:", error?.message),
          );
        return value;
      } catch (error) {
        if (!conflicted(error) || attempt >= 9) throw error;
        await pause(Math.random() * Math.min(1000, 25 * 2 ** attempt));
      }
    }
  };
  // One transaction at a time in this process; other processes are caught by versions.
  const queued = (globalStore.backstageTxQueue ?? Promise.resolve()).then(
    run,
    run,
  );
  globalStore.backstageTxQueue = queued.catch(() => undefined);
  return queued;
}

/** Deletes every item under `pk`, outside any transaction. */
export async function purge(pk: string) {
  let start: QueryCommandInput["ExclusiveStartKey"];
  do {
    const page = await client().send(
      new QueryCommand({
        TableName: table(),
        KeyConditionExpression: "pk = :pk",
        ExpressionAttributeValues: { ":pk": pk },
        ProjectionExpression: "pk, sk",
        ExclusiveStartKey: start,
      }),
    );
    const keys = page.Items ?? [];
    for (let i = 0; i < keys.length; i += 25) {
      let pending = keys
        .slice(i, i + 25)
        .map((Key) => ({ DeleteRequest: { Key } }));
      for (let attempt = 0; pending.length && attempt < 5; attempt++) {
        const result = await client().send(
          new BatchWriteCommand({ RequestItems: { [table()]: pending } }),
        );
        pending = (result.UnprocessedItems?.[table()] ??
          []) as typeof pending;
        if (pending.length) await pause(100 * 2 ** attempt);
      }
    }
    start = page.LastEvaluatedKey;
  } while (start);
}

// Sessions -----------------------------------------------------------------

/**
 * Per-run session state and its defaults. Reset returns every field here to
 * its default; pause_epoch only ever grows so late agent work stays rejected.
 */
export const runState = {
  revision: 0,
  intake_paused: 0,
  agent_paused: 0,
  selected_id: null,
  closing_requested: 0,
  closing_consumed: 0,
  budget_used: 0,
  budget_reserved: 0,
  recommendation_failed: 0,
  last_recommendation_attempt: 0,
  question_count: 0,
} as const;
export type SessionRow = {
  id: string;
  generation: string;
  title: string;
  live: number;
  created_at: number;
  revision: number;
  pause_epoch: number;
  intake_paused: number;
  agent_paused: number;
  selected_id: string | null;
  closing_requested: number;
  closing_consumed: number;
  budget_used: number;
  budget_reserved: number;
  recommendation_failed: number;
  last_recommendation_attempt: number;
  question_count: number;
};
export type WorkRow = {
  id: string;
  generation: string;
  pause_epoch: number;
  kind: string;
  question_ids: string[];
  revision: number;
  expires: number;
  closing: number;
  status: string;
  reservation: number;
  calls_used: number | null;
  result_id: string | null;
  acknowledged: number;
};
export type QuestionRow = {
  id: string;
  text: string;
  created_at: number;
  speaker_answered: number;
  hidden: number;
  attempts: number;
  next_try: number;
  votes: number;
  reply: { text: string; disposition: string; result_id: string } | null;
};

export const keys = {
  session: (id: string) => ["SESSIONS", `S#${id}`] as const,
  notes: (id: string) => [`SESSION#${id}`, "NOTES"] as const,
  live: ["META", "LIVE"] as const,
  worker: ["META", "WORKER"] as const,
  lease: ["META", "LEASE"] as const,
  visitor: (id: string) => [`VISITOR#${id}`, "META"] as const,
  generation: (g: string) => `GEN#${g}`,
  question: (g: string, id: string) => [`GEN#${g}`, `Q#${id}`] as const,
  vote: (g: string, visitor: string, question: string) =>
    [`GEN#${g}`, `V#${visitor}#${question}`] as const,
  work: (g: string, id: string) => [`GEN#${g}`, `W#${id}`] as const,
  recommendation: (g: string) => [`GEN#${g}`, "REC"] as const,
};
/** Seconds-since-epoch expiry for DynamoDB TTL. */
export const ttl = (ms: number) => Math.ceil(ms / 1000);

function row<T>(item: Item): T {
  const { pk: _pk, sk: _sk, v: _v, ...rest } = item;
  return rest as T;
}
/** Every session, newest first. There is always at least one. */
export async function sessions(): Promise<SessionRow[]> {
  let rows = (await store.query("SESSIONS", "S#")).map((item) =>
    row<SessionRow>(item),
  );
  if (!rows.length) {
    await transaction(async () => {
      if ((await store.query("SESSIONS", "S#")).length) return;
      const id = randomUUID();
      store.put({
        ...newSession(id, randomUUID(), "Untitled session"),
        pk: keys.session(id)[0],
        sk: keys.session(id)[1],
      });
    });
    rows = (await store.query("SESSIONS", "S#")).map((item) =>
      row<SessionRow>(item),
    );
  }
  return rows.sort(
    (a, b) => b.created_at - a.created_at || (a.id < b.id ? 1 : -1),
  );
}
export function newSession(
  id: string,
  generation: string,
  title: string,
): SessionRow {
  return {
    id,
    generation,
    title,
    live: 0,
    created_at: Date.now(),
    pause_epoch: 0,
    ...runState,
  };
}
export async function sessionById(id: string): Promise<SessionRow | undefined> {
  const item = await store.get(...keys.session(id));
  return item && row<SessionRow>(item);
}
export async function sessionByGeneration(
  generation: string,
): Promise<SessionRow | undefined> {
  return (await sessions()).find((s) => s.generation === generation);
}
export async function liveSession(): Promise<SessionRow | undefined> {
  return (await sessions()).find((s) => s.live);
}
/** The live session, else the most recently created one. */
export async function defaultSession(): Promise<SessionRow> {
  const all = await sessions();
  return all.find((s) => s.live) ?? all[0];
}
/** Applies `change` to session `s` as stored now, and returns the result. */
export async function updateSession(
  s: SessionRow,
  change: (current: SessionRow) => Partial<SessionRow>,
): Promise<SessionRow> {
  return row<SessionRow>(
    await store.update(...keys.session(s.id), (item) =>
      change(row<SessionRow>(item)),
    ),
  );
}
export async function talkingPointsOf(s: SessionRow): Promise<string> {
  return ((await store.get(...keys.notes(s.id)))?.text as string) ?? "";
}

// Questions, votes, activity -------------------------------------------------

export async function questions(s: SessionRow): Promise<QuestionRow[]> {
  return (await store.query(keys.generation(s.generation), "Q#")).map((item) =>
    row<QuestionRow>(item),
  );
}
export async function updateQuestion(
  s: SessionRow,
  id: string,
  change: (q: QuestionRow) => Partial<QuestionRow>,
) {
  return row<QuestionRow>(
    await store.update(...keys.question(s.generation, id), (item) =>
      change(row<QuestionRow>(item)),
    ),
  );
}

let activitySequence = 0;
export function activity(
  generation: string,
  kind: string,
  message: string,
  workId?: string,
  questionId?: string,
) {
  const at = Date.now();
  const order = `${String(at).padStart(15, "0")}#${String(activitySequence++ % 1e6).padStart(6, "0")}${randomUUID().slice(0, 8)}`;
  store.put({
    pk: keys.generation(generation),
    sk: `A#${order}`,
    at,
    kind,
    message: message.slice(0, 240),
    work_id: workId ?? null,
    question_id: questionId ?? null,
    ttl: ttl(at + 7 * 24 * 3600_000),
  });
}
export async function recentActivity(generation: string) {
  return (
    await store.query(keys.generation(generation), "A#", {
      descending: true,
      limit: 100,
    })
  ).map((item) => ({
    id: item.sk,
    at: item.at as number,
    kind: item.kind as string,
    message: item.message as string,
    workId: (item.work_id as string | null) ?? null,
    questionId: (item.question_id as string | null) ?? null,
  }));
}

export async function board(s: SessionRow, visitor = "") {
  const [rows, mine] = await Promise.all([
    questions(s),
    visitor
      ? store.query(keys.generation(s.generation), `V#${visitor}#`)
      : Promise.resolve([]),
  ]);
  const voted = new Set(mine.map((item) => item.question_id as string));
  return rows
    .sort(
      (a, b) =>
        b.votes - a.votes ||
        a.created_at - b.created_at ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    )
    .map((q) => ({
      id: q.id,
      text: q.text,
      createdAt: q.created_at,
      votes: q.votes,
      voted: voted.has(q.id),
      speakerAnswered: !!q.speaker_answered,
      hidden: !!q.hidden,
      selected: q.id === s.selected_id,
      reply: q.reply
        ? { text: q.reply.text, disposition: q.reply.disposition }
        : null,
    }));
}
/** Resolves a question within session `s`. */
export async function question(
  s: SessionRow,
  value: unknown,
): Promise<QuestionRow> {
  const id = identifier(value);
  const item = await store.get(...keys.question(s.generation, id));
  if (!item) fail(404, "QUESTION_NOT_FOUND", "Question not found.");
  return row<QuestionRow>(item);
}
