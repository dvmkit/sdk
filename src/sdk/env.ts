export function envFlag(value: string | undefined): boolean {
  return value === "1" || value === "true";
}
