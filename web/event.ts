import { NextRequest, NextResponse } from "next/server";
import { randomBytes, randomUUID } from "node:crypto";
import {
  db,
  config,
  board,
  activity,
  question,
  transaction,
  sessionById,
  sessionByGeneration,
  liveSession,
  defaultSession,
  type SessionRow,
} from "./db";
import * as work from "./work";
import {
  ApiError,
  fail,
  object,
  fields,
  identifier,
  text,
  boolean,
  type Json,
} from "./validate";

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
function sessionInfo(s: SessionRow) {
  return { id: s.id, title: s.title, live: !!s.live, createdAt: s.created_at };
}
function snapshot(s: SessionRow, visitorId = "") {
  const questions = board(s, visitorId);
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
    agent: { status: work.agentStatus(s), lastSeenAt: work.worker().heartbeat },
    recommendation: work.recommendation(s),
  };
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
        const id = question(s, data.questionId);
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
      const w = work.worker();
      response = {
        ...state,
        session: { ...sessionInfo(s), talkingPoints: s.talking_points },
        sessions: sessionList(),
        revision: s.revision,
        budget: work.budget(s),
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
            data.questionId === null ? null : question(s, data.questionId);
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
          const id = question(s, data.questionId);
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
        work.expire();
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
          agentPaused: work.blocked(s),
          status: work.worker().status,
          revision: s.revision,
          closingRequested: !!s.closing_requested,
          budget: work.budget(s),
          questions: board(s),
          serverTime: Date.now(),
        };
      } else {
        const data = await body(req);
        response = transaction(() => {
          work.expire();
          const s = generation(data.generation);
          if (operation === "agent-heartbeat") {
            fields(data, ["generation", "status"]);
            return work.heartbeat(s, data.status);
          }
          if (operation === "agent-claim") {
            fields(data, ["generation"]);
            return work.claim(s);
          }
          if (operation === "agent-result") {
            fields(
              data,
              ["generation", "workId", "resultId", "callsUsed"],
              ["replies", "recommendation"],
            );
            return work.complete(s, data);
          }
          if (operation === "agent-ack") {
            fields(data, ["generation", "workId"]);
            return work.acknowledge(s, data.workId);
          }
          if (operation === "agent-fail") {
            fields(data, ["generation", "workId", "callsUsed", "reason"]);
            return work.abandon(s, data);
          }
          if (operation === "agent-activity") {
            fields(
              data,
              ["generation", "kind"],
              ["workId", "questionId", "message"],
            );
            return work.report(s, data);
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
