import { NextRequest, NextResponse } from "next/server";
import { randomBytes, randomUUID } from "node:crypto";
import {
  db,
  config,
  board,
  activity,
  expireWork,
  transaction,
  sessionById,
  sessionByGeneration,
  liveSession,
  defaultSession,
  worker,
  agentBlocked,
  type SessionRow,
  type WorkRow,
} from "./db";

class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public retryAfter?: number,
  ) {
    super(message);
  }
}
type Json = Record<string, unknown>;
const idPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function fail(status: number, code: string, message: string): never {
  throw new ApiError(status, code, message);
}
function object(value: unknown): Json {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail(400, "INVALID_BODY", "Expected a JSON object.");
  return value as Json;
}
function fields(value: Json, required: string[], optional: string[] = []) {
  if (
    required.some((k) => !(k in value)) ||
    Object.keys(value).some((k) => ![...required, ...optional].includes(k))
  )
    fail(400, "INVALID_FIELDS", "Missing or unsupported request fields.");
}
function identifier(value: unknown): string {
  if (typeof value !== "string" || !idPattern.test(value))
    fail(400, "INVALID_ID", "Invalid identifier.");
  return value;
}
function text(value: unknown, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    fail(400, "INVALID_TEXT", `Enter between 1 and ${max} characters.`);
  return value;
}
function boolean(value: unknown): boolean {
  if (typeof value !== "boolean")
    fail(400, "INVALID_VALUE", "Expected true or false.");
  return value;
}
function integer(value: unknown, max: number): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > max
  )
    fail(400, "INVALID_VALUE", "Invalid integer.");
  return value;
}
/** Resolves the session a request's generation belongs to. */
function generation(value: unknown): SessionRow {
  const id = identifier(value);
  const s = sessionByGeneration(id);
  if (!s)
    fail(
      409,
      "STALE_GENERATION",
      "This session was reset or no longer exists. Refresh before continuing.",
    );
  return s;
}
function current(id: string): SessionRow {
  return sessionById(id)!;
}
async function body(req: NextRequest, max = 8192): Promise<Json> {
  if (
    !(req.headers.get("content-type") || "")
      .toLowerCase()
      .startsWith("application/json")
  )
    fail(415, "JSON_REQUIRED", "Send application/json.");
  const reader = req.body?.getReader();
  let size = 0;
  const chunks: Uint8Array[] = [];
  if (reader) {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > max) {
        await reader.cancel();
        fail(
          413,
          "BODY_TOO_LARGE",
          `Request body exceeds ${Math.round(max / 1024)} KiB.`,
        );
      }
      chunks.push(value);
    }
  }
  try {
    return object(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  } catch (error) {
    if (error instanceof ApiError) throw error;
    fail(400, "INVALID_JSON", "Invalid JSON body.");
  }
}
function channel(req: NextRequest, expected: "public" | "host" | "agent") {
  const actual = req.headers.get("x-backstage-channel");
  if (actual !== expected && !(expected === "public" && actual === "host"))
    fail(
      403,
      "PRIVATE_ROUTE",
      "This operation is unavailable on this listener.",
    );
}
function origin(req: NextRequest, host = false) {
  const defaults = host
    ? ["http://127.0.0.1:3001", "http://localhost:3001"]
    : [
        config.audienceUrl,
        "http://127.0.0.1:3000",
        "http://localhost:3000",
        "http://127.0.0.1:3001",
        "http://localhost:3001",
      ];
  const extra = (process.env[host ? "HOST_ORIGINS" : "PUBLIC_ORIGINS"] || "")
    .split(",")
    .filter(Boolean);
  const allowed = new Set(
    [...defaults, ...extra].map((url) => {
      try {
        return new URL(url).origin;
      } catch {
        return "";
      }
    }),
  );
  if (!req.headers.get("origin") || !allowed.has(req.headers.get("origin")!))
    fail(403, "ORIGIN_DENIED", "This page origin cannot make that change.");
}
const globalLimits = globalThis as typeof globalThis & {
  backstageLimits?: Map<string, { count: number; expires: number }>;
};
const limits = (globalLimits.backstageLimits ??= new Map());
function limit(key: string, maximum: number) {
  const now = Date.now();
  if (limits.size > 9000)
    for (const [k, v] of limits) if (v.expires <= now) limits.delete(k);
  let entry = limits.get(key);
  if (!entry || entry.expires <= now) {
    if (!entry && limits.size >= 10000)
      throw new ApiError(
        429,
        "RATE_LIMIT",
        "The demo is busy. Try again shortly.",
        Math.ceil(config.windowMs / 1000),
      );
    entry = { count: 0, expires: now + config.windowMs };
    limits.set(key, entry);
  }
  if (entry.count >= maximum)
    throw new ApiError(
      429,
      "RATE_LIMIT",
      "Too many requests. Please wait a moment.",
      Math.max(1, Math.ceil((entry.expires - now) / 1000)),
    );
  entry.count++;
}
function visitor(
  req: NextRequest,
  mint: boolean,
): { id: string; fresh: boolean } {
  const cookie = req.cookies.get("backstage_visitor")?.value;
  if (
    cookie &&
    /^[a-f0-9]{64}$/.test(cookie) &&
    db
      .prepare("SELECT 1 FROM visitors WHERE id=? AND expires>?")
      .get(cookie, Date.now())
  )
    return { id: cookie, fresh: false };
  if (!mint)
    fail(
      428,
      "COOKIES_REQUIRED",
      "Enable cookies and refresh this page before participating.",
    );
  limit(`cookie:${req.headers.get("x-backstage-ip")}`, config.cookiesPerIp);
  db.prepare(
    "DELETE FROM visitors WHERE expires<=? AND id NOT IN (SELECT visitor_id FROM votes)",
  ).run(Date.now());
  const id = randomBytes(32).toString("hex");
  db.prepare("INSERT INTO visitors(id,expires) VALUES(?,?)").run(
    id,
    Date.now() + 6 * 3600000,
  );
  return { id, fresh: true };
}
function setVisitorCookie(req: NextRequest, res: NextResponse, id: string) {
  res.cookies.set("backstage_visitor", id, {
    httpOnly: true,
    sameSite: "lax",
    secure: req.headers.get("x-backstage-scheme") === "https",
    path: "/",
    maxAge: 6 * 3600,
  });
}
function publicWrite(req: NextRequest, kind: "question" | "vote") {
  channel(req, "public");
  origin(req);
  const who = visitor(req, false);
  limit(`write-global`, config.globalWrites);
  limit(`write-ip:${req.headers.get("x-backstage-ip")}`, config.writesPerIp);
  limit(
    `${kind}:${who.id}`,
    kind === "question" ? config.questionsPerMinute : config.votesPerMinute,
  );
  return who.id;
}
const workerStaleMs = 15000;
function workerState() {
  const w = worker();
  const stale = !w.heartbeat || Date.now() - w.heartbeat > workerStaleMs;
  return { ...w, stale };
}
function sessionInfo(s: SessionRow) {
  return { id: s.id, title: s.title, live: !!s.live, createdAt: s.created_at };
}
function snapshot(s: SessionRow, visitorId = "") {
  const questions = board(s, visitorId);
  const raw = db
    .prepare("SELECT * FROM recommendations WHERE generation=?")
    .get(s.generation);
  const w = workerState();
  return {
    session: sessionInfo(s),
    event: {
      generation: s.generation,
      pauseEpoch: s.pause_epoch,
      intakePaused: !!s.intake_paused,
      agentPaused: !!s.agent_paused,
      intakeExhausted: questions.length >= config.questionCap,
      selectedQuestionId: s.selected_id,
      audienceUrl: config.audienceUrl,
      questionCap: config.questionCap,
    },
    questions,
    agent: {
      status: w.stale
        ? "disconnected"
        : w.session_id !== s.id
          ? "elsewhere"
          : agentBlocked(s)
            ? "paused"
            : w.status,
      lastSeenAt: w.heartbeat,
    },
    recommendation: raw
      ? {
          ...JSON.parse(raw.data as string),
          revision: raw.revision,
          createdAt: raw.created_at,
          stale: raw.revision !== s.revision || !!s.recommendation_failed,
        }
      : null,
  };
}
function budget(s: SessionRow) {
  return {
    used: s.budget_used,
    reserved: s.budget_reserved,
    limit: config.modelBudget,
    closingReserve: s.closing_consumed
      ? 0
      : Math.min(config.closingReserve, config.modelBudget),
  };
}
function getWork(value: unknown, s: SessionRow): WorkRow {
  const id = identifier(value);
  const work = db
    .prepare("SELECT * FROM work WHERE id=? AND generation=?")
    .get(id, s.generation) as WorkRow | undefined;
  if (!work) fail(404, "WORK_NOT_FOUND", "Work item not found.");
  return work;
}
function workPayload(w: WorkRow) {
  return {
    id: w.id,
    generation: w.generation,
    pauseEpoch: w.pause_epoch,
    kind: w.kind,
    questionIds: JSON.parse(w.question_ids),
    questions: JSON.parse(w.snapshot),
    revision: w.revision,
    leaseExpiresAt: w.expires,
    maxCalls: w.reservation,
    closing: !!w.closing,
  };
}
function reconcile(
  w: WorkRow,
  calls: number,
  status: string,
  resultId: string | null = null,
) {
  db.prepare(
    "UPDATE work SET status=?,calls_used=?,result_id=? WHERE id=?",
  ).run(status, calls, resultId, w.id);
  db.prepare(
    "UPDATE sessions SET budget_reserved=MAX(0,budget_reserved-?),budget_used=budget_used+? WHERE generation=?",
  ).run(w.reservation, calls, w.generation);
}
function active(w: WorkRow, s: SessionRow) {
  if (w.status !== "active")
    fail(409, "WORK_FINISHED", "This work item has finished.");
  if (w.expires <= Date.now())
    fail(409, "LEASE_EXPIRED", "This work lease expired.");
  if (agentBlocked(s) || w.pause_epoch !== s.pause_epoch)
    fail(
      409,
      "WORK_CANCELLED",
      "Agent processing was paused. Discard this result.",
    );
}
function question(value: unknown, s: SessionRow) {
  const id = identifier(value);
  if (
    !db
      .prepare("SELECT 1 FROM questions WHERE id=? AND generation=?")
      .get(id, s.generation)
  )
    fail(404, "QUESTION_NOT_FOUND", "Question not found.");
  return id;
}
function requireLive(): SessionRow {
  const s = liveSession();
  if (!s)
    fail(409, "NO_LIVE_SESSION", "There is no live session right now.");
  return s;
}
function bump(s: SessionRow) {
  db.prepare("UPDATE sessions SET revision=revision+1 WHERE id=?").run(s.id);
}
function sessionList() {
  return db
    .prepare(
      `SELECT s.id,s.title,s.live,s.created_at AS createdAt,
        (SELECT COUNT(*) FROM questions q WHERE q.generation=s.generation) AS questionCount
       FROM sessions s ORDER BY s.created_at DESC, s.rowid DESC`,
    )
    .all()
    .map((raw) => ({
      id: raw.id as string,
      title: raw.title as string,
      live: !!raw.live,
      createdAt: raw.createdAt as number,
      questionCount: raw.questionCount as number,
    }));
}
const TITLE_MAX = 120;
const TALKING_POINTS_MAX = 50_000;
function talkingPoints(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value !== "string" || value.length > TALKING_POINTS_MAX)
    fail(
      400,
      "INVALID_TEXT",
      `Talking points must be at most ${TALKING_POINTS_MAX.toLocaleString("en-US")} characters.`,
    );
  return value;
}
/** Makes one session live (pausing any other) or pauses it. */
function setLive(s: SessionRow, value: boolean) {
  if (value) {
    const previous = liveSession();
    if (previous && previous.id !== s.id) {
      db.prepare(
        "UPDATE sessions SET live=0,pause_epoch=pause_epoch+1 WHERE id=?",
      ).run(previous.id);
      activity(previous.generation, "pause", "Session paused; another session went live.");
    }
    if (!s.live) {
      db.prepare("UPDATE sessions SET live=1 WHERE id=?").run(s.id);
      activity(s.generation, "resume", "Session is live.");
    }
    return previous && previous.id !== s.id ? previous : undefined;
  }
  if (s.live) {
    db.prepare(
      "UPDATE sessions SET live=0,pause_epoch=pause_epoch+1 WHERE id=?",
    ).run(s.id);
    activity(s.generation, "pause", "Session paused.");
  }
}

export async function handle(
  req: NextRequest,
  operation: string,
): Promise<NextResponse> {
  try {
    let response: unknown;
    if (operation === "health") {
      channel(req, "public");
      db.prepare("SELECT 1").get();
      return NextResponse.json({ ok: true });
    }
    if (operation === "broadcast") {
      channel(req, "public");
      const who = visitor(req, true);
      limit(`read:${who.id}`, config.readsPerMinute);
      const live = liveSession();
      const state = live ? snapshot(live) : null;
      const res = NextResponse.json({
        session: state?.session ?? null,
        event: {
          generation: state?.event.generation ?? null,
          audienceUrl: config.audienceUrl,
        },
        question:
          state?.questions.find((q) => q.selected && !q.hidden) ?? null,
      });
      if (who.fresh) setVisitorCookie(req, res, who.id);
      return res;
    }
    if (operation === "state") {
      channel(req, "public");
      const who = visitor(req, true);
      limit(`read:${who.id}`, config.readsPerMinute);
      const live = liveSession();
      const res = NextResponse.json(
        live
          ? { ...snapshot(live, who.id), recommendation: null }
          : {
              session: null,
              event: null,
              questions: [],
              agent: null,
              recommendation: null,
            },
      );
      if (who.fresh) setVisitorCookie(req, res, who.id);
      return res;
    }
    if (operation === "questions") {
      publicWrite(req, "question");
      const data = await body(req);
      fields(data, ["text"]);
      const value = text(data.text, 1000);
      response = transaction(() => {
        const s = requireLive();
        if (s.intake_paused)
          fail(
            409,
            "INTAKE_PAUSED",
            "New questions are paused. You can still vote.",
          );
        if (
          (db
            .prepare("SELECT COUNT(*) AS n FROM questions WHERE generation=?")
            .get(s.generation)!.n as number) >= config.questionCap
        )
          fail(
            409,
            "INTAKE_FULL",
            "This session has reached its question limit. You can still vote.",
          );
        const id = randomUUID();
        db.prepare(
          "INSERT INTO questions(id,generation,text,created_at) VALUES(?,?,?,?)",
        ).run(id, s.generation, value, Date.now());
        bump(s);
        return { questionId: id, generation: s.generation };
      });
    } else if (operation === "votes") {
      const who = publicWrite(req, "vote");
      const data = await body(req);
      fields(data, ["questionId", "voted"]);
      const voted = boolean(data.voted);
      response = transaction(() => {
        const s = requireLive();
        const id = question(data.questionId, s);
        const change = voted
          ? db
              .prepare(
                "INSERT OR IGNORE INTO votes(visitor_id,question_id) VALUES(?,?)",
              )
              .run(who, id)
          : db
              .prepare("DELETE FROM votes WHERE visitor_id=? AND question_id=?")
              .run(who, id);
        if (change.changes) bump(s);
        return {
          ok: true,
          voted,
          votes: db
            .prepare("SELECT COUNT(*) AS n FROM votes WHERE question_id=?")
            .get(id)!.n,
        };
      });
    } else if (operation === "host-state") {
      channel(req, "host");
      const requested = req.nextUrl.searchParams.get("session");
      const s = requested
        ? (sessionById(identifier(requested)) ??
          fail(404, "SESSION_NOT_FOUND", "That session no longer exists."))
        : defaultSession();
      const state = snapshot(s);
      const w = workerState();
      response = {
        ...state,
        session: { ...sessionInfo(s), talkingPoints: s.talking_points },
        sessions: sessionList(),
        revision: s.revision,
        budget: budget(s),
        worker: {
          status: w.status,
          lastSeenAt: w.heartbeat,
          stale: w.stale,
          sessionId: w.session_id,
        },
        activity: db
          .prepare(
            "SELECT id,at,kind,message,work_id AS workId,question_id AS questionId FROM activity WHERE generation=? ORDER BY id DESC LIMIT 100",
          )
          .all(s.generation),
      };
    } else if (operation === "host-control") {
      channel(req, "host");
      origin(req, true);
      const data = await body(req, 256 * 1024);
      response = transaction(() => {
        const action = data.action;
        if (action === "create-session") {
          fields(data, ["action", "title"], ["talkingPoints"]);
          const id = randomUUID();
          const newGeneration = randomUUID();
          db.prepare(
            "INSERT INTO sessions(id,generation,title,talking_points,created_at) VALUES(?,?,?,?,?)",
          ).run(
            id,
            newGeneration,
            text(data.title, TITLE_MAX).trim(),
            talkingPoints(data.talkingPoints),
            Date.now(),
          );
          activity(newGeneration, "session", "Session created.");
          return { ok: true, sessionId: id, generation: newGeneration };
        }
        const s = generation(data.generation);
        if (action === "update-session") {
          fields(data, ["generation", "action"], ["title", "talkingPoints"]);
          if (data.title !== undefined)
            db.prepare("UPDATE sessions SET title=? WHERE id=?").run(
              text(data.title, TITLE_MAX).trim(),
              s.id,
            );
          if (data.talkingPoints !== undefined)
            db.prepare("UPDATE sessions SET talking_points=? WHERE id=?").run(
              talkingPoints(data.talkingPoints),
              s.id,
            );
          activity(s.generation, "session", "Session details updated.");
        } else if (action === "live") {
          fields(data, ["generation", "action", "value"]);
          const paused = setLive(s, boolean(data.value));
          return {
            ok: true,
            generation: s.generation,
            paused: paused ? sessionInfo(paused) : null,
          };
        } else if (action === "reset") {
          fields(data, ["generation", "action", "confirmation"]);
          if (data.confirmation !== "RESET")
            fail(
              400,
              "CONFIRMATION_REQUIRED",
              "Type RESET to clear this session.",
            );
          const newGeneration = randomUUID();
          db.prepare("DELETE FROM questions WHERE generation=?").run(
            s.generation,
          );
          for (const table of ["work", "recommendations", "activity"])
            db.prepare(`DELETE FROM ${table} WHERE generation=?`).run(
              s.generation,
            );
          db.prepare(
            `UPDATE sessions SET generation=?,revision=0,pause_epoch=pause_epoch+1,intake_paused=0,agent_paused=0,
              selected_id=NULL,closing_requested=0,closing_consumed=0,budget_used=0,budget_reserved=0,
              recommendation_failed=0,last_recommendation_attempt=0 WHERE id=?`,
          ).run(newGeneration, s.id);
          activity(newGeneration, "reset", "Session questions were cleared.");
          return { ok: true, generation: newGeneration };
        } else if (action === "intake" || action === "agent") {
          fields(data, ["generation", "action", "value"]);
          const value = boolean(data.value);
          if (action === "intake")
            db.prepare("UPDATE sessions SET intake_paused=? WHERE id=?").run(
              Number(value),
              s.id,
            );
          else
            db.prepare(
              "UPDATE sessions SET agent_paused=?,pause_epoch=pause_epoch+1 WHERE id=? AND agent_paused<>?",
            ).run(Number(value), s.id, Number(value));
          activity(
            s.generation,
            value ? "pause" : "resume",
            `${action === "agent" ? "Agent processing" : "Question intake"} ${value ? "paused" : "resumed"}.`,
          );
        } else if (action === "select") {
          fields(data, ["generation", "action", "questionId"]);
          const id =
            data.questionId === null ? null : question(data.questionId, s);
          if (
            id &&
            db.prepare("SELECT hidden FROM questions WHERE id=?").get(id)
              ?.hidden
          )
            fail(
              409,
              "QUESTION_HIDDEN",
              "Unhide this question before broadcasting it.",
            );
          db.prepare("UPDATE sessions SET selected_id=? WHERE id=?").run(
            id,
            s.id,
          );
          activity(
            s.generation,
            "broadcast",
            id
              ? "Host selected a question for broadcast."
              : "Host cleared the broadcast.",
            undefined,
            id ?? undefined,
          );
        } else if (action === "answered" || action === "hide") {
          fields(data, ["generation", "action", "questionId", "value"]);
          const id = question(data.questionId, s);
          const value = boolean(data.value);
          const column = action === "answered" ? "speaker_answered" : "hidden";
          const change = db
            .prepare(
              `UPDATE questions SET ${column}=? WHERE id=? AND ${column}<>?`,
            )
            .run(Number(value), id, Number(value));
          if (action === "answered" && change.changes) bump(s);
          if (action === "hide" && value)
            db.prepare(
              "UPDATE sessions SET selected_id=NULL WHERE id=? AND selected_id=?",
            ).run(s.id, id);
          activity(
            s.generation,
            action,
            action === "answered"
              ? "Host updated speaker-answer status."
              : "Host updated broadcast visibility.",
            undefined,
            id,
          );
        } else if (action === "closing") {
          fields(data, ["generation", "action"]);
          db.prepare("UPDATE sessions SET closing_requested=1 WHERE id=?").run(
            s.id,
          );
          activity(
            s.generation,
            "closing",
            "Host requested a recommended question order.",
          );
        } else fail(400, "UNKNOWN_ACTION", "Unknown host action.");
        return { ok: true, generation: current(s.id).generation };
      });
    } else {
      channel(req, "agent");
      if (operation === "agent-state") {
        transaction(expireWork);
        // An agent may be pointed at a session; otherwise it follows the live one.
        const requested = req.nextUrl.searchParams.get("session");
        const s = requested
          ? (sessionById(identifier(requested)) ??
            fail(404, "SESSION_NOT_FOUND", "That session no longer exists."))
          : defaultSession();
        response = {
          sessionId: s.id,
          sessionTitle: s.title,
          live: !!s.live,
          generation: s.generation,
          pauseEpoch: s.pause_epoch,
          agentPaused: agentBlocked(s),
          status: worker().status,
          revision: s.revision,
          closingRequested: !!s.closing_requested,
          budget: budget(s),
          questions: board(s),
          serverTime: Date.now(),
        };
      } else {
        const data = await body(req);
        response = transaction(() => {
          expireWork();
          const s = generation(data.generation);
          if (operation === "agent-heartbeat") {
            fields(data, ["generation", "status"]);
            const statuses = [
              "idle",
              "processing",
              "paused",
              "retrying",
              "over-budget",
              "disconnected",
            ];
            if (!statuses.includes(data.status as string))
              fail(400, "INVALID_STATUS", "Unknown worker status.");
            db.prepare(
              "UPDATE worker SET status=?,heartbeat=?,session_id=? WHERE singleton=1",
            ).run(data.status as string, Date.now(), s.id);
            return {
              ok: true,
              generation: s.generation,
              agentPaused: agentBlocked(s),
              pauseEpoch: s.pause_epoch,
            };
          }
          if (operation === "agent-claim") {
            fields(data, ["generation"]);
            const e = s;
            if (agentBlocked(e)) return { work: null, reason: "paused" };
            // One agent instance: at most one active work item across sessions.
            const existing = db
              .prepare(
                "SELECT * FROM work WHERE status='active' ORDER BY rowid LIMIT 1",
              )
              .get() as WorkRow | undefined;
            if (existing) return { work: null, reason: "busy" };
            const questions = board(e);
            const eligible = questions.filter((q) => !q.speakerAnswered);
            const pending = db
              .prepare(
                `SELECT q.id FROM questions q LEFT JOIN replies r ON r.question_id=q.id WHERE q.generation=? AND r.question_id IS NULL AND q.attempts<3 AND q.next_try<=? AND q.speaker_answered=0 ORDER BY q.created_at LIMIT 5`,
              )
              .all(e.generation, Date.now())
              .map((q) => q.id as string);
            const rec = db
              .prepare("SELECT revision FROM recommendations WHERE generation=?")
              .get(e.generation);
            const recommendationAttempts = db
              .prepare(
                "SELECT COUNT(*) AS n FROM work WHERE kind='recommendation' AND revision=? AND generation=? AND closing=0",
              )
              .get(e.revision, e.generation)!.n as number;
            const dirty =
              eligible.length > 0 &&
              recommendationAttempts < 3 &&
              (!rec ||
                rec.revision !== e.revision ||
                !!e.recommendation_failed);
            const closing = !!e.closing_requested;
            const kind = closing
              ? "recommendation"
              : pending.length
                ? "answers"
                : dirty && Date.now() - e.last_recommendation_attempt >= 60000
                  ? "recommendation"
                  : null;
            if (!kind) return { work: null, reason: "idle" };
            if (closing && !eligible.length) {
              db.prepare(
                "UPDATE sessions SET closing_requested=0 WHERE id=?",
              ).run(e.id);
              return { work: null, reason: "idle" };
            }
            const reserve = e.closing_consumed
              ? 0
              : Math.min(config.closingReserve, config.modelBudget);
            const ceiling = config.modelBudget - (closing ? 0 : reserve);
            if (e.budget_used + e.budget_reserved + config.runCalls > ceiling) {
              const previous = worker().status;
              db.exec(
                "UPDATE worker SET status='over-budget' WHERE singleton=1",
              );
              if (previous !== "over-budget")
                activity(
                  e.generation,
                  "budget-exhaustion",
                  "Model budget is exhausted; audience and host controls remain available.",
                );
              return { work: null, reason: "over-budget" };
            }
            const id = randomUUID();
            const ids = kind === "answers" ? pending : [];
            const now = Date.now();
            db.prepare(
              "INSERT INTO work(id,generation,pause_epoch,kind,question_ids,snapshot,revision,expires,closing,reservation) VALUES(?,?,?,?,?,?,?,?,?,?)",
            ).run(
              id,
              e.generation,
              e.pause_epoch,
              kind,
              JSON.stringify(ids),
              JSON.stringify(questions),
              e.revision,
              now + config.leaseMs,
              Number(closing),
              config.runCalls,
            );
            db.prepare(
              "UPDATE sessions SET budget_reserved=budget_reserved+?,closing_requested=CASE WHEN ? THEN 0 ELSE closing_requested END,closing_consumed=CASE WHEN ? THEN 1 ELSE closing_consumed END WHERE id=?",
            ).run(config.runCalls, Number(closing), Number(closing), e.id);
            db.exec("UPDATE worker SET status='processing' WHERE singleton=1");
            if (kind === "recommendation")
              db.prepare(
                "UPDATE sessions SET last_recommendation_attempt=? WHERE id=?",
              ).run(now, e.id);
            for (const q of ids)
              db.prepare(
                "UPDATE questions SET attempts=attempts+1 WHERE id=?",
              ).run(q);
            activity(
              e.generation,
              "work-claimed",
              `${kind === "answers" ? `${ids.length} question(s)` : "Q&A recommendation"} claimed.`,
              id,
            );
            return { work: workPayload(getWork(id, e)) };
          }
          if (operation === "agent-result") {
            fields(
              data,
              ["generation", "workId", "resultId", "callsUsed"],
              ["replies", "recommendation"],
            );
            const w = getWork(data.workId, s);
            const resultId = identifier(data.resultId);
            const calls = integer(data.callsUsed, w.reservation);
            if (w.status === "done" && w.result_id === resultId)
              return { ok: true, duplicate: true };
            active(w, s);
            if (resultId !== w.id)
              fail(
                400,
                "INVALID_RESULT_ID",
                "Use the work identifier as the stable result identifier.",
              );
            if (w.kind === "answers") {
              if (
                data.recommendation !== undefined ||
                !Array.isArray(data.replies)
              )
                fail(400, "INVALID_RESULT", "Expected question replies only.");
              const ids: string[] = JSON.parse(w.question_ids);
              const seen = new Set<string>();
              const replies = data.replies.map((raw) => {
                const reply = object(raw);
                fields(reply, ["questionId", "text", "disposition"]);
                const id = identifier(reply.questionId);
                if (!ids.includes(id) || seen.has(id))
                  fail(
                    400,
                    "INVALID_RESULT",
                    "Reply identifiers must match claimed questions exactly.",
                  );
                seen.add(id);
                if (
                  !["answered", "leave-for-speaker"].includes(
                    reply.disposition as string,
                  )
                )
                  fail(400, "INVALID_RESULT", "Invalid reply disposition.");
                return {
                  id,
                  text: text(reply.text, 1200),
                  disposition: reply.disposition as string,
                };
              });
              if (seen.size !== ids.length)
                fail(
                  400,
                  "INVALID_RESULT",
                  "Return one reply for every claimed question.",
                );
              for (const r of replies) {
                db.prepare(
                  "INSERT INTO replies(question_id,text,disposition,result_id) VALUES(?,?,?,?)",
                ).run(r.id, r.text, r.disposition, resultId);
                activity(
                  s.generation,
                  "reply-published",
                  "Backstage reply published.",
                  w.id,
                  r.id,
                );
              }
            } else {
              if (data.replies !== undefined)
                fail(400, "INVALID_RESULT", "Expected a recommendation only.");
              const rec = object(data.recommendation);
              fields(rec, ["revision", "groups", "queue"]);
              if (
                rec.revision !== w.revision ||
                rec.revision !== s.revision
              )
                fail(
                  409,
                  "STALE_RECOMMENDATION",
                  "Questions, votes, or speaker status changed. Discard this recommendation.",
                );
              if (
                !Array.isArray(rec.groups) ||
                rec.groups.length > 8 ||
                !Array.isArray(rec.queue) ||
                rec.queue.length > 8
              )
                fail(
                  400,
                  "INVALID_RESULT",
                  "Recommend at most eight groups and queue entries.",
                );
              const eligible = new Set(
                board(s)
                  .filter((q) => !q.speakerAnswered)
                  .map((q) => q.id),
              );
              const queued = new Set<string>();
              const grouped = new Set<string>();
              const groups = rec.groups.map((raw) => {
                const group = object(raw);
                fields(group, ["title", "questionIds"]);
                if (
                  !Array.isArray(group.questionIds) ||
                  group.questionIds.length < 2 ||
                  group.questionIds.length > 20
                )
                  fail(
                    400,
                    "INVALID_RESULT",
                    "Each group needs 2–20 questions.",
                  );
                return {
                  title: text(group.title, 100),
                  questionIds: group.questionIds.map((value) => {
                    const id = identifier(value);
                    if (!eligible.has(id) || grouped.has(id))
                      fail(
                        400,
                        "INVALID_RESULT",
                        "Invalid or duplicate group member.",
                      );
                    grouped.add(id);
                    return id;
                  }),
                };
              });
              const queue = rec.queue.map((raw) => {
                const item = object(raw);
                fields(item, ["questionId", "reason"]);
                const id = identifier(item.questionId);
                if (!eligible.has(id) || queued.has(id))
                  fail(
                    400,
                    "INVALID_RESULT",
                    "Invalid or duplicate queue member.",
                  );
                queued.add(id);
                return { questionId: id, reason: text(item.reason, 240) };
              });
              db.prepare(
                "INSERT OR REPLACE INTO recommendations(generation,revision,created_at,data) VALUES(?,?,?,?)",
              ).run(
                w.generation,
                w.revision,
                Date.now(),
                JSON.stringify({ groups, queue }),
              );
              db.prepare(
                "UPDATE sessions SET recommendation_failed=0 WHERE id=?",
              ).run(s.id);
              activity(
                s.generation,
                "queue-updated",
                "Backstage recommendation updated; votes and host choices remain unchanged.",
                w.id,
              );
            }
            reconcile(w, calls, "done", resultId);
            return { ok: true, duplicate: false };
          }
          if (operation === "agent-ack") {
            fields(data, ["generation", "workId"]);
            const w = getWork(data.workId, s);
            if (w.status !== "done")
              fail(
                409,
                "RESULT_REQUIRED",
                "Publish the result before acknowledging work.",
              );
            db.prepare("UPDATE work SET acknowledged=1 WHERE id=?").run(w.id);
            return { ok: true };
          }
          if (operation === "agent-fail") {
            fields(data, ["generation", "workId", "callsUsed", "reason"]);
            const w = getWork(data.workId, s);
            const calls = integer(data.callsUsed, w.reservation);
            if (
              !["timeout", "error", "cancelled"].includes(data.reason as string)
            )
              fail(400, "INVALID_REASON", "Unknown failure reason.");
            if (w.status !== "active") return { ok: true };
            reconcile(w, calls, "failed");
            if (w.kind === "recommendation")
              db.prepare(
                "UPDATE sessions SET recommendation_failed=1 WHERE id=?",
              ).run(s.id);
            for (const id of JSON.parse(w.question_ids))
              db.prepare("UPDATE questions SET next_try=? WHERE id=?").run(
                Date.now() + 3000,
                id,
              );
            activity(
              s.generation,
              data.reason === "timeout" ? "timeout" : "retry",
              data.reason === "cancelled"
                ? "Late work discarded after pause or reset."
                : "Agent work failed; bounded retry is available.",
              w.id,
            );
            return { ok: true };
          }
          if (operation === "agent-activity") {
            fields(
              data,
              ["generation", "kind"],
              ["workId", "questionId", "message"],
            );
            const summaries: Record<string, string> = {
              "notes-read": "Agent read the presentation notes.",
              "tool-success": "Agent tool completed successfully.",
              "tool-error": "Agent tool returned an error.",
              retry: "Agent is retrying an operation.",
              timeout: "Agent run reached its deadline.",
            };
            if (typeof data.kind !== "string" || !summaries[data.kind])
              fail(400, "INVALID_KIND", "Unknown activity kind.");
            const workId =
              data.workId === undefined ? undefined : getWork(data.workId, s).id;
            const questionId =
              data.questionId === undefined
                ? undefined
                : question(data.questionId, s);
            if (data.message !== undefined) text(data.message, 240);
            // Fixed summaries deliberately exclude arbitrary tool output, prompts, or credentials.
            activity(s.generation, data.kind, summaries[data.kind], workId, questionId);
            return { ok: true };
          }
          fail(404, "NOT_FOUND", "Unknown operation.");
        });
      }
    }
    return NextResponse.json(response);
  } catch (error) {
    if (error instanceof ApiError)
      return NextResponse.json(
        { error: { code: error.code, message: error.message } },
        {
          status: error.status,
          headers: error.retryAfter
            ? { "Retry-After": String(error.retryAfter) }
            : undefined,
        },
      );
    console.error(
      "Backstage request failed:",
      error instanceof Error ? error.message : "unknown error",
    );
    return NextResponse.json(
      {
        error: {
          code: "INTERNAL_ERROR",
          message: "The service could not complete this request.",
        },
      },
      { status: 500 },
    );
  }
}
