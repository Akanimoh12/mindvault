import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import {
  exportState,
  restoreState,
  StateBackupError,
  readPersistedState,
} from "./stateBackup.js";
import { STATE_VERSION, type ProfileState } from "./profiles.js";

const STATE_DIR = join(homedir(), ".mindvault");
const STATE_FILE = join(STATE_DIR, "state.json");
const PASS = "test-passphrase-ok";

const sample: ProfileState = {
  version: STATE_VERSION,
  activeProfile: "publisher",
  profiles: {
    publisher: {
      wallet: { publicKey: "GPUB", secretKey: "SSECRET" },
      apiKey: "api-key-xyz",
    },
    buyer: {
      wallet: { publicKey: "GBUY", secretKey: "SBUY" },
    },
  },
};

function writeState(state: ProfileState = sample): void {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), { mode: 0o600 });
}

describe("stateBackup", () => {
  const original = existsSync(STATE_FILE) ? readFileSync(STATE_FILE, "utf-8") : null;

  beforeEach(() => {
    writeState();
  });

  afterEach(() => {
    if (original !== null) {
      writeFileSync(STATE_FILE, original, { mode: 0o600 });
    } else if (existsSync(STATE_FILE)) {
      rmSync(STATE_FILE);
    }
  });

  it("exportState rejects short passphrases", () => {
    expect(() => exportState("short")).toThrow(StateBackupError);
    expect(() => exportState("short")).toThrow(/at least 8/);
  });

  it("exportState fails when state file is missing", () => {
    rmSync(STATE_FILE);
    expect(() => exportState(PASS)).toThrow(/No state file/);
  });

  it("exportState never leaks plaintext secrets", () => {
    const blob = exportState(PASS);
    expect(blob.startsWith("v1:")).toBe(true);
    expect(blob).not.toContain("SSECRET");
    expect(blob).not.toContain("SBUY");
    expect(blob).not.toContain("api-key-xyz");
    expect(blob).not.toContain("GPUB");
  });

  it("round-trips export → restore with same passphrase", () => {
    const blob = exportState(PASS);
    let restored: ProfileState | null = null;
    const msg = restoreState(blob, PASS, (s) => {
      restored = s;
    });
    expect(msg).toContain("2 profile");
    expect(msg).toContain("publisher");
    expect(restored).toEqual(sample);
  });

  it("restore rejects wrong passphrase without calling write", () => {
    const blob = exportState(PASS);
    let wrote = false;
    expect(() =>
      restoreState(blob, "wrong-passphrase", () => {
        wrote = true;
      }),
    ).toThrow(/integrity check failed/);
    expect(wrote).toBe(false);
  });

  it("restore rejects tampered blob without calling write", () => {
    const blob = exportState(PASS);
    const parts = blob.split(":");
    // flip last char of ciphertext
    const last = parts[3];
    const flipped =
      last.slice(0, -1) + (last.endsWith("A") ? "B" : "A");
    const tampered = `${parts[0]}:${parts[1]}:${parts[2]}:${flipped}`;
    let wrote = false;
    expect(() =>
      restoreState(tampered, PASS, () => {
        wrote = true;
      }),
    ).toThrow(StateBackupError);
    expect(wrote).toBe(false);
  });

  it("restore rejects invalid format", () => {
    expect(() => restoreState("not-a-blob", PASS, () => {})).toThrow(/Invalid backup format/);
    expect(() => restoreState("v2:a:b:c", PASS, () => {})).toThrow(/Invalid backup format/);
  });

  it("readPersistedState returns normalized profiles", () => {
    const state = readPersistedState();
    expect(state.activeProfile).toBe("publisher");
    expect(state.profiles.publisher?.wallet?.secretKey).toBe("SSECRET");
    expect(state.profiles.buyer?.wallet?.publicKey).toBe("GBUY");
  });
});
