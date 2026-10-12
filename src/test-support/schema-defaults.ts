/**
 * Fill top-level JSON-Schema `default` values on a caller-supplied data
 * object.
 *
 * dvmkit-owned verification tooling, not caller implementation: the published
 * `@dvmkit/dvm-cli` carries its own copy of this normalization, and this one exists
 * so dvmkit's signed-bytes parity tests, the DVM auth/credit contract helper and
 * the acceptance/smoke harnesses can build exactly the payload a caller would
 * sign against a DVM that advertises defaults in its `/v1/info` input schema —
 * regardless of whether the schema lists those fields as `required` (Zod's
 * `toJSONSchema` output mode does, input mode doesn't). Keep it in step with the
 * caller's behaviour by re-reading the caller repo, never by editing both.
 *
 * Top-level only: walks `schema.properties` and fills keys missing from
 * `data`. Nested defaults inside object properties are not touched — none
 * of the first-party DVMs need that today, and a recursive walk would
 * tangle merge semantics for unions / oneOf / `additionalProperties`. If
 * a future DVM lands a nested default, extend here.
 *
 * Caller-supplied values always win, including falsy ones (`false`, `0`,
 * `""`, `null`) — `key in data` is the test, not truthiness.
 *
 * Returns a new object plus the map of defaults that were actually
 * applied, matching the shape the caller reports when it surfaces a
 * one-line "Applied defaults" hint.
 */
export function applyJsonSchemaDefaults(
  schema: Record<string, unknown> | undefined,
  data: Record<string, unknown>
): { data: Record<string, unknown>; applied: Record<string, unknown> } {
  const applied: Record<string, unknown> = {};
  if (!schema || typeof schema !== "object") return { data: { ...data }, applied };

  const properties = (schema as { properties?: unknown }).properties;
  if (!properties || typeof properties !== "object") return { data: { ...data }, applied };

  const merged: Record<string, unknown> = { ...data };
  for (const [key, propSchema] of Object.entries(properties as Record<string, unknown>)) {
    if (key in merged) continue;
    if (!propSchema || typeof propSchema !== "object") continue;
    if (!("default" in (propSchema as Record<string, unknown>))) continue;
    const defaultValue = (propSchema as { default: unknown }).default;
    merged[key] = defaultValue;
    applied[key] = defaultValue;
  }
  return { data: merged, applied };
}

/**
 * Format the `applied` map from {@link applyJsonSchemaDefaults} into a
 * compact one-line summary for `--human` mode (e.g.
 * `format="markdown", screenshot=false, cache_max_age=3600`). Empty
 * input yields the empty string — caller can branch on that.
 */
export function formatAppliedDefaults(applied: Record<string, unknown>): string {
  return Object.entries(applied)
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join(", ");
}
