import { createHash, randomBytes } from "node:crypto";
import { schnorr } from "@noble/curves/secp256k1.js";
import { buildAdminChallenge } from "../../admin-cashu";
import type { JobRecord } from "../../job-store";

export const ADMIN_SECRET = "11".repeat(32);
export const ADMIN_KEY = `02${Buffer.from(schnorr.getPublicKey(Buffer.from(ADMIN_SECRET, "hex"))).toString("hex")}`;
export const TOKEN = "example-job-token";
export const ACTIVITY = 1_700_000_000_000;
export function contentJob(id = "example-job"): JobRecord {
  return {
    id, tags: [], capability: "work", input: "raw-input-secret", params: { prompt: "raw-param-secret" },
    requesterId: "anonymous", requesterTokenHash: createHash("sha256").update(TOKEN).digest("hex"),
    status: "completed", summary: "raw-output-secret", messages: [], seq: 0, paidMsats: 21000,
    receivedProofs: [{ amount: 1, secret: "bearer-proof-secret", id: "proof", C: "point" }],
    stepCache: [], state: {}, createdAt: ACTIVITY, lastActivityAt: ACTIVITY,
  };
}
export function adminHeader(method: string, path: string, now = Date.now(), secret = ADMIN_SECRET, dvmId = "example-dvm"): string {
  const nonceHex = randomBytes(16).toString("hex");
  const unixSeconds = String(Math.floor(now / 1000));
  const digest = buildAdminChallenge({ method, path, dvmId, nonceHex, unixSeconds });
  const signature = Buffer.from(schnorr.sign(digest, Buffer.from(secret, "hex"))).toString("hex");
  return `P2PK ${nonceHex}.${unixSeconds}.${signature}`;
}
