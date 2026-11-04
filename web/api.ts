import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { isIP } from "node:net";
import { config, keys, store, transaction, ttl } from "./db";
import { ApiError, fail, object, type Json } from "./validate";
import routes from "./routes.json";

/**
 * Route handler wrapper. `route(policy, fn)` applies, in order: the listener
 * check from routes.json, the page-origin check, the visitor cookie, rate
 * limits, and the JSON body (size-capped by routes.json). It then calls `fn`
 * and maps its result to JSON and any `ApiError` to an error response.
 */

type Channel = "public" | "host" | "agent";
type ApiRoute = { method: string; channels: Channel[]; maxBody?: number };
type Policy = {
  /** Browser writes must come from one of this audience's page origins. */
  origin?: "public" | "host";
  /** "mint" issues a visitor cookie when missing; "require" rejects without one. */
  visitor?: "mint" | "require";
  /** Rate-limit bucket: reads per visitor, or writes (global, per IP, per visitor). */
  rate?: "read" | "question" | "vote";
};
export type Context = {
  req: NextRequest;
  /** Parsed JSON object for non-GET requests; empty for GET. */
  body: Json;
  /** Visitor id when the policy asks for one; empty otherwise. */
  visitor: string;
};

export function route(
  policy: Policy,
  fn: (ctx: Context) => unknown | Promise<unknown>,
) {
  return async (req: NextRequest): Promise<NextResponse> => {
    try {
      const spec = (routes.api as Record<string, ApiRoute | undefined>)[
        req.nextUrl.pathname
      ];
      const { channel } = caller(req);
      if (!spec?.channels.includes(channel))
        fail(
          403,
          "PRIVATE_ROUTE",
          "This operation is unavailable on this listener.",
        );
      if (policy.origin) checkOrigin(req, policy.origin);
      const who = policy.visitor
        ? await visitor(req, policy.visitor === "mint")
        : undefined;
      if (policy.rate) rateLimit(req, policy.rate, who!.id);
      const body =
        req.method === "GET"
          ? {}
          : await readBody(req, spec.maxBody ?? routes.defaultMaxBody);
      const res = NextResponse.json(
        await fn({ req, body, visitor: who?.id ?? "" }),
      );
      if (who?.fresh) setVisitorCookie(req, res, who.id);
      return res;
    } catch (error) {
      return errorResponse(error);
    }
  };
}

/**
 * Who is calling, and over which listener. Under server.mjs (local build) the
 * server strips client-sent x-backstage-* headers and sets them from the
 * socket, so they are trusted. The public build runs behind a managed HTTPS
 * front end (Amplify/CloudFront) with no server.mjs: it is always the public
 * channel and ignores x-backstage-* entirely. The client IP is the entry
 * FORWARDED_HOPS from the right of X-Forwarded-For (default 1, the address
 * the front end appended); entries further left are client-controlled.
 */
function caller(req: NextRequest): {
  channel: Channel;
  ip: string;
  https: boolean;
} {
  if (process.env.BACKSTAGE_BUILD === "local") {
    if (!(globalThis as { backstageListeners?: boolean }).backstageListeners)
      fail(503, "NO_LISTENERS", "Start the local build with server.mjs.");
    return {
      channel: req.headers.get("x-backstage-channel") as Channel,
      ip: req.headers.get("x-backstage-ip") || "unknown",
      https: req.headers.get("x-backstage-scheme") === "https",
    };
  }
  const hops = Number(process.env.FORWARDED_HOPS || 1);
  const chain = (req.headers.get("x-forwarded-for") || "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  const ip = chain[chain.length - hops];
  return {
    channel: "public",
    ip: ip && isIP(ip) ? ip : "unknown",
    https: req.headers.get("x-forwarded-proto") !== "http",
  };
}

function errorResponse(error: unknown) {
  if (error instanceof ApiError)
    return NextResponse.json(
      { error: { code: error.code, message: error.message } },
      {
        status: error.status,
        headers: error.retryAfter
          ? { "Retry-After": String(error.retryAfter) }
          : undefined,
      },
    );
  console.error(
    "Backstage request failed:",
    error instanceof Error ? error.message : "unknown error",
  );
  return NextResponse.json(
    {
      error: {
        code: "INTERNAL_ERROR",
        message: "The service could not complete this request.",
      },
    },
    { status: 500 },
  );
}

async function readBody(req: NextRequest, max: number): Promise<Json> {
  if (
    !(req.headers.get("content-type") || "")
      .toLowerCase()
      .startsWith("application/json")
  )
    fail(415, "JSON_REQUIRED", "Send application/json.");
  const reader = req.body?.getReader();
  let size = 0;
  const chunks: Uint8Array[] = [];
  if (reader) {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > max) {
        await reader.cancel();
        fail(
          413,
          "BODY_TOO_LARGE",
          `Request body exceeds ${Math.round(max / 1024)} KiB.`,
        );
      }
      chunks.push(value);
    }
  }
  try {
    return object(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  } catch (error) {
    if (error instanceof ApiError) throw error;
    fail(400, "INVALID_JSON", "Invalid JSON body.");
  }
}

function checkOrigin(req: NextRequest, audience: "public" | "host") {
  const local = (port: string) => [
    `http://127.0.0.1:${port}`,
    `http://localhost:${port}`,
  ];
  const publicPort = process.env.PUBLIC_PORT || "3000";
  const hostPort = process.env.HOST_PORT || "3001";
  // The host listener also serves the audience pages, so it may write as public.
  const defaults =
    audience === "host"
      ? local(hostPort)
      : [config.audienceUrl, ...local(publicPort), ...local(hostPort)];
  const extra = (
    process.env[audience === "host" ? "HOST_ORIGINS" : "PUBLIC_ORIGINS"] || ""
  )
    .split(",")
    .filter(Boolean);
  const allowed = new Set(
    [...defaults, ...extra].map((url) => {
      try {
        return new URL(url).origin;
      } catch {
        return "";
      }
    }),
  );
  const origin = req.headers.get("origin");
  if (!origin || !allowed.has(origin))
    fail(403, "ORIGIN_DENIED", "This page origin cannot make that change.");
}

const globalLimits = globalThis as typeof globalThis & {
  backstageLimits?: Map<string, { count: number; expires: number }>;
};
const limits = (globalLimits.backstageLimits ??= new Map());
function limit(key: string, maximum: number) {
  const now = Date.now();
  if (limits.size > 9000)
    for (const [k, v] of limits) if (v.expires <= now) limits.delete(k);
  let entry = limits.get(key);
  if (!entry || entry.expires <= now) {
    if (!entry && limits.size >= 10000)
      throw new ApiError(
        429,
        "RATE_LIMIT",
        "The demo is busy. Try again shortly.",
        Math.ceil(config.windowMs / 1000),
      );
    entry = { count: 0, expires: now + config.windowMs };
    limits.set(key, entry);
  }
  if (entry.count >= maximum)
    throw new ApiError(
      429,
      "RATE_LIMIT",
      "Too many requests. Please wait a moment.",
      Math.max(1, Math.ceil((entry.expires - now) / 1000)),
    );
  entry.count++;
}
function rateLimit(
  req: NextRequest,
  bucket: NonNullable<Policy["rate"]>,
  visitorId: string,
) {
  if (bucket === "read")
    return limit(`read:${visitorId}`, config.readsPerMinute);
  limit(`write-global`, config.globalWrites);
  limit(`write-ip:${caller(req).ip}`, config.writesPerIp);
  limit(
    `${bucket}:${visitorId}`,
    bucket === "question" ? config.questionsPerMinute : config.votesPerMinute,
  );
}

const visitorCookie = "backstage_visitor";
const visitorTtlSeconds = 6 * 3600;
/** A server-issued browser cookie: identifies a browser session, not a person. */
async function visitor(
  req: NextRequest,
  mint: boolean,
): Promise<{ id: string; fresh: boolean }> {
  const cookie = req.cookies.get(visitorCookie)?.value;
  if (cookie && /^[a-f0-9]{64}$/.test(cookie)) {
    const known = await store.get(...keys.visitor(cookie));
    if (known && (known.expires as number) > Date.now())
      return { id: cookie, fresh: false };
  }
  if (!mint)
    fail(
      428,
      "COOKIES_REQUIRED",
      "Enable cookies and refresh this page before participating.",
    );
  limit(`cookie:${caller(req).ip}`, config.cookiesPerIp);
  const id = randomBytes(32).toString("hex");
  const expires = Date.now() + visitorTtlSeconds * 1000;
  const [pk, sk] = keys.visitor(id);
  // Expired visitors are removed by TTL a day after their cookie lapses.
  await transaction(async () =>
    store.put({ pk, sk, expires, ttl: ttl(expires + 24 * 3600_000) }),
  );
  return { id, fresh: true };
}
function setVisitorCookie(req: NextRequest, res: NextResponse, id: string) {
  res.cookies.set(visitorCookie, id, {
    httpOnly: true,
    sameSite: "lax",
    secure: caller(req).https,
    path: "/",
    maxAge: visitorTtlSeconds,
  });
}
