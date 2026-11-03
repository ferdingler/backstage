import { route } from "@/api";
import { config } from "@/db";
import * as session from "@/session";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = route({ visitor: "mint", rate: "read" }, async () => {
  const live = await session.live();
  const state = live ? await session.snapshot(live) : null;
  return {
    session: state?.session ?? null,
    event: {
      generation: state?.event.generation ?? null,
      audienceUrl: config.audienceUrl,
    },
    question: state?.questions.find((q) => q.selected && !q.hidden) ?? null,
  };
});
