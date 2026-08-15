import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { apiClient, type Agent, type AgentInvocation, type AgentInvocationDetail, type ApiClient, type Artifact, type Feedback, type Project, type Run, type Stage, type TimelineEvent } from "./client";
import { DecisionControls, McpCapabilityEvidence } from "./DecisionControls";

type DetailTab = "summary" | "workflow" | "timeline" | "artifacts" | "plan" | "execution" | "review" | "approvals";
type Theme = "system" | "dark" | "light";
type Health = "checking" | "connected" | "unavailable";
type InboxFilter = "all" | "waiting" | "running" | "completed" | "failed";
type ShellNav = "mission" | "workflows" | "runs" | "agents" | "tools" | "datasets" | "secrets" | "policies" | "schedules" | "audit";
type NodeDossierTab = "overview" | "audit" | "specifications" | "configuration" | "dependencies" | "history";
type WorkflowView = "mission" | "canvas" | "node" | "legacy";
type WorkflowNode = { id: string; name: string; type: "agent" | "gate" | "queue"; status: string; availability: Stage["availability"]; artifactKind: Artifact["kind"] | null; reason: string; position?: { x: number; y: number; width: number }; metric: string };
type WorkflowEdge = { fromNodeId: string; toNodeId: string; style: "solid" | "dashed"; emphasis: "primary" | "secondary" };
type PositionedWorkflowNode = WorkflowNode & { position: { x: number; y: number; width: number } };
type RouteState = { runId: string | null; tab: DetailTab; nodeId: string | null; nodeTab: NodeDossierTab; view: WorkflowView; agents: boolean; agentProjectId: string | null };
type CatalogColumnId = "agent" | "version" | "role" | "capabilities" | "owner" | "model" | "budget" | "status";
type CatalogColumn = { id: CatalogColumnId; label: string; required?: boolean; width: string };
const AUTHORITATIVE_REFRESH_MS = 3_000;
const catalogColumns: CatalogColumn[] = [
  { id: "agent", label: "Agent", required: true, width: "minmax(170px,1.1fr)" }, { id: "version", label: "Version", required: true, width: "minmax(80px,.45fr)" },
  { id: "role", label: "Role / toolset", required: true, width: "minmax(160px,1fr)" }, { id: "capabilities", label: "Capabilities", width: "minmax(125px,.8fr)" },
  { id: "owner", label: "Owner", width: "minmax(115px,.7fr)" }, { id: "model", label: "Model", width: "minmax(80px,.45fr)" },
  { id: "budget", label: "Budget", width: "minmax(80px,.45fr)" }, { id: "status", label: "Status", required: true, width: "minmax(100px,.5fr)" }
];

const tabs: Array<{ id: DetailTab; label: string }> = [
  { id: "summary", label: "Summary" }, { id: "workflow", label: "Workflow map" }, { id: "timeline", label: "Timeline" }, { id: "artifacts", label: "Artifacts" },
  { id: "plan", label: "Plan" }, { id: "execution", label: "Execution" }, { id: "review", label: "Review" }, { id: "approvals", label: "Approvals" }
];

function statusLabel(value: string) { return value.replaceAll("_", " "); }
function statusTone(value: string) {
  const normalized = value.toLowerCase();
  if (normalized === "active") return "run";
  if (normalized.includes("reject") || normalized.includes("fail")) return "err";
  if (normalized.includes("await") || normalized.includes("revision")) return "warn";
  if (normalized.includes("in_progress") || normalized.includes("planning") || normalized.includes("implementing") || normalized.includes("running")) return "active";
  if (normalized.includes("complete") || normalized.includes("approve") || normalized.includes("succeed")) return "run";
  return "idle";
}
function Pill({ status, label = statusLabel(status) }: { status: string; label?: string }) { return <span className={`pill ${statusTone(status)}`}><i />{label}</span>; }
function relativeTime(value: string) {
  const seconds = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 1000));
  if (seconds < 60) return seconds < 15 ? "now" : `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  return `${Math.floor(seconds / 3600)}h ago`;
}
function Kpi({ label, value }: { label: string; value: string | number }) { return <div className="kpi"><p>{label}</p><b>{value}</b></div>; }
function parseTheme(value: string | null): Theme | null { return value === "light" || value === "dark" || value === "system" ? value : null; }
function readStoredTheme(): Theme {
  try {
    const currentTheme = parseTheme(window.localStorage.getItem("workbench-theme"));
    if (currentTheme) return currentTheme;
    const legacyTheme = parseTheme(window.localStorage.getItem("cogito-workbench-theme"));
    if (!legacyTheme) return "system";
    window.localStorage.setItem("workbench-theme", legacyTheme);
    return legacyTheme;
  } catch { return "system"; }
}
function evidenceFor(run: Run, kind: Artifact["kind"]) { return run.artifacts.find((artifact) => artifact.kind === kind) ?? null; }
function artifactLabel(kind: Artifact["kind"]) {
  return kind === "source" ? "Specification" : kind === "product_specification" ? "Product specification" : kind === "specification_evaluation" ? "Specification evaluation" : kind;
}
function isWaiting(run: Run) { return run.active_gate !== null; }
function filterRun(run: Run, filter: InboxFilter, search: string) {
  const searchable = `${run.run_id} ${run.workflow_id ?? ""} ${run.project_id} ${run.status}`.toLowerCase();
  if (search && !searchable.includes(search.toLowerCase())) return false;
  if (filter === "waiting") return isWaiting(run);
  if (filter === "running") return run.status.includes("running");
  if (filter === "completed") return run.status.includes("completed");
  if (filter === "failed") return run.status.includes("failed") || run.status.includes("rejected");
  return true;
}

const shellNavItems: Array<{ id: ShellNav; label: string; glyph: string; available?: boolean }> = [
  { id: "mission", label: "Mission Control", glyph: "◎", available: true }, { id: "workflows", label: "Workflows", glyph: "⌘" },
  { id: "runs", label: "Runs", glyph: "▤" }, { id: "agents", label: "Agents", glyph: "▦" },
  { id: "tools", label: "Tools", glyph: "⌁" }, { id: "datasets", label: "Datasets", glyph: "◫" },
  { id: "secrets", label: "Secrets", glyph: "⌖" }, { id: "policies", label: "Policies", glyph: "◇" },
  { id: "schedules", label: "Schedules", glyph: "◷" }, { id: "audit", label: "Audit Log", glyph: "▧" }
];

function Sidebar({ projects, selectedProject, setSelectedProject, health, theme, setTheme, activeNav, onRuns, onAgents }: { projects: Project[]; selectedProject: string | undefined; setSelectedProject: (value: string | undefined) => void; health: Health; theme: Theme; setTheme: (theme: Theme) => void; activeNav: "mission" | "agents"; onRuns: () => void; onAgents: () => void }) {
  const [collapsed, setCollapsed] = useState(false);
  const healthLabel = health === "connected" ? "Authoritative relay connected" : health === "checking" ? "Checking relay connection" : "Relay connection unavailable";
  return <aside className={`sidebar ${collapsed ? "collapsed" : ""}`}>
    <div className="brand-row"><div className="brand-mark">◆</div><div><strong>COGITO</strong><small>AI Orchestration</small></div><button className="icon-button collapse-button" aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"} onClick={() => setCollapsed((value) => !value)}>{collapsed ? "»" : "«"}</button></div>
    <div className="workspace-switcher"><span className="workspace-icon">◇</span><label><span className="sr-only">Active project</span><select aria-label="Active project" value={selectedProject ?? ""} onChange={(event) => setSelectedProject(event.target.value || undefined)}><option value="">All authorized projects</option>{projects.map((project) => <option key={project.project_id} value={project.project_id}>{project.project_id}</option>)}</select><small><i className={`health-dot ${health}`} />Operational</small></label><span className="workspace-chevron" aria-hidden="true">⌄</span></div>
    <p className="nav-label">Workspace</p><nav aria-label="Workbench navigation">{shellNavItems.map((item) => { const available = item.id === "mission" || item.id === "agents"; const active = item.id === activeNav; return <button key={item.id} className={active ? "active" : ""} disabled={!available} aria-current={active ? "page" : undefined} title={available ? item.label : `${item.label} is not available yet`} onClick={item.id === "mission" ? onRuns : item.id === "agents" ? onAgents : undefined}><span className="nav-glyph" aria-hidden="true">{item.glyph}</span><span>{item.label}</span>{active && <i className="nav-dot" />}</button>; })}</nav>
    <div className="sidebar-bottom"><section className="quick-actions"><p className="nav-label">Quick actions</p><button disabled>New Workflow <span>+</span></button><button disabled>Trigger Run</button><button disabled>Create Agent</button><button disabled>View Dossiers</button></section><section className="system-status"><p className="nav-label">System status</p><b><i className={`health-dot ${health}`} />{health === "connected" ? "All Systems Operational" : healthLabel}</b><small>Derived from the relay health check</small></section><footer><span className="shell-footer-symbol" aria-hidden="true">?</span><label className="sr-only" htmlFor="theme-select">Theme</label><select id="theme-select" aria-label="Theme" value={theme} onChange={(event) => setTheme(event.target.value as Theme)}><option value="system">System</option><option value="dark">Dark</option><option value="light">Light</option></select><button className="avatar" aria-label="Operator profile">OP<i /></button></footer></div>
  </aside>;
}

function MissionControl({ runs, onOpen, refresh, refreshing, syncMessage }: { runs: Run[]; onOpen: (run: Run, tab?: DetailTab) => void; refresh: () => Promise<void>; refreshing: boolean; syncMessage: string }) {
  const [filter, setFilter] = useState<InboxFilter>("all");
  const [search, setSearch] = useState("");
  const filtered = runs.filter((run) => filterRun(run, filter, search));
  const counts: Record<InboxFilter, number> = { all: runs.length, waiting: runs.filter(isWaiting).length, running: runs.filter((run) => run.status.includes("running")).length, completed: runs.filter((run) => run.status.includes("completed")).length, failed: runs.filter((run) => run.status.includes("failed") || run.status.includes("rejected")).length };
  const active = runs.filter((run) => run.active_gate !== null || run.status.includes("planning") || run.status.includes("implementing")).length;
  return <section className="view mission-view" aria-labelledby="mission-control-title">
    <header className="flow-header"><div><h1 id="mission-control-title">Mission Control</h1><p className="mission-meta"><span>{runs.length} workflows</span><span>{runs.filter((run) => run.workflow_id).length} execution identities</span></p></div><div className="kpis"><Kpi label="Active workflows" value={active} /><Kpi label="Total throughput" value="—" /><Kpi label="Avg success" value="—" /><Kpi label="Open alerts" value={counts.failed} /></div></header>
    <div className="inbox-toolbar"><div className="filter-tabs" role="tablist" aria-label="Run filters">{(["all", "waiting", "running", "completed", "failed"] as InboxFilter[]).map((name) => <button key={name} role="tab" aria-selected={filter === name} onClick={() => setFilter(name)}>{name === "waiting" ? "Awaiting decision" : statusLabel(name)} <b>{counts[name]}</b></button>)}</div><label className="search-control">Search runs<input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Run, workflow, project, status" /></label></div>
    <div className="sync-row" role="status" aria-live="polite">{syncMessage}</div>
    <div className="table-wrap mission-table-wrap"><table><thead><tr><th>Status</th><th>Workflow</th><th>Flow ID</th><th>Type</th><th>Throughput</th><th>P95 latency</th><th>Success</th><th>Last run</th></tr></thead><tbody>{filtered.length === 0 ? <tr><td colSpan={8} className="empty">No scoped workflows match this Mission Control view.</td></tr> : filtered.map((run) => <tr key={run.run_id} onClick={() => onOpen(run)} tabIndex={0} onKeyDown={(event) => event.key === "Enter" && onOpen(run)}><td><Pill status={run.status} /></td><td className="workflow-name-cell"><b>{run.workflow_id ?? "Planning run"}</b><small>{run.project_id}</small></td><td className="mono workflow-id-cell">{run.run_id}</td><td>Planning run · {run.artifacts.length} evidence</td><td className="mono">—</td><td className="mono">—</td><td className="mono">—</td><td title={new Date(run.submitted_at).toLocaleString()}>{relativeTime(run.submitted_at)}</td></tr>)}</tbody></table></div>
    <button className="refresh-button" aria-busy={refreshing} onClick={() => void refresh()}>{refreshing ? "Refreshing authoritative state…" : "Refresh Mission Control"}</button>
  </section>;
}

function CatalogCell({ item, column }: { item: Agent; column: CatalogColumnId }) {
  if (column === "agent") return <span className="agent-release-identity"><span className="agent-release-mark">{item.registration_id.slice(0, 1).toUpperCase()}</span><b>{item.registration_id}</b></span>;
  if (column === "version") return <small>v{item.registration_version}</small>;
  if (column === "role") return item.gateway_routes.length ? <span className="catalog-routes">{item.gateway_routes.map((route) => <span key={`${route.policy_revision}:${route.role}`}><b>{route.role}</b><small>{route.toolset}</small></span>)}</span> : <span className="catalog-unavailable">Historical route unavailable</span>;
  if (column === "capabilities") return <span className="catalog-capabilities">{item.capabilities.join(" · ") || "—"}</span>;
  if (column === "owner") return <span className="catalog-owner">{item.owner}</span>;
  if (column === "model") return <span className="catalog-model">{item.gateway_routes.map((route) => route.model_alias).join(" · ") || "Unavailable"}</span>;
  if (column === "budget") return <span className="catalog-budget">{item.gateway_routes.map((route) => `$${route.max_budget_usd.toFixed(2)}`).join(" · ") || "Unavailable"}</span>;
  return <Pill status={item.lifecycle} />;
}

function AgentOperations({ client, projectId, onOpenWorkflow }: { client: ApiClient; projectId: string | undefined; onOpenWorkflow: (flow: AgentInvocation) => void }) {
  const [agents, setAgents] = useState<Agent[]>([]); const [selected, setSelected] = useState<Agent | null>(null); const [invocations, setInvocations] = useState<AgentInvocation[]>([]); const [invocationDetail, setInvocationDetail] = useState<AgentInvocationDetail | null>(null); const [message, setMessage] = useState("Select a project to load its authoritative agent inventory."); const [catalogColumnOrder, setCatalogColumnOrder] = useState<CatalogColumnId[]>(() => catalogColumns.map((column) => column.id)); const [visibleCatalogColumns, setVisibleCatalogColumns] = useState<CatalogColumnId[]>(() => catalogColumns.map((column) => column.id)); const [catalogSettingsOpen, setCatalogSettingsOpen] = useState(false); const [draggedColumn, setDraggedColumn] = useState<CatalogColumnId | null>(null); const invocationGeneration = useRef(0);
  useEffect(() => { setAgents([]); setSelected(null); setInvocations([]); setInvocationDetail(null); invocationGeneration.current += 1; if (!projectId) { setMessage("Select a project to load its authoritative agent inventory."); return; } let cancelled = false; setMessage("Loading authoritative agent inventory…"); void client.listAgents({ projectId }).then((result) => { if (!cancelled) { setAgents(result.agents); setSelected(result.agents[0] ?? null); setMessage(result.agents.length ? "Agent inventory is project-scoped and read-only." : "No policy-authorized agent releases are available for this project."); } }).catch(() => { if (!cancelled) setMessage("Agent inventory is temporarily unavailable."); }); return () => { cancelled = true; }; }, [client, projectId]);
  useEffect(() => { setInvocationDetail(null); invocationGeneration.current += 1; if (!projectId || !selected) return; let cancelled = false; setInvocations([]); void Promise.all([client.getAgent(selected, projectId), client.listAgentInvocations(selected, { projectId })]).then(([agent, history]) => { if (!cancelled) { setAgents((current) => current.map((item) => item.registration_id === agent.registration_id && item.registration_version === agent.registration_version ? agent : item)); setInvocations(history.invocations); setMessage("Agent inventory is project-scoped and read-only."); } }).catch(() => { if (!cancelled) setMessage("Agent detail is temporarily unavailable."); }); return () => { cancelled = true; }; }, [client, projectId, selected]);
  const activeCatalogColumns = catalogColumnOrder.filter((id) => visibleCatalogColumns.includes(id));
  const catalogGrid = activeCatalogColumns.map((id) => catalogColumns.find((column) => column.id === id)!.width).join(" ");
  const reorderCatalogColumn = (target: CatalogColumnId) => { if (!draggedColumn || draggedColumn === target) return; setCatalogColumnOrder((current) => { const next = current.filter((id) => id !== draggedColumn); next.splice(next.indexOf(target), 0, draggedColumn); return next; }); setDraggedColumn(null); };
  const toggleCatalogColumn = (column: CatalogColumn) => { if (column.required) return; setVisibleCatalogColumns((current) => current.includes(column.id) ? current.filter((id) => id !== column.id) : [...current, column.id]); };
  const showAllCatalogColumns = () => setVisibleCatalogColumns(catalogColumns.map((column) => column.id));
  const resetCatalogColumns = () => { setCatalogColumnOrder(catalogColumns.map((column) => column.id)); showAllCatalogColumns(); };
  const openInvocationDetail = (invocation: AgentInvocation) => { if (!projectId) return; const generation = ++invocationGeneration.current; setInvocationDetail(null); void client.getAgentInvocation(invocation, projectId).then((detail) => { if (generation === invocationGeneration.current) { setInvocationDetail(detail); setMessage("Showing safe immutable role pins."); } }).catch(() => { if (generation === invocationGeneration.current) setMessage("Invocation role pins are temporarily unavailable."); }); };
  return <section className="view mission-view agent-operations" aria-labelledby="agent-operations-title">
    <header className="flow-header agent-operations-header"><div><p className="eyebrow">Registry and runtime bindings</p><h1 id="agent-operations-title">Agent Operations</h1><p className="mission-meta"><span>{projectId ?? "No project selected"}</span><span>Read-only authoritative inventory</span></p></div><div className="kpis"><Kpi label="Eligible releases" value={agents.length} /><Kpi label="Pinned flows" value={invocations.length} /></div></header>
    <p className="sync-row" role="status">{message}</p>
    {projectId && <div className="agent-operations-layout">
      <section className="agent-catalog card" aria-label="Agent release catalog"><div className="agent-section-heading"><div><p className="eyebrow">Catalog</p><h2>Agent releases</h2></div><div className="catalog-header-actions"><span>{agents.length}</span><button className="catalog-settings-trigger" aria-label="Customize catalog columns" aria-expanded={catalogSettingsOpen} onClick={() => setCatalogSettingsOpen((open) => !open)}>⚙</button>{catalogSettingsOpen && <div className="catalog-column-settings" role="dialog" aria-label="Catalog columns"><b>Catalog columns</b><small>Drag headers to reorder. Toggle every optional field here; essential operational columns stay visible.</small>{catalogColumns.map((column) => <button key={column.id} aria-label={`Toggle catalog column ${column.label}`} aria-pressed={visibleCatalogColumns.includes(column.id)} disabled={column.required} onClick={() => toggleCatalogColumn(column)}><i>{visibleCatalogColumns.includes(column.id) ? "✓" : ""}</i>{column.label}{column.required && <em>Essential</em>}</button>)}<div className="catalog-settings-actions"><button onClick={showAllCatalogColumns}>Show all</button><button onClick={resetCatalogColumns}>Reset layout</button></div></div>}</div></div><div className="agent-release-list"><div className="agent-release-columns" style={{ gridTemplateColumns: catalogGrid }}>{activeCatalogColumns.map((id) => { const column = catalogColumns.find((candidate) => candidate.id === id)!; return <button key={id} draggable onDragStart={() => setDraggedColumn(id)} onDragEnd={() => setDraggedColumn(null)} onDragOver={(event) => event.preventDefault()} onDrop={() => reorderCatalogColumn(id)} aria-label={`Move ${column.label} column`} className={draggedColumn === id ? "dragging" : ""}><span aria-hidden="true">⠿</span>{column.label}</button>; })}</div>{agents.map((item) => <button key={`${item.registration_id}:${item.registration_version}`} className={`agent-release-card ${selected?.registration_id === item.registration_id && selected.registration_version === item.registration_version ? "selected" : ""}`} style={{ gridTemplateColumns: catalogGrid }} onClick={() => setSelected(item)}>{activeCatalogColumns.map((id) => <CatalogCell key={id} item={item} column={id} />)}</button>)}{agents.length === 0 && <p className="control-note">No safe agent release facts are available.</p>}</div></section>
      <div className="agent-dossier-stack">
        <section className="agent-flow-ledger card"><div className="agent-section-heading"><div><p className="eyebrow">Immutable run-role pins</p><h2>Workflow activity</h2></div><span>{invocations.length} invocations</span></div><p className="control-note">Each planner, developer, and MCP binding is pinned to its originating workflow. Root-run lifecycle is authoritative.</p><div className="agent-flow-list">{invocations.map((item) => <div className="agent-flow-row" key={`${item.run_id}:${item.role}`}><span className="flow-status"><Pill status={item.run_lifecycle_status} /></span><span className="flow-copy"><b>{item.role}</b><small>Release v{item.registration_version} · {item.gateway_route?.model_alias ?? "gateway route unavailable"}</small></span><span className="flow-id"><small>Workflow Flow ID</small><strong className="mono">{item.root_run_id}</strong></span><span className="flow-meta"><small>Last invocation update</small><strong>{new Date(item.updated_at).toLocaleString()}</strong></span><span className="flow-inspect">{item.workflow_available !== false ? <button aria-label={`Open workflow for ${item.role} ${statusLabel(item.run_lifecycle_status).toLowerCase()} invocation ${item.root_run_id}`} onClick={() => onOpenWorkflow(item)}>Open workflow →</button> : <small>Workflow view unavailable</small>}<button aria-label={`View role pins for ${item.role} ${item.run_id}`} onClick={() => openInvocationDetail(item)}>View role pins</button></span></div>)}{invocations.length === 0 && <p className="control-note">No persisted run-role bindings are available.</p>}</div>{invocationDetail && <section className="agent-invocation-dossier"><div className="agent-section-heading"><div><p className="eyebrow">Safe role evidence</p><h3>{invocationDetail.role} · v{invocationDetail.registration_version}</h3></div><button aria-label="Close role pins" onClick={() => setInvocationDetail(null)}>×</button></div><p className="control-note">Lifecycle: {invocationDetail.evidence.lifecycle}. Cost, turns, artifacts, and failures remain unavailable or redacted.</p><div className="agent-evidence-grid"><section><h4>Lifecycle transitions</h4>{invocationDetail.lifecycle_transitions.length ? <ol className="invocation-timeline">{invocationDetail.lifecycle_transitions.map((transition, index) => <li key={`${transition.occurred_at}:${index}`}><i /><span><b>{transition.to_status ?? "Unknown"}</b><small>{new Date(transition.occurred_at).toLocaleString()}</small></span></li>)}</ol> : <p className="control-note">No safe transitions available.</p>}</section><section><h4>MCP grants</h4>{invocationDetail.mcp_grants.length ? <ul className="mcp-grant-list">{invocationDetail.mcp_grants.map((grant) => <li key={`${grant.server_id}:${grant.server_version}:${grant.tool_name}:${grant.input_schema_sha256}`}><b>{grant.server_id}</b> v{grant.server_version} · {grant.tool_name}</li>)}</ul> : <p className="control-note">No MCP grants pinned.</p>}</section></div></section>}</section>
      </div>
    </div>}
  </section>;
}

type ProductPlanPhase = { id: string; name: string; description: string; acceptanceCriteria: string[]; requirementIds: string[]; verificationReferences: string[]; riskNotes: string[]; rollbackNotes: string[] };
type ProductPlan = { title: string; summary: string; phases: ProductPlanPhase[] };
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function productPlan(content: string, artifact: Artifact | null): ProductPlan | null {
  if (artifact?.kind !== "plan") return null;
  try {
    const parsed: unknown = JSON.parse(content);
    if (!isRecord(parsed) || typeof parsed.title !== "string" || typeof parsed.summary !== "string" || !Array.isArray(parsed.phases)) return null;
    const phases = parsed.phases.flatMap((value): ProductPlanPhase[] => {
      if (!isRecord(value) || typeof value.id !== "string" || typeof value.name !== "string" || typeof value.description !== "string" || !Array.isArray(value.acceptance_criteria) || !value.acceptance_criteria.every((criterion) => typeof criterion === "string")) return [];
      const strings = (field: string) => Array.isArray(value[field]) && value[field].every((item) => typeof item === "string") ? value[field] as string[] : [];
      return [{ id: value.id, name: value.name, description: value.description, acceptanceCriteria: value.acceptance_criteria, requirementIds: strings("requirement_ids"), verificationReferences: strings("verification_references"), riskNotes: strings("risk_notes"), rollbackNotes: strings("rollback_notes") }];
    });
    return { title: parsed.title, summary: parsed.summary, phases };
  } catch { return null; }
}
function ProductPlanSummary({ content, artifact }: { content: string; artifact: Artifact | null }) {
  const plan = productPlan(content, artifact);
  if (!plan) return null;
  return <section className="card dossier-section plan-summary" aria-labelledby="verified-plan-summary-title"><h3 id="verified-plan-summary-title" className="panel-title">Verified plan summary</h3><div className="dossier-section-body"><h4>{plan.title}</h4><p className="dossier-description">{plan.summary}</p><div className="timeline">{plan.phases.map((phase) => <div className="tl-item" key={phase.id}><i /><span><b>{phase.name}</b><small>{phase.description}</small>{phase.requirementIds.length > 0 && <small>Requirements: {phase.requirementIds.join(" · ")}</small>}{phase.acceptanceCriteria.length > 0 && <small>Acceptance: {phase.acceptanceCriteria.join(" · ")}</small>}{phase.verificationReferences.length > 0 && <small>Verification: {phase.verificationReferences.join(" · ")}</small>}{phase.riskNotes.length > 0 && <small>Risks: {phase.riskNotes.join(" · ")}</small>}{phase.rollbackNotes.length > 0 && <small>Rollback: {phase.rollbackNotes.join(" · ")}</small>}</span></div>)}</div></div></section>;
}

function SpecificationEvaluationSummary({ content, artifact }: { content: string; artifact: Artifact | null }) {
  if (artifact?.kind !== "specification_evaluation") return null;
  try {
    const parsed: unknown = JSON.parse(content);
    if (!isRecord(parsed)) return null;
    const coverage = isRecord(parsed.coverage) ? parsed.coverage : null;
    const findings = Array.isArray(parsed.findings) ? parsed.findings.filter(isRecord) : [];
    const ids = (value: unknown) => Array.isArray(value) && value.every((item) => typeof item === "string") ? value as string[] : [];
    return <section className="card dossier-section" aria-labelledby="evaluation-scorecard-title"><h3 id="evaluation-scorecard-title" className="panel-title">Evaluation scorecard</h3><div className="dossier-section-body"><p className="dossier-description">Readiness: <b>{typeof parsed.readiness === "string" ? parsed.readiness : "unavailable"}</b>{typeof parsed.risk_tier === "string" ? ` · Risk: ${parsed.risk_tier}` : ""}</p>{coverage && <div className="dossier-details"><div><span>Covered requirements</span><b>{ids(coverage.covered_requirement_ids).length}</b></div><div><span>Uncovered requirements</span><b>{ids(coverage.uncovered_requirement_ids).length}</b></div><div><span>Deferred requirements</span><b>{ids(coverage.deferred_requirement_ids).length}</b></div></div>}{findings.length > 0 && <div className="timeline">{findings.map((finding, index) => <div className="tl-item" key={`${String(finding.id ?? index)}`}><i /><span><b>{typeof finding.kind === "string" ? finding.kind : "finding"}</b><small>{typeof finding.message === "string" ? finding.message : "No safe finding detail is available."}</small>{ids(finding.requirement_ids).length > 0 && <small>Requirements: {ids(finding.requirement_ids).join(" · ")}</small>}</span></div>)}</div>}</div></section>;
  } catch { return null; }
}

function prettyEvidence(content: string) {
  try {
    const formatted = JSON.stringify(JSON.parse(content), null, 2);
    const tokenPattern = /("(?:\\.|[^"\\])*")(?=\s*:)|("(?:\\.|[^"\\])*")|\b(true|false|null)\b|(-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;
    const tokens = [];
    let lastIndex = 0;
    for (let match = tokenPattern.exec(formatted); match; match = tokenPattern.exec(formatted)) {
      if (match.index > lastIndex) tokens.push(formatted.slice(lastIndex, match.index));
      const tone = match[1] ? "json-key" : match[2] ? "json-string" : match[3] ? "json-literal" : "json-number";
      tokens.push(<span className={tone} key={`${match.index}:${match[0]}`}>{match[0]}</span>);
      lastIndex = match.index + match[0].length;
    }
    if (lastIndex < formatted.length) tokens.push(formatted.slice(lastIndex));
    return tokens;
  } catch { return content; }
}

function EvidenceViewer({ client, run, initial, stageId }: { client: ApiClient; run: Run; initial?: Artifact["kind"]; stageId?: string }) {
  const [selected, setSelected] = useState<Artifact | null>(() => initial ? evidenceFor(run, initial) : run.artifacts[0] ?? null);
  const [content, setContent] = useState(""); const [error, setError] = useState<string | null>(null); const [loading, setLoading] = useState(false); const [evidenceExpanded, setEvidenceExpanded] = useState(false); const [note, setNote] = useState(""); const [feedbackNotice, setFeedbackNotice] = useState<string | null>(null); const [feedback, setFeedback] = useState<Feedback[] | null>(null); const [submittingFeedback, setSubmittingFeedback] = useState(false); const [loadingFeedback, setLoadingFeedback] = useState(false);
  useEffect(() => { setSelected(initial ? evidenceFor(run, initial) : run.artifacts[0] ?? null); setContent(""); setError(null); setEvidenceExpanded(false); setFeedback(null); setFeedbackNotice(null); }, [initial, run.run_id]);
  useEffect(() => {
    if (!stageId || !selected) return;
    let cancelled = false;
    setLoadingFeedback(true);
    void client.getFeedback(run.run_id).then((items) => { if (!cancelled) setFeedback(items); }).catch((reason) => { if (!cancelled) setFeedbackNotice(reason instanceof Error ? reason.message : "Recorded review context is unavailable."); }).finally(() => { if (!cancelled) setLoadingFeedback(false); });
    return () => { cancelled = true; };
  }, [client, run.run_id, selected?.sha256, stageId]);
  const open = async (artifact: Artifact) => {
    if (selected?.sha256 === artifact.sha256 && content) { setEvidenceExpanded((expanded) => !expanded); return; }
    setSelected(artifact); setContent(""); setEvidenceExpanded(true); setLoading(true); setError(null); setFeedbackNotice(null);
    try { setContent((await client.getEvidence(run.run_id, artifact)).content); } catch (reason) { setContent(""); setError(reason instanceof Error ? reason.message : "Verified evidence is unavailable."); } finally { setLoading(false); }
  };
  const submitNote = async () => { if (!selected || !stageId || !note.trim()) return; try { setSubmittingFeedback(true); const recorded = await client.recordFeedback(run, selected, stageId, note.trim()); setFeedbackNotice(`Review context recorded at ${new Date(recorded.created_at).toLocaleString()}. It does not change execution.`); setFeedback((items) => [recorded, ...(items ?? [])]); setNote(""); } catch (reason) { setFeedbackNotice(reason instanceof Error ? reason.message : "Review context could not be recorded."); } finally { setSubmittingFeedback(false); } };
  const visibleFeedback = feedback?.filter((item) => item.stage_id === stageId && item.artifact_sha256 === selected?.sha256) ?? [];
  return <div className="dossier-section-stack"><section className="card dossier-section evidence-card"><h2 className="panel-title">Verified immutable evidence</h2><div className="dossier-section-body"><div className="artifact-list">{run.artifacts.map((artifact) => <button key={`${artifact.kind}:${artifact.sha256}`} className={selected?.sha256 === artifact.sha256 ? "selected" : ""} aria-expanded={selected?.sha256 === artifact.sha256 && evidenceExpanded} onClick={() => void open(artifact)}><b>{artifactLabel(artifact.kind)}</b><small>{artifact.sha256.slice(0, 12)}</small></button>)}</div>{selected && <p className="control-note">Digest: <span className="mono">{selected.sha256}</span></p>}{loading && <p className="control-note" role="status">Loading verified evidence…</p>}{error && <p className="evidence-error" role="alert">{error}</p>}{content && evidenceExpanded && <pre className="evidence-json" aria-label="Verified evidence">{prettyEvidence(content)}</pre>}{!selected && <p className="control-note">No immutable evidence is available for this run.</p>}</div></section>{content && evidenceExpanded && <ProductPlanSummary content={content} artifact={selected} />}{content && evidenceExpanded && <SpecificationEvaluationSummary content={content} artifact={selected} />}{stageId && selected && <section className="card dossier-section review-context"><h3 className="panel-title">Review context</h3><div className="dossier-section-body"><p id="review-context-help" className="control-note">Capture immutable rationale for reviewers of this exact evidence. It does not instruct an agent or change execution; use Request revision when the work itself needs to change.</p><label className="form-field" htmlFor="review-context"><span>Context for reviewers</span><textarea id="review-context" className="form-textarea" aria-describedby="review-context-help review-context-limit" value={note} onChange={(event) => setNote(event.target.value)} maxLength={10_000} placeholder="Add decision context, assumptions, or rollout concerns…" /></label><p id="review-context-limit" className="form-help">Up to 10,000 characters. Recording is permanent for this stage and digest.</p><div className="form-actions"><button className="button-primary" disabled={!note.trim() || submittingFeedback} aria-busy={submittingFeedback} onClick={() => void submitNote()}>{submittingFeedback ? "Recording…" : "Record context"}</button></div>{loadingFeedback && <p className="control-note" role="status">Loading recorded review context…</p>}{feedbackNotice && <p className="sync-row" role="status">{feedbackNotice}</p>}{feedback && (visibleFeedback.length ? <div className="timeline" aria-label="Recorded review context">{visibleFeedback.map((item) => <div className="tl-item" key={item.feedback_id}><i /><span><b>{item.actor_id}</b><small>{new Date(item.created_at).toLocaleString()} · {item.comment}</small></span></div>)}</div> : <p className="control-note">No review context is bound to this stage and digest.</p>)}</div></section>}</div>;
}

function ProductSpecificationControls({ client, run, onComplete }: { client: ApiClient; run: Run; onComplete: () => Promise<void | boolean> }) {
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [revisionText, setRevisionText] = useState("");
  const [editorOpen, setEditorOpen] = useState(false);
  const [waiverRationale, setWaiverRationale] = useState("");
  const [revisionParent, setRevisionParent] = useState<{ revision: number; artifactSha256: string } | null>(null);
  const artifact = evidenceFor(run, "product_specification");
  const selected = run.selected_product_specification_revision !== null && run.selected_product_specification_revision !== undefined;
  const mutable = run.status === "planning";
  const specificationRevision = run.product_specification_revision;
  const hasMutableRevision = typeof specificationRevision === "number" && Number.isInteger(specificationRevision) && specificationRevision >= 1;
  const act = async (action: () => Promise<void>, message: string) => {
    try { setPending(true); setNotice(null); await action(); await onComplete(); setNotice(message); return true; }
    catch (reason) { setNotice(reason instanceof Error ? reason.message : "The product specification action could not be completed."); return false; }
    finally { setPending(false); }
  };
  const beginRevision = async () => {
    if (!artifact || !hasMutableRevision || specificationRevision === undefined) {
      setNotice("The displayed product specification revision is unavailable. Refresh the run before editing or selecting it.");
      return;
    }
    try {
      setPending(true); setNotice(null);
      const evidence = await client.getEvidence(run.run_id, artifact);
      const parsed: unknown = JSON.parse(evidence.content);
      setRevisionText(JSON.stringify(parsed, null, 2));
      setRevisionParent({ revision: specificationRevision, artifactSha256: artifact.sha256 });
      setEditorOpen(true);
    } catch (reason) { setNotice(reason instanceof Error ? reason.message : "The immutable product specification could not be loaded."); }
    finally { setPending(false); }
  };
  const submitRevision = async () => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(revisionText);
    } catch { setNotice("Enter a complete valid JSON product specification before submitting."); }
    if (parsed !== undefined && revisionParent && await act(() => client.reviseProductSpecification(run, revisionParent, parsed), "Revision recorded. Review and select the new immutable evidence before planning.")) { setEditorOpen(false); setRevisionParent(null); }
  };
  return <section className="card dossier-section"><h2 className="panel-title">Product specification gate</h2><div className="dossier-section-body">
    <p className="control-note">Only the server can generate or select immutable specification evidence. Selection binds the digest used for plan generation.</p>
    {!mutable && <p className="control-note">This product specification is immutable because the run is no longer in refinement.</p>}
    {mutable && artifact && !hasMutableRevision && <p className="control-note">The displayed product specification revision is unavailable. Refresh the run before editing or selecting it.</p>}
    {mutable && !artifact && <button className="button-primary" disabled={pending} aria-busy={pending} onClick={() => void act(() => client.generateProductSpecification(run.run_id), "Draft generated. Review its verified evidence before evaluation.")}>{pending ? "Generating…" : "Generate product specification"}</button>}
    {mutable && artifact && !run.specification_evaluation_readiness && <button className="button-primary" disabled={pending} aria-busy={pending} onClick={() => void act(() => client.evaluateProductSpecification(run.run_id), "Evaluation recorded. Review its readiness before selecting this specification.")}>{pending ? "Evaluating…" : "Evaluate product specification"}</button>}
    {run.specification_evaluation_readiness === "needs_revision" && <><p className="evidence-error" role="alert">Evaluation requires a revised product specification before planning can continue, unless an authorized operator records an explicit exception.</p><label className="form-field" htmlFor="evaluation-waiver-rationale"><span>Waiver rationale</span><textarea id="evaluation-waiver-rationale" className="form-textarea" value={waiverRationale} onChange={(event) => setWaiverRationale(event.target.value)} maxLength={2000} placeholder="Explain why the evaluation finding is accepted…" /></label><div className="form-actions"><button className="button-secondary" disabled={pending || !waiverRationale.trim()} aria-busy={pending} onClick={() => void act(() => client.waiveSpecificationEvaluation(run, waiverRationale), "Evaluation waiver recorded. Review and select this specification before planning.")}>{pending ? "Recording…" : "Record evaluation waiver"}</button></div></>}
    {run.specification_evaluation_readiness === "waived" && <div className="sync-row" role="status">{run.specification_evaluation_waiver ? <>Evaluation waiver recorded by <b>{run.specification_evaluation_waiver.actor_id}</b> on {new Date(run.specification_evaluation_waiver.created_at).toLocaleString()}: {run.specification_evaluation_waiver.rationale}</> : "An authorized evaluation waiver is recorded for this specification."}</div>}
    {mutable && artifact && hasMutableRevision && !editorOpen && <button className="button-secondary" disabled={pending} aria-busy={pending} onClick={() => void beginRevision()}>{pending ? "Loading revision…" : "Edit product specification"}</button>}
    {mutable && artifact && hasMutableRevision && !selected && (run.specification_evaluation_readiness === "ready" || run.specification_evaluation_readiness === "waived") && <button className="button-primary" disabled={pending} aria-busy={pending} onClick={() => void act(() => client.selectProductSpecification(run), "Product specification selected for planning.")}>{pending ? "Selecting…" : "Select product specification"}</button>}
    {mutable && selected && <button className="button-primary" disabled={pending} aria-busy={pending} onClick={() => void act(() => client.generatePlan(run.run_id), "Plan generated. Review the immutable plan before approval.")}>{pending ? "Generating plan…" : "Generate plan"}</button>}
    {editorOpen && mutable && <><label className="form-field" htmlFor="product-specification-revision"><span>Complete product specification JSON</span><textarea id="product-specification-revision" className="form-textarea" value={revisionText} onChange={(event) => setRevisionText(event.target.value)} aria-describedby="product-specification-revision-help" /></label><p id="product-specification-revision-help" className="form-help">The complete request is limited to 96 KiB, replaces the selected draft only after server validation, and requires a new explicit selection.</p><div className="form-actions"><button className="button-primary" disabled={pending} aria-busy={pending} onClick={() => void submitRevision()}>{pending ? "Recording…" : "Record revised specification"}</button><button className="button-secondary" disabled={pending} onClick={() => { setEditorOpen(false); setRevisionParent(null); }}>Cancel revision</button></div></>}
    {selected && <p className="sync-row" role="status">Product specification revision {run.selected_product_specification_revision} is selected for planning.</p>}
    {notice && <p className="sync-row" role="status">{notice}</p>}
  </div></section>;
}

function Timeline({ events }: { events: TimelineEvent[] }) { return <section className="card"><h2 className="panel-title">Authoritative timeline</h2>{events.length === 0 ? <p className="control-note">No persisted lifecycle events are available yet.</p> : <div className="timeline">{events.map((event) => <div className="tl-item" key={event.event_id}><i /><span><b>{statusLabel(event.event_type)}</b><small>{new Date(event.occurred_at).toLocaleString()} · {event.gate ? `${event.gate} gate` : event.lifecycle_status ?? "lifecycle event"}{event.decision ? ` · ${event.decision}` : ""}{event.artifact_sha256 ? ` · ${event.artifact_sha256.slice(0, 12)}` : ""}</small></span><Pill status={event.delivered ? "delivered" : "pending"} label={event.delivered ? "delivered" : `${event.delivery_attempt_count} attempts`} /></div>)}</div>}</section>; }

function stageTone(stage: Stage) { return stage.state === "failed" ? "err" : stage.state === "awaiting_operator" || stage.state === "needs_revision" ? "warn" : stage.state === "in_progress" ? "active" : stage.state === "completed" ? "run" : "idle"; }
function relatedEvents(stage: Stage, events: TimelineEvent[]) {
  return events.filter((event) => (event.stage_ids?.length ? event.stage_ids : event.stage_id ? [event.stage_id] : []).includes(stage.stage_id)).slice(0, 3);
}

function graphFor(run: Run): { nodes: PositionedWorkflowNode[]; edges: WorkflowEdge[]; width: number; height: number } {
  const graph = run.workflow_graph;
  const sourceNodes: WorkflowNode[] = graph ? graph.nodes.map((node) => ({
    id: node.stage_id, name: node.label, type: node.node_type, status: node.state, availability: node.availability,
    artifactKind: node.artifact_kind, reason: node.reason, metric: node.artifact_kind ? String(run.artifacts.filter((artifact) => artifact.kind === node.artifact_kind).length) : "—"
  })) : (run.stages ?? []).map((stage) => ({
    id: stage.stage_id, name: stage.label, type: stage.stage_id.includes("approval") ? "gate" : stage.stage_id === "specification" ? "queue" : "agent", status: stage.state, availability: stage.availability,
    artifactKind: stage.artifact_kind, reason: stage.reason, metric: stage.artifact_kind ? String(run.artifacts.filter((artifact) => artifact.kind === stage.artifact_kind).length) : "—"
  }));
  const edges: WorkflowEdge[] = graph ? graph.edges.map((edge) => ({
    fromNodeId: edge.source_node_id, toNodeId: edge.target_node_id, style: edge.style, emphasis: edge.emphasis
  })) : sourceNodes.slice(1).map((node, index) => ({ fromNodeId: sourceNodes[index].id, toNodeId: node.id, style: "solid", emphasis: "primary" }));
  const incoming = new Map(sourceNodes.map((node) => [node.id, 0]));
  const outgoing = new Map(sourceNodes.map((node) => [node.id, [] as string[]]));
  edges.forEach((edge) => { incoming.set(edge.toNodeId, (incoming.get(edge.toNodeId) ?? 0) + 1); outgoing.get(edge.fromNodeId)?.push(edge.toNodeId); });
  const rank = new Map<string, number>(); const queue = sourceNodes.filter((node) => incoming.get(node.id) === 0);
  queue.forEach((node) => rank.set(node.id, 0));
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index]; const currentRank = rank.get(current.id) ?? 0;
    for (const nextId of outgoing.get(current.id) ?? []) { rank.set(nextId, Math.max(rank.get(nextId) ?? 0, currentRank + 1)); incoming.set(nextId, (incoming.get(nextId) ?? 1) - 1); if (incoming.get(nextId) === 0) { const next = sourceNodes.find((node) => node.id === nextId); if (next) queue.push(next); } }
  }
  const layers = new Map<number, WorkflowNode[]>();
  sourceNodes.forEach((node) => { const nodeRank = rank.get(node.id) ?? 0; layers.set(nodeRank, [...(layers.get(nodeRank) ?? []), node]); });
  const maxLayerSize = Math.max(1, ...[...layers.values()].map((layer) => layer.length));
  const height = Math.max(700, 140 + maxLayerSize * 190); const width = Math.max(1400, 160 + layers.size * 270);
  const nodes = sourceNodes.map((node) => {
    if (node.position) return { ...node, position: node.position };
    const nodeRank = rank.get(node.id) ?? 0; const layer = layers.get(nodeRank) ?? [node]; const slot = layer.findIndex((item) => item.id === node.id);
    const y = 70 + ((height - 140) / (layer.length + 1)) * (slot + 1) - 65;
    return { ...node, position: { x: 40 + nodeRank * 270, y, width: 200 } };
  });
  return { nodes, edges, width, height };
}
function evidenceCaption(node: PositionedWorkflowNode) {
  if (!node.artifactKind) return "no evidence";
  return node.metric === "1" ? "verified artifact" : "verified artifacts";
}

function compactGeometry(node: PositionedWorkflowNode, graph: ReturnType<typeof graphFor>) {
  return {
    centerX: (node.position.x + node.position.width / 2) / graph.width * 100,
    centerY: (node.position.y + 64) / graph.height * 100,
    width: Math.max(17, node.position.width / graph.width * 100)
  };
}

function compactEdgePath(source: ReturnType<typeof compactGeometry>, target: ReturnType<typeof compactGeometry>) {
  const x1 = source.centerX + source.width / 2;
  const x2 = target.centerX - target.width / 2;
  const midpoint = (x1 + x2) / 2;
  return `M ${x1} ${source.centerY} C ${midpoint} ${source.centerY}, ${midpoint} ${target.centerY}, ${x2} ${target.centerY}`;
}

function WorkflowMap({ run, timeline, onEvidence }: { run: Run; timeline: TimelineEvent[]; onEvidence: (kind: Artifact["kind"]) => void }) {
  const [zoom, setZoom] = useState(100);
  const [selectedStageId, setSelectedStageId] = useState<string | null>(null);
  const stages = run.stages ?? [];
  const selected = stages.find((stage) => stage.stage_id === selectedStageId) ?? stages.find((stage) => stage.state === "awaiting_operator") ?? stages[0] ?? null;
  useEffect(() => { setSelectedStageId(null); setZoom(100); }, [run.run_id]);
  return <section className="workflow-map" aria-labelledby="workflow-map-title"><div className="canvas-toolbar"><span id="workflow-map-title">Workflow topology · typed server state</span><div><button aria-label="Zoom out" disabled={zoom === 60} onClick={() => setZoom((value) => Math.max(60, value - 10))}>−</button><span aria-live="polite">{zoom}%</span><button aria-label="Zoom in" disabled={zoom === 160} onClick={() => setZoom((value) => Math.min(160, value + 10))}>+</button><button aria-label="Fit workflow map" onClick={() => setZoom(100)}>⌗</button></div><span className="canvas-mode">authoritative</span></div><div className="workflow-map-layout"><div className="canvas-scroll"><div className="map-scale" data-zoom={zoom} style={{ width: `${Math.max(880, stages.length * 220) * zoom / 100}px` }}><div className="workflow-map-canvas" style={{ "--count": stages.length, transform: `scale(${zoom / 100})` } as React.CSSProperties}><div className="workflow-map-line" />{stages.map((stage) => <button key={stage.stage_id} className={`workflow-node ${stageTone(stage)} ${selected?.stage_id === stage.stage_id ? "selected" : ""}`} onClick={() => setSelectedStageId(stage.stage_id)} aria-label={`${stage.label}: ${statusLabel(stage.state)}, ${stage.availability}`}><span className="workflow-node-marker" /><span><b>{stage.label}</b><small>{statusLabel(stage.state)}</small></span><Pill status={stage.state} label={stage.availability} /></button>)}</div></div></div>{selected && <aside className="workflow-stage-panel" aria-label={`${selected.label} details`}><p className="eyebrow">Selected stage</p><div className="title-line"><h2>{selected.label}</h2><Pill status={selected.state} /></div><p>{selected.reason}</p><dl><dt>State source</dt><dd>{selected.availability}</dd>{selected.artifact_kind && <><dt>Evidence</dt><dd><button className="text-button" onClick={() => onEvidence(selected.artifact_kind!)}>{selected.artifact_kind}</button></dd></>}</dl>{relatedEvents(selected, timeline).length > 0 && <div className="timeline"><p className="eyebrow">Related events</p>{relatedEvents(selected, timeline).map((event) => <div className="tl-item" key={event.event_id}><i /><span><b>{statusLabel(event.event_type)}</b><small>{new Date(event.occurred_at).toLocaleString()}</small></span></div>)}</div>}</aside>}</div></section>;
}

function LifecycleRail({ nodes, focusedNodeId, onFocus, onVisualize }: { nodes: PositionedWorkflowNode[]; focusedNodeId: string | null; onFocus: (node: PositionedWorkflowNode) => void; onVisualize: () => void }) {
  return <section className="lifecycle-rail" aria-labelledby="lifecycle-rail-title">
    <div className="lifecycle-rail-heading"><p id="lifecycle-rail-title">Lifecycle</p><small>Authoritative stage projection</small></div>
    <div className="lifecycle-rail-scroll"><ol>{nodes.map((node, index) => <li key={node.id} className={statusTone(node.status)}><button aria-label={`Focus ${node.name}`} aria-pressed={focusedNodeId === node.id} onClick={() => onFocus(node)}><span className="lifecycle-step">{index + 1}</span><span className="lifecycle-copy"><b>{node.name}</b><small>{statusLabel(node.status)}</small></span><i className="lifecycle-dot" /></button>{index < nodes.length - 1 && <span className="lifecycle-link" aria-hidden="true" />}</li>)}</ol></div>
    <button className="topology-mode-button" onClick={onVisualize} aria-label="Visualize workflow topology">Visualize</button>
  </section>;
}

function CompactTopology({ graph, focusedNodeId, onFocus, onLifecycle }: { graph: ReturnType<typeof graphFor>; focusedNodeId: string | null; onFocus: (node: PositionedWorkflowNode) => void; onLifecycle: () => void }) {
  const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
  const geometries = new Map(graph.nodes.map((node) => [node.id, compactGeometry(node, graph)]));
  return <section className="compact-topology" aria-labelledby="compact-topology-title"><header><div><p id="compact-topology-title">Workflow topology</p><small>Compact relay overview · authoritative graph</small></div><button className="topology-mode-button" onClick={onLifecycle}>Lifecycle</button></header><div className="compact-topology-viewport"><div className="compact-topology-canvas"><svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">{graph.edges.map((edge) => { const source = nodesById.get(edge.fromNodeId); const target = nodesById.get(edge.toNodeId); const sourceGeometry = geometries.get(edge.fromNodeId); const targetGeometry = geometries.get(edge.toNodeId); return source && target && sourceGeometry && targetGeometry ? <path key={`${edge.fromNodeId}-${edge.toNodeId}`} d={compactEdgePath(sourceGeometry, targetGeometry)} className={edge.emphasis} strokeDasharray={edge.style === "dashed" ? ".6 .6" : undefined} /> : null; })}</svg>{graph.nodes.map((node) => { const geometry = geometries.get(node.id)!; return <button key={node.id} className={`${node.type} ${statusTone(node.status)} ${focusedNodeId === node.id ? "selected" : ""}`} style={{ left: `${geometry.centerX}%`, top: `${geometry.centerY}%`, width: `${geometry.width}%` }} aria-label={`Select ${node.name}`} aria-pressed={focusedNodeId === node.id} onClick={() => onFocus(node)}><span className="compact-node-icon">{node.type === "agent" ? "✦" : node.type === "gate" ? "◇" : "▤"}</span><span className="compact-node-copy"><b>{node.name}</b><small>{node.type}</small></span><i className="compact-node-status" /><span className="compact-node-metric"><b>{node.metric}</b><small>{evidenceCaption(node)}</small></span></button>; })}</div></div></section>;
}

function StageInspector({ node, incoming, outgoing, collapsed, onToggle }: { node: PositionedWorkflowNode; incoming: number; outgoing: number; collapsed: boolean; onToggle: () => void }) {
  return <section className={`stage-inspector ${statusTone(node.status)} ${collapsed ? "collapsed" : ""}`} aria-label="Selected stage details">
    <div className="stage-inspector-title"><span className="stage-inspector-marker" /><div><p className="eyebrow">Selected stage</p><div className="title-line"><h2>{node.name}</h2><Pill status={node.status} /></div>{!collapsed && <p>{node.reason}</p>}</div><button className="stage-inspector-collapse" aria-label={collapsed ? "Expand stage details" : "Collapse stage details"} aria-expanded={!collapsed} onClick={onToggle}>{collapsed ? "⌄" : "⌃"}</button></div>
    {!collapsed && <dl className="stage-inspector-facts"><div><dt>State source</dt><dd>{node.availability}</dd></div><div><dt>Node role</dt><dd>{node.type}</dd></div><div><dt>Evidence</dt><dd>{node.artifactKind ? `${node.artifactKind} artifact` : "Unavailable"}</dd></div><div><dt>Dependencies</dt><dd>{incoming} upstream · {outgoing} downstream</dd></div></dl>}
  </section>;
}

function EmbeddedStageDossier({ client, run, node, edges, timeline, tab, setTab, onRefresh, decisionNotice, onDecisionComplete }: { client: ApiClient; run: Run; node: PositionedWorkflowNode; edges: WorkflowEdge[]; timeline: TimelineEvent[]; tab: NodeDossierTab; setTab: (tab: NodeDossierTab) => void; onRefresh: () => Promise<void | boolean>; decisionNotice: string | null; onDecisionComplete: () => void }) {
  const tabs: Array<{ id: NodeDossierTab; label: string }> = [{ id: "overview", label: "Overview" }, { id: "audit", label: "Audit activity" }, { id: "specifications", label: "Specifications" }, { id: "configuration", label: "Configuration" }, { id: "dependencies", label: "Dependencies" }, { id: "history", label: "History" }];
  const graph = graphFor(run);
  const relatedIds = edges.filter((edge) => edge.fromNodeId === node.id || edge.toNodeId === node.id).flatMap((edge) => [edge.fromNodeId, edge.toNodeId]).filter((id) => id !== node.id);
  const dependencies = graph.nodes.filter((item) => relatedIds.includes(item.id));
  const events = relatedEvents({ stage_id: node.id, label: node.name, state: node.status as Stage["state"], availability: node.availability, reason: node.reason, artifact_kind: node.artifactKind }, timeline);
  const configuration = { node_id: node.id, type: node.type, state_source: node.availability, evidence_kind: node.artifactKind };
  const history = events.length ? <div className="timeline">{events.map((event) => <div className="tl-item" key={event.event_id}><i /><span><b>{statusLabel(event.event_type)}</b><small>{new Date(event.occurred_at).toLocaleString()} · {event.delivered ? "delivered" : "pending delivery"}</small></span></div>)}</div> : <p className="control-note">No persisted lifecycle history is available for this node.</p>;
  return <section className="embedded-dossier" aria-labelledby="embedded-dossier-title"><header><div><p className="eyebrow">Selected-stage dossier</p><h2 id="embedded-dossier-title">{node.name}</h2></div></header><div className="subtabs" role="tablist" aria-label="Selected-stage dossier views">{tabs.map((item) => <button key={item.id} className="subtab" role="tab" aria-selected={tab === item.id} onClick={() => setTab(item.id)}>{item.label}</button>)}</div><div className="embedded-dossier-content">{decisionNotice && <p className="sync-row" role="status">{decisionNotice}</p>}{tab === "overview" && <div className="dossier-grid"><section className="card dossier-section dossier-summary"><h3 className="panel-title">Authoritative node context</h3><div className="dossier-section-body"><p className="dossier-description">{node.reason}</p><div className="dossier-details"><div><span>Node type</span><b>{node.type}</b></div><div><span>State source</span><b>{node.availability}</b></div><div><span>Evidence</span><b>{node.artifactKind ?? "Unavailable"}</b></div><div><span>Workflow scope</span><b>{run.project_id}</b></div></div></div></section><section className="card dossier-section dossier-events"><h3 className="panel-title">Recent events</h3><div className="dossier-section-body">{events.length ? <div className="timeline">{events.map((event) => <div className="tl-item" key={event.event_id}><i /><span><b>{statusLabel(event.event_type)}</b><small>{new Date(event.occurred_at).toLocaleString()}</small></span></div>)}</div> : <p className="control-note">No persisted events are attributable to this node.</p>}</div></section>{node.id === "product_specification" && <ProductSpecificationControls client={client} run={run} onComplete={onRefresh} />}{node.id === `${run.active_gate}_approval` && <DecisionControls client={client} run={run} onComplete={onRefresh} onSuccess={onDecisionComplete} />}</div>}{tab === "audit" && <section className="card dossier-section log-card"><h3 className="panel-title">Authoritative audit activity</h3><div className="dossier-section-body"><p className="control-note">This view contains durable lifecycle and approval events, not raw agent output.</p>{events.length ? events.map((event) => <p key={event.event_id}><span>{new Date(event.occurred_at).toLocaleTimeString()}</span> <b>[{event.gate ?? node.type}]</b> {statusLabel(event.event_type)}</p>) : <p className="control-note">No authoritative audit activity is available for this node.</p>}</div></section>}{tab === "specifications" && (node.artifactKind ? <EvidenceViewer client={client} run={run} initial={node.artifactKind} stageId={node.id} /> : <section className="card dossier-section"><h3 className="panel-title">Verified specification and evidence</h3><div className="dossier-section-body"><p className="control-note">No immutable evidence is available for this node.</p></div></section>)}{tab === "configuration" && <section className="card dossier-section"><h3 className="panel-title">Configuration availability</h3><div className="dossier-section-body"><p className="control-note">No persisted node configuration is available. This bounded display context is authoritative.</p><pre className="codeblock evidence-json" aria-label="Authoritative node display context">{prettyEvidence(JSON.stringify(configuration))}</pre></div></section>}{tab === "dependencies" && <section className="card dossier-section"><h3 className="panel-title">Dependencies</h3><div className="dossier-section-body dependency-list">{dependencies.length ? dependencies.map((dependency) => <div key={dependency.id}><span><b>{dependency.name}</b><small>{dependency.type}</small></span><Pill status={dependency.status} /></div>) : <p className="control-note">This node has no persisted graph dependencies.</p>}</div></section>}{tab === "history" && <section className="card dossier-section"><h3 className="panel-title">Persisted lifecycle history</h3><div className="dossier-section-body">{history}</div></section>}</div></section>;
}

function WorkflowCanvas({ client, run, timeline, onBack, onRefresh, decisionNotice, onDecisionComplete }: { client: ApiClient; run: Run; timeline: TimelineEvent[]; onBack: () => void; onRefresh: () => Promise<void | boolean>; decisionNotice: string | null; onDecisionComplete: () => void }) {
  const [visualizing, setVisualizing] = useState(false);
  const [dossierTab, setDossierTab] = useState<NodeDossierTab>("overview");
  const graph = graphFor(run);
  const [focusedNodeId, setFocusedNodeId] = useState<string | null>(() => graph.nodes.find((node) => node.id === `${run.active_gate}_approval`)?.id ?? graph.nodes.find((node) => node.status === "in_progress")?.id ?? graph.nodes[0]?.id ?? null);
  const [inspectorCollapsed, setInspectorCollapsed] = useState(false);
  useEffect(() => { setVisualizing(false); setDossierTab("overview"); setInspectorCollapsed(false); setFocusedNodeId(graph.nodes.find((node) => node.id === `${run.active_gate}_approval`)?.id ?? graph.nodes.find((node) => node.status === "in_progress")?.id ?? graph.nodes[0]?.id ?? null); }, [run.run_id]);
  const focusNode = (node: PositionedWorkflowNode) => {
    setFocusedNodeId(node.id);
    setDossierTab("overview");
  };
  const focusedNode = graph.nodes.find((node) => node.id === focusedNodeId) ?? graph.nodes[0] ?? null;
  const focusedIncoming = focusedNode ? graph.edges.filter((edge) => edge.toNodeId === focusedNode.id).length : 0;
  const focusedOutgoing = focusedNode ? graph.edges.filter((edge) => edge.fromNodeId === focusedNode.id).length : 0;
  return <section className="view relay-grid-view" aria-labelledby="workflow-title">
    <div className="breadcrumb"><button onClick={onBack}>Mission Control</button><span>/</span><b>{run.workflow_id ?? run.run_id}</b></div>
    <header className="dossier-head relay-head"><div><div className="title-line"><h1 id="workflow-title" className="dossier-title">{run.workflow_id ?? "Planning run"}</h1><Pill status={run.status} /></div><p className="mono">Flow ID {run.run_id} · started {new Date(run.submitted_at).toLocaleString()}</p></div><div className="d-kpis"><Kpi label="Evidence" value={run.artifacts.length} /><Kpi label="Stages" value={graph.nodes.length} /><Kpi label="Gate" value={run.active_gate ?? "none"} /><Kpi label="Scope" value={run.project_id} /></div></header>
    {graph.nodes.length === 0 ? <section className="lifecycle-unavailable" role="status">No authoritative lifecycle graph is available for this run yet.</section> : visualizing ? <CompactTopology graph={graph} focusedNodeId={focusedNodeId} onFocus={focusNode} onLifecycle={() => setVisualizing(false)} /> : <LifecycleRail nodes={graph.nodes} focusedNodeId={focusedNodeId} onFocus={focusNode} onVisualize={() => setVisualizing(true)} />}
    {focusedNode && <StageInspector node={focusedNode} incoming={focusedIncoming} outgoing={focusedOutgoing} collapsed={inspectorCollapsed} onToggle={() => setInspectorCollapsed((value) => !value)} />}
    {focusedNode && <EmbeddedStageDossier client={client} run={run} node={focusedNode} edges={graph.edges} timeline={timeline} tab={dossierTab} setTab={setDossierTab} onRefresh={onRefresh} decisionNotice={decisionNotice} onDecisionComplete={onDecisionComplete} />}
    {focusedNode?.id === "plan_approval" && run.active_gate !== "plan" && <McpCapabilityEvidence run={run} />}
  </section>;
}

function NodeDossier({ client, run, node, edges, timeline, tab, setTab, onBack, onCanvas, onRefresh, decisionNotice, onDecisionComplete }: { client: ApiClient; run: Run; node: PositionedWorkflowNode; edges: WorkflowEdge[]; timeline: TimelineEvent[]; tab: NodeDossierTab; setTab: (tab: NodeDossierTab) => void; onBack: () => void; onCanvas: () => void; onRefresh: () => Promise<void | boolean>; decisionNotice: string | null; onDecisionComplete: () => void }) {
  const tabs: Array<{ id: NodeDossierTab; label: string }> = [{ id: "overview", label: "Overview" }, { id: "audit", label: "Audit activity" }, { id: "specifications", label: "Specifications" }, { id: "configuration", label: "Configuration" }, { id: "dependencies", label: "Dependencies" }, { id: "history", label: "History" }];
  const graph = graphFor(run); const connectedIds = edges.filter((edge) => edge.fromNodeId === node.id || edge.toNodeId === node.id).flatMap((edge) => [edge.fromNodeId, edge.toNodeId]).filter((id) => id !== node.id); const dependencies = graph.nodes.filter((item) => connectedIds.includes(item.id));
  const events = relatedEvents({ stage_id: node.id, label: node.name, state: node.status as Stage["state"], availability: node.availability, reason: node.reason, artifact_kind: node.artifactKind }, timeline);
  return <section className="view dossier-view relay-dossier" aria-labelledby="node-title"><div className="breadcrumb"><button onClick={onBack}>Mission Control</button><span>/</span><button onClick={onCanvas}>{run.workflow_id ?? run.run_id}</button><span>/</span><b>{node.name}</b></div><header className="dossier-head"><div><div className="title-line"><h1 id="node-title" className="dossier-title">{node.name}</h1><Pill status={node.status} /></div><p className="mono">{node.id} · {node.type} · {node.availability}</p></div><div className="d-kpis"><Kpi label="Evidence" value={node.artifactKind ? 1 : "—"} /><Kpi label="State" value={statusLabel(node.status)} /><Kpi label="Links" value={dependencies.length} /></div></header><div className="subtabs" role="tablist" aria-label="Node dossier views">{tabs.map((item) => <button key={item.id} className="subtab" role="tab" aria-selected={tab === item.id} onClick={() => setTab(item.id)}>{item.label}</button>)}</div><div className="dossier-content">{decisionNotice && <p className="sync-row" role="status">{decisionNotice}</p>}{tab === "overview" && <><div className="dossier-grid"><section className="card dossier-summary"><p className="eyebrow">Authoritative node context</p><p className="dossier-description">{node.reason}</p><div className="dossier-details"><div><span>Node type</span><b>{node.type}</b></div><div><span>State source</span><b>{node.availability}</b></div><div><span>Evidence</span><b>{node.artifactKind ?? "Unavailable"}</b></div><div><span>Workflow scope</span><b>{run.project_id}</b></div></div></section><section className="card dossier-events"><h2 className="panel-title">Recent events</h2>{events.length ? <div className="timeline">{events.map((event) => <div className="tl-item" key={event.event_id}><i /><span><b>{statusLabel(event.event_type)}</b><small>{new Date(event.occurred_at).toLocaleString()}</small></span></div>)}</div> : <p className="control-note">No persisted events are attributable to this node.</p>}</section></div>{node.id === "product_specification" && <ProductSpecificationControls client={client} run={run} onComplete={onRefresh} />}{node.id === "plan_approval" && run.active_gate !== "plan" && <McpCapabilityEvidence run={run} />}{node.id === `${run.active_gate}_approval` && <DecisionControls client={client} run={run} onComplete={onRefresh} onSuccess={onDecisionComplete} />}</>}{tab === "audit" && <section className="card log-card"><h2 className="panel-title">Authoritative audit activity</h2><p className="control-note">This view contains durable lifecycle and approval events, not raw agent output.</p>{events.length ? events.map((event) => <p key={event.event_id}><span>{new Date(event.occurred_at).toLocaleTimeString()}</span> <b>[{event.gate ?? node.type}]</b> {statusLabel(event.event_type)}</p>) : <p className="control-note">No authoritative audit activity is available for this node.</p>}</section>}{tab === "specifications" && (node.artifactKind ? <EvidenceViewer client={client} run={run} initial={node.artifactKind} stageId={node.id} /> : <section className="card"><h2 className="panel-title">Verified specification and evidence</h2><p className="control-note">No immutable evidence is available for this node.</p></section>)}{tab === "configuration" && <section className="card"><h2 className="panel-title">Configuration</h2><pre className="codeblock" aria-label="Node configuration">{JSON.stringify({ node_id: node.id, type: node.type, state_source: node.availability, evidence_kind: node.artifactKind }, null, 2)}</pre></section>}{tab === "dependencies" && <section className="dependency-list">{dependencies.length ? dependencies.map((dependency) => <div key={dependency.id}><span><b>{dependency.name}</b><small>{dependency.type}</small></span><Pill status={dependency.status} /></div>) : <p className="control-note">This node has no persisted graph dependencies.</p>}</section>}{tab === "history" && <section className="card"><h2 className="panel-title">History</h2>{events.length ? <div className="timeline">{events.map((event) => <div className="tl-item" key={event.event_id}><i /><span><b>{statusLabel(event.event_type)}</b><small>{new Date(event.occurred_at).toLocaleString()} · {event.delivered ? "delivered" : "pending delivery"}</small></span></div>)}</div> : <p className="control-note">No persisted history is available for this node.</p>}</section>}</div></section>;
}

function UnavailableRun({ onBack, entity = "Run" }: { onBack: () => void; entity?: "Run" | "Node" }) { const isNode = entity === "Node"; return <section className="view mission-view" aria-labelledby="run-unavailable-title"><header className="flow-header"><div><h1 id="run-unavailable-title">{entity} unavailable</h1><p>{isNode ? "This node is not available in the current authoritative workflow graph." : "This run is unavailable or outside your authorized project scope."}</p></div></header><button className="refresh-button" onClick={onBack}>{isNode ? "Return to Workflow Canvas" : "Return to Mission Control"}</button></section>; }

function Detail({ client, run, tab, setTab, timeline, timelineMessage, onBack, onRefresh, decisionNotice, onDecisionComplete }: { client: ApiClient; run: Run; tab: DetailTab; setTab: (tab: DetailTab) => void; timeline: TimelineEvent[]; timelineMessage: string; onBack: () => void; onRefresh: () => Promise<void | boolean>; decisionNotice: string | null; onDecisionComplete: () => void }) {
  const openEvidence = (kind: Artifact["kind"]) => setTab(kind === "plan" ? "plan" : "artifacts");
  return <section className="view dossier-view" aria-labelledby="run-title"><div className="breadcrumb"><button onClick={onBack}>Mission Control</button><span>/</span><b>{run.run_id}</b></div><header className="dossier-head"><div><div className="title-line"><h1 id="run-title" className="dossier-title">Run detail</h1><Pill status={run.status} /></div><p className="mono">{run.workflow_id ?? "Workflow identity unavailable"} · submitted {new Date(run.submitted_at).toLocaleString()}</p></div><div className="d-kpis"><Kpi label="Gate" value={run.active_gate ?? "none"} /><Kpi label="Scope" value={run.project_id} /></div></header><div className="tabs" role="tablist" aria-label="Run detail views">{tabs.map((item) => <button key={item.id} role="tab" aria-selected={tab === item.id} onClick={() => setTab(item.id)}>{item.label}</button>)}</div><div className="dossier-content">{decisionNotice && <p className="sync-row" role="status">{decisionNotice}</p>}{tab === "summary" && <div className="dossier-grid"><section className="card dossier-summary"><p className="eyebrow">Authoritative run context</p><div className="dossier-details"><div><span>Run status</span><b>{statusLabel(run.status)}</b></div><div><span>Workflow identity</span><b className="mono">{run.workflow_id ?? "Not available"}</b></div><div><span>Active gate</span><b>{run.active_gate ?? "None"}</b></div><div><span>Artifacts</span><b>{run.artifacts.length} verified</b></div></div></section><section className="card"><h2 className="panel-title">Available views</h2><div className="timeline">{run.artifacts.map((artifact) => <button className="tl-item evidence-event" key={artifact.kind} onClick={() => openEvidence(artifact.kind)}><i /><span><b>{artifact.kind} evidence</b><small>{artifact.sha256.slice(0, 12)}</small></span></button>)}</div></section></div>}{tab === "workflow" && <WorkflowMap run={run} timeline={timeline} onEvidence={openEvidence} />}{tab === "timeline" && <><p className="sync-row" role="status">{timelineMessage}</p><Timeline events={timeline} /></>}{tab === "artifacts" && <EvidenceViewer client={client} run={run} />}{tab === "plan" && <EvidenceViewer client={client} run={run} initial="plan" />}{tab === "execution" && <section className="card"><h2 className="panel-title">Execution summary</h2>{run.execution ? <dl><dt>Phases</dt><dd>{run.execution.succeeded_phase_count} passed / {run.execution.failed_phase_count} failed / {run.execution.phase_count} recorded</dd><dt>Verification</dt><dd>{run.execution.verification_passed} passed / {run.execution.verification_failed} failed</dd><dt>Actual cost</dt><dd>{run.budget.actual_cost_usd === null ? "Unavailable" : `$${run.budget.actual_cost_usd.toFixed(2)}`}</dd><dt>Turns used</dt><dd>{run.budget.turns_used ?? "Unavailable"}</dd></dl> : <p className="control-note">Execution facts are unavailable until verified implementation evidence is recorded.</p>}</section>}{tab === "review" && <section className="card"><h2 className="panel-title">Review and validation</h2>{run.execution ? <dl><dt>Review</dt><dd>{run.execution.review_status ?? "Unavailable"}</dd><dt>Validation</dt><dd>{run.execution.validation_status ?? "Unavailable"}</dd></dl> : <p className="control-note">Classified review and validation facts are unavailable.</p>}</section>}{tab === "approvals" && <><section className="card"><h2 className="panel-title">Immutable approval history</h2>{run.approval_history_available ? run.approval_history.length ? <div className="timeline">{run.approval_history.map((approval) => <div className="tl-item" key={approval.decision_id}><i /><span><b>{approval.gate} {approval.decision}</b><small>{approval.actor_id} · {new Date(approval.created_at).toLocaleString()} · {approval.artifact_sha256.slice(0, 12)}</small></span><Pill status={approval.delivered ? "delivered" : "pending"} /></div>)}</div> : <p className="control-note">No operator decisions have been recorded.</p> : <p className="control-note">Approval history is available only to approvers.</p>}{run.external_links.length > 0 && <div className="external-links">{run.external_links.map((link) => <a key={`${link.kind}:${link.url}`} href={link.url} target="_blank" rel="noopener noreferrer">{link.label}</a>)}</div>}</section><McpCapabilityEvidence run={run} />{run.active_gate && <DecisionControls client={client} run={run} onComplete={onRefresh} onSuccess={onDecisionComplete} />}</>}</div></section>;
}

function routeFor(run: Run, tab: DetailTab) { return `/runs/${encodeURIComponent(run.run_id)}/${tab}`; }
function canvasRoute(run: Run) { return `/workflows/${encodeURIComponent(run.run_id)}`; }
function nodeRoute(run: Run, nodeId: string, tab: NodeDossierTab) { return `/workflows/${encodeURIComponent(run.run_id)}/nodes/${encodeURIComponent(nodeId)}/${tab}`; }
function readRoute(): RouteState {
  if (window.location.pathname === "/agents") return { runId: null, nodeId: null, nodeTab: "overview", tab: "summary", view: "mission", agents: true, agentProjectId: new URLSearchParams(window.location.search).get("project_id") };
  const node = window.location.pathname.match(/^\/workflows\/([^/]+)\/nodes\/([^/]+)\/(overview|audit|specifications|configuration|dependencies|history)$/);
  if (node) return { runId: decodeURIComponent(node[1]), nodeId: decodeURIComponent(node[2]), nodeTab: node[3] as NodeDossierTab, tab: "summary", view: "node", agents: false, agentProjectId: null };
  const canvas = window.location.pathname.match(/^\/workflows\/([^/]+)$/);
  if (canvas) return { runId: decodeURIComponent(canvas[1]), nodeId: null, nodeTab: "overview", tab: "summary", view: "canvas", agents: false, agentProjectId: null };
  const legacy = window.location.pathname.match(/^\/runs\/([^/]+)\/(summary|workflow|timeline|artifacts|plan|execution|review|approvals)$/);
  return { runId: legacy ? decodeURIComponent(legacy[1]) : null, nodeId: null, nodeTab: "overview", tab: (legacy?.[2] as DetailTab | undefined) ?? "summary", view: legacy ? "legacy" : "mission", agents: false, agentProjectId: null };
}

export function App({ client = apiClient }: { client?: ApiClient }) {
  const initialRoute = readRoute();
  const [runs, setRuns] = useState<Run[]>([]); const [projects, setProjects] = useState<Project[]>([]); const [projectsLoaded, setProjectsLoaded] = useState(false); const [selectedProject, setSelectedProject] = useState<string | undefined>(initialRoute.agentProjectId ?? undefined);
  const [surface, setSurface] = useState<"mission" | "agents">(initialRoute.agents ? "agents" : "mission");
  const [selected, setSelected] = useState<Run | null>(null); const [tab, setTabState] = useState<DetailTab>(initialRoute.tab); const [routeRunId, setRouteRunId] = useState<string | null>(initialRoute.runId); const [routeView, setRouteView] = useState<WorkflowView>(initialRoute.view); const [nodeId, setNodeId] = useState<string | null>(initialRoute.nodeId); const [nodeTab, setNodeTab] = useState<NodeDossierTab>(initialRoute.nodeTab); const [routeUnavailable, setRouteUnavailable] = useState(false); const [timeline, setTimeline] = useState<TimelineEvent[]>([]); const [timelineRunId, setTimelineRunId] = useState<string | null>(null); const [timelineMessage, setTimelineMessage] = useState("Timeline has not been refreshed yet.");
  const [error, setError] = useState<string | null>(null); const [syncMessage, setSyncMessage] = useState("Authoritative state has not been refreshed yet."); const [refreshing, setRefreshing] = useState(false); const [health, setHealth] = useState<Health>("checking"); const [theme, setTheme] = useState<Theme>(readStoredTheme); const [decisionNotice, setDecisionNotice] = useState<string | null>(null);
  const generation = useRef(0); const request = useRef<AbortController | null>(null); const routeRunIdRef = useRef<string | null>(initialRoute.runId); const listEtags = useRef(new Map<string, string>()); const timelineEtags = useRef(new Map<string, string>()); const timelineCache = useRef(new Map<string, TimelineEvent[]>()); const timelineGeneration = useRef(0); const detailGeneration = useRef(0); const detailRequest = useRef<AbortController | null>(null);
  const refresh = useCallback(async () => { if (!projectsLoaded) { setSyncMessage("Project inventory is unavailable; no run request was sent."); return; } const current = ++generation.current; request.current?.abort(); const controller = new AbortController(); request.current = controller; setRefreshing(true); try { const key = selectedProject ?? "*"; const result = await client.listRuns({ projectId: selectedProject, etag: listEtags.current.get(key), signal: controller.signal }); if (current !== generation.current) return; if (!result.unchanged) { setRuns(result.runs); setSelected((previous) => result.runs.find((run) => run.run_id === (routeRunIdRef.current ?? previous?.run_id)) ?? null); setSyncMessage(`Authoritative state updated at ${new Date().toLocaleTimeString()}.`); } else setSyncMessage(`Authoritative state unchanged at ${new Date().toLocaleTimeString()}.`); if (result.etag) listEtags.current.set(key, result.etag); setError(null); setHealth("connected"); } catch (reason) { if (!(reason instanceof DOMException && reason.name === "AbortError") && current === generation.current) { setError(reason instanceof Error ? reason.message : "Run inventory is temporarily unavailable."); setSyncMessage("Authoritative refresh failed; showing the last verified inventory."); setHealth("unavailable"); } } finally { if (current === generation.current) setRefreshing(false); } }, [client, projectsLoaded, selectedProject]);
  const refreshDetail = useCallback(async (runId: string, reportFailure = false): Promise<boolean> => { const current = ++detailGeneration.current; detailRequest.current?.abort(); const controller = new AbortController(); detailRequest.current = controller; try { const detail = await client.getRun(runId, controller.signal); if (current !== detailGeneration.current) return false; setSelected((previous) => previous?.run_id === detail.run_id ? detail : previous); return true; } catch (reason) { if (!(reason instanceof DOMException && reason.name === "AbortError") && reportFailure && current === detailGeneration.current) setError("Unable to load the latest scoped run detail; showing the last verified summary."); return false; } }, [client]);
  const refreshTimeline = useCallback(async (runId: string) => { const current = ++timelineGeneration.current; try { const result = await client.getTimeline(runId, { etag: timelineEtags.current.get(runId) }); if (current !== timelineGeneration.current) return; if (!result.unchanged) { timelineCache.current.set(runId, result.events); setTimeline(result.events); setTimelineMessage(`Timeline updated at ${new Date().toLocaleTimeString()}.`); } else { setTimeline(timelineCache.current.get(runId) ?? []); setTimelineMessage("Timeline unchanged."); } setTimelineRunId(runId); if (result.etag) timelineEtags.current.set(runId, result.etag); } catch { if (current === timelineGeneration.current) setTimelineMessage("Timeline is temporarily unavailable; showing the last verified events."); } }, [client]);
  useEffect(() => { const controller = new AbortController(); void client.listProjects(controller.signal).then((items) => { setProjects(items); setSelectedProject((current) => current && items.some((item) => item.project_id === current) ? current : items.length === 1 ? items[0].project_id : undefined); setProjectsLoaded(true); }).catch(() => { setError("Unable to load authorized project inventory."); setHealth("unavailable"); }); void client.getHealth(controller.signal).then((ok) => setHealth(ok ? "connected" : "unavailable")).catch(() => setHealth("unavailable")); return () => controller.abort(); }, [client]);
  useEffect(() => { if (projectsLoaded) void refresh(); }, [projectsLoaded, refresh]);
  useEffect(() => { if (!projectsLoaded || !routeRunId || selected?.run_id === routeRunId) return; let cancelled = false; void client.getRun(routeRunId).then((detail) => { if (!cancelled) { setRouteUnavailable(false); setSelected(detail); } }).catch(() => { if (!cancelled) setRouteUnavailable(true); }); return () => { cancelled = true; }; }, [client, projectsLoaded, routeRunId, selected?.run_id]);
  useEffect(() => { if (!projectsLoaded || selected) return; const timer = window.setInterval(() => void refresh(), AUTHORITATIVE_REFRESH_MS); return () => window.clearInterval(timer); }, [projectsLoaded, refresh, selected]);
  useEffect(() => { if (!selected) return; void refreshDetail(selected.run_id, true); void refreshTimeline(selected.run_id); const timer = window.setInterval(() => { void refreshDetail(selected.run_id); void refreshTimeline(selected.run_id); }, AUTHORITATIVE_REFRESH_MS); return () => { window.clearInterval(timer); detailRequest.current?.abort(); }; }, [refreshDetail, refreshTimeline, selected?.run_id]);
  useEffect(() => { try { window.localStorage.setItem("workbench-theme", theme); } catch { /* preference storage is optional */ } }, [theme]);
  useEffect(() => { const listener = () => { const current = readRoute(); routeRunIdRef.current = current.runId; setRouteRunId(current.runId); setRouteView(current.view); setNodeId(current.nodeId); setNodeTab(current.nodeTab); setTabState(current.tab); if (current.agents && current.agentProjectId) setSelectedProject(current.agentProjectId); setSurface(current.agents ? "agents" : "mission"); }; window.addEventListener("popstate", listener); return () => window.removeEventListener("popstate", listener); }, []);
  const openCanvas = (run: Run) => { setDecisionNotice(null); setRouteUnavailable(false); routeRunIdRef.current = run.run_id; setSelected(run); setRouteRunId(run.run_id); setRouteView("canvas"); setNodeId(null); window.history.pushState({}, "", canvasRoute(run)); };
  const openInvocationWorkflow = (flow: AgentInvocation) => { setDecisionNotice(null); setRouteUnavailable(false); routeRunIdRef.current = flow.root_run_id; setSelected(runs.find((run) => run.run_id === flow.root_run_id) ?? null); setRouteRunId(flow.root_run_id); setRouteView("canvas"); setNodeId(null); setSurface("mission"); window.history.pushState({}, "", `/workflows/${encodeURIComponent(flow.root_run_id)}`); };
  const openAgentCatalog = () => { detailRequest.current?.abort(); setRouteUnavailable(false); routeRunIdRef.current = null; setRouteRunId(null); setRouteView("mission"); setNodeId(null); setSelected(null); setSurface("agents"); const projectQuery = selectedProject ? `?project_id=${encodeURIComponent(selectedProject)}` : ""; window.history.pushState({}, "", `/agents${projectQuery}`); };
  const selectProject = (projectId: string | undefined) => { setSelectedProject(projectId); if (surface === "agents") { const projectQuery = projectId ? `?project_id=${encodeURIComponent(projectId)}` : ""; window.history.replaceState({}, "", `/agents${projectQuery}`); } };
  const setTab = (nextTab: DetailTab) => { setTabState(nextTab); if (selected) window.history.pushState({}, "", routeFor(selected, nextTab)); };
  const setDossierTab = (nextTab: NodeDossierTab) => { setNodeTab(nextTab); if (selected && nodeId) window.history.pushState({}, "", nodeRoute(selected, nodeId, nextTab)); };
  const backToCanvas = () => { if (!selected) return; setRouteView("canvas"); setNodeId(null); window.history.pushState({}, "", canvasRoute(selected)); };
  const back = () => { window.history.pushState({}, "", "/"); setRouteUnavailable(false); routeRunIdRef.current = null; setRouteRunId(null); setRouteView("mission"); setNodeId(null); setSelected(null); };
  const selectedRun = selected ?? runs.find((run) => run.run_id === routeRunId) ?? null;
  const refreshSelected = useCallback(async (): Promise<boolean> => { if (!selectedRun) return false; const refreshed = await refreshDetail(selectedRun.run_id, true); if (refreshed) void refreshTimeline(selectedRun.run_id); return refreshed; }, [refreshDetail, refreshTimeline, selectedRun]);
  const graph = selectedRun ? graphFor(selectedRun) : null;
  const selectedNode = graph?.nodes.find((node) => node.id === nodeId) ?? null;
  const content = useMemo(() => surface === "agents" ? <AgentOperations client={client} projectId={selectedProject} onOpenWorkflow={openInvocationWorkflow} /> : selectedRun && routeView === "canvas" ? <WorkflowCanvas client={client} run={selectedRun} timeline={timelineRunId === selectedRun.run_id ? timeline : []} onBack={back} onRefresh={refreshSelected} decisionNotice={decisionNotice} onDecisionComplete={() => setDecisionNotice("Decision accepted; canonical state has been refreshed.")} /> : selectedRun && routeView === "node" && selectedNode && graph ? <NodeDossier client={client} run={selectedRun} node={selectedNode} edges={graph.edges} timeline={timelineRunId === selectedRun.run_id ? timeline : []} tab={nodeTab} setTab={setDossierTab} onBack={back} onCanvas={backToCanvas} onRefresh={refreshSelected} decisionNotice={decisionNotice} onDecisionComplete={() => setDecisionNotice("Decision accepted; canonical state has been refreshed.")} /> : selectedRun && routeView === "node" ? <UnavailableRun onBack={backToCanvas} entity="Node" /> : selectedRun && routeView === "legacy" ? <Detail client={client} run={selectedRun} tab={tab} setTab={setTab} timeline={timelineRunId === selectedRun.run_id ? timeline : []} timelineMessage={timelineRunId === selectedRun.run_id ? timelineMessage : "Loading scoped timeline…"} onBack={back} onRefresh={refreshSelected} decisionNotice={decisionNotice} onDecisionComplete={() => setDecisionNotice("Decision accepted; canonical state has been refreshed.")} /> : routeRunId && routeUnavailable ? <UnavailableRun onBack={back} /> : <MissionControl runs={runs} onOpen={openCanvas} refresh={refresh} refreshing={refreshing} syncMessage={syncMessage} />, [back, backToCanvas, client, decisionNotice, graph, nodeTab, openInvocationWorkflow, refreshSelected, routeRunId, routeUnavailable, routeView, runs, selectedNode, selectedProject, selectedRun, setDossierTab, surface, syncMessage, tab, timeline, timelineMessage, timelineRunId]);
  return <main className="app-shell" data-theme={theme}><Sidebar projects={projects} selectedProject={selectedProject} setSelectedProject={selectProject} health={health} theme={theme} setTheme={setTheme} activeNav={surface === "mission" ? "mission" : "agents"} onRuns={() => { setSurface("mission"); back(); }} onAgents={openAgentCatalog} /><div className="main-content">{error && <p className="app-error" role="alert">{error}</p>}{content}</div></main>;
}
