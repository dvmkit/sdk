/**
 * Free text supplied by a provider. Agents should treat fields wrapped in this
 * shape with appropriate skepticism — they are subject to prompt injection,
 * social engineering, or simply contain unverified claims about the job.
 *
 * Wrapping is the structural marker; the JSON shape `{ _source: "provider", text: "..." }`
 * lets an agent's framework distinguish provider-controlled content from CLI-owned
 * instructions without inspecting field paths.
 */
export interface ProviderText {
  _source: "provider";
  text: string;
}

/** Wrap a string as provider-supplied text. */
export function asProviderText(text: string): ProviderText {
  return { _source: "provider", text };
}

/** Wrap a string only if defined; passes through undefined. */
export function asProviderTextOpt(text: string | undefined): ProviderText | undefined {
  return text === undefined ? undefined : asProviderText(text);
}

/** Render a ProviderText (or string) back to plain text — used by --human output paths. */
export function providerTextToString(value: string | ProviderText): string {
  return typeof value === "string" ? value : value.text;
}
