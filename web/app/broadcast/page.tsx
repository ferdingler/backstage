"use client";

import { Brand, Icon, Question, useLiveState } from "../ui";

type BroadcastState = {
  event: { generation: string; audienceUrl: string };
  question: Question | null;
};

export default function BroadcastPage() {
  const { data, error } = useLiveState<BroadcastState>("/api/broadcast");
  const question = data?.question;
  return (
    <div className="broadcast-shell">
      <header className="topbar">
        <Brand />
        <span className="eyebrow">From the audience</span>
        <span className="live-pill">
          <span className="dot" />
          Live Q&A
        </span>
      </header>
      <main className="broadcast-stage" aria-live="polite">
        {error ? (
          <div className="broadcast-empty">
            <div className="broadcast-label">Connection interrupted</div>
            <h1>We’ll be right back.</h1>
            <p>Reconnecting to the presenter’s selection.</p>
          </div>
        ) : question ? (
          <>
            <div className="broadcast-label">
              <Icon name="question" size={19} />A question from the room
            </div>
            <h1 className="broadcast-question">{question.text}</h1>
            <div className="broadcast-meta">
              <span className="broadcast-votes">
                <Icon name="up" size={16} />
                {question.votes} {question.votes === 1 ? "vote" : "votes"}
              </span>
              <span>Selected by the speaker</span>
              {question.speakerAnswered && <span>Answered by the speaker</span>}
            </div>
          </>
        ) : (
          <div className="broadcast-empty">
            <div className="broadcast-label">
              <Icon name="spark" size={18} />
              The conversation continues
            </div>
            <h1>
              Good questions.
              <br />
              Great conversations.
            </h1>
            <p>
              {data
                ? "Ask what’s on your mind and vote for the questions you’d like the speaker to answer."
                : "Connecting to the live conversation…"}
            </p>
          </div>
        )}
      </main>
      <footer className="broadcast-footer">
        <span>
          Join the conversation
          {data?.event.audienceUrl && (
            <>
              {" "}
              · <a href={data.event.audienceUrl}>{data.event.audienceUrl}</a>
            </>
          )}
        </span>
        <span>Backstage · Strands + Box</span>
      </footer>
    </div>
  );
}
