import { readFileSync } from "node:fs";

import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import {
  CLIENT_COMPATIBILITY_HEADERS,
  clientCompatibilityAttributes,
  clientCompatibilityMiddleware,
  parseClientCompatibility,
  requireClientCompatibility,
} from "../client-compatibility";

interface FixtureCase {
  name: string;
  request_headers: Record<string, string>;
  valid: { client: boolean; protocol_version: boolean; capabilities: boolean };
  client_version?: string;
  protocol_version?: number;
  capabilities: string[];
  requirement?: {
    required_capabilities: string[];
    minimum_client_version?: string;
  };
  response?: { status: number; body: Record<string, unknown> };
}

const fixture = JSON.parse(
  readFileSync(
    new URL("../../../../protocol-fixtures/client-compatibility.json", import.meta.url),
    {
      encoding: "utf8",
    }
  )
) as { server_response_headers: Record<string, string>; cases: FixtureCase[] };

describe("client compatibility", () => {
  it.each(fixture.cases)("parses the portable $name fixture", (testCase) => {
    const parsed = parseClientCompatibility(new Headers(testCase.request_headers));
    expect(parsed.valid).toEqual({
      client: testCase.valid.client,
      protocolVersion: testCase.valid.protocol_version,
      capabilities: testCase.valid.capabilities,
    });
    expect(parsed.clientVersion?.version).toBe(testCase.client_version);
    expect(parsed.protocolVersion).toBe(testCase.protocol_version);
    expect(parsed.capabilities).toEqual(testCase.capabilities);
  });

  it("keeps absent headers permissive on an unaffected endpoint and advertises protocol v1", async () => {
    const app = new Hono();
    app.use("*", clientCompatibilityMiddleware());
    app.get("/unaffected", (c) => c.json({ ok: true }));

    const response = await app.request("/unaffected");
    expect(response.status).toBe(200);
    expect(response.headers.get(CLIENT_COMPATIBILITY_HEADERS.protocolVersion)).toBe(
      fixture.server_response_headers[CLIENT_COMPATIBILITY_HEADERS.protocolVersion]
    );
    expect(await response.json()).toEqual({ ok: true });
  });

  it("returns the fixture's 426 before an endpoint side effect", async () => {
    const testCase = fixture.cases.find((entry) => entry.name === "missing-capability");
    if (!testCase?.requirement || !testCase.response) throw new Error("fixture is incomplete");
    let sideEffects = 0;
    const app = new Hono();
    app.use("*", clientCompatibilityMiddleware());
    app.post(
      "/guarded",
      requireClientCompatibility({
        requiredCapabilities: testCase.requirement.required_capabilities,
        minimumClientVersion: testCase.requirement.minimum_client_version,
      }),
      (c) => {
        sideEffects += 1;
        return c.json({ ok: true });
      }
    );

    const response = await app.request("/guarded", {
      method: "POST",
      headers: testCase.request_headers,
    });
    expect(response.status).toBe(testCase.response.status);
    expect(response.headers.get(CLIENT_COMPATIBILITY_HEADERS.protocolVersion)).toBe(
      fixture.server_response_headers[CLIENT_COMPATIBILITY_HEADERS.protocolVersion]
    );
    expect(await response.json()).toEqual(testCase.response.body);
    expect(sideEffects).toBe(0);
  });

  it("does not let a spoofed high version bypass a capability requirement", async () => {
    let sideEffects = 0;
    const app = new Hono();
    app.use("*", clientCompatibilityMiddleware());
    app.post(
      "/guarded",
      requireClientCompatibility({
        requiredCapabilities: ["request-resume"],
        minimumClientVersion: "0.1.0",
      }),
      (c) => {
        sideEffects += 1;
        return c.json({ ok: true });
      }
    );

    const response = await app.request("/guarded", {
      method: "POST",
      headers: {
        "DVM-Client": "dvm/99.0.0",
        "DVM-Protocol-Version": "1",
        "DVM-Client-Capabilities": "credit-recovery",
      },
    });
    expect(response.status).toBe(426);
    expect(await response.json()).toMatchObject({ current_client_version: "99.0.0" });
    expect(sideEffects).toBe(0);
  });

  it.each([undefined, "dvm/latest", "other/99.0.0", "dvm/999999999999999999999.0.0"])(
    "does not let missing or malformed client version %s satisfy a minimum",
    async (client) => {
      const app = new Hono();
      app.use("*", clientCompatibilityMiddleware());
      app.post("/guarded", requireClientCompatibility({ minimumClientVersion: "0.1.0" }), (c) =>
        c.json({ ok: true })
      );
      const headers: Record<string, string> = {
        "DVM-Protocol-Version": "1",
        "DVM-Client-Capabilities": "request-resume",
      };
      if (client !== undefined) headers["DVM-Client"] = client;
      const response = await app.request("/guarded", { method: "POST", headers });
      expect(response.status).toBe(426);
      expect(await response.json()).not.toHaveProperty("current_client_version");
    }
  );

  it("returns both minimum and current versions when a valid client is too old", async () => {
    const app = new Hono();
    app.use("*", clientCompatibilityMiddleware());
    app.post("/guarded", requireClientCompatibility({ minimumClientVersion: "0.2.0" }), (c) =>
      c.json({ ok: true })
    );
    const response = await app.request("/guarded", {
      method: "POST",
      headers: { "DVM-Client": "dvm/0.1.9" },
    });
    expect(response.status).toBe(426);
    expect(await response.json()).toMatchObject({
      required_capabilities: [],
      minimum_client_version: "0.2.0",
      current_client_version: "0.1.9",
    });
  });

  it.each([
    ["dvm/1.0.0-rc.1", "1.0.0", 426],
    ["dvm/1.0.0-rc.2", "1.0.0-rc.10", 426],
    ["dvm/1.0.0-rc.10", "1.0.0-rc.2", 200],
  ] as const)(
    "orders client %s against minimum %s with status %i",
    async (client, minimumClientVersion, status) => {
      const app = new Hono();
      app.use("*", clientCompatibilityMiddleware());
      app.post("/guarded", requireClientCompatibility({ minimumClientVersion }), (c) =>
        c.json({ ok: true })
      );
      const response = await app.request("/guarded", {
        method: "POST",
        headers: { "DVM-Client": client },
      });
      expect(response.status).toBe(status);
    }
  );

  it.each(["", " ", "\t"])("rejects an invalid configured minimum %j", (minimumClientVersion) => {
    expect(() => requireClientCompatibility({ minimumClientVersion })).toThrow(
      "minimum client version must be a valid SemVer value"
    );
  });

  it("accepts a current client with every required capability", async () => {
    const app = new Hono();
    app.use("*", clientCompatibilityMiddleware());
    app.post(
      "/guarded",
      requireClientCompatibility({
        requiredCapabilities: ["request-resume", "credit-recovery"],
        minimumClientVersion: "0.1.0",
      }),
      (c) => c.json({ ok: true })
    );

    const response = await app.request("/guarded", {
      method: "POST",
      headers: fixture.cases.find((entry) => entry.name === "current")?.request_headers,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it.each([
    "request-resume,credit-recovery",
    "request-resume,request-resume",
    "credit-recovery, request-resume",
    "Not_Valid",
  ])("lets no invalid capability list satisfy a requirement: %s", async (capabilities) => {
    const app = new Hono();
    app.use("*", clientCompatibilityMiddleware());
    app.post(
      "/guarded",
      requireClientCompatibility({ requiredCapabilities: ["request-resume"] }),
      (c) => c.json({ ok: true })
    );
    const response = await app.request("/guarded", {
      method: "POST",
      headers: { "DVM-Client-Capabilities": capabilities },
    });
    expect(response.status).toBe(426);
  });

  it.each(["future-protocol", "malformed-version"])(
    "keeps $name metadata permissive on an unaffected endpoint",
    async (name) => {
      const testCase = fixture.cases.find((entry) => entry.name === name);
      if (!testCase) throw new Error("fixture is incomplete");
      const app = new Hono();
      app.use("*", clientCompatibilityMiddleware());
      app.get("/unaffected", (c) => c.json({ ok: true }));
      const response = await app.request("/unaffected", { headers: testCase.request_headers });
      expect(response.status).toBe(200);
    }
  );

  it("emits validated support fields as attributes rather than identity dimensions", () => {
    const testCase = fixture.cases.find((entry) => entry.name === "current");
    if (!testCase) throw new Error("fixture is incomplete");
    const attrs = clientCompatibilityAttributes(
      parseClientCompatibility(new Headers(testCase.request_headers))
    );
    expect(attrs).toEqual({
      "client.version": "0.1.0",
      "client.version_valid": true,
      "client.protocol_version": 1,
      "client.protocol_version_valid": true,
      "client.capabilities": ["credit-recovery", "request-resume"],
      "client.capabilities_valid": true,
    });
  });
});
