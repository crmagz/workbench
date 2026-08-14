/** @jest-environment node */

import type { Server } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { jest } from "@jest/globals";

import { createDevelopmentServer, createProductionServer, createRelay, createSessionRelay } from "../server.mjs";

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("relay did not bind a TCP address");
  return `http://127.0.0.1:${address.port}`;
}

test("forwards only allowlisted Workbench requests with the server-side credential", async () => {
  const upstream = jest.fn(async (): Promise<Response> => new Response(JSON.stringify({ items: [] }), { status: 200 }));
  const app = createRelay({
    upstreamUrl: "https://api.example.test",
    token: "server-only-token",
    fetchImpl: upstream as unknown as typeof fetch
  });
  const server = app.listen(0, "127.0.0.1");
  const origin = await listen(server);

  const allowed = await fetch(`${origin}/api/cogito/api/v1/workbench/runs`);
  const timeline = await fetch(`${origin}/api/cogito/api/v1/workbench/runs/run-123/timeline`);
  const feedback = await fetch(`${origin}/api/cogito/api/v1/workbench/runs/run-123/feedback`);
  const revise = await fetch(`${origin}/api/cogito/api/v1/planning-runs/run-123/revise-product-specification`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ specification: { text: "x".repeat(17 * 1024) } })
  });
  const productSpecification = await fetch(`${origin}/api/cogito/api/v1/workbench/runs/run-123/evidence/product_specification?artifact_sha256=${"a".repeat(64)}`);
  const denied = await fetch(`${origin}/api/cogito/api/v1/runs`);
  const crossOrigin = await fetch(`${origin}/api/cogito//attacker.example/api/v1/workbench/runs`);
  await new Promise<void>((resolve, reject) => server.close((error?: Error) => error ? reject(error) : resolve()));

  expect(allowed.status).toBe(200);
  expect(denied.status).toBe(404);
  expect(crossOrigin.status).toBe(404);
  expect(timeline.status).toBe(200);
  expect(feedback.status).toBe(200);
  expect(productSpecification.status).toBe(200);
  expect(revise.status).toBe(200);
  expect(upstream).toHaveBeenCalledTimes(5);
  expect(upstream).toHaveBeenCalledWith(
    new URL("https://api.example.test/api/v1/planning-runs/run-123/revise-product-specification"),
    expect.objectContaining({ body: expect.stringContaining("x".repeat(17 * 1024)) })
  );
  expect(upstream).toHaveBeenCalledWith(
    new URL("https://api.example.test/api/v1/workbench/runs"),
    expect.objectContaining({ headers: expect.objectContaining({ authorization: "Bearer server-only-token" }) })
  );
  expect(upstream).toHaveBeenCalledWith(
    new URL("https://api.example.test/api/v1/workbench/runs/run-123/timeline"),
    expect.objectContaining({ headers: expect.objectContaining({ authorization: "Bearer server-only-token" }) })
  );
  expect(upstream).toHaveBeenCalledWith(
    new URL("https://api.example.test/api/v1/workbench/runs/run-123/feedback"),
    expect.objectContaining({ headers: expect.objectContaining({ authorization: "Bearer server-only-token" }) })
  );
});

test("forwards only the bounded read-only Agent Operations paths", async () => {
  const upstream = jest.fn(async (): Promise<Response> => new Response(JSON.stringify({ items: [] }), { status: 200 }));
  const app = createRelay({ upstreamUrl: "https://api.example.test", token: "server-only-token", fetchImpl: upstream as unknown as typeof fetch });
  const server = app.listen(0, "127.0.0.1");
  const origin = await listen(server);

  const inventory = await fetch(`${origin}/api/cogito/api/v1/workbench/agents?project_id=default`);
  const detail = await fetch(`${origin}/api/cogito/api/v1/workbench/agents/developer/1.0.0?project_id=default`);
  const history = await fetch(`${origin}/api/cogito/api/v1/workbench/agents/developer/1.0.0/invocations?project_id=default`);
  const invocation = await fetch(`${origin}/api/cogito/api/v1/workbench/agent-invocations/run-1/developer?project_id=default`);
  const denied = await fetch(`${origin}/api/cogito/api/v1/workbench/agents`, { method: "POST" });
  await new Promise<void>((resolve, reject) => server.close((error?: Error) => error ? reject(error) : resolve()));

  expect([inventory.status, detail.status, history.status, invocation.status]).toEqual([200, 200, 200, 200]);
  expect(denied.status).toBe(404);
  expect(upstream).toHaveBeenCalledTimes(4);
  expect(upstream).toHaveBeenCalledWith(
    new URL("https://api.example.test/api/v1/workbench/agent-invocations/run-1/developer?project_id=default"),
    expect.objectContaining({ method: "GET", headers: expect.objectContaining({ authorization: "Bearer server-only-token" }) })
  );
});

test("preserves queries, selected request headers, upstream errors, ETags, and empty 304 responses", async () => {
  const upstream = jest.fn(async (url: URL, init: RequestInit): Promise<Response> => {
    if (url.searchParams.has("artifact_sha256")) {
      return new Response(JSON.stringify({ detail: "evidence not found" }), { status: 404 });
    }
    if (new Headers(init.headers).get("if-none-match") === '"current"') {
      return new Response(null, { status: 304, headers: { ETag: '"current"' } });
    }
    return new Response(JSON.stringify({ decision_id: "decision-1" }), { status: 202, headers: { ETag: '"next"' } });
  });
  const app = createRelay({
    upstreamUrl: "https://api.example.test/base/",
    token: "server-only-token",
    fetchImpl: upstream as unknown as typeof fetch
  });
  const server = app.listen(0, "127.0.0.1");
  const origin = await listen(server);

  const notModified = await fetch(`${origin}/api/cogito/api/v1/workbench/runs`, {
    headers: { "If-None-Match": '"current"' }
  });
  const evidence = await fetch(
    `${origin}/api/cogito/api/v1/workbench/runs/run-123/evidence/plan?artifact_sha256=digest%26value`
  );
  const action = await fetch(`${origin}/api/cogito/api/v1/coordination/runs/run-123/actions/plan`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": "action-1" },
    body: JSON.stringify({ decision: "approve", artifact_sha256: "a".repeat(64), mcp_selection: [{ role: "developer", server_id: "github_readonly_mcp" }] })
  });
  await new Promise<void>((resolve, reject) => server.close((error?: Error) => error ? reject(error) : resolve()));

  expect(notModified.status).toBe(304);
  expect(notModified.headers.get("etag")).toBe('"current"');
  await expect(notModified.text()).resolves.toBe("");
  expect(evidence.status).toBe(404);
  await expect(evidence.json()).resolves.toEqual({ detail: "evidence not found" });
  expect(action.status).toBe(202);
  expect(action.headers.get("etag")).toBe('"next"');
  expect(await action.json()).toEqual({ decision_id: "decision-1" });
  expect(upstream).toHaveBeenNthCalledWith(
    1,
    new URL("https://api.example.test/api/v1/workbench/runs"),
    expect.objectContaining({ headers: expect.objectContaining({ authorization: "Bearer server-only-token", "if-none-match": '"current"' }) })
  );
  expect(upstream).toHaveBeenNthCalledWith(
    2,
    new URL("https://api.example.test/api/v1/workbench/runs/run-123/evidence/plan?artifact_sha256=digest%26value"),
    expect.objectContaining({ headers: expect.objectContaining({ authorization: "Bearer server-only-token" }) })
  );
  expect(upstream).toHaveBeenNthCalledWith(
    3,
    new URL("https://api.example.test/api/v1/coordination/runs/run-123/actions/plan"),
    expect.objectContaining({
      headers: expect.objectContaining({ authorization: "Bearer server-only-token", "idempotency-key": "action-1" }),
      body: expect.stringContaining('"mcp_selection"')
    })
  );
});

test("refuses a static-token standalone server in production", () => {
  expect(() => createDevelopmentServer({
    upstreamUrl: "https://api.example.test",
    token: "server-only-token",
    environment: "production"
  })).toThrow("Production startup requires an OIDC session relay");
});

test("requires a configured session relay for production", () => {
  expect(() => createSessionRelay({ sessionRelayUrl: "" })).toThrow("COGITO_SESSION_RELAY_URL");
  expect(() => createProductionServer({ sessionRelayUrl: "https://session.example.test", staticDirectory: "" })).toThrow("static directory");
});

test("production server serves health locally and forwards only allowlisted session requests", async () => {
  const upstream = jest.fn(async (url: URL, init: RequestInit): Promise<Response> => {
    expect(init.headers).toMatchObject({ accept: "application/json", cookie: "session=verified" });
    return new Response(JSON.stringify({ path: url.pathname }), { status: 200, headers: { etag: "timeline-revision" } });
  });
  const app = createProductionServer({
    sessionRelayUrl: "https://session.example.test",
    staticDirectory: new URL("../dist", import.meta.url).pathname,
    fetchImpl: upstream as unknown as typeof fetch
  });
  const server = app.listen(0, "127.0.0.1");
  const origin = await listen(server);

  const health = await fetch(`${origin}/healthz`);
  const timeline = await fetch(`${origin}/api/cogito/api/v1/workbench/runs/run-123/timeline`, { headers: { cookie: "session=verified" } });
  const feedback = await fetch(`${origin}/api/cogito/api/v1/workbench/runs/run-123/feedback`, { headers: { cookie: "session=verified" } });
  const denied = await fetch(`${origin}/api/cogito/api/v1/workbench/runs/run-123/internal`);
  await new Promise<void>((resolve, reject) => server.close((error?: Error) => error ? reject(error) : resolve()));

  expect(health.status).toBe(200);
  expect(timeline.status).toBe(200);
  expect(timeline.headers.get("etag")).toBe("timeline-revision");
  expect(feedback.status).toBe(200);
  expect(denied.status).toBe(404);
  expect(upstream).toHaveBeenCalledWith(new URL("https://session.example.test/api/v1/workbench/runs/run-123/timeline"), expect.anything());
  expect(upstream).toHaveBeenCalledWith(new URL("https://session.example.test/api/v1/workbench/runs/run-123/feedback"), expect.anything());
});

test("preserves each session cookie and uses the session relay readiness endpoint", async () => {
  const upstream = jest.fn(async (url: URL): Promise<Response> => {
    if (url.pathname === "/ready") return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
    const headers = new Headers();
    headers.append("set-cookie", "session=renewed; Path=/; HttpOnly; Secure");
    headers.append("set-cookie", "csrf=verified; Path=/; Secure");
    return new Response(JSON.stringify({ items: [] }), { status: 200, headers });
  });
  const app = createProductionServer({
    sessionRelayUrl: "https://session.example.test",
    readinessUrl: "https://session.example.test/ready",
    staticDirectory: new URL("../dist", import.meta.url).pathname,
    fetchImpl: upstream as unknown as typeof fetch
  });
  const server = app.listen(0, "127.0.0.1");
  const origin = await listen(server);

  const ready = await fetch(`${origin}/readyz`);
  const inventory = await fetch(`${origin}/api/cogito/api/v1/workbench/runs`);
  await new Promise<void>((resolve, reject) => server.close((error?: Error) => error ? reject(error) : resolve()));

  expect(ready.status).toBe(200);
  expect(await ready.json()).toEqual({ status: "ready" });
  expect(inventory.headers.getSetCookie()).toEqual([
    "session=renewed; Path=/; HttpOnly; Secure",
    "csrf=verified; Path=/; Secure"
  ]);
  expect(upstream).toHaveBeenCalledWith(new URL("https://session.example.test/ready"), expect.anything());
});

test("fails readiness for an unavailable relay and returns a bounded timeout response", async () => {
  const timeout = jest.fn(async (_url: URL, init: RequestInit): Promise<Response> => new Promise((_resolve, reject) => {
    init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
  }));
  const app = createProductionServer({
    sessionRelayUrl: "https://session.example.test",
    staticDirectory: new URL("../dist", import.meta.url).pathname,
    fetchImpl: timeout as unknown as typeof fetch,
    upstreamTimeoutMs: 1
  });
  const server = app.listen(0, "127.0.0.1");
  const origin = await listen(server);

  const ready = await fetch(`${origin}/readyz`);
  const inventory = await fetch(`${origin}/api/cogito/api/v1/workbench/runs`);
  await new Promise<void>((resolve, reject) => server.close((error?: Error) => error ? reject(error) : resolve()));

  expect(ready.status).toBe(503);
  expect(inventory.status).toBe(504);
  await expect(inventory.json()).resolves.toEqual({ detail: "Workbench relay upstream request timed out." });
});

test("refuses a readiness endpoint outside the session relay origin", () => {
  expect(() => createSessionRelay({
    sessionRelayUrl: "https://session.example.test",
    readinessUrl: "https://attacker.example.test/healthz"
  })).toThrow("COGITO_SESSION_RELAY_READY_URL");
});

test("serves the single-page application for a deep run link without masking API routes", async () => {
  const staticDirectory = await mkdtemp(path.join(tmpdir(), "cogito-relay-static-"));
  await writeFile(path.join(staticDirectory, "index.html"), "<!doctype html><title>Cogito Operator Workbench</title>");
  const app = createDevelopmentServer({
    upstreamUrl: "https://api.example.test",
    token: "server-only-token",
    staticDirectory
  });
  const server = app.listen(0, "127.0.0.1");
  try {
    const origin = await listen(server);

    const detail = await fetch(`${origin}/runs/run-123/summary`);
    const api = await fetch(`${origin}/api/unknown`);
    const apiRoot = await fetch(`${origin}/api`);
    const health = await fetch(`${origin}/healthz`);

    expect(detail.status).toBe(200);
    expect(await detail.text()).toContain("Cogito Operator Workbench");
    expect(api.status).toBe(404);
    expect(apiRoot.status).toBe(404);
    expect(health.status).toBe(404);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error?: Error) => error ? reject(error) : resolve()));
    await rm(staticDirectory, { recursive: true, force: true });
  }
});

test("can expose local process health for packaged static-token development", async () => {
  const app = createDevelopmentServer({
    upstreamUrl: "https://api.example.test",
    token: "server-only-token",
    staticDirectory: new URL("../dist", import.meta.url).pathname,
    healthcheck: true
  });
  const server = app.listen(0, "127.0.0.1");
  const origin = await listen(server);

  const health = await fetch(`${origin}/healthz`);
  const ready = await fetch(`${origin}/readyz`);
  await new Promise<void>((resolve, reject) => server.close((error?: Error) => error ? reject(error) : resolve()));

  expect(health.status).toBe(200);
  expect(ready.status).toBe(200);
});

test("forwards only the fixed health and project inventory reads", async () => {
  const upstream = jest.fn(async (url: URL): Promise<Response> => new Response(JSON.stringify({ path: url.pathname }), { status: 200 }));
  const app = createRelay({
    upstreamUrl: "https://api.example.test",
    token: "server-only-token",
    fetchImpl: upstream as unknown as typeof fetch
  });
  const server = app.listen(0, "127.0.0.1");
  const origin = await listen(server);

  const health = await fetch(`${origin}/api/cogito/healthz`);
  const projects = await fetch(`${origin}/api/cogito/api/v1/workbench/projects`);
  const denied = await fetch(`${origin}/api/cogito/api/v1/workbench/projects/alpha`);
  await new Promise<void>((resolve, reject) => server.close((error?: Error) => error ? reject(error) : resolve()));

  expect(health.status).toBe(200);
  expect(projects.status).toBe(200);
  expect(denied.status).toBe(404);
  expect(upstream).toHaveBeenNthCalledWith(1, new URL("https://api.example.test/healthz"), expect.anything());
  expect(upstream).toHaveBeenNthCalledWith(2, new URL("https://api.example.test/api/v1/workbench/projects"), expect.anything());
});

test("returns a sanitized 502 when the configured upstream is unreachable", async () => {
  const upstream = jest.fn(async (): Promise<Response> => { throw new TypeError("fetch failed"); });
  const app = createRelay({
    upstreamUrl: "http://127.0.0.1:8000",
    token: "server-only-token",
    fetchImpl: upstream as unknown as typeof fetch
  });
  const server = app.listen(0, "127.0.0.1");
  const origin = await listen(server);

  const response = await fetch(`${origin}/api/cogito/api/v1/workbench/runs`);
  await new Promise<void>((resolve, reject) => server.close((error?: Error) => error ? reject(error) : resolve()));

  expect(response.status).toBe(502);
  await expect(response.json()).resolves.toEqual({
    detail: "Workbench relay cannot reach the configured API. Verify the local API URL and port-forward."
  });
});

test("exposes relay response counters without exposing upstream credentials", async () => {
  const app = createRelay({
    upstreamUrl: "https://api.example.test",
    token: "server-only-token",
    fetchImpl: (async () => new Response(JSON.stringify({ items: [] }), { status: 200 })) as typeof fetch
  });
  const server = app.listen(0, "127.0.0.1");
  const origin = await listen(server);

  await fetch(`${origin}/api/cogito/api/v1/workbench/runs`);
  const metrics = await fetch(`${origin}/metrics`);
  await new Promise<void>((resolve, reject) => server.close((error?: Error) => error ? reject(error) : resolve()));

  expect(metrics.status).toBe(200);
  expect(await metrics.text()).toContain('cogito_workbench_requests_total{method="GET",status="200"} 1');
});
