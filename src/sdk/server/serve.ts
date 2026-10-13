import type { DVMDescriptor, ZodLike } from "../types";
import { createDVMHost, type DVMServeResult, type DVMHostOpts } from "./host";

/** Single-DVM host. Use createDVMHost for multiple mounts with distinct prefixes. */
export async function serve<State, InputSchema extends ZodLike | undefined = undefined>(
  descriptor: DVMDescriptor<State, InputSchema>,
  opts?: DVMHostOpts
): Promise<DVMServeResult> {
  const host = createDVMHost(opts);
  host.mount(descriptor);
  return host.serve();
}
