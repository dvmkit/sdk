import { it } from "vitest";

import { pinnedFetchScenarios, runPinnedFetchProbe } from "../../../test-support/pinned-fetch-probe-runner";

it.each(pinnedFetchScenarios)("closes upload streams and real sockets: %s", async (scenario) => {
  await runPinnedFetchProbe(scenario, true);
}, 15_000);
