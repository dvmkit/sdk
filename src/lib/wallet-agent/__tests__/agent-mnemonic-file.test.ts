import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs");
vi.mock("../../../defaults", () => ({
  AGENT_MNEMONIC_FILE: "/mock/.dvm/wallet.mnemonic",
  CONFIG_DIR: "/mock/.dvm",
}));

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";

import { DvmError } from "../../errors";
import { deleteAgentMnemonic, readAgentMnemonic, writeAgentMnemonic } from "../agent-mnemonic-file";

const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const OTHER = "zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong";

function present(...paths: string[]): void {
  vi.mocked(existsSync).mockImplementation((p) => paths.includes(String(p)));
}

beforeEach(() => {
  vi.clearAllMocks();
  present();
});

describe("readAgentMnemonic", () => {
  it("returns null when the file does not exist", () => {
    present();
    expect(readAgentMnemonic()).toBeNull();
    expect(readFileSync).not.toHaveBeenCalled();
  });

  it("returns the trimmed, normalised mnemonic when present", () => {
    present("/mock/.dvm/wallet.mnemonic");
    vi.mocked(readFileSync).mockReturnValue(
      `  ABANDON   abandon\tabandon abandon abandon abandon abandon abandon abandon abandon abandon ABOUT  \n`
    );
    expect(readAgentMnemonic()).toBe(MNEMONIC);
  });
});

describe("writeAgentMnemonic", () => {
  it("creates the config dir 0700, writes a 0600 tmp file, then renames atomically", () => {
    const result = writeAgentMnemonic(
      `  ABANDON   abandon\tabandon abandon abandon abandon abandon abandon abandon abandon abandon ABOUT  `
    );

    expect(mkdirSync).toHaveBeenCalledWith("/mock/.dvm", { recursive: true, mode: 0o700 });
    expect(writeFileSync).toHaveBeenCalledWith("/mock/.dvm/wallet.mnemonic.tmp", MNEMONIC + "\n", {
      mode: 0o600,
    });
    expect(renameSync).toHaveBeenCalledWith(
      "/mock/.dvm/wallet.mnemonic.tmp",
      "/mock/.dvm/wallet.mnemonic"
    );
    expect(chmodSync).toHaveBeenCalledWith("/mock/.dvm/wallet.mnemonic", 0o600);
    expect(result.backupFile).toBeNull();
  });

  it("refuses to overwrite an existing mnemonic without force", () => {
    present("/mock/.dvm/wallet.mnemonic");

    try {
      writeAgentMnemonic(OTHER);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(DvmError);
      expect((err as DvmError).code).toBe("agent_mnemonic_exists");
    }

    expect(writeFileSync).not.toHaveBeenCalled();
    expect(renameSync).not.toHaveBeenCalled();
  });

  it("force copies the prior words aside at 0600 before replacing them", () => {
    present("/mock/.dvm/wallet.mnemonic");
    vi.mocked(readFileSync).mockReturnValue(`${MNEMONIC}\n`);

    const result = writeAgentMnemonic(OTHER, { force: true });

    expect(result.backupFile).toMatch(/^\/mock\/\.dvm\/wallet\.mnemonic\..*\.bak$/);
    // Created 0600 with an exclusive flag — the words are never on disk at a
    // wider mode, and we can't land on top of a concurrent backup.
    expect(writeFileSync).toHaveBeenCalledWith(result.backupFile, `${MNEMONIC}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    expect(renameSync).toHaveBeenCalledWith(
      "/mock/.dvm/wallet.mnemonic.tmp",
      "/mock/.dvm/wallet.mnemonic"
    );
    expect(vi.mocked(writeFileSync).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(renameSync).mock.invocationCallOrder[0]
    );
  });

  it("skips the backup when the forced write is the same mnemonic", () => {
    present("/mock/.dvm/wallet.mnemonic");
    vi.mocked(readFileSync).mockReturnValue(`${MNEMONIC}\n`);

    const result = writeAgentMnemonic(MNEMONIC, { force: true });

    expect(result.backupFile).toBeNull();
    expect(writeFileSync).toHaveBeenCalledTimes(1);
  });

  it("crash sim: rename fails after tmp write — best-effort cleanup, error propagates", () => {
    vi.mocked(renameSync).mockImplementationOnce(() => {
      throw new Error("ENOSPC");
    });

    expect(() => {
      writeAgentMnemonic(MNEMONIC);
    }).toThrow("ENOSPC");

    expect(unlinkSync).toHaveBeenCalledWith("/mock/.dvm/wallet.mnemonic.tmp");
  });
});

describe("deleteAgentMnemonic", () => {
  it("backs the words up before removing the file", () => {
    present("/mock/.dvm/wallet.mnemonic");
    vi.mocked(readFileSync).mockReturnValue(`${MNEMONIC}\n`);

    const { backupFile } = deleteAgentMnemonic();

    expect(backupFile).toMatch(/^\/mock\/\.dvm\/wallet\.mnemonic\..*\.bak$/);
    expect(writeFileSync).toHaveBeenCalledWith(backupFile, `${MNEMONIC}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    expect(unlinkSync).toHaveBeenCalledWith("/mock/.dvm/wallet.mnemonic");
  });

  it("is a no-op when the file is absent", () => {
    present();
    expect(deleteAgentMnemonic()).toEqual({ backupFile: null });
    expect(unlinkSync).not.toHaveBeenCalled();
  });
});
