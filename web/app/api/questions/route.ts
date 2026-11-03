import { route } from "@/api";
import * as session from "@/session";
import { fields } from "@/validate";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const POST = route(
  { origin: "public", visitor: "require", rate: "question" },
  ({ body }) => {
    fields(body, ["text"]);
    return session.ask(body.text);
  },
);
