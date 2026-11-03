import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
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
const globalDb = globalThis as typeof globalThis & {
  backstageDb?: DatabaseSync;
};
const sessionColumns = `revision INTEGER NOT NULL DEFAULT 0, pause_epoch INTEGER NOT NULL DEFAULT 0,
  intake_paused INTEGER NOT NULL DEFAULT 0, agent_paused INTEGER NOT NULL DEFAULT 0,
  selected_id TEXT, closing_requested INTEGER NOT NULL DEFAULT 0, closing_consumed INTEGER NOT NULL DEFAULT 0,
  budget_used INTEGER NOT NULL DEFAULT 0, budget_reserved INTEGER NOT NULL DEFAULT 0,
  recommendation_failed INTEGER NOT NULL DEFAULT 0, last_recommendation_attempt INTEGER NOT NULL DEFAULT 0`;
function columns(database: DatabaseSync, table: string) {
  return database
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .map((column) => column.name as string);
}
function database(): DatabaseSync {
  if (globalDb.backstageDb) return globalDb.backstageDb;
  const filename = resolve(process.env.BACKSTAGE_DB || "data/backstage.sqlite");
  mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
  const database = new DatabaseSync(filename);
  database.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, generation TEXT NOT NULL UNIQUE, title TEXT NOT NULL,
  talking_points TEXT NOT NULL DEFAULT '', live INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, ${sessionColumns});
CREATE UNIQUE INDEX IF NOT EXISTS sessions_one_live ON sessions(live) WHERE live=1;
CREATE TABLE IF NOT EXISTS worker (singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  status TEXT NOT NULL DEFAULT 'disconnected', heartbeat INTEGER, session_id TEXT);
CREATE TABLE IF NOT EXISTS visitors (id TEXT PRIMARY KEY, expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS questions (id TEXT PRIMARY KEY, generation TEXT NOT NULL, text TEXT NOT NULL, created_at INTEGER NOT NULL,
  speaker_answered INTEGER NOT NULL DEFAULT 0, hidden INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0, next_try INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS votes (visitor_id TEXT NOT NULL REFERENCES visitors(id), question_id TEXT NOT NULL REFERENCES questions(id) ON DELETE CASCADE, PRIMARY KEY(visitor_id,question_id));
CREATE TABLE IF NOT EXISTS replies (question_id TEXT PRIMARY KEY REFERENCES questions(id) ON DELETE CASCADE, text TEXT NOT NULL, disposition TEXT NOT NULL, result_id TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS work (id TEXT PRIMARY KEY, generation TEXT NOT NULL, pause_epoch INTEGER NOT NULL, kind TEXT NOT NULL,
 question_ids TEXT NOT NULL, snapshot TEXT NOT NULL, revision INTEGER NOT NULL, expires INTEGER NOT NULL,
 closing INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'active', reservation INTEGER NOT NULL, calls_used INTEGER, result_id TEXT UNIQUE, acknowledged INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS activity (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, kind TEXT NOT NULL, message TEXT NOT NULL, work_id TEXT, question_id TEXT);
INSERT OR IGNORE INTO worker(singleton) VALUES(1);
`);
  database.exec("BEGIN IMMEDIATE");
  try {
    // Activity is scoped to a session generation.
    if (!columns(database, "activity").includes("generation"))
      database.exec("ALTER TABLE activity ADD COLUMN generation TEXT");
    // Recommendations used to be a singleton; key them by session generation.
    if (columns(database, "recommendations").includes("singleton"))
      database.exec(`ALTER TABLE recommendations RENAME TO recommendations_v1;`);
    database.exec(
      "CREATE TABLE IF NOT EXISTS recommendations (generation TEXT PRIMARY KEY, revision INTEGER NOT NULL, created_at INTEGER NOT NULL, data TEXT NOT NULL)",
    );
    if (columns(database, "recommendations_v1").length)
      database.exec(`INSERT OR IGNORE INTO recommendations SELECT generation,revision,created_at,data FROM recommendations_v1;
DROP TABLE recommendations_v1;`);
    // The single-event table becomes the first session.
    const legacy = columns(database, "event");
    if (legacy.length) {
      const row = database.prepare("SELECT * FROM event WHERE singleton=1").get();
      if (row) {
        const copied = [
          "generation", "revision", "pause_epoch", "intake_paused", "agent_paused", "selected_id",
          "closing_requested", "closing_consumed", "budget_used", "budget_reserved",
          "recommendation_failed", "last_recommendation_attempt",
        ].filter((name) => legacy.includes(name));
        database
          .prepare(
            `INSERT OR IGNORE INTO sessions(id,title,live,created_at,${copied.join(",")})
             VALUES(?,?,1,?,${copied.map(() => "?").join(",")})`,
          )
          .run(randomUUID(), "Session 1", Date.now(), ...copied.map((name) => row[name] as string | number | null));
        database
          .prepare("UPDATE worker SET status=?,heartbeat=? WHERE singleton=1")
          .run((row.worker_status as string) ?? "disconnected", (row.heartbeat as number | null) ?? null);
        database
          .prepare("UPDATE activity SET generation=? WHERE generation IS NULL")
          .run(row.generation as string);
      }
      database.exec("DROP TABLE event");
    }
    // There is always at least one session to host.
    if (!database.prepare("SELECT 1 FROM sessions LIMIT 1").get())
      database
        .prepare("INSERT INTO sessions(id,generation,title,created_at) VALUES(?,?,?,?)")
        .run(randomUUID(), randomUUID(), "Untitled session", Date.now());
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
  globalDb.backstageDb = database;
  return database;
}
// Next imports route modules during builds. Open runtime storage only on a request.
export const db = {
  prepare: (sql: string) => database().prepare(sql),
  exec: (sql: string) => database().exec(sql),
};
export type SessionRow = {
  id: string;
  generation: string;
  title: string;
  talking_points: string;
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
};
export type WorkRow = {
  id: string;
  generation: string;
  pause_epoch: number;
  kind: string;
  question_ids: string;
  snapshot: string;
  revision: number;
  expires: number;
  closing: number;
  status: string;
  reservation: number;
  calls_used: number | null;
  result_id: string | null;
  acknowledged: number;
};
export function sessionById(id: string): SessionRow | undefined {
  return db.prepare("SELECT * FROM sessions WHERE id=?").get(id) as
    | SessionRow
    | undefined;
}
export function sessionByGeneration(generation: string): SessionRow | undefined {
  return db.prepare("SELECT * FROM sessions WHERE generation=?").get(generation) as
    | SessionRow
    | undefined;
}
export function liveSession(): SessionRow | undefined {
  return db.prepare("SELECT * FROM sessions WHERE live=1").get() as
    | SessionRow
    | undefined;
}
/** The live session, else the most recently created one. */
export function defaultSession(): SessionRow {
  return (liveSession() ??
    db
      .prepare("SELECT * FROM sessions ORDER BY created_at DESC, rowid DESC LIMIT 1")
      .get()) as SessionRow;
}
/** Runs `fn` atomically. Nested calls join the enclosing transaction. */
export function transaction<T>(fn: () => T): T {
  if (database().isTransaction) return fn();
  db.exec("BEGIN IMMEDIATE");
  try {
    const value = fn();
    db.exec("COMMIT");
    return value;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
export function activity(
  generation: string,
  kind: string,
  message: string,
  workId?: string,
  questionId?: string,
) {
  db.prepare(
    "INSERT INTO activity(at,generation,kind,message,work_id,question_id) VALUES(?,?,?,?,?,?)",
  ).run(
    Date.now(),
    generation,
    kind,
    message.slice(0, 240),
    workId ?? null,
    questionId ?? null,
  );
  db.prepare(
    "DELETE FROM activity WHERE generation=? AND id NOT IN (SELECT id FROM activity WHERE generation=? ORDER BY id DESC LIMIT 100)",
  ).run(generation, generation);
}
export function board(s: SessionRow, visitor = "") {
  return db
    .prepare(
      `SELECT q.id,q.text,q.created_at AS createdAt,q.speaker_answered AS speakerAnswered,q.hidden,
    (SELECT COUNT(*) FROM votes v WHERE v.question_id=q.id) AS votes,
    EXISTS(SELECT 1 FROM votes v WHERE v.question_id=q.id AND visitor_id=?) AS voted,
    r.text AS replyText,r.disposition FROM questions q LEFT JOIN replies r ON r.question_id=q.id
    WHERE q.generation=? ORDER BY votes DESC,q.created_at ASC,q.id ASC`,
    )
    .all(visitor, s.generation)
    .map((raw) => ({
      id: raw.id as string,
      text: raw.text as string,
      createdAt: raw.createdAt as number,
      votes: raw.votes as number,
      voted: !!raw.voted,
      speakerAnswered: !!raw.speakerAnswered,
      hidden: !!raw.hidden,
      selected: raw.id === s.selected_id,
      reply: raw.replyText
        ? {
            text: raw.replyText as string,
            disposition: raw.disposition as string,
          }
        : null,
    }));
}
/** Resolves a question id within session `s`. */
export function question(s: SessionRow, value: unknown): string {
  const id = identifier(value);
  if (
    !db
      .prepare("SELECT 1 FROM questions WHERE id=? AND generation=?")
      .get(id, s.generation)
  )
    fail(404, "QUESTION_NOT_FOUND", "Question not found.");
  return id;
}
