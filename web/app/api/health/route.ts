import { route } from "@/api";
import { keys, store } from "@/db";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = route({}, async () => {
  await store.get(...keys.live);
  return { ok: true };
});
