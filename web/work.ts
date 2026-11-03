import { randomUUID } from "node:crypto";
import {
  db,
  config,
  board,
  activity,
  question,
  transaction,
  type SessionRow,
  type WorkRow,
} from "./db";
import { fail, fields, identifier, integer, object, text } from "./validate";

/** Unvalidated request fields; this module checks each one it reads. */
type Fields<K extends string> = Partial<Record<K, unknown>>;

/**
 * Agent work leases. The agent claims one work item at a time, then completes,
 * abandons, or lets it expire. This module owns everything that follows:
 *
 * - Scheduling: answers first, then a recommendation when the queue is stale.
 * - The model-call budget: a claim reserves `config.runCalls`; settling the
 *   lease releases the reservation and charges the calls actually used (an
 *   expired lease is charged in full). The closing reserve is held back for
 *   the host's one closing recommendation.
 * - Retry: failed or expired answer work backs off before its questions are
 *   claimed again; a failed recommendation marks the current one stale.
 * - Result validation against what was claimed.
 *
 * Every exported operation is atomic.
 */

const retryDelayMs = 3000;
const maxAttempts = 3;
const answerBatch = 5;
const recommendationIntervalMs = 60_000;
const workerStaleMs = 15_000;
const workerStatuses = [
  "idle",
  "processing",
  "paused",
  "retrying",
  "over-budget",
  "disconnected",
];
const activitySummaries: Record<string, string> = {
  "notes-read": "Agent read the session’s talking points.",
  "tool-success": "Agent tool completed successfully.",
  "tool-error": "Agent tool returned an error.",
  retry: "Agent is retrying an operation.",
  timeout: "Agent run reached its deadline.",
};

/** Agent work is allowed only while the session is live and not agent-paused. */
export function blocked(s: SessionRow) {
  return !!s.agent_paused || !s.live;
}

// Worker ------------------------------------------------------------------

type WorkerRow = {
  status: string;
  heartbeat: number | null;
  session_id: string | null;
};
export function worker() {
  const w = db
    .prepare("SELECT * FROM worker WHERE singleton=1")
    .get() as WorkerRow;
  const stale = !w.heartbeat || Date.now() - w.heartbeat > workerStaleMs;
  return { ...w, stale };
}
function setWorkerStatus(status: string) {
  db.prepare("UPDATE worker SET status=? WHERE singleton=1").run(status);
}
/** What the audience and host see about the agent for session `s`. */
export function agentStatus(s: SessionRow) {
  const w = worker();
  return w.stale
    ? "disconnected"
    : w.session_id !== s.id
      ? "elsewhere"
      : blocked(s)
        ? "paused"
        : w.status;
}
export function heartbeat(s: SessionRow, status: unknown) {
  if (!workerStatuses.includes(status as string))
    fail(400, "INVALID_STATUS", "Unknown worker status.");
  db.prepare(
    "UPDATE worker SET status=?,heartbeat=?,session_id=? WHERE singleton=1",
  ).run(status as string, Date.now(), s.id);
  return {
    ok: true,
    generation: s.generation,
    agentPaused: blocked(s),
    pauseEpoch: s.pause_epoch,
  };
}

// Budget and recommendation ------------------------------------------------

function closingReserve(s: SessionRow) {
  return s.closing_consumed
    ? 0
    : Math.min(config.closingReserve, config.modelBudget);
}
export function budget(s: SessionRow) {
  return {
    used: s.budget_used,
    reserved: s.budget_reserved,
    limit: config.modelBudget,
    closingReserve: closingReserve(s),
  };
}
function recommendationRow(s: SessionRow) {
  return db
    .prepare("SELECT * FROM recommendations WHERE generation=?")
    .get(s.generation) as
    { revision: number; created_at: number; data: string } | undefined;
}
/** A recommendation is stale once the board changed or its refresh failed. */
function isStale(row: { revision: number } | undefined, s: SessionRow) {
  return !row || row.revision !== s.revision || !!s.recommendation_failed;
}
export function recommendation(s: SessionRow) {
  const row = recommendationRow(s);
  return row
    ? {
        ...JSON.parse(row.data),
        revision: row.revision,
        createdAt: row.created_at,
        stale: isStale(row, s),
      }
    : null;
}

// Lease lifecycle -----------------------------------------------------------

/** Ends a lease: release its reservation and charge `calls`. */
function settle(
  w: WorkRow,
  calls: number,
  status: "done" | "failed" | "expired",
  resultId: string | null = null,
) {
  db.prepare(
    "UPDATE work SET status=?,calls_used=?,result_id=? WHERE id=?",
  ).run(status, calls, resultId, w.id);
  db.prepare(
    "UPDATE sessions SET budget_reserved=MAX(0,budget_reserved-?),budget_used=budget_used+? WHERE generation=?",
  ).run(w.reservation, calls, w.generation);
}
/** Unfinished work: its questions back off and a recommendation goes stale. */
function retryLater(w: WorkRow) {
  for (const id of JSON.parse(w.question_ids) as string[])
    db.prepare("UPDATE questions SET next_try=? WHERE id=?").run(
      Date.now() + retryDelayMs,
      id,
    );
  if (w.kind === "recommendation")
    db.prepare(
      "UPDATE sessions SET recommendation_failed=1 WHERE generation=?",
    ).run(w.generation);
}
/** Expires overdue leases, charging their full reservation. */
export function expire() {
  transaction(() => {
    const stale = db
      .prepare("SELECT * FROM work WHERE status='active' AND expires<=?")
      .all(Date.now()) as WorkRow[];
    for (const w of stale) {
      settle(w, w.reservation, "expired");
      retryLater(w);
      activity(
        w.generation,
        "retry",
        "Work lease expired; its full model reservation remains charged.",
        w.id,
      );
    }
  });
}
export function find(s: SessionRow, value: unknown): WorkRow {
  const id = identifier(value);
  const work = db
    .prepare("SELECT * FROM work WHERE id=? AND generation=?")
    .get(id, s.generation) as WorkRow | undefined;
  if (!work) fail(404, "WORK_NOT_FOUND", "Work item not found.");
  return work;
}
function payload(w: WorkRow, s: SessionRow) {
  return {
    id: w.id,
    sessionId: s.id,
    sessionTitle: s.title,
    // Host-written reference material for this session's answers.
    talkingPoints: s.talking_points,
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
function requireActive(w: WorkRow, s: SessionRow) {
  if (w.status !== "active")
    fail(409, "WORK_FINISHED", "This work item has finished.");
  if (w.expires <= Date.now())
    fail(409, "LEASE_EXPIRED", "This work lease expired.");
  if (blocked(s) || w.pause_epoch !== s.pause_epoch)
    fail(
      409,
      "WORK_CANCELLED",
      "Agent processing was paused. Discard this result.",
    );
}

type Claim =
  | { work: ReturnType<typeof payload> }
  | { work: null; reason: "paused" | "busy" | "idle" | "over-budget" };

/** Leases the next piece of work for session `s`, if any is due and affordable. */
export function claim(s: SessionRow): Claim {
  return transaction((): Claim => {
    if (blocked(s)) return { work: null, reason: "paused" };
    // One agent instance: at most one active work item across sessions.
    if (db.prepare("SELECT 1 FROM work WHERE status='active' LIMIT 1").get())
      return { work: null, reason: "busy" };
    const questions = board(s);
    const eligible = questions.filter((q) => !q.speakerAnswered);
    const pending = db
      .prepare(
        `SELECT q.id FROM questions q LEFT JOIN replies r ON r.question_id=q.id WHERE q.generation=? AND r.question_id IS NULL AND q.attempts<? AND q.next_try<=? AND q.speaker_answered=0 ORDER BY q.created_at LIMIT ?`,
      )
      .all(s.generation, maxAttempts, Date.now(), answerBatch)
      .map((q) => q.id as string);
    const recommendationAttempts = db
      .prepare(
        "SELECT COUNT(*) AS n FROM work WHERE kind='recommendation' AND revision=? AND generation=? AND closing=0",
      )
      .get(s.revision, s.generation)!.n as number;
    const dirty =
      eligible.length > 0 &&
      recommendationAttempts < maxAttempts &&
      isStale(recommendationRow(s), s);
    const closing = !!s.closing_requested;
    const kind = closing
      ? "recommendation"
      : pending.length
        ? "answers"
        : dirty &&
            Date.now() - s.last_recommendation_attempt >=
              recommendationIntervalMs
          ? "recommendation"
          : null;
    if (!kind) return { work: null, reason: "idle" };
    if (closing && !eligible.length) {
      db.prepare("UPDATE sessions SET closing_requested=0 WHERE id=?").run(
        s.id,
      );
      return { work: null, reason: "idle" };
    }
    // Only the closing run may spend the closing reserve.
    const ceiling = config.modelBudget - (closing ? 0 : closingReserve(s));
    if (s.budget_used + s.budget_reserved + config.runCalls > ceiling) {
      if (worker().status !== "over-budget") {
        setWorkerStatus("over-budget");
        activity(
          s.generation,
          "budget-exhaustion",
          "Model budget is exhausted; audience and host controls remain available.",
        );
      }
      return { work: null, reason: "over-budget" };
    }
    const id = randomUUID();
    const ids = kind === "answers" ? pending : [];
    const now = Date.now();
    db.prepare(
      "INSERT INTO work(id,generation,pause_epoch,kind,question_ids,snapshot,revision,expires,closing,reservation) VALUES(?,?,?,?,?,?,?,?,?,?)",
    ).run(
      id,
      s.generation,
      s.pause_epoch,
      kind,
      JSON.stringify(ids),
      JSON.stringify(questions),
      s.revision,
      now + config.leaseMs,
      Number(closing),
      config.runCalls,
    );
    db.prepare(
      "UPDATE sessions SET budget_reserved=budget_reserved+?,closing_requested=CASE WHEN ? THEN 0 ELSE closing_requested END,closing_consumed=CASE WHEN ? THEN 1 ELSE closing_consumed END WHERE id=?",
    ).run(config.runCalls, Number(closing), Number(closing), s.id);
    setWorkerStatus("processing");
    if (kind === "recommendation")
      db.prepare(
        "UPDATE sessions SET last_recommendation_attempt=? WHERE id=?",
      ).run(now, s.id);
    for (const q of ids)
      db.prepare("UPDATE questions SET attempts=attempts+1 WHERE id=?").run(q);
    activity(
      s.generation,
      "work-claimed",
      `${kind === "answers" ? `${ids.length} question(s)` : "Q&A recommendation"} claimed.`,
      id,
    );
    return { work: payload(find(s, id), s) };
  });
}

function parseReplies(w: WorkRow, raw: unknown[]) {
  const ids: string[] = JSON.parse(w.question_ids);
  const seen = new Set<string>();
  const replies = raw.map((value) => {
    const reply = object(value);
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
      !["answered", "leave-for-speaker"].includes(reply.disposition as string)
    )
      fail(400, "INVALID_RESULT", "Invalid reply disposition.");
    return {
      id,
      text: text(reply.text, 1200),
      disposition: reply.disposition as string,
    };
  });
  if (seen.size !== ids.length)
    fail(400, "INVALID_RESULT", "Return one reply for every claimed question.");
  return replies;
}
function parseRecommendation(w: WorkRow, s: SessionRow, raw: unknown) {
  const rec = object(raw);
  fields(rec, ["revision", "groups", "queue"]);
  if (rec.revision !== w.revision || rec.revision !== s.revision)
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
  const grouped = new Set<string>();
  const queued = new Set<string>();
  const groups = rec.groups.map((value) => {
    const group = object(value);
    fields(group, ["title", "questionIds"]);
    if (
      !Array.isArray(group.questionIds) ||
      group.questionIds.length < 2 ||
      group.questionIds.length > 20
    )
      fail(400, "INVALID_RESULT", "Each group needs 2–20 questions.");
    return {
      title: text(group.title, 100),
      questionIds: group.questionIds.map((member) => {
        const id = identifier(member);
        if (!eligible.has(id) || grouped.has(id))
          fail(400, "INVALID_RESULT", "Invalid or duplicate group member.");
        grouped.add(id);
        return id;
      }),
    };
  });
  const queue = rec.queue.map((value) => {
    const item = object(value);
    fields(item, ["questionId", "reason"]);
    const id = identifier(item.questionId);
    if (!eligible.has(id) || queued.has(id))
      fail(400, "INVALID_RESULT", "Invalid or duplicate queue member.");
    queued.add(id);
    return { questionId: id, reason: text(item.reason, 240) };
  });
  return { groups, queue };
}

/** Publishes a lease's result. Resubmitting the same result is a no-op. */
export function complete(
  s: SessionRow,
  input: Fields<
    "workId" | "resultId" | "callsUsed" | "replies" | "recommendation"
  >,
) {
  return transaction(() => {
    const w = find(s, input.workId);
    const resultId = identifier(input.resultId);
    const calls = integer(input.callsUsed, w.reservation);
    if (w.status === "done" && w.result_id === resultId)
      return { ok: true, duplicate: true };
    requireActive(w, s);
    if (resultId !== w.id)
      fail(
        400,
        "INVALID_RESULT_ID",
        "Use the work identifier as the stable result identifier.",
      );
    if (w.kind === "answers") {
      if (input.recommendation !== undefined || !Array.isArray(input.replies))
        fail(400, "INVALID_RESULT", "Expected question replies only.");
      for (const r of parseReplies(w, input.replies)) {
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
      if (input.replies !== undefined)
        fail(400, "INVALID_RESULT", "Expected a recommendation only.");
      const data = parseRecommendation(w, s, input.recommendation);
      db.prepare(
        "INSERT OR REPLACE INTO recommendations(generation,revision,created_at,data) VALUES(?,?,?,?)",
      ).run(w.generation, w.revision, Date.now(), JSON.stringify(data));
      db.prepare("UPDATE sessions SET recommendation_failed=0 WHERE id=?").run(
        s.id,
      );
      activity(
        s.generation,
        "queue-updated",
        "Backstage recommendation updated; votes and host choices remain unchanged.",
        w.id,
      );
    }
    settle(w, calls, "done", resultId);
    return { ok: true, duplicate: false };
  });
}

export function acknowledge(s: SessionRow, workId: unknown) {
  return transaction(() => {
    const w = find(s, workId);
    if (w.status !== "done")
      fail(
        409,
        "RESULT_REQUIRED",
        "Publish the result before acknowledging work.",
      );
    db.prepare("UPDATE work SET acknowledged=1 WHERE id=?").run(w.id);
    return { ok: true };
  });
}

/** The agent gave up on a lease; charge what it used and retry later. */
export function abandon(
  s: SessionRow,
  input: Fields<"workId" | "callsUsed" | "reason">,
) {
  return transaction(() => {
    const w = find(s, input.workId);
    const calls = integer(input.callsUsed, w.reservation);
    if (!["timeout", "error", "cancelled"].includes(input.reason as string))
      fail(400, "INVALID_REASON", "Unknown failure reason.");
    if (w.status !== "active") return { ok: true };
    settle(w, calls, "failed");
    retryLater(w);
    activity(
      s.generation,
      input.reason === "timeout" ? "timeout" : "retry",
      input.reason === "cancelled"
        ? "Late work discarded after pause or reset."
        : "Agent work failed; bounded retry is available.",
      w.id,
    );
    return { ok: true };
  });
}

/**
 * Records an agent-reported activity. Fixed summaries deliberately exclude
 * arbitrary tool output, prompts, or credentials.
 */
export function report(
  s: SessionRow,
  input: Fields<"kind" | "workId" | "questionId" | "message">,
) {
  return transaction(() => {
    if (typeof input.kind !== "string" || !activitySummaries[input.kind])
      fail(400, "INVALID_KIND", "Unknown activity kind.");
    const workId =
      input.workId === undefined ? undefined : find(s, input.workId).id;
    const questionId =
      input.questionId === undefined
        ? undefined
        : question(s, input.questionId);
    if (input.message !== undefined) text(input.message, 240);
    activity(
      s.generation,
      input.kind,
      activitySummaries[input.kind],
      workId,
      questionId,
    );
    return { ok: true };
  });
}
