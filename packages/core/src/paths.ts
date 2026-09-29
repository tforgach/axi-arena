import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Root for the DB, run artifacts and trial dirs. Override with AXI_ARENA_HOME. */
export function arenaHome(): string {
  const dir = process.env.AXI_ARENA_HOME || join(homedir(), ".axi-arena");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function runDir(runId: string): string {
  const dir = join(arenaHome(), "runs", runId);
  mkdirSync(dir, { recursive: true });
  return dir;
}
