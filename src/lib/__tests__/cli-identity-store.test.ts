import { mkdtempSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as DefaultsModule from "../../defaults";

let tmp: string;

vi.mock("../../defaults", async () => {
  const mod = await vi.importActual<typeof DefaultsModule>("../../defaults");
  return {
    ...mod,
    get CONFIG_DIR() {
      return tmp;
    },
    get IDENTITIES_FILE() {
      return join(tmp, "identities.json");
    },
  };
});

import { IDENTITIES_FILE } from "../../defaults";
import {
  type CliIdentityEntry,
  deriveIdentityFromPrivkey,
  generateIdentity,
  IDENTITIES_VERSION,
  identitiesFileExists,
  loadIdentities,
  saveIdentities,
} from "../cli-identity-store";
import { DvmError } from "../errors";

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "dvm-identity-store-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("generateIdentity", () => {
  it("produces 64-char hex privkey + pubkey and a createdAt timestamp", () => {
    const entry = generateIdentity(1700000000000);
    expect(entry.privkey).toMatch(/^[0-9a-f]{64}$/);
    expect(entry.pubkey).toMatch(/^[0-9a-f]{64}$/);
    expect(entry.createdAt).toBe(1700000000000);
  });

  it("never returns the same keypair twice", () => {
    const a = generateIdentity();
    const b = generateIdentity();
    expect(a.privkey).not.toBe(b.privkey);
  });
});

describe("deriveIdentityFromPrivkey", () => {
  it("derives the same pubkey for the same secret as generateIdentity", () => {
    const a = generateIdentity(123);
    const b = deriveIdentityFromPrivkey(a.privkey, 456);
    expect(b.pubkey).toBe(a.pubkey);
    expect(b.createdAt).toBe(456);
  });

  it("rejects a malformed hex secret", () => {
    expect(() => deriveIdentityFromPrivkey("not-hex")).toThrow(DvmError);
    expect(() => deriveIdentityFromPrivkey("ab".repeat(31))).toThrow(DvmError);
    expect(() => deriveIdentityFromPrivkey("AB".repeat(32))).toThrow(DvmError);
  });
});

describe("save/load roundtrip", () => {
  it("returns null and reports missing when the file does not exist", () => {
    expect(loadIdentities()).toBeNull();
    expect(identitiesFileExists()).toBe(false);
  });

  it("writes mode 0600 and roundtrips", () => {
    const entry: CliIdentityEntry = generateIdentity(1);
    saveIdentities({ version: IDENTITIES_VERSION, identities: { default: entry } });

    expect(identitiesFileExists()).toBe(true);
    const mode = statSync(IDENTITIES_FILE).mode & 0o777;
    expect(mode).toBe(0o600);
    expect(() => statSync(`${IDENTITIES_FILE}.tmp`)).toThrow();

    const loaded = loadIdentities();
    expect(loaded?.version).toBe(IDENTITIES_VERSION);
    expect(loaded?.identities.default).toEqual(entry);
  });

  it("rejects bad JSON with identities_corrupt", () => {
    writeFileSync(IDENTITIES_FILE, "{not json", "utf-8");
    expect(() => loadIdentities()).toThrow(expect.objectContaining({ code: "identities_corrupt" }));
  });

  it("rejects an unknown version", () => {
    writeFileSync(IDENTITIES_FILE, JSON.stringify({ version: 999, identities: {} }), "utf-8");
    expect(() => loadIdentities()).toThrow(
      expect.objectContaining({ code: "identities_unknown_version" })
    );
  });

  it("rejects a missing identities map", () => {
    writeFileSync(IDENTITIES_FILE, JSON.stringify({ version: 1 }), "utf-8");
    expect(() => loadIdentities()).toThrow(expect.objectContaining({ code: "identities_corrupt" }));
  });

});
