import assert from "node:assert/strict";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "@playwright/test";

import { createDevelopmentServer } from "../../server.mjs";

const digest = "a".repeat(64);
const specificationDigest = "c".repeat(64);
const now = "2026-07-27T00:00:00Z";
const mcpGrant = { role: "developer", server_id: "github_readonly_mcp", server_version: "1.0.0", server_manifest_sha256: "b".repeat(64), tool_name: "catalog_read", input_schema_sha256: "c".repeat(64), repository_scope: "acme/api-gateway" };

function listen(server) {
  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("test server did not bind a TCP address"));
      resolve(`http://127.0.0.1:${address.port}`);
    });
    server.once("error", reject);
  });
}

function close(server) {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function send(response, code, body, headers = {}) {
  response.writeHead(code, { "content-type": "application/json", ...headers });
  response.end(body ? JSON.stringify(body) : "");
}

test("operator decision refreshes a browser-rendered authoritative Workflow Canvas and Dossier", async ({ page }) => {
  let approved = false;
  const actions = [];
  const feedback = [];
  const run = (detail = false) => {
    const stages = [
      { stage_id: "specification", label: "Specification", state: "completed", availability: "authoritative", reason: "Specification stored.", artifact_kind: "source" },
      { stage_id: "product_specification", label: "Product specification", state: "completed", availability: "authoritative", reason: "Specification selected.", artifact_kind: "product_specification" },
      { stage_id: "planning", label: "Planning", state: "completed", availability: "authoritative", reason: "Plan generated.", artifact_kind: "plan" },
      { stage_id: "plan_approval", label: "Plan approval", state: approved ? "completed" : "awaiting_operator", availability: "authoritative", reason: approved ? "Gate advanced." : "Decision required.", artifact_kind: "plan" },
      { stage_id: "implementation", label: "Implementation", state: "unavailable", availability: "unavailable", reason: "Not started.", artifact_kind: null },
      { stage_id: "implementation_approval", label: "Implementation approval", state: "unavailable", availability: "unavailable", reason: "Not started.", artifact_kind: null }
    ];
    return {
    run_id: "run-browser-e2e",
    project_id: "default",
    status: approved ? "completed" : "awaiting_plan_approval",
    submitted_at: now,
    workflow_id: "planning-run-browser-e2e-revision-1",
    stages,
    workflow_graph: {
      nodes: stages.map((stage) => ({ ...stage, node_type: stage.stage_id.includes("approval") ? "gate" : stage.stage_id === "specification" ? "queue" : "agent" })),
      edges: [
        { source_node_id: "specification", target_node_id: "product_specification", style: "solid", emphasis: "primary" },
        { source_node_id: "product_specification", target_node_id: "planning", style: "solid", emphasis: "primary" },
        { source_node_id: "planning", target_node_id: "plan_approval", style: "solid", emphasis: "primary" },
        { source_node_id: "plan_approval", target_node_id: "implementation", style: "solid", emphasis: "primary" },
        { source_node_id: "implementation", target_node_id: "implementation_approval", style: "solid", emphasis: "primary" }
      ]
    },
    active_gate: approved ? null : "plan",
    artifacts: [{ kind: "source", sha256: digest }, { kind: "product_specification", sha256: specificationDigest }, { kind: "plan", sha256: digest }],
    abilities: ["view", "approve"],
    workflow: ["planning", "plan", "plan_approval"],
    budget: { max_cost_usd: 3, max_wall_clock_minutes: 45, max_review_rounds: 2, actual_cost_usd: detail ? 1.25 : null, turns_used: detail ? 42 : null },
    approval_history_available: true,
    approval_history: detail ? [{ decision_id: "decision-browser-e2e", gate: "plan", decision: "approve", artifact_sha256: digest, actor_id: "operator-browser", created_at: now, delivered: true }] : [],
    execution: detail ? { phase_count: 2, succeeded_phase_count: 2, failed_phase_count: 0, verification_passed: 2, verification_failed: 0, review_status: "converged", validation_status: "passed" } : null,
    external_links: detail ? [{ kind: "repository", label: "Repository", url: "https://github.com/acme/api-gateway" }] : [],
    mcp_capabilities: { state: approved ? "approved" : "awaiting_plan_approval", pinned_grants: [mcpGrant], selected_grants: approved ? [] : null, invocation_evidence_available: false }
    };
  };
  const upstream = createServer((request, response) => {
    void (async () => {
      assert.equal(request.headers.authorization, "Bearer browser-e2e-token");
      const requestUrl = new URL(request.url ?? "/", "http://upstream.test");
      if (requestUrl.pathname === "/healthz") return send(response, 200, { status: "ok" });
      if (requestUrl.pathname === "/api/v1/workbench/projects") return send(response, 200, { items: [{ project_id: "default" }] });
      if (requestUrl.pathname === "/api/v1/workbench/runs") {
        const etag = approved ? '"complete"' : '"waiting"';
        if (request.headers["if-none-match"] === etag) return send(response, 304, null, { etag });
        return send(response, 200, { items: [run()], revision: etag }, { etag });
      }
      if (request.url === "/api/v1/workbench/runs/run-browser-e2e") return send(response, 200, run(true));
      if (request.url === "/api/v1/workbench/runs/run-browser-e2e/timeline") {
        return send(response, 200, { items: [{ event_id: "event-browser-e2e", event_type: "plan.awaiting_approval", occurred_at: now, stage_id: "plan_approval", stage_ids: ["planning", "plan_approval"], gate: "plan", artifact_sha256: digest, decision: null, lifecycle_status: null, delivered: true, delivery_attempt_count: 1 }], revision: "timeline" }, { etag: "timeline" });
      }
      if (request.url?.startsWith(`/api/v1/workbench/runs/run-browser-e2e/evidence/plan?artifact_sha256=${digest}`)) {
        return send(response, 200, { kind: "plan", sha256: digest, content_type: "application/json", content: "{}" });
      }
      if (request.url?.startsWith(`/api/v1/workbench/runs/run-browser-e2e/evidence/product_specification?artifact_sha256=${specificationDigest}`)) {
        return send(response, 200, { kind: "product_specification", sha256: specificationDigest, content_type: "application/json", content: '{"acceptance_criteria":[]}' });
      }
      if (request.url === "/api/v1/workbench/runs/run-browser-e2e/feedback" && request.method === "GET") {
        return send(response, 200, { items: feedback });
      }
      if (request.url === "/api/v1/workbench/runs/run-browser-e2e/feedback" && request.method === "POST") {
        let body = "";
        for await (const chunk of request) body += chunk;
        const payload = JSON.parse(body);
        const recorded = { feedback_id: "feedback-browser-e2e", run_id: "run-browser-e2e", ...payload, actor_id: "operator-browser", created_at: now };
        feedback.unshift(recorded);
        return send(response, 202, recorded);
      }
      if (request.url === "/api/v1/coordination/runs/run-browser-e2e/actions/plan" && request.method === "POST") {
        let body = "";
        for await (const chunk of request) body += chunk;
        actions.push({ payload: JSON.parse(body), key: request.headers["idempotency-key"] });
        approved = true;
        return send(response, 202, { decision_id: "decision-browser-e2e" });
      }
      return send(response, 404, { detail: "not found" });
    })().catch(() => {
      if (!response.headersSent) send(response, 500, { detail: "browser E2E upstream fixture failed" });
    });
  });
  const upstreamOrigin = await listen(upstream);
  const dirname = path.dirname(fileURLToPath(import.meta.url));
  const app = createDevelopmentServer({
    upstreamUrl: upstreamOrigin,
    token: "browser-e2e-token",
    staticDirectory: path.resolve(dirname, "../../dist")
  });
  const frontend = createServer(app);
  const frontendOrigin = await listen(frontend);
  try {
    await page.goto(frontendOrigin);
    await expect(page.getByRole("heading", { name: "Mission Control" })).toBeVisible();
    await page.goto(`${frontendOrigin}/runs/run-browser-e2e/plan`);
    await expect(page.getByRole("heading", { name: "Run detail" })).toBeVisible();
    await expect(page.getByText(digest, { exact: true })).toBeVisible();
    await page.locator(".artifact-list").getByRole("button", { name: /plan/i }).click();
    await expect(page.getByLabel("Verified evidence")).toHaveText("{}");
    await page.locator(".artifact-list").getByRole("button", { name: /Product specification/i }).click();
    await expect(page.getByLabel("Verified evidence")).toContainText("acceptance_criteria");

    await page.goto(frontendOrigin);
    await page.getByText("run-browser-e2e", { exact: true }).click();
    await expect(page.getByRole("heading", { name: "planning-run-browser-e2e-revision-1" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Focus Plan approval" })).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator(".embedded-dossier").getByRole("heading", { name: "Plan approval", exact: true })).toBeVisible();
    await expect(page).toHaveURL(/\/workflows\/run-browser-e2e$/);
    await page.reload();
    await expect(page.getByRole("button", { name: "Focus Plan approval" })).toBeVisible();
    await page.getByRole("button", { name: "Focus Implementation", exact: true }).click();
    await expect(page.getByRole("button", { name: "Focus Implementation", exact: true })).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("button", { name: "Focus Plan approval" }).click();
    await expect(page.getByLabel("Selected stage details").getByText("Decision required.")).toBeVisible();
    await page.getByRole("tab", { name: "Audit activity" }).click();
    await expect(page.getByText("plan.awaiting approval")).toBeVisible();
    await page.getByRole("button", { name: "Focus Planning" }).click();
    await page.getByRole("tab", { name: "Overview" }).click();
    await expect(page.getByText("plan.awaiting approval")).toBeVisible();
    await page.getByRole("button", { name: "Focus Plan approval" }).click();
    for (const name of ["Specifications", "Configuration", "Dependencies", "History"]) await page.getByRole("tab", { name }).click();
    await page.getByRole("tab", { name: "Specifications" }).click();
    await page.getByLabel("Context for reviewers").fill("Clarify rollout risk.");
    await page.getByRole("button", { name: "Record context" }).click();
    await expect(page.getByText(/use Request revision when the work itself needs to change/)).toBeVisible();
    await expect(page.getByText(/Clarify rollout risk\./)).toBeVisible();
    await page.getByRole("tab", { name: "Overview" }).click();
    await expect(page.getByText("developer: github_readonly_mcp@1.0.0 / catalog_read / acme/api-gateway")).toBeVisible();
    await page.getByRole("checkbox", { name: /catalog_read/ }).uncheck();
    await page.getByRole("button", { name: "Approve" }).click();
    await expect.poll(() => actions.length).toBe(1);
    assert.equal(actions[0].payload.decision, "approve");
    assert.equal(actions[0].payload.artifact_sha256, digest);
    assert.deepEqual(actions[0].payload.mcp_selection, []);
    assert.equal(typeof actions[0].key, "string");
    await expect(page.getByRole("button", { name: "Approve" })).toHaveCount(0);
    await expect(page.getByText("Decision accepted; canonical state has been refreshed.")).toBeVisible();
  } finally {
    await close(frontend);
    await close(upstream);
  }
});
