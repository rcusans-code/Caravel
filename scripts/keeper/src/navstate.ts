// NAV guard state that must survive a keeper restart (keeper-launder side):
// the navguard latch and the last price released per asset. Without it a
// restart after ~20 nav-keeper re-posts of a bad price finds no pre-jump
// record in prices(asset, 20) and releases the bad price.
//
// One JSON file per oracle (a redeploy with a new oracle starts clean):
// NAV_STATE_FILE, default ${XDG_STATE_HOME:-~/.local/state}/caravel/navguard-<ORACLE_ID>.json.
// Written atomically (tmp + rename) only when it changed.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { NavLatch } from "./navguard.js";

export interface NavState {
  latch: NavLatch;
  /** asset id -> last price the guard released (hold false). */
  trusted: Map<string, bigint>;
}

interface Json {
  version: 1;
  oracle: string;
  assets: Record<string, { trusted?: string; latch?: { anchor: string; bad: string[] } }>;
}

export const emptyNavState = (): NavState => ({ latch: new Map(), trusted: new Map() });

export function navStatePath(oracle: string, env: NodeJS.ProcessEnv = process.env): string {
  if (env.NAV_STATE_FILE) return env.NAV_STATE_FILE;
  const base = env.XDG_STATE_HOME || path.join(homedir(), ".local", "state");
  return path.join(base, "caravel", `navguard-${oracle}.json`);
}

export function serializeNavState(oracle: string, s: NavState): string {
  const assets: Json["assets"] = {};
  const ids = new Set([...s.trusted.keys(), ...s.latch.keys()]);
  for (const id of [...ids].sort()) {
    const t = s.trusted.get(id);
    const l = s.latch.get(id);
    assets[id] = {
      ...(t !== undefined ? { trusted: t.toString() } : {}),
      ...(l ? { latch: { anchor: l.anchor.toString(), bad: [...l.bad].map(String).sort() } } : {}),
    };
  }
  return JSON.stringify({ version: 1, oracle, assets } satisfies Json, null, 1) + "\n";
}

/** Parse a state file body; throws on a malformed file or one written for another oracle. */
export function parseNavState(raw: string, oracle: string): NavState {
  const j = JSON.parse(raw) as Json;
  if (j.version !== 1 || typeof j.assets !== "object" || j.assets === null) throw new Error("unknown state format");
  if (j.oracle !== oracle) throw new Error(`state is for oracle ${String(j.oracle).slice(0, 8)}…, not ${oracle.slice(0, 8)}…`);
  const s = emptyNavState();
  for (const [id, a] of Object.entries(j.assets)) {
    if (a.trusted !== undefined) s.trusted.set(id, BigInt(a.trusted));
    if (a.latch) s.latch.set(id, { anchor: BigInt(a.latch.anchor), bad: new Set(a.latch.bad.map((p) => BigInt(p))) });
  }
  return s;
}

/**
 * Read the state file. A missing file is a clean start (`error` undefined);
 * an unreadable one starts empty and returns the reason, for the caller to
 * log and alert (the guard then works as before: in memory from here on).
 */
export function loadNavState(file: string, oracle: string): { state: NavState; error?: string } {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { state: emptyNavState() };
    return { state: emptyNavState(), error: (e as Error).message };
  }
  try {
    return { state: parseNavState(raw, oracle) };
  } catch (e) {
    return { state: emptyNavState(), error: `${file}: ${(e as Error).message}` };
  }
}

/** Write `body` to `file` atomically (tmp file + rename), creating the directory. */
export function saveNavState(file: string, body: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, body, { mode: 0o600 });
  renameSync(tmp, file);
}
