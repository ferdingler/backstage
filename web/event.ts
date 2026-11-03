import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { db, config, board, transaction } from "./db";
import * as session from "./session";
import * as work from "./work";
import {
  ApiError,
  fail,
  object,
  fields,
  text,
  boolean,
  type Json,
} from "./validate";

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
      const live = session.live();
      const state = live ? session.snapshot(live) : null;
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
      const live = session.live();
      const res = NextResponse.json(
        live
          ? { ...session.snapshot(live, who.id), recommendation: null }
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
      response = session.ask(data.text);
    } else if (operation === "votes") {
      const who = publicWrite(req, "vote");
      const data = await body(req);
      fields(data, ["questionId", "voted"]);
      response = session.vote(who, data.questionId, boolean(data.voted));
    } else if (operation === "host-state") {
      channel(req, "host");
      response = session.hostView(
        session.byIdOrDefault(req.nextUrl.searchParams.get("session")),
      );
    } else if (operation === "host-control") {
      channel(req, "host");
      origin(req, true);
      const data = await body(req, 256 * 1024);
      response = transaction(() => {
        const action = data.action;
        if (action === "create-session") {
          fields(data, ["action", "title"], ["talkingPoints"]);
          return { ok: true, ...session.create(data) };
        }
        const s = session.byGeneration(data.generation);
        if (action === "update-session") {
          fields(data, ["generation", "action"], ["title", "talkingPoints"]);
          session.update(s, data);
        } else if (action === "live") {
          fields(data, ["generation", "action", "value"]);
          const paused = session.setLive(s, boolean(data.value));
          return {
            ok: true,
            generation: s.generation,
            paused: paused ? session.info(paused) : null,
          };
        } else if (action === "reset") {
          fields(data, ["generation", "action", "confirmation"]);
          return { ok: true, ...session.reset(s, data.confirmation) };
        } else if (action === "intake") {
          fields(data, ["generation", "action", "value"]);
          session.setIntakePaused(s, boolean(data.value));
        } else if (action === "agent") {
          fields(data, ["generation", "action", "value"]);
          session.setAgentPaused(s, boolean(data.value));
        } else if (action === "select") {
          fields(data, ["generation", "action", "questionId"]);
          session.select(s, data.questionId);
        } else if (action === "answered") {
          fields(data, ["generation", "action", "questionId", "value"]);
          session.markAnswered(s, data.questionId, boolean(data.value));
        } else if (action === "hide") {
          fields(data, ["generation", "action", "questionId", "value"]);
          session.setHidden(s, data.questionId, boolean(data.value));
        } else if (action === "closing") {
          fields(data, ["generation", "action"]);
          session.requestClosing(s);
        } else fail(400, "UNKNOWN_ACTION", "Unknown host action.");
        return { ok: true, generation: s.generation };
      });
    } else {
      channel(req, "agent");
      if (operation === "agent-state") {
        work.expire();
        // An agent may be pointed at a session; otherwise it follows the live one.
        const s = session.byIdOrDefault(req.nextUrl.searchParams.get("session"));
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
          const s = session.byGeneration(data.generation);
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
