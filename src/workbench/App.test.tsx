import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, jest } from "@jest/globals";

import { App } from "./App";
import type { ApiClient, Run, TimelineEvent } from "./client";

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
  return { listProjects: async () => [{ project_id: "default" }], getHealth: async () => true, listRuns: async () => ({ runs: [run], revision: "runs", etag: "runs", unchanged: false }), getRun: async () => run, getTimeline: async () => ({ events, revision: "timeline", etag: "timeline", unchanged: false }), getEvidence: async () => ({ content: '{"title":"verified"}', sha256: digest }), getFeedback: async () => [], recordFeedback: async () => ({ feedback_id: "feedback-1", run_id: run.run_id, intent: "note", artifact_sha256: digest, stage_id: "planning", actor_id: "operator", comment: "Recorded note", created_at: "2026-08-02T00:00:00Z" }), decide: async () => undefined, generateProductSpecification: async () => undefined, selectProductSpecification: async () => undefined, reviseProductSpecification: async () => undefined, ...overrides };
}

beforeEach(() => { window.history.replaceState({}, "", "/"); window.localStorage.clear(); });

test("migrates the legacy stored theme preference", async () => {
  window.localStorage.setItem("cogito-workbench-theme", "dark");
  render(<App client={client()} />);

  expect(await screen.findByRole("heading", { name: "Mission Control" })).toBeVisible();
  expect(screen.getByRole("combobox", { name: "Theme" })).toHaveValue("dark");
  expect(window.localStorage.getItem("workbench-theme")).toBe("dark");
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

test("displays the complete digest bound to a waiting-gate decision", async () => {
  const user = userEvent.setup();
  render(<App client={client()} />);

  await user.click(await screen.findByText("run-12345678"));

  expect(screen.getByLabelText("Exact plan decision artifact SHA-256")).toHaveTextContent(digest);
});

test("disables a waiting-gate decision when its authoritative artifact is absent", async () => {
  const user = userEvent.setup();
  const incompleteRun: Run = { ...run, artifacts: run.artifacts.filter((artifact) => artifact.kind !== "plan") };
  render(<App client={client({ listRuns: async () => ({ runs: [incompleteRun], revision: "incomplete", etag: "incomplete", unchanged: false }), getRun: async () => incompleteRun })} />);

  await user.click(await screen.findByText("run-12345678"));

  expect(screen.getByLabelText("Exact plan decision artifact SHA-256")).toHaveTextContent("Unavailable");
  expect(screen.getByRole("button", { name: "Approve" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Request revision" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Reject" })).toBeDisabled();
});

test("keeps a legacy run usable while workflow graph fields are rolling out", async () => {
  const legacyRun: Run = { ...run, workflow_id: undefined, stages: undefined, workflow_graph: undefined };
  const user = userEvent.setup();
  render(<App client={client({ listRuns: async () => ({ runs: [legacyRun], revision: "legacy", etag: "legacy", unchanged: false }), getRun: async () => legacyRun })} />);

  await user.click(await screen.findByText("run-12345678"));
  expect(await screen.findByText("No authoritative lifecycle graph is available for this run yet.")).toBeVisible();
});

test("distinguishes authoritative audit activity from verified specifications", async () => {
  const user = userEvent.setup();
  render(<App client={client()} />);

  await user.click(await screen.findByText("run-12345678"));
  await user.click(screen.getByRole("tab", { name: "Audit activity" }));

  expect(await screen.findByRole("heading", { name: "Authoritative audit activity" })).toBeVisible();
  expect(screen.getByText("This view contains durable lifecycle and approval events, not raw agent output.")).toBeVisible();
  expect(screen.queryByText("Execution log")).not.toBeInTheDocument();

  await user.click(screen.getByRole("tab", { name: "Specifications" }));
  expect(await screen.findByRole("heading", { name: "Verified immutable evidence" })).toBeVisible();
  expect(screen.getAllByText(digest.slice(0, 12))).toHaveLength(2);
});

test("shows a server-attributed transition in the Planning dossier audit and overview", async () => {
  const user = userEvent.setup();
  render(<App client={client()} />);

  await user.click(await screen.findByText("run-12345678"));
  await user.click(screen.getByRole("button", { name: "Focus Planning" }));
  await user.click(screen.getByRole("tab", { name: "Overview" }));
  expect(await screen.findByText("plan.awaiting approval")).toBeVisible();
  await user.click(screen.getByRole("tab", { name: "Audit activity" }));
  expect(screen.getByText("plan.awaiting approval")).toBeVisible();
});

test("allows a scoped operator to generate a product specification from its dossier", async () => {
  const user = userEvent.setup();
  const generateProductSpecification = jest.fn<ApiClient["generateProductSpecification"]>().mockResolvedValue(undefined);
  const refinementStages: Run["stages"] = [{ stage_id: "specification", label: "Specification", state: "completed", availability: "authoritative", reason: "Stored.", artifact_kind: "source" }, { stage_id: "product_specification", label: "Product specification", state: "in_progress", availability: "authoritative", reason: "No draft.", artifact_kind: null }];
  const refinementRun: Run = { ...run, status: "planning", active_gate: null, artifacts: [{ kind: "source", sha256: digest }], stages: refinementStages, workflow_graph: { nodes: refinementStages.map((stage) => ({ ...stage, node_type: "queue" })), edges: [{ source_node_id: "specification", target_node_id: "product_specification", style: "solid", emphasis: "primary" }] } };
  render(<App client={client({ listRuns: async () => ({ runs: [refinementRun], revision: "refinement", etag: "refinement", unchanged: false }), getRun: async () => refinementRun, generateProductSpecification })} />);

  await user.click(await screen.findByText("run-12345678"));
  await user.click(screen.getByRole("button", { name: "Focus Product specification" }));
  await user.click(screen.getByRole("button", { name: "Generate product specification" }));

  expect(generateProductSpecification).toHaveBeenCalledWith("run-12345678");
});

test("submits a complete edited product specification against its displayed digest", async () => {
  const user = userEvent.setup();
  const specificationDigest = "c".repeat(64);
  const reviseProductSpecification = jest.fn<ApiClient["reviseProductSpecification"]>().mockResolvedValue(undefined);
  const refinementStages: Run["stages"] = [{ stage_id: "specification", label: "Specification", state: "completed", availability: "authoritative", reason: "Stored.", artifact_kind: "source" }, { stage_id: "product_specification", label: "Product specification", state: "awaiting_operator", availability: "authoritative", reason: "Review.", artifact_kind: "product_specification" }];
  const refinementRun: Run = { ...run, status: "planning", active_gate: null, product_specification_revision: 1, artifacts: [{ kind: "source", sha256: digest }, { kind: "product_specification", sha256: specificationDigest }], stages: refinementStages, workflow_graph: { nodes: refinementStages.map((stage) => ({ ...stage, node_type: "queue" })), edges: [{ source_node_id: "specification", target_node_id: "product_specification", style: "solid", emphasis: "primary" }] } };
  render(<App client={client({ listRuns: async () => ({ runs: [refinementRun], revision: "refinement", etag: "refinement", unchanged: false }), getRun: async () => refinementRun, getEvidence: async () => ({ content: '{"title":"draft"}', sha256: specificationDigest }), reviseProductSpecification })} />);

  await user.click(await screen.findByText("run-12345678"));
  await user.click(screen.getByRole("button", { name: "Focus Product specification" }));
  await user.click(screen.getByRole("button", { name: "Edit product specification" }));
  const editor = await screen.findByRole("textbox", { name: "Complete product specification JSON" });
  fireEvent.change(editor, { target: { value: '{"title":"reviewed"}' } });
  await user.click(screen.getByRole("button", { name: "Record revised specification" }));

  expect(reviseProductSpecification).toHaveBeenCalledWith(refinementRun, { revision: 1, artifactSha256: specificationDigest }, { title: "reviewed" });
});

test("keeps an invalid server-rejected revision in the editor for correction", async () => {
  const user = userEvent.setup();
  const specificationDigest = "c".repeat(64);
  const reviseProductSpecification = jest.fn<ApiClient["reviseProductSpecification"]>().mockRejectedValue(new Error("Authoritative API request failed (422)"));
  const refinementStages: Run["stages"] = [{ stage_id: "product_specification", label: "Product specification", state: "awaiting_operator", availability: "authoritative", reason: "Review.", artifact_kind: "product_specification" }];
  const refinementRun: Run = { ...run, status: "planning", active_gate: null, product_specification_revision: 1, artifacts: [{ kind: "product_specification", sha256: specificationDigest }], stages: refinementStages, workflow_graph: { nodes: refinementStages.map((stage) => ({ ...stage, node_type: "queue" })), edges: [] } };
  render(<App client={client({ listRuns: async () => ({ runs: [refinementRun], revision: "refinement", etag: "refinement", unchanged: false }), getRun: async () => refinementRun, getEvidence: async () => ({ content: '{"title":"draft"}', sha256: specificationDigest }), reviseProductSpecification })} />);

  await user.click(await screen.findByText("run-12345678"));
  await user.click(screen.getByRole("button", { name: "Focus Product specification" }));
  await user.click(screen.getByRole("button", { name: "Edit product specification" }));
  const editor = await screen.findByRole("textbox", { name: "Complete product specification JSON" });
  fireEvent.change(editor, { target: { value: '{"title":"reviewed"}' } });
  await user.click(screen.getByRole("button", { name: "Record revised specification" }));

  expect(screen.getByRole("textbox", { name: "Complete product specification JSON" })).toHaveValue('{"title":"reviewed"}');
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
  expect(screen.queryByRole("button", { name: "Edit product specification" })).not.toBeInTheDocument();
});

test("requires an authoritative positive revision before offering product specification actions", async () => {
  const user = userEvent.setup();
  const specificationDigest = "c".repeat(64);
  const refinementStages: Run["stages"] = [{ stage_id: "product_specification", label: "Product specification", state: "awaiting_operator", availability: "authoritative", reason: "Review.", artifact_kind: "product_specification" }];
  const incompleteRun: Run = { ...run, status: "planning", active_gate: null, product_specification_revision: 0, artifacts: [{ kind: "product_specification", sha256: specificationDigest }], stages: refinementStages, workflow_graph: { nodes: refinementStages.map((stage) => ({ ...stage, node_type: "queue" })), edges: [] } };
  render(<App client={client({ listRuns: async () => ({ runs: [incompleteRun], revision: "incomplete", etag: "incomplete", unchanged: false }), getRun: async () => incompleteRun })} />);

  await user.click(await screen.findByText("run-12345678"));
  await user.click(screen.getByRole("button", { name: "Focus Product specification" }));

  expect(screen.getByText("The displayed product specification revision is unavailable. Refresh the run before editing or selecting it.")).toBeVisible();
  expect(screen.queryByRole("button", { name: "Edit product specification" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Select product specification" })).not.toBeInTheDocument();
});

test("formats authoritative configuration as syntax-highlighted JSON", async () => {
  const user = userEvent.setup();
  render(<App client={client()} />);

  await user.click(await screen.findByText("run-12345678"));
  await user.click(screen.getByRole("tab", { name: "Configuration" }));
  const configuration = screen.getByLabelText("Authoritative node display context");

  expect(JSON.parse(configuration.textContent ?? "")).toMatchObject({ node_id: "plan_approval", type: "gate" });
  expect(configuration).toHaveClass("evidence-json");
  expect(configuration.querySelector(".json-key")).not.toBeNull();
});

test("renders verified plan phases and acceptance criteria for product review", async () => {
  const user = userEvent.setup();
  const plan = JSON.stringify({
    title: "Protect customer API traffic",
    summary: "Add bounded rate limiting before releasing the gateway change.",
    phases: [{
      id: "phase-1",
      name: "Rate limiter",
      description: "Add the limit policy.",
      acceptance_criteria: ["Requests over the limit receive a clear response."]
    }]
  });
  render(<App client={client({ getEvidence: async () => ({ content: plan, sha256: digest }) })} />);

  await user.click(await screen.findByText("run-12345678"));
  await user.click(screen.getByRole("tab", { name: "Specifications" }));
  await user.click(screen.getByRole("button", { name: `plan ${digest.slice(0, 12)}` }));

  expect(await screen.findByRole("heading", { name: "Protect customer API traffic" })).toBeVisible();
  expect(screen.getByText("Rate limiter")).toBeVisible();
  expect(screen.getAllByText(/Requests over the limit receive a clear response/)).toHaveLength(2);
  expect(JSON.parse(screen.getByLabelText("Verified evidence").textContent ?? "")).toEqual(JSON.parse(plan));
});

test("toggles selected immutable evidence from its artifact button", async () => {
  const user = userEvent.setup();
  render(<App client={client()} />);

  await user.click(await screen.findByText("run-12345678"));
  await user.click(screen.getByRole("tab", { name: "Specifications" }));
  const evidenceButton = screen.getByRole("button", { name: `plan ${digest.slice(0, 12)}` });
  await user.click(evidenceButton);
  expect(await screen.findByLabelText("Verified evidence")).toBeVisible();
  expect(evidenceButton).toHaveAttribute("aria-expanded", "true");
  await user.click(evidenceButton);
  expect(screen.queryByLabelText("Verified evidence")).not.toBeInTheDocument();
  expect(evidenceButton).toHaveAttribute("aria-expanded", "false");
});

test("renders a product specification as separately verified evidence", async () => {
  const user = userEvent.setup();
  const specificationDigest = "c".repeat(64);
  const refinedRun: Run = {
    ...run,
    artifacts: [{ kind: "source", sha256: digest }, { kind: "product_specification", sha256: specificationDigest }, { kind: "plan", sha256: digest }]
  };
  render(<App client={client({ listRuns: async () => ({ runs: [refinedRun], revision: "refined", etag: "refined", unchanged: false }), getRun: async () => refinedRun, getEvidence: async (_runId, artifact) => ({ content: '{"unresolved_questions":[]}', sha256: artifact.sha256 }) })} />);

  await user.click(await screen.findByText("run-12345678"));
  await user.click(screen.getByRole("tab", { name: "Specifications" }));
  const evidence = screen.getByRole("button", { name: `Product specification ${specificationDigest.slice(0, 12)}` });
  await user.click(evidence);

  expect(await screen.findByLabelText("Verified evidence")).toHaveTextContent("unresolved_questions");
});

test("records immutable review context without presenting it as execution control", async () => {
  const user = userEvent.setup();
  const recordFeedback = jest.fn<ApiClient["recordFeedback"]>().mockResolvedValue({ feedback_id: "feedback-1", run_id: run.run_id, intent: "note", artifact_sha256: digest, stage_id: "plan_approval", actor_id: "operator", comment: "Clarify rollback.", created_at: "2026-08-02T00:00:00Z" });
  render(<App client={client({ recordFeedback })} />);

  await user.click(await screen.findByText("run-12345678"));
  await user.click(screen.getByRole("tab", { name: "Specifications" }));
  await user.type(screen.getByLabelText("Context for reviewers"), "Clarify rollback.");
  await user.click(screen.getByRole("button", { name: "Record context" }));

  expect(recordFeedback).toHaveBeenCalledWith(run, { kind: "plan", sha256: digest }, "plan_approval", "Clarify rollback.");
  expect(await screen.findByText(/use Request revision when the work itself needs to change/)).toBeVisible();
});

test("clears a recorded-context notice when the selected evidence digest changes", async () => {
  const user = userEvent.setup();
  const sourceDigest = "b".repeat(64);
  const distinctEvidenceRun: Run = { ...run, artifacts: [{ kind: "source", sha256: sourceDigest }, { kind: "plan", sha256: digest }] };
  const recordFeedback = jest.fn<ApiClient["recordFeedback"]>().mockResolvedValue({ feedback_id: "feedback-1", run_id: run.run_id, intent: "note", artifact_sha256: digest, stage_id: "plan_approval", actor_id: "operator", comment: "Clarify rollback.", created_at: "2026-08-02T00:00:00Z" });
  render(<App client={client({ listRuns: async () => ({ runs: [distinctEvidenceRun], revision: "distinct-evidence", etag: "distinct-evidence", unchanged: false }), getRun: async () => distinctEvidenceRun, recordFeedback })} />);

  await user.click(await screen.findByText("run-12345678"));
  await user.click(screen.getByRole("tab", { name: "Specifications" }));
  await user.type(screen.getByLabelText("Context for reviewers"), "Clarify rollback.");
  await user.click(screen.getByRole("button", { name: "Record context" }));
  expect(await screen.findByText(/Review context recorded at/)).toBeVisible();

  await user.click(screen.getByRole("button", { name: `Specification ${sourceDigest.slice(0, 12)}` }));
  expect(screen.queryByText(/Review context recorded at/)).not.toBeInTheDocument();
});

test("shows only notes bound to the selected stage and immutable digest", async () => {
  const user = userEvent.setup();
  const getFeedback = jest.fn<ApiClient["getFeedback"]>().mockResolvedValue([
    { feedback_id: "feedback-matching", run_id: run.run_id, intent: "note", artifact_sha256: digest, stage_id: "plan_approval", actor_id: "owner", comment: "Shown note.", created_at: "2026-08-02T00:00:00Z" },
    { feedback_id: "feedback-other-stage", run_id: run.run_id, intent: "note", artifact_sha256: digest, stage_id: "planning", actor_id: "owner", comment: "Hidden stage.", created_at: "2026-08-02T00:00:00Z" },
    { feedback_id: "feedback-other-digest", run_id: run.run_id, intent: "note", artifact_sha256: "b".repeat(64), stage_id: "plan_approval", actor_id: "owner", comment: "Hidden digest.", created_at: "2026-08-02T00:00:00Z" }
  ]);
  render(<App client={client({ getFeedback })} />);

  await user.click(await screen.findByText("run-12345678"));
  await user.click(screen.getByRole("tab", { name: "Specifications" }));
  expect(await screen.findByText(/Shown note\./)).toBeVisible();
  expect(getFeedback).toHaveBeenCalledWith(run.run_id);
  expect(screen.queryByText(/Hidden stage\./)).not.toBeInTheDocument();
  expect(screen.queryByText(/Hidden digest\./)).not.toBeInTheDocument();
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
  await user.click(screen.getByRole("tab", { name: "History" }));

  expect(await screen.findByText("plan.first event")).toBeVisible();
  expect(screen.queryByText("plan.second event")).not.toBeInTheDocument();
});

test("keeps the selected-stage Dossier embedded in a deep-linkable Workflow Canvas", async () => {
  const user = userEvent.setup();
  render(<App client={client()} />);
  await user.click(await screen.findByText("run-12345678"));

  expect(await screen.findByRole("heading", { name: "planning-run-42-revision-1" })).toBeVisible();
  expect(window.location.pathname).toBe("/workflows/run-12345678");
  expect(screen.getAllByRole("heading", { name: /^Plan approval$/ })).toHaveLength(2);
  await user.click(screen.getByRole("tab", { name: "Dependencies" }));
  expect(screen.getAllByText("Planning", { exact: true }).length).toBeGreaterThan(0);
  expect(window.location.pathname).toBe("/workflows/run-12345678");
});

test("replaces the lifecycle bar with an interactive compact authoritative topology", async () => {
  const user = userEvent.setup();
  render(<App client={client()} />);
  await user.click(await screen.findByText("run-12345678"));

  await user.click(await screen.findByRole("button", { name: "Visualize workflow topology" }));
  expect(screen.getByText("Workflow topology")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Select Implementation" }));
  expect(screen.getByLabelText("Selected stage details")).toHaveTextContent("Implementation");
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
  expect(screen.getByLabelText("Selected stage details")).toHaveTextContent("Decision required.");
  await user.click(screen.getByRole("button", { name: /^Focus Implementation$/ }));
  expect(screen.getByRole("button", { name: /^Focus Implementation$/ })).toHaveAttribute("aria-pressed", "true");
  expect(planApproval).toHaveAttribute("aria-pressed", "false");
  expect(screen.getByLabelText("Selected stage details")).toHaveTextContent("Not started.");
  expect(screen.getByLabelText("Selected stage details").querySelector("button:not([aria-label='Collapse stage details'])")).toBeNull();
  await user.click(screen.getByRole("button", { name: "Collapse stage details" }));
  expect(screen.getByLabelText("Selected stage details")).toHaveTextContent("Implementation");
  expect(screen.getByRole("button", { name: "Expand stage details" })).toHaveAttribute("aria-expanded", "false");
  await user.click(screen.getByRole("button", { name: "Focus Plan approval" }));
  expect(screen.getByLabelText("Selected stage details")).toHaveTextContent("Plan approval");
  expect(screen.getByRole("button", { name: "Expand stage details" })).toHaveAttribute("aria-expanded", "false");
  await user.click(screen.getByRole("button", { name: "Expand stage details" }));
  expect(screen.getByLabelText("Selected stage details")).toHaveTextContent("Decision required.");
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

test("renders and submits a narrowed governed MCP selection", async () => {
  const user = userEvent.setup();
  const decide = jest.fn<ApiClient["decide"]>().mockResolvedValue(undefined);
  const mcpRun: Run = { ...run, mcp_capabilities: { state: "awaiting_plan_approval", pinned_grants: [mcpGrant], selected_grants: null, invocation_evidence_available: false } };
  render(<App client={client({ listRuns: async () => ({ runs: [mcpRun], revision: "mcp", etag: "mcp", unchanged: false }), getRun: async () => mcpRun, decide })} />);

  await user.click(await screen.findByText("run-12345678"));
  await user.click(screen.getByRole("button", { name: "Focus Plan approval" }));
  expect(screen.getByText("developer: github_readonly_mcp@1.0.0 / catalog_read / acme/api-gateway")).toBeVisible();
  await user.click(screen.getByRole("checkbox", { name: /catalog_read/ }));
  await user.click(screen.getByRole("button", { name: "Approve" }));

  expect(decide).toHaveBeenCalledWith(mcpRun, "approve", "", []);
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
