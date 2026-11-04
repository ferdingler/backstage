import { route } from "@/api";
import { transaction } from "@/db";
import * as session from "@/session";
import { boolean, fail, fields } from "@/validate";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** One endpoint for every host action, selected by `action`. */
export const POST = route({ origin: "host" }, ({ body }) =>
  transaction(async () => {
    const action = body.action;
    if (action === "create-session") {
      fields(body, ["action", "title"], ["talkingPoints"]);
      return { ok: true, ...(await session.create(body)) };
    }
    const s = await session.byGeneration(body.generation);
    switch (action) {
      case "update-session":
        fields(body, ["generation", "action"], ["title", "talkingPoints"]);
        await session.update(s, body);
        break;
      case "live": {
        fields(body, ["generation", "action", "value"]);
        const paused = await session.setLive(s, boolean(body.value));
        return {
          ok: true,
          generation: s.generation,
          paused: paused ? session.info(paused) : null,
        };
      }
      case "reset":
        fields(body, ["generation", "action", "confirmation"]);
        return { ok: true, ...(await session.reset(s, body.confirmation)) };
      case "intake":
        fields(body, ["generation", "action", "value"]);
        await session.setIntakePaused(s, boolean(body.value));
        break;
      case "agent":
        fields(body, ["generation", "action", "value"]);
        await session.setAgentPaused(s, boolean(body.value));
        break;
      case "select":
        fields(body, ["generation", "action", "questionId"]);
        await session.select(s, body.questionId);
        break;
      case "answered":
        fields(body, ["generation", "action", "questionId", "value"]);
        await session.markAnswered(s, body.questionId, boolean(body.value));
        break;
      case "hide":
        fields(body, ["generation", "action", "questionId", "value"]);
        await session.setHidden(s, body.questionId, boolean(body.value));
        break;
      case "closing":
        fields(body, ["generation", "action"]);
        await session.requestClosing(s);
        break;
      default:
        fail(400, "UNKNOWN_ACTION", "Unknown host action.");
    }
    return { ok: true, generation: s.generation };
  }),
);
