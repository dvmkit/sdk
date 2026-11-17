export interface TempoCloseStressReport {
  success: boolean;
  testResults: {
    assertionResults: {
      fullName: string;
      status: string;
      failureMessages?: string[];
    }[];
  }[];
}

export const CLOSE_TEST: string;

export function assertTempoCloseReport(
  report: TempoCloseStressReport,
  options?: { negativeControl?: boolean }
): void;
