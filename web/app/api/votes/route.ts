import { NextRequest } from "next/server";
import { handle } from "@/event";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function PUT(request: NextRequest) {
  return handle(request, "votes");
}
