import { Agent, get as httpGet } from "node:http";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { generateIdentity } from "../../../lib/builder-identity";
import { attestationEnv, signDeployAttestation } from "../../../test-support/deploy-attestation";
import { configureDVM } from "../../configure";
import { CLIENT_COMPATIBILITY_HEADERS } from "../client-compatibility";
import { createDVMHost } from "../host";
import { MemoryJobStore } from "../memory-job-store";
import { secp256k1Auth } from "../secp256k1-auth";
import { createSignedRequestVerifier } from "../signed-request";

describe("createDVMHost", () => {
  let server: { url: string; close: () => Promise<void> } | undefined;
  let priorDeployId: string | undefined;

  beforeEach(() => {
    priorDeployId = process.env.DVMKIT_DEPLOY_ID;
  });

  afterEach(async () => {
    if (server) {
      await server.close();
      server = undefined;
    }
    if (priorDeployId === undefined) delete process.env.DVMKIT_DEPLOY_ID;
    else process.env.DVMKIT_DEPLOY_ID = priorDeployId;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("does not fill an explicit empty host environment from process env", async () => {
    process.env.DVMKIT_DEPLOY_ID = "deploy-host-happy";
    const dvm = configureDVM({
      name: "host-happy",
      capability: "test",
      tag: "test",
      onJob(ctx) {
        ctx.complete("ok");
      }
    });

    const host = createDVMHost({ devMode: true, port: 0, env: {} });
    host.mount(dvm);
    server = await host.serve();

    const res = await fetch(`${server.url}/v1/info`);
    expect(res.status).toBe(200);
    const info = (await res.json()) as { name?: string; deploy_id?: string };
    expect(info.name).toBe("host-happy");
    expect(info.deploy_id).toBe("unknown");
  });

  it("does not warn about Cashu configuration outside an explicit host environment", async () => {
    vi.stubEnv("DVMKIT_CASHU_MINTS", "https://ambient-mint.example.com");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const host = createDVMHost({ devMode: true, port: 0, env: {} });
    host.mount(
      configureDVM({
        name: "empty-host-env",
        capability: "test",
        onJob(ctx) {
          ctx.complete("ok");
        }
      })
    );
    server = await host.serve();

    expect(warn.mock.calls.flat().map(String).join("\n")).not.toContain("cashu_opts_env_ignored");
  });

  it("uses process env when host env is omitted", async () => {
    process.env.DVMKIT_DEPLOY_ID = "deploy-host-default";
    const host = createDVMHost({ devMode: true, port: 0 });
    host.mount(
      configureDVM({
        name: "host-default-env",
        capability: "test",
        onJob(ctx) {
          ctx.complete("ok");
        }
      })
    );
    server = await host.serve();

    const info = (await (await fetch(`${server.url}/v1/info`)).json()) as {
      deploy_id?: string;
    };
    expect(info.deploy_id).toBe("deploy-host-default");
  });

  it("keeps identity, owner, provenance, and signed-request audience in the supplied host env", async () => {
    const suppliedBuilder = generateIdentity();
    const supplied = signDeployAttestation({
      builderSecret: suppliedBuilder.secret,
      builderPubkey: suppliedBuilder.pubkey,
      dvmId: "dvm-supplied",
      slug: "supplied-host",
      capabilities: ["test"]
    });
    const suppliedAttestation = supplied.payload;
    const ambientAttestation = {
      ...suppliedAttestation,
      dvm_id: "dvm-ambient",
      slug: "ambient-host",
      builder_pubkey: generateIdentity().pubkey
    };
    vi.stubEnv("GIT_SHA", "ambient-sha");
    vi.stubEnv("BUILD_TIME", "ambient-time");
    vi.stubEnv("DVMKIT_DEPLOY_ID", "ambient-deploy");
    vi.stubEnv("DVMKIT_BUILDER_PUBKEY", ambientAttestation.builder_pubkey);
    vi.stubEnv("DVMKIT_BUILDER_ATTESTATION", JSON.stringify(ambientAttestation));
    vi.stubEnv("DVMKIT_BUILDER_SIGNATURE", "e".repeat(128));
    vi.stubEnv("DVMKIT_OWNER_HANDLE", "ambient-owner");

    const host = createDVMHost({
      devMode: true,
      port: 0,
      env: {
        GIT_SHA: "supplied-sha",
        BUILD_TIME: "supplied-time",
        DVMKIT_DEPLOY_ID: "supplied-deploy",
        DVMKIT_BUILDER_PUBKEY: supplied.identityPubkey,
        DVMKIT_BUILDER_ATTESTATION: JSON.stringify(suppliedAttestation),
        DVMKIT_BUILDER_SIGNATURE: supplied.signature,
        DVMKIT_OWNER_HANDLE: "supplied-owner"
      }
    });
    host.mount(
      configureDVM({
        name: "supplied-host",
        capability: "test",
        auth: secp256k1Auth(),
        onJob(ctx) {
          ctx.complete("ok");
        }
      })
    );
    server = await host.serve();

    const info = (await (await fetch(`${server.url}/v1/info`)).json()) as {
      sdk_sha?: string;
      deploy_id?: string;
      builder?: { pubkey: string; attestation: typeof suppliedAttestation };
      owner?: { handle: string };
      auth_audience?: { dvm_id: string; builder_pubkey: string };
    };
    expect(info.sdk_sha).toBe("supplied-sha");
    expect(info.deploy_id).toBe("supplied-deploy");
    expect(info.builder).toMatchObject({
      pubkey: supplied.identityPubkey,
      attestation: suppliedAttestation
    });
    expect(info.owner).toMatchObject({ handle: "supplied-owner" });
    expect(info.auth_audience).toEqual({
      dvm_id: "dvm-supplied",
      builder_pubkey: supplied.identityPubkey
    });

    const healthz = (await (await fetch(`${server.url}/healthz`)).json()) as {
      gitSha: string;
      deployedAt: string;
      deployId: string;
    };
    expect(healthz).toMatchObject({
      gitSha: "supplie",
      deployedAt: "supplied-time",
      deployId: "supplied-deploy"
    });
  });

  it("keeps two live hosts isolated from each other's identity and provenance", async () => {
    const input = z.object({
      pubkey: z.string().regex(/^[0-9a-f]{64}$/),
      signature: z.string().regex(/^[0-9a-f]{128}$/),
      timestamp: z.number().int(),
      nonce: z.string().min(8),
      action: z.string()
    });
    const signer = createSignedRequestVerifier(input);
    const requesterSecret = new Uint8Array([
      0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f, 0x10, 0x11, 0x12, 0x13,
      0x14, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x1b, 0x1c, 0x1d, 0x1e, 0x1f, 0x20
    ]);
    function configuredHost(name: string, dvmId: string, sha: string) {
      let executions = 0;
      const builder = generateIdentity();
      const attestation = signDeployAttestation({
        builderSecret: builder.secret,
        builderPubkey: builder.pubkey,
        dvmId,
        slug: name,
        capabilities: ["test"]
      });
      const host = createDVMHost({
        devMode: true,
        port: 0,
        env: {
          ...attestationEnv(attestation),
          GIT_SHA: sha,
          BUILD_TIME: `${name}-time`,
          DVMKIT_DEPLOY_ID: `${name}-deploy`
        }
      });
      host.mount(
        configureDVM({
          name,
          capabilities: {
            do: {
              input,
              onJob(ctx) {
                executions += 1;
                ctx.complete("ok");
              }
            }
          },
          auth: secp256k1Auth()
        })
      );
      return { host, attestation, executions: () => executions };
    }

    const firstConfig = configuredHost("first-host", "dvm-first", "first-sha");
    const secondConfig = configuredHost("second-host", "dvm-second", "second-sha");
    const first = await firstConfig.host.serve();
    const second = await secondConfig.host.serve();
    server = second;
    try {
      const [firstInfo, secondInfo, firstHealthz, secondHealthz] = await Promise.all([
        fetch(`${first.url}/v1/info`).then((res) => res.json()),
        fetch(`${second.url}/v1/info`).then((res) => res.json()),
        fetch(`${first.url}/healthz`).then((res) => res.json()),
        fetch(`${second.url}/healthz`).then((res) => res.json())
      ]);
      expect(firstInfo).toMatchObject({
        sdk_sha: "first-sha",
        deploy_id: "first-host-deploy",
        auth_audience: {
          dvm_id: "dvm-first",
          builder_pubkey: firstConfig.attestation.identityPubkey
        }
      });
      expect(secondInfo).toMatchObject({
        sdk_sha: "second-sha",
        deploy_id: "second-host-deploy",
        auth_audience: {
          dvm_id: "dvm-second",
          builder_pubkey: secondConfig.attestation.identityPubkey
        }
      });
      expect(firstHealthz).toMatchObject({
        gitSha: "first-s",
        deployId: "first-host-deploy"
      });
      expect(secondHealthz).toMatchObject({
        gitSha: "second-",
        deployId: "second-host-deploy"
      });

      const signedForFirst = signer.signRequest(requesterSecret, { action: "run" }, undefined, {
        audience: {
          dvm_id: "dvm-first",
          builder_pubkey: firstConfig.attestation.identityPubkey
        },
        method: "POST",
        path: "/v1/job",
        capability: "do"
      });
      const request = JSON.stringify({
        capability: "do",
        data: signedForFirst
      });
      const accepted = await fetch(`${first.url}/v1/job`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: request
      });
      expect(accepted.status).toBeLessThan(400);
      expect(firstConfig.executions()).toBe(1);

      const rejected = await fetch(`${second.url}/v1/job`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: request
      });
      expect(rejected.status).toBe(401);
      expect(secondConfig.executions()).toBe(0);
    } finally {
      await first.close();
    }
  });

  it("refuses to serve an unsupported Tempo chain", async () => {
    const host = createDVMHost({
      devMode: true,
      port: 0,
      env: {
        DVMKIT_TEMPO_RECIPIENT: `0x${"a".repeat(40)}`,
        DVMKIT_TEMPO_SECRET_KEY: "ab".repeat(32),
        DVMKIT_TEMPO_CHAIN_ID: "999",
        DVMKIT_TEMPO_CURRENCY: `0x${"1".repeat(40)}`
      },
      jobStore: new MemoryJobStore()
    });
    host.mount(
      configureDVM({
        name: "unsupported-tempo-chain",
        capability: "test",
        onJob(ctx) {
          ctx.complete("must not run");
        }
      })
    );

    await expect(host.serve()).rejects.toThrow(
      `DVMKIT_TEMPO_CHAIN_ID must be 4217 (mainnet) or 42431 (Moderato); got '999'.`
    );
  });

  it("refuses a production receipt key whose injected DVM ID contradicts its attestation", async () => {
    const dvm = configureDVM({
      name: "receipt-identity-guard",
      capability: "test",
      tag: "test",
      onJob(ctx) {
        ctx.complete("ok");
      }
    });
    const builder = generateIdentity();
    const attestation = signDeployAttestation({
      builderSecret: builder.secret,
      builderPubkey: builder.pubkey,
      dvmId: "dvm-attested",
      slug: "receipt-identity-guard",
      capabilities: ["test"],
      withReceiptKey: true
    });
    const host = createDVMHost({
      port: 0,
      jobStore: new MemoryJobStore(),
      env: {
        ...attestationEnv(attestation),
        DVMKIT_DVM_ID: "dvm-injected-elsewhere"
      }
    });
    host.mount(dvm);

    await expect(host.serve()).rejects.toThrow(/Receipt-signing identity is incomplete or contradictory/);
  });

  it("logs a dvm_boot_phase_timings breakdown before the listener opens", async () => {
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((msg?: unknown) => {
      if (typeof msg === "string") logs.push(msg);
    });

    const dvm = configureDVM({
      name: "boot-timings",
      capability: "test",
      tag: "test",
      onJob(ctx) {
        ctx.complete("ok");
      }
    });

    const host = createDVMHost({ devMode: true, port: 0, env: {} });
    host.mount(dvm);
    server = await host.serve();

    const line = logs
      .map((l) => {
        try {
          return JSON.parse(l) as {
            event?: string;
          };
        } catch {
          return undefined;
        }
      })
      .find((o) => o?.event === "dvm_boot_phase_timings");

    expect(line).toBeDefined();
    expect(JSON.stringify(line)).not.toContain("phaseMs");
  });

  it("exposes host.app for custom non-protocol routes", async () => {
    const dvm = configureDVM({
      name: "host-app-route",
      capability: "test",
      tag: "test",
      onJob(ctx) {
        ctx.complete("ok");
      }
    });

    const host = createDVMHost({ devMode: true, port: 0, env: {} });
    host.app.get("/custom/ping", (c) => c.json({ pong: true }));
    host.mount(dvm);
    server = await host.serve();

    const res = await fetch(`${server.url}/custom/ping`);
    expect(res.status).toBe(200);
    expect(res.headers.get(CLIENT_COMPATIBILITY_HEADERS.protocolVersion)).toBe("1");
    expect(await res.json()).toEqual({ pong: true });
  });

  it("mounts multiple DVMs at distinct prefixes", async () => {
    const a = configureDVM({
      name: "a-dvm",
      capability: "test",
      tag: "test",
      onJob(ctx) {
        ctx.complete("a");
      }
    });
    const b = configureDVM({
      name: "b-dvm",
      capability: "test",
      tag: "test",
      onJob(ctx) {
        ctx.complete("b");
      }
    });

    const host = createDVMHost({ devMode: true, port: 0, env: {} });
    host.mount(a);
    host.mount(b, { prefix: "/b" });
    server = await host.serve();

    const ra = (await (await fetch(`${server.url}/v1/info`)).json()) as {
      name?: string;
    };
    const rb = (await (await fetch(`${server.url}/b/v1/info`)).json()) as {
      name?: string;
    };
    expect(ra.name).toBe("a-dvm");
    expect(rb.name).toBe("b-dvm");
  });

  it("propagates an onBoot throw out of host.serve()", async () => {
    const dvm = configureDVM({
      name: "boot-fail",
      capability: "test",
      tag: "test",
      onBoot() {
        throw new Error("boot failed: missing API key");
      },
      onJob(ctx) {
        ctx.complete("never");
      }
    });

    const host = createDVMHost({ devMode: true, port: 0, env: {} });
    host.mount(dvm);
    await expect(host.serve()).rejects.toThrow(/boot failed: missing API key/);
  });

  it("runs onShutdown in reverse mount order", async () => {
    const calls: string[] = [];
    const a = configureDVM({
      name: "shut-a",
      capability: "test",
      tag: "test",
      onShutdown() {
        calls.push("a");
      },
      onJob(ctx) {
        ctx.complete("ok");
      }
    });
    const b = configureDVM({
      name: "shut-b",
      capability: "test",
      tag: "test",
      onShutdown() {
        calls.push("b");
      },
      onJob(ctx) {
        ctx.complete("ok");
      }
    });

    const host = createDVMHost({ devMode: true, port: 0, env: {} });
    host.mount(a);
    host.mount(b, { prefix: "/b" });
    server = await host.serve();
    await server.close();
    server = undefined;

    expect(calls).toEqual(["b", "a"]);
  });

  it("closes promptly with an idle keep-alive connection open", async () => {
    const dvm = configureDVM({
      name: "idle-close",
      capability: "test",
      tag: "test",
      onJob(ctx) {
        ctx.complete("ok");
      }
    });
    const agent = new Agent({ keepAlive: true });

    try {
      const host = createDVMHost({ devMode: true, port: 0, env: {} });
      host.mount(dvm);
      server = await host.serve();

      await new Promise<void>((resolve, reject) => {
        const request = httpGet(`${server?.url}/v1/info`, { agent }, (response) => {
          response.resume();
          response.on("end", resolve);
        });
        request.on("error", reject);
      });
      await vi.waitFor(() => {
        expect(Object.values(agent.freeSockets).flat()).toHaveLength(1);
      });

      await expect(settlesWithin(server.close(), 1_000)).resolves.toBeUndefined();
      server = undefined;
    } finally {
      agent.destroy();
    }
  });

  it("lets an in-flight request finish before close resolves", async () => {
    let markStarted: () => void = () => undefined;
    let releaseRequest: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const released = new Promise<void>((resolve) => {
      releaseRequest = resolve;
    });
    const dvm = configureDVM({
      name: "in-flight-close",
      capability: "test",
      tag: "test",
      onJob(ctx) {
        ctx.complete("ok");
      }
    });
    const host = createDVMHost({ devMode: true, port: 0, env: {} });
    host.app.get("/slow", async (c) => {
      markStarted();
      await released;
      return c.text("finished");
    });
    host.mount(dvm);
    server = await host.serve();

    try {
      const responsePromise = fetch(`${server.url}/slow`);
      await started;
      const closePromise = server.close();

      await expect(staysPending(closePromise, 30)).resolves.toBe(true);
      releaseRequest();

      const response = await settlesWithin(responsePromise, 1_000);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("finished");
      await expect(settlesWithin(closePromise, 1_000)).resolves.toBeUndefined();
      server = undefined;
    } finally {
      releaseRequest();
    }
  });

  it("invokes descriptor.routes(app) on mount and inherits the prefix", async () => {
    const calls: { name: string; hasRoute: boolean }[] = [];
    const root = configureDVM({
      name: "routes-root",
      capability: "test",
      tag: "test",
      onJob(ctx) {
        ctx.complete("ok");
      },
      routes(app) {
        calls.push({ name: "root", hasRoute: typeof app.get === "function" });
        app.get("/custom-route", (c) => c.json({ from: "root" }));
      }
    });
    const prefixed = configureDVM({
      name: "routes-prefixed",
      capability: "test",
      tag: "test",
      onJob(ctx) {
        ctx.complete("ok");
      },
      routes(app) {
        calls.push({
          name: "prefixed",
          hasRoute: typeof app.get === "function"
        });
        app.get("/custom-route", (c) => c.json({ from: "prefixed" }));
      }
    });

    const host = createDVMHost({ devMode: true, port: 0, env: {} });
    host.mount(root);
    host.mount(prefixed, { prefix: "/sub" });
    server = await host.serve();

    expect(calls.map((c) => c.name)).toEqual(["root", "prefixed"]);
    expect(calls.every((c) => c.hasRoute)).toBe(true);

    const rootRes = await fetch(`${server.url}/custom-route`);
    expect(rootRes.status).toBe(200);
    expect(await rootRes.json()).toEqual({ from: "root" });

    const prefixedRes = await fetch(`${server.url}/sub/custom-route`);
    expect(prefixedRes.status).toBe(200);
    expect(await prefixedRes.json()).toEqual({ from: "prefixed" });
  });

  it("fails loud when DATABASE_URL is missing in production mode", async () => {
    const dvm = configureDVM({
      name: "needs-db",
      capability: "test",
      tag: "test",
      onJob(ctx) {
        ctx.complete("ok");
      }
    });

    const host = createDVMHost({ port: 0, env: {} });
    host.mount(dvm);
    await expect(host.serve()).rejects.toThrow(/Postgres database/);
  });

  it("emits /v1/info#builder block from DVMKIT_BUILDER_* env", async () => {
    const dvm = configureDVM({
      name: "info-builder-env",
      capability: "test",
      tag: "test",
      onJob(ctx) {
        ctx.complete("ok");
      }
    });

    const attestation = {
      dvm_id: "dvm-info-builder-env",
      slug: "info-builder-env",
      capabilities_hash: "a".repeat(64),
      builder_pubkey: "b".repeat(64),
      deployed_at: 1747512345
    };
    const host = createDVMHost({
      devMode: true,
      port: 0,
      env: {
        DVMKIT_BUILDER_PUBKEY: "b".repeat(64),
        DVMKIT_BUILDER_ATTESTATION: JSON.stringify(attestation),
        DVMKIT_BUILDER_SIGNATURE: "c".repeat(128)
      }
    });
    host.mount(dvm);
    server = await host.serve();

    const info = (await (await fetch(`${server.url}/v1/info`)).json()) as {
      builder?: {
        pubkey: string;
        attestation: typeof attestation;
        signature: string;
      };
    };
    expect(info.builder).toEqual({
      pubkey: "b".repeat(64),
      attestation,
      signature: "c".repeat(128)
    });
  });

  it("emits /v1/info#builder block from opts.builder when env is empty", async () => {
    const dvm = configureDVM({
      name: "info-builder-opts",
      capability: "test",
      tag: "test",
      onJob(ctx) {
        ctx.complete("ok");
      }
    });

    const attestation = {
      dvm_id: "dvm-info-builder-opts",
      slug: "info-builder-opts",
      capabilities_hash: "a".repeat(64),
      builder_pubkey: "b".repeat(64),
      deployed_at: 1747512345
    };
    const host = createDVMHost({
      devMode: true,
      port: 0,
      env: {},
      builder: {
        pubkey: "b".repeat(64),
        attestation,
        signature: "c".repeat(128)
      }
    });
    host.mount(dvm);
    server = await host.serve();

    const info = (await (await fetch(`${server.url}/v1/info`)).json()) as {
      builder?: {
        pubkey: string;
        attestation: typeof attestation;
        signature: string;
      };
    };
    expect(info.builder).toEqual({
      pubkey: "b".repeat(64),
      attestation,
      signature: "c".repeat(128)
    });
  });

  it("opts.builder overrides DVMKIT_BUILDER_* env per-field", async () => {
    const dvm = configureDVM({
      name: "info-builder-precedence",
      capability: "test",
      tag: "test",
      onJob(ctx) {
        ctx.complete("ok");
      }
    });

    const envAttestation = {
      dvm_id: "dvm-info-builder-precedence",
      slug: "info-builder-precedence",
      capabilities_hash: "e".repeat(64),
      builder_pubkey: "e".repeat(64),
      deployed_at: 1
    };
    const optsAttestation = {
      dvm_id: "dvm-info-builder-precedence",
      slug: "info-builder-precedence",
      capabilities_hash: "a".repeat(64),
      builder_pubkey: "b".repeat(64),
      deployed_at: 2
    };
    const host = createDVMHost({
      devMode: true,
      port: 0,
      env: {
        DVMKIT_BUILDER_PUBKEY: "e".repeat(64),
        DVMKIT_BUILDER_ATTESTATION: JSON.stringify(envAttestation),
        DVMKIT_BUILDER_SIGNATURE: "e".repeat(128)
      },
      builder: {
        pubkey: "b".repeat(64),
        attestation: optsAttestation,
        signature: "c".repeat(128)
      }
    });
    host.mount(dvm);
    server = await host.serve();

    const info = (await (await fetch(`${server.url}/v1/info`)).json()) as {
      builder?: {
        pubkey: string;
        attestation: typeof optsAttestation;
        signature: string;
      };
    };
    expect(info.builder).toEqual({
      pubkey: "b".repeat(64),
      attestation: optsAttestation,
      signature: "c".repeat(128)
    });
  });

  it("omits /v1/info#builder block when env is absent and opts.builder is unset", async () => {
    const dvm = configureDVM({
      name: "info-builder-absent",
      capability: "test",
      tag: "test",
      onJob(ctx) {
        ctx.complete("ok");
      }
    });

    const host = createDVMHost({ devMode: true, port: 0, env: {} });
    host.mount(dvm);
    server = await host.serve();

    const info = (await (await fetch(`${server.url}/v1/info`)).json()) as {
      builder?: unknown;
    };
    expect(info.builder).toBeUndefined();
  });

  it("omits /v1/info#builder when DVMKIT_BUILDER_ATTESTATION is malformed JSON", async () => {
    const dvm = configureDVM({
      name: "info-builder-malformed",
      capability: "test",
      tag: "test",
      onJob(ctx) {
        ctx.complete("ok");
      }
    });

    const host = createDVMHost({
      devMode: true,
      port: 0,
      env: {
        DVMKIT_BUILDER_PUBKEY: "b".repeat(64),
        DVMKIT_BUILDER_ATTESTATION: "{not json",
        DVMKIT_BUILDER_SIGNATURE: "c".repeat(128)
      }
    });
    host.mount(dvm);
    server = await host.serve();

    const info = (await (await fetch(`${server.url}/v1/info`)).json()) as {
      builder?: unknown;
    };
    expect(info.builder).toBeUndefined();
  });

  it("logs every inferred opt at boot", async () => {
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });

    const dvm = configureDVM({
      name: "boot-log",
      capability: "test",
      tag: "test",
      onJob(ctx) {
        ctx.complete("ok");
      }
    });

    const host = createDVMHost({ devMode: true, port: 0, env: {} });
    host.mount(dvm);
    server = await host.serve();

    expect(logs.length).toBeGreaterThan(0);
    expect(logs.every((line) => JSON.parse(line).event)).toBe(true);
    expect(logs.join("\n")).not.toContain("boot-log");
  });

  describe("signed-request replay store wiring", () => {
    const signedSchema = z.object({
      pubkey: z.string().regex(/^[0-9a-f]{64}$/),
      signature: z.string().regex(/^[0-9a-f]{128}$/),
      timestamp: z.number().int(),
      nonce: z.string().min(8),
      action: z.string()
    });

    function buildSignedDvm(name: string, auth = secp256k1Auth()) {
      return configureDVM({
        name,
        capabilities: {
          do: {
            input: signedSchema,
            onJob(ctx) {
              ctx.complete("ok");
            }
          }
        },
        auth
      });
    }

    it("logs 'memory (per-process — multi-machine UNSAFE)' and warns when devMode lacks a pool", async () => {
      const logs: string[] = [];
      const warnings: string[] = [];
      vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
        logs.push(args.map(String).join(" "));
      });
      vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
        warnings.push(args.map(String).join(" "));
      });

      const host = createDVMHost({ devMode: true, port: 0, env: {} });
      host.mount(buildSignedDvm("signed-dvm"));
      server = await host.serve();

      expect(logs).toContain('{"event":"diagnostic.message","level":"info"}');
      // devMode silences the multi-machine warning.
      expect(warnings.find((w) => w.includes("secp256k1_auth_replay_store_in_memory"))).toBeUndefined();
    });

    it("warns loudly when secp256k1Auth boots without a pool outside devMode", async () => {
      const warnings: string[] = [];
      vi.spyOn(console, "log").mockImplementation(() => {});
      vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
        warnings.push(args.map(String).join(" "));
      });

      const host = createDVMHost({
        port: 0,
        env: {},
        jobStore: new MemoryJobStore()
      });
      host.mount(buildSignedDvm("signed-dvm"));
      server = await host.serve();

      const warning = warnings.find((w) => w.includes("secp256k1_auth_replay_store_in_memory"));
      expect(warning).toBeDefined();
      expect(warning).not.toContain("signed-dvm");
    });

    it("throws under DVMKIT_FAIL_FAST=true when secp256k1Auth has no cross-machine store", async () => {
      vi.spyOn(console, "log").mockImplementation(() => {});
      vi.spyOn(console, "warn").mockImplementation(() => {});

      const host = createDVMHost({
        port: 0,
        env: { DVMKIT_FAIL_FAST: "true" },
        jobStore: new MemoryJobStore()
      });
      host.mount(buildSignedDvm("signed-dvm"));

      await expect(host.serve()).rejects.toThrow(/secp256k1Auth.*in-memory replay store/);
    });

    it("logs 'user-supplied' and does not warn when user passed an explicit replayStore", async () => {
      const logs: string[] = [];
      const warnings: string[] = [];
      vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
        logs.push(args.map(String).join(" "));
      });
      vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
        warnings.push(args.map(String).join(" "));
      });

      const userStore = {
        async checkAndRecord() {
          return false;
        }
      };
      const host = createDVMHost({ devMode: true, port: 0, env: {} });
      host.mount(buildSignedDvm("signed-dvm", secp256k1Auth({ replayStore: userStore })));
      server = await host.serve();

      expect(logs).toContain('{"event":"diagnostic.message","level":"info"}');
      expect(warnings.find((w) => w.includes("secp256k1_auth_replay_store_in_memory"))).toBeUndefined();
    });

    it("logs 'disabled' when user passed replayStore: null", async () => {
      const logs: string[] = [];
      vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
        logs.push(args.map(String).join(" "));
      });
      vi.spyOn(console, "warn").mockImplementation(() => {});

      const host = createDVMHost({ devMode: true, port: 0, env: {} });
      host.mount(buildSignedDvm("signed-dvm", secp256k1Auth({ replayStore: null })));
      server = await host.serve();

      expect(logs).toContain('{"event":"diagnostic.message","level":"info"}');
    });
  });

  describe("consumed-credential / admin-nonce / KV store wiring", () => {
    // Activates the MPP rail without a pool: createDVMHost builds a real
    // single-key handle from these env vars (host.ts MPP block), so
    // `mounts.some(... mpp)` is true and the consumed-credential check fires.
    const MPP_ENV = {
      DVMKIT_TEMPO_RECIPIENT: `0x${"a".repeat(40)}`,
      DVMKIT_TEMPO_SECRET_KEY: "ab".repeat(32)
    };

    function buildPlainDvm(name: string) {
      return configureDVM({
        name,
        capability: "test",
        tag: "test",
        onJob(ctx) {
          ctx.complete("ok");
        }
      });
    }

    it("logs all three store backends at boot", async () => {
      const logs: string[] = [];
      vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
        logs.push(args.map(String).join(" "));
      });

      const host = createDVMHost({ devMode: true, port: 0, env: {} });
      host.mount(buildPlainDvm("store-log"));
      server = await host.serve();

      expect(
        logs.filter((line) => line === '{"event":"diagnostic.message","level":"info"}').length
      ).toBeGreaterThanOrEqual(3);
    });

    it("throws under DVMKIT_FAIL_FAST=true when the KV store falls back to memory", async () => {
      vi.spyOn(console, "log").mockImplementation(() => {});
      vi.spyOn(console, "warn").mockImplementation(() => {});

      const host = createDVMHost({
        port: 0,
        env: { DVMKIT_FAIL_FAST: "true" },
        jobStore: new MemoryJobStore()
      });
      host.mount(buildPlainDvm("kv-failfast"));

      await expect(host.serve()).rejects.toThrow(/The kv store fell back to in-memory/);
    });

    it("warns (not throws) for the KV store outside devMode, and not for an unused MPP rail", async () => {
      const warnings: string[] = [];
      vi.spyOn(console, "log").mockImplementation(() => {});
      vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
        warnings.push(args.map(String).join(" "));
      });

      const host = createDVMHost({
        port: 0,
        env: {},
        jobStore: new MemoryJobStore()
      });
      host.mount(buildPlainDvm("kv-warn"));
      server = await host.serve();

      expect(warnings.find((w) => w.includes("kv_store_in_memory"))).toBeDefined();
      // MPP not configured → consumed-credential check is gated off.
      expect(warnings.find((w) => w.includes("consumed_credential_store_in_memory"))).toBeUndefined();
    });

    it("devMode silences the KV fallback warning", async () => {
      const warnings: string[] = [];
      vi.spyOn(console, "log").mockImplementation(() => {});
      vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
        warnings.push(args.map(String).join(" "));
      });

      const host = createDVMHost({ devMode: true, port: 0, env: {} });
      host.mount(buildPlainDvm("kv-dev"));
      server = await host.serve();

      expect(warnings.find((w) => w.includes("kv_store_in_memory"))).toBeUndefined();
    });

    it("throws under DVMKIT_FAIL_FAST=true when the MPP consumed-credential store falls back", async () => {
      vi.spyOn(console, "log").mockImplementation(() => {});
      vi.spyOn(console, "warn").mockImplementation(() => {});

      const host = createDVMHost({
        port: 0,
        env: { ...MPP_ENV, DVMKIT_FAIL_FAST: "true" },
        jobStore: new MemoryJobStore()
      });
      host.mount(buildPlainDvm("mpp-failfast"));

      await expect(host.serve()).rejects.toThrow(/The consumed-credential store fell back to in-memory/);
    });

    it("warns for the MPP consumed-credential store outside devMode", async () => {
      const warnings: string[] = [];
      vi.spyOn(console, "log").mockImplementation(() => {});
      vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
        warnings.push(args.map(String).join(" "));
      });

      const host = createDVMHost({
        port: 0,
        env: MPP_ENV,
        jobStore: new MemoryJobStore()
      });
      host.mount(buildPlainDvm("mpp-warn"));
      server = await host.serve();

      expect(warnings.find((w) => w.includes("consumed_credential_store_in_memory"))).toBeDefined();
    });
  });
});

async function settlesWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`promise did not settle within ${timeoutMs}ms`));
        }, timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function staysPending(promise: Promise<unknown>, durationMs: number): Promise<boolean> {
  return Promise.race([
    promise.then(() => false),
    new Promise<true>((resolve) => {
      setTimeout(() => {
        resolve(true);
      }, durationMs);
    })
  ]);
}
