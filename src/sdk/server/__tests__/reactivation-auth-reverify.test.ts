import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { configureDVM } from "../../configure";
import { createFxFetcher } from "../../pricing";
import { MemoryKVStore } from "../../store";
import { JobManager, ReactivationAuthSchemaError } from "../job-manager";
import type { JobRecord } from "../job-store";
import { MemoryJobStore } from "../memory-job-store";
import { secp256k1Auth } from "../secp256k1-auth";
import { createSignedRequestVerifier, SignedRequestError } from "../signed-request";

const sampleSchema = z.object({
  pubkey: z.string().regex(/^[0-9a-f]{64}$/),
  signature: z.string().regex(/^[0-9a-f]{128}$/),
  timestamp: z.number().int(),
  nonce: z.string().min(8),
  action: z.string()
});

const PRIVKEY = new Uint8Array([
  0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f, 0x10, 0x11, 0x12, 0x13,
  0x14, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x1b, 0x1c, 0x1d, 0x1e, 0x1f, 0x20
]);
const AUTH_AUDIENCE = { dvm_id: "dvm-reactivation", builder_pubkey: "ab".repeat(32) };
const AUTH_DOMAIN = {
  audience: AUTH_AUDIENCE,
  method: "POST",
  path: "/v1/job",
  capability: "do"
} as const;

function buildManager(schema: typeof sampleSchema = sampleSchema): {
  jm: JobManager<Record<string, unknown>, typeof sampleSchema>;
  signer: ReturnType<typeof createSignedRequestVerifier<z.infer<typeof sampleSchema>>>;
} {
  const signer = createSignedRequestVerifier(schema, { domain: AUTH_DOMAIN });
  const descriptor = configureDVM({
    name: "reactivation-auth-test",
    capability: "do",
    tag: "test",
    idleTimeout: 120,
    input: schema,
    onJob(ctx) {
      ctx.complete(`ok:${ctx.auth?.pubkey ?? "missing"}`);
    },
    auth: secp256k1Auth()
  });
  const jm = new JobManager(descriptor, {
    env: {},
    store: new MemoryKVStore(),
    jobStore: new MemoryJobStore(),
    devMode: true,
    fxFetcher: createFxFetcher(),
    staleJobTimeoutMs: 0,
    authAudience: AUTH_AUDIENCE
  });
  return { jm, signer };
}

function seedRecord(input: string, overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    id: "job-rv-1",
    tags: [],
    capability: "do",
    input,
    params: {},
    requesterId: "requester-1",
    authRequestPath: "/v1/job",
    status: "awaiting-input",
    messages: [],
    seq: 0,
    paidMsats: 0,
    receivedProofs: [],
    stepCache: [],
    state: {},
    createdAt: Date.now() - 60_000,
    lastActivityAt: Date.now() - 60_000,
    ...overrides
  };
}

describe("JobManager.reactivateJob re-verifies persisted auth envelope", () => {
  it("reactivates a valid persisted envelope and exposes ctx.auth.pubkey", () => {
    const { jm, signer } = buildManager();
    try {
      const signed = signer.signRequest(PRIVKEY, { action: "publish" });
      const record = seedRecord(JSON.stringify(signed));
      const { sdkCtx } = jm.reactivateJob(record);
      expect(sdkCtx.auth?.pubkey).toBe(signed.pubkey);
    } finally {
      jm.shutdown();
    }
  });

  it("throws SignedRequestError when the persisted pubkey was swapped (DB-tamper)", () => {
    // The threat model: attacker overwrites `pubkey` on the persisted row to
    // forge `ctx.auth.pubkey`. They can keep the original signature (it
    // doesn't even need to be valid against the swapped pubkey; mismatch is
    // exactly what the re-check catches).
    const { jm, signer } = buildManager();
    try {
      const signed = signer.signRequest(PRIVKEY, { action: "publish" });
      const tampered = { ...signed, pubkey: "f".repeat(64) };
      const record = seedRecord(JSON.stringify(tampered));

      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        expect(() => jm.reactivateJob(record)).toThrow(SignedRequestError);
        expect(warn).toHaveBeenCalledOnce();
        const payload = JSON.parse(String(warn.mock.calls[0][0]));
        expect(payload.event).toBe("auth_reverify_failed");
        expect(payload.level).toBe("warn");
        expect(payload).not.toHaveProperty("capability");
        expect(JSON.stringify(payload)).not.toContain(record.id);
      } finally {
        warn.mockRestore();
      }
    } finally {
      jm.shutdown();
    }
  });

  it("throws SignedRequestError when the persisted payload was mutated under the signature", () => {
    // Same threat, different vector: keep the legitimate pubkey but rewrite
    // the action. The signature was computed over the original action, so
    // verification fails.
    const { jm, signer } = buildManager();
    try {
      const signed = signer.signRequest(PRIVKEY, { action: "publish" });
      const tampered = { ...signed, action: "delete-everything" };
      const record = seedRecord(JSON.stringify(tampered));

      vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        expect(() => jm.reactivateJob(record)).toThrow(SignedRequestError);
      } finally {
        vi.restoreAllMocks();
      }
    } finally {
      jm.shutdown();
    }
  });

  it("rejects a proof transplanted from another authenticated route", () => {
    const { jm } = buildManager();
    try {
      const resultSigner = createSignedRequestVerifier(sampleSchema, {
        domain: { ...AUTH_DOMAIN, path: "/v1/request-result/recover-1" }
      });
      const signed = resultSigner.signRequest(PRIVKEY, { action: "publish" });
      const record = seedRecord(JSON.stringify(signed));

      vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        expect(() => jm.reactivateJob(record)).toThrow(SignedRequestError);
      } finally {
        vi.restoreAllMocks();
      }
    } finally {
      jm.shutdown();
    }
  });

  it("anchors a request-resume proof to the accepted resume route", () => {
    const { jm } = buildManager();
    try {
      const resumePath = "/v1/request-resume/recover-1";
      const resumeSigner = createSignedRequestVerifier(sampleSchema, {
        domain: { ...AUTH_DOMAIN, path: resumePath }
      });
      const signed = resumeSigner.signRequest(PRIVKEY, { action: "publish" });
      const record = seedRecord(JSON.stringify(signed), {
        authRequestPath: resumePath
      });

      expect(() => jm.reactivateJob(record)).not.toThrow();
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        expect(() => jm.reactivateJob({ ...record, authRequestPath: "/v1/job" })).toThrow(SignedRequestError);
      } finally {
        warn.mockRestore();
      }
    } finally {
      jm.shutdown();
    }
  });

  it("ignores drift on reactivation — an envelope signed long ago still re-verifies", () => {
    // Long-running jobs (sleep handlers, polling loops, multi-day workflows)
    // would otherwise 401 on the first cross-machine inbound. Re-check skips
    // drift; only the signature has to hold.
    const { jm } = buildManager();
    try {
      const longAgoSigner = createSignedRequestVerifier(sampleSchema, {
        now: () => Math.floor(Date.now() / 1000) - 7 * 86_400, // 7 days ago
        domain: AUTH_DOMAIN
      });
      const signed = longAgoSigner.signRequest(PRIVKEY, { action: "publish" });
      const record = seedRecord(JSON.stringify(signed));
      expect(() => jm.reactivateJob(record)).not.toThrow();
    } finally {
      jm.shutdown();
    }
  });

  it("re-verifies a persisted credit envelope under a strict schema", () => {
    // The persisted `record.input` is the pre-Zod wire form, credit fields
    // included. A strict schema used to throw a ZodError out of `parseInput`
    // here, before the envelope could be merged back for the signature check —
    // so every cross-machine resume of an explicit draw 400'd.
    const { jm, signer } = buildManager(sampleSchema.strict() as typeof sampleSchema);
    try {
      const signed = signer.signRequest(PRIVKEY, {
        action: "publish",
        credit_id: "c1",
        draw_id: "d1"
      });
      const record = seedRecord(JSON.stringify(signed));
      const { sdkCtx } = jm.reactivateJob(record);
      expect(sdkCtx.auth?.pubkey).toBe(signed.pubkey);
      // The envelope stays out of the handler's input.
      expect(sdkCtx.input).not.toHaveProperty("credit_id");
    } finally {
      jm.shutdown();
    }
  });

  it("still catches a tampered credit field under a strict schema", () => {
    const { jm, signer } = buildManager(sampleSchema.strict() as typeof sampleSchema);
    try {
      const signed = signer.signRequest(PRIVKEY, {
        action: "publish",
        credit_id: "c1",
        draw_id: "d1"
      });
      const record = seedRecord(JSON.stringify({ ...signed, draw_id: "d-swapped" }));
      vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        expect(() => jm.reactivateJob(record)).toThrow(SignedRequestError);
      } finally {
        vi.restoreAllMocks();
      }
    } finally {
      jm.shutdown();
    }
  });

  it("re-verifies a persisted body whose schema fills a nested default", () => {
    // The re-verify reads the persisted wire form, which is what the caller
    // signed. Verifying the Zod-parsed form instead meant any default the CLI
    // couldn't pre-fill — `applyJsonSchemaDefaults` is top-level only — 401'd
    // the first cross-machine inbound on a job that submitted fine.
    const nested = sampleSchema.extend({
      options: z.object({
        label: z.string().optional(),
        depth: z.number().default(2)
      })
    }) as unknown as typeof sampleSchema;
    const { jm, signer } = buildManager(nested);
    try {
      const signed = signer.signRequest(PRIVKEY, {
        action: "publish",
        options: { label: "body" }
      });
      const record = seedRecord(JSON.stringify(signed));
      const { sdkCtx } = jm.reactivateJob(record);
      expect(sdkCtx.auth?.pubkey).toBe(signed.pubkey);
      // The handler still gets the parsed input, defaults and all.
      expect((sdkCtx.input as { options: { depth: number } }).options.depth).toBe(2);
    } finally {
      jm.shutdown();
    }
  });

  it("catches a key injected into the persisted row that the schema doesn't declare", () => {
    // Verifying the parsed form made this tamper invisible: Zod's default strip
    // mode dropped the injected key before the signature was checked, so the
    // row re-verified clean. The raw read sees it.
    const { jm, signer } = buildManager();
    try {
      const signed = signer.signRequest(PRIVKEY, { action: "publish" });
      const record = seedRecord(JSON.stringify({ ...signed, injected: "by-the-dba" }));
      vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        expect(() => jm.reactivateJob(record)).toThrow(SignedRequestError);
      } finally {
        vi.restoreAllMocks();
      }
    } finally {
      jm.shutdown();
    }
  });

  it("rejects a persisted statement whose audience was tampered", () => {
    const { jm, signer } = buildManager();
    try {
      const signed = signer.signRequest(PRIVKEY, { action: "publish" });
      const record = seedRecord(
        JSON.stringify({
          ...signed,
          auth_statement: {
            ...signed.auth_statement,
            audience: {
              ...signed.auth_statement?.audience,
              dvm_id: "dvm-attacker"
            }
          }
        })
      );
      vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        expect(() => jm.reactivateJob(record)).toThrow(SignedRequestError);
      } finally {
        vi.restoreAllMocks();
      }
    } finally {
      jm.shutdown();
    }
  });

  it("throws ReactivationAuthSchemaError when descriptor.auth is set but capability has no input schema", () => {
    // Defence-in-depth: this should be impossible (submit-path
    // AuthSchemaError blocks job creation), but if a legacy row ever lands
    // here we should fail loudly, not silently skip verification.
    const descriptor = configureDVM({
      name: "no-schema-auth-test",
      capability: "do",
      tag: "test",
      idleTimeout: 120,
      // No `input:` declared.
      onJob(ctx) {
        ctx.complete("ok");
      },
      auth: secp256k1Auth()
    });
    const jm = new JobManager(descriptor, {
      env: {},
      store: new MemoryKVStore(),
      jobStore: new MemoryJobStore(),
      devMode: true,
      fxFetcher: createFxFetcher(),
      staleJobTimeoutMs: 0
    });
    try {
      const record = seedRecord(""); // empty input string
      expect(() => jm.reactivateJob(record)).toThrow(ReactivationAuthSchemaError);
    } finally {
      jm.shutdown();
    }
  });

  it("does NOT re-verify when descriptor has no auth — `ctx.auth` stays undefined", () => {
    // Sanity: the re-verify branch must only fire for auth-declaring DVMs.
    const descriptor = configureDVM({
      name: "no-auth-test",
      capability: "do",
      tag: "test",
      idleTimeout: 120,
      onJob(ctx) {
        ctx.complete("ok");
      }
    });
    const jm = new JobManager(descriptor, {
      env: {},
      store: new MemoryKVStore(),
      jobStore: new MemoryJobStore(),
      devMode: true,
      fxFetcher: createFxFetcher(),
      staleJobTimeoutMs: 0
    });
    try {
      const record = seedRecord("any-string-input");
      const { sdkCtx } = jm.reactivateJob(record);
      expect(sdkCtx.auth).toBeUndefined();
    } finally {
      jm.shutdown();
    }
  });
});
