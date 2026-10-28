import { getP2PKExpectedWitnessPubkeys } from "@cashu/cashu-ts";
import { describe, expect, it } from "vitest";

import { toLockPubkey } from "../../../lib/cashu/lock-pubkey";
import { assessCashuLock } from "../wallet-accumulator-receive";
import { acceptedLockShapes } from "./__helpers__/cashu-lock-shapes";

const DVM_KEY = toLockPubkey("02" + "ab".repeat(32));
const RETIRED_KEY = toLockPubkey("03" + "cd".repeat(32));
const PAYER_KEY = "02" + "ef".repeat(32);
const ACTIVE = [DVM_KEY, RETIRED_KEY];
const NOW = 1_790_000_000;
const DAY = 86_400;
// Advertised min_locktime (7 days) less the 24 h resume window.
const FLOOR = NOW + 6 * DAY;

function secret(data: string, tags: string[][] = [], kind = "P2PK"): string {
  return JSON.stringify([kind, { nonce: "00".repeat(16), data, tags }]);
}

describe("assessCashuLock", () => {
  it.each([
    ["a past locktime with a payer refund", [["locktime", `${NOW - 60}`], ["refund", PAYER_KEY]]],
    ["a locktime seconds away with a payer refund", [["locktime", `${NOW + 30}`], ["refund", PAYER_KEY]]],
    ["a locktime below the floor without a refund", [["locktime", `${FLOOR - 1}`]]],
    ["a payer key on a 1-of-n main path (n_sigs absent)", [["pubkeys", PAYER_KEY]]],
    ["a payer key on a 1-of-n main path (n_sigs 1)", [["pubkeys", PAYER_KEY], ["n_sigs", "1"]]],
    ["n_sigs 2 including a payer key", [["pubkeys", PAYER_KEY], ["n_sigs", "2"]]],
    ["n_sigs 2 over DVM keys only", [["pubkeys", RETIRED_KEY], ["n_sigs", "2"]]],
    ["an unreadable locktime", [["locktime", "next-week"]]],
    ["a locktime tag with no value", [["locktime"]]],
    // Shapes the DVM's melter cannot sign or the mint cannot redeem.
    ["pubkeys repeating the data key", [["pubkeys", DVM_KEY]]],
    ["pubkeys repeating the data key under the other prefix", [["pubkeys", "03" + DVM_KEY.slice(2)]]],
    ["an x-only DVM key in pubkeys", [["pubkeys", RETIRED_KEY.slice(2)]]],
    ["sigflag SIG_ALL", [["sigflag", "SIG_ALL"]]],
    ["a refund entry that is not a key", [["locktime", `${NOW + 7 * DAY}`], ["refund", "not-a-key"]]],
    ["a refund key listed twice", [["locktime", `${NOW + 7 * DAY}`], ["refund", PAYER_KEY, PAYER_KEY]]],
    ["an x-only refund key", [["locktime", `${NOW + 7 * DAY}`], ["refund", PAYER_KEY.slice(2)]]],
  ])("refuses %s as lock_not_exclusive", (_label, tags) => {
    expect(assessCashuLock(secret(DVM_KEY, tags), ACTIVE, NOW)).toMatchObject({
      kind: "rejected",
      code: "lock_not_exclusive",
    });
  });

  it("refuses an already-open refund path that the witness-key helper reports as DVM-spendable", () => {
    const expired = secret(DVM_KEY, [["locktime", `${NOW - 60}`], ["refund", PAYER_KEY]]);
    // The clock-dependent helper lists the DVM key among current signers, which
    // is why exclusivity is judged from the secret's structure instead.
    expect(getP2PKExpectedWitnessPubkeys(expired)).toContain(DVM_KEY);
    expect(assessCashuLock(expired, ACTIVE, NOW)).toMatchObject({ code: "lock_not_exclusive" });
  });

  it("enforces the floor at min_locktime minus 24 hours, flagging only the clock-dependent refusal", () => {
    const at = (locktime: number) =>
      assessCashuLock(secret(DVM_KEY, [["locktime", `${locktime}`], ["refund", PAYER_KEY]]), ACTIVE, NOW);
    expect(at(FLOOR)).toEqual({ kind: "exclusive", lockPubkey: DVM_KEY });
    expect(at(FLOOR - 1)).toMatchObject({ code: "lock_not_exclusive", locktimeBelowFloor: true });
    expect(assessCashuLock(secret(DVM_KEY, [["pubkeys", PAYER_KEY]]), ACTIVE, NOW)).not.toHaveProperty(
      "locktimeBelowFloor"
    );
  });

  it.each(acceptedLockShapes({ current: DVM_KEY, retired: RETIRED_KEY, payer: PAYER_KEY, nowSec: NOW }))(
    "accepts $label",
    ({ data, tags, matches }) => {
      expect(assessCashuLock(secret(data, tags), ACTIVE, NOW)).toEqual({
        kind: "exclusive",
        lockPubkey: matches === "current" ? DVM_KEY : RETIRED_KEY,
      });
      // An accepted lock must parse on the signer side the melter uses.
      expect(() => getP2PKExpectedWitnessPubkeys(secret(data, tags))).not.toThrow();
    }
  );

  it.each([
    ["a valueless n_sigs", [["n_sigs"]]],
    ["a valueless sigflag", [["sigflag"]]],
    ["a valueless pubkeys", [["pubkeys"]]],
    ["a valueless refund", [["locktime", `${NOW + 7 * DAY}`], ["refund"]]],
    ["a valueless n_sigs_refund", [["locktime", `${NOW + 7 * DAY}`], ["refund", PAYER_KEY], ["n_sigs_refund"]]],
    ["an unknown tag", [["memo", "hello"]]],
    ["an unknown valueless tag", [["memo"]]],
    ["a duplicated unknown-to-cashu-ts tag", [["memo", "a"], ["memo", "b"]]],
    ["n_sigs with two values", [["n_sigs", "1", "1"]]],
    ["a non-canonical n_sigs", [["n_sigs", "01"]]],
    ["n_sigs_refund of 0", [["locktime", `${NOW + 7 * DAY}`], ["refund", PAYER_KEY], ["n_sigs_refund", "0"]]],
    ["n_sigs_refund above the refund key count", [["locktime", `${NOW + 7 * DAY}`], ["refund", PAYER_KEY], ["n_sigs_refund", "2"]]],
    ["n_sigs_refund that is not a number", [["locktime", `${NOW + 7 * DAY}`], ["refund", PAYER_KEY], ["n_sigs_refund", "one"]]],
    ["n_sigs_refund without refund keys", [["locktime", `${NOW + 7 * DAY}`], ["n_sigs_refund", "1"]]],
    ["a non-canonical locktime", [["locktime", `0${NOW + 7 * DAY}`]]],
    ["a signed locktime", [["locktime", `+${NOW + 7 * DAY}`]]],
  ])("refuses %s outside the canonical tag shape as lock_not_exclusive", (_label, tags) => {
    expect(assessCashuLock(secret(DVM_KEY, tags as string[][]), ACTIVE, NOW)).toMatchObject({
      kind: "rejected",
      code: "lock_not_exclusive",
    });
  });

  it.each([
    ["a duplicated NUT-11 tag", [["locktime", `${NOW + 7 * DAY}`], ["locktime", `${NOW + 8 * DAY}`]]],
    ["a tag value that is not a string", [["locktime", NOW + 7 * DAY]]],
  ])("refuses %s, which cashu-ts rejects at parse", (_label, tags) => {
    expect(assessCashuLock(secret(DVM_KEY, tags as string[][]), ACTIVE, NOW)).toMatchObject({
      kind: "rejected",
      code: "not_p2pk_locked",
    });
  });

  it("keeps the existing codes for unlocked and foreign-key secrets", () => {
    expect(assessCashuLock("plain-secret", ACTIVE, NOW)).toMatchObject({ code: "not_p2pk_locked" });
    expect(assessCashuLock(secret("ff".repeat(32), [["pubkeys", DVM_KEY]], "HTLC"), ACTIVE, NOW)).toMatchObject({
      code: "not_p2pk_locked",
    });
    expect(assessCashuLock(secret(PAYER_KEY, [["refund", DVM_KEY]]), ACTIVE, NOW)).toMatchObject({
      code: "wrong_lock_pubkey",
    });
  });

  it.each([
    ["the x-only spelling of a DVM key", DVM_KEY.slice(2)],
    ["a DVM key with a trailing space", `${DVM_KEY} `],
  ])("refuses %s in data, which the mint or signer cannot use, as wrong_lock_pubkey", (_label, data) => {
    expect(assessCashuLock(secret(data), ACTIVE, NOW)).toMatchObject({ code: "wrong_lock_pubkey" });
  });
});
