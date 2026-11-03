import { randomUUID } from "node:crypto";
import {
  config,
  board,
  activity,
  question,
  questions as questionRows,
  transaction,
  keys,
  store,
  sessionByGeneration,
  updateSession,
  updateQuestion,
  talkingPointsOf,
  type Item,
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
const noWorker: WorkerRow = {
  status: "disconnected",
  heartbeat: null,
  session_id: null,
};
export async function worker() {
  const item = await store.get(...keys.worker);
  const w: WorkerRow = {
    status: (item?.status as string) ?? noWorker.status,
    heartbeat: (item?.heartbeat as number | null) ?? null,
    session_id: (item?.session_id as string | null) ?? null,
  };
  const stale = !w.heartbeat || Date.now() - w.heartbeat > workerStaleMs;
  return { ...w, stale };
}
function updateWorker(change: Partial<WorkerRow>) {
  return store.update(...keys.worker, () => change, { ...noWorker });
}
/** What the audience and host see about the agent for session `s`. */
export function agentStatus(
  s: SessionRow,
  w: Awaited<ReturnType<typeof worker>>,
) {
  return w.stale
    ? "disconnected"
    : w.session_id !== s.id
      ? "elsewhere"
      : blocked(s)
        ? "paused"
        : w.status;
}
export async function heartbeat(s: SessionRow, status: unknown) {
  if (!workerStatuses.includes(status as string))
    fail(400, "INVALID_STATUS", "Unknown worker status.");
  await updateWorker({
    status: status as string,
    heartbeat: Date.now(),
    session_id: s.id,
  });
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
type RecommendationRow = { revision: number; created_at: number; data: string };
async function recommendationRow(
  s: SessionRow,
): Promise<RecommendationRow | undefined> {
  return (await store.get(...keys.recommendation(s.generation))) as
    | (Item & RecommendationRow)
    | undefined;
}
/** A recommendation is stale once the board changed or its refresh failed. */
function isStale(row: { revision: number } | undefined, s: SessionRow) {
  return !row || row.revision !== s.revision || !!s.recommendation_failed;
}
export async function recommendation(s: SessionRow) {
  const row = await recommendationRow(s);
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

function updateWork(w: WorkRow, change: Partial<WorkRow>) {
  return store.update(...keys.work(w.generation, w.id), () => change);
}
/**
 * Ends a lease: release its reservation, charge `calls`, and free the single
 * lease slot. Work from a reset generation has no session left to charge.
 */
async function settle(
  w: WorkRow,
  calls: number,
  status: "done" | "failed" | "expired",
  resultId: string | null = null,
) {
  await updateWork(w, { status, calls_used: calls, result_id: resultId });
  const s = await sessionByGeneration(w.generation);
  if (s)
    await updateSession(s, (c) => ({
      budget_reserved: Math.max(0, c.budget_reserved - w.reservation),
      budget_used: c.budget_used + calls,
    }));
  const lease = await store.get(...keys.lease);
  if (lease?.work_id === w.id)
    await store.update(...keys.lease, () => ({
      work_id: null,
      generation: null,
      expires: 0,
    }));
}
/** Unfinished work: its questions back off and a recommendation goes stale. */
async function retryLater(w: WorkRow) {
  const s = await sessionByGeneration(w.generation);
  if (!s) return;
  for (const id of w.question_ids)
    if (await store.get(...keys.question(w.generation, id)))
      await updateQuestion(s, id, () => ({
        next_try: Date.now() + retryDelayMs,
      }));
  if (w.kind === "recommendation")
    await updateSession(s, () => ({ recommendation_failed: 1 }));
}
/** Expires the overdue lease, if any, charging its full reservation. */
export function expire() {
  return transaction(async () => {
    const lease = await store.get(...keys.lease);
    if (!lease?.work_id || (lease.expires as number) > Date.now()) return;
    const item = await store.get(
      ...keys.work(lease.generation as string, lease.work_id as string),
    );
    const w = item as (Item & WorkRow) | undefined;
    if (!w || w.status !== "active") {
      await store.update(...keys.lease, () => ({
        work_id: null,
        generation: null,
        expires: 0,
      }));
      return;
    }
    await settle(w, w.reservation, "expired");
    await retryLater(w);
    activity(
      w.generation,
      "retry",
      "Work lease expired; its full model reservation remains charged.",
      w.id,
    );
  });
}
export async function find(s: SessionRow, value: unknown): Promise<WorkRow> {
  const id = identifier(value);
  const work = (await store.get(...keys.work(s.generation, id))) as
    | (Item & WorkRow)
    | undefined;
  if (!work) fail(404, "WORK_NOT_FOUND", "Work item not found.");
  return work;
}
async function payload(
  w: WorkRow,
  s: SessionRow,
  snapshot: Awaited<ReturnType<typeof board>>,
) {
  return {
    id: w.id,
    sessionId: s.id,
    sessionTitle: s.title,
    // Host-written reference material for this session's answers.
    talkingPoints: await talkingPointsOf(s),
    generation: w.generation,
    pauseEpoch: w.pause_epoch,
    kind: w.kind,
    questionIds: w.question_ids,
    questions: snapshot,
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
  | { work: Awaited<ReturnType<typeof payload>> }
  | { work: null; reason: "paused" | "busy" | "idle" | "over-budget" };

/** Leases the next piece of work for session `s`, if any is due and affordable. */
export function claim(s: SessionRow): Promise<Claim> {
  return transaction(async (): Promise<Claim> => {
    if (blocked(s)) return { work: null, reason: "paused" };
    // One agent instance: at most one active work item across sessions.
    if ((await store.get(...keys.lease))?.work_id)
      return { work: null, reason: "busy" };
    const [questions, rows, history, latest] = await Promise.all([
      board(s),
      questionRows(s),
      store.query(keys.generation(s.generation), "W#"),
      recommendationRow(s),
    ]);
    const eligible = questions.filter((q) => !q.speakerAnswered);
    const now = Date.now();
    const pending = rows
      .filter(
        (q) =>
          !q.reply &&
          q.attempts < maxAttempts &&
          q.next_try <= now &&
          !q.speaker_answered,
      )
      .sort((a, b) => a.created_at - b.created_at)
      .slice(0, answerBatch)
      .map((q) => q.id);
    const recommendationAttempts = history.filter(
      (w) =>
        w.kind === "recommendation" && w.revision === s.revision && !w.closing,
    ).length;
    const dirty =
      eligible.length > 0 &&
      recommendationAttempts < maxAttempts &&
      isStale(latest, s);
    const closing = !!s.closing_requested;
    const kind = closing
      ? "recommendation"
      : pending.length
        ? "answers"
        : dirty && now - s.last_recommendation_attempt >= recommendationIntervalMs
          ? "recommendation"
          : null;
    if (!kind) return { work: null, reason: "idle" };
    if (closing && !eligible.length) {
      await updateSession(s, () => ({ closing_requested: 0 }));
      return { work: null, reason: "idle" };
    }
    // Only the closing run may spend the closing reserve.
    const ceiling = config.modelBudget - (closing ? 0 : closingReserve(s));
    if (s.budget_used + s.budget_reserved + config.runCalls > ceiling) {
      if ((await worker()).status !== "over-budget") {
        await updateWorker({ status: "over-budget" });
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
    const w: WorkRow = {
      id,
      generation: s.generation,
      pause_epoch: s.pause_epoch,
      kind,
      question_ids: ids,
      revision: s.revision,
      expires: now + config.leaseMs,
      closing: Number(closing),
      status: "active",
      reservation: config.runCalls,
      calls_used: null,
      result_id: null,
      acknowledged: 0,
    };
    const [pk, sk] = keys.work(s.generation, id);
    store.put({ ...w, pk, sk });
    await store.update(
      ...keys.lease,
      () => ({ work_id: id, generation: s.generation, expires: w.expires }),
      {},
    );
    await updateSession(s, (c) => ({
      budget_reserved: c.budget_reserved + config.runCalls,
      ...(closing ? { closing_requested: 0, closing_consumed: 1 } : {}),
      ...(kind === "recommendation" ? { last_recommendation_attempt: now } : {}),
    }));
    await updateWorker({ status: "processing" });
    for (const q of ids)
      await updateQuestion(s, q, (c) => ({ attempts: c.attempts + 1 }));
    activity(
      s.generation,
      "work-claimed",
      `${kind === "answers" ? `${ids.length} question(s)` : "Q&A recommendation"} claimed.`,
      id,
    );
    return { work: await payload(w, s, questions) };
  });
}

function parseReplies(w: WorkRow, raw: unknown[]) {
  const ids = w.question_ids;
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
async function parseRecommendation(
  w: WorkRow,
  s: SessionRow,
  raw: unknown,
) {
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
    (await board(s))
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
  return transaction(async () => {
    const w = await find(s, input.workId);
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
        await question(s, r.id);
        await updateQuestion(s, r.id, () => ({
          reply: { text: r.text, disposition: r.disposition, result_id: resultId },
        }));
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
      const data = await parseRecommendation(w, s, input.recommendation);
      const [pk, sk] = keys.recommendation(w.generation);
      await store.update(
        pk,
        sk,
        () => ({
          revision: w.revision,
          created_at: Date.now(),
          data: JSON.stringify(data),
        }),
        {},
      );
      await updateSession(s, () => ({ recommendation_failed: 0 }));
      activity(
        s.generation,
        "queue-updated",
        "Backstage recommendation updated; votes and host choices remain unchanged.",
        w.id,
      );
    }
    await settle(w, calls, "done", resultId);
    return { ok: true, duplicate: false };
  });
}

export function acknowledge(s: SessionRow, workId: unknown) {
  return transaction(async () => {
    const w = await find(s, workId);
    if (w.status !== "done")
      fail(
        409,
        "RESULT_REQUIRED",
        "Publish the result before acknowledging work.",
      );
    await updateWork(w, { acknowledged: 1 });
    return { ok: true };
  });
}

/** The agent gave up on a lease; charge what it used and retry later. */
export function abandon(
  s: SessionRow,
  input: Fields<"workId" | "callsUsed" | "reason">,
) {
  return transaction(async () => {
    const w = await find(s, input.workId);
    const calls = integer(input.callsUsed, w.reservation);
    if (!["timeout", "error", "cancelled"].includes(input.reason as string))
      fail(400, "INVALID_REASON", "Unknown failure reason.");
    if (w.status !== "active") return { ok: true };
    await settle(w, calls, "failed");
    await retryLater(w);
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
  return transaction(async () => {
    if (typeof input.kind !== "string" || !activitySummaries[input.kind])
      fail(400, "INVALID_KIND", "Unknown activity kind.");
    const workId =
      input.workId === undefined ? undefined : (await find(s, input.workId)).id;
    const questionId =
      input.questionId === undefined
        ? undefined
        : (await question(s, input.questionId)).id;
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
