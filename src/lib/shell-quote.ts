/** Quote one argument for safe copy/paste into a POSIX shell command. */
export function shellQuoteArg(value: string): string {
  if (value === "") return "''";
  if (SAFE_VALUE_RE.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

// Values containing only these characters are safe to emit unquoted in a
// POSIX shell. Everything else gets single-quote wrapping so metacharacters
// survive copy/paste as one literal argument.
const SAFE_VALUE_RE = /^[a-zA-Z0-9_\-./@:=,+%]+$/;
