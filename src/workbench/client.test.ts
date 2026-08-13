import { apiClient, type Run } from "./client";
import { jest } from "@jest/globals";

const run: Run = {
  run_id: "run-123",
  project_id: "default",
  status: "awaiting_plan_approval",
  submitted_at: "2026-07-26T00:00:00Z",
  workflow_id: "workflow-123",
  active_gate: "plan",
  artifacts: [{ kind: "plan", sha256: "a".repeat(64) }],
  stages: [],
  abilities: ["view", "approve"],
  workflow: ["planning", "plan_approval"],
  budget: { max_cost_usd: 3, max_wall_clock_minutes: 45, max_review_rounds: 2, actual_cost_usd: null, turns_used: null },
  approval_history_available: true,
  approval_history: [],
  execution: null,
  external_links: []
};

test("submits the exact displayed digest to the authoritative action route", async () => {
  const fetchMock = jest.fn<(url: string, options: RequestInit) => Promise<Response>>(async () => (
    { ok: true, status: 202, json: async () => ({ decision_id: "decision-1" }) } as Response
  ));
  global.fetch = fetchMock as unknown as typeof fetch;

  await apiClient.decide(run, "approve");

  expect(fetchMock).toHaveBeenCalledWith(
    "/api/cogito/api/v1/coordination/runs/run-123/actions/plan",
    expect.objectContaining({ method: "POST", headers: expect.objectContaining({ "Idempotency-Key": expect.any(String) }) })
  );
  const [, options] = fetchMock.mock.calls[0]!;
  expect(JSON.parse(options.body as string)).toMatchObject({ decision: "approve", artifact_sha256: "a".repeat(64) });
});

test("does not claim success after a stale authoritative conflict", async () => {
  global.fetch = jest.fn(async () => ({ ok: false, status: 409 })) as unknown as typeof fetch;

  await expect(apiClient.decide(run, "approve")).rejects.toThrow("409");
});

test("reuses the idempotency key after an ambiguous transport failure", async () => {
  const fetchMock = jest
    .fn<(url: string, options: RequestInit) => Promise<Response>>()
    .mockRejectedValueOnce(new Error("network interrupted"))
    .mockResolvedValueOnce({ ok: true, status: 202, json: async () => ({}) } as Response);
  global.fetch = fetchMock as unknown as typeof fetch;

  await expect(apiClient.decide(run, "approve")).rejects.toThrow("network interrupted");
  await apiClient.decide(run, "approve");

  expect(fetchMock.mock.calls[0]![1].headers).toEqual(fetchMock.mock.calls[1]![1].headers);
});

test("reuses the feedback idempotency key after an ambiguous transport failure", async () => {
  const fetchMock = jest
    .fn<(url: string, options: RequestInit) => Promise<Response>>()
    .mockRejectedValueOnce(new Error("network interrupted"))
    .mockResolvedValueOnce({ ok: true, status: 202, json: async () => ({ feedback_id: "feedback-1" }) } as Response);
  global.fetch = fetchMock as unknown as typeof fetch;

  await expect(apiClient.recordFeedback(run, run.artifacts[0]!, "plan_approval", "Clarify rollback.")).rejects.toThrow("network interrupted");
  await apiClient.recordFeedback(run, run.artifacts[0]!, "plan_approval", "Clarify rollback.");

  expect(fetchMock.mock.calls[0]![1].headers).toEqual(fetchMock.mock.calls[1]![1].headers);
});

test("reuses the revision idempotency key after an ambiguous transport failure", async () => {
  const specificationRun: Run = { ...run, product_specification_revision: 1, artifacts: [{ kind: "product_specification", sha256: "b".repeat(64) }] };
  const fetchMock = jest
    .fn<(url: string, options: RequestInit) => Promise<Response>>()
    .mockRejectedValueOnce(new Error("network interrupted"))
    .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({}) } as Response);
  global.fetch = fetchMock as unknown as typeof fetch;

  const parent = { revision: 1, artifactSha256: "b".repeat(64) };
  await expect(apiClient.reviseProductSpecification(specificationRun, parent, { title: "reviewed" })).rejects.toThrow("interrupted");
  await apiClient.reviseProductSpecification(specificationRun, parent, { title: "reviewed" });

  expect(fetchMock.mock.calls[0]![1].headers).toEqual(fetchMock.mock.calls[1]![1].headers);
  expect(JSON.parse(fetchMock.mock.calls[1]![1].body as string)).toMatchObject({
    expected_product_specification_revision: 1,
    parent_artifact_sha256: "b".repeat(64), specification: { title: "reviewed" }
  });
});

test("reuses the revision idempotency key when a successful response body is interrupted", async () => {
  const specificationRun: Run = { ...run, product_specification_revision: 2, artifacts: [{ kind: "product_specification", sha256: "c".repeat(64) }] };
  const parent = { revision: 1, artifactSha256: "b".repeat(64) };
  const fetchMock = jest
    .fn<(url: string, options: RequestInit) => Promise<Response>>()
    .mockResolvedValueOnce({ ok: true, status: 200, json: async () => { throw new Error("truncated"); } } as unknown as Response)
    .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({}) } as Response);
  global.fetch = fetchMock as unknown as typeof fetch;

  await expect(apiClient.reviseProductSpecification(specificationRun, parent, { title: "reviewed" })).rejects.toThrow("retry safely");
  await apiClient.reviseProductSpecification(specificationRun, parent, { title: "reviewed" });

  expect(fetchMock.mock.calls[0]![1].headers).toEqual(fetchMock.mock.calls[1]![1].headers);
});

test("reuses the revision idempotency key after an ambiguous relay timeout", async () => {
  const parent = { revision: 1, artifactSha256: "b".repeat(64) };
  const fetchMock = jest
    .fn<(url: string, options: RequestInit) => Promise<Response>>()
    .mockResolvedValueOnce({ ok: false, status: 504 } as Response)
    .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({}) } as Response);
  global.fetch = fetchMock as unknown as typeof fetch;

  await expect(apiClient.reviseProductSpecification(run, parent, { title: "reviewed" })).rejects.toThrow("504");
  await apiClient.reviseProductSpecification(run, parent, { title: "reviewed" });

  expect(fetchMock.mock.calls[0]![1].headers).toEqual(fetchMock.mock.calls[1]![1].headers);
});

test("binds a revision submission to the immutable parent captured by the editor", async () => {
  const laterRun: Run = { ...run, product_specification_revision: 2, artifacts: [{ kind: "product_specification", sha256: "c".repeat(64) }] };
  const fetchMock = jest.fn<(url: string, options: RequestInit) => Promise<Response>>(async () => ({ ok: true, status: 200, json: async () => ({}) } as Response));
  global.fetch = fetchMock as unknown as typeof fetch;

  await apiClient.reviseProductSpecification(laterRun, { revision: 1, artifactSha256: "b".repeat(64) }, { title: "reviewed" });

  expect(JSON.parse(fetchMock.mock.calls[0]![1].body as string)).toMatchObject({
    expected_product_specification_revision: 1,
    parent_artifact_sha256: "b".repeat(64)
  });
});

test("rejects an oversized revision before sending it to the relay", async () => {
  const fetchMock = jest.fn<(url: string, options: RequestInit) => Promise<Response>>();
  global.fetch = fetchMock as unknown as typeof fetch;

  await expect(apiClient.reviseProductSpecification(run, { revision: 1, artifactSha256: "b".repeat(64) }, { text: "x".repeat(100_000) })).rejects.toThrow("96 KiB");

  expect(fetchMock).not.toHaveBeenCalled();
});

test("sends ETags and cancellation signals on authoritative refreshes", async () => {
  const fetchMock = jest.fn<(url: string, options: RequestInit) => Promise<Response>>(async () => (
    {
      ok: true,
      status: 200,
      headers: { get: (name: string) => name.toLowerCase() === "etag" ? '"next"' : null },
      json: async () => ({ items: [], revision: "next" })
    } as Response
  ));
  global.fetch = fetchMock as unknown as typeof fetch;
  const controller = new AbortController();

  await apiClient.listRuns({ etag: '"previous"', signal: controller.signal });

  expect(fetchMock).toHaveBeenCalledWith(
    "/api/cogito/api/v1/workbench/runs",
    expect.objectContaining({ headers: { "If-None-Match": '"previous"' }, signal: controller.signal })
  );
});

test("retains the cached ETag when a 304 response omits one", async () => {
  global.fetch = jest.fn(async () => (
    { ok: false, status: 304, headers: { get: () => null } } as unknown as Response
  )) as unknown as typeof fetch;

  await expect(apiClient.listRuns({ etag: '"cached"' })).resolves.toEqual({
    runs: [], revision: '"cached"', etag: '"cached"', unchanged: true
  });
});

test("lists only relay-provided projects and checks relay health", async () => {
  const fetchMock = jest
    .fn<(url: string, options?: RequestInit) => Promise<Response>>()
    .mockResolvedValueOnce({ ok: true, json: async () => ({ items: [{ project_id: "alpha" }] }) } as Response)
    .mockResolvedValueOnce({ ok: true } as Response);
  global.fetch = fetchMock as unknown as typeof fetch;

  await expect(apiClient.listProjects()).resolves.toEqual([{ project_id: "alpha" }]);
  await expect(apiClient.getHealth()).resolves.toBe(true);
  expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/cogito/api/v1/workbench/projects", { signal: undefined });
  expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/cogito/healthz", { signal: undefined });
});

test("URL-encodes evidence digests", async () => {
  const fetchMock = jest.fn(async () => ({ ok: true, status: 200, json: async () => ({ content: "{}" }) } as Response));
  global.fetch = fetchMock as unknown as typeof fetch;

  await apiClient.getEvidence("run/123", { kind: "plan", sha256: "digest&extra=value" });

  expect(fetchMock).toHaveBeenCalledWith(
    "/api/cogito/api/v1/workbench/runs/run%2F123/evidence/plan?artifact_sha256=digest%26extra%3Dvalue"
  );
});

test("loads one scoped workflow detail through the fixed relay route", async () => {
  const fetchMock = jest.fn(async () => ({ ok: true, status: 200, json: async () => run } as Response));
  global.fetch = fetchMock as unknown as typeof fetch;

  await expect(apiClient.getRun("run/123")).resolves.toEqual(run);

  expect(fetchMock).toHaveBeenCalledWith("/api/cogito/api/v1/workbench/runs/run%2F123", { signal: undefined });
});

test("loads the fixed scoped timeline route and retains a matching ETag", async () => {
  const fetchMock = jest.fn(async () => (
    { ok: false, status: 304, headers: { get: () => null } } as unknown as Response
  ));
  global.fetch = fetchMock as unknown as typeof fetch;

  await expect(apiClient.getTimeline("run/123", { etag: '"timeline"' })).resolves.toEqual({
    events: [], revision: '"timeline"', etag: '"timeline"', unchanged: true
  });
  expect(fetchMock).toHaveBeenCalledWith(
    "/api/cogito/api/v1/workbench/runs/run%2F123/timeline",
    { headers: { "If-None-Match": '"timeline"' }, signal: undefined }
  );
});
