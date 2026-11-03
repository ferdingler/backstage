"use client";

import { useMemo, useState } from "react";
import {
  AgentReply,
  EmptyState,
  Header,
  Icon,
  Notice,
  PublicState,
  QuestionStatus,
  plural,
  request,
  timeLabel,
  useAutoClear,
  useLiveState,
} from "./ui";

const MAX_LENGTH = 1000;

export default function AudiencePage() {
  const { data, error, refresh, setData } =
    useLiveState<PublicState>("/api/state");
  const [draft, setDraft] = useState("");
  const [message, setMessage] = useState<{
    text: string;
    error: boolean;
  } | null>(null);
  useAutoClear(message, setMessage);
  const [submitting, setSubmitting] = useState(false);
  const [voting, setVoting] = useState<Set<string>>(new Set());
  const [sort, setSort] = useState<"votes" | "newest">("votes");
  const questions = useMemo(
    () =>
      [...(data?.questions || [])].sort((a, b) =>
        sort === "votes"
          ? b.votes - a.votes || a.createdAt - b.createdAt
          : b.createdAt - a.createdAt,
      ),
    [data?.questions, sort],
  );
  const live = !!data?.session;
  const intakeClosed = !!(
    !live ||
    data?.event?.intakePaused ||
    data?.event?.intakeExhausted
  );

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting || !draft.trim() || intakeClosed) return;
    setSubmitting(true);
    setMessage(null);
    try {
      await request("/api/questions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: draft }),
      });
      setDraft("");
      setMessage({ text: "Question submitted.", error: false });
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
    <>
      <Header connected={data ? !error : null} />
      <main id="main" tabIndex={-1} className="page narrow">
        {data?.session && (
          <p className="eyebrow" data-session-id={data.session.id}>
            {data.session.title}
          </p>
        )}
        <h1 className="page-title">Ask a question</h1>
        <p className="page-intro">
          Anonymous. Vote for the questions you want answered.
        </p>

        <form
          className="composer"
          onSubmit={submit}
          aria-label="New question"
          hidden={!!data && !live}
        >
          <label className="sr-only" htmlFor="question">
            Your question
          </label>
          <textarea
            id="question"
            name="question"
            className="textarea"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (
                event.key === "Enter" &&
                (event.metaKey || event.ctrlKey) &&
                !event.nativeEvent.isComposing
              )
                event.currentTarget.form?.requestSubmit();
            }}
            maxLength={MAX_LENGTH}
            rows={3}
            placeholder="Type your question…"
            required
            disabled={submitting || intakeClosed}
            aria-describedby="question-hint"
          />
          <div className="composer-foot">
            <span id="question-hint" className="hint">
              {intakeClosed
                ? data?.event?.intakeExhausted
                  ? "The question limit has been reached. Voting is still open."
                  : "New questions are paused. Voting is still open."
                : `${draft.length.toLocaleString()} / ${MAX_LENGTH.toLocaleString()}`}
            </span>
            <button
              className="button primary"
              type="submit"
              disabled={!data || submitting || !draft.trim() || intakeClosed}
            >
              {submitting ? "Sending…" : "Submit"}
            </button>
          </div>
        </form>

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

        <section className="section" aria-labelledby="questions-title">
          <div className="section-head">
            <h2 id="questions-title" className="section-title">
              {data ? plural(questions.length, "question") : "Questions"}
            </h2>
            <div className="segmented" role="group" aria-label="Sort questions">
              <button
                type="button"
                aria-pressed={sort === "votes"}
                onClick={() => setSort("votes")}
              >
                Top
              </button>
              <button
                type="button"
                aria-pressed={sort === "newest"}
                onClick={() => setSort("newest")}
              >
                New
              </button>
            </div>
          </div>

          {!data ? (
            error ? (
              <EmptyState title="Can’t connect">{error}</EmptyState>
            ) : (
              <EmptyState title="Loading questions…" loading />
            )
          ) : !live ? (
            <EmptyState title="No live session">
              Questions open when the host starts a session.
            </EmptyState>
          ) : questions.length === 0 ? (
            <EmptyState title="No questions yet">
              Be the first to ask.
            </EmptyState>
          ) : (
            <ol className="list" aria-labelledby="questions-title">
              {questions.map((question) => (
                <li
                  key={question.id}
                  className={`item ${question.selected ? "is-selected" : ""} ${question.speakerAnswered ? "is-answered" : ""}`}
                  data-question-id={question.id}
                  data-votes={question.votes}
                  data-voted={question.voted}
                >
                  <article className="item-row voteable" aria-label={question.text}>
                    <button
                      type="button"
                      className="vote"
                      aria-pressed={question.voted}
                      aria-label={`${question.voted ? "Remove your vote" : "Vote"} for “${question.text}”. ${plural(question.votes, "vote")}.`}
                      disabled={voting.has(question.id)}
                      onClick={() => vote(question.id, !question.voted)}
                    >
                      <Icon name="up" size={22} />
                      <span className="vote-count">{question.votes}</span>
                    </button>
                    <div className="item-body">
                      <p className="item-text">{question.text}</p>
                      <div className="meta">
                        <time
                          dateTime={new Date(question.createdAt).toISOString()}
                        >
                          {timeLabel(question.createdAt)}
                        </time>
                        <QuestionStatus question={question} />
                      </div>
                    </div>
                    <AgentReply question={question} />
                  </article>
                </li>
              ))}
            </ol>
          )}
        </section>
      </main>
    </>
  );
}
