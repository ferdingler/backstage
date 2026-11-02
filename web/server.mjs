import http from "node:http";
import next from "next";
import { isIP } from "node:net";

const dev = process.argv.includes("--dev");
const app = next({ dev, hostname: "127.0.0.1" });
await app.prepare();
const handler = app.getRequestHandler();
const trustedProxy = process.env.TRUSTED_PROXY_IP;
const publicPaths = new Map([
  ["/", ["GET", "HEAD"]],
  ["/broadcast", ["GET", "HEAD"]],
  ["/favicon.ico", ["GET", "HEAD"]],
  ["/api/health", ["GET"]],
  ["/api/state", ["GET"]],
  ["/api/broadcast", ["GET"]],
  ["/api/questions", ["POST"]],
  ["/api/votes", ["PUT"]],
]);
const agentPaths = new Map([
  ["/api/agent/state", ["GET"]],
  ...["claim", "heartbeat", "result", "ack", "fail", "activity"].map(
    (action) => [`/api/agent/${action}`, ["POST"]],
  ),
]);
const servers = [];
function reject(res, status, message) {
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify({ error: { code: "ACCESS_DENIED", message } }));
}
for (const [channel, defaultPort, variable] of [
  ["public", 3000, "PUBLIC_PORT"],
  ["host", 3001, "HOST_PORT"],
  ["agent", 3003, "AGENT_PORT"],
]) {
  const port = Number(process.env[variable] || defaultPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error(`Invalid ${variable}`);
  const server = http.createServer(async (req, res) => {
    const raw = req.url || "/";
    // Decode once so legitimate encoded chunk filenames work; reject traversal
    // and double encodings before Next performs its own URL normalization.
    let path;
    try {
      path = decodeURIComponent(raw.split("?")[0]);
    } catch {
      return reject(res, 404, "Unknown route.");
    }
    if (
      !path.startsWith("/") ||
      path.startsWith("//") ||
      /[%\\?#\x00-\x20]/.test(path) ||
      /\/\.{1,2}(\/|$)/.test(path)
    )
      return reject(res, 404, "Unknown route.");
    const method = req.method || "GET";
    const asset =
      path.startsWith("/_next/static/") && ["GET", "HEAD"].includes(method);
    const developmentAsset =
      dev &&
      channel !== "agent" &&
      path.startsWith("/_next/") &&
      ["GET", "HEAD"].includes(method);
    const allowed =
      channel === "public"
        ? publicPaths.get(path)?.includes(method) || asset || developmentAsset
        : channel === "agent"
          ? agentPaths.get(path)?.includes(method)
          : publicPaths.get(path)?.includes(method) ||
            asset ||
            developmentAsset ||
            (["/host"].includes(path) && ["GET", "HEAD"].includes(method)) ||
            (path === "/api/host/state" && method === "GET") ||
            (path === "/api/host/control" && method === "POST");
    if (!allowed)
      return reject(res, 404, "This route is unavailable on this listener.");
    if (Number(req.headers["content-length"] || 0) > 8192)
      return reject(res, 413, "Request body exceeds 8 KiB.");
    const peer = (req.socket.remoteAddress || "unknown").replace(
      /^::ffff:/,
      "",
    );
    const trusted =
      !!trustedProxy && peer === trustedProxy && channel === "public";
    const forwardedIp = String(req.headers["x-forwarded-for"] || "");
    const ip = trusted && isIP(forwardedIp) ? forwardedIp : peer;
    const scheme =
      trusted && req.headers["x-forwarded-proto"] === "https"
        ? "https"
        : "http";
    for (const key of Object.keys(req.headers))
      if (
        key.startsWith("x-backstage-") ||
        key.startsWith("x-forwarded-") ||
        key === "forwarded"
      )
        delete req.headers[key];
    req.headers["x-backstage-channel"] = channel;
    req.headers["x-backstage-ip"] = ip;
    req.headers["x-backstage-scheme"] = scheme;
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "same-origin");
    if (path.startsWith("/api/")) res.setHeader("Cache-Control", "no-store");
    try {
      await handler(req, res);
    } catch {
      if (!res.headersSent)
        reject(res, 500, "The service could not complete this request.");
      else res.end();
    }
  });
  server.listen(port, "127.0.0.1", () =>
    console.log(`Backstage ${channel}: http://127.0.0.1:${port}`),
  );
  servers.push(server);
}
async function stop() {
  for (const s of servers) s.close();
  await app.close();
  process.exit(0);
}
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
