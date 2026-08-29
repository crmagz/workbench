import type { Artifact } from "./client";

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

function isRecord(value: unknown): value is { [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function yamlKey(key: string) {
  return /^[A-Za-z_][A-Za-z0-9_-]*$/.test(key) ? key : JSON.stringify(key);
}

function yamlScalar(value: null | boolean | number | string) {
  if (value === null) return "null";
  // JSON strings can look like YAML timestamps, numbers, or YAML 1.1
  // booleans. Quote every string so this read-only projection round-trips
  // without changing the authoritative JSON contract's value types.
  if (typeof value === "string") return JSON.stringify(value);
  return String(value);
}

function yamlLines(value: JsonValue, depth = 0): string[] {
  const indent = " ".repeat(depth);
  if (!Array.isArray(value) && !isRecord(value)) return [`${indent}${yamlScalar(value)}`];
  if (Array.isArray(value)) {
    if (value.length === 0) return [`${indent}[]`];
    return value.flatMap((item) => {
      if (!Array.isArray(item) && !isRecord(item)) return [`${indent}- ${yamlScalar(item)}`];
      return [`${indent}-`, ...yamlLines(item, depth + 2)];
    });
  }
  const entries = Object.entries(value);
  if (entries.length === 0) return [`${indent}{}`];
  return entries.flatMap(([key, item]) => {
    if (!Array.isArray(item) && !isRecord(item)) return [`${indent}${yamlKey(key)}: ${yamlScalar(item)}`];
    return [`${indent}${yamlKey(key)}:`, ...yamlLines(item, depth + 2)];
  });
}

function sourceContract(value: { [key: string]: JsonValue }) {
  if (Object.keys(value).length !== 1 || typeof value.initial_specification !== "string") return value;
  try {
    const parsed: unknown = JSON.parse(value.initial_specification);
    return isRecord(parsed) ? parsed : value;
  } catch {
    return value;
  }
}

/**
 * Produces a stable, read-only schema envelope for an authoritative JSON artifact.
 * The underlying artifact is never transformed or re-submitted from this representation.
 */
export function renderSchemaYaml(content: string, artifact: Pick<Artifact, "kind" | "sha256">, revision?: number | null) {
  try {
    const parsed: unknown = JSON.parse(content);
    if (!isRecord(parsed) && !Array.isArray(parsed)) return null;
    if (artifact.kind === "plan") return yamlLines(parsed).join("\n");
    if (!isRecord(parsed)) return null;
    const contract = artifact.kind === "source" ? sourceContract(parsed) : parsed;
    const { schema_version: schemaVersion, ...specification } = contract;
    const metadata: { [key: string]: JsonValue } = { artifactSha256: artifact.sha256 };
    if (schemaVersion !== undefined) metadata.schemaVersion = schemaVersion;
    if (artifact.kind === "product_specification" && revision !== null && revision !== undefined) metadata.revision = revision;
    const composition: JsonValue = {
      apiVersion: "cogito.dev/v1",
      kind: artifact.kind === "source" ? "SubmittedSpecification" : "ProductSpecification",
      metadata,
      spec: specification
    };
    return yamlLines(composition).join("\n");
  } catch {
    return null;
  }
}
