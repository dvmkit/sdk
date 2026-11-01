import { SimplePool } from "nostr-tools/pool";
import { expect, vi } from "vitest";

import type { Nip47Stub } from "./nip47-stub";

/** Drop an established socket immediately before the real relay publishes. */
export function closeNextNwcPublish(wallet: Nip47Stub): void {
  const ensureRelay = SimplePool.prototype.ensureRelay;
  let armed = true;
  vi.spyOn(SimplePool.prototype, "ensureRelay").mockImplementation(async function (this: SimplePool, url, params) {
    const relay = await ensureRelay.call(this, url, params);
    if (armed) {
      armed = false;
      const publish = relay.publish;
      vi.spyOn(relay, "publish").mockImplementationOnce(async function (event) {
        wallet.setFault({ mode: "relay-down" });
        await vi.waitFor(() => expect(relay.connected).toBe(false), { interval: 5 });
        return publish.call(relay, event);
      });
    }
    return relay;
  });
}
