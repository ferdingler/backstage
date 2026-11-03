"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import QRCode from "qrcode";
import {
  AgentReply,
  EmptyState,
  Header,
  HostState,
  Icon,
  Notice,
  Question,
  QuestionStatus,
  isAgentHealthy,
  plural,
  request,
  timeLabel,
  useAutoClear,
  useLiveState,
} from "../ui";

type Control = {
  action: string;
  questionId?: string | null;
  value?: boolean;
  confirmation?: string;
};

type Tab = "votes" | "recommended" | "talking";
const TITLE_MAX = 120;
const TALKING_POINTS_MAX = 50_000;

/** Opens and closes a native modal dialog in step with `open`. */
function useModal(open: boolean, onOpen?: () => void) {
  const ref = useRef<HTMLDialogElement>(null);
  const opened = useRef(onOpen);
  opened.current = onOpen;
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      opened.current?.();
      dialog.showModal();
    } else if (!open && dialog.open) dialog.close();
  }, [open]);
  return ref;
}

function NewSessionDialog({
  open,
  busy,
  close,
  create,
}: {
  open: boolean;
  busy: boolean;
  close: () => void;
  create: (title: string, talkingPoints: string) => void;
}) {
  const [title, setTitle] = useState("");
  const [points, setPoints] = useState("");
  const ref = useModal(open, () => {
    setTitle("");
    setPoints("");
  });
  return (
    <dialog
      ref={ref}
      className="dialog wide"
      aria-labelledby="new-session-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) close();
      }}
      onClose={() => open && close()}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (title.trim()) create(title.trim(), points);
        }}
      >
        <h2 id="new-session-title" className="dialog-title">
          New session
        </h2>
        <p className="dialog-text">
          Starts paused. Go live when you are ready for questions.
        </p>
        <label className="label" htmlFor="new-session-name">
          Title
        </label>
        <input
          id="new-session-name"
          className="input text"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          maxLength={TITLE_MAX}
          autoComplete="off"
          autoFocus
          required
          disabled={busy}
        />
        <label className="label spaced" htmlFor="new-session-points">
          Talking points <span className="optional">(optional)</span>
        </label>
        <textarea
          id="new-session-points"
          className="input notes"
          rows={8}
          value={points}
          onChange={(event) => setPoints(event.target.value)}
          maxLength={TALKING_POINTS_MAX}
          disabled={busy}
        />
        <div className="dialog-actions">
          <button
            className="button"
            type="button"
            onClick={close}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            className="button primary"
            type="submit"
            disabled={!title.trim() || busy}
          >
            {busy ? "Creating…" : "Create session"}
          </button>
        </div>
      </form>
    </dialog>
  );
}

function TalkingPoints({
  session,
  busy,
  save,
  onDirtyChange,
}: {
  session: HostState["session"];
  busy: boolean;
  save: (title: string, talkingPoints: string) => Promise<boolean>;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const [baseline, setBaseline] = useState({
    id: session.id,
    title: session.title,
    points: session.talkingPoints,
  });
  const [title, setTitle] = useState(session.title);
  const [points, setPoints] = useState(session.talkingPoints);
  const dirty = title !== baseline.title || points !== baseline.points;
  // Follow server changes unless the host has unsaved edits.
  useEffect(() => {
    if (
      session.id !== baseline.id ||
      (!dirty &&
        (session.title !== baseline.title ||
          session.talkingPoints !== baseline.points))
    ) {
      setBaseline({
        id: session.id,
        title: session.title,
        points: session.talkingPoints,
      });
      setTitle(session.title);
      setPoints(session.talkingPoints);
    }
  }, [session.id, session.title, session.talkingPoints, baseline, dirty]);
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);
  return (
    <form
      className="talking-points"
      onSubmit={async (event) => {
        event.preventDefault();
        if (!dirty || !title.trim()) return;
        if (await save(title.trim(), points))
          setBaseline({ id: session.id, title: title.trim(), points });
      }}
    >
      <label className="label" htmlFor="session-title-input">
        Title
      </label>
      <input
        id="session-title-input"
        className="input text"
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        maxLength={TITLE_MAX}
        autoComplete="off"
        required
      />
      <label className="label spaced" htmlFor="talking-points">
        Talking points
      </label>
      <p className="hint" id="talking-points-hint">
        The agent answers audience questions from these notes only.
      </p>
      <textarea
        id="talking-points"
        className="input notes tall"
        value={points}
        onChange={(event) => setPoints(event.target.value)}
        maxLength={TALKING_POINTS_MAX}
        aria-describedby="talking-points-hint talking-points-count"
        placeholder="Key points, facts, and links the agent may use…"
      />
      <div className="panel-bar">
        <span id="talking-points-count" className="hint" aria-live="off">
          {points.length.toLocaleString()} /{" "}
          {TALKING_POINTS_MAX.toLocaleString()}
          {dirty && " · Unsaved changes"}
        </span>
        <button
          type="submit"
          className="button primary"
          disabled={!dirty || busy || !title.trim()}
          data-dirty={dirty}
        >
          {busy ? "Saving…" : "Save"}
        </button>
      </div>
    </form>
  );
}

function agentLabel(status: string) {
  const labels: Record<string, string> = {
    idle: "Ready",
    processing: "Working",
    paused: "Paused",
    retrying: "Retrying",
    "over-budget": "Out of budget",
    elsewhere: "On another session",
  };
  return labels[status] || "Offline";
}

function JoinCard({ url }: { url: string }) {
  const [image, setImage] = useState("");
  useEffect(() => {
    let current = true;
    QRCode.toDataURL(url, {
      width: 320,
      margin: 1,
      color: { dark: "#111111", light: "#ffffff" },
      errorCorrectionLevel: "M",
    })
      .then((value) => current && setImage(value))
      .catch(() => current && setImage(""));
    return () => {
      current = false;
    };
  }, [url]);
  return (
    <section className="card" aria-labelledby="join-title">
      <h2 id="join-title" className="card-title">
        Audience link
      </h2>
      {image && (
        <img
          className="qr"
          src={image}
          width={160}
          height={160}
          alt={`QR code linking to ${url}`}
        />
      )}
      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        className="link-url"
        data-audience-url={url}
      >
        {url}
      </a>
    </section>
  );
}

function ResetDialog({
  open,
  busy,
  close,
  reset,
}: {
  open: boolean;
  busy: boolean;
  close: () => void;
  reset: () => void;
}) {
  const [confirmation, setConfirmation] = useState("");
  const ref = useModal(open, () => setConfirmation(""));
  return (
    <dialog
      ref={ref}
      className="dialog"
      aria-labelledby="reset-title"
      aria-describedby="reset-description"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) close();
      }}
      onClose={() => open && close()}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (confirmation === "RESET") reset();
        }}
      >
        <h2 id="reset-title" className="dialog-title">
          Reset session?
        </h2>
        <p id="reset-description" className="dialog-text">
          This permanently clears this session’s questions, votes, replies,
          and recommendations. The title and talking points are kept.
        </p>
        <label className="label" htmlFor="reset-confirm">
          Type RESET to confirm
        </label>
        <input
          id="reset-confirm"
          className="input code"
          value={confirmation}
          onChange={(event) => setConfirmation(event.target.value)}
          autoComplete="off"
          spellCheck={false}
          autoFocus
          disabled={busy}
        />
        <div className="dialog-actions">
          <button
            className="button"
            type="button"
            onClick={close}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            className="button danger"
            type="submit"
            disabled={confirmation !== "RESET" || busy}
          >
            {busy ? "Resetting…" : "Reset"}
          </button>
        </div>
      </form>
    </dialog>
  );
}

function Switch({
  id,
  label,
  description,
  checked,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  description: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <div className="switch-row">
      <div>
        <label htmlFor={id} className="switch-label">
          {label}
        </label>
        <p id={`${id}-description`} className="hint">
          {description}
        </p>
      </div>
      <button
        id={id}
        type="button"
        role="switch"
        className="switch"
        aria-checked={checked}
        aria-describedby={`${id}-description`}
        disabled={disabled}
        onClick={() => onChange(!checked)}
      >
        <span aria-hidden="true" />
      </button>
    </div>
  );
}

function HostQuestion({
  question,
  rank,
  reason,
  pending,
  control,
  showReply,
}: {
  question: Question;
  rank: number;
  reason?: string;
  pending: boolean;
  control: (payload: Control) => void;
  showReply: boolean;
}) {
  const textId = `q-${question.id}`;
  return (
    <li
      className={`item ${question.selected ? "is-selected" : ""} ${question.hidden ? "is-hidden" : ""} ${question.speakerAnswered ? "is-answered" : ""}`}
      data-question-id={question.id}
      data-votes={question.votes}
      data-selected={question.selected}
      data-answered={question.speakerAnswered}
      data-hidden={question.hidden}
    >
      <article className="item-row" aria-labelledby={textId}>
        <span className="rank" aria-hidden="true">
          {rank}
        </span>
        <div className="item-body">
          <p className="item-text" id={textId}>
            {question.text}
          </p>
          <div className="meta">
            <span className="votes-inline">
              <Icon name="up" size={16} />
              {plural(question.votes, "vote")}
            </span>
            <time dateTime={new Date(question.createdAt).toISOString()}>
              {timeLabel(question.createdAt)}
            </time>
            <QuestionStatus question={question} />
            {question.hidden && (
              <span className="tag warn">
                <Icon name="hidden" size={14} />
                Hidden
              </span>
            )}
            {question.reply && !showReply && (
              <span className="tag">
                <Icon name="spark" size={14} />
                Agent replied
              </span>
            )}
          </div>
          {reason && (
            <p className="reason">
              <span className="sr-only">Agent’s reason: </span>
              {reason}
            </p>
          )}
          {showReply && <AgentReply question={question} />}
          <div className="actions">
            <button
              type="button"
              className={`button small ${question.selected ? "primary" : ""}`}
              aria-describedby={textId}
              aria-pressed={question.selected}
              disabled={pending || question.hidden}
              onClick={() =>
                control({
                  action: "select",
                  questionId: question.selected ? null : question.id,
                })
              }
            >
              <Icon name="screen" size={16} />
              {question.selected ? "On screen" : "Show on screen"}
            </button>
            <button
              type="button"
              className="button small"
              aria-describedby={textId}
              aria-pressed={question.speakerAnswered}
              disabled={pending}
              onClick={() =>
                control({
                  action: "answered",
                  questionId: question.id,
                  value: !question.speakerAnswered,
                })
              }
            >
              <Icon name="check" size={16} />
              {question.speakerAnswered ? "Answered" : "Mark answered"}
            </button>
            <button
              type="button"
              className="button small subtle"
              aria-describedby={textId}
              aria-pressed={question.hidden}
              disabled={pending}
              onClick={() =>
                control({
                  action: "hide",
                  questionId: question.id,
                  value: !question.hidden,
                })
              }
            >
              <Icon name="hidden" size={16} />
              {question.hidden ? "Unhide" : "Hide"}
            </button>
          </div>
        </div>
      </article>
    </li>
  );
}

function sessionUrl(id: string | null) {
  return id ? `/host?session=${encodeURIComponent(id)}` : "/host";
}

export default function HostPage() {
  // undefined until the URL has been read on the client.
  const [sessionId, setSessionId] = useState<string | null | undefined>();
  useEffect(() => {
    const read = () =>
      setSessionId(new URLSearchParams(location.search).get("session"));
    read();
    window.addEventListener("popstate", read);
    return () => window.removeEventListener("popstate", read);
  }, []);
  const {
    data: latest,
    error,
    refresh,
  } = useLiveState<HostState>(
    sessionId === undefined
      ? null
      : `/api/host/state${sessionId ? `?session=${encodeURIComponent(sessionId)}` : ""}`,
  );
  // Never act on a previous session's data while the next one loads.
  const data =
    latest && (!sessionId || latest.session.id === sessionId) ? latest : null;
  useEffect(() => {
    if (data && !sessionId)
      history.replaceState(null, "", sessionUrl(data.session.id));
  }, [data, sessionId]);
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  const [newOpen, setNewOpen] = useState(false);
  const [message, setMessage] = useState<{
    text: string;
    error: boolean;
  } | null>(null);
  useAutoClear(message, setMessage);
  const [pending, setPending] = useState("");
  const [resetOpen, setResetOpen] = useState(false);
  const [tab, setTab] = useState<Tab>("votes");
  const [showAnswered, setShowAnswered] = useState(false);
  const [showReplies, setShowReplies] = useState(false);
  const tabRefs = useRef<Record<Tab, HTMLButtonElement | null>>({
    votes: null,
    recommended: null,
    talking: null,
  });

  function selectSession(id: string) {
    if (data && id === data.session.id) return;
    if (dirty && !confirm("Discard unsaved talking points?")) return;
    setDirty(false);
    history.pushState(null, "", sessionUrl(id));
    setSessionId(id);
    setMessage(null);
  }

  const questions = useMemo(
    () =>
      [...(data?.questions || [])].sort(
        (a, b) =>
          Number(a.speakerAnswered) - Number(b.speakerAnswered) ||
          b.votes - a.votes ||
          a.createdAt - b.createdAt,
      ),
    [data?.questions],
  );
  const questionMap = new Map(questions.map((q) => [q.id, q]));
  const visibleQuestions = showAnswered
    ? questions
    : questions.filter((q) => !q.speakerAnswered);
  const answered = questions.filter((q) => q.speakerAnswered).length;
  const selected = questions.find(
    (q) => q.id === data?.event.selectedQuestionId && !q.hidden,
  );
  const agentStatus = data?.agent.status || "disconnected";
  const live = !!data?.session.live;
  const recommendation = data?.recommendation;
  const queue = (recommendation?.queue || []).flatMap((item) => {
    const question = questionMap.get(item.questionId);
    return question && (showAnswered || !question.speakerAnswered)
      ? [{ ...item, question }]
      : [];
  });

  async function control(
    payload: Control & { title?: string; talkingPoints?: string },
  ): Promise<Record<string, unknown> | null> {
    if (!data) return null;
    setPending(payload.action + (payload.questionId || ""));
    setMessage(null);
    try {
      const result = await request<Record<string, unknown>>(
        "/api/host/control",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(
            payload.action === "create-session"
              ? payload
              : { generation: data.event.generation, ...payload },
          ),
        },
      );
      if (payload.action === "reset") {
        setResetOpen(false);
        setMessage({ text: "Session reset.", error: false });
      }
      if (payload.action === "create-session") {
        setNewOpen(false);
        selectSession(String(result.sessionId));
        setTab("votes");
        setMessage({
          text: "Session created. Go live when you are ready.",
          error: false,
        });
      }
      if (payload.action === "update-session")
        setMessage({ text: "Saved.", error: false });
      if (payload.action === "live") {
        const paused = result.paused as { title: string } | null;
        setMessage({
          text: payload.value
            ? paused
              ? `Session is live. “${paused.title}” was paused.`
              : "Session is live."
            : "Session paused. The audience sees a waiting screen.",
          error: false,
        });
      }
      if (payload.action === "closing")
        setMessage({
          text: "Recommendations requested. They appear once the agent has run.",
          error: false,
        });
      refresh();
      return result;
    } catch (error) {
      setMessage({
        text:
          error instanceof Error
            ? error.message
            : "That action couldn’t be saved. Please try again.",
        error: true,
      });
      refresh();
      return null;
    } finally {
      setPending("");
    }
  }

  function tabKey(event: React.KeyboardEvent) {
    const order: Tab[] = ["votes", "recommended", "talking"];
    const index = order.indexOf(tab);
    let next: Tab | undefined;
    if (event.key === "ArrowRight") next = order[(index + 1) % order.length];
    if (event.key === "ArrowLeft")
      next = order[(index - 1 + order.length) % order.length];
    if (event.key === "Home") next = order[0];
    if (event.key === "End") next = order[order.length - 1];
    if (!next) return;
    event.preventDefault();
    setTab(next);
    tabRefs.current[next]?.focus();
  }

  return (
    <>
      <Header label="Host" connected={data ? !error : null}>
        <a
          className="button small"
          href="/broadcast"
          target="_blank"
          rel="noreferrer"
        >
          <Icon name="screen" size={16} />
          Broadcast
          <span className="sr-only"> (opens in a new tab)</span>
        </a>
      </Header>
      <main id="main" tabIndex={-1} className="page wide">
        {latest ? (
          <section className="session-bar" aria-label="Session">
            <div className="session-heading">
              <h1 className="session-title">
                {data?.session.title ?? "Loading…"}
              </h1>
              {data && (
                <span
                  className={`tag ${live ? "good" : ""}`}
                  data-session-live={live}
                >
                  <span
                    className={`status-dot ${live ? "good" : ""}`}
                    aria-hidden="true"
                  />
                  {live ? "Live" : "Paused"}
                </span>
              )}
            </div>
            <div className="session-actions">
              <label className="sr-only" htmlFor="session-select">
                Switch session
              </label>
              <select
                id="session-select"
                className="select"
                value={data?.session.id ?? sessionId ?? ""}
                onChange={(event) => selectSession(event.target.value)}
              >
                {latest.sessions.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.title}
                    {item.live ? " · Live" : ""} · {item.questionCount}{" "}
                    {item.questionCount === 1 ? "question" : "questions"}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="button"
                disabled={!data}
                onClick={() => setNewOpen(true)}
              >
                <Icon name="plus" size={18} />
                New session
              </button>
              <button
                type="button"
                className={`button ${live ? "" : "primary"}`}
                disabled={!data || pending === "live"}
                aria-describedby="live-hint"
                onClick={() => control({ action: "live", value: !live })}
              >
                <Icon name={live ? "pause" : "play"} size={18} />
                {live ? "Pause session" : "Go live"}
              </button>
              <span id="live-hint" className="sr-only">
                Only one session can be live. Going live pauses any other live
                session.
              </span>
            </div>
          </section>
        ) : (
          <h1 className="sr-only">Host</h1>
        )}

        <div className="notices" aria-live="polite">
          {message && (
            <Notice tone={message.error ? "error" : "info"}>
              {message.text}
            </Notice>
          )}
          {error && data && (
            <Notice tone="error">{error} Showing the last update.</Notice>
          )}
        </div>

        {!data ? (
          error ? (
            <EmptyState title="Can’t load this session">
              {error}{" "}
              {sessionId && <a href="/host">Open the current session</a>}
            </EmptyState>
          ) : (
            <EmptyState title="Loading session…" loading />
          )
        ) : (
          <>
            <dl className="stats" aria-label="Session summary">
              <div className="stat">
                <dt>Questions</dt>
                <dd data-stat="questions">{questions.length}</dd>
              </div>
              <div className="stat">
                <dt>Answered</dt>
                <dd data-stat="answered">{answered}</dd>
              </div>
              <div className="stat">
                <dt>Agent</dt>
                <dd data-stat="agent" data-agent-status={agentStatus}>
                  <span
                    className={`status-dot ${isAgentHealthy(agentStatus) ? "good" : "off"}`}
                    aria-hidden="true"
                  />
                  <span className="stat-text">
                    {agentLabel(agentStatus)}
                  </span>
                </dd>
                <dd className="stat-sub">
                  {data.worker.lastSeenAt
                    ? `Seen ${timeLabel(data.worker.lastSeenAt)}`
                    : "Never seen"}
                </dd>
              </div>
              <div className="stat">
                <dt>Model calls</dt>
                <dd data-stat="model-calls">
                  {data.budget.used}
                  <span className="stat-of"> / {data.budget.limit}</span>
                </dd>
                <dd className="stat-sub">
                  {[
                    data.budget.reserved > 0 &&
                      `${data.budget.reserved} in use`,
                    data.budget.closingReserve > 0 &&
                      `${data.budget.closingReserve} held for recommendations`,
                  ]
                    .filter(Boolean)
                    .join(" · ") || "\u00a0"}
                </dd>
              </div>
            </dl>

            <div className="host-grid">
              <section className="host-main" aria-label="Questions">
                <div className="section-head">
                  <div
                    className="tabs"
                    role="tablist"
                    aria-label="Question views"
                    onKeyDown={tabKey}
                  >
                    {(
                      [
                        ["votes", "By votes", visibleQuestions.length],
                        ["recommended", "Recommended", queue.length],
                        ["talking", "Talking points", null],
                      ] as const
                    ).map(([value, label, count]) => (
                      <button
                        key={value}
                        ref={(element) => {
                          tabRefs.current[value] = element;
                        }}
                        type="button"
                        role="tab"
                        id={`tab-${value}`}
                        aria-controls={`panel-${value}`}
                        aria-selected={tab === value}
                        tabIndex={tab === value ? 0 : -1}
                        onClick={() => setTab(value)}
                      >
                        {label}
                        {count !== null && <span className="count">{count}</span>}
                      </button>
                    ))}
                  </div>
                  <div className="filters" hidden={tab === "talking"}>
                    <label className="check">
                      <input
                        type="checkbox"
                        checked={showAnswered}
                        onChange={(e) => setShowAnswered(e.target.checked)}
                      />
                      Show answered
                    </label>
                    <label className="check">
                      <input
                        type="checkbox"
                        checked={showReplies}
                        onChange={(e) => setShowReplies(e.target.checked)}
                      />
                      Show replies
                    </label>
                  </div>
                </div>

                <div
                  role="tabpanel"
                  id="panel-votes"
                  aria-labelledby="tab-votes"
                  hidden={tab !== "votes"}
                  tabIndex={0}
                  className="panel"
                >
                  {visibleQuestions.length ? (
                    <ol className="list">
                      {visibleQuestions.map((question, index) => (
                        <HostQuestion
                          key={question.id}
                          question={question}
                          rank={index + 1}
                          control={control}
                          pending={!!pending}
                          showReply={showReplies}
                        />
                      ))}
                    </ol>
                  ) : (
                    <EmptyState
                      title={
                        questions.length ? "All answered" : "No questions yet"
                      }
                    >
                      {questions.length
                        ? "Turn on “Show answered” to review them."
                        : "Questions from the audience appear here."}
                    </EmptyState>
                  )}
                </div>

                <div
                  role="tabpanel"
                  id="panel-recommended"
                  aria-labelledby="tab-recommended"
                  hidden={tab !== "recommended"}
                  tabIndex={0}
                  className="panel"
                >
                  <div className="panel-bar">
                    <p className="hint">
                      {recommendation
                        ? `Agent-suggested order · ${timeLabel(recommendation.createdAt)}`
                        : "Agent-suggested order, based on audience votes."}
                    </p>
                    <button
                      type="button"
                      className="button small"
                      disabled={pending === "closing"}
                      onClick={() => control({ action: "closing" })}
                    >
                      <Icon name="spark" size={16} />
                      {pending === "closing"
                        ? "Requesting…"
                        : recommendation
                          ? "Refresh"
                          : "Recommend order"}
                    </button>
                  </div>
                  {recommendation?.stale && (
                    <Notice>
                      Questions changed since this was generated. Refresh for
                      an up-to-date order.
                    </Notice>
                  )}
                  {queue.length ? (
                    <ol className="list">
                      {queue.map((item, index) => (
                        <HostQuestion
                          key={item.questionId}
                          question={item.question}
                          rank={index + 1}
                          reason={item.reason}
                          pending={!!pending}
                          control={control}
                          showReply={showReplies}
                        />
                      ))}
                    </ol>
                  ) : (
                    <EmptyState
                      title={
                        recommendation
                          ? "Nothing left to recommend"
                          : "No recommendations yet"
                      }
                    >
                      {data.event.agentPaused
                        ? "The agent is paused. Resume it to generate recommendations."
                        : recommendation
                          ? "Pick any question from the votes view."
                          : "Request an order when you are ready to take questions."}
                    </EmptyState>
                  )}
                  {!!recommendation?.groups.length && (
                    <div className="groups">
                      <h3 className="subhead">Related questions</h3>
                      {recommendation.groups.map((group, index) => (
                        <section className="group" key={index}>
                          <h4 className="group-title">{group.title}</h4>
                          <ul className="group-list">
                            {group.questionIds.map((id) => {
                              const question = questionMap.get(id);
                              return question ? (
                                <li key={id} data-question-id={id}>
                                  <span>{question.text}</span>
                                  <span className="group-votes">
                                    {plural(question.votes, "vote")}
                                  </span>
                                </li>
                              ) : null;
                            })}
                          </ul>
                        </section>
                      ))}
                      <p className="hint">
                        Groups are suggestions. Each question keeps its own
                        votes.
                      </p>
                    </div>
                  )}
                </div>

                <div
                  role="tabpanel"
                  id="panel-talking"
                  aria-labelledby="tab-talking"
                  hidden={tab !== "talking"}
                  className="panel"
                >
                  <TalkingPoints
                    session={data.session}
                    busy={pending === "update-session"}
                    onDirtyChange={setDirty}
                    save={async (title, talkingPoints) =>
                      !!(await control({
                        action: "update-session",
                        title,
                        talkingPoints,
                      }))
                    }
                  />
                </div>
              </section>

              <aside className="host-side" aria-label="Session controls">
                <section
                  className={`card on-screen ${selected ? "active" : ""}`}
                  aria-labelledby="screen-title"
                >
                  <h2 id="screen-title" className="card-title">
                    <Icon name="screen" size={18} />
                    On screen
                  </h2>
                  {selected ? (
                    <>
                      <p className="on-screen-text" data-selected-id={selected.id}>
                        {selected.text}
                      </p>
                      <button
                        type="button"
                        className="button small"
                        disabled={pending.startsWith("select")}
                        onClick={() =>
                          control({ action: "select", questionId: null })
                        }
                      >
                        Clear screen
                      </button>
                    </>
                  ) : (
                    <p className="hint">Nothing selected.</p>
                  )}
                </section>

                <section className="card" aria-labelledby="controls-title">
                  <h2 id="controls-title" className="card-title">
                    Controls
                  </h2>
                  <Switch
                    id="intake"
                    label="Accept questions"
                    description={
                      data.event.intakeExhausted
                        ? `Limit of ${data.event.questionCap} reached`
                        : data.event.intakePaused
                          ? "Paused · voting stays open"
                          : "Open"
                    }
                    checked={!data.event.intakePaused}
                    disabled={pending === "intake"}
                    onChange={(value) =>
                      control({ action: "intake", value: !value })
                    }
                  />
                  <Switch
                    id="agent"
                    label="Agent"
                    description={
                      data.event.agentPaused
                        ? "Paused"
                        : live
                          ? "Allowed to run"
                          : "Runs while the session is live"
                    }
                    checked={!data.event.agentPaused}
                    disabled={pending === "agent"}
                    onChange={(value) =>
                      control({ action: "agent", value: !value })
                    }
                  />
                  <button
                    type="button"
                    className="button small subtle danger-text"
                    onClick={() => setResetOpen(true)}
                  >
                    Reset session…
                  </button>
                </section>

                <JoinCard url={data.event.audienceUrl} />
              </aside>
            </div>

            <details className="activity">
              <summary>
                Activity
                <span className="count">{data.activity.length}</span>
              </summary>
              <p className="hint">
                Application events from the agent worker. Sandbox policy
                decisions are logged separately.
              </p>
              {data.activity.length ? (
                <ol className="activity-list">
                  {data.activity.map((event) => (
                    <li key={event.id} data-kind={event.kind}>
                      <time dateTime={new Date(event.at).toISOString()}>
                        {timeLabel(event.at)}
                      </time>
                      <span className="activity-kind">
                        {event.kind.replaceAll("-", " ")}
                      </span>
                      <span className="activity-message">{event.message}</span>
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="hint">No activity yet.</p>
              )}
            </details>
          </>
        )}
      </main>
      <ResetDialog
        open={resetOpen}
        busy={pending === "reset"}
        close={() => setResetOpen(false)}
        reset={() => control({ action: "reset", confirmation: "RESET" })}
      />
      <NewSessionDialog
        open={newOpen}
        busy={pending === "create-session"}
        close={() => setNewOpen(false)}
        create={(title, talkingPoints) =>
          control({ action: "create-session", title, talkingPoints })
        }
      />
    </>
  );
}
