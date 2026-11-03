"use client";

import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { Icon, Question, ThemeSwitcher, plural, useLiveState } from "../ui";

type BroadcastState = {
  event: { generation: string; audienceUrl: string };
  question: Question | null;
};

function useQr(url: string | undefined) {
  const [image, setImage] = useState("");
  useEffect(() => {
    if (!url) return;
    let current = true;
    QRCode.toDataURL(url, {
      width: 480,
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
  return image;
}

function displayUrl(url: string) {
  return url.replace(/^https?:\/\//, "").replace(/\/$/, "");
}

export default function BroadcastPage() {
  const { data, error } = useLiveState<BroadcastState>("/api/broadcast");
  const question = data?.question;
  const url = data?.event.audienceUrl;
  const qr = useQr(url);

  return (
    <div className="broadcast">
      <div className="broadcast-tools">
        <ThemeSwitcher />
      </div>
      <main
        id="main"
        tabIndex={-1}
        className="broadcast-stage"
        data-state={question ? "question" : "idle"}
        data-question-id={question?.id}
      >
        <div aria-live="polite" aria-atomic="true" className="broadcast-live">
          {question ? (
            <>
              <h1 className="broadcast-question">{question.text}</h1>
              <p className="broadcast-meta">
                <span>
                  <Icon name="up" size={28} />
                  {plural(question.votes, "vote")}
                </span>
                {question.speakerAnswered && (
                  <span>
                    <Icon name="check" size={28} />
                    Answered
                  </span>
                )}
              </p>
            </>
          ) : (
            <div className="broadcast-idle">
              <h1 className="broadcast-title">Ask a question</h1>
              {url && <p className="broadcast-url">{displayUrl(url)}</p>}
              {qr && (
                <img
                  className="qr broadcast-qr"
                  src={qr}
                  width={240}
                  height={240}
                  alt={`QR code linking to ${url}`}
                />
              )}
            </div>
          )}
        </div>
      </main>
      <footer className="broadcast-foot">
        {question && url ? (
          <span>
            Ask at <strong>{displayUrl(url)}</strong>
          </span>
        ) : (
          <span />
        )}
        {error && (
          <span className="connection offline" role="status">
            <span className="dot" aria-hidden="true" />
            Reconnecting
          </span>
        )}
      </footer>
    </div>
  );
}
