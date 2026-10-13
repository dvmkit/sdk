import { describe, expect, it, vi } from "vitest";

vi.mock("fs");
vi.mock("../../defaults", () => ({
  BUILDER_CONFIG_DIR: "/mock/.dvmkit",
  BUILDER_FILE: "/mock/.dvmkit/builder.json",
}));

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "fs";

import {
  findBuilderDvmsByHandle,
  getBuilderDvm,
  loadBuilderStore,
  patchBuilderDvm,
  requireBuilderDvmByHandle,
  setIdentityPubkey,
  upsertBuilderDvm,
} from "../builder-store";

function writtenBuilderStore(): string {
  const call = vi
    .mocked(writeFileSync)
    .mock.calls.find(([path]) => path === "/mock/.dvmkit/builder.json.tmp");
  expect(call).toBeDefined();
  return call?.[1] as string;
}

describe("loadBuilderStore", () => {
  it("returns an empty v2 store when the file does not exist", () => {
    vi.mocked(existsSync).mockReturnValue(false);
    expect(loadBuilderStore()).toEqual({ version: 2, dvms: {} });
  });

  it("parses a valid v2 store", () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(
      JSON.stringify({
        version: 2,
        dvms: {
          "abc-123": {
            handle: "my-dvm",
            canonical_dvm_id: "abc-123",
            current_rotation_index: 2,
            self_hosted: false,
            updated_at: "2026-05-12T00:00:00.000Z",
          },
        },
      })
    );
    const store = loadBuilderStore();
    expect(store.dvms["abc-123"].canonical_dvm_id).toBe("abc-123");
    expect(store.dvms["abc-123"].current_rotation_index).toBe(2);
  });

  it("migrates v1 slug-keyed state to immutable DVM IDs", () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(
      JSON.stringify({
        version: 1,
        dvms: {
          "my-dvm": {
            canonical_dvm_id: "abc-123",
            current_rotation_index: 2,
            updated_at: "2026-05-12T00:00:00.000Z",
          },
        },
      })
    );

    expect(loadBuilderStore()).toMatchObject({
      version: 2,
      dvms: { "abc-123": { handle: "my-dvm", canonical_dvm_id: "abc-123" } },
    });
  });

  it("throws on invalid JSON", () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue("{ not valid");
    expect(() => loadBuilderStore()).toThrow(/not valid JSON/);
  });

  it("throws on unknown schema version (refuses silent overwrite)", () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ version: 99, dvms: {} }));
    expect(() => loadBuilderStore()).toThrow(/unknown version 99/);
  });

  it("throws when dvms is missing", () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ version: 2 }));
    expect(() => loadBuilderStore()).toThrow(/missing the dvms object/);
  });
});

describe("upsertBuilderDvm", () => {
  it("creates the dir + atomically writes a new entry at mode 0600", () => {
    vi.mocked(existsSync).mockReturnValue(false);
    const writeSpy = vi.mocked(writeFileSync);
    writeSpy.mockClear();
    upsertBuilderDvm("abc-123", {
      handle: "my-dvm",
      canonical_dvm_id: "abc-123",
      current_rotation_index: 0,
    });
    expect(vi.mocked(mkdirSync)).toHaveBeenCalledWith("/mock/.dvmkit", {
      recursive: true,
      mode: 0o700,
    });
    expect(writeSpy).toHaveBeenCalledTimes(1);
    const [path, contents, opts] = writeSpy.mock.calls[0];
    expect(path).toBe("/mock/.dvmkit/builder.json.tmp");
    expect(opts).toEqual({ mode: 0o600 });
    expect(renameSync).toHaveBeenCalledWith(
      "/mock/.dvmkit/builder.json.tmp",
      "/mock/.dvmkit/builder.json"
    );
    expect(chmodSync).toHaveBeenCalledWith("/mock/.dvmkit/builder.json", 0o600);
    const parsed = JSON.parse(contents as string) as { dvms: Record<string, unknown> };
    expect(parsed.dvms["abc-123"]).toMatchObject({
      handle: "my-dvm",
      canonical_dvm_id: "abc-123",
      current_rotation_index: 0,
    });
  });

  it("merges into an existing store rather than overwriting siblings", () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(
      JSON.stringify({
        version: 2,
        dvms: {
          "uuid-existing": {
            handle: "existing",
            canonical_dvm_id: "uuid-existing",
            current_rotation_index: 3,
            updated_at: "2026-05-01T00:00:00.000Z",
          },
        },
      })
    );
    upsertBuilderDvm("uuid-new", {
      handle: "new-dvm",
      canonical_dvm_id: "uuid-new",
      current_rotation_index: 0,
    });
    const parsed = JSON.parse(writtenBuilderStore()) as { dvms: Record<string, unknown> };
    expect(Object.keys(parsed.dvms).sort()).toEqual(["uuid-existing", "uuid-new"]);
    expect(
      (parsed.dvms["uuid-existing"] as { current_rotation_index: number }).current_rotation_index
    ).toBe(3);
  });
});

describe("builder-store persistence", () => {
  it("backs up changed content before setIdentityPubkey replaces it", () => {
    const previous = JSON.stringify({ version: 2, dvms: {} });
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(previous);

    setIdentityPubkey("a".repeat(64));

    const backup = vi
      .mocked(writeFileSync)
      .mock.calls.find(([path]) => String(path).endsWith(".bak"));
    expect(backup).toEqual([
      expect.stringMatching(/^\/mock\/\.dvmkit\/builder\.json\..*\.bak$/),
      previous,
      { mode: 0o600, flag: "wx" },
    ]);
    expect(JSON.parse(writtenBuilderStore())).toMatchObject({
      identity_pubkey: "a".repeat(64),
    });
  });

  it("does not litter backups when the serialized content is unchanged", () => {
    const store = { version: 2, identity_pubkey: "a".repeat(64), dvms: {} };
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify(store, null, 2) + "\n");

    setIdentityPubkey("a".repeat(64));

    expect(vi.mocked(writeFileSync)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(writeFileSync)).toHaveBeenCalledWith(
      "/mock/.dvmkit/builder.json.tmp",
      JSON.stringify(store, null, 2) + "\n",
      { mode: 0o600 }
    );
  });

  it("leaves the live file untouched and cleans up when rename fails", () => {
    const previous = JSON.stringify({ version: 2, dvms: {} });
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(previous);
    vi.mocked(renameSync).mockImplementationOnce(() => {
      throw new Error("ENOSPC");
    });

    expect(() => setIdentityPubkey("b".repeat(64))).toThrow("ENOSPC");

    expect(unlinkSync).toHaveBeenCalledWith("/mock/.dvmkit/builder.json.tmp");
    expect(
      vi.mocked(writeFileSync).mock.calls.filter(([path]) => path === "/mock/.dvmkit/builder.json")
    ).toHaveLength(0);
    expect(chmodSync).not.toHaveBeenCalled();
  });

  it("rejects a missing patch target before creating backup or temp files", () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ version: 2, dvms: {} }));

    expect(() => patchBuilderDvm("missing", { current_rotation_index: 1 })).toThrow(
      /no entry exists/
    );

    expect(writeFileSync).not.toHaveBeenCalled();
    expect(renameSync).not.toHaveBeenCalled();
  });
});

describe("getBuilderDvm", () => {
  it("returns undefined when the handle is unknown", () => {
    vi.mocked(existsSync).mockReturnValue(false);
    expect(getBuilderDvm("missing")).toBeUndefined();
  });

  it("returns the entry when the immutable DVM ID exists", () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(
      JSON.stringify({
        version: 2,
        dvms: {
          "abc-123": {
            handle: "my-dvm",
            canonical_dvm_id: "abc-123",
            current_rotation_index: 0,
            updated_at: "2026-05-12T00:00:00.000Z",
          },
        },
      })
    );
    expect(getBuilderDvm("abc-123")?.canonical_dvm_id).toBe("abc-123");
  });
});

describe("same-slug DVM state", () => {
  it("keeps lock and payout state independent across two orgs", () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(
      JSON.stringify({
        version: 2,
        dvms: {
          "dvm-personal-scrape": {
            handle: "scrape",
            canonical_dvm_id: "dvm-personal-scrape",
            current_rotation_index: 1,
            payout_ln_address: "personal@example.com",
            updated_at: "2026-05-01T00:00:00.000Z",
          },
          "dvm-acme-scrape": {
            handle: "scrape",
            canonical_dvm_id: "dvm-acme-scrape",
            current_rotation_index: 4,
            payout_ln_address: "acme@example.com",
            updated_at: "2026-05-02T00:00:00.000Z",
          },
        },
      })
    );
    patchBuilderDvm("dvm-acme-scrape", { payout_ln_address: "ops@example.com" });

    const parsed = JSON.parse(writtenBuilderStore()) as {
      dvms: Record<string, Record<string, unknown>>;
    };
    expect(parsed.dvms["dvm-personal-scrape"]).toMatchObject({
      current_rotation_index: 1,
      payout_ln_address: "personal@example.com",
    });
    expect(parsed.dvms["dvm-acme-scrape"]).toMatchObject({
      current_rotation_index: 4,
      payout_ln_address: "ops@example.com",
    });
  });
});

describe("by-handle resolution", () => {
  /** A legacy v1 store, keyed by slug, written by `dvmctl deploy`. */
  function v1PlatformStore(): void {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(
      JSON.stringify({
        version: 1,
        dvms: {
          scrape: {
            canonical_dvm_id: "dvm-platform-scrape",
            current_rotation_index: 2,
            payout_ln_address: "payout@example.com",
            updated_at: "2026-05-01T00:00:00.000Z",
          },
        },
      })
    );
  }

  it("finds a platform-deployed entry, which carries no self_hosted flag", () => {
    v1PlatformStore();

    // Platform-deployed entries lack `self_hosted` but remain valid builder targets.
    expect(requireBuilderDvmByHandle("scrape")).toMatchObject({
      handle: "scrape",
      canonical_dvm_id: "dvm-platform-scrape",
      current_rotation_index: 2,
    });
  });

  it("refuses rather than picking when two entries share a handle", () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(
      JSON.stringify({
        version: 2,
        dvms: {
          "dvm-personal-scrape": {
            handle: "scrape",
            canonical_dvm_id: "dvm-personal-scrape",
            current_rotation_index: 1,
            updated_at: "2026-05-01T00:00:00.000Z",
          },
          "dvm-acme-scrape": {
            handle: "scrape",
            canonical_dvm_id: "dvm-acme-scrape",
            current_rotation_index: 4,
            updated_at: "2026-05-02T00:00:00.000Z",
          },
        },
      })
    );

    expect(findBuilderDvmsByHandle("scrape")).toHaveLength(2);
    expect(() => requireBuilderDvmByHandle("scrape")).toThrow(
      expect.objectContaining({
        code: "ambiguous_dvm_handle",
        hint: expect.stringContaining("dvm-acme-scrape"),
      })
    );
  });

  it("states what `init --self-hosted` would cost instead of just naming it", () => {
    vi.mocked(existsSync).mockReturnValue(false);

    expect(() => requireBuilderDvmByHandle("scrape")).toThrow(
      expect.objectContaining({
        code: "dvm_not_initialized",
        hint: expect.stringContaining("underivable"),
      })
    );
  });
});
