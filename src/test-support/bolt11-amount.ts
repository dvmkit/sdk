/** Read the millisatoshi amount from the human-readable part of a BOLT-11 invoice. */
export function bolt11AmountMsats(bolt11: string): number | null {
  const trimmed = bolt11.trim();
  const separator = trimmed.lastIndexOf("1");
  if (separator <= 0) return null;
  const match = /^ln(?:bcrt|bc|tbs|tb|sb)(\d+)([munp])?$/i.exec(trimmed.slice(0, separator));
  if (!match) return null;
  const digits = Number(match[1]);
  if (!Number.isFinite(digits)) return null;
  switch ((match[2] as string | undefined)?.toLowerCase() ?? "") {
    case "m":
      return digits * 1e8;
    case "u":
      return digits * 1e5;
    case "n":
      return digits * 1e2;
    case "p":
      return Math.round(digits / 10);
    default:
      return digits * 1e11;
  }
}
