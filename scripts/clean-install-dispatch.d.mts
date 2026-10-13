export interface CleanInstallDispatchOptions {
  requireDatabase: boolean;
  npm: (args: string[]) => void;
}

export function dispatchCleanInstall(options: CleanInstallDispatchOptions): void;
export function assertCleanInstallDispatch(
  dispatch: (options: CleanInstallDispatchOptions) => unknown
): void;
