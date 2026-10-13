import { describe, expect, it } from "vitest";
import type { MppxChallenge } from "../../messages/types";

function tempoChallenge(amount = "1000000"): MppxChallenge {
  return { id: "ch_test", realm: "test", method: "tempo", intent: "charge", request: { amount, currency: "0x20C0", recipient: "0x" + "a".repeat(40) } } as MppxChallenge;
}

describe("tempoChallengeAmountMicro", () => {
  it("reads mppx's atomic wire amount", async () => {
    const { tempoChallengeAmountMicro } = await import("../tempo-credential");
    expect(tempoChallengeAmountMicro(tempoChallenge("12345"))).toBe(12_345n);
  });

  it("preserves amounts beyond safe-number precision", async () => {
    const { tempoChallengeAmountMicro } = await import("../tempo-credential");
    expect(tempoChallengeAmountMicro(tempoChallenge("9007199254740993"))).toBe(9_007_199_254_740_993n);
  });

  it.each(["0", "-1", "01", "1.5", "1e6", " 1", "1 ", ""])("refuses non-positive or non-integer wire amount %j", async (amount) => {
    const { tempoChallengeAmountMicro } = await import("../tempo-credential");
    expect(() => tempoChallengeAmountMicro(tempoChallenge(amount))).toThrowError(expect.objectContaining({ code: "tempo_amount_invalid" }));
  });

  it("refuses a missing amount", async () => {
    const { tempoChallengeAmountMicro } = await import("../tempo-credential");
    expect(() => tempoChallengeAmountMicro({ id: "x", realm: "r" } as MppxChallenge)).toThrow(
      /invalid Tempo charge amount/
    );
  });
});

describe("tempoCredentialValidBefore", () => {
  it("mirrors mppx's own min(signed + ttl, challenge expiry)", async () => {
    const { tempoCredentialValidBefore } = await import("../tempo-credential");
    const signedAt = 1_800_000_000_000;
    const ttlDeadline = 1_800_000_025;

    // A five-minute challenge, the shape dvmkit's own DVMs issue: the client's
    // twenty-five-second window is what binds, and it is what a resume has to
    // measure re-presentation against.
    expect(
      tempoCredentialValidBefore(
        {
          challenge: { ...tempoChallenge(), expires: new Date(signedAt + 300_000).toISOString() },
          payload: {},
        },
        signedAt
      )
    ).toBe(ttlDeadline);

    // A challenge expiring first caps it, exactly as mppx does.
    expect(
      tempoCredentialValidBefore(
        {
          challenge: { ...tempoChallenge(), expires: new Date(signedAt + 5_000).toISOString() },
          payload: {},
        },
        signedAt
      )
    ).toBe(signedAt / 1000 + 5);

    expect(tempoCredentialValidBefore({ challenge: tempoChallenge(), payload: {} }, signedAt)).toBe(
      ttlDeadline
    );
  });

  it("names no deadline for a challenge whose expiry will not parse", async () => {
    const { tempoCredentialValidBefore } = await import("../tempo-credential");
    expect(
      tempoCredentialValidBefore(
        { challenge: { ...tempoChallenge(), expires: "not-a-date" }, payload: {} },
        1_800_000_000_000
      )
    ).toBeUndefined();
  });
});
