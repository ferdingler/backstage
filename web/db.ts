import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";

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
function database(): DatabaseSync {
  if (globalDb.backstageDb) return globalDb.backstageDb;
  const filename = resolve(process.env.BACKSTAGE_DB || "data/backstage.sqlite");
  mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
  const database = new DatabaseSync(filename);
  database.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS event (singleton INTEGER PRIMARY KEY CHECK(singleton=1), generation TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0, pause_epoch INTEGER NOT NULL DEFAULT 0,
  intake_paused INTEGER NOT NULL DEFAULT 0, agent_paused INTEGER NOT NULL DEFAULT 0,
  selected_id TEXT, closing_requested INTEGER NOT NULL DEFAULT 0, closing_consumed INTEGER NOT NULL DEFAULT 0,
  budget_used INTEGER NOT NULL DEFAULT 0, budget_reserved INTEGER NOT NULL DEFAULT 0,
  worker_status TEXT NOT NULL DEFAULT 'disconnected', heartbeat INTEGER, recommendation_failed INTEGER NOT NULL DEFAULT 0, last_recommendation_attempt INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS visitors (id TEXT PRIMARY KEY, expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS questions (id TEXT PRIMARY KEY, generation TEXT NOT NULL, text TEXT NOT NULL, created_at INTEGER NOT NULL,
  speaker_answered INTEGER NOT NULL DEFAULT 0, hidden INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0, next_try INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS votes (visitor_id TEXT NOT NULL REFERENCES visitors(id), question_id TEXT NOT NULL REFERENCES questions(id) ON DELETE CASCADE, PRIMARY KEY(visitor_id,question_id));
CREATE TABLE IF NOT EXISTS replies (question_id TEXT PRIMARY KEY REFERENCES questions(id) ON DELETE CASCADE, text TEXT NOT NULL, disposition TEXT NOT NULL, result_id TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS work (id TEXT PRIMARY KEY, generation TEXT NOT NULL, pause_epoch INTEGER NOT NULL, kind TEXT NOT NULL,
 question_ids TEXT NOT NULL, snapshot TEXT NOT NULL, revision INTEGER NOT NULL, expires INTEGER NOT NULL,
 closing INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'active', reservation INTEGER NOT NULL, calls_used INTEGER, result_id TEXT UNIQUE, acknowledged INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS recommendations (singleton INTEGER PRIMARY KEY CHECK(singleton=1), generation TEXT NOT NULL, revision INTEGER NOT NULL, created_at INTEGER NOT NULL, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS activity (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, kind TEXT NOT NULL, message TEXT NOT NULL, work_id TEXT, question_id TEXT);
`);
  if (
    !database
      .prepare("PRAGMA table_info(event)")
      .all()
      .some((column) => column.name === "recommendation_failed")
  )
    database.exec(
      "ALTER TABLE event ADD COLUMN recommendation_failed INTEGER NOT NULL DEFAULT 0",
    );
  database
    .prepare("INSERT OR IGNORE INTO event(singleton,generation) VALUES(1,?)")
    .run(randomUUID());
  globalDb.backstageDb = database;
  return database;
}
// Next imports route modules during builds. Open runtime storage only on a request.
export const db = {
  prepare: (sql: string) => database().prepare(sql),
  exec: (sql: string) => database().exec(sql),
};
export type EventRow = {
  generation: string;
  revision: number;
  pause_epoch: number;
  intake_paused: number;
  agent_paused: number;
  selected_id: string | null;
  closing_requested: number;
  closing_consumed: number;
  budget_used: number;
  budget_reserved: number;
  worker_status: string;
  heartbeat: number | null;
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
export function event(): EventRow {
  return db.prepare("SELECT * FROM event WHERE singleton=1").get() as EventRow;
}
export function transaction<T>(fn: () => T): T {
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
  kind: string,
  message: string,
  workId?: string,
  questionId?: string,
) {
  db.prepare(
    "INSERT INTO activity(at,kind,message,work_id,question_id) VALUES(?,?,?,?,?)",
  ).run(
    Date.now(),
    kind,
    message.slice(0, 240),
    workId ?? null,
    questionId ?? null,
  );
  db.exec(
    "DELETE FROM activity WHERE id NOT IN (SELECT id FROM activity ORDER BY id DESC LIMIT 100)",
  );
}
export function board(visitor = "") {
  return db
    .prepare(
      `SELECT q.id,q.text,q.created_at AS createdAt,q.speaker_answered AS speakerAnswered,q.hidden,
    (SELECT COUNT(*) FROM votes v WHERE v.question_id=q.id) AS votes,
    EXISTS(SELECT 1 FROM votes v WHERE v.question_id=q.id AND visitor_id=?) AS voted,
    r.text AS replyText,r.disposition FROM questions q LEFT JOIN replies r ON r.question_id=q.id
    WHERE q.generation=? ORDER BY votes DESC,q.created_at ASC,q.id ASC`,
    )
    .all(visitor, event().generation)
    .map((raw) => ({
      id: raw.id as string,
      text: raw.text as string,
      createdAt: raw.createdAt as number,
      votes: raw.votes as number,
      voted: !!raw.voted,
      speakerAnswered: !!raw.speakerAnswered,
      hidden: !!raw.hidden,
      selected: raw.id === event().selected_id,
      reply: raw.replyText
        ? {
            text: raw.replyText as string,
            disposition: raw.disposition as string,
          }
        : null,
    }));
}
export function expireWork() {
  const stale = db
    .prepare("SELECT * FROM work WHERE status='active' AND expires<=?")
    .all(Date.now()) as WorkRow[];
  for (const w of stale) {
    db.prepare(
      "UPDATE work SET status='expired',calls_used=reservation WHERE id=?",
    ).run(w.id);
    db.prepare(
      "UPDATE event SET budget_used=budget_used+?,budget_reserved=MAX(0,budget_reserved-?) WHERE singleton=1 AND generation=?",
    ).run(w.reservation, w.reservation, w.generation);
    const ids: string[] = JSON.parse(w.question_ids);
    for (const id of ids)
      db.prepare("UPDATE questions SET next_try=? WHERE id=?").run(
        Date.now() + 3000,
        id,
      );
    if (w.kind === "recommendation")
      db.exec("UPDATE event SET recommendation_failed=1 WHERE singleton=1");
    activity(
      "retry",
      "Work lease expired; its full model reservation remains charged.",
      w.id,
    );
  }
}
