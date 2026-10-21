
import { describe, expect, it } from "vitest";

import { generateIdentity, signAttestation } from "../builder-identity";
import { computeResultHash, signDrainReceipt, signReceipt } from "../receipt";
import { deriveReceiptKeypair } from "../receipt-key";
import {
  authenticatedBuilderPubkey,
  checkReceiptAttestation,
  verifyDrainReceiptChain,
  verifyDrawFundingReceiptChain,
  verifyFundingReceiptChain,
  verifyJobReceipt,
  weakestReceiptVerdict
} from "../receipt-verify";
import {
  attestedDvm,
  BUILDER_SECRET,
  unsignedDrainReceipt,
  unsignedReceipt,
} from "./fixtures/receipt-fixture";

describe("authenticatedBuilderPubkey", () => {
  it("returns the normalized identity only for a self-consistent signed builder block", () => {
    const dvm = attestedDvm();
    expect(
      authenticatedBuilderPubkey({ ...dvm.anchor, pubkey: dvm.anchor.pubkey.toUpperCase() })
    ).toBe(dvm.anchor.pubkey);
  });

  it("rejects a claimed key that the signed attestation does not authenticate", () => {
    const dvm = attestedDvm();
    expect(authenticatedBuilderPubkey({ ...dvm.anchor, pubkey: "ab".repeat(32) })).toBeUndefined();
    expect(authenticatedBuilderPubkey({ pubkey: dvm.anchor.pubkey })).toBeUndefined();
  });
});

describe("verifyJobReceipt — the attested path", () => {
  it("verifies a receipt whose key the builder attested", () => {
    const dvm = attestedDvm();
    const result = verifyJobReceipt({ receipt: dvm.sign(), builder: dvm.anchor });

    expect(result.status).toBe("verified");
    expect(result.checks).toEqual({
      job_id: "unchecked",
      signature: true,
      attestation: "ok",
      result_hash: "unchecked",
    });
    expect(result.reason).toBeUndefined();
  });

  it("rejects a receipt signed by a key the attestation does not name", () => {
    const dvm = attestedDvm();
    const other = deriveReceiptKeypair(dvm.identity.secret, "dvm-impostor");
    const receipt = signReceipt(unsignedReceipt({ receipt_pubkey: other.pubkey }), other.secret);

    const result = verifyJobReceipt({ receipt, builder: dvm.anchor });
    expect(result.status).toBe("invalid");
    expect(result.reason).toBe("receipt_key_mismatch");
    expect(result.checks.signature).toBe(true);
    expect(result.checks.attestation).toBe("key_mismatch");
  });

  it("rejects a valid receipt that names a different immutable DVM ID", () => {
    const dvm = attestedDvm();
    const receipt = dvm.sign({ dvm_id: "dvm-replaced-provider" });

    const result = verifyJobReceipt({ receipt, builder: dvm.anchor });
    expect(result.status).toBe("invalid");
    expect(result.reason).toBe("dvm_identity_mismatch");
    expect(result.checks).toMatchObject({ signature: true, attestation: "identity_mismatch" });
  });

  it("rejects an attestation that does not verify under the advertised builder pubkey", () => {
    const dvm = attestedDvm();
    const impostor = generateIdentity();
    const forged = {
      ...dvm.anchor,
      signature: signAttestation(dvm.attestation, impostor.secret),
    };

    const result = verifyJobReceipt({ receipt: dvm.sign(), builder: forged });
    expect(result.status).toBe("invalid");
    expect(result.reason).toBe("attestation_invalid");
  });
});

describe("verifyJobReceipt — the unattested path", () => {
  it("downgrades rather than rejects when the DVM serves no builder block", () => {
    const result = verifyJobReceipt({
      receipt: signReceipt(unsignedReceipt(), BUILDER_SECRET_FOR_WORDCOUNT()),
    });

    expect(result.status).toBe("verified_unattested");
    expect(result.checks.signature).toBe(true);
    expect(result.checks.attestation).toBe("absent");
    expect(result.reason).toBeUndefined();
  });

  it("downgrades when the builder block attests no receipt key", () => {
    const dvm = attestedDvm();
    const { receipt_pubkey: _dropped, ...withoutKey } = dvm.attestation;
    const anchor = {
      pubkey: dvm.identity.pubkey,
      attestation: withoutKey as unknown as Record<string, unknown>,
      signature: signAttestation(withoutKey, dvm.identity.secret),
    };

    const result = verifyJobReceipt({ receipt: dvm.sign(), builder: anchor });
    expect(result.status).toBe("verified_unattested");
    expect(result.checks.attestation).toBe("absent");
  });

  it("treats a structurally broken builder block as absent, not as a failure", () => {
    const result = verifyJobReceipt({
      receipt: signReceipt(unsignedReceipt(), BUILDER_SECRET_FOR_WORDCOUNT()),
      builder: { pubkey: "", attestation: null, signature: "" } as never,
    });
    expect(result.status).toBe("verified_unattested");
  });
});

describe("verifyJobReceipt — signature", () => {
  it("rejects a receipt edited after signing", () => {
    const dvm = attestedDvm();
    const receipt = dvm.sign();

    for (const tampered of [
      { ...receipt, paid: { ...receipt.paid, msats: 1 } },
      { ...receipt, outcome: "failed" as const },
      { ...receipt, seq: receipt.seq + 1 },
      { ...receipt, job_id: "job-someone-elses" },
    ]) {
      const result = verifyJobReceipt({ receipt: tampered, builder: dvm.anchor });
      expect(result.status).toBe("invalid");
      expect(result.reason).toBe("signature_invalid");
    }
  });

  it("returns a verdict rather than throwing on malformed bytes", () => {
    const dvm = attestedDvm();
    const result = verifyJobReceipt({
      receipt: { ...dvm.sign(), signature: "not-hex" },
      builder: dvm.anchor,
    });
    expect(result.status).toBe("invalid");
    expect(result.reason).toBe("signature_invalid");
  });
});

describe("verifyJobReceipt — job binding", () => {
  it("rejects a flawlessly signed receipt for a different job", () => {
    // The one failure the rest of the chain waves straight through: everything
    // about this receipt is sound, it just isn't proof of the job we asked
    // about. Without this link a DVM could answer every job read with one
    // genuine receipt and every caller would report "verified".
    const dvm = attestedDvm();
    const result = verifyJobReceipt({
      receipt: dvm.sign(),
      builder: dvm.anchor,
      expectedJobId: "job-some-other-one",
    });

    expect(result.status).toBe("invalid");
    expect(result.reason).toBe("job_id_mismatch");
    expect(result.checks.job_id).toBe("mismatch");
    expect(result.checks.signature).toBe(true);
  });

  it("confirms the binding when the receipt names the job asked about", () => {
    const dvm = attestedDvm();
    const receipt = dvm.sign();
    const result = verifyJobReceipt({
      receipt,
      builder: dvm.anchor,
      expectedJobId: receipt.job_id,
    });

    expect(result.status).toBe("verified");
    expect(result.checks.job_id).toBe("ok");
  });

});

describe("verifyJobReceipt — result hash", () => {
  const artifact = { name: "out.txt", data: "six little words right here", encoding: "utf-8" };

  it("confirms a receipt that binds the delivered result", () => {
    const dvm = attestedDvm();
    const receipt = dvm.sign({ result_hash: computeResultHash("6 words", [artifact]) });

    const result = verifyJobReceipt({
      receipt,
      builder: dvm.anchor,
      delivered: { summary: "6 words", artifactContents: [artifact] },
    });
    expect(result.status).toBe("verified");
    expect(result.checks.result_hash).toBe("ok");
  });

  it("catches a receipt attesting a result other than the one delivered", () => {
    const dvm = attestedDvm();
    const receipt = dvm.sign({ result_hash: computeResultHash("6 words", [artifact]) });

    const result = verifyJobReceipt({
      receipt,
      builder: dvm.anchor,
      delivered: { summary: "6 words", artifactContents: [{ ...artifact, data: "swapped" }] },
    });
    expect(result.status).toBe("invalid");
    expect(result.reason).toBe("result_hash_mismatch");
  });

  it("stays unchecked when the DVM delivered nothing to bind", () => {
    const dvm = attestedDvm();
    const receipt = dvm.sign({ outcome: "cancelled", reason: "user_cancelled", result_hash: null });
    const result = verifyJobReceipt({
      receipt,
      builder: dvm.anchor,
      delivered: { artifactContents: [] },
    });
    expect(result.checks.result_hash).toBe("unchecked");
    expect(result.status).toBe("verified");
  });

  it("ignores the summary on a non-completed job", () => {
    // The SDK writes the terminal *reason* into the summary column on a
    // failed job, so a verifier that folded the summary in would fail every
    // crash-reaped receipt. `computeResultHash` documents the same rule.
    const dvm = attestedDvm();
    const receipt = dvm.sign({
      outcome: "failed",
      reason: "worker_died_mid_job",
      result_hash: computeResultHash(undefined, [artifact]),
    });

    const result = verifyJobReceipt({
      receipt,
      builder: dvm.anchor,
      delivered: { summary: "worker_died_mid_job", artifactContents: [artifact] },
    });
    expect(result.checks.result_hash).toBe("ok");
    expect(result.status).toBe("verified");
  });
});

describe("checkReceiptAttestation — the chain without link 1", () => {
  const dvm = attestedDvm();

  it("accepts a drain-shaped receipt signed under the attested key", () => {
    expect(
      checkReceiptAttestation(
        { dvm_id: dvm.attestation.dvm_id, receipt_pubkey: dvm.receiptKey.pubkey },
        dvm.anchor
      )
    ).toBe("ok");
  });

  it("catches a drain receipt signed by a key the builder never attested", () => {
    const impostor = deriveReceiptKeypair(generateIdentity().secret, "dvm-wordcount");
    expect(
      checkReceiptAttestation(
        { dvm_id: dvm.attestation.dvm_id, receipt_pubkey: impostor.pubkey },
        dvm.anchor
      )
    ).toBe("key_mismatch");
  });

  it("reads a dev-mode DVM as absent, not invalid — nothing to chain to", () => {
    expect(
      checkReceiptAttestation(
        { dvm_id: dvm.attestation.dvm_id, receipt_pubkey: dvm.receiptKey.pubkey },
        undefined
      )
    ).toBe("absent");
  });

  it("rejects an attestation that doesn't verify under the advertised builder key", () => {
    const forged = {
      ...dvm.anchor,
      signature: signAttestation(dvm.anchor.attestation as never, generateIdentity().secret),
    };
    expect(
      checkReceiptAttestation(
        { dvm_id: dvm.attestation.dvm_id, receipt_pubkey: dvm.receiptKey.pubkey },
        forged
      )
    ).toBe("invalid");
  });

});

describe("verifyDrainReceiptChain", () => {
  const dvm = attestedDvm();

  it("walks a drain receipt to the builder identity", () => {
    const result = verifyDrainReceiptChain({ receipt: dvm.signDrain(), builder: dvm.anchor });
    expect(result.status).toBe("verified");
    expect(result.checks).toEqual({
      drain_id: "unchecked",
      credit_id: "unchecked",
      signature: true,
      attestation: "ok",
    });
    expect(result.reason).toBeUndefined();
  });

  it("binds the receipt to the reclaim it is claimed as evidence of", () => {
    const receipt = dvm.signDrain({ drain_id: "drain-1", credit_id: "credit-1" });
    const result = verifyDrainReceiptChain({
      receipt,
      builder: dvm.anchor,
      expectedDrainId: "drain-1",
      expectedCreditId: "credit-1",
    });
    expect(result.status).toBe("verified");
    expect(result.checks).toMatchObject({ drain_id: "ok", credit_id: "ok" });
  });

  it("rejects a soundly-signed receipt filed under someone else's drain", () => {
    // The store files a bundle under an unsigned `drainId` label. A relabelled
    // bundle is not evidence of the reclaim it now sits under, whoever signed it.
    const result = verifyDrainReceiptChain({
      receipt: dvm.signDrain({ drain_id: "drain-1" }),
      builder: dvm.anchor,
      expectedDrainId: "drain-2",
    });
    expect(result.status).toBe("invalid");
    expect(result.reason).toBe("drain_id_mismatch");
    expect(result.checks.signature).toBe(true);
  });

  it("rejects a receipt naming a different credit than the reclaim it is filed under", () => {
    const result = verifyDrainReceiptChain({
      receipt: dvm.signDrain({ credit_id: "credit-1" }),
      builder: dvm.anchor,
      expectedCreditId: "credit-2",
    });
    expect(result.status).toBe("invalid");
    expect(result.reason).toBe("credit_id_mismatch");
  });

  it("downgrades a dev-mode DVM's receipt rather than rejecting it", () => {
    const result = verifyDrainReceiptChain({ receipt: dvm.signDrain({ event: "parked" }) });
    expect(result.status).toBe("verified_unattested");
    expect(result.checks).toEqual({
      drain_id: "unchecked",
      credit_id: "unchecked",
      signature: true,
      attestation: "absent",
    });
  });

  it("catches a receipt edited after signing", () => {
    const receipt = { ...dvm.signDrain(), amount_micro: 900_000 };
    const result = verifyDrainReceiptChain({ receipt, builder: dvm.anchor });
    expect(result.status).toBe("invalid");
    expect(result.reason).toBe("signature_invalid");
  });

  it("catches a refund IOU signed by a key the builder never attested", () => {
    const impostor = deriveReceiptKeypair(generateIdentity().secret, "dvm-wordcount");
    const forged = signDrainReceipt(
      unsignedDrainReceipt({ receipt_pubkey: impostor.pubkey }),
      impostor.secret
    );
    const result = verifyDrainReceiptChain({ receipt: forged, builder: dvm.anchor });
    expect(result.status).toBe("invalid");
    expect(result.reason).toBe("receipt_key_mismatch");
    expect(result.checks.signature).toBe(true);
  });

  it("rejects a valid reclaim receipt that names a different immutable DVM ID", () => {
    const receipt = dvm.signDrain({ dvm_id: "dvm-replaced-provider" });
    const result = verifyDrainReceiptChain({ receipt, builder: dvm.anchor });

    expect(result.status).toBe("invalid");
    expect(result.reason).toBe("dvm_identity_mismatch");
    expect(result.checks).toMatchObject({ signature: true, attestation: "identity_mismatch" });
  });

  it("catches an attestation that doesn't verify under the advertised builder key", () => {
    const forged = {
      ...dvm.anchor,
      signature: signAttestation(dvm.attestation, generateIdentity().secret),
    };
    const result = verifyDrainReceiptChain({ receipt: dvm.signDrain(), builder: forged });
    expect(result.status).toBe("invalid");
    expect(result.reason).toBe("attestation_invalid");
  });

  it("gives a verdict on a body that isn't a receipt at all, rather than throwing", () => {
    for (const junk of [null, undefined, "receipt", {}, { receipt_pubkey: 7 }, []]) {
      const result = verifyDrainReceiptChain({
        receipt: junk,
        builder: dvm.anchor,
        expectedDrainId: "drain-1",
      });
      expect(result.status).toBe("invalid");
      // "no id to compare" is the signature's verdict to give, not a mismatch.
      expect(result.reason).toBe("signature_invalid");
      expect(result.checks.drain_id).toBe("unchecked");
      expect(result.checks.attestation).toBe("absent");
    }
  });

});

describe("verifyFundingReceiptChain", () => {
  const dvm = attestedDvm();

  it("verifies the funding-time tuple through the builder attestation", () => {
    const receipt = dvm.signFunding();
    const result = verifyFundingReceiptChain({
      receipt,
      builder: dvm.anchor,
      expectedCreditId: "credit-1",
      expectedFundId: "fund-1",
      expectedFundedMicro: 500_000,
      expectedBalanceAfterMicro: 750_000,
      expectedLedgerSeq: 3,
      expectedCallerPubkey: "bb".repeat(32),
    });
    expect(result.status).toBe("verified");
    expect(result.checks).toMatchObject({
      credit_id: "ok",
      fund_id: "ok",
      funded_micro: "ok",
      balance_after_micro: "ok",
      ledger_seq: "ok",
      caller_pubkey: "ok",
      signature: true,
      attestation: "ok",
    });
  });

  it.each([
    [{ expectedCreditId: "credit-2" }, "credit_id", "credit_id_mismatch"],
    [{ expectedFundId: "fund-2" }, "fund_id", "fund_id_mismatch"],
    [{ expectedFundedMicro: 500_001 }, "funded_micro", "funding_amount_mismatch"],
    [{ expectedBalanceAfterMicro: 750_001 }, "balance_after_micro", "funding_balance_mismatch"],
    [{ expectedLedgerSeq: 4 }, "ledger_seq", "funding_ledger_seq_mismatch"],
    [{ expectedCallerPubkey: "cc".repeat(32) }, "caller_pubkey", "caller_pubkey_mismatch"],
  ] as const)("rejects a signed funding receipt with a mismatched %s", (expected, field, reason) => {
    const result = verifyFundingReceiptChain({
      receipt: dvm.signFunding(),
      builder: dvm.anchor,
      ...expected,
    });
    expect(result.status).toBe("invalid");
    expect(result.reason).toBe(reason);
    expect(result.checks[field]).toBe("mismatch");
    expect(result.checks.signature).toBe(true);
  });
});

describe("verifyDrawFundingReceiptChain", () => {
  const dvm = attestedDvm();

  it("verifies every binding of a mid-job funding fact through the builder attestation", () => {
    const receipt = dvm.signDrawFunding();
    const result = verifyDrawFundingReceiptChain({
      receipt,
      builder: dvm.anchor,
      expectedCreditId: "credit-1",
      expectedJobId: "job-a7571b-1",
      expectedDrawId: "draw-1",
      expectedFundId: "0xabc123",
      expectedCurrency: "usd",
      expectedFundedMicro: 50_000,
      expectedLedgerSeq: 6,
      expectedCallerPubkey: "bb".repeat(32),
    });
    expect(result.status).toBe("verified");
    expect(result.checks).toMatchObject({
      credit_id: "ok",
      job_id: "ok",
      draw_id: "ok",
      fund_id: "ok",
      currency: "ok",
      funded_micro: "ok",
      ledger_seq: "ok",
      caller_pubkey: "ok",
      signature: true,
      attestation: "ok",
    });
  });

  it.each([
    [{ expectedCreditId: "credit-2" }, "credit_id", "credit_id_mismatch"],
    [{ expectedJobId: "job-other" }, "job_id", "job_id_mismatch"],
    [{ expectedDrawId: "draw-2" }, "draw_id", "draw_id_mismatch"],
    [{ expectedFundId: "0xother" }, "fund_id", "fund_id_mismatch"],
    [{ expectedCurrency: "eur" }, "currency", "funding_currency_mismatch"],
    [{ expectedFundedMicro: 50_001 }, "funded_micro", "funding_amount_mismatch"],
    [{ expectedLedgerSeq: 7 }, "ledger_seq", "funding_ledger_seq_mismatch"],
    [{ expectedCallerPubkey: "cc".repeat(32) }, "caller_pubkey", "caller_pubkey_mismatch"],
  ] as const)("rejects a signed draw funding receipt with a mismatched %s", (expected, field, reason) => {
    const result = verifyDrawFundingReceiptChain({
      receipt: dvm.signDrawFunding(),
      builder: dvm.anchor,
      ...expected,
    });
    expect(result.status).toBe("invalid");
    expect(result.reason).toBe(reason);
    expect(result.checks[field]).toBe("mismatch");
    expect(result.checks.signature).toBe(true);
  });

  it("refuses an opening funding receipt presented as draw funding evidence", () => {
    const result = verifyDrawFundingReceiptChain({ receipt: dvm.signFunding(), builder: dvm.anchor });
    expect(result.status).toBe("invalid");
    expect(result.reason).toBe("signature_invalid");
    expect(result.receipt).toBeUndefined();
  });

  it("refuses a body missing its draw binding even when the rest is signed", () => {
    const { draw_id: _drawId, ...withoutDraw } = dvm.signDrawFunding();
    const result = verifyDrawFundingReceiptChain({ receipt: withoutDraw, builder: dvm.anchor });
    expect(result.status).toBe("invalid");
    expect(result.reason).toBe("signature_invalid");
  });

  it("marks a key the attestation does not name as a provider mismatch", () => {
    const other = attestedDvm();
    const result = verifyDrawFundingReceiptChain({ receipt: other.signDrawFunding(), builder: dvm.anchor });
    expect(result.status).toBe("invalid");
    expect(result.reason).toBe("receipt_key_mismatch");
  });
});

describe("weakestReceiptVerdict", () => {
  it("takes the weakest link — a bundle is only as good as its worst receipt", () => {
    expect(weakestReceiptVerdict(["verified", "verified", "verified"])).toBe("verified");
    expect(weakestReceiptVerdict(["verified", "verified_unattested"])).toBe("verified_unattested");
    expect(weakestReceiptVerdict(["verified", "invalid", "verified_unattested"])).toBe("invalid");
  });

  it("reads an empty set as absent — nothing issued is not something that failed", () => {
    expect(weakestReceiptVerdict([])).toBe("absent");
  });
});

function BUILDER_SECRET_FOR_WORDCOUNT(): string {
  return deriveReceiptKeypair(BUILDER_SECRET, "dvm-wordcount").secret;
}
