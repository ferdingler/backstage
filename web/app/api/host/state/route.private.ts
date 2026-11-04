import { route } from "@/api";
import * as session from "@/session";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = route({}, async ({ req }) =>
  session.hostView(
    await session.byIdOrDefault(req.nextUrl.searchParams.get("session")),
  ),
);
