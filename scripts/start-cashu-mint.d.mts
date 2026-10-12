export const MINT_CONTAINER: string;
export const MINT_URL: string;

export interface StartCashuMintOptions {
  docker: (args: string[]) => number;
  probe: () => Promise<boolean>;
  wait: (ms: number) => Promise<void>;
  attempts?: number;
  intervalMs?: number;
}

export function startCashuMint(options: StartCashuMintOptions): Promise<void>;
