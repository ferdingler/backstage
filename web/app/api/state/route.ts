import { route } from "@/api";
import * as session from "@/session";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = route({ visitor: "mint", rate: "read" }, async ({ visitor }) => {
  const live = await session.live();
  // The audience never sees the agent's recommendation.
  return live
    ? { ...(await session.snapshot(live, visitor)), recommendation: null }
    : {
        session: null,
        event: null,
        questions: [],
        agent: null,
        recommendation: null,
      };
});
