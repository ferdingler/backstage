import { route } from "@/api";
import { db } from "@/db";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = route({}, () => {
  db.prepare("SELECT 1").get();
  return { ok: true };
});
