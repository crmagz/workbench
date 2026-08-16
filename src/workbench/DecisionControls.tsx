import { useEffect, useRef, useState } from "react";

import { mcpSelectionKey, type ApiClient, type McpCapabilities, type McpToolSelection, type Run } from "./client";

function capabilityLabel(grant: McpToolSelection) {
  return `${grant.role}: ${grant.server_id}@${grant.server_version} / ${grant.tool_name}${grant.repository_scope ? ` / ${grant.repository_scope}` : ""}`;
}

function isDisplaySafeGrant(value: unknown): value is McpToolSelection {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const grant = value as Partial<McpToolSelection>;
  return [grant.role, grant.server_id, grant.server_version, grant.server_manifest_sha256, grant.tool_name, grant.input_schema_sha256]
    .every((field) => typeof field === "string" && field.length > 0)
    && (grant.repository_scope === undefined || grant.repository_scope === null || typeof grant.repository_scope === "string");
}

function isDisplaySafeCapabilities(value: McpCapabilities | null | undefined): value is McpCapabilities {
  if (!value) return false;
  if (!["awaiting_plan_approval", "approved", "not_applicable"].includes(value.state) || !Array.isArray(value.pinned_grants)
    || !value.pinned_grants.every(isDisplaySafeGrant) || ![true, false].includes(value.invocation_evidence_available)) return false;
  if (new Set(value.pinned_grants.map(mcpSelectionKey)).size !== value.pinned_grants.length) return false;
  if (value.selected_grants === null) return true;
  return Array.isArray(value.selected_grants)
    && value.selected_grants.every(isDisplaySafeGrant)
    && new Set(value.selected_grants.map(mcpSelectionKey)).size === value.selected_grants.length
    && value.selected_grants.every((grant) => value.pinned_grants.some((pin) => mcpSelectionKey(pin) === mcpSelectionKey(grant)));
}

export function McpCapabilityEvidence({ run }: { run: Run }) {
  const capabilities = run.mcp_capabilities;
  if (!isDisplaySafeCapabilities(capabilities) || !run.abilities.includes("approve") || capabilities.state === "not_applicable") return null;
  const selected = capabilities.selected_grants;
  return <section aria-label="Governed MCP capability evidence" className="mcp-capabilities">
    <h3>Governed MCP capabilities</h3>
    <p className="control-note">Inherited workflow authority. Server-pinned grants apply to eligible agents for this workflow; this surface cannot configure endpoints, invoke tools, or expand authority.</p>
    {capabilities.state === "approved" && <p className="mcp-selection-summary">{selected === null ? "All pinned capability grants were retained." : selected.length === 0 ? "No MCP tools were selected." : `${selected.length} recorded capability grant${selected.length === 1 ? "" : "s"}.`}</p>}
    <ul className="mcp-grant-list">
      {(selected ?? capabilities.pinned_grants).map((grant) => <li key={mcpSelectionKey(grant)}>{capabilityLabel(grant)}</li>)}
    </ul>
  </section>;
}

function trapDialogFocus(event: React.KeyboardEvent<HTMLElement>, close: () => void) {
  if (event.key === "Escape") { event.preventDefault(); close(); return; }
  if (event.key !== "Tab") return;
  const focusable = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("button:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])"));
  if (focusable.length === 0) return;
  const first = focusable[0]; const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
}

export function DecisionControls({ client, run, onComplete, onSuccess, workflowLabels = false }: { client: ApiClient; run: Run; onComplete: () => Promise<void | boolean>; onSuccess?: () => void; workflowLabels?: boolean }) {
  const [comment, setComment] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [pendingWorkflowDecision, setPendingWorkflowDecision] = useState<"reject" | "request_revision" | null>(null);
  const mounted = useRef(false);
  const workflowDialogRef = useRef<HTMLElement>(null);
  const workflowTriggerRef = useRef<HTMLButtonElement | null>(null);
  const artifact = run.active_gate ? run.artifacts.find((item) => item.kind === run.active_gate) : null;
  const capabilities = run.active_gate === "plan" && isDisplaySafeCapabilities(run.mcp_capabilities) ? run.mcp_capabilities : null;

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    if (!pendingWorkflowDecision) return;
    const previousFocus = workflowTriggerRef.current;
    workflowDialogRef.current?.querySelector<HTMLElement>("textarea:not([disabled]), button:not([disabled])")?.focus();
    return () => previousFocus?.focus();
  }, [pendingWorkflowDecision]);

  async function decide(decision: "approve" | "reject" | "request_revision") {
    if (decision !== "approve" && !comment.trim()) {
      setMessage("A rationale is required for this decision");
      return;
    }
    try {
      setPending(true);
      setMessage(null);
      await client.decide(run, decision, comment, decision === "approve" && capabilities ? null : undefined);
      if (workflowLabels) setPendingWorkflowDecision(null);
      const refreshed = await onComplete();
      if (refreshed === false) {
        if (mounted.current) setMessage("Decision accepted, but canonical state could not be refreshed.");
        return;
      }
      onSuccess?.();
    } catch (error) {
      if (error instanceof Error && error.message.includes("(409)")) {
        try {
          await onComplete();
        } catch {
          // The conflict is still surfaced below if a canonical refresh is temporarily unavailable.
        }
      }
      if (mounted.current) setMessage(error instanceof Error ? error.message : "Decision could not be submitted.");
    } finally {
      if (mounted.current) setPending(false);
    }
  }

  if (!run.active_gate || !run.abilities.includes("approve")) return null;
  if (run.active_gate === "plan" && capabilities?.state === "approved") return <McpCapabilityEvidence run={run} />;
  return (
    <section aria-label="Approval decision" className="decision-panel">
      <h3>{workflowLabels ? "Workflow decision" : `${run.active_gate} approval gate`}</h3>
      {!workflowLabels && <p className="decision-artifact">
        <span>Exact decision artifact SHA-256</span>
        <code aria-label={`Exact ${run.active_gate} decision artifact SHA-256`}>{artifact?.sha256 ?? "Unavailable"}</code>
      </p>}
      {!artifact && <p className="evidence-error" role="alert">The authoritative decision artifact is unavailable; no action can be submitted.</p>}
      {capabilities && <McpCapabilityEvidence run={run} />}
      {!workflowLabels && <label className="form-field" htmlFor="decision-comment"><span>Rationale for rejection or revision</span>
        <textarea className="form-textarea" id="decision-comment" value={comment} onChange={(event) => setComment(event.target.value)} />
      </label>}
      <div className="form-actions decision-actions">
        <button className={workflowLabels ? "button-success" : "button-primary"} disabled={pending || !artifact} onClick={() => void decide("approve")}>Approve</button>
        <button className="button-primary" disabled={pending || !artifact} onClick={(event) => { if (workflowLabels) { workflowTriggerRef.current = event.currentTarget; setPendingWorkflowDecision("request_revision"); } else void decide("request_revision"); }}>{workflowLabels ? "Needs refinement" : "Request revision"}</button>
        {workflowLabels ? <button className="button-danger" disabled={pending || !artifact} onClick={(event) => { workflowTriggerRef.current = event.currentTarget; setPendingWorkflowDecision("reject"); }}>Cancel</button> : <button className="button-secondary" disabled={pending || !artifact} onClick={() => void decide("reject")}>Reject</button>}
      </div>
      <p aria-live="polite">{message}</p>
      {workflowLabels && pendingWorkflowDecision && <div className="specification-edit-scrim" onMouseDown={() => !pending && setPendingWorkflowDecision(null)}><section ref={workflowDialogRef} className="specification-edit-dialog" role="dialog" aria-modal="true" aria-labelledby="workflow-decision-title" onMouseDown={(event) => event.stopPropagation()} onKeyDown={(event) => trapDialogFocus(event, () => !pending && setPendingWorkflowDecision(null))} tabIndex={-1}><h3 id="workflow-decision-title">{pendingWorkflowDecision === "reject" ? "Cancel workflow" : "Needs refinement"}</h3><p>Provide the durable rationale that will accompany this workflow decision.</p><label className="form-field" htmlFor="workflow-decision-comment"><span>Decision rationale</span><textarea className="form-textarea" id="workflow-decision-comment" value={comment} onChange={(event) => setComment(event.target.value)} /></label><div className="form-actions"><button className={pendingWorkflowDecision === "reject" ? "button-danger" : "button-primary"} disabled={pending || !artifact || !comment.trim()} onClick={() => void decide(pendingWorkflowDecision)}>{pendingWorkflowDecision === "reject" ? "Confirm cancel" : "Confirm refinement"}</button><button className="button-secondary" disabled={pending} onClick={() => setPendingWorkflowDecision(null)}>Keep editing</button></div></section></div>}
    </section>
  );
}
