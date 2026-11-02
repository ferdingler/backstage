import { NextRequest, NextResponse } from "next/server";
import { randomBytes, randomUUID } from "node:crypto";
import {
  db,
  config,
  event,
  board,
  activity,
  expireWork,
  transaction,
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
function generation(value: unknown) {
  const id = identifier(value);
  if (id !== event().generation)
    fail(
      409,
      "STALE_GENERATION",
      "The event was reset. Refresh before continuing.",
    );
  return id;
}
async function body(req: NextRequest): Promise<Json> {
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
      if (size > 8192) {
        await reader.cancel();
        fail(413, "BODY_TOO_LARGE", "Request body exceeds 8 KiB.");
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
function snapshot(visitorId = "") {
  const e = event();
  const questions = board(visitorId);
  const raw = db
    .prepare("SELECT * FROM recommendations WHERE singleton=1 AND generation=?")
    .get(e.generation);
  const stale = !e.heartbeat || Date.now() - e.heartbeat > 15000;
  return {
    event: {
      generation: e.generation,
      pauseEpoch: e.pause_epoch,
      intakePaused: !!e.intake_paused,
      agentPaused: !!e.agent_paused,
      intakeExhausted: questions.length >= config.questionCap,
      selectedQuestionId: e.selected_id,
      audienceUrl: config.audienceUrl,
      questionCap: config.questionCap,
    },
    questions,
    agent: {
      status: stale
        ? "disconnected"
        : e.agent_paused
          ? "paused"
          : e.worker_status,
      lastSeenAt: e.heartbeat,
    },
    recommendation: raw
      ? {
          ...JSON.parse(raw.data as string),
          revision: raw.revision,
          createdAt: raw.created_at,
          stale: raw.revision !== e.revision || !!e.recommendation_failed,
        }
      : null,
  };
}
function budget() {
  const e = event();
  return {
    used: e.budget_used,
    reserved: e.budget_reserved,
    limit: config.modelBudget,
    closingReserve: e.closing_consumed
      ? 0
      : Math.min(config.closingReserve, config.modelBudget),
  };
}
function getWork(value: unknown): WorkRow {
  const id = identifier(value);
  const work = db
    .prepare("SELECT * FROM work WHERE id=? AND generation=?")
    .get(id, event().generation) as WorkRow | undefined;
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
    "UPDATE event SET budget_reserved=MAX(0,budget_reserved-?),budget_used=budget_used+? WHERE singleton=1",
  ).run(w.reservation, calls);
}
function active(w: WorkRow) {
  const e = event();
  if (w.status !== "active")
    fail(409, "WORK_FINISHED", "This work item has finished.");
  if (w.expires <= Date.now())
    fail(409, "LEASE_EXPIRED", "This work lease expired.");
  if (e.agent_paused || w.pause_epoch !== e.pause_epoch)
    fail(
      409,
      "WORK_CANCELLED",
      "Agent processing was paused. Discard this result.",
    );
}
function question(value: unknown) {
  const id = identifier(value);
  if (
    !db
      .prepare("SELECT 1 FROM questions WHERE id=? AND generation=?")
      .get(id, event().generation)
  )
    fail(404, "QUESTION_NOT_FOUND", "Question not found.");
  return id;
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
      const state = snapshot();
      const res = NextResponse.json({
        event: {
          generation: state.event.generation,
          audienceUrl: state.event.audienceUrl,
        },
        question: state.questions.find((q) => q.selected && !q.hidden) ?? null,
      });
      if (who.fresh)
        res.cookies.set("backstage_visitor", who.id, {
          httpOnly: true,
          sameSite: "lax",
          secure: req.headers.get("x-backstage-scheme") === "https",
          path: "/",
          maxAge: 6 * 3600,
        });
      return res;
    }
    if (operation === "state") {
      channel(req, "public");
      const who = visitor(req, true);
      limit(`read:${who.id}`, config.readsPerMinute);
      const publicState = snapshot(who.id);
      const res = NextResponse.json({ ...publicState, recommendation: null });
      if (who.fresh)
        res.cookies.set("backstage_visitor", who.id, {
          httpOnly: true,
          sameSite: "lax",
          secure: req.headers.get("x-backstage-scheme") === "https",
          path: "/",
          maxAge: 6 * 3600,
        });
      return res;
    }
    if (operation === "questions") {
      publicWrite(req, "question");
      const data = await body(req);
      fields(data, ["text"]);
      const value = text(data.text, 1000);
      response = transaction(() => {
        const e = event();
        if (e.intake_paused)
          fail(
            409,
            "INTAKE_PAUSED",
            "New questions are paused. You can still vote.",
          );
        if (
          (db.prepare("SELECT COUNT(*) AS n FROM questions").get()!
            .n as number) >= config.questionCap
        )
          fail(
            409,
            "INTAKE_FULL",
            "This event has reached its question limit. You can still vote.",
          );
        const id = randomUUID();
        db.prepare(
          "INSERT INTO questions(id,generation,text,created_at) VALUES(?,?,?,?)",
        ).run(id, e.generation, value, Date.now());
        db.exec("UPDATE event SET revision=revision+1 WHERE singleton=1");
        return { questionId: id, generation: e.generation };
      });
    } else if (operation === "votes") {
      const who = publicWrite(req, "vote");
      const data = await body(req);
      fields(data, ["questionId", "voted"]);
      const voted = boolean(data.voted);
      response = transaction(() => {
        const id = question(data.questionId);
        const change = voted
          ? db
              .prepare(
                "INSERT OR IGNORE INTO votes(visitor_id,question_id) VALUES(?,?)",
              )
              .run(who, id)
          : db
              .prepare("DELETE FROM votes WHERE visitor_id=? AND question_id=?")
              .run(who, id);
        if (change.changes)
          db.exec("UPDATE event SET revision=revision+1 WHERE singleton=1");
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
      const e = event();
      const state = snapshot();
      response = {
        ...state,
        revision: e.revision,
        budget: budget(),
        worker: {
          status: state.agent.status,
          lastSeenAt: e.heartbeat,
          stale: !e.heartbeat || Date.now() - e.heartbeat > 15000,
        },
        activity: db
          .prepare(
            "SELECT id,at,kind,message,work_id AS workId,question_id AS questionId FROM activity ORDER BY id DESC LIMIT 100",
          )
          .all(),
        boxLog: {
          status: "local-terminal",
          message:
            "Box decisions are available only in the separate local terminal. No live log source is attached here.",
        },
      };
    } else if (operation === "host-control") {
      channel(req, "host");
      origin(req, true);
      const data = await body(req);
      response = transaction(() => {
        generation(data.generation);
        const action = data.action;
        if (action === "reset") {
          fields(data, ["generation", "action", "confirmation"]);
          if (data.confirmation !== "RESET")
            fail(
              400,
              "CONFIRMATION_REQUIRED",
              "Type RESET to clear the event.",
            );
          const newGeneration = randomUUID();
          db.exec(
            "DELETE FROM votes; DELETE FROM replies; DELETE FROM questions; DELETE FROM work; DELETE FROM recommendations; DELETE FROM activity; DELETE FROM visitors; DELETE FROM event;",
          );
          db.prepare("INSERT INTO event(singleton,generation) VALUES(1,?)").run(
            newGeneration,
          );
          activity("reset", "A fresh event generation was created.");
          return { ok: true, generation: newGeneration };
        }
        if (action === "intake" || action === "agent") {
          fields(data, ["generation", "action", "value"]);
          const value = boolean(data.value);
          if (action === "intake")
            db.prepare(
              "UPDATE event SET intake_paused=? WHERE singleton=1",
            ).run(Number(value));
          else
            db.prepare(
              "UPDATE event SET agent_paused=?,pause_epoch=pause_epoch+1 WHERE singleton=1 AND agent_paused<>?",
            ).run(Number(value), Number(value));
          activity(
            value ? "pause" : "resume",
            `${action === "agent" ? "Agent processing" : "Question intake"} ${value ? "paused" : "resumed"}.`,
          );
        } else if (action === "select") {
          fields(data, ["generation", "action", "questionId"]);
          const id =
            data.questionId === null ? null : question(data.questionId);
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
          db.prepare("UPDATE event SET selected_id=? WHERE singleton=1").run(
            id,
          );
          activity(
            "broadcast",
            id
              ? "Host selected a question for broadcast."
              : "Host cleared the broadcast.",
            undefined,
            id ?? undefined,
          );
        } else if (action === "answered" || action === "hide") {
          fields(data, ["generation", "action", "questionId", "value"]);
          const id = question(data.questionId);
          const value = boolean(data.value);
          const column = action === "answered" ? "speaker_answered" : "hidden";
          const change = db
            .prepare(
              `UPDATE questions SET ${column}=? WHERE id=? AND ${column}<>?`,
            )
            .run(Number(value), id, Number(value));
          if (action === "answered" && change.changes)
            db.exec("UPDATE event SET revision=revision+1 WHERE singleton=1");
          if (action === "hide" && value)
            db.prepare(
              "UPDATE event SET selected_id=NULL WHERE selected_id=?",
            ).run(id);
          activity(
            action,
            action === "answered"
              ? "Host updated speaker-answer status."
              : "Host updated broadcast visibility.",
            undefined,
            id,
          );
        } else if (action === "closing") {
          fields(data, ["generation", "action"]);
          db.exec("UPDATE event SET closing_requested=1 WHERE singleton=1");
          activity("closing", "Host requested a closing Q&A recommendation.");
        } else fail(400, "UNKNOWN_ACTION", "Unknown host action.");
        return { ok: true, generation: event().generation };
      });
    } else {
      channel(req, "agent");
      if (operation === "agent-state") {
        transaction(expireWork);
        const e = event();
        response = {
          generation: e.generation,
          pauseEpoch: e.pause_epoch,
          agentPaused: !!e.agent_paused,
          status: e.worker_status,
          revision: e.revision,
          closingRequested: !!e.closing_requested,
          budget: budget(),
          questions: board(),
          serverTime: Date.now(),
        };
      } else {
        const data = await body(req);
        response = transaction(() => {
          generation(data.generation);
          expireWork();
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
              "UPDATE event SET worker_status=?,heartbeat=? WHERE singleton=1",
            ).run(data.status as string, Date.now());
            const e = event();
            return {
              ok: true,
              generation: e.generation,
              agentPaused: !!e.agent_paused,
              pauseEpoch: e.pause_epoch,
            };
          }
          if (operation === "agent-claim") {
            fields(data, ["generation"]);
            const e = event();
            if (e.agent_paused) return { work: null, reason: "paused" };
            const existing = db
              .prepare(
                "SELECT * FROM work WHERE generation=? AND status='active' ORDER BY rowid LIMIT 1",
              )
              .get(e.generation) as WorkRow | undefined;
            if (existing) return { work: null, reason: "busy" };
            const questions = board();
            const eligible = questions.filter((q) => !q.speakerAnswered);
            const pending = db
              .prepare(
                `SELECT q.id FROM questions q LEFT JOIN replies r ON r.question_id=q.id WHERE r.question_id IS NULL AND q.attempts<3 AND q.next_try<=? AND q.speaker_answered=0 ORDER BY q.created_at LIMIT 5`,
              )
              .all(Date.now())
              .map((q) => q.id as string);
            const rec = db
              .prepare("SELECT revision FROM recommendations WHERE singleton=1")
              .get();
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
              db.exec("UPDATE event SET closing_requested=0 WHERE singleton=1");
              return { work: null, reason: "idle" };
            }
            const reserve = e.closing_consumed
              ? 0
              : Math.min(config.closingReserve, config.modelBudget);
            const ceiling = config.modelBudget - (closing ? 0 : reserve);
            if (e.budget_used + e.budget_reserved + config.runCalls > ceiling) {
              db.exec(
                "UPDATE event SET worker_status='over-budget' WHERE singleton=1",
              );
              if (e.worker_status !== "over-budget")
                activity(
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
              "UPDATE event SET budget_reserved=budget_reserved+?,worker_status='processing',closing_requested=CASE WHEN ? THEN 0 ELSE closing_requested END,closing_consumed=CASE WHEN ? THEN 1 ELSE closing_consumed END WHERE singleton=1",
            ).run(config.runCalls, Number(closing), Number(closing));
            if (kind === "recommendation")
              db.prepare(
                "UPDATE event SET last_recommendation_attempt=? WHERE singleton=1",
              ).run(now);
            for (const q of ids)
              db.prepare(
                "UPDATE questions SET attempts=attempts+1 WHERE id=?",
              ).run(q);
            activity(
              "work-claimed",
              `${kind === "answers" ? `${ids.length} question(s)` : "Q&A recommendation"} claimed.`,
              id,
            );
            return { work: workPayload(getWork(id)) };
          }
          if (operation === "agent-result") {
            fields(
              data,
              ["generation", "workId", "resultId", "callsUsed"],
              ["replies", "recommendation"],
            );
            const w = getWork(data.workId);
            const resultId = identifier(data.resultId);
            const calls = integer(data.callsUsed, w.reservation);
            if (w.status === "done" && w.result_id === resultId)
              return { ok: true, duplicate: true };
            active(w);
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
                rec.revision !== event().revision
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
                board()
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
                "INSERT OR REPLACE INTO recommendations(singleton,generation,revision,created_at,data) VALUES(1,?,?,?,?)",
              ).run(
                w.generation,
                w.revision,
                Date.now(),
                JSON.stringify({ groups, queue }),
              );
              db.exec(
                "UPDATE event SET recommendation_failed=0 WHERE singleton=1",
              );
              activity(
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
            const w = getWork(data.workId);
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
            const w = getWork(data.workId);
            const calls = integer(data.callsUsed, w.reservation);
            if (
              !["timeout", "error", "cancelled"].includes(data.reason as string)
            )
              fail(400, "INVALID_REASON", "Unknown failure reason.");
            if (w.status !== "active") return { ok: true };
            reconcile(w, calls, "failed");
            if (w.kind === "recommendation")
              db.exec(
                "UPDATE event SET recommendation_failed=1 WHERE singleton=1",
              );
            for (const id of JSON.parse(w.question_ids))
              db.prepare("UPDATE questions SET next_try=? WHERE id=?").run(
                Date.now() + 3000,
                id,
              );
            activity(
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
              data.workId === undefined ? undefined : getWork(data.workId).id;
            const questionId =
              data.questionId === undefined
                ? undefined
                : question(data.questionId);
            if (data.message !== undefined) text(data.message, 240);
            // Fixed summaries deliberately exclude arbitrary tool output, prompts, or credentials.
            activity(data.kind, summaries[data.kind], workId, questionId);
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
