import { route } from "@/api";
import { board } from "@/db";
import * as session from "@/session";
import * as work from "@/work";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = route({}, ({ req }) => {
  work.expire();
  // An agent may be pointed at a session; otherwise it follows the live one.
  const s = session.byIdOrDefault(req.nextUrl.searchParams.get("session"));
  return {
    sessionId: s.id,
    sessionTitle: s.title,
    live: !!s.live,
    generation: s.generation,
    pauseEpoch: s.pause_epoch,
    agentPaused: work.blocked(s),
    status: work.worker().status,
    revision: s.revision,
    closingRequested: !!s.closing_requested,
    budget: work.budget(s),
    questions: board(s),
    serverTime: Date.now(),
  };
});
