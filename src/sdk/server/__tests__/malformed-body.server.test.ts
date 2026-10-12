import { afterEach, describe, expect, it } from "vitest";

import { configureDVM } from "../../configure";
import { createDVMHost } from "../host";

describe("malformed request body", () => {
  let server: { url: string; close: () => Promise<void> } | undefined;

  afterEach(async () => {
    if (server) {
      await server.close();
      server = undefined;
    }
  });

  async function startHost(): Promise<string> {
    const dvm = configureDVM({
      name: "guard-test",
      capability: "echo",
      tag: "test",
      onJob(ctx) {
        ctx.complete("ok");
      },
    });
    const host = createDVMHost({ devMode: true, port: 0, env: {} });
    host.mount(dvm);
    server = await host.serve();
    return server.url;
  }

  interface ErrorBody {
    error: string;
    message: string;
    hint: string;
  }

  it.each([
    ["POST /v1/job", (url: string) => `${url}/v1/job`],
    ["POST /v1/quote", (url: string) => `${url}/v1/quote`],
  ])("returns 400 with invalid_request on empty body to %s", async (_, path) => {
    const url = await startHost();
    const res = await fetch(path(url), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrorBody;
    expect(body.error).toBe("invalid_request");
    expect(body.message).toContain("valid JSON");
    expect(body.hint).toContain("/v1/info");
  });

  // `/v1/credit` guards the same way but points at its own request
  // shape rather than `/v1/info` — `/v1/info` describes capabilities, which
  // tells a caller nothing about how to word a top-up.
  it.each([
    ["empty body", undefined],
    ["malformed JSON", "{not-json"],
  ])("returns 400 with invalid_request on %s to POST /v1/credit", async (_, payload) => {
    const url = await startHost();
    const res = await fetch(`${url}/v1/credit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payload,
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrorBody;
    expect(body.error).toBe("invalid_request");
    expect(body.message).toContain("valid JSON");
    expect(body.hint).toContain('"op"');
  });

  it("returns 400 with invalid_request on malformed JSON to POST /v1/job", async () => {
    const url = await startHost();
    const res = await fetch(`${url}/v1/job`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not-json",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrorBody;
    expect(body.error).toBe("invalid_request");
  });

});
