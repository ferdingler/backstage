import { NextRequest } from "next/server";
import { handle } from "@/event";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function GET(request: NextRequest) {
  return handle(request, "broadcast");
}
