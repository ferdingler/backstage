"use client";

import { useMemo, useState } from "react";
import {
  AgentReply,
  Brand,
  EmptyState,
  Icon,
  PublicState,
  QuestionStatus,
  request,
  statusLabel,
  timeLabel,
  useLiveState,
} from "./ui";

export default function AudiencePage() {
  const { data, error, refresh, setData } =
    useLiveState<PublicState>("/api/state");
  const [draft, setDraft] = useState("");
  const [message, setMessage] = useState<{
    text: string;
    error: boolean;
  } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [voting, setVoting] = useState<Set<string>>(new Set());
  const [sort, setSort] = useState<"votes" | "newest">("votes");
  const questions = useMemo(
    () =>
      [...(data?.questions || [])].sort((a, b) =>
        sort === "votes"
          ? b.votes - a.votes ||
            new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
          : new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      ),
    [data?.questions, sort],
  );
  const intakeClosed = data?.event.intakePaused || data?.event.intakeExhausted;
  const agentStatus = data?.event.agentPaused
    ? "paused"
    : data?.agent.status || "disconnected";

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting || !draft.trim()) return;
    setSubmitting(true);
    setMessage(null);
    try {
      await request("/api/questions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: draft }),
      });
      setDraft("");
      setMessage({
        text: "Your question is in. The room can vote for it now.",
        error: false,
      });
      refresh();
    } catch (error) {
      setMessage({
        text:
          error instanceof Error
            ? error.message
            : "Your question couldn’t be sent. Please try again.",
        error: true,
      });
    } finally {
      setSubmitting(false);
    }
  }

  async function vote(questionId: string, voted: boolean) {
    if (voting.has(questionId)) return;
    setVoting((current) => new Set(current).add(questionId));
    try {
      const result = await request<{ votes: number; voted: boolean }>(
        "/api/votes",
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ questionId, voted }),
        },
      );
      setData((current) =>
        current
          ? {
              ...current,
              questions: current.questions.map((question) =>
                question.id === questionId
                  ? { ...question, votes: result.votes, voted: result.voted }
                  : question,
              ),
            }
          : current,
      );
      refresh();
    } catch (error) {
      setMessage({
        text:
          error instanceof Error
            ? error.message
            : "Your vote couldn’t be saved. Please try again.",
        error: true,
      });
    } finally {
      setVoting((current) => {
        const next = new Set(current);
        next.delete(questionId);
        return next;
      });
    }
  }

  return (
    <div className="shell">
      <header className="topbar">
        <Brand />
        <span className="topbar-label">
          A LIVE EXPERIMENT IN AGENT BOUNDARIES
        </span>
        <span className={`status-pill ${error ? "warn" : "good"}`}>
          <span className="dot" />
          {error ? "Reconnecting" : "Live Q&A"}
        </span>
      </header>
      <main>
        <section className="hero" aria-labelledby="page-title">
          <div>
            <div className="eyebrow">Your curiosity. The conversation.</div>
            <h1 id="page-title">
              A good question
              <br />
              changes <em>the room.</em>
            </h1>
          </div>
          <p className="hero-note">
            <strong>Meet Backstage, our Q&A agent.</strong>Ask about the talk,
            vote for a question, or try to distract the agent. The speaker has
            the final say.
          </p>
        </section>
        <div className="audience-grid">
          <aside className="composer">
            <h2>What’s on your mind?</h2>
            <p className="composer-intro">
              A genuine question or a clever distraction.
              <br />
              Let’s see how Backstage responds.
            </p>
            <form onSubmit={submit}>
              <label className="field-label" htmlFor="question">
                Your question
              </label>
              <textarea
                id="question"
                className="question-input"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                maxLength={1000}
                placeholder="What happens when an agent tries to step outside its boundaries?"
                required
                disabled={submitting}
                aria-describedby="question-limit"
              />
              <div className="field-foot" id="question-limit">
                <span>No name needed.</span>
                <span>{draft.length} / 1,000</span>
              </div>
              <button
                className="button primary full"
                type="submit"
                disabled={
                  !data || submitting || !draft.trim() || !!intakeClosed
                }
              >
                {submitting
                  ? "Sending your question…"
                  : intakeClosed
                    ? "Questions are paused"
                    : "Send to Backstage"}
                {!submitting && !intakeClosed && (
                  <Icon name="arrow" size={16} />
                )}
              </button>
            </form>
            {data?.event.intakeExhausted && (
              <p className="message">
                The question board is full for this session. You can still vote
                for the questions you want to hear.
              </p>
            )}
            {data?.event.intakePaused && !data.event.intakeExhausted && (
              <p className="message">
                The speaker has paused new questions. You can still read and
                vote.
              </p>
            )}
            {message && (
              <p
                className={`message ${message.error ? "error" : ""}`}
                role={message.error ? "alert" : "status"}
              >
                {message.text}
              </p>
            )}
            <div className="composer-footer">
              <Icon name="lock" size={12} />
              <p>
                Anonymous participation. A browser cookie remembers your votes
                for this session.
              </p>
            </div>
          </aside>
          <section aria-labelledby="questions-title">
            <div className="feed-heading">
              <h2 id="questions-title">
                The room is asking{" "}
                <span className="count">{questions.length}</span>
              </h2>
              <div className="segmented" aria-label="Question order">
                <button
                  className={sort === "votes" ? "active" : ""}
                  aria-pressed={sort === "votes"}
                  onClick={() => setSort("votes")}
                >
                  Top voted
                </button>
                <button
                  className={sort === "newest" ? "active" : ""}
                  aria-pressed={sort === "newest"}
                  onClick={() => setSort("newest")}
                >
                  Newest
                </button>
              </div>
            </div>
            {error && (
              <p className="message error connection-notice" role="status">
                {error} Your current question board is still here.
              </p>
            )}
            {data && (
              <div className="question-meta" style={{ marginBottom: 18 }}>
                <span
                  className={`status-pill ${agentStatus === "processing" || agentStatus === "idle" ? "good" : "neutral"}`}
                >
                  <span className="dot" />
                  {statusLabel(agentStatus)}
                </span>
                <span>Replies don’t close questions for the speaker.</span>
              </div>
            )}
            {!data ? (
              <EmptyState title="Joining the conversation…" loading>
                Getting the latest questions from the room.
              </EmptyState>
            ) : questions.length === 0 ? (
              <EmptyState title="Every conversation starts somewhere.">
                Ask the first question. Backstage will take it from here.
              </EmptyState>
            ) : (
              <div>
                {questions.map((question) => (
                  <article
                    key={question.id}
                    className={`question-card ${question.selected ? "selected" : ""} ${question.speakerAnswered ? "answered" : ""}`}
                    aria-label={`Question: ${question.text}`}
                  >
                    <div className="question-main">
                      <button
                        className={`vote-button ${question.voted ? "voted" : ""}`}
                        aria-label={`${question.voted ? "Remove vote from" : "Vote for"}: ${question.text}`}
                        aria-pressed={question.voted}
                        disabled={voting.has(question.id)}
                        onClick={() => vote(question.id, !question.voted)}
                      >
                        <Icon name="up" />
                        <span>{question.votes}</span>
                      </button>
                      <div className="question-content">
                        <div className="question-meta">
                          <time
                            dateTime={new Date(
                              question.createdAt,
                            ).toISOString()}
                          >
                            {timeLabel(question.createdAt)}
                          </time>
                          <span aria-hidden="true">·</span>
                          <QuestionStatus question={question} />
                        </div>
                        <h3 className="question-text">{question.text}</h3>
                      </div>
                    </div>
                    <AgentReply question={question} />
                  </article>
                ))}
              </div>
            )}
          </section>
        </div>
      </main>
      <footer className="footer">
        <span>Built for questions. Open to distractions.</span>
        <span>Backstage · Strands + Box</span>
      </footer>
    </div>
  );
}
