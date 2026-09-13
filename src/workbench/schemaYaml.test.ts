import { renderSchemaYaml } from "./schemaYaml";

describe("renderSchemaYaml", () => {
  test("wraps a submitted specification in a stable schema composition", () => {
    const sha256 = "a".repeat(64);
    const rendered = renderSchemaYaml(JSON.stringify({ schema_version: "v1", title: "Scaffold a uv project", workflow_context: { repositories: ["https://github.com/crmagz/cogito-kind-e2e-fixture"] } }), { kind: "source", sha256 });

    expect(rendered).toBe(`apiVersion: "cogito.dev/v1"\nkind: "SubmittedSpecification"\nmetadata:\n  artifactSha256: "${sha256}"\n  schemaVersion: "v1"\nspec:\n  title: "Scaffold a uv project"\n  workflow_context:\n    repositories:\n      - "https://github.com/crmagz/cogito-kind-e2e-fixture"`);
  });

  test("identifies a product specification and its selected revision", () => {
    const rendered = renderSchemaYaml('{"requirement_ids":["freq_7"],"gates":[{"kind":"approval"}]}', { kind: "product_specification", sha256: "b".repeat(64) }, 3);

    expect(rendered).toContain('kind: "ProductSpecification"');
    expect(rendered).toContain("  revision: 3");
    expect(rendered).toContain("  requirement_ids:");
    expect(rendered).toContain('      kind: "approval"');
  });

  test("labels the operator-facing contract as a Work Specification", () => {
    const rendered = renderSchemaYaml('{"requirement_ids":["freq_7"]}', { kind: "work_specification", sha256: "c".repeat(64) }, 3);

    expect(rendered).toContain('kind: "WorkSpecification"');
    expect(rendered).toContain("  revision: 3");
  });

  test("projects the submitted Work Specification without exposing its internal intake envelope", () => {
    const contract = JSON.stringify({
      schema_version: "cogito.initial-specification/v1",
      constraints: { max_cost_usd: 50 },
      work_specification: {
        schema_version: 2,
        title: "Validate Work Specification",
        user_story: "As a product manager, I need one readable contract.",
        outcome: "The contract is reviewable.",
        acceptance_criteria: ["The Work Specification is displayed directly."],
        technical_context: [],
        repository_candidates: []
      },
      workflow_context: { template_ref: "software_delivery@1.0.0", policy_ref: "platform_standard@1.0.0" }
    });
    const rendered = renderSchemaYaml(JSON.stringify({ initial_specification: contract }), { kind: "work_specification", sha256: "f".repeat(64) }, 0);

    expect(rendered).toContain('kind: "WorkSpecification"');
    expect(rendered).toContain('workflowTemplateRef: "software_delivery@1.0.0"');
    expect(rendered).toContain('workflowPolicyRef: "platform_standard@1.0.0"');
    expect(rendered).toContain('  title: "Validate Work Specification"');
    expect(rendered).not.toContain("initial_specification:");
    expect(rendered).not.toContain("work_specification:");
    expect(rendered).not.toContain("constraints:");
  });

  test("unwraps the persisted source-artifact envelope for the YAML composition", () => {
    const contract = JSON.stringify({ schema_version: "cogito.initial-specification/v1", goal: "Scaffold a uv project", repositories: [{ ref: "https://github.com/crmagz/cogito-kind-e2e-fixture.git#abc" }] });
    const rendered = renderSchemaYaml(JSON.stringify({ initial_specification: contract }), { kind: "source", sha256: "d".repeat(64) });

    expect(rendered).toContain('schemaVersion: "cogito.initial-specification/v1"');
    expect(rendered).toContain("  goal: \"Scaffold a uv project\"");
    expect(rendered).not.toContain("initial_specification:");
  });

  test("declines malformed or non-object evidence", () => {
    expect(renderSchemaYaml("not json", { kind: "source", sha256: "c".repeat(64) })).toBeNull();
    expect(renderSchemaYaml("[]", { kind: "source", sha256: "c".repeat(64) })).toBeNull();
  });

  test("quotes strings that YAML would otherwise resolve to another type", () => {
    const rendered = renderSchemaYaml(
      JSON.stringify({ goal: "2026-08-23", numeric_text: "12e3", legacy_boolean: "on" }),
      { kind: "source", sha256: "e".repeat(64) },
    );

    expect(rendered).toContain('  goal: "2026-08-23"');
    expect(rendered).toContain('  numeric_text: "12e3"');
    expect(rendered).toContain('  legacy_boolean: "on"');
  });
});
