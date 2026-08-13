import { fireEvent, render, screen } from "@testing-library/react";
import { jest } from "@jest/globals";

import { DecisionControls } from "./DecisionControls";
import type { ApiClient, McpToolSelection, Run } from "./client";

const digest = "a".repeat(64);
const grant = (tool_name: string): McpToolSelection => ({ role: "developer", server_id: "github_readonly_mcp", server_version: "1.0.0", server_manifest_sha256: "b".repeat(64), tool_name, input_schema_sha256: "c".repeat(64), repository_scope: "acme/api-gateway" });
const run = (run_id: string, grants: McpToolSelection[]): Run => ({
  run_id, project_id: "default", status: "awaiting_plan_approval", submitted_at: "2026-08-13T00:00:00Z", active_gate: "plan",
  artifacts: [{ kind: "plan", sha256: digest }], abilities: ["view", "approve"], workflow: ["plan_approval"], budget: { max_cost_usd: 1, max_wall_clock_minutes: 1, max_review_rounds: 1, actual_cost_usd: null, turns_used: null }, approval_history_available: true, approval_history: [], execution: null, external_links: [],
  mcp_capabilities: { state: "awaiting_plan_approval", pinned_grants: grants, selected_grants: null, invocation_evidence_available: false }
});

test("resets a local MCP selection when the displayed run changes", async () => {
  const decide = jest.fn<ApiClient["decide"]>().mockResolvedValue(undefined);
  const client = { decide } as unknown as ApiClient;
  const onComplete = jest.fn(async () => undefined);
  const first = run("run-first", [grant("catalog_read")]);
  const second = run("run-second", [grant("issue_read")]);
  const view = render(<DecisionControls client={client} run={first} onComplete={onComplete} />);

  fireEvent.click(screen.getByRole("checkbox", { name: /catalog_read/ }));
  view.rerender(<DecisionControls client={client} run={second} onComplete={onComplete} />);
  fireEvent.click(screen.getByRole("button", { name: "Approve" }));

  await Promise.resolve();
  expect(decide).toHaveBeenCalledWith(second, "approve", "", null);
});

test("preserves a narrowed MCP selection through a transient summary refresh", async () => {
  const decide = jest.fn<ApiClient["decide"]>().mockResolvedValue(undefined);
  const client = { decide } as unknown as ApiClient;
  const onComplete = jest.fn(async () => undefined);
  const current = run("run-current", [grant("catalog_read")]);
  const summary = { ...current, mcp_capabilities: undefined };
  const view = render(<DecisionControls client={client} run={current} onComplete={onComplete} />);

  fireEvent.click(screen.getByRole("checkbox", { name: /catalog_read/ }));
  view.rerender(<DecisionControls client={client} run={summary} onComplete={onComplete} />);
  view.rerender(<DecisionControls client={client} run={current} onComplete={onComplete} />);
  fireEvent.click(screen.getByRole("button", { name: "Approve" }));

  await Promise.resolve();
  expect(decide).toHaveBeenCalledWith(current, "approve", "", []);
});

test("withholds malformed grant objects before they can become controls", () => {
  const malformed = { ...run("run-malformed", [grant("catalog_read")]), mcp_capabilities: { state: "awaiting_plan_approval", pinned_grants: [null], selected_grants: null, invocation_evidence_available: false } } as unknown as Run;
  render(<DecisionControls client={{ decide: async () => undefined } as unknown as ApiClient} run={malformed} onComplete={async () => undefined} />);

  expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
});

test("does not claim a canonical refresh when it cannot load the authoritative result", async () => {
  const decide = jest.fn<ApiClient["decide"]>().mockResolvedValue(undefined);
  render(<DecisionControls client={{ decide } as unknown as ApiClient} run={run("run-refresh", [grant("catalog_read")])} onComplete={async () => false} />);

  fireEvent.click(screen.getByRole("button", { name: "Approve" }));

  expect(await screen.findByText("Decision accepted, but canonical state could not be refreshed.")).toBeVisible();
});
