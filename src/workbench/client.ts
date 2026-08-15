export type Artifact = { kind: "source" | "product_specification" | "specification_evaluation" | "plan" | "implementation"; sha256: string };
export type Project = { project_id: string };
export type Approval = { decision_id: string; gate: "plan" | "implementation"; decision: string; artifact_sha256: string; actor_id: string; created_at: string; delivered: boolean };
export type SpecificationEvaluationWaiver = { artifact_sha256: string; actor_id: string; rationale: string; created_at: string };
export type Budget = { max_cost_usd: number; max_wall_clock_minutes: number; max_review_rounds: number; actual_cost_usd: number | null; turns_used: number | null };
export type Execution = { phase_count: number; succeeded_phase_count: number; failed_phase_count: number; verification_passed: number; verification_failed: number; review_status: string | null; validation_status: string | null };
export type ExternalLink = { kind: string; label: string; url: string };
export type McpToolSelection = {
  role: string;
  server_id: string;
  server_version: string;
  server_manifest_sha256: string;
  tool_name: string;
  input_schema_sha256: string;
  repository_scope?: string | null;
};
export type McpCapabilities = {
  state: "awaiting_plan_approval" | "approved" | "not_applicable";
  pinned_grants: McpToolSelection[];
  selected_grants: McpToolSelection[] | null;
  invocation_evidence_available: boolean;
};
export type TimelineEvent = {
  event_id: string;
  event_type: string;
  occurred_at: string;
  stage_id: string | null;
  stage_ids: string[];
  gate: "plan" | "implementation" | null;
  artifact_sha256: string | null;
  decision: "approve" | "reject" | "request_revision" | null;
  lifecycle_status: string | null;
  delivered: boolean;
  delivery_attempt_count: number;
};
export type Feedback = { feedback_id: string; run_id: string; intent: "note"; artifact_sha256: string; stage_id: string; actor_id: string; comment: string; created_at: string };
export type Stage = {
  stage_id: string;
  label: string;
  state: "completed" | "in_progress" | "awaiting_operator" | "needs_revision" | "failed" | "unavailable";
  availability: "authoritative" | "unavailable";
  reason: string;
  artifact_kind: Artifact["kind"] | null;
};
export type WorkflowGraphNode = Stage & { node_type: "agent" | "gate" | "queue" };
export type WorkflowGraphEdge = { source_node_id: string; target_node_id: string; style: "solid" | "dashed"; emphasis: "primary" | "secondary" };
export type WorkflowGraph = { nodes: WorkflowGraphNode[]; edges: WorkflowGraphEdge[] };
export type Run = {
  run_id: string;
  project_id: string;
  status: string;
  submitted_at: string;
  workflow_id?: string | null;
  product_specification_revision?: number;
  selected_product_specification_revision?: number | null;
  specification_evaluation_readiness?: "ready" | "needs_revision" | "waived" | null;
  selected_specification_evaluation_sha256?: string | null;
  specification_evaluation_waiver?: SpecificationEvaluationWaiver | null;
  stages?: Stage[];
  workflow_graph?: WorkflowGraph;
  active_gate: "plan" | "implementation" | null;
  artifacts: Artifact[];
  abilities: string[];
  workflow: string[];
  budget: Budget;
  approval_history_available: boolean;
  approval_history: Approval[];
  execution: Execution | null;
  external_links: ExternalLink[];
  // Omitted by older API releases and withheld entirely for non-approvers.
  mcp_capabilities?: McpCapabilities | null;
};
export type AgentGatewayRoute = { policy_revision: string; role: string; model_alias: string; max_budget_usd: number; toolset: string };
export type Agent = {
  registration_id: string;
  registration_version: string;
  manifest_sha256: string;
  component_id: string;
  component_version: string;
  lifecycle: string;
  maturity: string;
  execution_class: string;
  owner: string;
  capabilities: string[];
  gateway_routes: AgentGatewayRoute[];
};
export type AgentInvocation = {
  run_id: string;
  root_run_id: string;
  parent_run_id: string | null;
  registration_id: string;
  registration_version: string;
  role: string;
  run_lifecycle_status: string;
  workflow_available?: boolean;
  created_at: string;
  updated_at: string;
  gateway_route: AgentGatewayRoute | null;
};
export type AgentLifecycleTransition = { from_status: string | null; to_status: string | null; occurred_at: string };
export type AgentMcpGrant = { server_id: string; server_version: string; server_manifest_sha256: string; tool_name: string; input_schema_sha256: string; repository_scope?: string | null };
export type AgentInvocationDetail = AgentInvocation & {
  mcp_grants: AgentMcpGrant[];
  lifecycle_transitions: AgentLifecycleTransition[];
  evidence: Record<"lifecycle" | "actual_cost" | "turns_used" | "result_artifact" | "failure_detail" | "mcp_invocation_outcome", "available" | "unavailable" | "redacted">;
};

export type ApiClient = {
  listProjects: (signal?: AbortSignal) => Promise<Project[]>;
  getHealth: (signal?: AbortSignal) => Promise<boolean>;
  listRuns: (options?: { projectId?: string; etag?: string; signal?: AbortSignal }) => Promise<{ runs: Run[]; revision: string; etag: string | null; unchanged: boolean }>;
  getRun: (runId: string, signal?: AbortSignal) => Promise<Run>;
  getTimeline: (runId: string, options?: { etag?: string; signal?: AbortSignal }) => Promise<{ events: TimelineEvent[]; revision: string; etag: string | null; unchanged: boolean }>;
  getEvidence: (runId: string, artifact: Artifact) => Promise<{ content: string; sha256: string }>;
  getFeedback: (runId: string) => Promise<Feedback[]>;
  recordFeedback: (run: Run, artifact: Artifact, stageId: string, comment: string) => Promise<Feedback>;
  decide: (run: Run, decision: "approve" | "reject" | "request_revision", comment?: string, mcpSelection?: McpToolSelection[] | null) => Promise<void>;
  generateProductSpecification: (runId: string) => Promise<void>;
  evaluateProductSpecification: (runId: string) => Promise<void>;
  waiveSpecificationEvaluation: (run: Run, rationale: string) => Promise<void>;
  generatePlan: (runId: string) => Promise<void>;
  selectProductSpecification: (run: Run) => Promise<void>;
  reviseProductSpecification: (run: Run, parent: { revision: number; artifactSha256: string }, specification: unknown) => Promise<void>;
  listAgents: (options: { projectId: string; etag?: string; signal?: AbortSignal }) => Promise<{ agents: Agent[]; revision: string; etag: string | null; unchanged: boolean }>;
  getAgent: (agent: Pick<Agent, "registration_id" | "registration_version">, projectId: string, signal?: AbortSignal) => Promise<Agent>;
  listAgentInvocations: (agent: Pick<Agent, "registration_id" | "registration_version">, options: { projectId: string; etag?: string; signal?: AbortSignal }) => Promise<{ invocations: AgentInvocation[]; revision: string; etag: string | null; unchanged: boolean }>;
  getAgentInvocation: (invocation: Pick<AgentInvocation, "run_id" | "role">, projectId: string, signal?: AbortSignal) => Promise<AgentInvocationDetail>;
};

const base = "/api/cogito/api/v1";
const inFlightDecisionKeys = new Map<string, string>();
const inFlightFeedbackKeys = new Map<string, string>();
const inFlightRevisionKeys = new Map<string, string>();
const inFlightWaiverKeys = new Map<string, string>();
// The authoritative evidence reader is bounded at 100 KB. Leave room for the
// revision envelope so an editor submission cannot be accepted by the relay
// but become unreadable in the Workbench.
const MAX_REFINEMENT_REQUEST_BYTES = 96 * 1024;

async function json(response: Response) {
  if (!response.ok) throw new Error(`Authoritative API request failed (${response.status})`);
  return response.json();
}

export const apiClient: ApiClient = {
  async listProjects(signal) {
    const response = await fetch(`${base}/workbench/projects`, { signal });
    return (await json(response)).items;
  },
  async getHealth(signal) {
    const response = await fetch("/api/cogito/healthz", { signal });
    return response.ok;
  },
  async listRuns({ projectId, etag, signal } = {}) {
    const query = projectId ? `?project_id=${encodeURIComponent(projectId)}` : "";
    const response = await fetch(`${base}/workbench/runs${query}`, { headers: etag ? { "If-None-Match": etag } : {}, signal });
    if (response.status === 304) return { runs: [], revision: etag ?? "", etag: response.headers.get("etag") ?? etag ?? null, unchanged: true };
    const body = await json(response);
    return { runs: body.items, revision: body.revision, etag: response.headers.get("etag"), unchanged: false };
  },
  async listAgents({ projectId, etag, signal }) {
    const response = await fetch(`${base}/workbench/agents?project_id=${encodeURIComponent(projectId)}`, { headers: etag ? { "If-None-Match": etag } : {}, signal });
    if (response.status === 304) return { agents: [], revision: etag ?? "", etag: response.headers.get("etag") ?? etag ?? null, unchanged: true };
    const body = await json(response);
    return { agents: body.items, revision: body.revision, etag: response.headers.get("etag"), unchanged: false };
  },
  async getAgent(agent, projectId, signal) {
    return json(await fetch(`${base}/workbench/agents/${encodeURIComponent(agent.registration_id)}/${encodeURIComponent(agent.registration_version)}?project_id=${encodeURIComponent(projectId)}`, { signal }));
  },
  async listAgentInvocations(agent, { projectId, etag, signal }) {
    const response = await fetch(`${base}/workbench/agents/${encodeURIComponent(agent.registration_id)}/${encodeURIComponent(agent.registration_version)}/invocations?project_id=${encodeURIComponent(projectId)}`, { headers: etag ? { "If-None-Match": etag } : {}, signal });
    if (response.status === 304) return { invocations: [], revision: etag ?? "", etag: response.headers.get("etag") ?? etag ?? null, unchanged: true };
    const body = await json(response);
    return { invocations: body.items, revision: body.revision, etag: response.headers.get("etag"), unchanged: false };
  },
  async getAgentInvocation(invocation, projectId, signal) {
    const query = new URLSearchParams({ project_id: projectId });
    return json(await fetch(`${base}/workbench/agent-invocations/${encodeURIComponent(invocation.run_id)}/${encodeURIComponent(invocation.role)}?${query.toString()}`, { signal }));
  },
  async getRun(runId, signal) {
    return json(await fetch(`${base}/workbench/runs/${encodeURIComponent(runId)}`, { signal }));
  },
  async getTimeline(runId, { etag, signal } = {}) {
    const response = await fetch(`${base}/workbench/runs/${encodeURIComponent(runId)}/timeline`, { headers: etag ? { "If-None-Match": etag } : {}, signal });
    if (response.status === 304) return { events: [], revision: etag ?? "", etag: response.headers.get("etag") ?? etag ?? null, unchanged: true };
    const body = await json(response);
    return { events: body.items, revision: body.revision, etag: response.headers.get("etag"), unchanged: false };
  },
  async getEvidence(runId, artifact) {
    const response = await fetch(
      `${base}/workbench/runs/${encodeURIComponent(runId)}/evidence/${artifact.kind}?artifact_sha256=${encodeURIComponent(artifact.sha256)}`
    );
    return json(response);
  },
  async getFeedback(runId) {
    return (await json(await fetch(`${base}/workbench/runs/${encodeURIComponent(runId)}/feedback`))).items;
  },
  async recordFeedback(run, artifact, stageId, comment) {
    const fingerprint = `${run.run_id}:${artifact.sha256}:${stageId}:${comment}`;
    const idempotencyKey = inFlightFeedbackKeys.get(fingerprint) ?? crypto.randomUUID();
    inFlightFeedbackKeys.set(fingerprint, idempotencyKey);
    const response = await fetch(`${base}/workbench/runs/${encodeURIComponent(run.run_id)}/feedback`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
      body: JSON.stringify({ intent: "note", artifact_sha256: artifact.sha256, stage_id: stageId, comment })
    });
    if (!response.ok) {
      inFlightFeedbackKeys.delete(fingerprint);
      throw new Error(`Authoritative API request failed (${response.status})`);
    }
    const feedback = await json(response);
    // A transport/body failure before this point is ambiguous, so the key remains available for safe replay.
    inFlightFeedbackKeys.delete(fingerprint);
    return feedback;
  },
  async decide(run, decision, comment, mcpSelection) {
    if (!run.active_gate) throw new Error("This run is not awaiting an operator decision");
    if (decision !== "approve" && !comment?.trim()) throw new Error("A rationale is required for this decision");
    const artifact = run.artifacts.find((item) => item.kind === run.active_gate);
    if (!artifact) throw new Error("The authoritative decision artifact is unavailable");
    const canonicalSelection = mcpSelection === undefined ? undefined : mcpSelection === null ? null : [...mcpSelection]
      .sort((left, right) => mcpSelectionKey(left).localeCompare(mcpSelectionKey(right)));
    const selectionFingerprint = canonicalSelection === undefined ? "omitted" : canonicalSelection === null ? "null" : canonicalSelection
      .map((grant) => mcpSelectionKey(grant)).join("|");
    const fingerprint = `${run.run_id}:${run.active_gate}:${artifact.sha256}:${decision}:${selectionFingerprint}`;
    const idempotencyKey = inFlightDecisionKeys.get(fingerprint) ?? crypto.randomUUID();
    inFlightDecisionKeys.set(fingerprint, idempotencyKey);
    const body: { decision: typeof decision; artifact_sha256: string; comment?: string; mcp_selection?: McpToolSelection[] | null } = { decision, artifact_sha256: artifact.sha256, comment };
    if (canonicalSelection !== undefined) body.mcp_selection = canonicalSelection;
    const response = await fetch(`${base}/coordination/runs/${encodeURIComponent(run.run_id)}/actions/${run.active_gate}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
      body: JSON.stringify(body)
    });
    if (!response.ok) {
      if (response.status >= 400 && response.status < 500 && response.status !== 408) inFlightDecisionKeys.delete(fingerprint);
      throw new Error(`Authoritative API request failed (${response.status})`);
    }
    try { await response.json(); }
    catch { throw new Error("Authoritative API response could not be read; retry safely."); }
    // A transport/body failure before this point is ambiguous, so the key remains available for safe replay.
    inFlightDecisionKeys.delete(fingerprint);
  },
  async generateProductSpecification(runId) {
    await json(await fetch(`${base}/planning-runs/${encodeURIComponent(runId)}/generate-product-specification`, { method: "POST" }));
  },
  async evaluateProductSpecification(runId) {
    await json(await fetch(`${base}/planning-runs/${encodeURIComponent(runId)}/evaluate-product-specification`, { method: "POST" }));
  },
  async waiveSpecificationEvaluation(run, rationale) {
    const artifact = run.artifacts.find((item) => item.kind === "specification_evaluation");
    if (!artifact) throw new Error("The displayed specification evaluation is unavailable.");
    const normalizedRationale = rationale.trim();
    const fingerprint = `${run.run_id}:${artifact.sha256}:${normalizedRationale}`;
    const idempotencyKey = inFlightWaiverKeys.get(fingerprint) ?? crypto.randomUUID();
    inFlightWaiverKeys.set(fingerprint, idempotencyKey);
    const response = await fetch(`${base}/planning-runs/${encodeURIComponent(run.run_id)}/waive-specification-evaluation`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
      body: JSON.stringify({ artifact_sha256: artifact.sha256, rationale: normalizedRationale })
    });
    if (!response.ok) {
      if (response.status >= 400 && response.status < 500 && response.status !== 408) inFlightWaiverKeys.delete(fingerprint);
      throw new Error(`Authoritative API request failed (${response.status})`);
    }
    try { await response.json(); }
    catch { throw new Error("Authoritative API response could not be read; retry safely."); }
    inFlightWaiverKeys.delete(fingerprint);
  },
  async generatePlan(runId) {
    await json(await fetch(`${base}/planning-runs/${encodeURIComponent(runId)}/generate-plan`, { method: "POST" }));
  },
  async selectProductSpecification(run) {
    const artifact = run.artifacts.find((item) => item.kind === "product_specification");
    if (!artifact || !run.product_specification_revision) throw new Error("A displayed product specification revision is required.");
    await json(await fetch(`${base}/planning-runs/${encodeURIComponent(run.run_id)}/select-product-specification`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
      body: JSON.stringify({ revision: run.product_specification_revision, artifact_sha256: artifact.sha256 })
    }));
  },
  async reviseProductSpecification(run, parent, specification) {
    if (!parent.revision || !parent.artifactSha256) throw new Error("A displayed product specification revision is required.");
    const fingerprint = `${run.run_id}:${parent.revision}:${parent.artifactSha256}:${JSON.stringify(specification)}`;
    const idempotencyKey = inFlightRevisionKeys.get(fingerprint) ?? crypto.randomUUID();
    inFlightRevisionKeys.set(fingerprint, idempotencyKey);
    const body = JSON.stringify({
      expected_product_specification_revision: parent.revision,
      parent_artifact_sha256: parent.artifactSha256,
      specification
    });
    if (new Blob([body]).size > MAX_REFINEMENT_REQUEST_BYTES) {
      inFlightRevisionKeys.delete(fingerprint);
      throw new Error("The revised product specification exceeds the 96 KiB Workbench request limit.");
    }
    let response: Response;
    try {
      response = await fetch(`${base}/planning-runs/${encodeURIComponent(run.run_id)}/revise-product-specification`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
        body
      });
    } catch { throw new Error("Authoritative API request was interrupted before a response."); }
    if (!response.ok) {
      // A relay 5xx can be emitted after the authoritative API committed but
      // before the response reached the browser. Keep the key for safe replay.
      if (response.status >= 400 && response.status < 500 && response.status !== 408) {
        inFlightRevisionKeys.delete(fingerprint);
      }
      throw new Error(`Authoritative API request failed (${response.status})`);
    }
    try { await response.json(); }
    catch { throw new Error("Authoritative API response could not be read; retry safely."); }
    inFlightRevisionKeys.delete(fingerprint);
  }
};

export function mcpSelectionKey(selection: McpToolSelection) {
  return [
    selection.role,
    selection.server_id,
    selection.server_version,
    selection.server_manifest_sha256,
    selection.tool_name,
    selection.input_schema_sha256,
    selection.repository_scope ?? ""
  ].join("\u0000");
}
