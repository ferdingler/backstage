"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type Question = {
  id: string;
  text: string;
  createdAt: number;
  votes: number;
  voted: boolean;
  reply: null | { text: string; disposition: "answered" | "leave-for-speaker" };
  speakerAnswered: boolean;
  hidden: boolean;
  selected: boolean;
};
export type PublicState = {
  event: {
    generation: string;
    intakePaused: boolean;
    agentPaused: boolean;
    intakeExhausted: boolean;
    selectedQuestionId: string | null;
    audienceUrl: string;
    questionCap: number;
  };
  questions: Question[];
  agent: { status: string; lastSeenAt: number | null };
  recommendation: null | {
    revision: number;
    createdAt: number;
    stale: boolean;
    groups: { title: string; questionIds: string[] }[];
    queue: { questionId: string; reason: string }[];
  };
};
export type HostState = PublicState & {
  activity: {
    id: string;
    at: number;
    kind: string;
    message: string;
    workId?: string;
    questionId?: string;
  }[];
  budget: {
    used: number;
    reserved: number;
    limit: number;
    closingReserve: number;
  };
  worker: { status: string; lastSeenAt: number | null; stale: boolean };
  revision: number;
  boxLog: { status: string; message: string };
};

export class ApiError extends Error {
  constructor(
    message: string,
    public retryAfter = 0,
  ) {
    super(message);
  }
}

export async function request<T>(
  url: string,
  options: RequestInit = {},
): Promise<T> {
  const response = await fetch(url, {
    ...options,
    cache: "no-store",
    credentials: "same-origin",
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const retryAfter = Math.min(
      120,
      Math.max(0, Number(response.headers.get("Retry-After")) || 0),
    );
    const message =
      body?.error?.message ||
      (response.status === 429
        ? "A little too fast. Please try again shortly."
        : "We couldn’t reach Backstage. Please try again.");
    throw new ApiError(
      retryAfter ? `${message} Try again in ${retryAfter}s.` : message,
      retryAfter,
    );
  }
  return body as T;
}

export function useLiveState<T>(url: string) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);
  const failureCount = useRef(0);
  const refresh = useCallback(() => setRefreshKey((value) => value + 1), []);
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let active: AbortController | undefined;
    const load = async (initial = false) => {
      if ((!initial && document.hidden) || stopped) return;
      active?.abort();
      active = new AbortController();
      let delay = 3000;
      try {
        const next = await request<T>(url, { signal: active.signal });
        if (stopped) return;
        setData(next);
        setError("");
        failureCount.current = 0;
      } catch (error) {
        if (stopped || (error instanceof Error && error.name === "AbortError"))
          return;
        failureCount.current += 1;
        delay = Math.max(
          Math.min(30000, 3000 * 2 ** Math.min(failureCount.current, 4)),
          error instanceof ApiError ? error.retryAfter * 1000 : 0,
        );
        setError(
          error instanceof Error
            ? error.message
            : "Connection interrupted. Reconnecting…",
        );
      }
      if (!stopped)
        timer = setTimeout(() => {
          void load();
        }, delay);
    };
    const visibility = () => {
      clearTimeout(timer);
      if (document.hidden) active?.abort();
      else void load();
    };
    document.addEventListener("visibilitychange", visibility);
    void load(true);
    return () => {
      stopped = true;
      clearTimeout(timer);
      active?.abort();
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [url, refreshKey]);
  return { data, error, refresh, setData };
}

export function Icon({
  name,
  size = 16,
}: {
  name:
    | "arrow"
    | "up"
    | "spark"
    | "lock"
    | "question"
    | "screen"
    | "external"
    | "check"
    | "pause";
  size?: number;
}) {
  const paths: Record<string, React.ReactNode> = {
    arrow: (
      <>
        <path d="M4 12h15M13 6l6 6-6 6" />
      </>
    ),
    up: <path d="m6 14 6-6 6 6" />,
    spark: (
      <>
        <path d="m12 3 2.4 6.6L21 12l-6.6 2.4L12 21l-2.4-6.6L3 12l6.6-2.4L12 3Z" />
        <path d="M20 3v4m-2-2h4" />
      </>
    ),
    lock: (
      <>
        <rect x="5" y="10" width="14" height="11" rx="2" />
        <path d="M8 10V7a4 4 0 0 1 8 0v3m-4 5v2" />
      </>
    ),
    question: (
      <>
        <path d="M21 11a9 9 0 0 1-9 9H4l-2 2v-11a9 9 0 1 1 19 0Z" />
        <path d="M9 8a3 3 0 0 1 6 0c0 2-3 2-3 4m0 3h.01" />
      </>
    ),
    screen: (
      <>
        <rect x="3" y="3" width="18" height="13" rx="2" />
        <path d="M8 21h8m-4-5v5" />
      </>
    ),
    external: (
      <>
        <path d="M14 3h7v7m0-7L10 14M9 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-4" />
      </>
    ),
    check: <path d="m5 12 4 4L19 6" />,
    pause: (
      <>
        <path d="M8 5v14M16 5v14" />
      </>
    ),
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  );
}

export function Brand({ href = "/" }: { href?: string }) {
  return (
    <a className="brand" href={href} aria-label="Backstage home">
      <span className="brand-mark" aria-hidden="true">
        b.
      </span>
      backstage
    </a>
  );
}

export function EmptyState({
  title,
  children,
  loading = false,
}: {
  title: string;
  children?: React.ReactNode;
  loading?: boolean;
}) {
  return (
    <div className="empty-state">
      {loading ? (
        <div className="loading-bar" />
      ) : (
        <Icon name="question" size={28} />
      )}
      <h3>{title}</h3>
      {children && <p>{children}</p>}
    </div>
  );
}

export function timeLabel(date: number) {
  const value = new Date(date);
  return Number.isNaN(value.getTime())
    ? ""
    : value.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

export function statusLabel(status: string) {
  const labels: Record<string, string> = {
    idle: "Ready for questions",
    processing: "Working on the queue",
    paused: "Agent paused",
    retrying: "Trying again",
    "over-budget": "Model budget reached",
    disconnected: "Agent offline",
  };
  return labels[status] || "Waiting for agent";
}

export function QuestionStatus({ question }: { question: Question }) {
  if (question.speakerAnswered)
    return (
      <span className="status-pill good">
        <Icon name="check" size={10} />
        Answered by speaker
      </span>
    );
  if (question.selected)
    return (
      <span className="status-pill warn">
        <Icon name="screen" size={10} />
        On the screen
      </span>
    );
  if (question.reply)
    return (
      <span className="status-pill neutral">Agent replied · open for Q&A</span>
    );
  return <span>Awaiting a reply</span>;
}

export function AgentReply({ question }: { question: Question }) {
  if (!question.reply) return null;
  return (
    <div className="reply">
      <div className="reply-label">
        <Icon name="spark" size={12} />
        Backstage
        <span style={{ fontWeight: 400, color: "var(--muted)" }}>
          · agent reply
        </span>
      </div>
      <p>{question.reply.text.slice(0, 1200)}</p>
      {question.reply.disposition === "leave-for-speaker" && (
        <div className="reply-note">Leaving this one for the speaker.</div>
      )}
    </div>
  );
}
