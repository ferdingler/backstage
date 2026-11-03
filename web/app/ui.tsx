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
export type SessionInfo = {
  id: string;
  title: string;
  live: boolean;
  createdAt: number;
};
export type EventState = {
  generation: string;
  intakePaused: boolean;
  agentPaused: boolean;
  intakeExhausted: boolean;
  selectedQuestionId: string | null;
  audienceUrl: string;
  questionCap: number;
};
export type Recommendation = {
  revision: number;
  createdAt: number;
  stale: boolean;
  groups: { title: string; questionIds: string[] }[];
  queue: { questionId: string; reason: string }[];
};
/** Audience view of the live session; `session` is null when none is live. */
export type PublicState = {
  session: SessionInfo | null;
  event: EventState | null;
  questions: Question[];
  agent: { status: string; lastSeenAt: number | null } | null;
  recommendation: null;
};
export type HostState = {
  session: SessionInfo & { talkingPoints: string };
  sessions: (SessionInfo & { questionCount: number })[];
  event: EventState;
  questions: Question[];
  agent: { status: string; lastSeenAt: number | null };
  recommendation: Recommendation | null;
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
  worker: {
    status: string;
    lastSeenAt: number | null;
    stale: boolean;
    sessionId: string | null;
  };
  revision: number;
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
        ? "Too many requests. Please try again shortly."
        : "Couldn’t reach the server. Please try again.");
    throw new ApiError(
      retryAfter ? `${message} Try again in ${retryAfter}s.` : message,
      retryAfter,
    );
  }
  return body as T;
}

/** Polls `url`; pass null to wait without fetching. */
export function useLiveState<T>(url: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);
  const failureCount = useRef(0);
  const refresh = useCallback(() => setRefreshKey((value) => value + 1), []);
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let active: AbortController | undefined;
    if (!url) return;
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


type IconName =
  | "up"
  | "check"
  | "screen"
  | "hidden"
  | "spark"
  | "sun"
  | "moon"
  | "auto"
  | "external"
  | "arrow"
  | "plus"
  | "play"
  | "pause";

const iconPaths: Record<IconName, React.ReactNode> = {
  up: <path d="m6 15 6-6 6 6" />,
  check: <path d="m5 12.5 4.5 4.5L19 7" />,
  screen: (
    <>
      <rect x="3" y="4" width="18" height="12" rx="2" />
      <path d="M8 20h8m-4-4v4" />
    </>
  ),
  hidden: (
    <>
      <path d="M3 3l18 18M10.6 5.1A10 10 0 0 1 12 5c5 0 9 4.5 10 7a12 12 0 0 1-3 4.2M6.6 6.6A12 12 0 0 0 2 12c1 2.5 5 7 10 7a9.8 9.8 0 0 0 5.4-1.6" />
      <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
    </>
  ),
  spark: (
    <path d="M12 3.5 13.9 10l6.6 2-6.6 2L12 20.5 10.1 14l-6.6-2 6.6-2L12 3.5Z" />
  ),
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </>
  ),
  moon: <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z" />,
  auto: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 3.5v17a8.5 8.5 0 0 0 0-17Z" fill="currentColor" />
    </>
  ),
  external: (
    <path d="M14 4h6v6m0-6-9 9M10 5H6a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-4" />
  ),
  arrow: <path d="M5 12h14m-6-6 6 6-6 6" />,
  plus: <path d="M12 5v14M5 12h14" />,
  play: <path d="M7 5v14l11-7L7 5Z" />,
  pause: <path d="M8 5v14M16 5v14" />,
};

export function Icon({ name, size = 20 }: { name: IconName; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {iconPaths[name]}
    </svg>
  );
}

type Theme = "system" | "light" | "dark";
const themes: { value: Theme; label: string; icon: IconName }[] = [
  { value: "system", label: "System theme", icon: "auto" },
  { value: "light", label: "Light theme", icon: "sun" },
  { value: "dark", label: "Dark theme", icon: "moon" },
];

export function ThemeSwitcher() {
  const [theme, setTheme] = useState<Theme>("system");
  useEffect(() => {
    const current = document.documentElement.dataset.theme;
    if (current === "light" || current === "dark") setTheme(current);
  }, []);
  function choose(next: Theme) {
    setTheme(next);
    if (next === "system") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = next;
    try {
      if (next === "system") localStorage.removeItem("theme");
      else localStorage.setItem("theme", next);
    } catch {
      // Storage can be unavailable; the choice still applies to this page.
    }
  }
  return (
    <div className="theme-switcher" role="group" aria-label="Color theme">
      {themes.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-label={option.label}
          aria-pressed={theme === option.value}
          title={option.label}
          data-theme-option={option.value}
          onClick={() => choose(option.value)}
        >
          <Icon name={option.icon} size={18} />
        </button>
      ))}
    </div>
  );
}

export function Header({
  label,
  connected,
  children,
}: {
  label?: string;
  connected: boolean | null;
  children?: React.ReactNode;
}) {
  return (
    <header className="header">
      <div className="header-inner">
        <div className="header-title">
          <span className="wordmark">Backstage</span>
          {label && <span className="header-label">{label}</span>}
        </div>
        <div className="header-actions">
          {children}
          {connected !== null && (
            <span
              className={`connection ${connected ? "" : "offline"}`}
              role="status"
              data-connection={connected ? "live" : "reconnecting"}
            >
              <span className="dot" aria-hidden="true" />
              {connected ? "Connected" : "Reconnecting"}
            </span>
          )}
          <ThemeSwitcher />
        </div>
      </div>
    </header>
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
    <div className="empty" role={loading ? "status" : undefined}>
      {loading && <div className="loading-bar" aria-hidden="true" />}
      <p className="empty-title">{title}</p>
      {children && <p className="empty-text">{children}</p>}
    </div>
  );
}

export function Notice({
  tone = "info",
  children,
}: {
  tone?: "info" | "error";
  children: React.ReactNode;
}) {
  return (
    <p
      className={`notice ${tone}`}
      role={tone === "error" ? "alert" : "status"}
    >
      {children}
    </p>
  );
}

export function timeLabel(date: number) {
  const value = new Date(date);
  return Number.isNaN(value.getTime())
    ? ""
    : value.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

export function plural(count: number, word: string) {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

/** Clears a non-error message after a few seconds. Errors stay until replaced. */
export function useAutoClear(
  message: { text: string; error: boolean } | null,
  clear: (value: null) => void,
) {
  useEffect(() => {
    if (!message || message.error) return;
    const timer = setTimeout(() => clear(null), 5000);
    return () => clearTimeout(timer);
  }, [message, clear]);
}

export function isAgentHealthy(status: string) {
  return status === "idle" || status === "processing";
}

export function QuestionStatus({ question }: { question: Question }) {
  if (question.speakerAnswered)
    return (
      <span className="tag good">
        <Icon name="check" size={14} />
        Answered
      </span>
    );
  if (question.selected)
    return (
      <span className="tag accent">
        <Icon name="screen" size={14} />
        On screen
      </span>
    );
  return null;
}

export function AgentReply({ question }: { question: Question }) {
  if (!question.reply) return null;
  return (
    <div className="reply" data-reply-disposition={question.reply.disposition}>
      <p className="reply-label">
        <Icon name="spark" size={14} />
        Agent reply
      </p>
      <p className="reply-text">{question.reply.text.slice(0, 1200)}</p>
      {question.reply.disposition === "leave-for-speaker" && (
        <p className="reply-note">Left open for the speaker.</p>
      )}
    </div>
  );
}
