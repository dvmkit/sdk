import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { schnorr } from "@noble/curves/secp256k1.js";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { configureDVM } from "../../configure";
import { MemoryKVStore } from "../../store";
import { createDVMServer } from "../app";
import { CreditLedger } from "../credit-ledger";
import { CREDIT_REQUEST_SCHEMA } from "../credit-routes";
import { HostingControl, signHostingClosure, signHostingControl,
  type HostingClosureCommand, type HostingControlCommand } from "../hosting-control";
import { PostgresJobStore } from "../postgres-job-store";
import { secp256k1Auth } from "../secp256k1-auth";
import { createSignedRequestVerifier } from "../signed-request";
import { expectJobIdentity, expectNoJobIdentity } from "./__helpers__/job-identity";

const DATABASE_URL = process.env.DATABASE_URL;
const RUN = !!DATABASE_URL && /\/dvmkit_test(_[0-9a-f]{8})?(\?|$)/.test(DATABASE_URL);
const secret = "test-only-hosting-management-secret-32-bytes";
const wireFixture = JSON.parse(readFileSync(new URL("../../../../protocol-fixtures/hosting-control.json", import.meta.url), "utf8")) as {
  secret: string; command: HostingControlCommand; signature: string;
  resumeV2: { command: HostingControlCommand; signature: string };
  closureV3: { command: HostingClosureCommand; signature: string };
};

describe("hosting control wire signature", () => {
  it("matches the independent HMAC protocol fixture", () => {
    expect(signHostingControl(wireFixture.secret, wireFixture.command)).toBe(wireFixture.signature);
    expect(signHostingControl(wireFixture.secret, wireFixture.resumeV2.command)).toBe(wireFixture.resumeV2.signature);
    expect(signHostingClosure(wireFixture.secret, wireFixture.closureV3.command)).toBe(wireFixture.closureV3.signature);
  });
});

describe.skipIf(!RUN)("durable hosting admission", () => {
  let poolA: pg.Pool;
  let poolB: pg.Pool;
  let store: PostgresJobStore;
  const dvmId = `test-${randomUUID()}`;
  const scope = `deployment-${randomUUID()}`;
  let nonce = 0;

  const command = (action: HostingControlCommand["action"], fields: Partial<HostingControlCommand> = {}): HostingControlCommand => ({
    action, dvmId, scope, timestampMs: Date.now(), nonce: `nonce_${String(++nonce).padStart(20, "0")}`,
    ...fields,
  });
  const resume = (generation: number, leaseMs = 300_000): HostingControlCommand => {
    const leaseExpiresAtMs = Date.now() + leaseMs;
    return command("resume", { version: 2, generation, leaseExpiresAtMs,
      deadlineMs: leaseExpiresAtMs + 30_000 });
  };

  beforeAll(async () => {
    poolA = new pg.Pool({ connectionString: DATABASE_URL });
    poolB = new pg.Pool({ connectionString: DATABASE_URL });
    store = new PostgresJobStore(poolA);
    await store.init();
    await store.initStreaming();
  });

  afterAll(async () => {
    await poolA.query("DELETE FROM sdk_hosting_admissions WHERE dvm_id=$1", [dvmId]);
    await poolA.query("DELETE FROM sdk_hosting_nonces WHERE dvm_id=$1", [dvmId]);
    await poolA.query("DELETE FROM sdk_hosting_control WHERE dvm_id=$1", [dvmId]);
    await store.shutdownStreaming();
    await poolA.end();
    await poolB.end();
  });

  it("serializes cross-instance admission before payment and preserves an in-flight reservation", async () => {
    const a = new HostingControl(poolA, dvmId, { secret, scope });
    const b = new HostingControl(poolB, dvmId, { secret, scope });
    await a.init();
    await b.init();

    expect(await a.admit("before-lease", "job-before-lease")).toBe(false);
    expect((await b.status()).state).toBe("draining");
    expect(await b.transition(resume(1))).toBe("ok");
    expect(await a.admit("before-drain", "job-before")).toBe(true);
    expect(await b.transition(command("drain", { generation: 2, deadlineMs: Date.now() + 30_000 }))).toBe("ok");
    expect(await a.admit("after-drain", "job-after")).toBe(false);
    expect((await a.status()).pendingAdmissionCount).toBe(1);
    expect(await a.jobDeadline("job-before")).toBeGreaterThan(Date.now());

    await a.finishAdmission("before-drain", "unresolved");
    expect((await b.status()).unresolvedAdmissionCount).toBe(1);
  });

  it("binds control to its scope and rejects replay, stale generations, and conflicting duplicates", async () => {
    const control = new HostingControl(poolA, dvmId, { secret, scope });
    const drain = command("drain", { generation: 3, deadlineMs: Date.now() + 30_000 });
    const signature = signHostingControl(secret, drain);
    expect(await control.authorize(drain, signature)).toBe(true);
    expect(await control.authorize(drain, signature)).toBe(false);
    expect(await control.authorize({ ...drain, nonce: command("status").nonce, scope: "other" }, signature)).toBe(false);
    expect(await control.transition(drain)).toBe("ok");
    expect(await control.transition(command("drain", { generation: 3, deadlineMs: drain.deadlineMs }))).toBe("ok");
    expect(await control.transition(command("resume", { generation: 4 }))).toBe("conflict");
    expect(await control.transition(resume(3))).toBe("conflict");
    const funded = resume(4);
    const fundedSignature = signHostingControl(secret, funded);
    expect(await control.authorize({ ...funded, deadlineMs: funded.deadlineMs! + 1 }, fundedSignature)).toBe(false);
    expect(await control.authorize({ ...funded, leaseExpiresAtMs: funded.leaseExpiresAtMs! + 1 }, fundedSignature)).toBe(false);
    expect(await control.authorize({ ...funded, scope: "other" }, fundedSignature)).toBe(false);
    expect(await control.authorize(funded, fundedSignature)).toBe(true);
    expect(await control.transition(funded)).toBe("ok");
    expect(await control.transition({ ...funded, nonce: command("status").nonce })).toBe("ok");
    expect(await control.transition({ ...funded, deadlineMs: funded.deadlineMs! + 1 })).toBe("conflict");
    expect((await control.status()).state).toBe("accepting");
    expect(await control.jobDeadline("job-before")).toBeTypeOf("number");
  });

  it("migrates an unleased accepting scope closed while retaining pending recovery", async () => {
    const oldDvm = `test-${randomUUID()}`;
    const oldScope = `deployment-${randomUUID()}`;
    try {
      await poolA.query(
        `INSERT INTO sdk_hosting_control (dvm_id, scope, state, generation)
         VALUES ($1,$2,'accepting',4)`, [oldDvm, oldScope]
      );
      await poolA.query(
        `INSERT INTO sdk_hosting_admissions (id,dvm_id,scope,job_id,admitted_at_ms)
         VALUES ($1,$2,$3,$4,$5)`, [randomUUID(), oldDvm, oldScope, "paid-work", Date.now()]
      );
      const upgraded = new HostingControl(poolB, oldDvm, { secret, scope: oldScope });
      await upgraded.init();
      expect(await upgraded.admit(randomUUID(), "new-work")).toBe(false);
      const status = await upgraded.status();
      expect(status.state).toBe("draining");
      expect(status.generation).toBe(4);
      expect(status.pendingAdmissions).toEqual([expect.objectContaining({ workId: "paid-work" })]);
      expect(status.deadlineMs).toBeGreaterThan(Date.now());
      expect(await upgraded.jobDeadline("paid-work")).toBe(status.deadlineMs);
      await upgraded.init();
      expect((await upgraded.status()).deadlineMs).toBe(status.deadlineMs);
      await poolA.query(
        `UPDATE sdk_hosting_control SET state='accepting', deadline_ms=NULL
         WHERE dvm_id=$1 AND scope=$2`, [oldDvm, oldScope]
      );
      expect(await upgraded.admit(randomUUID(), "mixed-version-new-work")).toBe(false);
      expect((await upgraded.status()).state).toBe("draining");
      expect(await upgraded.jobDeadline("paid-work")).toBe(status.deadlineMs);
    } finally {
      await poolA.query("DELETE FROM sdk_hosting_admissions WHERE dvm_id=$1", [oldDvm]);
      await poolA.query("DELETE FROM sdk_hosting_control WHERE dvm_id=$1", [oldDvm]);
    }
  });

  it("uses database time after the scope lock and keeps an expired run bounded after renewal", async () => {
    const localDvm = `test-${randomUUID()}`;
    const localScope = `deployment-${randomUUID()}`;
    const a = new HostingControl(poolA, localDvm, { secret, scope: localScope });
    const b = new HostingControl(poolB, localDvm, { secret, scope: localScope });
    const localResume = (generation: number, leaseMs: number, completionMs: number): HostingControlCommand => {
      const leaseExpiresAtMs = Date.now() + leaseMs;
      return { action: "resume", version: 2, dvmId: localDvm, scope: localScope,
        timestampMs: Date.now(), nonce: `nonce_${randomUUID().replaceAll("-", "")}`,
        generation, leaseExpiresAtMs, deadlineMs: leaseExpiresAtMs + completionMs };
    };
    await a.init();
    try {
      const first = localResume(1, 2_000, 500);
      expect(await a.transition(first)).toBe("ok");
      await b.init();
      expect((await b.status()).state).toBe("accepting");
      expect(await a.admit("old-run", "old-job")).toBe(true);
      const lock = await poolA.connect();
      try {
        await lock.query("BEGIN");
        await lock.query("SELECT 1 FROM sdk_hosting_control WHERE dvm_id=$1 AND scope=$2 FOR UPDATE", [localDvm, localScope]);
        const waiting = b.admit("late-run", "late-job");
        await new Promise((resolve) => setTimeout(resolve, 2_100));
        await lock.query("COMMIT");
        expect(await waiting).toBe(false);
      } finally {
        await lock.query("ROLLBACK").catch(() => undefined);
        lock.release();
      }
      const expired = await b.status();
      expect(expired.state).toBe("draining");
      expect(expired.leaseExpiresAtMs).toBe(first.leaseExpiresAtMs);
      expect(expired.pendingAdmissions.map((item) => item.workId)).toEqual(["old-job"]);
      const second = localResume(2, 3_000, 1000);
      expect(await b.transition(second)).toBe("ok");
      expect(await b.admit("new-run", "new-job")).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(await a.dispatchDeadlineReached("old-job")).toBe(true);
      expect(await a.dispatchDeadlineReached("new-job")).toBe(false);
      expect((await a.status()).state).toBe("accepting");
      expect(await a.transition(first)).toBe("conflict");
    } finally {
      await poolA.query("DELETE FROM sdk_hosting_admissions WHERE dvm_id=$1", [localDvm]);
      await poolA.query("DELETE FROM sdk_hosting_nonces WHERE dvm_id=$1", [localDvm]);
      await poolA.query("DELETE FROM sdk_hosting_control WHERE dvm_id=$1", [localDvm]);
    }
  });

  it("refuses a direct SDK submit after drain before the handler or any payment path runs", async () => {
    const descriptor = configureDVM({
      name: "hosting-test", capability: "echo", tag: "test", idleTimeout: 120,
      onJob(ctx) { ctx.complete("done"); },
    });
    const server = await createDVMServer(descriptor, {
      env: {}, store: new MemoryKVStore(), jobStore: store, db: poolA, dvmId,
      devMode: true, hostingControl: { secret, scope },
    });
    try {
      const drain = command("drain", { generation: 5, deadlineMs: Date.now() + 30_000 });
      const controlled = await server.app.request("/_hosting/control", {
        method: "POST", headers: { "Content-Type": "application/json", "X-DVM-Hosting-Signature": signHostingControl(secret, drain) },
        body: JSON.stringify(drain),
      });
      expect(controlled.status).toBe(200);
      const response = await server.app.request("/v1/job", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ capability: "echo", input: "hello" }),
      });
      expect(response.status).toBe(503);
      expect((await response.json()).error).toBe("hosting_draining");
      const unauthenticated = await server.app.request("/_hosting/status", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(command("status")),
      });
      expect(unauthenticated.status).toBe(401);
      const statusCommand = command("status");
      const status = await server.app.request("/_hosting/status", {
        method: "POST", headers: { "Content-Type": "application/json",
          "X-DVM-Hosting-Signature": signHostingControl(secret, statusCommand) },
        body: JSON.stringify(statusCommand),
      });
      expect(status.status).toBe(200);
      // The platform reads this to learn the deployment states job identity in the response head.
      expect((await status.json()).jobIdentityHeader).toBe("v1");
    } finally {
      await server.shutdown();
    }
  });

  it("closes a direct endpoint when its signed lease expires without a platform request", async () => {
    const localDvm = `test-${randomUUID()}`;
    const localScope = `deployment-${randomUUID()}`;
    let ran = 0;
    const descriptor = configureDVM({
      name: "hosting-expiry", capability: "echo", tag: "test",
      onJob(ctx) { ran++; ctx.complete("done"); },
    });
    const server = await createDVMServer(descriptor, {
      env: {}, store: new MemoryKVStore(), jobStore: store, db: poolA, dvmId: localDvm,
      devMode: true, hostingControl: { secret, scope: localScope },
    });
    const submit = () => server.app.request("/v1/job", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ capability: "echo", input: "hello" }),
    });
    try {
      expect((await submit()).status).toBe(503);
      const leaseExpiresAtMs = Date.now() + 2_000;
      const lease: HostingControlCommand = {
        version: 2, action: "resume", dvmId: localDvm, scope: localScope,
        timestampMs: Date.now(), nonce: `nonce_${randomUUID().replaceAll("-", "")}`,
        generation: 1, leaseExpiresAtMs, deadlineMs: leaseExpiresAtMs + 500,
      };
      const resumed = await server.app.request("/_hosting/control", {
        method: "POST", headers: { "Content-Type": "application/json",
          "X-DVM-Hosting-Signature": signHostingControl(secret, lease) },
        body: JSON.stringify(lease),
      });
      expect(resumed.status).toBe(200);
      expect(await resumed.json()).toMatchObject({ state: "accepting", generation: 1, leaseExpiresAtMs });
      await new Promise((resolve) => setTimeout(resolve, 2_100));
      expect((await submit()).status).toBe(503);
      expect(ran).toBe(0);
      const control = new HostingControl(poolB, localDvm, { secret, scope: localScope });
      expect((await control.status()).state).toBe("draining");
      expect((await control.status()).deadlineMs).toBe(lease.deadlineMs);
    } finally {
      await server.shutdown();
      await poolA.query("DELETE FROM sdk_hosting_admissions WHERE dvm_id=$1", [localDvm]);
      await poolA.query("DELETE FROM sdk_hosting_nonces WHERE dvm_id=$1", [localDvm]);
      await poolA.query("DELETE FROM sdk_hosting_control WHERE dvm_id=$1", [localDvm]);
    }
  });

  it("does not dispatch an admitted request that finishes pricing after its completion deadline", async () => {
    const localDvm = `test-${randomUUID()}`;
    const localScope = `deployment-${randomUUID()}`;
    let releaseQuote: (() => void) | undefined;
    let enteredQuote: (() => void) | undefined;
    const blockedQuote = new Promise<void>((resolve) => { releaseQuote = resolve; });
    const quoteEntered = new Promise<void>((resolve) => { enteredQuote = resolve; });
    let ran = 0;
    const descriptor = configureDVM({
      name: "hosting-pending", capability: "echo", tag: "test",
      onQuote: { schema: z.any(), async handler() {
        enteredQuote?.();
        await blockedQuote;
        return { upfront: { amount: 0, currency: "usd" as const }, description: "free" };
      } },
      onJob(ctx) { ran++; ctx.complete("too late"); },
    });
    const server = await createDVMServer(descriptor, {
      env: {}, store: new MemoryKVStore(), jobStore: store, db: poolA, dvmId: localDvm,
      devMode: true, hostingControl: { secret, scope: localScope },
    });
    const control = new HostingControl(poolB, localDvm, { secret, scope: localScope });
    try {
      const leaseExpiresAtMs = Date.now() + 2_000;
      expect(await control.transition({
        version: 2, action: "resume", dvmId: localDvm, scope: localScope,
        timestampMs: Date.now(), nonce: `nonce_${randomUUID().replaceAll("-", "")}`,
        generation: 1, leaseExpiresAtMs, deadlineMs: leaseExpiresAtMs + 150,
      })).toBe("ok");
      const submission = server.app.request("/v1/job", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ capability: "echo", input: "hello" }),
      });
      await quoteEntered;
      expect((await control.status()).pendingAdmissionCount).toBe(1);
      await new Promise((resolve) => setTimeout(resolve, 2_300));
      expect((await control.status()).state).toBe("draining");
      releaseQuote?.();
      const response = await submission;
      expect([200, 202]).toContain(response.status);
      const terminalBody = await response.json() as { job_id: string };
      const jobId = terminalBody.job_id;
      expectJobIdentity(response, terminalBody);
      expect((await store.get(jobId))?.status).toBe("cancelled");
      expect(ran).toBe(0);
    } finally {
      releaseQuote?.();
      await server.shutdown();
      await poolA.query("DELETE FROM sdk_hosting_admissions WHERE dvm_id=$1", [localDvm]);
      await poolA.query("DELETE FROM sdk_hosting_nonces WHERE dvm_id=$1", [localDvm]);
      await poolA.query("DELETE FROM sdk_hosting_control WHERE dvm_id=$1", [localDvm]);
    }
  });

  it("keeps an ambiguous funding admission visible after expiry until its paid fact is durable", async () => {
    const localDvm = `test-${randomUUID()}`;
    const localScope = `deployment-${randomUUID()}`;
    const control = new HostingControl(poolA, localDvm, { secret, scope: localScope });
    const ledger = new CreditLedger(poolA);
    await ledger.init();
    await control.init();
    const creditId = `credit-${randomUUID()}`;
    const fundId = `fund-${randomUUID()}`;
    const admissionId = randomUUID();
    try {
      const leaseExpiresAtMs = Date.now() + 2_000;
      expect(await control.transition({
        version: 2, action: "resume", dvmId: localDvm, scope: localScope,
        timestampMs: Date.now(), nonce: `nonce_${randomUUID().replaceAll("-", "")}`,
        generation: 1, leaseExpiresAtMs, deadlineMs: leaseExpiresAtMs + 500,
      })).toBe("ok");
      expect(await control.admit(admissionId, `credit-fund:${creditId}:${fundId}`, { creditId, fundId })).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 2_100));
      await control.finishAdmission(admissionId, "unresolved");
      expect((await control.status()).unresolvedAdmissions).toEqual([
        { admissionId, jobId: `credit-fund:${creditId}:${fundId}` },
      ]);
      await ledger.fund({
        creditId, callerPubkey: "1".repeat(64), currency: "usd", amountMicro: 300_000,
        expiryMs: Date.now() + 3_600_000,
        basis: { rail: "cashu", paidMsats: 300_000, fundingRef: `proof-${fundId}` },
      });
      await ledger.recordFunding({ creditId, fundId, amountMicro: 300_000, rail: "cashu" });
      expect((await control.status()).unresolvedAdmissionCount).toBe(0);
      expect((await control.status()).state).toBe("draining");
    } finally {
      await poolA.query("DELETE FROM sdk_hosting_admissions WHERE dvm_id=$1", [localDvm]);
      await poolA.query("DELETE FROM sdk_hosting_nonces WHERE dvm_id=$1", [localDvm]);
      await poolA.query("DELETE FROM sdk_hosting_control WHERE dvm_id=$1", [localDvm]);
    }
  });

  it("persists deadline cancellation even when the handler ignores abort and tries to complete later", async () => {
    const control = new HostingControl(poolB, dvmId, { secret, scope });
    expect(await control.transition(resume(6))).toBe("ok");
    let finishHandler: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => { finishHandler = resolve; });
    const descriptor = configureDVM({
      name: "hosting-long-job", capability: "wait", tag: "test", idleTimeout: 120,
      async onJob(ctx) {
        await blocked;
        ctx.complete("late completion must not win");
      },
    });
    const server = await createDVMServer(descriptor, {
      env: {}, store: new MemoryKVStore(), jobStore: store, db: poolA, dvmId,
      devMode: true, hostingControl: { secret, scope },
    });
    try {
      const accepted = await server.app.request("/v1/job", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ capability: "wait", input: "hello" }),
      });
      expect(accepted.status).toBe(202);
      const { job_id: jobId } = await accepted.json() as { job_id: string };
      expect((await control.status()).activeJobIds).toContain(jobId);
      expect(await control.transition(command("drain", { generation: 7, deadlineMs: Date.now() + 500 }))).toBe("ok");
      for (let attempt = 0; attempt < 30 && (await store.get(jobId))?.status !== "cancelled"; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(await control.dispatchDeadlineReached(jobId)).toBe(true);
      expect((await store.get(jobId))?.status).toBe("cancelled");
      finishHandler?.();
      await new Promise((resolve) => setTimeout(resolve, 100));
      const durable = await store.get(jobId);
      expect(durable?.status).toBe("cancelled");
      expect(durable?.endedBy).toBe("provider");
      expect(durable?.messages.some((message) => message.type === "cancel")).toBe(true);
      expect(durable?.summary).not.toBe("late completion must not win");
    } finally {
      finishHandler?.();
      await server.shutdown();
    }
  });

  it("blocks new credit funding while leaving authenticated balance recovery reachable", async () => {
    const ledger = new CreditLedger(poolA);
    await ledger.init();
    const descriptor = configureDVM({
      name: "hosting-credit", capability: "echo", tag: "test", price: "$0.10",
      onJob(ctx) { ctx.complete("done"); },
      credit: { min: "$0.10", max: "$5.00" },
      auth: secp256k1Auth(),
    });
    const server = await createDVMServer(descriptor, {
      env: {}, store: new MemoryKVStore(), jobStore: store, db: poolA, dvmId,
      creditLedger: ledger, hostingControl: { secret, scope },
      x402: { facilitator: "https://payments.example.com", network: "eip155:8453", payTo: "0x1111111111111111111111111111111111111111" },
    });
    const signer = createSignedRequestVerifier(CREDIT_REQUEST_SCHEMA);
    const key = new Uint8Array(32).fill(13);
    const callerPubkey = Buffer.from(schnorr.getPublicKey(key)).toString("hex");
    try {
      const fund = signer.signRequest(key, {
        op: "fund", fund: { amount_micro: 300_000, fund_id: `fund-${randomUUID()}`, commitment: "0".repeat(64) },
      });
      const refused = await server.app.request("/v1/credit", {
        method: "POST", headers: { "Content-Type": "application/json", "X-PAYMENT": "unused-payment-proof" },
        body: JSON.stringify(fund),
      });
      expect(refused.status).toBe(503);
      expect((await refused.json()).error).toBe("hosting_draining");

      const creditId = `credit-${randomUUID()}`;
      const fundId = `fund-${randomUUID()}`;
      await ledger.fund({
        creditId, callerPubkey, currency: "usd", amountMicro: 300_000,
        expiryMs: Date.now() + 3_600_000,
        basis: { rail: "cashu", paidMsats: 300_000, fundingRef: `proof-${fundId}` },
      });
      await ledger.recordFunding({ creditId, fundId, amountMicro: 300_000, rail: "cashu" });
      const replay = signer.signRequest(key, {
        op: "fund", credit_id: creditId,
        fund: { amount_micro: 300_000, fund_id: fundId, commitment: "0".repeat(64) },
      });
      const recovered = await server.app.request("/v1/credit", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(replay),
      });
      expect(recovered.status).toBe(200);
      expect((await recovered.json()).replayed).toBe(true);

      const balance = signer.signRequest(key, { op: "balance" });
      const readable = await server.app.request("/v1/credit", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(balance),
      });
      expect(readable.status).toBe(200);
      expect((await readable.json()).op).toBe("balance");
    } finally {
      await server.shutdown();
    }
  });

  it("recovers only the original job for an already admitted payment artifact", async () => {
    const control = new HostingControl(poolB, dvmId, { secret, scope });
    expect(await control.transition(resume(8))).toBe("ok");
    const descriptor = configureDVM({
      name: "hosting-replay", capability: "echo", tag: "test",
      async onJob(ctx) { ctx.complete("done"); },
    });
    const server = await createDVMServer(descriptor, {
      env: {}, store: new MemoryKVStore(), jobStore: store, db: poolA, dvmId,
      devMode: true, hostingControl: { secret, scope },
    });
    const submit = (artifact: string, input: string) => server.app.request("/v1/job", {
      method: "POST", headers: { "Content-Type": "application/json", "X-Cashu": artifact },
      body: JSON.stringify({ capability: "echo", input }),
    });
    try {
      const accepted = await submit("test-artifact-one", "same request");
      expect([200, 202]).toContain(accepted.status);
      const original = await accepted.json() as { job_id: string; job_token: string };
      expect(await control.transition(command("drain", { generation: 9, deadlineMs: Date.now() + 30_000 }))).toBe("ok");
      const recovered = await submit("test-artifact-one", "same request");
      expect([200, 202]).toContain(recovered.status);
      const recoveredBody = await recovered.json() as { job_id: string };
      expect(recoveredBody).toMatchObject({ job_id: original.job_id, job_token: original.job_token });
      expectJobIdentity(recovered, recoveredBody);
      const refused = await submit("test-artifact-two", "same request");
      expect(refused.status).toBe(503);
      expectNoJobIdentity(refused);
      expect((await submit("test-artifact-one", "changed request")).status).toBe(503);
      expect(await control.transition(resume(10, 2_000))).toBe("ok");
      await new Promise((resolve) => setTimeout(resolve, 2_100));
      expect((await control.status()).state).toBe("draining");
      const expiredReplay = await submit("test-artifact-one", "same request");
      expect([200, 202]).toContain(expiredReplay.status);
      expect(await expiredReplay.json()).toMatchObject({ job_id: original.job_id, job_token: original.job_token });
      expect((await submit("test-artifact-one", "changed request")).status).toBe(503);
    } finally {
      await server.shutdown();
    }
  });

  it("drains only its scoped jobs and reports pre-control jobs as unowned", async () => {
    const sharedDvmId = `test-${randomUUID()}`;
    const scopeA = `deployment-${randomUUID()}`;
    const scopeB = `deployment-${randomUUID()}`;
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const descriptor = configureDVM({
      name: "hosting-scope", capability: "wait", tag: "test", idleTimeout: 120,
      async onJob(ctx) { await blocked; ctx.complete("done"); },
    });
    const common = { env: {}, store: new MemoryKVStore(), jobStore: store, db: poolA,
      dvmId: sharedDvmId, devMode: true };
    const serverA = await createDVMServer(descriptor, {
      ...common, hostingControl: { secret, scope: scopeA },
    });
    const serverB = await createDVMServer(descriptor, {
      ...common, hostingControl: { secret, scope: scopeB },
    });
    const legacy = await createDVMServer(descriptor, common);
    const submit = (server: typeof serverB) => server.app.request("/v1/job", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ capability: "wait", input: "hello" }),
    });
    let scopedJob: string | undefined;
    let legacyJob: string | undefined;
    try {
      expect((await submit(serverB)).status).toBe(503);
      const controlB = new HostingControl(poolB, sharedDvmId, { secret, scope: scopeB });
      const scopeLease = Date.now() + 30_000;
      expect(await controlB.transition({
        action: "resume", version: 2, dvmId: sharedDvmId, scope: scopeB,
        timestampMs: Date.now(), nonce: `nonce_${randomUUID().replaceAll("-", "")}`,
        generation: 1, leaseExpiresAtMs: scopeLease, deadlineMs: scopeLease + 30_000,
      })).toBe("ok");
      scopedJob = (await (await submit(serverB)).json() as { job_id: string }).job_id;
      legacyJob = (await (await submit(legacy)).json() as { job_id: string }).job_id;
      const controlA = new HostingControl(poolB, sharedDvmId, { secret, scope: scopeA });
      const before = await controlA.status();
      expect(before.activeJobIds).not.toContain(scopedJob);
      expect(before.activeJobIds).not.toContain(legacyJob);
      expect(before.unownedActiveJobIds).toContain(legacyJob);
      expect(before.unownedActiveJobIds).not.toContain(scopedJob);
      expect((await controlB.status()).activeJobIds).toContain(scopedJob);

      expect(await controlA.transition({
        action: "drain", dvmId: sharedDvmId, scope: scopeA,
        timestampMs: Date.now(), nonce: `nonce_${randomUUID().replaceAll("-", "")}`,
        generation: 1, deadlineMs: Date.now() + 100,
      })).toBe("ok");
      await new Promise((resolve) => setTimeout(resolve, 1200));
      expect((await store.get(scopedJob))?.status).not.toBe("cancelled");
      expect((await store.get(legacyJob))?.status).not.toBe("cancelled");
      expect((await controlA.status()).unownedActiveJobIds).toContain(legacyJob);
    } finally {
      release?.();
      for (let attempt = 0; attempt < 50 && scopedJob && legacyJob; attempt++) {
        const jobs = await Promise.all([store.get(scopedJob), store.get(legacyJob)]);
        if (jobs.every((job) => job && ["completed", "failed", "cancelled"].includes(job.status))) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      await Promise.all([serverA.shutdown(), serverB.shutdown(), legacy.shutdown()]);
      await poolA.query("DELETE FROM sdk_hosting_admissions WHERE dvm_id=$1", [sharedDvmId]);
      await poolA.query("DELETE FROM sdk_hosting_control WHERE dvm_id=$1", [sharedDvmId]);
    }
  });
});
