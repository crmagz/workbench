import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_UPSTREAM_TIMEOUT_MS = 10_000;

const allowed = [
  { method: "GET", path: /^\/healthz$/ },
  { method: "GET", path: /^\/api\/v1\/workbench\/projects$/ },
  { method: "POST", path: /^\/api\/v1\/planning-runs\/[^/]+\/(?:generate-product-specification|select-product-specification|revise-product-specification)$/ },
  { method: "GET", path: /^\/api\/v1\/workbench\/runs(?:\/[^/]+(?:\/(?:timeline|evidence\/(?:source|product_specification|plan|implementation)))?)?$/ },
  { method: "GET", path: /^\/api\/v1\/workbench\/runs\/[^/]+\/feedback$/ },
  { method: "POST", path: /^\/api\/v1\/workbench\/runs\/[^/]+\/feedback$/ },
  { method: "POST", path: /^\/api\/v1\/coordination\/runs\/[^/]+\/actions\/(?:plan|implementation)$/ }
];

function createApp() {
  const app = express();
  const requestCounts = new Map();
  app.locals.metrics = { requestCounts };
  app.disable("x-powered-by");
  app.use((request, response, next) => {
    if (request.path === "/api" || request.path.startsWith("/api/")) response.setHeader("Cache-Control", "no-store");
    response.setHeader("Referrer-Policy", "same-origin");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("X-Frame-Options", "DENY");
    response.setHeader("Content-Security-Policy", "default-src 'self'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'; object-src 'none'");
    next();
  });
  app.use(express.json({ limit: "100kb" }));
  app.use((request, response, next) => {
    if (request.path === "/api" || request.path.startsWith("/api/")) {
      response.on("finish", () => {
        const key = `${request.method}:${response.statusCode}`;
        requestCounts.set(key, (requestCounts.get(key) || 0) + 1);
      });
    }
    next();
  });
  app.get("/metrics", (_request, response) => {
    const lines = ["# HELP cogito_workbench_requests_total Workbench relay responses by method and status.", "# TYPE cogito_workbench_requests_total counter"];
    for (const [key, count] of requestCounts) {
      const [method, status] = key.split(":");
      lines.push(`cogito_workbench_requests_total{method="${method}",status="${status}"} ${count}`);
    }
    response.type("text/plain; version=0.0.4").send(`${lines.join("\n")}\n`);
  });
  return app;
}

function upstreamFailure(response, error, message) {
  const timedOut = error?.name === "TimeoutError" || error?.name === "AbortError";
  response.status(timedOut ? 504 : 502).json({ detail: timedOut ? "Workbench relay upstream request timed out." : message });
}

function timeoutFromEnvironment(value) {
  if (!value) return DEFAULT_UPSTREAM_TIMEOUT_MS;
  const timeout = Number(value);
  if (!Number.isInteger(timeout) || timeout < 100 || timeout > 60_000) {
    throw new Error("COGITO_UPSTREAM_TIMEOUT_MS must be an integer between 100 and 60000");
  }
  return timeout;
}

function copyResponseHeaders(upstreamResponse, response, { session = false } = {}) {
  for (const name of ["etag"]) {
    const value = upstreamResponse.headers.get(name);
    if (value) response.setHeader(name, value);
  }
  if (!session) return;
  const cookies = typeof upstreamResponse.headers.getSetCookie === "function"
    ? upstreamResponse.headers.getSetCookie()
    : upstreamResponse.headers.get("set-cookie") ? [upstreamResponse.headers.get("set-cookie")] : [];
  if (cookies.length) response.setHeader("Set-Cookie", cookies);
}

export function createRelay({ upstreamUrl, token, fetchImpl = fetch, upstreamTimeoutMs = DEFAULT_UPSTREAM_TIMEOUT_MS }) {
  if (!upstreamUrl || !token) {
    throw new Error("COGITO_UPSTREAM_URL and COGITO_UPSTREAM_TOKEN are required for the development relay");
  }
  const upstream = new URL(upstreamUrl);
  const app = createApp();
  app.use("/api/cogito", async (request, response) => {
    const pathWithQuery = request.originalUrl.replace(/^\/api\/cogito/, "");
    const requestUrl = new URL(pathWithQuery, upstream);
    // A scheme-relative path (for example //attacker.example/...) would make
    // URL resolve to a different host. Never forward the relay credential off
    // the explicitly configured upstream origin.
    if (requestUrl.origin !== upstream.origin || !allowed.some((rule) => rule.method === request.method && rule.path.test(requestUrl.pathname))) {
      return response.status(404).json({ detail: "Workbench relay path not found" });
    }
    try {
      const headers = { authorization: `Bearer ${token}`, accept: "application/json" };
      for (const name of ["if-none-match", "idempotency-key"]) {
        if (request.headers[name]) headers[name] = request.headers[name];
      }
      if (request.method !== "GET") headers["content-type"] = "application/json";
      const upstreamResponse = await fetchImpl(requestUrl, {
        method: request.method,
        headers,
        body: request.method === "GET" ? undefined : JSON.stringify(request.body),
        signal: AbortSignal.timeout(upstreamTimeoutMs)
      });
      const body = await upstreamResponse.text();
      copyResponseHeaders(upstreamResponse, response);
      response.status(upstreamResponse.status);
      if (body) response.type("application/json").send(body);
      else response.end();
    } catch (error) {
      upstreamFailure(response, error, "Workbench relay cannot reach the configured API. Verify the local API URL and port-forward.");
    }
  });
  return app;
}

export function createSessionRelay({ sessionRelayUrl, readinessUrl, fetchImpl = fetch, upstreamTimeoutMs = DEFAULT_UPSTREAM_TIMEOUT_MS }) {
  if (!sessionRelayUrl) {
    throw new Error("COGITO_SESSION_RELAY_URL is required for the production session relay");
  }
  const upstream = new URL(sessionRelayUrl);
  const readiness = new URL(readinessUrl || "/healthz", upstream);
  if (readiness.origin !== upstream.origin) throw new Error("COGITO_SESSION_RELAY_READY_URL must use the session relay origin");
  const app = createApp();
  app.locals.acceptingTraffic = true;
  app.get("/readyz", async (_request, response) => {
    if (!app.locals.acceptingTraffic) return response.status(503).json({ status: "draining" });
    try {
      const upstreamResponse = await fetchImpl(readiness, {
        method: "GET",
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(upstreamTimeoutMs)
      });
      return response.status(upstreamResponse.ok ? 200 : 503).json({ status: upstreamResponse.ok ? "ready" : "upstream_unavailable" });
    } catch {
      return response.status(503).json({ status: "upstream_unavailable" });
    }
  });
  app.use("/api/cogito", async (request, response) => {
    const pathWithQuery = request.originalUrl.replace(/^\/api\/cogito/, "");
    const requestUrl = new URL(pathWithQuery, upstream);
    if (requestUrl.origin !== upstream.origin || !allowed.some((rule) => rule.method === request.method && rule.path.test(requestUrl.pathname))) {
      return response.status(404).json({ detail: "Workbench relay path not found" });
    }
    try {
      const headers = { accept: "application/json" };
      for (const name of ["cookie", "if-none-match", "idempotency-key"]) {
        if (request.headers[name]) headers[name] = request.headers[name];
      }
      if (request.method !== "GET") headers["content-type"] = "application/json";
      const upstreamResponse = await fetchImpl(requestUrl, {
        method: request.method,
        headers,
        body: request.method === "GET" ? undefined : JSON.stringify(request.body),
        signal: AbortSignal.timeout(upstreamTimeoutMs)
      });
      const body = await upstreamResponse.text();
      copyResponseHeaders(upstreamResponse, response, { session: true });
      response.status(upstreamResponse.status);
      if (body) response.type("application/json").send(body);
      else response.end();
    } catch (error) {
      upstreamFailure(response, error, "Workbench session relay cannot reach the configured upstream.");
    }
  });
  return app;
}

export function createDevelopmentServer({ upstreamUrl, token, staticDirectory, healthcheck = false, environment = process.env.NODE_ENV }) {
  if (environment === "production") {
    throw new Error("Production startup requires an OIDC session relay; static upstream tokens are development-only");
  }
  const app = createRelay({ upstreamUrl, token });
  if (healthcheck) {
    app.get("/healthz", (_request, response) => response.status(200).json({ status: "ok" }));
    app.get("/readyz", (_request, response) => response.status(200).json({ status: "ready" }));
  }
  if (staticDirectory) {
    app.use(express.static(staticDirectory));
    app.use((request, response, next) => {
      const isApiPath = request.path === "/api" || request.path.startsWith("/api/");
      if (request.method !== "GET" || request.path === "/healthz" || isApiPath) return next();
      return response.sendFile("index.html", { root: staticDirectory });
    });
  }
  return app;
}

export function createProductionServer({ sessionRelayUrl, readinessUrl, staticDirectory, fetchImpl = fetch, upstreamTimeoutMs = DEFAULT_UPSTREAM_TIMEOUT_MS }) {
  if (!staticDirectory) throw new Error("A static directory is required for the production Workbench server");
  const app = createSessionRelay({ sessionRelayUrl, readinessUrl, fetchImpl, upstreamTimeoutMs });
  app.get("/healthz", (_request, response) => response.status(200).json({ status: "ok" }));
  app.use(express.static(staticDirectory));
  app.use((request, response, next) => {
    const isApiPath = request.path === "/api" || request.path.startsWith("/api/");
    if (request.method !== "GET" || request.path === "/healthz" || isApiPath) return next();
    return response.sendFile("index.html", { root: staticDirectory });
  });
  return app;
}

export function startServer(app, { port = 4173, host, shutdownTimeoutMs = 25_000 } = {}) {
  const server = app.listen(port, host);
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.locals.acceptingTraffic = false;
    const forceExit = setTimeout(() => process.exit(1), shutdownTimeoutMs);
    forceExit.unref();
    server.close(() => {
      clearTimeout(forceExit);
      process.exit(0);
    });
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dirname = path.dirname(fileURLToPath(import.meta.url));
  const upstreamTimeoutMs = timeoutFromEnvironment(process.env.COGITO_UPSTREAM_TIMEOUT_MS);
  const app = process.env.COGITO_RELAY_MODE === "session"
    ? createProductionServer({
      sessionRelayUrl: process.env.COGITO_SESSION_RELAY_URL,
      readinessUrl: process.env.COGITO_SESSION_RELAY_READY_URL,
      staticDirectory: path.join(dirname, "dist"),
      upstreamTimeoutMs
    })
    : createDevelopmentServer({
      upstreamUrl: process.env.COGITO_UPSTREAM_URL,
      token: process.env.COGITO_UPSTREAM_TOKEN,
      staticDirectory: path.join(dirname, "dist"),
      healthcheck: process.env.COGITO_RELAY_MODE === "static",
      environment: process.env.COGITO_RELAY_MODE === "static" ? "development" : process.env.NODE_ENV,
      upstreamTimeoutMs
    });
  startServer(app, { port: process.env.PORT || 4173 });
}
