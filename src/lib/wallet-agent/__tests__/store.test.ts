import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("fs");
vi.mock("../../../defaults", () => ({
  CONFIG_DIR: "/mock/.dvm",
  WALLET_FILE: "/mock/.dvm/wallet.json",
}));

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "fs";

import { DvmError } from "../../errors";
import {
  type AgentWallet,
  type PendingSubmission,
  DEFAULT_AGENT_MINT_URL,
  effectiveFundingMint,
  effectiveMints,
  isStorableJobId,
  loadAgentWallet,
  loadWalletConfiguredMints,
  saveAgentWallet,
  WALLET_VERSION,
  walletExists,
} from "../store";

const validWallet: AgentWallet = {
  version: WALLET_VERSION,
  lock_privkey: "ab".repeat(32),
  lock_pubkey: "02" + "cd".repeat(32),
  mnemonic_fingerprint: null,
  mints: [],
  proofs: [],
  nut13_counters: {},
  pending_mints: [],
  pending_melts: [],
  pending_submissions: [],
  recent_spends: [],
  created_at: "2026-05-09T00:00:00.000Z",
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("agent wallet store", () => {
  describe("walletExists", () => {
    it("returns true when the file exists", () => {
      vi.mocked(existsSync).mockReturnValue(true);
      expect(walletExists()).toBe(true);
      expect(existsSync).toHaveBeenCalledWith("/mock/.dvm/wallet.json");
    });

    it("returns false when the file is missing", () => {
      vi.mocked(existsSync).mockReturnValue(false);
      expect(walletExists()).toBe(false);
    });
  });

  describe("loadWalletConfiguredMints", () => {
    it("returns no configured mints when the wallet is missing", () => {
      vi.mocked(existsSync).mockReturnValue(false);
      expect(loadWalletConfiguredMints()).toEqual([]);
      expect(writeFileSync).not.toHaveBeenCalled();
    });

    it("reads only authoritative configured mints without saving or choosing the default", () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ ...validWallet, mints: ["https://a.example.com", "https://b.example.com"] }));
      expect(loadWalletConfiguredMints()).toEqual(["https://a.example.com", "https://b.example.com"]);
      vi.mocked(readFileSync).mockReturnValue(JSON.stringify(validWallet));
      expect(loadWalletConfiguredMints()).toEqual([]);
      expect(writeFileSync).not.toHaveBeenCalled();
      expect(renameSync).not.toHaveBeenCalled();
    });

    it("keeps a legacy wallet's absent mint field empty without persisting its in-memory migration", () => {
      vi.mocked(existsSync).mockReturnValue(true);
      const legacy: Partial<AgentWallet> = { ...validWallet };
      delete legacy.mints;
      vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ ...legacy, version: 8 }));
      expect(loadWalletConfiguredMints()).toEqual([]);
      expect(writeFileSync).not.toHaveBeenCalled();
    });
  });

  describe("loadAgentWallet", () => {
    it("returns null when the file does not exist", () => {
      vi.mocked(existsSync).mockReturnValue(false);
      expect(loadAgentWallet()).toBeNull();
      expect(readFileSync).not.toHaveBeenCalled();
    });

    it("parses and returns a valid current-version wallet", () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(JSON.stringify(validWallet));
      expect(loadAgentWallet()).toEqual(validWallet);
    });

    it("rejects unknown version with wallet_unknown_version", () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ ...validWallet, version: 99 }));
      try {
        loadAgentWallet();
        expect.unreachable("should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(DvmError);
        expect((e as DvmError).code).toBe("wallet_unknown_version");
        expect((e as DvmError).hint).toMatch(/Upgrade dvm CLI/);
      }
    });

    it("migrates an empty v1 wallet to v9 in-memory, renaming recovery_* fields", () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(
        JSON.stringify({
          version: 1,
          recovery_privkey: validWallet.lock_privkey,
          recovery_pubkey: validWallet.lock_pubkey,
          mints: ["https://mint.example"],
          proofs: [],
          pending_mints: [],
          created_at: "2026-05-09T00:00:00.000Z",
        })
      );
      const migrated = loadAgentWallet();
      expect(migrated?.version).toBe(WALLET_VERSION);
      expect(migrated?.lock_privkey).toBe(validWallet.lock_privkey);
      expect(migrated?.lock_pubkey).toBe(validWallet.lock_pubkey);
      expect(migrated?.proofs).toEqual([]);
      expect(migrated?.pending_mints).toEqual([]);
      expect(migrated?.recent_spends).toEqual([]);
      expect(migrated?.mints).toEqual(["https://mint.example"]);
    });

    it("migrates a populated v2 wallet to v9 in-memory, renaming recovery_* fields + adding recent_spends", () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(
        JSON.stringify({
          version: 2,
          recovery_privkey: validWallet.lock_privkey,
          recovery_pubkey: validWallet.lock_pubkey,
          mints: ["https://mint.example"],
          proofs: [
            {
              mint: "https://mint.example",
              secret: "s",
              C: "02C",
              amount: 4,
              id: "k1",
              locked_to_pubkey: validWallet.lock_pubkey,
              status: "valid",
            },
          ],
          pending_mints: [
            {
              mint: "https://mint.example",
              quote_id: "q1",
              amount_sats: 100,
              requested_at: "2026-05-09T12:00:00.000Z",
            },
          ],
          created_at: "2026-05-09T00:00:00.000Z",
        })
      );
      const migrated = loadAgentWallet();
      expect(migrated?.version).toBe(WALLET_VERSION);
      expect(migrated?.lock_privkey).toBe(validWallet.lock_privkey);
      expect(migrated?.lock_pubkey).toBe(validWallet.lock_pubkey);
      expect(migrated?.proofs).toHaveLength(1);
      expect(migrated?.pending_mints).toHaveLength(1);
      expect(migrated?.recent_spends).toEqual([]);
    });

    it("migrates a v4 wallet to v9 in-memory, adding pending_submissions + nut13_counters", () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(
        JSON.stringify({
          version: 4,
          lock_privkey: validWallet.lock_privkey,
          lock_pubkey: validWallet.lock_pubkey,
          mints: ["https://mint.example"],
          proofs: [],
          pending_mints: [],
          recent_spends: [],
          created_at: "2026-05-09T00:00:00.000Z",
        })
      );
      const migrated = loadAgentWallet();
      expect(migrated?.version).toBe(WALLET_VERSION);
      expect(migrated?.lock_privkey).toBe(validWallet.lock_privkey);
      expect(migrated?.lock_pubkey).toBe(validWallet.lock_pubkey);
      expect(migrated?.pending_submissions).toEqual([]);
      expect(migrated?.nut13_counters).toEqual({});
      expect(migrated?.mnemonic_fingerprint).toBeNull();
    });

    it("migrates a v5 wallet to v9 in-memory, adding nut13_counters + mnemonic_fingerprint", () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(
        JSON.stringify({
          version: 5,
          lock_privkey: validWallet.lock_privkey,
          lock_pubkey: validWallet.lock_pubkey,
          mints: ["https://mint.example"],
          proofs: [
            {
              mint: "https://mint.example",
              secret: "s",
              C: "02C",
              amount: 4,
              id: "k1",
              locked_to_pubkey: validWallet.lock_pubkey,
              status: "valid",
            },
          ],
          pending_mints: [],
          pending_submissions: [],
          recent_spends: [],
          created_at: "2026-05-09T00:00:00.000Z",
        })
      );
      const migrated = loadAgentWallet();
      expect(migrated?.version).toBe(WALLET_VERSION);
      expect(migrated?.proofs).toHaveLength(1);
      expect(migrated?.pending_submissions).toEqual([]);
      expect(migrated?.nut13_counters).toEqual({});
      // v5 wallets predate the mnemonic-on-disk model — inherits null so NUT-13
      // stays inactive until the user runs `dvm wallet restore <mnemonic>`.
      expect(migrated?.mnemonic_fingerprint).toBeNull();
    });

    it("migrates a v7 wallet to v9 in-memory, adding an empty pending_melts", () => {
      // No wallet predating `dvm wallet cash-out` can have a melt in flight,
      // so an empty list is exact rather than a lossy default.
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(
        JSON.stringify({
          version: 7,
          lock_privkey: validWallet.lock_privkey,
          lock_pubkey: validWallet.lock_pubkey,
          mnemonic_fingerprint: "cc".repeat(32),
          mints: ["https://mint.example"],
          proofs: [
            {
              mint: "https://mint.example",
              secret: "s",
              C: "02C",
              amount: 8,
              id: "k1",
              locked_to_pubkey: validWallet.lock_pubkey,
              status: "valid",
            },
          ],
          nut13_counters: { "https://mint.example": { k1: 2 } },
          pending_mints: [],
          pending_submissions: [],
          recent_spends: [],
          created_at: "2026-05-09T00:00:00.000Z",
        })
      );
      const migrated = loadAgentWallet();
      expect(migrated?.version).toBe(WALLET_VERSION);
      expect(migrated?.pending_melts).toEqual([]);
      expect(migrated?.proofs).toHaveLength(1);
      expect(migrated?.mnemonic_fingerprint).toBe("cc".repeat(32));
      expect(migrated?.nut13_counters).toEqual({ "https://mint.example": { k1: 2 } });
    });

    it("migrates a v8 wallet to v9 while preserving pending mints without expiry", () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(
        JSON.stringify({
          version: 8,
          lock_privkey: validWallet.lock_privkey,
          lock_pubkey: validWallet.lock_pubkey,
          mnemonic_fingerprint: null,
          mints: ["https://mint.example"],
          proofs: [],
          nut13_counters: {},
          pending_mints: [
            {
              mint: "https://mint.example",
              quote_id: "legacy-quote",
              amount_sats: 100,
              requested_at: "2026-05-09T12:00:00.000Z",
            },
          ],
          pending_melts: [],
          pending_submissions: [],
          recent_spends: [],
          created_at: "2026-05-09T00:00:00.000Z",
        })
      );

      const migrated = loadAgentWallet();
      expect(migrated?.version).toBe(WALLET_VERSION);
      expect(migrated?.pending_mints).toHaveLength(1);
      expect(migrated?.pending_mints[0]).toMatchObject({ quote_id: "legacy-quote" });
      expect(migrated?.pending_mints[0].expires_at).toBeUndefined();
    });

    it("migrates a v6 wallet to v7 in-memory, preserving fields and adding no defaults for reserved_for/t_expire", () => {
      // v6 → v7 just bumps the version; proofs already on disk are
      // free-balance, so they keep reserved_for/t_expire unset.
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(
        JSON.stringify({
          version: 6,
          lock_privkey: validWallet.lock_privkey,
          lock_pubkey: validWallet.lock_pubkey,
          mnemonic_fingerprint: "ee".repeat(32),
          mints: ["https://mint.example"],
          proofs: [
            {
              mint: "https://mint.example",
              secret: "x",
              C: "02y",
              amount: 4,
              id: "k1",
              locked_to_pubkey: validWallet.lock_pubkey,
              status: "valid",
            },
          ],
          nut13_counters: { "https://mint.example": { k1: 3 } },
          pending_mints: [],
          pending_submissions: [],
          recent_spends: [],
          created_at: "2026-05-09T00:00:00.000Z",
        })
      );
      const migrated = loadAgentWallet();
      expect(migrated?.version).toBe(WALLET_VERSION);
      expect(migrated?.proofs).toHaveLength(1);
      expect(migrated?.proofs[0].reserved_for).toBeUndefined();
      expect(migrated?.proofs[0].t_expire).toBeUndefined();
      expect(migrated?.mnemonic_fingerprint).toBe("ee".repeat(32));
      expect(migrated?.nut13_counters).toEqual({ "https://mint.example": { k1: 3 } });
    });

    it("preserves nut13_counters and mnemonic_fingerprint when a v6 wallet round-trips through migrateV5ToV6 (defensive)", () => {
      // v6 records loaded straight through to migrateV5ToV6 must keep their
      // existing counters/fingerprint — that path runs when a v5-shaped JSON
      // happens to carry the v6 fields already.
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(
        JSON.stringify({
          version: 5,
          lock_privkey: validWallet.lock_privkey,
          lock_pubkey: validWallet.lock_pubkey,
          mnemonic_fingerprint: "ff".repeat(32),
          mints: [],
          proofs: [],
          nut13_counters: { "https://mint.example": { k1: 7 } },
          pending_mints: [],
          pending_submissions: [],
          recent_spends: [],
          created_at: "2026-05-09T00:00:00.000Z",
        })
      );
      const migrated = loadAgentWallet();
      expect(migrated?.mnemonic_fingerprint).toBe("ff".repeat(32));
      expect(migrated?.nut13_counters).toEqual({ "https://mint.example": { k1: 7 } });
    });

    it("migrates a v3 wallet to v9 in-memory, renaming recovery_* fields", () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(
        JSON.stringify({
          version: 3,
          recovery_privkey: validWallet.lock_privkey,
          recovery_pubkey: validWallet.lock_pubkey,
          mints: ["https://mint.example"],
          proofs: [],
          pending_mints: [],
          recent_spends: [],
          created_at: "2026-05-09T00:00:00.000Z",
        })
      );
      const migrated = loadAgentWallet();
      expect(migrated?.version).toBe(WALLET_VERSION);
      expect(migrated?.lock_privkey).toBe(validWallet.lock_privkey);
      expect(migrated?.lock_pubkey).toBe(validWallet.lock_pubkey);
      expect(migrated?.recent_spends).toEqual([]);
    });

    it("refuses to migrate a v1 wallet with populated legacy data", () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(
        JSON.stringify({
          version: 1,
          recovery_privkey: validWallet.lock_privkey,
          recovery_pubkey: validWallet.lock_pubkey,
          mints: [],
          proofs: [{ id: "k1", amount: 1, secret: "x", C: "02y" }],
          pending_mints: [],
          created_at: "2026-05-09T00:00:00.000Z",
        })
      );
      try {
        loadAgentWallet();
        expect.unreachable("should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(DvmError);
        expect((e as DvmError).code).toBe("wallet_unknown_version");
      }
    });

    it("rejects malformed JSON with wallet_corrupt", () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue("{not json");
      try {
        loadAgentWallet();
        expect.unreachable("should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(DvmError);
        expect((e as DvmError).code).toBe("wallet_corrupt");
      }
    });

    it("rejects a JSON file missing the version field with wallet_corrupt", () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ lock_privkey: "x" }));
      try {
        loadAgentWallet();
        expect.unreachable("should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(DvmError);
        expect((e as DvmError).code).toBe("wallet_corrupt");
      }
    });
  });

  describe("saveAgentWallet", () => {
    it("creates the config dir, writes a 0600 tmp file, then renames atomically", () => {
      saveAgentWallet(validWallet);
      expect(vi.mocked(writeFileSync).mock.calls.some(([path]) => path === "/mock/.dvm/wallet.json")).toBe(false);

      expect(mkdirSync).toHaveBeenCalledWith("/mock/.dvm", { recursive: true, mode: 0o700 });
      expect(writeFileSync).toHaveBeenCalledWith(
        "/mock/.dvm/wallet.json.tmp",
        expect.stringContaining(`"version": ${String(WALLET_VERSION)}`),
        { mode: 0o600 }
      );
      expect(renameSync).toHaveBeenCalledWith(
        "/mock/.dvm/wallet.json.tmp",
        "/mock/.dvm/wallet.json"
      );
    });

    it("persists optional DLEQ without dropping the proof blinding factor", () => {
      saveAgentWallet({
        ...validWallet,
        proofs: [
          {
            mint: "https://mint.example",
            secret: "s",
            C: "02C",
            amount: 4,
            id: "k1",
            dleq: { e: "dleq-e", s: "dleq-s", r: "blind-r" },
            locked_to_pubkey: validWallet.lock_pubkey,
            status: "valid",
          },
        ],
      });

      const json = vi.mocked(writeFileSync).mock.calls[0][1] as string;
      const persisted = JSON.parse(json) as AgentWallet;
      expect(persisted.proofs[0].dleq).toEqual({
        e: "dleq-e",
        s: "dleq-s",
        r: "blind-r",
      });
    });

    it("crash sim: rename fails after tmp write — best-effort cleanup, no rename, error propagates", () => {
      vi.mocked(renameSync).mockImplementationOnce(() => {
        throw new Error("ENOSPC");
      });

      expect(() => {
        saveAgentWallet(validWallet);
      }).toThrow("ENOSPC");

      expect(writeFileSync).toHaveBeenCalledWith("/mock/.dvm/wallet.json.tmp", expect.any(String), {
        mode: 0o600,
      });
      expect(unlinkSync).toHaveBeenCalledWith("/mock/.dvm/wallet.json.tmp");
    });

  });

  describe("PendingMint.minting sub-state", () => {
    it("round-trips through save → load with the minting blob intact", () => {
      const withMinting: AgentWallet = {
        ...validWallet,
        pending_mints: [
          {
            mint: "https://mint.example",
            quote_id: "crash-quote",
            amount_sats: 100,
            requested_at: "2026-05-09T12:00:00.000Z",
            minting: {
              keyset_id: "k1",
              outputs: [
                {
                  blinded_message: { amount: 64, B_: "02BB64", id: "k1" },
                  blinding_factor: "0a",
                  secret: "5b2250324f50225d",
                },
                {
                  blinded_message: { amount: 32, B_: "02BB32", id: "k1" },
                  blinding_factor: "0b",
                  secret: "5b2250324f50225d",
                  ephemeral_e: "deadbeef",
                },
              ],
            },
          },
        ],
      };
      saveAgentWallet(withMinting);
      const written = vi.mocked(writeFileSync).mock.calls[0][1] as string;

      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(written);
      const loaded = loadAgentWallet();
      expect(loaded).toEqual(withMinting);
      expect(loaded?.pending_mints[0].minting?.outputs).toHaveLength(2);
      expect(loaded?.pending_mints[0].minting?.outputs[1].ephemeral_e).toBe("deadbeef");
    });
  });

  describe("PendingSubmission.accepted_unresolved", () => {
    const acceptedUnresolved = {
      kind: "identity_mismatch",
      observed_at: "2026-10-10T12:00:00.000Z",
      header_job_id: "job-a",
      body_job_id: "b".repeat(512),
      accepted_job_id: "job-a",
      ambiguity_id: "ambiguity-1",
    } as const;
    const submission: PendingSubmission = {
      endpoint: "https://dvm.example",
      request_id: "11111111-1111-4111-8111-111111111111",
      intended_lock_pubkey: "02" + "ef".repeat(32),
      mint: "https://mint.example",
      amount_sats: 21,
      output_proofs: [],
      created_at: "2026-10-10T11:59:00.000Z",
      accepted_unresolved: acceptedUnresolved,
    };

    function loadRaw(wallet: Record<string, unknown>) {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(JSON.stringify(wallet));
      return loadAgentWallet();
    }

    it("round-trips through save → load intact", () => {
      const wallet: AgentWallet = { ...validWallet, pending_submissions: [submission] };
      saveAgentWallet(wallet);
      const written = vi.mocked(writeFileSync).mock.calls[0][1] as string;
      expect(loadRaw(JSON.parse(written) as Record<string, unknown>)).toEqual(wallet);
    });

    it.each([5, 6, 7, 8])("survives migration from a v%i wallet", (version) => {
      const migrated = loadRaw({
        version,
        lock_privkey: validWallet.lock_privkey,
        lock_pubkey: validWallet.lock_pubkey,
        mints: [],
        proofs: [],
        pending_mints: [],
        pending_submissions: [submission],
        created_at: "2026-05-09T00:00:00.000Z",
      });
      expect(migrated?.version).toBe(WALLET_VERSION);
      expect(migrated?.pending_submissions[0].accepted_unresolved).toEqual(acceptedUnresolved);
    });

    const malformed: [string, Record<string, unknown>][] = [
      ["an unknown kind", { kind: "mismatch" }],
      ["a missing ambiguity_id", { ambiguity_id: undefined }],
      ["a non-timestamp observed_at", { observed_at: "yesterday" }],
      ["a date-only observed_at", { observed_at: "2026-10-10" }],
      ["a free-form observed_at Date.parse accepts", { observed_at: "October 10, 2026" }],
      ["an impossible calendar day", { observed_at: "2026-02-30T12:00:00.000Z" }],
      ["an observed_at without an offset", { observed_at: "2026-10-10T12:00:00" }],
      ["a job ID over 512 characters", { body_job_id: "b".repeat(513) }],
      ["a job ID with a TAB", { accepted_job_id: "job\t1" }],
      ["a job ID with an escape sequence", { header_job_id: "job-a\u001b[2J" }],
      ["a job ID with a C1 control character", { accepted_job_id: "job-a\u0085" }],
    ];

    it.each(malformed)("refuses to save a record with %s and writes nothing", (_name, change) => {
      const bad = { ...submission, accepted_unresolved: { ...acceptedUnresolved, ...change } };
      try {
        saveAgentWallet({ ...validWallet, pending_submissions: [bad as PendingSubmission] });
        expect.unreachable("should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(DvmError);
        expect((e as DvmError).code).toBe("accepted_unresolved_invalid");
      }
      // The prior wallet file is left exactly as it was.
      expect(writeFileSync).not.toHaveBeenCalled();
      expect(renameSync).not.toHaveBeenCalled();
    });

    it("loads a wallet holding proofs and a malformed record with the proofs intact and the marker kept", () => {
      const proof = {
        mint: "https://mint.example",
        secret: "s",
        C: "02C",
        amount: 1000,
        id: "k1",
        locked_to_pubkey: validWallet.lock_pubkey,
        status: "valid" as const,
      };
      const loaded = loadRaw({
        ...validWallet,
        proofs: [proof],
        pending_submissions: [
          {
            ...submission,
            accepted_unresolved: {
              kind: "router_identity_conflict",
              observed_at: acceptedUnresolved.observed_at,
              header_job_id: "job-a",
              body_job_id: "b".repeat(513),
              accepted_job_id: "job\t1",
            },
          },
        ],
      });

      expect(loaded?.proofs).toEqual([proof]);
      expect(loaded?.pending_submissions[0].accepted_unresolved).toEqual({
        kind: "router_identity_conflict",
        observed_at: acceptedUnresolved.observed_at,
        header_job_id: "job-a",
        ambiguity_id: submission.request_id,
      });
      // The repaired wallet is storable again, so the next write cannot fail on it.
      expect(() => saveAgentWallet(loaded!)).not.toThrow();
    });

    it.each([
      ["an unknown kind", { ...acceptedUnresolved, kind: "mismatch" }, { kind: "body_unreadable" }],
      [
        "a non-timestamp observed_at",
        { ...acceptedUnresolved, observed_at: "yesterday" },
        { observed_at: "1970-01-01T00:00:00.000Z" },
      ],
      [
        "a record that is not an object",
        "unresolved",
        {
          kind: "body_unreadable",
          observed_at: "1970-01-01T00:00:00.000Z",
          ambiguity_id: submission.request_id,
        },
      ],
    ])("keeps a record with %s as a marker with placeholder values", (_name, stored, expected) => {
      const loaded = loadRaw({
        ...validWallet,
        pending_submissions: [{ ...submission, accepted_unresolved: stored }],
      });
      expect(loaded?.pending_submissions[0].accepted_unresolved).toMatchObject(expected);
    });

    it("falls back to missing-ambiguity when the request_id is itself unstorable", () => {
      const loaded = loadRaw({
        ...validWallet,
        pending_submissions: [
          { ...submission, request_id: "req\t1", accepted_unresolved: { ...acceptedUnresolved, ambiguity_id: "" } },
        ],
      });
      expect(loaded?.pending_submissions[0].accepted_unresolved?.ambiguity_id).toBe("missing-ambiguity");
    });

    it("accepts an ISO-8601 observed_at with a numeric offset", () => {
      const wallet: AgentWallet = {
        ...validWallet,
        pending_submissions: [
          { ...submission, accepted_unresolved: { ...acceptedUnresolved, observed_at: "2026-10-10T14:00:00+02:00" } },
        ],
      };
      expect(() => saveAgentWallet(wallet)).not.toThrow();
    });

    it.each([
      ["no pending_submissions field", { ...validWallet, pending_submissions: undefined }],
      ["a null pending submission", { ...validWallet, pending_submissions: [null] }],
    ])("saves a wallet with %s without a TypeError", (_name, wallet) => {
      expect(() => saveAgentWallet(wallet as unknown as AgentWallet)).not.toThrow();
      expect(writeFileSync).toHaveBeenCalledOnce();
    });

    it.each([
      ["512 code units", "a".repeat(512), true],
      ["non-ASCII text", "job-\u00e9", true],
      ["513 code units", "a".repeat(513), false],
      ["an empty string", "", false],
      ["NUL", "job\u00001", false],
      ["TAB", "job\t1", false],
      ["DEL", "job\u007f1", false],
      ["U+0080", "job\u00801", false],
      ["U+009F", "job\u009f1", false],
    ])("isStorableJobId classifies %s", (_name, value, expected) => {
      expect(isStorableJobId(value)).toBe(expected);
    });
  });

  describe("effectiveMints", () => {
    it("returns the configured mint list when populated", () => {
      expect(effectiveMints({ mints: ["https://a", "https://b"] })).toEqual([
        "https://a",
        "https://b",
      ]);
    });

    it("falls back to the default Coinos mint when empty", () => {
      expect(effectiveMints({ mints: [] })).toEqual([DEFAULT_AGENT_MINT_URL]);
    });
  });

  describe("effectiveFundingMint", () => {
    it("returns the first configured mint with source=configured", () => {
      expect(effectiveFundingMint(["https://a", "https://b"])).toEqual({
        url: "https://a",
        source: "configured",
      });
    });

    it("returns the built-in default with source=fallback when empty", () => {
      expect(effectiveFundingMint([])).toEqual({
        url: DEFAULT_AGENT_MINT_URL,
        source: "fallback",
      });
    });
  });
});
