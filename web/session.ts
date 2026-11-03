import { randomUUID } from "node:crypto";
import {
  db,
  config,
  board,
  activity,
  question,
  transaction,
  runState,
  generationTables,
  sessionById,
  sessionByGeneration,
  liveSession,
  defaultSession,
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
  db.prepare("UPDATE sessions SET revision=revision+1 WHERE id=?").run(s.id);
}
function cancelAgentWork(id: string) {
  db.prepare("UPDATE sessions SET pause_epoch=pause_epoch+1 WHERE id=?").run(
    id,
  );
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

// Lookup -------------------------------------------------------------------

/** Resolves the session a client's generation belongs to; a reset makes it stale. */
export function byGeneration(value: unknown): SessionRow {
  const s = sessionByGeneration(identifier(value));
  if (!s)
    fail(
      409,
      "STALE_GENERATION",
      "This session was reset or no longer exists. Refresh before continuing.",
    );
  return s;
}
/** The requested session, else the live one, else the newest. */
export function byIdOrDefault(requested: string | null): SessionRow {
  if (!requested) return defaultSession();
  return (
    sessionById(identifier(requested)) ??
    fail(404, "SESSION_NOT_FOUND", "That session no longer exists.")
  );
}
export { liveSession as live };
function requireLive(): SessionRow {
  const s = liveSession();
  if (!s) fail(409, "NO_LIVE_SESSION", "There is no live session right now.");
  return s;
}

// Read models --------------------------------------------------------------

export function info(s: SessionRow) {
  return { id: s.id, title: s.title, live: !!s.live, createdAt: s.created_at };
}
export function snapshot(s: SessionRow, visitorId = "") {
  const questions = board(s, visitorId);
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
      status: work.agentStatus(s),
      lastSeenAt: work.worker().heartbeat,
    },
    recommendation: work.recommendation(s),
  };
}
function list() {
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
/** Everything the host dashboard shows for session `s`. */
export function hostView(s: SessionRow) {
  const w = work.worker();
  return {
    ...snapshot(s),
    session: { ...info(s), talkingPoints: s.talking_points },
    sessions: list(),
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
}

// Audience -----------------------------------------------------------------

export function ask(value: unknown) {
  const questionText = text(value, QUESTION_MAX);
  return transaction(() => {
    const s = requireLive();
    if (s.intake_paused)
      fail(
        409,
        "INTAKE_PAUSED",
        "New questions are paused. You can still vote.",
      );
    const count = db
      .prepare("SELECT COUNT(*) AS n FROM questions WHERE generation=?")
      .get(s.generation)!.n as number;
    if (count >= config.questionCap)
      fail(
        409,
        "INTAKE_FULL",
        "This session has reached its question limit. You can still vote.",
      );
    const id = randomUUID();
    db.prepare(
      "INSERT INTO questions(id,generation,text,created_at) VALUES(?,?,?,?)",
    ).run(id, s.generation, questionText, Date.now());
    boardChanged(s);
    return { questionId: id, generation: s.generation };
  });
}
export function vote(visitorId: string, questionId: unknown, voted: boolean) {
  return transaction(() => {
    const s = requireLive();
    const id = question(s, questionId);
    const change = voted
      ? db
          .prepare(
            "INSERT OR IGNORE INTO votes(visitor_id,question_id) VALUES(?,?)",
          )
          .run(visitorId, id)
      : db
          .prepare("DELETE FROM votes WHERE visitor_id=? AND question_id=?")
          .run(visitorId, id);
    if (change.changes) boardChanged(s);
    return {
      ok: true,
      voted,
      votes: db
        .prepare("SELECT COUNT(*) AS n FROM votes WHERE question_id=?")
        .get(id)!.n,
    };
  });
}

// Host ---------------------------------------------------------------------

export function create(input: { title?: unknown; talkingPoints?: unknown }) {
  return transaction(() => {
    const id = randomUUID();
    const generation = randomUUID();
    db.prepare(
      "INSERT INTO sessions(id,generation,title,talking_points,created_at) VALUES(?,?,?,?,?)",
    ).run(
      id,
      generation,
      title(input.title),
      talkingPoints(input.talkingPoints),
      Date.now(),
    );
    activity(generation, "session", "Session created.");
    return { sessionId: id, generation };
  });
}
export function update(
  s: SessionRow,
  input: { title?: unknown; talkingPoints?: unknown },
) {
  transaction(() => {
    if (input.title !== undefined)
      db.prepare("UPDATE sessions SET title=? WHERE id=?").run(
        title(input.title),
        s.id,
      );
    if (input.talkingPoints !== undefined)
      db.prepare("UPDATE sessions SET talking_points=? WHERE id=?").run(
        talkingPoints(input.talkingPoints),
        s.id,
      );
    activity(s.generation, "session", "Session details updated.");
  });
}
/**
 * Makes `s` the one live session or pauses it. Returns the session that was
 * paused to make room, if any.
 */
export function setLive(s: SessionRow, value: boolean) {
  return transaction(() => {
    if (!value) {
      if (s.live) pause(s, "Session paused.");
      return undefined;
    }
    const previous = liveSession();
    const displaced = previous && previous.id !== s.id ? previous : undefined;
    if (displaced)
      pause(displaced, "Session paused; another session went live.");
    if (!s.live) {
      db.prepare("UPDATE sessions SET live=1 WHERE id=?").run(s.id);
      activity(s.generation, "resume", "Session is live.");
    }
    return displaced;
  });
}
function pause(s: SessionRow, message: string) {
  db.prepare("UPDATE sessions SET live=0 WHERE id=?").run(s.id);
  cancelAgentWork(s.id);
  activity(s.generation, "pause", message);
}
/** Clears the session's questions and run state under a new generation. */
export function reset(s: SessionRow, confirmation: unknown) {
  if (confirmation !== "RESET")
    fail(400, "CONFIRMATION_REQUIRED", "Type RESET to clear this session.");
  return transaction(() => {
    const generation = randomUUID();
    for (const table of generationTables)
      db.prepare(`DELETE FROM ${table} WHERE generation=?`).run(s.generation);
    const columns = Object.keys(runState);
    db.prepare(
      `UPDATE sessions SET generation=?,${columns.map((c) => `${c}=?`).join(",")} WHERE id=?`,
    ).run(generation, ...Object.values(runState), s.id);
    cancelAgentWork(s.id);
    activity(generation, "reset", "Session questions were cleared.");
    return { generation };
  });
}
export function setIntakePaused(s: SessionRow, value: boolean) {
  transaction(() => {
    db.prepare("UPDATE sessions SET intake_paused=? WHERE id=?").run(
      Number(value),
      s.id,
    );
    activity(
      s.generation,
      value ? "pause" : "resume",
      `Question intake ${value ? "paused" : "resumed"}.`,
    );
  });
}
export function setAgentPaused(s: SessionRow, value: boolean) {
  transaction(() => {
    const change = db
      .prepare(
        "UPDATE sessions SET agent_paused=? WHERE id=? AND agent_paused<>?",
      )
      .run(Number(value), s.id, Number(value));
    if (change.changes) cancelAgentWork(s.id);
    activity(
      s.generation,
      value ? "pause" : "resume",
      `Agent processing ${value ? "paused" : "resumed"}.`,
    );
  });
}
/** Puts a question on the broadcast, or clears it with `null`. */
export function select(s: SessionRow, questionId: unknown) {
  transaction(() => {
    const id = questionId === null ? null : question(s, questionId);
    if (
      id &&
      db.prepare("SELECT hidden FROM questions WHERE id=?").get(id)?.hidden
    )
      fail(
        409,
        "QUESTION_HIDDEN",
        "Unhide this question before broadcasting it.",
      );
    db.prepare("UPDATE sessions SET selected_id=? WHERE id=?").run(id, s.id);
    activity(
      s.generation,
      "broadcast",
      id
        ? "Host selected a question for broadcast."
        : "Host cleared the broadcast.",
      undefined,
      id ?? undefined,
    );
  });
}
function setQuestionFlag(
  s: SessionRow,
  questionId: unknown,
  column: "speaker_answered" | "hidden",
  value: boolean,
) {
  const id = question(s, questionId);
  const change = db
    .prepare(`UPDATE questions SET ${column}=? WHERE id=? AND ${column}<>?`)
    .run(Number(value), id, Number(value));
  return { id, changed: !!change.changes };
}
/** Speaker-answered questions leave the agent's queue, so the board changes. */
export function markAnswered(
  s: SessionRow,
  questionId: unknown,
  value: boolean,
) {
  transaction(() => {
    const { id, changed } = setQuestionFlag(
      s,
      questionId,
      "speaker_answered",
      value,
    );
    if (changed) boardChanged(s);
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
  transaction(() => {
    const { id } = setQuestionFlag(s, questionId, "hidden", value);
    if (value)
      db.prepare(
        "UPDATE sessions SET selected_id=NULL WHERE id=? AND selected_id=?",
      ).run(s.id, id);
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
  transaction(() => {
    db.prepare("UPDATE sessions SET closing_requested=1 WHERE id=?").run(s.id);
    activity(
      s.generation,
      "closing",
      "Host requested a recommended question order.",
    );
  });
}
