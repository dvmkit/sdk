import type ts from "typescript";

export interface SurfaceEntry {
  export: string;
  declaration: string;
  names: string[];
  signatures?: Record<string, { stability: string; signature: string }>;
}

export const publicEntryPoints: string[];
export function readStability(root: string, entryPoint: string): Map<string, string>;
export function inspectDeclaration(root: string, declaration: string, program?: ts.Program): { checker: ts.TypeChecker; symbols: ts.Symbol[] };
export function signatureOf(exported: ts.Symbol, checker: ts.TypeChecker): string;
export function inspectSurface(root: string, manifest: { exports: Record<string, { types: string }> }): SurfaceEntry[];
export function hasBreakingMarker(changelog: string, version: string, baselineVersion: string): boolean;
export function validateBaseline(baseline: unknown, packageName: string): void;
