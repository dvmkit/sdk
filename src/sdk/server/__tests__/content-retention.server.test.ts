import { readFileSync } from "node:fs";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { servedApps } from "../../../test-support/served-app";
import { configureDVM } from "../../configure";
import { MemoryKVStore } from "../../store";
import { installAdminContentRoutes } from "../admin-content";
import { createDVMServer } from "../app";
import { MemoryConsumedCredentialStore } from "../consumed-credential-store";
import { contentMetadata, type ContentHold } from "../content-retention";
import type { JobStatus, JobStore } from "../job-store";
import { toLockPubkey } from "../lock-pubkey-store";
import { MemoryJobStore } from "../memory-job-store";
import { ACTIVITY, ADMIN_KEY, TOKEN, adminHeader, contentJob } from "./__helpers__/content-fixtures";

const fixture = JSON.parse(readFileSync(new URL("../../../../protocol-fixtures/job-content-retention-v1.json", import.meta.url), "utf8"));
const servers = servedApps();

function adminApp(store: JobStore, now: () => number = Date.now, current = ADMIN_KEY) {
  const app = new Hono();
  installAdminContentRoutes(app, {
    dvmId: "example-dvm", store, retentionDays: 730, now,
    nonceStore: new MemoryConsumedCredentialStore(),
    getLockPubkeyState: async () => ({ current: toLockPubkey(current), retired: current === ADMIN_KEY ? [] : [{ pubkey: toLockPubkey(ADMIN_KEY), retiredAtMs: now() }] }),
  });
  return app;
}

describe("job content expiry", () => {
  it("uses independently specified portable deadlines including disabled, held and redacted states", () => {
    expect(configureDVM({ name: "example", capability: "work", onJob() {} }).jobRetentionDays).toBe(730);
    for (const row of fixture.metadata) {
      const job = { ...contentJob(), status: row.status as JobStatus, redactedAt: row.redacted ? ACTIVITY + 1 : undefined };
      const holds: ContentHold[] = row.held ? [{ id: "hold", job_id: job.id, purpose: "support", reason: "case", actor: ADMIN_KEY, created_at: 1, review_due_at: 2, cleared_at: null }] : [];
      expect(contentMetadata(job, row.days, holds)).toEqual(row.expected);
    }
    expect(() => configureDVM({ name: "example", capability: "work", onJob() {}, jobRetentionDays: Number.MAX_SAFE_INTEGER })).toThrow();
  });

  it("keeps an active response deadline null when completion overlaps its metadata read", async () => {
    let entered!: () => void;
    let release!: () => void;
    const reading = new Promise<void>((resolve) => { entered = resolve; });
    const resume = new Promise<void>((resolve) => { release = resolve; });
    class RacingStore extends MemoryJobStore {
      override async getContentSnapshot(id: string) {
        entered();
        await resume;
        return super.getContentSnapshot(id);
      }
    }
    const store = new RacingStore();
    await store.save({ ...contentJob(), status: "processing" });
    const runtime = await createDVMServer(configureDVM({ name: "example", capability: "work", onJob() {} }), { env: {}, store: new MemoryKVStore(), jobStore: store, devMode: true });
    try {
      const pending = runtime.app.request("/v1/job/example-job", { headers: { "X-Job-Token": TOKEN } });
      await reading;
      await store.save({ ...contentJob(), lastActivityAt: ACTIVITY + 100 });
      release();
      expect(await (await pending).json()).toMatchObject({ status: "processing", content_expires_at: null, content_available: true });
    } finally { release(); runtime.jobManager.shutdown(); }
  });

  it("keeps cached and stored SSE empty after a committed sweep while preserving event bytes before it", async () => {
    const store = new MemoryJobStore();
    const runtime = await createDVMServer(configureDVM({ name: "example", capability: "work", jobRetentionDays: 1, onJob(ctx) { ctx.complete("private SSE output"); } }), { env: {}, store: new MemoryKVStore(), jobStore: store, devMode: true });
    const now = Date.now;
    try {
      const body = await (await runtime.app.request("/v1/job", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ capability: "work", input: "private input" }) })).json();
      const path = `/v1/job/${body.job_id}/messages`;
      const headers = { "X-Job-Token": body.job_token, Accept: "text/event-stream" };
      const cached = await (await runtime.app.request(path, { headers })).text();
      const job = runtime.jobManager.activeJobs.get(body.job_id)!;
      runtime.jobManager.activeJobs.delete(body.job_id);
      const stored = await (await runtime.app.request(path, { headers })).text();
      const event = (bytes: string) => JSON.parse(bytes.split("data: ")[1].trim());
      expect(event(stored)).toEqual(event(cached));
      expect(cached).toContain("private SSE output");
      runtime.jobManager.activeJobs.set(body.job_id, job);
      Date.now = () => now() + 2 * 86400000;
      expect((await runtime.jobManager.sweepJobRetention()).redacted).toBe(1);
      expect(await (await runtime.app.request(path, { headers })).text()).toBe("");
      runtime.jobManager.activeJobs.delete(body.job_id);
      expect(await (await runtime.app.request(path, { headers })).text()).toBe("");
    } finally { Date.now = now; runtime.jobManager.shutdown(); }
  });

  it("uses one submit snapshot when completion occurs during its metadata read", async () => {
    let entered!: () => void;
    let release!: () => void;
    let complete!: () => void;
    const reading = new Promise<void>((resolve) => { entered = resolve; });
    const resume = new Promise<void>((resolve) => { release = resolve; });
    class RacingStore extends MemoryJobStore {
      override async getContentSnapshot(id: string) { entered(); await resume; return super.getContentSnapshot(id); }
    }
    const runtime = await createDVMServer(configureDVM({ name: "example", capability: "work", onJob(ctx) { complete = () => ctx.complete("finished"); } }), { env: {}, store: new MemoryKVStore(), jobStore: new RacingStore(), devMode: true });
    try {
      const pending = runtime.app.request("/v1/job", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ capability: "work", input: "hello" }) });
      await reading;
      complete();
      await [...runtime.jobManager.activeJobs.values()][0].terminalWork;
      release();
      const response = await pending;
      const body = await response.json();
      expect(response.status).toBe(202);
      expect(body.content_expires_at).toBeNull();
      expect(body).not.toHaveProperty("summary");
      expect(body).not.toHaveProperty("status", "completed");
    } finally { release(); runtime.jobManager.shutdown(); }
  });

  it("freezes terminal activity across late writes and authenticated status/message reads", async () => {
    const store = new MemoryJobStore();
    await store.save(contentJob());
    await store.save({ ...contentJob(), lastActivityAt: Date.now() });
    await store.appendOutgoing("example-job", { from: "provider", type: "text", timestamp: 1, content: { text: "late message" } });
    expect((await store.get("example-job"))?.lastActivityAt).toBe(ACTIVITY);
    const descriptor = configureDVM({ name: "example", capability: "work", onJob() {} });
    const runtime = await createDVMServer(descriptor, { env: {}, store: new MemoryKVStore(), jobStore: store, devMode: true });
    try {
      const url = await servers.serve(runtime.app);
      expect((await fetch(`${url}/v1/job/example-job`)).status).toBe(401);
      expect((await fetch(`${url}/v1/job/example-job`, { headers: { "X-Job-Token": "wrong" } })).status).toBe(404);
      for (const path of ["", "/messages"]) {
        const response = await fetch(`${url}/v1/job/example-job${path}`, { headers: { "X-Job-Token": TOKEN } });
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ content_expires_at: 1763072000000, content_available: true });
      }
      expect((await store.get("example-job"))?.lastActivityAt).toBe(ACTIVITY);
      await store.redactJob({ jobId: "example-job", expectedLastActivityAt: ACTIVITY, redactedAt: Date.now() });
      const response = await fetch(`${url}/v1/job/example-job`, { headers: { "X-Job-Token": TOKEN } });
      const body = await response.json();
      expect(body).toMatchObject({ status: "completed", content_available: false, content_expires_at: 1763072000000 });
      expect(body).not.toHaveProperty("summary");
    } finally { runtime.jobManager.shutdown(); }
  });
});

describe("signed case holds", () => {
  it("composes holds and retains immutable actor/history when overdue, renewed and cleared", async () => {
    let now = 1760000000000;
    const store = new MemoryJobStore();
    await store.save(contentJob());
    const url = await servers.serve(adminApp(store, () => now));
    const path = "/admin/jobs/example-job/content-holds";
    async function send(route: string, body?: object, secret?: string) {
      const method = body ? "POST" : "GET";
      const response = await fetch(url + route, { method, headers: { Authorization: adminHeader(method, route, now, secret), "Content-Type": "application/json" }, ...(body && { body: JSON.stringify(body) }) });
      return { status: response.status, body: await response.json() };
    }
    const first = await send(path, fixture.place);
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ content_expires_at: null, baseline_content_expires_at: 1763072000000, content_available: true });
    const id = first.body.holds[0].id;
    expect(first.body.holds[0]).toMatchObject({ actor: ADMIN_KEY, created_at: now, cleared_at: null, review_overdue: false });
    const placedEvent = first.body.events[0];
    const second = await send(path, { ...fixture.place, purpose: "support" });
    expect(second.body.holds).toHaveLength(2);
    now += 60001;
    expect((await send(path)).body.holds.every((hold: ContentHold & { review_overdue: boolean }) => hold.review_overdue)).toBe(true);
    expect(await store.redactJob({ jobId: "example-job", expectedLastActivityAt: ACTIVITY, redactedAt: now })).toBe(false);
    const renewed = await send(`${path}/${id}/renew`, fixture.renew);
    expect(renewed.body.events[0]).toEqual(placedEvent);
    expect(renewed.body.events[2]).toMatchObject({ action: "renewed", actor: ADMIN_KEY, review_due_at: fixture.renew.review_due_at });
    expect((await send(`${path}/${id}/clear`, fixture.clear)).body.content_expires_at).toBeNull();
    const other = second.body.holds.find((hold: ContentHold) => hold.id !== id).id;
    const cleared = await send(`${path}/${other}/clear`, fixture.clear);
    expect(cleared.body.content_expires_at).toBe(1763072000000);
    expect(cleared.body.events.map((event: { action: string }) => event.action)).toEqual(["placed", "placed", "renewed", "cleared", "cleared"]);
    expect((await send(`${path}/${id}/renew`, fixture.renew)).status).toBe(409);
    expect(await store.redactJob({ jobId: "example-job", expectedLastActivityAt: ACTIVITY, redactedAt: now })).toBe(true);
    expect((await send(path, { ...fixture.place, review_due_at: now + 60000 })).body.error).toBe("content_unavailable");
  });

  it("rejects wrong service, signer, path, stale timestamps and injected identity; concurrent replay has one winner", async () => {
    const now = 1760000000000;
    const store = new MemoryJobStore();
    await store.save(contentJob());
    const url = await servers.serve(adminApp(store, () => now));
    const path = "/admin/jobs/example-job/content-holds";
    async function post(header: string, body = fixture.place) {
      return fetch(url + path, { method: "POST", headers: { Authorization: header, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    }
    for (const header of [adminHeader("POST", path, now, "22".repeat(32)), adminHeader("POST", path, now, undefined, "other-service"), adminHeader("GET", path, now), adminHeader("POST", path, now - 300000), "P2PK malformed"]) expect((await post(header)).status).toBe(401);
    expect((await post(adminHeader("POST", path, now), { ...fixture.place, actor: "forged" })).status).toBe(400);
    const header = adminHeader("POST", path, now);
    const results = await Promise.all([post(header), post(header)]);
    expect(results.map((response) => response.status).sort()).toEqual([201, 401]);
    expect((await store.getContentSnapshot("example-job"))?.history.events).toHaveLength(1);
    expect((await post(header)).status).toBe(401);
  });

  it("validates dates, reasons and purposes before any durable mutation", async () => {
    const now = 1760000000000;
    const store = new MemoryJobStore();
    await store.save(contentJob());
    const app = adminApp(store, () => now);
    const path = "/admin/jobs/example-job/content-holds";
    for (const body of [
      { ...fixture.place, purpose: "archive" },
      { ...fixture.place, reason: " " },
      { ...fixture.place, reason: "x".repeat(1001) },
      { ...fixture.place, review_due_at: Math.floor(now / 1000) },
      { ...fixture.place, review_due_at: now },
      { ...fixture.place, review_due_at: now + 0.5 },
    ]) {
      const response = await app.request(path, { method: "POST", headers: { Authorization: adminHeader("POST", path, now), "Content-Type": "application/json" }, body: JSON.stringify(body) });
      expect(response.status).toBe(400);
    }
    expect((await store.getContentSnapshot("example-job"))?.history).toEqual({ holds: [], events: [] });
    const missing = path.replace("example-job", "missing");
    const response = await app.request(missing, { headers: { Authorization: adminHeader("GET", missing, now) } });
    expect(response.status).toBe(404);
  });

  it("reports unsupported custom stores without inventing expiry or availability", async () => {
    const store = new MemoryJobStore();
    await store.save(contentJob());
    const custom: JobStore = {
      get: store.get.bind(store), save: store.save.bind(store), delete: store.delete.bind(store),
      findJobByPaymentTxHash: store.findJobByPaymentTxHash.bind(store),
    };
    const admin = adminApp(custom);
    const path = "/admin/jobs/example-job/content-holds";
    const refusal = await admin.request(path, { headers: { Authorization: adminHeader("GET", path) } });
    expect(refusal.status).toBe(503);
    expect(await refusal.json()).toMatchObject({ error: "content_holds_unavailable" });
    const runtime = await createDVMServer(configureDVM({ name: "example", capability: "work", onJob() {} }), { env: {}, store: new MemoryKVStore(), jobStore: custom, devMode: true });
    try {
      const response = await runtime.app.request("/v1/job/example-job", { headers: { "X-Job-Token": TOKEN } });
      const body = await response.json();
      expect(body.status).toBe("completed");
      expect(body).not.toHaveProperty("content_expires_at");
      expect(body).not.toHaveProperty("content_available");
    } finally { runtime.jobManager.shutdown(); }
  });

  it("attributes a grace-period signer to that key rather than the current key", async () => {
    const store = new MemoryJobStore();
    await store.save(contentJob());
    const url = await servers.serve(adminApp(store, Date.now, `02${"ab".repeat(32)}`));
    const path = "/admin/jobs/example-job/content-holds";
    const response = await fetch(url + path, { method: "POST", headers: { Authorization: adminHeader("POST", path), "Content-Type": "application/json" }, body: JSON.stringify({ purpose: "support", reason: "case", review_due_at: Date.now() + 60000 }) });
    expect(response.status).toBe(201);
    expect((await response.json()).events[0].actor).toBe(ADMIN_KEY);
  });
});
