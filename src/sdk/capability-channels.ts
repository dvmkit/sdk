import type { CapabilityChannel, CapabilityDescriptor } from "./types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyCapabilityDescriptor = CapabilityDescriptor<any, any>;

/** The descriptor maps the lookup reads; a `DVMDescriptor` satisfies it. */
export interface ChannelCapabilityMaps {
  readonly capabilities: Readonly<Record<string, AnyCapabilityDescriptor>>;
  readonly x402Capabilities?: Readonly<Record<string, AnyCapabilityDescriptor>>;
}

/**
 * The definition that serves capability `name` on `channel`, or `undefined`
 * when none is offered there. Names are unique within a channel, so the
 * dvmkit protocol and x402 may each resolve the same name to a different
 * definition.
 */
export function capabilityForChannel(
  descriptor: ChannelCapabilityMaps,
  name: string,
  channel: CapabilityChannel
): AnyCapabilityDescriptor | undefined {
  const map = channel === "job" ? descriptor.capabilities : descriptor.x402Capabilities;
  // Own keys only, so a name like "constructor" never resolves to a prototype member.
  if (!map || !Object.hasOwn(map, name)) return undefined;
  return map[name];
}
