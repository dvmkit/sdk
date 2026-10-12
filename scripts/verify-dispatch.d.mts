export interface VerificationStep {
  name: string;
  args: string[];
  skip?: string;
}

export interface VerificationDispatchOptions {
  cleanSource: boolean;
  requireDatabase: boolean;
  databaseUrl: string | undefined;
  packedSafetyReport: string | undefined;
  run: (step: VerificationStep) => void;
}

export function dispatchVerification(options: VerificationDispatchOptions): VerificationStep[];
export function assertReleaseDispatch(
  dispatch: (options: VerificationDispatchOptions) => unknown
): void;
