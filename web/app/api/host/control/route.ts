import { route } from "@/api";
import { transaction } from "@/db";
import * as session from "@/session";
import { boolean, fail, fields } from "@/validate";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** One endpoint for every host action, selected by `action`. */
export const POST = route({ origin: "host" }, ({ body }) =>
  transaction(() => {
    const action = body.action;
    if (action === "create-session") {
      fields(body, ["action", "title"], ["talkingPoints"]);
      return { ok: true, ...session.create(body) };
    }
    const s = session.byGeneration(body.generation);
    switch (action) {
      case "update-session":
        fields(body, ["generation", "action"], ["title", "talkingPoints"]);
        session.update(s, body);
        break;
      case "live": {
        fields(body, ["generation", "action", "value"]);
        const paused = session.setLive(s, boolean(body.value));
        return {
          ok: true,
          generation: s.generation,
          paused: paused ? session.info(paused) : null,
        };
      }
      case "reset":
        fields(body, ["generation", "action", "confirmation"]);
        return { ok: true, ...session.reset(s, body.confirmation) };
      case "intake":
        fields(body, ["generation", "action", "value"]);
        session.setIntakePaused(s, boolean(body.value));
        break;
      case "agent":
        fields(body, ["generation", "action", "value"]);
        session.setAgentPaused(s, boolean(body.value));
        break;
      case "select":
        fields(body, ["generation", "action", "questionId"]);
        session.select(s, body.questionId);
        break;
      case "answered":
        fields(body, ["generation", "action", "questionId", "value"]);
        session.markAnswered(s, body.questionId, boolean(body.value));
        break;
      case "hide":
        fields(body, ["generation", "action", "questionId", "value"]);
        session.setHidden(s, body.questionId, boolean(body.value));
        break;
      case "closing":
        fields(body, ["generation", "action"]);
        session.requestClosing(s);
        break;
      default:
        fail(400, "UNKNOWN_ACTION", "Unknown host action.");
    }
    return { ok: true, generation: s.generation };
  }),
);
