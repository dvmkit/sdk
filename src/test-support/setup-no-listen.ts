/** Unit-suite only: fail any test that opens a listening socket, so a port-opening
 * test left in `npm test` breaks everywhere (CI included) rather than only on
 * machines that forbid binding. Such tests belong in `*.server.test.ts`.
 * Patching the prototype covers http, https and raw `net` servers alike. */

import { createRequire } from "node:module";

const LISTEN_GUARD_INSTALLED = Symbol.for("dvmkit.no-listen-guard");

// `createRequire`: an ES module namespace is frozen, while the CJS `net` export
// is the object every other module's `net.Server` resolves to.
const net = createRequire(import.meta.url)("node:net") as typeof import("node:net");
const proto = net.Server.prototype as unknown as Record<symbol, boolean | undefined>;

if (proto[LISTEN_GUARD_INSTALLED] !== true) {
  proto[LISTEN_GUARD_INSTALLED] = true;
  net.Server.prototype.listen = function listenBlockedInUnitTests(): never {
    throw new Error(
      "This test opened a listening socket, which the offline unit suite forbids. " +
        "Rename the file to *.server.test.ts so `npm run test:server` runs it."
    );
  } as typeof net.Server.prototype.listen;
}
