import { route } from "@/api";
import * as session from "@/session";
import { boolean, fields } from "@/validate";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const PUT = route(
  { origin: "public", visitor: "require", rate: "vote" },
  ({ body, visitor }) => {
    fields(body, ["questionId", "voted"]);
    return session.vote(visitor, body.questionId, boolean(body.voted));
  },
);
