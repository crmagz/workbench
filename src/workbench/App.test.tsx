import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, jest } from "@jest/globals";

import { App } from "./App";
import type { AgentInvocationDetail, ApiClient, Run, TimelineEvent } from "./client";

const digest = "a".repeat(64);
const stages: Run["stages"] = [{ stage_id: "specification", label: "Specification", state: "completed", availability: "authoritative", reason: "Specification stored.", artifact_kind: "source" }, { stage_id: "planning", label: "Planning", state: "completed", availability: "authoritative", reason: "Plan generated.", artifact_kind: "plan" }, { stage_id: "plan_approval", label: "Plan approval", state: "awaiting_operator", availability: "authoritative", reason: "Decision required.", artifact_kind: "plan" }, { stage_id: "implementation", label: "Implementation", state: "unavailable", availability: "unavailable", reason: "Not started.", artifact_kind: null }, { stage_id: "implementation_approval", label: "Implementation approval", state: "unavailable", availability: "unavailable", reason: "Not started.", artifact_kind: null }];
const run: Run = {
  run_id: "run-12345678", project_id: "default", status: "awaiting_plan_approval", submitted_at: "2026-07-26T00:00:00Z", workflow_id: "planning-run-42-revision-1", active_gate: "plan",
  artifacts: [{ kind: "source", sha256: digest }, { kind: "plan", sha256: digest }], stages, workflow_graph: { nodes: stages.map((stage) => ({ ...stage, node_type: stage.stage_id.includes("approval") ? "gate" : stage.stage_id === "specification" ? "queue" : "agent" })), edges: [{ source_node_id: "specification", target_node_id: "planning", style: "solid", emphasis: "primary" }, { source_node_id: "planning", target_node_id: "plan_approval", style: "solid", emphasis: "primary" }, { source_node_id: "plan_approval", target_node_id: "implementation", style: "solid", emphasis: "primary" }, { source_node_id: "implementation", target_node_id: "implementation_approval", style: "solid", emphasis: "primary" }] }, abilities: ["view", "approve"], workflow: ["planning", "plan", "plan_approval"],
  budget: { max_cost_usd: 3, max_wall_clock_minutes: 45, max_review_rounds: 2, actual_cost_usd: null, turns_used: null }, approval_history_available: true, approval_history: [], execution: null, external_links: []
};
const events: TimelineEvent[] = [{ event_id: "event-1", event_type: "plan.awaiting_approval", occurred_at: "2026-07-26T00:00:00Z", stage_id: "plan_approval", stage_ids: ["planning", "plan_approval"], gate: "plan", artifact_sha256: digest, decision: null, lifecycle_status: null, delivered: true, delivery_attempt_count: 1 }];
const mcpGrant = { role: "developer", server_id: "github_readonly_mcp", server_version: "1.0.0", server_manifest_sha256: "b".repeat(64), tool_name: "catalog_read", input_schema_sha256: "c".repeat(64), repository_scope: "acme/api-gateway" };

function client(overrides: Partial<ApiClient> = {}): ApiClient {
  return { listProjects: async () => [{ project_id: "default" }], getHealth: async () => true, listRuns: async () => ({ runs: [run], revision: "runs", etag: "runs", unchanged: false }), getRun: async () => run, getTimeline: async () => ({ events, revision: "timeline", etag: "timeline", unchanged: false }), getEvidence: async () => ({ content: '{"title":"verified"}', sha256: digest }), getFeedback: async () => [], recordFeedback: async () => ({ feedback_id: "feedback-1", run_id: run.run_id, intent: "note", artifact_sha256: digest, stage_id: "planning", actor_id: "operator", comment: "Recorded note", created_at: "2026-08-02T00:00:00Z" }), decide: async () => undefined, generateProductSpecification: async () => undefined, acceptProductSpecification: async () => ({ outcome: "accepted" }), cancelPlanningRun: async () => undefined, evaluateProductSpecification: async () => undefined, waiveSpecificationEvaluation: async () => undefined, generatePlan: async () => undefined, selectProductSpecification: async () => undefined, reviseProductSpecification: async () => undefined, listAgents: async () => ({ agents: [], revision: "agents", etag: "agents", unchanged: false }), getAgent: async () => { throw new Error("agent unavailable"); }, listAgentInvocations: async () => ({ invocations: [], revision: "invocations", etag: "agents", unchanged: false }), getAgentInvocation: async () => { throw new Error("agent unavailable"); }, ...overrides };
}

beforeEach(() => { window.history.replaceState({}, "", "/"); window.localStorage.clear(); });

test("migrates the legacy stored theme preference", async () => {
  window.localStorage.setItem("cogito-workbench-theme", "dark");
  render(<App client={client()} />);

  expect(await screen.findByRole("heading", { name: "Mission Control" })).toBeVisible();
  expect(screen.getByRole("combobox", { name: "Theme" })).toHaveValue("dark");
  expect(window.localStorage.getItem("workbench-theme")).toBe("dark");
});

test("shows a persisted terminal failure reason in workflow audit activity", async () => {
  const failedRun: Run = {
    ...run,
    status: "planning_failed",
    active_gate: null,
    failure_summary: "Execution workspace could not load the selected specification package.",
    stages: stages.map((stage) => stage.stage_id === "planning" ? { ...stage, state: "failed" } : stage),
  };
  const failedEvents: TimelineEvent[] = [{
    ...events[0],
    event_id: "event-failed",
    event_type: "run_status_changed",
    lifecycle_status: "FAILED",
    stage_id: "planning",
    stage_ids: ["planning"],
  }];
  const user = userEvent.setup();
  render(<App client={client({
    listRuns: async () => ({ runs: [failedRun], revision: "runs", etag: "runs", unchanged: false }),
    getRun: async () => failedRun,
    getTimeline: async () => ({ events: failedEvents, revision: "timeline", etag: "timeline", unchanged: false }),
  })} />);

  await user.click(await screen.findByText(failedRun.workflow_id!));
  expect(await screen.findByRole("alert")).toHaveTextContent("Execution workspace could not load the selected specification package.");
  expect(screen.getByRole("heading", { name: "Workflow audit activity" })).toBeVisible();
});

test("keeps the completed evaluation in focus after specification acceptance", async () => {
  const acceptedStages: Run["stages"] = [
    { stage_id: "specification", label: "Specification", state: "completed", availability: "authoritative", reason: "Recorded.", artifact_kind: "source" },
    { stage_id: "product_specification", label: "Product specification", state: "completed", availability: "authoritative", reason: "Accepted.", artifact_kind: "product_specification" },
    { stage_id: "specification_evaluation", label: "Specification evaluation", state: "completed", availability: "authoritative", reason: "Recorded.", artifact_kind: "specification_evaluation" },
    { stage_id: "planning", label: "Planning", state: "awaiting_operator", availability: "authoritative", reason: "Proceed when ready.", artifact_kind: null },
  ];
  const acceptedRun: Run = {
    ...run,
    active_gate: null,
    artifacts: [{ kind: "source", sha256: digest }, { kind: "product_specification", sha256: digest }, { kind: "specification_evaluation", sha256: digest }],
    stages: acceptedStages,
    workflow_graph: { nodes: acceptedStages.map((stage) => ({ ...stage, node_type: stage.stage_id === "planning" ? "agent" : "queue" })), edges: acceptedStages.slice(1).map((stage, index) => ({ source_node_id: acceptedStages[index].stage_id, target_node_id: stage.stage_id, style: "solid", emphasis: "primary" })) },
  };
  const user = userEvent.setup();
  render(<App client={client({ listRuns: async () => ({ runs: [acceptedRun], revision: "runs", etag: "runs", unchanged: false }), getRun: async () => acceptedRun })} />);

  await user.click(await screen.findByText(acceptedRun.workflow_id!));
  expect(await screen.findByRole("heading", { name: "Specification evaluation" })).toBeVisible();
});

test("renders project-scoped agent operations without offering execution controls", async () => {
  const agent = {
    registration_id: "developer", registration_version: "1.0.0", manifest_sha256: "b".repeat(64), component_id: "developer", component_version: "1.0.0", lifecycle: "active", maturity: "active", execution_class: "adapter", owner: "cogito-platform", capabilities: ["develop"],
    gateway_routes: [{ policy_revision: "gateway-v1", role: "developer", model_alias: "complex", max_budget_usd: 25, toolset: "development-restricted" }]
  };
  const binding = { run_id: "run-agent-1", root_run_id: run.run_id, parent_run_id: null, registration_id: "developer", registration_version: "1.0.0", role: "developer", run_lifecycle_status: "RUNNING", created_at: "2026-08-13T00:00:00Z", updated_at: "2026-08-13T00:01:00Z", gateway_route: agent.gateway_routes[0] };
  const user = userEvent.setup();
  render(<App client={client({
    listAgents: async () => ({ agents: [agent], revision: "agents", etag: "agents", unchanged: false }),
    getAgent: async () => agent,
    listAgentInvocations: async () => ({ invocations: [binding], revision: "bindings", etag: "bindings", unchanged: false }),
    getAgentInvocation: async () => { throw new Error("workflow navigation does not fetch an invocation detail"); }
  })} />);

  await user.click(await screen.findByRole("button", { name: "Agents" }));
  expect(await screen.findByRole("heading", { name: "Agent Operations" })).toBeVisible();
  expect(screen.getByRole("button", { name: "Move Role / toolset column" })).toBeVisible();
  expect(screen.getByRole("button", { name: "Move Capabilities column" })).toBeVisible();
  expect(screen.getByRole("button", { name: "Move Owner column" })).toBeVisible();
  expect(screen.getByRole("button", { name: "Move Model column" })).toBeVisible();
  expect(screen.getByRole("button", { name: "Move Budget column" })).toBeVisible();
  expect(screen.getByText(/Root-run lifecycle is authoritative/)).toBeVisible();
  expect(screen.getByRole("button", { name: "Create Agent" })).toBeDisabled();

  const budgetColumn = screen.getByRole("button", { name: "Move Budget column" });
  fireEvent.dragStart(budgetColumn);
  fireEvent.dragOver(screen.getByRole("button", { name: "Move Owner column" }));
  fireEvent.drop(screen.getByRole("button", { name: "Move Owner column" }));
  expect(document.querySelector(".agent-release-columns")?.textContent?.indexOf("Budget")).toBeLessThan(document.querySelector(".agent-release-columns")?.textContent?.indexOf("Owner") ?? -1);

  await user.click(screen.getByRole("button", { name: "Customize catalog columns" }));
  expect(screen.getByRole("dialog", { name: "Catalog columns" })).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Toggle catalog column Owner" }));
  expect(screen.getByRole("button", { name: "Toggle catalog column Owner" })).toHaveAttribute("aria-pressed", "false");
  expect(screen.queryByRole("button", { name: "Move Owner column" })).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Show all" }));
  expect(screen.getByRole("button", { name: "Toggle catalog column Owner" })).toHaveAttribute("aria-pressed", "true");
  await user.click(screen.getByRole("button", { name: "Customize catalog columns" }));
  expect(screen.getByRole("button", { name: "Move Owner column" })).toBeVisible();
  await user.click(screen.getByRole("button", { name: /Open workflow for developer running invocation/i }));
  expect(window.location.pathname).toBe(`/workflows/${run.run_id}`);
  expect(await screen.findByRole("button", { name: "Focus Specification" })).toBeVisible();
});

test("opens the originating workflow from an immutable agent invocation", async () => {
  const developer = { registration_id: "developer", registration_version: "1.0.0", manifest_sha256: "b".repeat(64), component_id: "developer", component_version: "1.0.0", lifecycle: "active", maturity: "active", execution_class: "adapter", owner: "cogito-platform", capabilities: ["develop"], gateway_routes: [{ policy_revision: "gateway-v1", role: "developer", model_alias: "complex", max_budget_usd: 25, toolset: "development-restricted" }] };
  const binding = { run_id: "run-agent-1", root_run_id: run.run_id, parent_run_id: null, registration_id: "developer", registration_version: "1.0.0", role: "developer", run_lifecycle_status: "RUNNING", created_at: "2026-08-13T00:00:00Z", updated_at: "2026-08-13T00:01:00Z", gateway_route: developer.gateway_routes[0] };
  const user = userEvent.setup();
  render(<App client={client({
    listAgents: async () => ({ agents: [developer], revision: "agents", etag: "agents", unchanged: false }),
    getAgent: async () => developer,
    listAgentInvocations: async () => ({ invocations: [binding], revision: "bindings", etag: "bindings", unchanged: false }),
    getAgentInvocation: async () => { throw new Error("workflow navigation does not fetch an invocation detail"); }
  })} />);

  await user.click(await screen.findByRole("button", { name: "Agents" }));
  await user.click(await screen.findByRole("button", { name: /Open workflow for developer running invocation/i }));

  expect(window.location.pathname).toBe(`/workflows/${run.run_id}`);
  expect(await screen.findByRole("button", { name: "Focus Specification" })).toBeVisible();
});

test("opening an agent invocation replaces a previously selected workflow", async () => {
  const secondRun: Run = { ...run, run_id: "run-87654321", workflow_id: "planning-run-43-revision-1" };
  const developer = { registration_id: "developer", registration_version: "1.0.0", manifest_sha256: "b".repeat(64), component_id: "developer", component_version: "1.0.0", lifecycle: "active", maturity: "active", execution_class: "adapter", owner: "cogito-platform", capabilities: ["develop"], gateway_routes: [{ policy_revision: "gateway-v1", role: "developer", model_alias: "complex", max_budget_usd: 25, toolset: "development-restricted" }] };
  const binding = { run_id: "run-agent-2", root_run_id: secondRun.run_id, parent_run_id: null, registration_id: "developer", registration_version: "1.0.0", role: "developer", run_lifecycle_status: "RUNNING", created_at: "2026-08-13T00:00:00Z", updated_at: "2026-08-13T00:01:00Z", gateway_route: developer.gateway_routes[0] };
  const user = userEvent.setup();
  render(<App client={client({
    listRuns: async () => ({ runs: [run, secondRun], revision: "runs", etag: "runs", unchanged: false }),
    getRun: async (runId) => runId === secondRun.run_id ? secondRun : run,
    listAgents: async () => ({ agents: [developer], revision: "agents", etag: "agents", unchanged: false }),
    getAgent: async () => developer,
    listAgentInvocations: async () => ({ invocations: [binding], revision: "bindings", etag: "bindings", unchanged: false })
  })} />);

  await user.click(await screen.findByText(run.workflow_id!));
  expect(await screen.findByRole("heading", { name: run.workflow_id! })).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Agents" }));
  await user.click(await screen.findByRole("button", { name: /Open workflow for developer running invocation/i }));

  expect(window.location.pathname).toBe(`/workflows/${secondRun.run_id}`);
  expect(await screen.findByRole("heading", { name: secondRun.workflow_id! })).toBeVisible();
});

test("renders safe role pins without replacing the originating workflow action", async () => {
  const developer = { registration_id: "developer", registration_version: "1.0.0", manifest_sha256: "b".repeat(64), component_id: "developer", component_version: "1.0.0", lifecycle: "active", maturity: "active", execution_class: "adapter", owner: "cogito-platform", capabilities: ["develop"], gateway_routes: [{ policy_revision: "gateway-v1", role: "developer", model_alias: "complex", max_budget_usd: 25, toolset: "development-restricted" }] };
  const binding = { run_id: "run-agent-3", root_run_id: run.run_id, parent_run_id: null, registration_id: "developer", registration_version: "1.0.0", role: "developer", run_lifecycle_status: "RUNNING", workflow_available: false, created_at: "2026-08-13T00:00:00Z", updated_at: "2026-08-13T00:01:00Z", gateway_route: developer.gateway_routes[0] };
  const user = userEvent.setup();
  render(<App client={client({
    listAgents: async () => ({ agents: [developer], revision: "agents", etag: "agents", unchanged: false }),
    getAgent: async () => developer,
    listAgentInvocations: async () => ({ invocations: [binding], revision: "bindings", etag: "bindings", unchanged: false }),
    getAgentInvocation: async () => ({ ...binding, mcp_grants: [{ server_id: "catalog", server_version: "1.0.0", server_manifest_sha256: "c".repeat(64), tool_name: "read", input_schema_sha256: "d".repeat(64), repository_scope: null }], lifecycle_transitions: [], evidence: { lifecycle: "available", actual_cost: "unavailable", turns_used: "unavailable", result_artifact: "redacted", failure_detail: "redacted", mcp_invocation_outcome: "unavailable" } })
  })} />);

  await user.click(await screen.findByRole("button", { name: "Agents" }));
  await user.click(await screen.findByRole("button", { name: /View role pins for developer run-agent-3/i }));

  expect(await screen.findByRole("heading", { name: /developer.*v1\.0\.0/i })).toBeVisible();
  expect(screen.getByText("catalog")).toBeVisible();
  expect(screen.getByText(/v1\.0\.0.*read/i)).toBeVisible();
  expect(screen.getByText("Workflow view unavailable")).toBeVisible();
  expect(screen.queryByRole("button", { name: /Open workflow for developer running invocation/i })).not.toBeInTheDocument();
});

test("clears a role-pin error after a later successful inspection", async () => {
  const developer = { registration_id: "developer", registration_version: "1.0.0", manifest_sha256: "b".repeat(64), component_id: "developer", component_version: "1.0.0", lifecycle: "active", maturity: "active", execution_class: "adapter", owner: "cogito-platform", capabilities: ["develop"], gateway_routes: [{ policy_revision: "gateway-v1", role: "developer", model_alias: "complex", max_budget_usd: 25, toolset: "development-restricted" }] };
  const binding = { run_id: "run-agent-retry", root_run_id: run.run_id, parent_run_id: null, registration_id: "developer", registration_version: "1.0.0", role: "developer", run_lifecycle_status: "RUNNING", workflow_available: false, created_at: "2026-08-13T00:00:00Z", updated_at: "2026-08-13T00:01:00Z", gateway_route: developer.gateway_routes[0] };
  const detail: AgentInvocationDetail = { run_id: binding.run_id, root_run_id: binding.root_run_id, parent_run_id: binding.parent_run_id, registration_id: binding.registration_id, registration_version: binding.registration_version, role: binding.role, run_lifecycle_status: "RUNNING", workflow_available: false, created_at: binding.created_at, updated_at: binding.updated_at, gateway_route: binding.gateway_route, mcp_grants: [], lifecycle_transitions: [], evidence: { lifecycle: "available", actual_cost: "unavailable", turns_used: "unavailable", result_artifact: "redacted", failure_detail: "redacted", mcp_invocation_outcome: "unavailable" } };
  let attempts = 0;
  const user = userEvent.setup();
  render(<App client={client({
    listAgents: async () => ({ agents: [developer], revision: "agents", etag: "agents", unchanged: false }),
    getAgent: async () => developer,
    listAgentInvocations: async () => ({ invocations: [binding], revision: "bindings", etag: "bindings", unchanged: false }),
    getAgentInvocation: async () => { attempts += 1; if (attempts === 1) throw new Error("temporary"); return detail; }
  })} />);

  await user.click(await screen.findByRole("button", { name: "Agents" }));
  const inspect = await screen.findByRole("button", { name: /View role pins for developer run-agent-retry/i });
  await user.click(inspect);
  expect(await screen.findByText("Invocation role pins are temporarily unavailable.")).toBeVisible();
  await user.click(inspect);
  expect(await screen.findByText("Showing safe immutable role pins.")).toBeVisible();
  expect(screen.queryByText("Invocation role pins are temporarily unavailable.")).not.toBeInTheDocument();
});

test("restores Agent Operations after a browser refresh on its addressable route", async () => {
  window.history.replaceState({}, "", "/agents");
  render(<App client={client()} />);

  expect(await screen.findByRole("heading", { name: "Agent Operations" })).toBeVisible();
});

test("presents Mission Control with filterable authoritative workflow identity", async () => {
  const user = userEvent.setup();
  render(<App client={client()} />);

  expect(await screen.findByRole("heading", { name: "Mission Control" })).toBeVisible();
  expect(screen.getByText("COGITO")).toBeVisible();
  expect(screen.getByText("AI Orchestration")).toBeVisible();
  expect(await screen.findByText("planning-run-42-revision-1")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Collapse sidebar" }));
  expect(screen.getByRole("button", { name: "Expand sidebar" })).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Expand sidebar" }));
  expect(screen.getAllByText(/Authoritative state updated/)).toHaveLength(1);
  expect(screen.getByRole("button", { name: "Workflows" })).toBeDisabled();
  await user.click(screen.getByRole("tab", { name: /awaiting decision/i }));
  expect(screen.getByText("run-12345678")).toBeVisible();
  await user.type(screen.getByPlaceholderText("Run, workflow, project, status"), "unrelated");
  expect(screen.getByText("No scoped workflows match this Mission Control view.")).toBeVisible();
});

test("displays the complete digest in the workflow specification workspace", async () => {
  const user = userEvent.setup();
  render(<App client={client()} />);

  await user.click(await screen.findByText("run-12345678"));

  expect(await screen.findByText(digest)).toBeVisible();
});

test("preserves verified plan evidence in the legacy plan route", async () => {
  const plan = '{"title":"verified plan"}';
  window.history.replaceState({}, "", "/runs/run-12345678/plan");
  render(<App client={client({ getEvidence: async () => ({ content: plan, sha256: digest }) })} />);

  expect(await screen.findByLabelText("Verified evidence")).toHaveTextContent("verified plan");
  expect(screen.getByRole("button", { name: `plan ${digest.slice(0, 12)}` })).toHaveAttribute("aria-expanded", "true");
});

test("disables a waiting-gate decision when its authoritative artifact is absent", async () => {
  const user = userEvent.setup();
  const incompleteRun: Run = { ...run, artifacts: run.artifacts.filter((artifact) => artifact.kind !== "plan") };
  render(<App client={client({ listRuns: async () => ({ runs: [incompleteRun], revision: "incomplete", etag: "incomplete", unchanged: false }), getRun: async () => incompleteRun })} />);

  await user.click(await screen.findByText("run-12345678"));

  expect(screen.getByText(/authoritative decision artifact is unavailable/i)).toBeVisible();
  expect(screen.getByRole("button", { name: "Approve" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Needs refinement" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
});

test("manages revision and cancellation from the centralized workflow controls", async () => {
  const user = userEvent.setup();
  const decide = jest.fn<ApiClient["decide"]>().mockResolvedValue(undefined);
  render(<App client={client({ decide })} />);

  await user.click(await screen.findByText("run-12345678"));
  await user.click(screen.getByRole("button", { name: "Needs refinement" }));
  await user.type(screen.getByRole("textbox", { name: "Decision rationale" }), "Evidence needs another review.");
  await user.click(screen.getByRole("button", { name: "Confirm refinement" }));
  expect(decide).toHaveBeenCalledWith(run, "request_revision", "Evidence needs another review.", undefined);

  await user.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.getByRole("button", { name: "Confirm cancel" })).toBeVisible();
  expect(decide).toHaveBeenCalledTimes(1);
  await user.click(screen.getByRole("button", { name: "Confirm cancel" }));
  expect(decide).toHaveBeenLastCalledWith(run, "reject", "Evidence needs another review.", undefined);
});

test("keeps a legacy run usable while workflow graph fields are rolling out", async () => {
  const legacyRun: Run = { ...run, workflow_id: undefined, stages: undefined, workflow_graph: undefined };
  const user = userEvent.setup();
  render(<App client={client({ listRuns: async () => ({ runs: [legacyRun], revision: "legacy", etag: "legacy", unchanged: false }), getRun: async () => legacyRun })} />);

  await user.click(await screen.findByText("run-12345678"));
  expect(await screen.findByText("No authoritative lifecycle graph is available for this run yet.")).toBeVisible();
});

test("combines authoritative audit activity and verified specifications in one workflow control center", async () => {
  const user = userEvent.setup();
  render(<App client={client()} />);

  await user.click(await screen.findByText("run-12345678"));
  expect(await screen.findByRole("region", { name: "Workflow control center" })).toBeVisible();
  expect(screen.getByRole("heading", { name: "Workflow audit activity" })).toBeVisible();
  expect(screen.getByText(/Durable lifecycle, agent, and approval events/)).toBeVisible();
  expect(screen.queryByText("Execution log")).not.toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "Workflow specification workspace" })).toBeVisible();
});

test("keeps the centralized audit log while phase context changes", async () => {
  const user = userEvent.setup();
  render(<App client={client()} />);

  await user.click(await screen.findByText("run-12345678"));
  await user.click(screen.getByRole("button", { name: "Focus Planning" }));
  expect(screen.getByLabelText("Selected workflow phase")).toHaveTextContent("Planning");
  expect(await screen.findByText("plan.awaiting approval")).toBeVisible();
  expect(screen.getByRole("heading", { name: "Workflow audit activity" })).toBeVisible();
});

test("keeps active workflow decisions available while phase evidence changes", async () => {
  const user = userEvent.setup();
  render(<App client={client()} />);

  await user.click(await screen.findByText("run-12345678"));
  expect(screen.getByRole("button", { name: "Approve" })).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Focus Specification" }));
  expect(screen.getByLabelText("Selected workflow phase")).toHaveTextContent("Specification");
  expect(screen.getByRole("button", { name: "Approve" })).toBeVisible();
  expect(screen.getByRole("button", { name: "Needs refinement" })).toBeVisible();
  expect(screen.getByRole("button", { name: "Cancel" })).toBeVisible();
});

test("keeps product-specification controls available while any workflow phase is selected", async () => {
  const user = userEvent.setup();
  const generateProductSpecification = jest.fn<ApiClient["generateProductSpecification"]>().mockResolvedValue(undefined);
  const refinementStages: Run["stages"] = [{ stage_id: "specification", label: "Specification", state: "completed", availability: "authoritative", reason: "Stored.", artifact_kind: "source" }, { stage_id: "product_specification", label: "Product specification", state: "in_progress", availability: "authoritative", reason: "No draft.", artifact_kind: null }];
  const refinementRun: Run = { ...run, status: "planning", active_gate: null, artifacts: [{ kind: "source", sha256: digest }], stages: refinementStages, available_actions: [{ action_id: "generate_product_specification", stage_id: "product_specification", label: "Proceed", description: "Create a draft.", requires_confirmation: false }], workflow_graph: { nodes: refinementStages.map((stage) => ({ ...stage, node_type: "queue" })), edges: [{ source_node_id: "specification", target_node_id: "product_specification", style: "solid", emphasis: "primary" }] } };
  render(<App client={client({ listRuns: async () => ({ runs: [refinementRun], revision: "refinement", etag: "refinement", unchanged: false }), getRun: async () => refinementRun, generateProductSpecification })} />);

  await user.click(await screen.findByText("run-12345678"));
  expect(screen.getByRole("button", { name: "Proceed" })).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Focus Product specification" }));
  expect(screen.getByRole("button", { name: "Proceed" })).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Proceed" }));

  expect(generateProductSpecification).toHaveBeenCalledWith("run-12345678");
});

test("confirms acceptance or continues editing a product specification", async () => {
  const user = userEvent.setup();
  const specificationDigest = "c".repeat(64);
  const reviseProductSpecification = jest.fn<ApiClient["reviseProductSpecification"]>().mockResolvedValue(undefined);
  const acceptProductSpecification = jest.fn<ApiClient["acceptProductSpecification"]>().mockResolvedValue({ outcome: "accepted" });
  const refinementStages: Run["stages"] = [{ stage_id: "specification", label: "Specification", state: "completed", availability: "authoritative", reason: "Stored.", artifact_kind: "source" }, { stage_id: "product_specification", label: "Product specification", state: "awaiting_operator", availability: "authoritative", reason: "Review.", artifact_kind: "product_specification" }];
  const refinementRun: Run = { ...run, status: "planning", active_gate: null, product_specification_revision: 1, artifacts: [{ kind: "source", sha256: digest }, { kind: "product_specification", sha256: specificationDigest }], stages: refinementStages, available_actions: [{ action_id: "accept_product_specification", stage_id: "product_specification", label: "Accept", description: "Validate and accept.", requires_confirmation: true }, { action_id: "refine_product_specification", stage_id: "product_specification", label: "Needs refinement", description: "Edit the draft.", requires_confirmation: false }, { action_id: "cancel_planning_run", stage_id: "product_specification", label: "Cancel", description: "Stop the run.", requires_confirmation: true }], workflow_graph: { nodes: refinementStages.map((stage) => ({ ...stage, node_type: "queue" })), edges: [{ source_node_id: "specification", target_node_id: "product_specification", style: "solid", emphasis: "primary" }] } };
  render(<App client={client({ listRuns: async () => ({ runs: [refinementRun], revision: "refinement", etag: "refinement", unchanged: false }), getRun: async () => refinementRun, getEvidence: async () => ({ content: '{"title":"draft"}', sha256: specificationDigest }), reviseProductSpecification, acceptProductSpecification })} />);

  await user.click(await screen.findByText("run-12345678"));
  await user.click(screen.getByRole("button", { name: "Focus Product specification" }));
  expect(await screen.findByLabelText("Specification contents")).toHaveTextContent('"title": "draft"');
  expect(screen.getByLabelText("Product specification contents")).toHaveTextContent('"title": "draft"');
  expect(screen.queryByRole("button", { name: "Evaluate product specification" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Select product specification" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Cancel" })).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Accept" }));
  expect(screen.getByRole("dialog", { name: "Confirm specification" })).toHaveTextContent("Accept this immutable revision as the planning contract.");
  await user.click(screen.getByRole("button", { name: "Continue editing" }));
  const editor = await screen.findByRole("textbox", { name: "Editable product specification JSON" });
  fireEvent.change(editor, { target: { value: '{"title":"reviewed"}' } });
  expect(document.querySelector(".syntax-textarea-layer")).toHaveTextContent('{"title":"reviewed"}');
  await user.click(screen.getByRole("button", { name: "Save refined specification" }));

  expect(reviseProductSpecification).toHaveBeenCalledWith(refinementRun, { revision: 1, artifactSha256: specificationDigest }, { title: "reviewed" });
  await user.click(screen.getByRole("button", { name: "Accept" }));
  await user.click(screen.getByRole("button", { name: "Confirm specification" }));
  expect(acceptProductSpecification).toHaveBeenCalledWith(refinementRun);
  expect(screen.queryByRole("dialog", { name: "Confirm specification" })).not.toBeInTheDocument();
  expect(screen.getByRole("status")).toHaveTextContent("Planning agent is generating the immutable plan.");
});

test("keeps an invalid server-rejected revision in the editor for correction", async () => {
  const user = userEvent.setup();
  const specificationDigest = "c".repeat(64);
  const reviseProductSpecification = jest.fn<ApiClient["reviseProductSpecification"]>().mockRejectedValue(new Error("Authoritative API request failed (422)"));
  const refinementStages: Run["stages"] = [{ stage_id: "product_specification", label: "Product specification", state: "awaiting_operator", availability: "authoritative", reason: "Review.", artifact_kind: "product_specification" }];
  const refinementRun: Run = { ...run, status: "planning", active_gate: null, product_specification_revision: 1, specification_evaluation_readiness: "needs_revision", artifacts: [{ kind: "product_specification", sha256: specificationDigest }], stages: refinementStages, available_actions: [{ action_id: "refine_product_specification", stage_id: "product_specification", label: "Needs refinement", description: "Edit the draft.", requires_confirmation: false }], workflow_graph: { nodes: refinementStages.map((stage) => ({ ...stage, node_type: "queue" })), edges: [] } };
  render(<App client={client({ listRuns: async () => ({ runs: [refinementRun], revision: "refinement", etag: "refinement", unchanged: false }), getRun: async () => refinementRun, getEvidence: async () => ({ content: '{"title":"draft"}', sha256: specificationDigest }), reviseProductSpecification })} />);

  await user.click(await screen.findByText("run-12345678"));
  await user.click(screen.getByRole("button", { name: "Focus Product specification" }));
  expect(screen.getByRole("button", { name: "Needs refinement" })).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Needs refinement" }));
  const editor = await screen.findByRole("textbox", { name: "Editable product specification JSON" });
  fireEvent.change(editor, { target: { value: '{"title":"reviewed"}' } });
  await user.click(screen.getByRole("button", { name: "Save refined specification" }));

  expect(screen.getByRole("textbox", { name: "Editable product specification JSON" })).toHaveValue('{"title":"reviewed"}');
  expect(screen.getByText("Authoritative API request failed (422)")).toBeVisible();
});

test("does not present refinement controls after planning has advanced", async () => {
  const user = userEvent.setup();
  const specificationDigest = "c".repeat(64);
  const completedStages: Run["stages"] = [{ stage_id: "product_specification", label: "Product specification", state: "completed", availability: "authoritative", reason: "Selected.", artifact_kind: "product_specification" }];
  const completedRun: Run = { ...run, product_specification_revision: 1, selected_product_specification_revision: 1, artifacts: [{ kind: "product_specification", sha256: specificationDigest }], stages: completedStages, workflow_graph: { nodes: completedStages.map((stage) => ({ ...stage, node_type: "queue" })), edges: [] } };
  render(<App client={client({ listRuns: async () => ({ runs: [completedRun], revision: "completed", etag: "completed", unchanged: false }), getRun: async () => completedRun })} />);

  await user.click(await screen.findByText("run-12345678"));
  await user.click(screen.getByRole("button", { name: "Focus Product specification" }));
  expect(screen.getByText("This product specification is immutable because the run is no longer in refinement.")).toBeVisible();
  expect(screen.queryByRole("textbox", { name: "Editable product specification JSON" })).not.toBeInTheDocument();
});

test("requires an authoritative positive revision before offering product specification actions", async () => {
  const user = userEvent.setup();
  const specificationDigest = "c".repeat(64);
  const refinementStages: Run["stages"] = [{ stage_id: "product_specification", label: "Product specification", state: "awaiting_operator", availability: "authoritative", reason: "Review.", artifact_kind: "product_specification" }];
  const incompleteRun: Run = { ...run, status: "planning", active_gate: null, product_specification_revision: 0, artifacts: [{ kind: "product_specification", sha256: specificationDigest }], stages: refinementStages, workflow_graph: { nodes: refinementStages.map((stage) => ({ ...stage, node_type: "queue" })), edges: [] } };
  render(<App client={client({ listRuns: async () => ({ runs: [incompleteRun], revision: "incomplete", etag: "incomplete", unchanged: false }), getRun: async () => incompleteRun })} />);

  await user.click(await screen.findByText("run-12345678"));
  await user.click(screen.getByRole("button", { name: "Focus Product specification" }));

  expect(screen.getByText("The displayed product specification revision is unavailable. Refresh the run before editing or accepting it.")).toBeVisible();
  expect(screen.queryByRole("textbox", { name: "Editable product specification JSON" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Select product specification" })).not.toBeInTheDocument();
});

test("shows selected phase facts in the consolidated workflow control center", async () => {
  const user = userEvent.setup();
  render(<App client={client()} />);

  await user.click(await screen.findByText("run-12345678"));
  const phase = screen.getByLabelText("Selected workflow phase");
  expect(phase).toHaveTextContent("Plan approval");
  expect(phase).toHaveTextContent("gate");
  expect(phase).toHaveTextContent("authoritative");
});

test("keeps plan evidence out of the workflow specification workspace", async () => {
  const user = userEvent.setup();
  render(<App client={client()} />);

  await user.click(await screen.findByText("run-12345678"));

  expect(await screen.findByLabelText("Specification contents")).toBeVisible();
  expect(screen.queryByLabelText("plan contents")).not.toBeInTheDocument();
});

test("displays submitted and product specifications together", async () => {
  const user = userEvent.setup();
  const specificationDigest = "c".repeat(64);
  const refinedRun: Run = { ...run, artifacts: [{ kind: "source", sha256: digest }, { kind: "product_specification", sha256: specificationDigest }, { kind: "plan", sha256: digest }] };
  render(<App client={client({ listRuns: async () => ({ runs: [refinedRun], revision: "refined", etag: "refined", unchanged: false }), getRun: async () => refinedRun })} />);

  await user.click(await screen.findByText("run-12345678"));
  expect(await screen.findByLabelText("Specification contents")).toBeVisible();
  expect(screen.getByLabelText("Product specification contents")).toBeVisible();
  expect(screen.getByText(specificationDigest)).toBeVisible();
});

test("renders the complete specification bodies in the workflow workspace", async () => {
  const user = userEvent.setup();
  const specificationDigest = "c".repeat(64);
  const refinedRun: Run = {
    ...run,
    artifacts: [{ kind: "source", sha256: digest }, { kind: "product_specification", sha256: specificationDigest }, { kind: "plan", sha256: digest }]
  };
  render(<App client={client({ listRuns: async () => ({ runs: [refinedRun], revision: "refined", etag: "refined", unchanged: false }), getRun: async () => refinedRun })} />);

  await user.click(await screen.findByText("run-12345678"));
  expect(await screen.findByLabelText("Specification contents")).toHaveTextContent("verified");
  expect(screen.getByLabelText("Product specification contents")).toHaveTextContent("verified");
});

test("removes reviewer-context controls from the specification workspace", async () => {
  const user = userEvent.setup();
  render(<App client={client()} />);

  await user.click(await screen.findByText("run-12345678"));
  expect(screen.queryByLabelText("Context for reviewers")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Record context" })).not.toBeInTheDocument();
});

test("renders an authoritative in-progress stage as active", async () => {
  const activeStages = stages.map((stage) => stage.stage_id === "planning" ? { ...stage, state: "in_progress" as const } : stage);
  const activeRun: Run = {
    ...run,
    status: "planning",
    active_gate: null,
    stages: activeStages,
    workflow_graph: { ...run.workflow_graph!, nodes: activeStages.map((stage) => ({ ...stage, node_type: stage.stage_id.includes("approval") ? "gate" : stage.stage_id === "specification" ? "queue" : "agent" })) }
  };
  const user = userEvent.setup();
  render(<App client={client({ listRuns: async () => ({ runs: [activeRun], revision: "active", etag: "active", unchanged: false }), getRun: async () => activeRun })} />);

  await user.click(await screen.findByText("run-12345678"));
  expect(screen.getByRole("button", { name: "Focus Planning" }).closest("li")).toHaveClass("active");
});

test("restores a cached timeline when a previously viewed run is not modified", async () => {
  const user = userEvent.setup();
  const secondRun: Run = { ...run, run_id: "run-87654321", workflow_id: "planning-run-43-revision-1" };
  const firstEvent: TimelineEvent = { ...events[0], event_id: "event-first", event_type: "plan.first_event" };
  const secondEvent: TimelineEvent = { ...events[0], event_id: "event-second", event_type: "plan.second_event" };
  const timelineCalls = new Map<string, number>();
  const getTimeline = jest.fn<ApiClient["getTimeline"]>(async (runId) => {
    const calls = (timelineCalls.get(runId) ?? 0) + 1;
    timelineCalls.set(runId, calls);
    if (runId === run.run_id && calls > 1) return { events: [], revision: "first", etag: "first", unchanged: true };
    return runId === run.run_id
      ? { events: [firstEvent], revision: "first", etag: "first", unchanged: false }
      : { events: [secondEvent], revision: "second", etag: "second", unchanged: false };
  });
  render(<App client={client({ listRuns: async () => ({ runs: [run, secondRun], revision: "runs", etag: "runs", unchanged: false }), getRun: async (runId) => runId === run.run_id ? run : secondRun, getTimeline })} />);

  await user.click(await screen.findByText(run.run_id));
  await user.click(screen.getAllByRole("button", { name: "Mission Control" })[0]);
  await user.click(await screen.findByText(secondRun.run_id));
  await user.click(screen.getAllByRole("button", { name: "Mission Control" })[0]);
  await user.click(await screen.findByText(run.run_id));
  expect(await screen.findByText("plan.first event")).toBeVisible();
  expect(screen.queryByText("plan.second event")).not.toBeInTheDocument();
});

test("keeps the single workflow control center embedded in a deep-linkable Workflow Canvas", async () => {
  const user = userEvent.setup();
  render(<App client={client()} />);
  await user.click(await screen.findByText("run-12345678"));

  expect(await screen.findByRole("heading", { name: "planning-run-42-revision-1" })).toBeVisible();
  expect(window.location.pathname).toBe("/workflows/run-12345678");
  expect(screen.getByRole("heading", { name: "Workflow control center" })).toBeVisible();
  expect(screen.getByRole("button", { name: "Focus Planning" })).toBeVisible();
  expect(window.location.pathname).toBe("/workflows/run-12345678");
});

test("replaces the lifecycle bar with an interactive compact authoritative topology", async () => {
  const user = userEvent.setup();
  render(<App client={client()} />);
  await user.click(await screen.findByText("run-12345678"));

  await user.click(await screen.findByRole("button", { name: "Visualize workflow topology" }));
  expect(screen.getByText("Workflow topology")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Select Implementation" }));
  expect(screen.getByLabelText("Selected workflow phase")).toHaveTextContent("Implementation");
  await user.click(screen.getByRole("button", { name: "Lifecycle" }));
  expect(screen.getByText("Lifecycle")).toBeVisible();
});

test("uses the authoritative graph nodes for the lifecycle rail and focuses the selected section", async () => {
  const user = userEvent.setup();
  render(<App client={client()} />);
  await user.click(await screen.findByText("run-12345678"));

  expect(screen.getByText("Lifecycle")).toBeVisible();
  const planApproval = screen.getByRole("button", { name: "Focus Plan approval" });
  expect(planApproval).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByLabelText("Selected workflow phase")).toHaveTextContent("Decision required.");
  await user.click(screen.getByRole("button", { name: /^Focus Implementation$/ }));
  expect(screen.getByRole("button", { name: /^Focus Implementation$/ })).toHaveAttribute("aria-pressed", "true");
  expect(planApproval).toHaveAttribute("aria-pressed", "false");
  expect(screen.getByLabelText("Selected workflow phase")).toHaveTextContent("Not started.");
  await user.click(screen.getByRole("button", { name: "Focus Plan approval" }));
  expect(screen.getByLabelText("Selected workflow phase")).toHaveTextContent("Plan approval");
  expect(screen.getByLabelText("Selected workflow phase")).toHaveTextContent("Decision required.");
});

test("keeps a stale approval conflict visible and never claims success", async () => {
  const user = userEvent.setup();
  const decide = jest.fn<ApiClient["decide"]>().mockRejectedValue(new Error("Authoritative API request failed (409)"));
  const getRun = jest.fn<ApiClient["getRun"]>().mockResolvedValue(run);
  render(<App client={client({ decide, getRun })} />);
  await user.click(await screen.findByText("run-12345678"));
  await user.click(screen.getByRole("button", { name: "Approve" }));

  expect(await screen.findByText("Authoritative API request failed (409)")).toBeVisible();
  expect(screen.queryByText("Decision accepted; canonical state has been refreshed.")).not.toBeInTheDocument();
  expect(getRun.mock.calls.length).toBeGreaterThanOrEqual(2);
});

test("renders inherited governed MCP authority once for the workflow", async () => {
  const user = userEvent.setup();
  const decide = jest.fn<ApiClient["decide"]>().mockResolvedValue(undefined);
  const mcpRun: Run = { ...run, mcp_capabilities: { state: "awaiting_plan_approval", pinned_grants: [mcpGrant], selected_grants: null, invocation_evidence_available: false } };
  render(<App client={client({ listRuns: async () => ({ runs: [mcpRun], revision: "mcp", etag: "mcp", unchanged: false }), getRun: async () => mcpRun, decide })} />);

  await user.click(await screen.findByText("run-12345678"));
  await user.click(screen.getByRole("button", { name: "Focus Plan approval" }));
  expect(screen.getByText("developer: github_readonly_mcp@1.0.0 / catalog_read / acme/api-gateway")).toBeVisible();
  expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Approve" }));

  expect(decide).toHaveBeenCalledWith(mcpRun, "approve", "", null);
});

test("hides MCP capability identities and controls from viewers", async () => {
  const user = userEvent.setup();
  const viewerRun: Run = { ...run, abilities: ["view"], mcp_capabilities: { state: "awaiting_plan_approval", pinned_grants: [mcpGrant], selected_grants: null, invocation_evidence_available: false } };
  render(<App client={client({ listRuns: async () => ({ runs: [viewerRun], revision: "viewer", etag: "viewer", unchanged: false }), getRun: async () => viewerRun })} />);

  await user.click(await screen.findByText("run-12345678"));
  await user.click(screen.getByRole("button", { name: "Focus Plan approval" }));
  expect(screen.queryByText("developer: github_readonly_mcp@1.0.0 / catalog_read / acme/api-gateway")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
});

test("hides malformed MCP capability data rather than rendering or submitting it", async () => {
  const user = userEvent.setup();
  const malformedRun = { ...run, mcp_capabilities: { state: "awaiting_plan_approval", pinned_grants: "not-a-list", selected_grants: null } } as unknown as Run;
  render(<App client={client({ listRuns: async () => ({ runs: [malformedRun], revision: "malformed", etag: "malformed", unchanged: false }), getRun: async () => malformedRun })} />);

  await user.click(await screen.findByText("run-12345678"));
  await user.click(screen.getByRole("button", { name: "Focus Plan approval" }));
  expect(screen.queryByRole("checkbox", { name: /catalog_read/ })).not.toBeInTheDocument();
});

test("shows the authoritative recorded MCP selection after approval", async () => {
  const approvedRun: Run = { ...run, status: "implementing", active_gate: null, mcp_capabilities: { state: "approved", pinned_grants: [mcpGrant], selected_grants: [], invocation_evidence_available: false } };
  window.history.pushState({}, "", "/runs/run-12345678/approvals");
  render(<App client={client({ listRuns: async () => ({ runs: [approvedRun], revision: "approved", etag: "approved", unchanged: false }), getRun: async () => approvedRun })} />);

  expect(await screen.findByText("No MCP tools were selected.")).toBeVisible();
  window.history.replaceState({}, "", "/");
});

test("shows the recorded MCP selection in the primary plan-approval dossier", async () => {
  const user = userEvent.setup();
  const approvedRun: Run = { ...run, status: "implementing", active_gate: null, mcp_capabilities: { state: "approved", pinned_grants: [mcpGrant], selected_grants: [], invocation_evidence_available: false } };
  render(<App client={client({ listRuns: async () => ({ runs: [approvedRun], revision: "approved-canvas", etag: "approved-canvas", unchanged: false }), getRun: async () => approvedRun })} />);

  await user.click(await screen.findByText("run-12345678"));
  await user.click(screen.getByRole("button", { name: "Focus Plan approval" }));
  expect(screen.getByText("No MCP tools were selected.")).toBeVisible();
});

test("withholds another plan decision while the worker is advancing an approved MCP plan", async () => {
  const user = userEvent.setup();
  const pendingAdvanceRun: Run = { ...run, mcp_capabilities: { state: "approved", pinned_grants: [mcpGrant], selected_grants: [], invocation_evidence_available: false } };
  render(<App client={client({ listRuns: async () => ({ runs: [pendingAdvanceRun], revision: "pending-advance", etag: "pending-advance", unchanged: false }), getRun: async () => pendingAdvanceRun })} />);

  await user.click(await screen.findByText("run-12345678"));
  await user.click(screen.getByRole("button", { name: "Focus Plan approval" }));
  expect(screen.getByText("No MCP tools were selected.")).toBeVisible();
  expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
});

test("shows a non-disclosing recovery state for an unavailable direct run link", async () => {
  window.history.pushState({}, "", "/runs/foreign-run/summary");
  const user = userEvent.setup();
  render(<App client={client({ listRuns: async () => ({ runs: [], revision: "empty", etag: "empty", unchanged: false }), getRun: async () => { throw new Error("not found"); } })} />);

  expect(await screen.findByRole("heading", { name: "Run unavailable" })).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Return to Mission Control" }));
  expect(await screen.findByRole("heading", { name: "Mission Control" })).toBeVisible();
  window.history.replaceState({}, "", "/");
});

test("recovers an invalid node deep link to its authoritative Workflow Canvas", async () => {
  window.history.pushState({}, "", "/workflows/run-12345678/nodes/unknown/overview");
  const user = userEvent.setup();
  render(<App client={client()} />);

  expect(await screen.findByRole("heading", { name: "Node unavailable" })).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Return to Workflow Canvas" }));
  expect(await screen.findByRole("heading", { name: "planning-run-42-revision-1" })).toBeVisible();
  expect(window.location.pathname).toBe("/workflows/run-12345678");
});

test("does not poll the inbox while a selected detail has its own canonical refresh", async () => {
  jest.useFakeTimers();
  try {
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
    const listRuns = jest.fn<ApiClient["listRuns"]>().mockResolvedValue({ runs: [run], revision: "runs", etag: "runs", unchanged: false });
    const getRun = jest.fn<ApiClient["getRun"]>().mockResolvedValue(run);
    const getTimeline = jest.fn<ApiClient["getTimeline"]>().mockResolvedValue({ events, revision: "timeline", etag: "timeline", unchanged: false });
    render(<App client={client({ listRuns, getRun, getTimeline })} />);
    await user.click(await screen.findByText("run-12345678"));
    await act(async () => { await jest.advanceTimersByTimeAsync(3_000); });
    expect(listRuns).toHaveBeenCalledTimes(1);
    expect(getRun).toHaveBeenCalledTimes(2);
    expect(getTimeline).toHaveBeenCalledTimes(2);
  } finally { jest.useRealTimers(); }
});

test("stops workflow polling while Agent Operations is open", async () => {
  jest.useFakeTimers();
  try {
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
    const getRun = jest.fn<ApiClient["getRun"]>().mockResolvedValue(run);
    render(<App client={client({ getRun })} />);

    await user.click(await screen.findByText("run-12345678"));
    expect(await screen.findByRole("heading", { name: "planning-run-42-revision-1" })).toBeVisible();
    expect(getRun).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "Agents" }));
    expect(await screen.findByRole("heading", { name: "Agent Operations" })).toBeVisible();
    await act(async () => { await jest.advanceTimersByTimeAsync(3_000); });
    expect(getRun).toHaveBeenCalledTimes(1);
  } finally { jest.useRealTimers(); }
});

test("ignores an out-of-order selected-run refresh", async () => {
  jest.useFakeTimers();
  try {
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
    let resolveFirst: ((value: Run) => void) | undefined;
    const completedRun: Run = { ...run, status: "completed", active_gate: null };
    const getRun = jest.fn<ApiClient["getRun"]>()
      .mockImplementationOnce(() => new Promise<Run>((resolve) => { resolveFirst = resolve; }))
      .mockResolvedValue(completedRun);
    render(<App client={client({ getRun })} />);

    await user.click(await screen.findByText("run-12345678"));
    await act(async () => { await jest.advanceTimersByTimeAsync(3_000); });
    const selectedRunHeader = screen.getByRole("heading", { name: "planning-run-42-revision-1" }).parentElement;
    expect(selectedRunHeader).toHaveTextContent("completed");
    await act(async () => { resolveFirst?.(run); });
    expect(selectedRunHeader).toHaveTextContent("completed");
  } finally { jest.useRealTimers(); }
});
