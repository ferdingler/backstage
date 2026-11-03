import { route } from "@/api";
import { transaction } from "@/db";
import * as session from "@/session";
import * as work from "@/work";
import { fields } from "@/validate";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const POST = route({}, ({ body }) =>
  transaction(async () => {
    const s = await session.forAgent(body.generation);
    fields(body, ["generation", "workId"]);
    return work.acknowledge(s, body.workId);
  }),
);
