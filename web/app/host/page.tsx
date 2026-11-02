"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import QRCode from "qrcode";
import {
  AgentReply,
  Brand,
  EmptyState,
  HostState,
  Icon,
  Question,
  QuestionStatus,
  request,
  statusLabel,
  timeLabel,
  useLiveState,
} from "../ui";

type Control = {
  action: string;
  questionId?: string | null;
  value?: boolean;
  confirmation?: string;
};

function AudienceQR({ url }: { url: string }) {
  const [image, setImage] = useState("");
  useEffect(() => {
    let current = true;
    QRCode.toDataURL(url, {
      width: 220,
      margin: 2,
      color: { dark: "#292922", light: "#fffefa" },
      errorCorrectionLevel: "M",
    })
      .then((value) => {
        if (current) setImage(value);
      })
      .catch(() => {
        if (current) setImage("");
      });
    return () => {
      current = false;
    };
  }, [url]);
  return (
    <section className="qr-panel">
      <h2>Bring the room in</h2>
      <p>Scan to ask a question or cast a vote.</p>
      {image ? (
        <img
          className="qr-img"
          src={image}
          width={142}
          height={142}
          alt={`QR code for the audience page: ${url}`}
        />
      ) : (
        <p>Preparing the QR code…</p>
      )}
      <a href={url} target="_blank" rel="noreferrer" className="qr-link">
        {url}
      </a>
    </section>
  );
}

function ResetDialog({
  busy,
  close,
  reset,
}: {
  busy: boolean;
  close: () => void;
  reset: () => void;
}) {
  const [confirmation, setConfirmation] = useState("");
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    container.current?.querySelector("input")?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) close();
      if (event.key === "Tab") {
        const elements = Array.from(
          container.current?.querySelectorAll<HTMLElement>(
            "input:not(:disabled),button:not(:disabled)",
          ) || [],
        );
        const first = elements[0],
          last = elements.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener("keydown", keydown);
    return () => {
      document.removeEventListener("keydown", keydown);
      previous?.focus();
    };
  }, [busy, close]);
  return (
    <div className="dialog-backdrop">
      <div
        ref={container}
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="reset-title"
        aria-describedby="reset-description"
      >
        <h2 id="reset-title">Start a fresh session?</h2>
        <p id="reset-description">
          This clears all questions, votes, replies, and the current queue.
          In-flight agent results from this session will be discarded.
        </p>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (confirmation === "RESET") reset();
          }}
        >
          <label className="field-label" htmlFor="reset-confirm">
            Type RESET to confirm
          </label>
          <input
            id="reset-confirm"
            value={confirmation}
            onChange={(event) => setConfirmation(event.target.value)}
            autoComplete="off"
            disabled={busy}
          />
          <div className="dialog-actions">
            <button
              className="button ghost"
              type="button"
              onClick={close}
              disabled={busy}
            >
              Keep this session
            </button>
            <button
              className="button danger"
              type="submit"
              disabled={confirmation !== "RESET" || busy}
            >
              {busy ? "Resetting…" : "Reset session"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function HostQuestion({
  question,
  rank,
  reason,
  pending,
  control,
  showReply = false,
}: {
  question: Question;
  rank: number;
  reason?: string;
  pending: boolean;
  control: (payload: Control) => void;
  showReply?: boolean;
}) {
  return (
    <article
      className={`host-card ${question.selected ? "selected" : ""} ${question.hidden ? "hidden-question" : ""}`}
    >
      <div className="host-question-row">
        <span className="rank-number">{String(rank).padStart(2, "0")}</span>
        <div className="question-content">
          <div className="question-meta">
            <span className="host-votes">
              <Icon name="up" size={11} />
              {question.votes} {question.votes === 1 ? "vote" : "votes"}
            </span>
            <span>·</span>
            <QuestionStatus question={question} />
            {question.hidden && (
              <span className="status-pill warn">Hidden from broadcast</span>
            )}
          </div>
          <h3 className="question-text">{question.text}</h3>
          {reason && <p className="recommendation-reason">{reason}</p>}
        </div>
      </div>
      {showReply && <AgentReply question={question} />}
      <div className="host-actions">
        <button
          className={`button small ${question.selected ? "primary" : "ghost"}`}
          disabled={pending || question.hidden}
          onClick={() =>
            control({
              action: "select",
              questionId: question.selected ? null : question.id,
            })
          }
        >
          <Icon name="screen" size={12} />
          {question.selected ? "Clear screen" : "Show on screen"}
        </button>
        <button
          className="button ghost small"
          disabled={pending}
          onClick={() =>
            control({
              action: "answered",
              questionId: question.id,
              value: !question.speakerAnswered,
            })
          }
        >
          <Icon name="check" size={12} />
          {question.speakerAnswered ? "Reopen" : "Speaker answered"}
        </button>
        <button
          className="quiet-button"
          disabled={pending}
          onClick={() =>
            control({
              action: "hide",
              questionId: question.id,
              value: !question.hidden,
            })
          }
        >
          {question.hidden ? "Allow broadcast" : "Hide from broadcast"}
        </button>
      </div>
    </article>
  );
}

export default function HostPage() {
  const { data, error, refresh } = useLiveState<HostState>("/api/host/state");
  const [message, setMessage] = useState<{
    text: string;
    error: boolean;
  } | null>(null);
  const [pending, setPending] = useState("");
  const [resetOpen, setResetOpen] = useState(false);
  const [showAnswered, setShowAnswered] = useState(false);
  const [showReplies, setShowReplies] = useState(false);
  const questions = useMemo(
    () =>
      [...(data?.questions || [])].sort(
        (a, b) =>
          Number(a.speakerAnswered) - Number(b.speakerAnswered) ||
          b.votes - a.votes ||
          new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
      ),
    [data?.questions],
  );
  const visibleQuestions = showAnswered
    ? questions
    : questions.filter((question) => !question.speakerAnswered);
  const questionMap = new Map(
    questions.map((question) => [question.id, question]),
  );
  const answered = questions.filter(
    (question) => question.speakerAnswered,
  ).length;
  const selected = questions.find(
    (question) =>
      question.id === data?.event.selectedQuestionId && !question.hidden,
  );
  const agentStatus = data?.event.agentPaused
    ? "paused"
    : data?.worker.stale
      ? "disconnected"
      : data?.worker.status || "disconnected";
  const recommendation = data?.recommendation;
  const queue = (recommendation?.queue || []).flatMap((item) => {
    const question = questionMap.get(item.questionId);
    return question && !question.speakerAnswered ? [{ ...item, question }] : [];
  });

  async function control(payload: Control) {
    if (!data) return;
    setPending(payload.action + (payload.questionId || ""));
    setMessage(null);
    try {
      await request("/api/host/control", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ generation: data.event.generation, ...payload }),
      });
      if (payload.action === "reset") {
        setResetOpen(false);
        setMessage({
          text: "Fresh session ready. The previous generation is closed.",
          error: false,
        });
      }
      if (payload.action === "closing")
        setMessage({
          text: "Closing Q&A requested. The agent will prepare the queue when it is running and unpaused.",
          error: false,
        });
      refresh();
    } catch (error) {
      setMessage({
        text:
          error instanceof Error
            ? error.message
            : "That action couldn’t be saved. Please try again.",
        error: true,
      });
      refresh();
    } finally {
      setPending("");
    }
  }

  return (
    <div className="host-shell">
      <header className="topbar host-topbar">
        <div className="host-brand">
          <Brand href="/host" />
          <span className="eyebrow">Presenter desk</span>
        </div>
        <div className="toolbar">
          <span className="status-pill neutral">
            <Icon name="lock" size={11} />
            Private
          </span>
          <a
            className="button ghost small"
            href="/broadcast"
            target="_blank"
            rel="noreferrer"
          >
            <Icon name="screen" size={14} />
            Open broadcast
          </a>
        </div>
      </header>
      <main>
        <section className="host-heading">
          <div>
            <h1>You have the floor.</h1>
            <p>The room asks. Backstage assists. You decide what comes next.</p>
          </div>
          <button
            className="button primary"
            disabled={!data || pending === "closing"}
            onClick={() => control({ action: "closing" })}
          >
            <Icon name="spark" size={14} />
            {pending === "closing" ? "Requesting…" : "Prepare closing Q&A"}
          </button>
        </section>
        {error && (
          <p className="message error connection-notice" role="status">
            {error} Displaying the last available state.
          </p>
        )}
        {message && (
          <p
            className={`message connection-notice ${message.error ? "error" : ""}`}
            role={message.error ? "alert" : "status"}
          >
            {message.text}
          </p>
        )}
        {!data ? (
          <EmptyState title="Opening the presenter desk…" loading>
            Loading this session’s questions and controls.
          </EmptyState>
        ) : (
          <>
            <section className="session-strip" aria-label="Session status">
              <div className="session-stat">
                <div className="eyebrow">In the room</div>
                <div className="session-value">
                  {questions.length}
                  <span style={{ fontSize: 11, color: "#c4c5b5" }}>
                    questions
                  </span>
                </div>
              </div>
              <div className="session-stat">
                <div className="eyebrow">On the mic</div>
                <div className="session-value">
                  {answered}
                  <span style={{ fontSize: 11, color: "#c4c5b5" }}>
                    answered
                  </span>
                </div>
              </div>
              <div className="session-stat">
                <div className="eyebrow">Backstage agent</div>
                <div className="session-value small">
                  <span
                    className="dot"
                    style={{
                      color:
                        agentStatus === "idle" || agentStatus === "processing"
                          ? "#b8c49d"
                          : "#d7a282",
                    }}
                  />
                  {statusLabel(agentStatus)}
                </div>
              </div>
              <div className="session-stat">
                <div className="eyebrow">Model calls</div>
                <div className="session-value">
                  {data.budget.used}
                  <span style={{ fontSize: 11, color: "#c4c5b5" }}>
                    / {data.budget.limit}
                    {data.budget.reserved > 0
                      ? ` · ${data.budget.reserved} held`
                      : ""}
                  </span>
                </div>
              </div>
              <div className="session-aside">
                {data.worker.lastSeenAt
                  ? `Last heartbeat ${timeLabel(data.worker.lastSeenAt)}`
                  : "No worker heartbeat yet"}
                <br />
                {data.budget.closingReserve} calls reserved for closing Q&A
              </div>
            </section>
            <div className="host-grid">
              <section aria-labelledby="vote-view-title">
                <div className="panel-heading">
                  <h2 id="vote-view-title">
                    The audience queue{" "}
                    <span className="count">{visibleQuestions.length}</span>
                  </h2>
                  <span className="eyebrow">By votes</span>
                </div>
                <div
                  className="question-meta"
                  style={{ justifyContent: "space-between", marginBottom: 16 }}
                >
                  <button
                    className="quiet-button"
                    onClick={() => setShowAnswered(!showAnswered)}
                  >
                    {showAnswered
                      ? "Hide answered questions"
                      : `Show answered (${answered})`}
                  </button>
                  <button
                    className="quiet-button"
                    onClick={() => setShowReplies(!showReplies)}
                  >
                    {showReplies ? "Hide agent replies" : "Show agent replies"}
                  </button>
                </div>
                {visibleQuestions.length ? (
                  visibleQuestions.map((question, index) => (
                    <HostQuestion
                      key={question.id}
                      question={question}
                      rank={index + 1}
                      control={control}
                      pending={!!pending}
                      showReply={showReplies}
                    />
                  ))
                ) : (
                  <EmptyState
                    title={
                      questions.length
                        ? "All caught up."
                        : "The room is warming up."
                    }
                  >
                    {questions.length
                      ? "Every question has been answered by the speaker. Reopen one, or wait for the next."
                      : "Questions will appear here as the audience joins."}
                  </EmptyState>
                )}
                <p className="control-hint">
                  Raw intake stays visible here. Hiding a question only excludes
                  it from the broadcast.
                </p>
              </section>
              <section aria-labelledby="recommendation-title">
                <div className="panel-heading">
                  <h2
                    id="recommendation-title"
                    style={{ display: "flex", alignItems: "center", gap: 7 }}
                  >
                    <Icon name="spark" size={14} />
                    Backstage recommends
                  </h2>
                  <span className="eyebrow">Agent</span>
                </div>
                <p className="rec-intro">
                  An agent’s suggested order, using the room’s actual votes.
                  Choose any question from either queue.
                </p>
                {recommendation?.stale && (
                  <p className="message error connection-notice">
                    The board has changed. This recommendation is stale; the
                    vote queue is current.
                  </p>
                )}
                {queue.length ? (
                  queue.map((item, index) => (
                    <HostQuestion
                      key={item.questionId}
                      question={item.question}
                      rank={index + 1}
                      reason={item.reason}
                      pending={!!pending}
                      control={control}
                    />
                  ))
                ) : (
                  <div className="empty-state queue-empty">
                    <Icon name="spark" size={25} />
                    <h3>
                      {data.recommendation
                        ? "The floor is yours."
                        : "A second perspective."}
                    </h3>
                    <p>
                      {data.event.agentPaused
                        ? "The agent is paused. The audience queue and all host controls remain available."
                        : data.recommendation
                          ? "No remaining questions are recommended. You can still choose any question from the audience queue."
                          : "Recommendations appear after Backstage reviews the questions. You can request a closing queue above."}
                    </p>
                  </div>
                )}
                {!!recommendation?.groups.length && (
                  <div style={{ marginTop: 23 }}>
                    <div className="eyebrow" style={{ marginBottom: 11 }}>
                      Related questions · agent groups
                    </div>
                    {recommendation.groups.map((group, index) => (
                      <section className="group-card" key={index}>
                        <h3>{group.title}</h3>
                        {group.questionIds.map((id) => {
                          const question = questionMap.get(id);
                          return question ? (
                            <div className="group-member" key={id}>
                              <span>{question.text}</span>
                              <span className="member-votes">
                                {question.votes}{" "}
                                {question.votes === 1 ? "vote" : "votes"}
                              </span>
                            </div>
                          ) : null;
                        })}
                      </section>
                    ))}
                    <p className="control-hint">
                      Votes belong to the original questions. Groups do not
                      combine or move votes.
                    </p>
                  </div>
                )}
              </section>
              <aside className="host-sidebar">
                <section className="control-panel">
                  <h2>Session controls</h2>
                  <div className="control-row">
                    <div className="control-row-label">
                      New questions
                      <small>
                        {data.event.intakeExhausted
                          ? `Full · ${data.event.questionCap} question cap`
                          : data.event.intakePaused
                            ? "Intake paused"
                            : "Open to the room"}
                      </small>
                    </div>
                    <button
                      className={`toggle ${!data.event.intakePaused ? "on" : ""}`}
                      role="switch"
                      aria-checked={!data.event.intakePaused}
                      aria-label="Accept new questions"
                      disabled={pending === "intake"}
                      onClick={() =>
                        control({
                          action: "intake",
                          value: !data.event.intakePaused,
                        })
                      }
                    >
                      <span />
                    </button>
                  </div>
                  <div className="control-row">
                    <div className="control-row-label">
                      Agent processing
                      <small>
                        {data.event.agentPaused
                          ? "Paused by presenter"
                          : "Allowed to work"}
                      </small>
                    </div>
                    <button
                      className={`toggle ${!data.event.agentPaused ? "on" : ""}`}
                      role="switch"
                      aria-checked={!data.event.agentPaused}
                      aria-label="Allow agent processing"
                      disabled={pending === "agent"}
                      onClick={() =>
                        control({
                          action: "agent",
                          value: !data.event.agentPaused,
                        })
                      }
                    >
                      <span />
                    </button>
                  </div>
                  <p className="control-hint">
                    Pausing the agent leaves voting and presenter controls
                    available.
                  </p>
                  <button
                    className="button ghost small full"
                    onClick={() => setResetOpen(true)}
                  >
                    Reset this session…
                  </button>
                </section>
                <section className="mini-broadcast">
                  <h2>
                    <Icon name="screen" size={13} />
                    On the screen
                  </h2>
                  {selected ? (
                    <>
                      <p>{selected.text}</p>
                      <button
                        className="button ghost small full"
                        disabled={pending === "select"}
                        onClick={() =>
                          control({ action: "select", questionId: null })
                        }
                      >
                        Clear broadcast
                      </button>
                    </>
                  ) : (
                    <p style={{ color: "var(--muted)", fontSize: 11 }}>
                      Nothing selected. The broadcast is showing its waiting
                      screen.
                    </p>
                  )}
                </section>
                <AudienceQR url={data.event.audienceUrl} />
              </aside>
            </div>
            <section
              className="activity-section"
              aria-labelledby="activity-title"
            >
              <div className="activity-header">
                <div>
                  <h2 id="activity-title">Behind the scenes</h2>
                  <p>
                    Recent application activity. These events describe the
                    worker’s workflow.
                  </p>
                </div>
                <div className="box-note">
                  <strong>Box decision records · local terminal only</strong>No
                  live Box log source is connected to this dashboard.
                  Application events are not proof of enforcement. See the
                  terminal command in the runbook.
                </div>
              </div>
              {data.activity.length ? (
                <ol className="activity-list">
                  {data.activity.map((event) => (
                    <li className="activity-row" key={event.id}>
                      <time
                        className="activity-time"
                        dateTime={new Date(event.at).toISOString()}
                      >
                        {timeLabel(event.at)}
                      </time>
                      <span className="activity-kind">
                        {event.kind.replaceAll("-", " ")}
                      </span>
                      <span className="activity-detail">
                        {event.message}
                        {(event.questionId || event.workId) && (
                          <span className="activity-id">
                            {event.questionId
                              ? `question ${String(event.questionId).slice(0, 8)}`
                              : `work ${String(event.workId).slice(0, 8)}`}
                          </span>
                        )}
                      </span>
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="control-hint">
                  No application activity yet. Start the worker to see its
                  progress here.
                </p>
              )}
            </section>
          </>
        )}
      </main>
      <footer className="footer">
        <span>Host actions belong to you. Agent suggestions are optional.</span>
        <span>Backstage · Presenter desk</span>
      </footer>
      {resetOpen && (
        <ResetDialog
          busy={pending === "reset"}
          close={() => setResetOpen(false)}
          reset={() => control({ action: "reset", confirmation: "RESET" })}
        />
      )}
    </div>
  );
}
