import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { schnorr } from "@noble/curves/secp256k1.js";
import { configureDVM } from "@dvmkit/sdk";
import {
  createDVMHost, installAdminContentRoutes,
  MemoryConsumedCredentialStore, contentMetadata,
} from "@dvmkit/sdk/server";
import { MemoryJobStore } from "@dvmkit/sdk/testing";

const fixture = JSON.parse(readFileSync(new URL("./job-content-retention-v1.json", import.meta.url), "utf8"));
const secret = Buffer.from("11".repeat(32), "hex");
const actor = /** @type {Awaited<ReturnType<import("@dvmkit/sdk/server").InstallAdminContentRoutesOpts["getLockPubkeyState"]>>["current"]} */ (`02${Buffer.from(schnorr.getPublicKey(secret)).toString("hex")}`);
const now = 1760000000000;
/** @type {import("@dvmkit/sdk/server").JobRecord} */
const job = { id: "packed-job", tags: [], capability: "work", input: "private input", params: {}, requesterId: "caller", status: "completed", summary: "private output", messages: [], seq: 0, paidMsats: 0, receivedProofs: [], stepCache: [], state: {}, createdAt: fixture.last_activity_at, lastActivityAt: fixture.last_activity_at };
assert.equal(configureDVM({ name: "example", capability: "work", onJob() {} }).jobRetentionDays, 730);
assert.deepEqual(contentMetadata(job, 730), fixture.metadata[0].expected);
const store = new MemoryJobStore();
await store.save(job);
const host = createDVMHost({ env: {}, devMode: true, jobStore: store });
installAdminContentRoutes(host.app, {
  dvmId: "example-dvm", store, retentionDays: 730, now: () => now,
  getLockPubkeyState: async () => ({ current: actor, retired: [] }),
  nonceStore: new MemoryConsumedCredentialStore(),
});
host.mount(configureDVM({ name: "example", capability: "work", onJob(ctx) { ctx.complete("ok"); } }));
const server = await host.serve({ port: 0 });
try {
  const submitted = await fetch(server.url + "/v1/job", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ capability: "work", input: "hello" }) });
  assert.equal(submitted.status, 200);
  const submittedBody = await submitted.json();
  assert.equal(submittedBody.content_available, true);
  assert.equal(typeof submittedBody.content_expires_at, "number");
  const path = "/admin/jobs/packed-job/content-holds";
  const nonce = randomBytes(16).toString("hex");
  const unix = String(Math.floor(now / 1000));
  const digest = new TextEncoder().encode(`dvmkit-admin:POST:${path}:example-dvm:${nonce}:${unix}`);
  // Portable admin clients sign the same challenge bytes as the existing builder CLI.
  const { sha256 } = await import("@noble/hashes/sha2.js");
  const signature = Buffer.from(schnorr.sign(sha256(digest), secret)).toString("hex");
  const request = { method: "POST", headers: { Authorization: `P2PK ${nonce}.${unix}.${signature}`, "Content-Type": "application/json" }, body: JSON.stringify(fixture.place) };
  const response = await fetch(server.url + path, request);
  assert.equal(response.status, 201);
  const body = await response.json();
  assert.equal(body.content_expires_at, null);
  assert.equal(body.baseline_content_expires_at, 1763072000000);
  assert.equal(body.events[0].actor, actor);
  assert.equal(body.holds[0].review_overdue, false);
  assert.equal(JSON.stringify(body).includes("private output"), false);
  assert.equal((await fetch(server.url + path, request)).status, 401);
  assert.equal(await store.redactJob({ jobId: job.id, expectedLastActivityAt: job.lastActivityAt, redactedAt: now }), false);
} finally { await server.close(); }
assert.match(readFileSync(process.argv[2], "utf8"), /dvmkit-financial-evidence/);
console.log("packed content retention: wire metadata, signed admin hold, replay, sweep fence, packaged export recipe passed");
