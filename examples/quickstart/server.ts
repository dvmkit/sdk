import { serve } from "@dvmkit/sdk/server";

import dvm from "./handler.ts";

const server = await serve(dvm, { devMode: true });

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    void server.close().then(() => process.exit(0));
  });
}
