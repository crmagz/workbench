# Cogito Operator Workbench

An evidence-first, project-scoped operator console for Cogito. It presents a
filterable Runs inbox, deep-linkable run detail, an authoritative lifecycle
timeline, digest-bound evidence and approval views, and append-only
immutable review context. Review context is non-executable: it is scoped to one
server-owned stage and immutable artifact digest, and does not change a workflow
or instruct an agent. It is deliberately not a chat client and it does not
directly access object storage or Temporal.

## Local development

The Node relay is the only component that reads `COGITO_UPSTREAM_TOKEN`; it
forwards a small allowlist of Workbench API requests and never sends that token
to browser JavaScript. Copy `.env.example` into a local, untracked `.env` and
point it at a locally forwarded development API:

```sh
kubectl --context kind-cogito-observability -n cogito port-forward service/cogito-api 8000:8000
npm ci
npm run dev
```

Set `COGITO_UPSTREAM_TOKEN` only in the ignored `.env` file or server process
environment. The Vite development server mounts the same relay as `npm run
serve`, so browser requests to `/api/cogito` remain same-origin and the token
never enters browser code or the production build.

To serve a built application through the development relay, run `npm run build`
then `npm run serve`. Production startup intentionally fails until a real OIDC
session relay is configured. Do not use a static upstream token in production.

## Container and Helm deployment

The repository includes a non-root Node image and the `chart/` Helm chart.
Production deployment requires Helm 4, an immutable image digest and release
tag, TLS, an
explicit session-relay readiness endpoint, and least-privilege NetworkPolicy
rules. The chart rejects incomplete production settings during rendering. It
only accepts `relay.mode=session`, which forwards same-origin browser requests
to an environment-owned OIDC session relay; it never accepts an API token in
production.

Install Helm 4 (the project validates with Helm 4.2.3) and copy the production
example to a protected environment-specific values file. Replace all blank and
`.example.invalid` placeholders, including the ingress certificate, trusted
ingress source, session relay, DNS, and monitoring selectors:

```sh
cp chart/values-production.example.yaml /secure/path/workbench-production.yaml

helm upgrade --install workbench chart/ \
  --namespace cogito --create-namespace \
  -f chart/values.yaml -f chart/values-production.yaml \
  -f /secure/path/workbench-production.yaml \
  --server-side=true --rollback-on-failure --wait --timeout 10m
```

Run `helm test workbench --namespace cogito` after deployment. The test
requires the NetworkPolicy to allow its labelled test Pod and DNS to reach the
service. Enable the optional `serviceMonitor` only in clusters that have the
Prometheus Operator CRD; it scrapes `/metrics` for relay response counts.

The Forge callable Node workflow builds and publishes this image on `main` to
`ghcr.io/crmagz/workbench` for both `linux/amd64` and `linux/arm64`.
It uses the repository-scoped ephemeral GitHub token with package publishing
permission rather than AWS credentials. Forge is also the sole release
authority: it calculates semantic versions, creates the `workbench/v*` tag, and
creates GitHub releases. The old repository-specific release workflow was
removed to prevent competing tag/release pipelines.

For local Kind validation only, the ignored `.claude/Makefile` builds the image,
loads it into Kind, deploys a static-token relay that reads the existing cluster
secret, and forwards the Workbench on port 8001:

```sh
make -f .claude/Makefile deploy
make -f .claude/Makefile port-forward
```

Open `http://127.0.0.1:8001`. The static-token mode is rejected when
`global.production=true` and must not be used outside local development.
The local Makefile requires Helm 4 and is intentionally ignored because it
contains local cluster wiring, not deployable production configuration.

## Validation

```sh
npm run typecheck
npm test
npm run build
npm run lint
```

Tests are native Jest component and HTTP-integration tests. The reusable Forge
workflow runs the same locked install, build, lint, typecheck, and test steps;
the callable Helm workflow validates this chart with Helm 4 and strict
Kubernetes schemas, then builds, installs, and runs `helm test` in an
ephemeral Kind cluster. Forge owns image publication and release creation.

## Browser E2E

The hermetic browser suite starts the built Workbench with a constrained local
relay and a deterministic upstream fixture. It covers scoped inventory,
deep-link reload, timeline rendering, verified evidence, digest-bound review context, approval feedback,
and the persisted post-decision state:

```sh
npm run test:e2e
```

The opt-in Kind browser test remains in the repository test suite rather than
in an operator script. Its read-only path requires a locally forwarded API, a
non-production development token, and the identifier of an existing scoped
run. A separate mutable path requires a disposable run that is awaiting *plan*
approval and the exact plan-artifact digest; it verifies the displayed evidence
before submitting a decision. It is read-only unless
`COGITO_KIND_E2E_DECISION` is set:

```sh
COGITO_KIND_E2E=1 \
COGITO_E2E_UPSTREAM_URL=http://127.0.0.1:8000 \
COGITO_E2E_UPSTREAM_TOKEN=<development-token> \
COGITO_E2E_RUN_ID=<run-id> \
npm run test:e2e:kind
```

To exercise the waiting-gate acceptance path, use a disposable run and set all
of the following in addition to the upstream values:

```sh
COGITO_KIND_E2E=1 \
COGITO_E2E_WAITING_PLAN_RUN_ID=<waiting-plan-run-id> \
COGITO_E2E_PLAN_SHA256=<64-hex-plan-digest> \
COGITO_KIND_E2E_DECISION=request_revision \
npm run test:e2e:kind
```

Use a separate terminal for the local API forwarding command shown above. The
test never reads cluster credentials or passes the relay token to browser
JavaScript. The mutable command requests a revision and therefore changes the
specified disposable run.

To validate the governed MCP approval cockpit, use a different disposable run
whose waiting plan has server-pinned MCP grants. This action explicitly records
an empty MCP selection, so the run may proceed into implementation. The test
verifies the rendered approval evidence, submits the selection through the
deployed Workbench, and confirms that the API records `selected_grants: []`:

```sh
COGITO_KIND_E2E=1 \
COGITO_E2E_MCP_WAITING_PLAN_RUN_ID=<mcp-pinned-waiting-plan-run-id> \
COGITO_E2E_MCP_PLAN_SHA256=<64-hex-plan-digest> \
COGITO_KIND_E2E_DECISION=approve_no_mcp \
npm run test:e2e:kind
```
