# Workbench context

Workbench is the project-scoped, browser-facing operator console for Cogito.
It reads through an allow-listed same-origin relay and treats Cogito's run
projection and mutation responses as authoritative. Browser code never receives
an upstream token, reads object storage, or talks directly to Temporal.

## Centralized workflow-specification workspace

The primary run-detail experience is a single workflow form rather than a
duplicated selected-stage dossier. It combines:

- the active phase and current operator instruction;
- compact **Specification** and **Product specification** artifact selectors,
  with their SHA-256 digests shown below;
- an always-expanded, syntax-highlighted JSON editor for the current product
  specification;
- the permitted gate controls: green **Approve**, blue **Needs refinement**,
  and red **Cancel**; and
- a centralized audit log containing lifecycle decisions and agent phase
  load/completion updates.

The workspace intentionally does not inline a separate verified-evidence
section. The existing plan and node-detail routes keep the complete immutable
evidence viewer for every artifact kind.

## Product-specification revisions

Editing the JSON opens a confirmation dialog before submitting a complete
replacement. Cogito validates the expected revision and parent artifact digest,
then creates a new immutable product-specification revision. The editor keeps
the exact text the operator entered, including whitespace, while adding syntax
highlighting behind the textarea.

The UI protects the operator from concurrent refreshes: requests are tied to
the artifact revision they loaded, a replaced artifact reconciles the selected
reference, and unsaved text is retained as a stale draft when a newer revision
arrives. A stale draft must be explicitly reloaded and cannot be confirmed.

## Workflow actions and auditability

Approve, refinement, and cancellation are server-authorized, digest-bound
workflow actions. Refinement and cancellation require a rationale. The UI
closes a successfully accepted confirmation even when the follow-up projection
is briefly eventually consistent, then shows the refreshed authoritative state.
Dialogs manage focus, trap keyboard navigation, and restore focus to their
initiating control.

The centralized audit log is a review surface, not an authority. Cogito keeps
the immutable evidence, decision record, and execution/outbox state. For the
full backend lifecycle contract, see Cogito's
[specification evaluation lifecycle guide](https://github.com/crmagz/cogito/blob/main/docs/specification-evaluation-lifecycle.md).

## Delivery state

The centralized single-form workflow workspace is proposed in
[Workbench PR #17](https://github.com/crmagz/workbench/pull/17). Its targeted
component tests cover legacy evidence views, current-artifact reconciliation,
revision loading and stale-draft guards, action confirmation behavior, and
dialog keyboard focus.
