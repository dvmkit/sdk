import type { z } from "zod";

export interface HumanizedZodError {
  message: string;
  hint: string;
}

/**
 * Render a `ZodError` into the structured `{ message, hint }` fields used by
 * `/v1/job` and `/v1/quote` error envelopes.
 *
 * `message` is a single human-readable line (path: reason; …) that an agent
 * can relay to its caller, capped at {@link MAX_REPORTED_CLAUSES} clauses with
 * the remainder counted rather than printed. `hint` is the most actionable fix
 * derived from the issues — oversized string → chunking guidance, empty
 * required string → "provide non-empty text", everything else → a pointer at
 * `/v1/info`. The hint is picked over **every** issue, not just the clauses
 * that fit: a chunking hint is the one output that tells a caller what to
 * actually do, and losing it because the oversized field sorted fourth is the
 * same class of unhelpful answer this whole path exists to avoid.
 */
export function humanizeZodError(err: z.ZodError, opts: { schemaUrl: string }): HumanizedZodError {
  return humanizeZodIssues(err.issues, opts);
}

/**
 * {@link humanizeZodError} over a bare issue list.
 *
 * The signed-request auth gate reports a *subset* of a parse's
 * issues — the ones outside the signing envelope — so it has no `ZodError` to
 * hand over, only the slice it decided to disclose. Rendering it through the
 * same clause builder is what makes a schema violation read identically
 * whether the caller hit it on the 401 auth gate or the 400 input gate — which
 * is also why the clause cap lives here rather than at one of the two call
 * sites.
 */
export function humanizeZodIssues(
  issues: readonly z.core.$ZodIssue[],
  opts: { schemaUrl: string }
): HumanizedZodError {
  return { message: summariseIssues(issues), hint: pickHint(issues, opts.schemaUrl) };
}

/**
 * Read a Zod issue list off whatever `safeParse` put in its `error` slot.
 *
 * `ZodLike.safeParse` types that slot as `unknown` — deliberately, so the SDK's
 * duck-typed schema contract doesn't pin a zod version — and `instanceof
 * z.ZodError` is unsound the moment two copies of zod are resolved in one
 * process (a builder's own dependency alongside the SDK's). Duck-typing the
 * `issues` array is the same discipline `isZodSchema` already applies to the
 * schema itself. Returns `undefined` when the error carries no issue list, in
 * which case callers must fall back to a shape-free message.
 */
export function zodIssuesOf(error: unknown): readonly z.core.$ZodIssue[] | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const issues: unknown = (error as { issues?: unknown }).issues;
  return Array.isArray(issues) ? (issues as readonly z.core.$ZodIssue[]) : undefined;
}

/**
 * How many issue clauses reach `message`. A caller who got the shape wholly
 * wrong can produce dozens; the first few name the mistake, and the rest are a
 * wall of text an agent has to relay to a human. The overflow is counted rather
 * than dropped silently — a caller who fixes three fields and gets the same
 * error back needs to know there were more.
 */
const MAX_REPORTED_CLAUSES = 3;

function summariseIssues(issues: readonly z.core.$ZodIssue[]): string {
  if (issues.length === 0) return "Input validation failed";
  const line = issues.slice(0, MAX_REPORTED_CLAUSES).map(summariseIssue).join("; ");
  const overflow = issues.length - MAX_REPORTED_CLAUSES;
  return overflow > 0 ? `${line} (+${overflow.toString()} more)` : line;
}

function summariseIssue(issue: z.core.$ZodIssue): string {
  const path = formatPath(issue.path);
  const reason = describeReason(issue);
  return path ? `${path}: ${reason}` : reason;
}

function formatPath(path: readonly PropertyKey[]): string {
  if (path.length === 0) return "";
  return path
    .map((segment) => (typeof segment === "number" ? `[${segment.toString()}]` : String(segment)))
    .join(".");
}

function describeReason(issue: z.core.$ZodIssue): string {
  switch (issue.code) {
    case "too_big": {
      const max = issue.maximum.toString();
      if (issue.origin === "string") return `too long (max ${max} chars)`;
      if (issue.origin === "array" || issue.origin === "set") {
        return `too many items (max ${max})`;
      }
      return `value too large (max ${max})`;
    }
    case "too_small": {
      const min = issue.minimum.toString();
      if (issue.origin === "string") {
        return min === "1" ? "required" : `too short (min ${min} chars)`;
      }
      if (issue.origin === "array" || issue.origin === "set") {
        return min === "1" ? "required (must be non-empty)" : `too few items (min ${min})`;
      }
      return `value too small (min ${min})`;
    }
    case "invalid_type":
      return `expected ${issue.expected}`;
    case "invalid_value":
      return `must be one of: ${issue.values.map(String).join(", ")}`;
    case "invalid_format":
      return `invalid ${issue.format}`;
    case "unrecognized_keys":
      return `unrecognized field(s): ${issue.keys.join(", ")}`;
    case "not_multiple_of":
      return `must be a multiple of ${issue.divisor.toString()}`;
    case "invalid_union":
      return "no matching variant";
    case "custom":
    default:
      return issue.message || "invalid";
  }
}

function pickHint(issues: readonly z.core.$ZodIssue[], schemaUrl: string): string {
  const tooBigString = issues.find(
    (i): i is z.core.$ZodIssueTooBig => i.code === "too_big" && i.origin === "string"
  );
  if (tooBigString) {
    const path = formatPath(tooBigString.path);
    const field = path ? `\`${path}\` ` : "";
    return `Input field ${field}exceeds the ${tooBigString.maximum.toString()}-character limit. Split into smaller chunks and submit separately.`;
  }

  const tooSmallString = issues.find(
    (i): i is z.core.$ZodIssueTooSmall =>
      i.code === "too_small" && i.origin === "string" && i.minimum === 1
  );
  if (tooSmallString) {
    const path = formatPath(tooSmallString.path);
    const field = path ? `\`${path}\`` : "the required string field";
    return `Provide non-empty text in ${field}.`;
  }

  return `Inspect ${schemaUrl} for the expected input schema.`;
}
