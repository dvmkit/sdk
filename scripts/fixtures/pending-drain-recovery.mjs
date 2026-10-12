import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { promisify, isDeepStrictEqual } from "node:util";

import {
  clearPendingDrain,
  loadCredit,
  pendingDrainById,
  pendingDrainFor,
  recordDrainReceipts,
  recordFundResponse,
  recordPendingDrain,
} from "@dvmkit/sdk/internal";

const callerPubkey = "ab".repeat(32);
const pending = Array.from({ length: 12 }, (_, i) => {
  /** @type {Record<string, string>} */
  const payout = i % 2 === 0
    ? { address: `example-payout-${i}` }
    : { refund_pubkey: "02" + "cd".repeat(32) };
  return {
    drainId: `drain-${i}`,
    creditId: `credit-${i}`,
    method: i % 2 === 0 ? "tempo" : "cashu",
    payout,
    requestedAt: 0,
    ...(i % 2 === 0 ? { mppCredential: `Payment example-close-${i}` } : {}),
  };
});
const stateDir = process.env.DVM_CONFIG_DIR;
assert.ok(stateDir, "recovery probe requires an isolated state directory");
const role = process.argv[2];

if (!role) {
  let interrupted = false;
  const retried = new Set();
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const expected = pending.find((entry) => entry.drainId === payload.drain_id);
    const matches = expected && isDeepStrictEqual(payload, drainPayload(expected)) &&
      request.headers.authorization === expected.mppCredential;
    if (!matches) {
      response.writeHead(400).end();
      return;
    }
    if (!interrupted) {
      interrupted = true;
      request.socket.destroy();
      return;
    }
    retried.add(expected.drainId);
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ status: "requested" }));
  });
  server.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const endpoint = `http://127.0.0.1:${address.port}`;
  try {
    for (const phase of ["write", "retry", "retire"]) {
      await promisify(execFile)(process.execPath, [import.meta.filename, phase], {
        env: { ...process.env, REFUND_PROBE_ENDPOINT: endpoint },
      });
    }
    assert.ok(interrupted, "the first request must lose its response");
    assert.equal(retried.size, pending.length, "every persisted drain must be retryable");
  } finally {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve(undefined)));
  }
} else {
  const endpoint = process.env.REFUND_PROBE_ENDPOINT;
  assert.ok(endpoint);
  if (role === "write") {
    for (const entry of pending) {
      fund(entry.creditId, endpoint);
      recordPendingDrain(endpoint, callerPubkey, entry);
      if (entry === pending[0]) {
        await assert.rejects(post(entry, endpoint), "an unconfirmed POST must not retire its descriptor");
      }
    }
    fund("credit-current", endpoint);
  } else {
    const record = loadCredit(endpoint, callerPubkey);
    assert.equal(record?.creditId, "credit-current");
    assert.ok(isDeepStrictEqual(record?.pendingDrains, pending), "reload must preserve every recovery descriptor");
    if (role === "retry") {
      for (const expected of pending) {
        const entry = pendingDrainFor(record, expected.creditId);
        assert.ok(isDeepStrictEqual(entry, expected), "credit lookup must preserve recovery credentials");
        assert.ok(isDeepStrictEqual(pendingDrainById(record, expected.drainId), expected), "drain lookup must preserve its credit association");
        assert.ok(entry);
        recordPendingDrain(endpoint, callerPubkey, entry);
        const response = await post(entry, endpoint);
        assert.equal(response.status, 200, "retry must use the original request and credential");
      }
    } else if (role === "retire") {
      const entry = pending[0];
      recordDrainReceipts({
        endpoint,
        callerPubkey,
        drainId: entry.drainId,
        creditId: entry.creditId,
        receipts: [{ event: "sent", drain_id: entry.drainId }],
        read: { reachable: true },
      });
      clearPendingDrain(endpoint, callerPubkey, entry);
      const remaining = loadCredit(endpoint, callerPubkey);
      assert.ok(isDeepStrictEqual(remaining?.pendingDrains, pending.slice(1)), "retirement must preserve unrelated drains");
      const bytes = readFileSync(join(stateDir, "credits.json"), "utf8");
      assert.ok(!bytes.includes(entry.mppCredential ?? ""), "retired credentials must leave disk");
      assert.ok(!JSON.stringify(remaining?.drainEvidence).includes("Payment example-"), "receipt evidence must not contain credentials");
    } else {
      throw new Error("unknown recovery probe phase");
    }
  }
}

/** @param {import("@dvmkit/sdk/internal").PendingDrain} entry */
function drainPayload(entry) {
  return { credit_id: entry.creditId, drain_id: entry.drainId, method: entry.method, payout: entry.payout };
}

/** @param {import("@dvmkit/sdk/internal").PendingDrain} entry @param {string} endpoint */
function post(entry, endpoint) {
  return fetch(`${endpoint}/v1/credit/drain`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(entry.mppCredential ? { Authorization: entry.mppCredential } : {}) },
    body: JSON.stringify(drainPayload(entry)),
    signal: AbortSignal.timeout(5_000),
  });
}

/** @param {string} creditId @param {string} endpoint */
function fund(creditId, endpoint) {
  recordFundResponse({
    endpoint,
    callerPubkey,
    credit: {
      credit_id: creditId, currency: "usd", balance_micro: 200_000, remaining_micro: 200_000,
      expiry_ms: 0, expired: false, drainable: true, ledger_seq: 1,
    },
    targetMicro: 400_000,
  });
}
