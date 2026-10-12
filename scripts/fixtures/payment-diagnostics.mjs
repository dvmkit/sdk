import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "node:http";

import { Amount, blindMessage, createDLEQProof, createNewMintKeys, getEncodedToken, hashToCurve } from "@cashu/cashu-ts";
import { Credential, Errors } from "mppx";
import { Mppx, tempo } from "mppx/server";
// Defaults capture state paths at import time; isolate them before loading the SDK.
const callerState = mkdtempSync(join(process.cwd(), ".payment-diagnostic-state-"));
process.env.DVM_CONFIG_DIR = join(callerState, "caller");
process.env.DVMKIT_CONFIG_DIR = join(callerState, "builder");
const [
  { FxRateUnavailableError },
  { MemoryConsumedCredentialStore, MemoryCreditLedger, MemoryProcessedPaymentStore },
  { initLoggers, SpanWriter, verifyIncomingPayment, verifyUpfrontPayment, wrapMppx, toLockPubkey },
] = await Promise.all([import("@dvmkit/sdk"), import("@dvmkit/sdk/server"), import("@dvmkit/sdk/internal")]);

const [archivePath, expectedVersion] = process.argv.slice(2);
assert.ok(archivePath && expectedVersion, "archive and exact version are required");
const manifest = JSON.parse(readFileSync("node_modules/@dvmkit/sdk/package.json", "utf8"));
assert.equal(manifest.version, expectedVersion);
const archive = readFileSync(archivePath);
const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
const integrity = `sha512-${createHash("sha512").update(archive).digest("base64")}`;
assert.equal(lock.packages["node_modules/@dvmkit/sdk"].integrity, integrity, "installed bytes must match the tested archive");

const pair = createNewMintKeys(4, new Uint8Array(32).fill(9), { versionByte: 0 });
const keys = Object.fromEntries(Object.entries(pair.pubKeys).map(([amount, key]) => [amount, hex(key)]));
const lockPubkey = toLockPubkey(keys["1"]);
let facilitatorMode = "verify_reject";
const mint = createServer(async (request, response) => {
  let data;
  const path = new URL(request.url ?? "/", "http://example.com").pathname;
  if (path === "/v1/info") {
    const methods = [{ method: "bolt11", unit: "sat" }];
    data = { nuts: { 4: { methods }, 5: { methods }, 7: { supported: true }, 9: { supported: true }, 10: { supported: true }, 11: { supported: true }, 12: { supported: true }, 20: { supported: true } } };
  } else if (path === "/v1/keysets") {
    data = { keysets: [{ id: pair.keysetId, unit: "sat", active: true, input_fee_ppk: 0 }] };
  } else if (path === "/v1/keys" || path.startsWith("/v1/keys/")) {
    data = { keysets: [{ id: pair.keysetId, unit: "sat", keys }] };
  } else if (path === "/v1/checkstate") {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    data = { states: body.Ys.map((/** @type {string} */ Y) => ({ Y, state: "UNSPENT" })) };
  } else if (path === "/verify") {
    if (facilitatorMode === "verify_throw") {
      response.end("SENTINEL_PROVIDER_BODY");
      return;
    }
    data = facilitatorMode === "verify_reject"
      ? { isValid: false, invalidReason: "SENTINEL_PROVIDER_REASON" }
      : { isValid: true };
  } else if (path === "/settle") {
    data = { success: false, errorReason: "SENTINEL_PROVIDER_REASON" };
  } else {
    response.statusCode = 404;
    response.end();
    return;
  }
  response.setHeader("Content-Type", "application/json");
  response.end(JSON.stringify(data));
});
await new Promise((resolve) => mint.listen(0, "127.0.0.1", () => resolve(undefined)));
const address = mint.address();
assert.ok(address && typeof address !== "string");
const mintUrl = `http://127.0.0.1:${address.port}`;
/** @type {import("@dvmkit/sdk/internal").SpanRow[]} */
const rows = [];
const writer = new SpanWriter({ send: async (batch) => { rows.push(...batch); } }, 60_000);
initLoggers(writer, "unknown");
/** @type {Record<string, unknown>[]} */
const warnings = [];
const originalWarn = console.warn;
console.warn = (value) => { warnings.push(JSON.parse(String(value))); };
let cashuCases = 0;
let credentialCases = 0;
try {
  const ledger = new MemoryCreditLedger();
  // The mint and accumulator storage are external boundaries; token decoding,
  // DLEQ, lock binding, proof-state checks and payment preflight use installed SDK code.
  const accumulatorDb = /** @type {import("@dvmkit/sdk/internal").AccumulatorPool} */ (/** @type {unknown} */ ({
    query: async () => ({ rows: [], rowCount: 1 }),
    connect: async () => ({ query: async () => ({ rows: [], rowCount: 1 }), release: () => undefined }),
  }));
  const cases = [
    { cause: "rate_unavailable", error: new TypeError("SENTINEL_RATE_URL https://example.com/?secret=SENTINEL") },
    { cause: "rate_stale_refused", error: new FxRateUnavailableError("SENTINEL_STALE", undefined, { staleDays: 6, staleSource: "example", thresholdDays: 5 }) },
  ];
  for (const [index, entry] of cases.entries()) {
    const requestId = `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
    const result = await verifyIncomingPayment({ type: "payment", content: {
      cashu_token: token(index), cashu_request_id: requestId,
    } }, {
      cashuMode: "p2pk-accumulator", accumulatorDb, lockPubkeys: [lockPubkey],
      mints: [mintUrl], dvmId: "example-dvm", jobId: `example-job-${index}`,
      creditLedger: ledger, processedPayments: new MemoryProcessedPaymentStore(),
      fxFetcher: { fetch: async () => { throw entry.error; }, supportedCurrencies: () => ["usd"], lastKnown: () => null },
    }, { pendingPaymentMsats: 8000, requesterPubkey: "11".repeat(32) });
    assert.equal(result.error, undefined);
    assert.equal(result.verified?.paidMsats, 8000);
    assert.equal(result.verified.creditId, undefined);
    assert.ok(warnings.some((row) => row.event === "credit_topup_skipped" && row.reason === "denomination_unavailable" && row.cause === entry.cause));
    cashuCases++;
  }

  // A real mppx challenge and HMAC bind the credential; only its external broadcast is synthetic.
  const method = tempo.charge({ recipient: `0x${"11".repeat(20)}`, currency: "0x20C000000000000000000000b9537d11c60E8b50", decimals: 6 });
  delete method.validate;
  /** @type {Error} */
  let failure = new Errors.InvalidChallengeError({ reason: "SENTINEL_CHALLENGE_REASON" });
  method.broadcast = async () => { throw failure; };
  const mpp = wrapMppx(Mppx.create({ methods: [method], secretKey: "22".repeat(32), realm: "example.com" }));
  const fxFetcher = { fetch: async () => ({ rates: { usd: 100_000 }, as_of: "2026-01-01T00:00:00Z" }), supportedCurrencies: () => ["usd"] };
  for (const [index, category] of ["invalid_challenge", "unknown"].entries()) {
    if (index === 1) failure = new TypeError("SENTINEL_ERROR_MESSAGE");
    const challenge = await mpp.challenge.tempo.charge({ amount: "0.001000", meta: { path: "/v1/job", nonce: String(index) } });
    const credential = Credential.from({ challenge, payload: { type: "hash", hash: `0x${"aa".repeat(32)}` } });
    const result = await verifyUpfrontPayment({ requiredMsats: 1000, mppCredential: credential, mpp, fxFetcher });
    assert.equal(result.error?.body.error, "payment_invalid");
    assert.equal(result.paidMsats, 0);
    assert.ok(warnings.some((row) => row.event === "tempo_credential_rejected" && row.failure_category === category && row.failure_stage === "verifier_broadcast" && row.phase === "upfront"));
    credentialCases++;
  }
  // A persistence failure after a successful external broadcast must retain its distinct stage.
  method.broadcast = async () => ({ method: "tempo", status: "success", timestamp: new Date().toISOString(), reference: "example-reference" });
  const consumedCredentialStore = new MemoryConsumedCredentialStore();
  consumedCredentialStore.mark = async () => { throw new TypeError("SENTINEL_STORE"); };
  const challenge = await mpp.challenge.tempo.charge({ amount: "0.001000", meta: { path: "/v1/job", nonce: "store" } });
  const credential = Credential.from({ challenge, payload: { type: "hash", hash: `0x${"aa".repeat(32)}` } });
  const refused = await verifyUpfrontPayment({ requiredMsats: 1000, mppCredential: credential, mpp, fxFetcher, consumedCredentialStore });
  assert.equal(refused.error?.body.error, "payment_invalid");
  assert.ok(warnings.some((row) => row.event === "tempo_credential_rejected" && row.failure_stage === "replay_store" && row.failure_category === "unknown"));
  credentialCases++;

  for (const mode of ["verify_reject", "settle_reject", "verify_throw"]) {
    facilitatorMode = mode;
    const payment = Buffer.from(JSON.stringify({ x402Version: 1, scheme: "exact", network: "base-sepolia", payload: {
      signature: "0xexample", authorization: { from: `0x${"33".repeat(20)}`, to: `0x${"11".repeat(20)}`, value: "1000", validAfter: "0", validBefore: "9999999999", nonce: `0x${"44".repeat(32)}` },
    } })).toString("base64");
    const result = await verifyUpfrontPayment({
      requiredMsats: 1000, x402Payment: payment, x402Config: { facilitator: mintUrl, network: "eip155:84532", payTo: `0x${"11".repeat(20)}` },
      priceFiat: { currency: "usd", amountMicro: 1000 }, fxFetcher,
    });
    assert.equal(result.error?.body.error, "payment_invalid");
    const stage = mode === "settle_reject" ? "broadcast" : "verifier";
    const category = mode === "verify_throw" ? "unknown" : mode === "settle_reject" ? "settlement_failed" : "verification_failed";
    assert.ok(warnings.some((row) => row.event === "x402_credential_rejected" && row.failure_stage === stage && row.failure_category === category));
    credentialCases++;
  }
  await writer.flush();
  assert.ok(rows.some((row) => row.name === "tempo.verify_credential" && row.attributes.failure_category === "invalid_challenge" && row.attributes.failure_stage === "verifier_broadcast"));
  assert.ok(!JSON.stringify({ rows, warnings }).includes("SENTINEL"));
} finally {
  console.warn = originalWarn;
  await writer.shutdown();
  mint.closeAllConnections();
  await new Promise((resolve, reject) => mint.close((error) => error ? reject(error) : resolve(undefined)));
  rmSync(callerState, { recursive: true, force: true });
}
console.log(JSON.stringify({ version: manifest.version, sha256: createHash("sha256").update(archive).digest("hex"), integrity, cashuCases, credentialCases }));

/** @param {Uint8Array} bytes */
function hex(bytes) { return Buffer.from(bytes).toString("hex"); }

/** @param {number} index */
function token(index) {
  const secret = JSON.stringify(["P2PK", { nonce: `example-proof-${index}`, data: lockPubkey }]);
  const bytes = new TextEncoder().encode(secret);
  const { B_ } = blindMessage(bytes, 3n);
  const privateKey = pair.privKeys["8"];
  const dleq = createDLEQProof(B_, privateKey);
  const C = hashToCurve(bytes).multiply(BigInt(`0x${hex(privateKey)}`)).toHex(true);
  return getEncodedToken({ mint: mintUrl, unit: "sat", proofs: [{
    id: pair.keysetId, amount: Amount.from(8), secret, C,
    dleq: { e: hex(dleq.e), s: hex(dleq.s), r: "3".padStart(64, "0") },
  }] });
}
