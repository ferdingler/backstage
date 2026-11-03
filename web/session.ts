import { randomUUID } from "node:crypto";
import {
  config,
  board,
  activity,
  question,
  transaction,
  runState,
  keys,
  store,
  purge,
  sessions,
  sessionById,
  sessionByGeneration,
  liveSession,
  defaultSession,
  newSession,
  updateSession,
  updateQuestion,
  talkingPointsOf,
  recentActivity,
  type SessionRow,
} from "./db";
import * as work from "./work";
import { fail, identifier, text } from "./validate";

/**
 * Sessions: what the audience and host can do to one, and the read models
 * they see. Two counters on a session carry meaning for the agent, and only
 * this module moves them:
 *
 * - `revision` grows whenever the board changes in a way that can change the
 *   recommended order (a question, a vote, speaker-answered status). A
 *   recommendation made at an older revision is stale.
 * - `pause_epoch` grows whenever in-flight agent work must be discarded (the
 *   session or its agent is paused, or the session is reset).
 *
 * Every exported operation is atomic.
 */

const TITLE_MAX = 120;
const TALKING_POINTS_MAX = 50_000;
const QUESTION_MAX = 1000;

function boardChanged(s: SessionRow) {
  return updateSession(s, (c) => ({ revision: c.revision + 1 }));
}
function cancelAgentWork(s: SessionRow) {
  return updateSession(s, (c) => ({ pause_epoch: c.pause_epoch + 1 }));
}
function title(value: unknown) {
  return text(value, TITLE_MAX).trim();
}
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
function saveTalkingPoints(id: string, value: string) {
  const [pk, sk] = keys.notes(id);
  return store.update(pk, sk, () => ({ text: value }), { text: "" });
}

// Lookup -------------------------------------------------------------------

/** Resolves the session a client's generation belongs to; a reset makes it stale. */
export async function byGeneration(value: unknown): Promise<SessionRow> {
  const s = await sessionByGeneration(identifier(value));
  if (!s)
    fail(
      409,
      "STALE_GENERATION",
      "This session was reset or no longer exists. Refresh before continuing.",
    );
  return s;
}
/** Resolves the agent's session after expiring overdue leases. */
export async function forAgent(generation: unknown): Promise<SessionRow> {
  await work.expire();
  return byGeneration(generation);
}
/** The requested session, else the live one, else the newest. */
export async function byIdOrDefault(
  requested: string | null,
): Promise<SessionRow> {
  if (!requested) return defaultSession();
  return (
    (await sessionById(identifier(requested))) ??
    fail(404, "SESSION_NOT_FOUND", "That session no longer exists.")
  );
}
export { liveSession as live };
async function requireLive(): Promise<SessionRow> {
  const s = await liveSession();
  if (!s) fail(409, "NO_LIVE_SESSION", "There is no live session right now.");
  return s;
}

// Read models --------------------------------------------------------------

export function info(s: SessionRow) {
  return { id: s.id, title: s.title, live: !!s.live, createdAt: s.created_at };
}
export async function snapshot(s: SessionRow, visitorId = "") {
  const [questions, w, recommendation] = await Promise.all([
    board(s, visitorId),
    work.worker(),
    work.recommendation(s),
  ]);
  return {
    session: info(s),
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
      status: work.agentStatus(s, w),
      lastSeenAt: w.heartbeat,
    },
    recommendation,
  };
}
async function list() {
  return (await sessions()).map((s) => ({
    id: s.id,
    title: s.title,
    live: !!s.live,
    createdAt: s.created_at,
    questionCount: s.question_count,
  }));
}
/** Everything the host dashboard shows for session `s`. */
export async function hostView(s: SessionRow) {
  const [view, w, all, notes, events] = await Promise.all([
    snapshot(s),
    work.worker(),
    list(),
    talkingPointsOf(s),
    recentActivity(s.generation),
  ]);
  return {
    ...view,
    session: { ...info(s), talkingPoints: notes },
    sessions: all,
    revision: s.revision,
    budget: work.budget(s),
    worker: {
      status: w.status,
      lastSeenAt: w.heartbeat,
      stale: w.stale,
      sessionId: w.session_id,
    },
    activity: events,
  };
}

// Audience -----------------------------------------------------------------

export function ask(value: unknown) {
  const questionText = text(value, QUESTION_MAX);
  return transaction(async () => {
    const s = await requireLive();
    if (s.intake_paused)
      fail(
        409,
        "INTAKE_PAUSED",
        "New questions are paused. You can still vote.",
      );
    if (s.question_count >= config.questionCap)
      fail(
        409,
        "INTAKE_FULL",
        "This session has reached its question limit. You can still vote.",
      );
    const id = randomUUID();
    const [pk, sk] = keys.question(s.generation, id);
    store.put({
      pk,
      sk,
      id,
      text: questionText,
      created_at: Date.now(),
      speaker_answered: 0,
      hidden: 0,
      attempts: 0,
      next_try: 0,
      votes: 0,
      reply: null,
    });
    await updateSession(s, (c) => ({
      revision: c.revision + 1,
      question_count: c.question_count + 1,
    }));
    return { questionId: id, generation: s.generation };
  });
}
export function vote(visitorId: string, questionId: unknown, voted: boolean) {
  return transaction(async () => {
    const s = await requireLive();
    const q = await question(s, questionId);
    const [pk, sk] = keys.vote(s.generation, visitorId, q.id);
    const existing = !!(await store.get(pk, sk));
    let votes = q.votes;
    if (voted !== existing) {
      if (voted)
        store.put({ pk, sk, visitor_id: visitorId, question_id: q.id });
      else await store.remove(pk, sk);
      votes = (
        await updateQuestion(s, q.id, (c) => ({
          votes: c.votes + (voted ? 1 : -1),
        }))
      ).votes;
      await boardChanged(s);
    }
    return { ok: true, voted, votes };
  });
}

// Host ---------------------------------------------------------------------

export function create(input: { title?: unknown; talkingPoints?: unknown }) {
  return transaction(async () => {
    const id = randomUUID();
    const generation = randomUUID();
    const [pk, sk] = keys.session(id);
    store.put({ ...newSession(id, generation, title(input.title)), pk, sk });
    const notes = talkingPoints(input.talkingPoints);
    if (notes) await saveTalkingPoints(id, notes);
    activity(generation, "session", "Session created.");
    return { sessionId: id, generation };
  });
}
export function update(
  s: SessionRow,
  input: { title?: unknown; talkingPoints?: unknown },
) {
  return transaction(async () => {
    if (input.title !== undefined) {
      const value = title(input.title);
      await updateSession(s, () => ({ title: value }));
    }
    if (input.talkingPoints !== undefined)
      await saveTalkingPoints(s.id, talkingPoints(input.talkingPoints));
    activity(s.generation, "session", "Session details updated.");
  });
}
/**
 * Makes `s` the one live session or pauses it. Returns the session that was
 * paused to make room, if any.
 */
export function setLive(s: SessionRow, value: boolean) {
  return transaction(async () => {
    const current = (await sessionById(s.id))!;
    // Every change of the live session rewrites this item, so two hosts
    // making different sessions live at once cannot both succeed.
    const [pk, sk] = keys.live;
    if (!value) {
      if (current.live) {
        await pause(current, "Session paused.");
        await store.update(pk, sk, () => ({ session_id: null }), {});
      }
      return undefined;
    }
    const previous = await liveSession();
    const displaced = previous && previous.id !== s.id ? previous : undefined;
    if (displaced)
      await pause(displaced, "Session paused; another session went live.");
    if (!current.live) {
      await updateSession(s, () => ({ live: 1 }));
      await store.update(pk, sk, () => ({ session_id: s.id }), {});
      activity(s.generation, "resume", "Session is live.");
    }
    return displaced;
  });
}
async function pause(s: SessionRow, message: string) {
  await updateSession(s, (c) => ({ live: 0, pause_epoch: c.pause_epoch + 1 }));
  activity(s.generation, "pause", message);
}
/** Clears the session's questions and run state under a new generation. */
export function reset(s: SessionRow, confirmation: unknown) {
  if (confirmation !== "RESET")
    fail(400, "CONFIRMATION_REQUIRED", "Type RESET to clear this session.");
  return transaction(async () => {
    const generation = randomUUID();
    await updateSession(s, (c) => ({
      generation,
      ...runState,
      pause_epoch: c.pause_epoch + 1,
    }));
    // A lease from the old generation can no longer be completed.
    const lease = await store.get(...keys.lease);
    if (lease?.generation === s.generation)
      await store.update(...keys.lease, () => ({
        work_id: null,
        generation: null,
        expires: 0,
      }));
    activity(generation, "reset", "Session questions were cleared.");
    // Old-generation items are unreachable once the session moves on.
    const old = keys.generation(s.generation);
    store.afterCommit(() => purge(old));
    return { generation };
  });
}
export function setIntakePaused(s: SessionRow, value: boolean) {
  return transaction(async () => {
    await updateSession(s, () => ({ intake_paused: Number(value) }));
    activity(
      s.generation,
      value ? "pause" : "resume",
      `Question intake ${value ? "paused" : "resumed"}.`,
    );
  });
}
export function setAgentPaused(s: SessionRow, value: boolean) {
  return transaction(async () => {
    const current = (await sessionById(s.id))!;
    if (current.agent_paused !== Number(value)) {
      await updateSession(s, () => ({ agent_paused: Number(value) }));
      await cancelAgentWork(s);
    }
    activity(
      s.generation,
      value ? "pause" : "resume",
      `Agent processing ${value ? "paused" : "resumed"}.`,
    );
  });
}
/** Puts a question on the broadcast, or clears it with `null`. */
export function select(s: SessionRow, questionId: unknown) {
  return transaction(async () => {
    const q = questionId === null ? null : await question(s, questionId);
    if (q?.hidden)
      fail(
        409,
        "QUESTION_HIDDEN",
        "Unhide this question before broadcasting it.",
      );
    await updateSession(s, () => ({ selected_id: q?.id ?? null }));
    activity(
      s.generation,
      "broadcast",
      q
        ? "Host selected a question for broadcast."
        : "Host cleared the broadcast.",
      undefined,
      q?.id,
    );
  });
}
async function setQuestionFlag(
  s: SessionRow,
  questionId: unknown,
  flag: "speaker_answered" | "hidden",
  value: boolean,
) {
  const q = await question(s, questionId);
  const changed = q[flag] !== Number(value);
  if (changed) await updateQuestion(s, q.id, () => ({ [flag]: Number(value) }));
  return { id: q.id, changed };
}
/** Speaker-answered questions leave the agent's queue, so the board changes. */
export function markAnswered(
  s: SessionRow,
  questionId: unknown,
  value: boolean,
) {
  return transaction(async () => {
    const { id, changed } = await setQuestionFlag(
      s,
      questionId,
      "speaker_answered",
      value,
    );
    if (changed) await boardChanged(s);
    activity(
      s.generation,
      "answered",
      "Host updated speaker-answer status.",
      undefined,
      id,
    );
  });
}
/** Hiding a question also takes it off the broadcast. */
export function setHidden(s: SessionRow, questionId: unknown, value: boolean) {
  return transaction(async () => {
    const { id } = await setQuestionFlag(s, questionId, "hidden", value);
    if (value)
      await updateSession(s, (c) =>
        c.selected_id === id ? { selected_id: null } : {},
      );
    activity(
      s.generation,
      "hide",
      "Host updated broadcast visibility.",
      undefined,
      id,
    );
  });
}
/** Asks the agent for one closing recommendation, paid from the closing reserve. */
export function requestClosing(s: SessionRow) {
  return transaction(async () => {
    await updateSession(s, () => ({ closing_requested: 1 }));
    activity(
      s.generation,
      "closing",
      "Host requested a recommended question order.",
    );
  });
}
