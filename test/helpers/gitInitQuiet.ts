// SPDX-License-Identifier: MIT
// One shared `git init` for every test that commits in a temp repo (GH #338, follows GH #330).
// A detached git auto-maintenance/gc child can outlive `git commit` and keep writing under .git
// while cleanup removes the dir (ENOTEMPTY), so the repo is created with auto-maintenance off.
// Pair with rmTemp for cleanup. multiModelRepo.ts applies the same three settings.

import { spawnSync } from "node:child_process";

export const NO_AUTO_MAINTENANCE: ReadonlyArray<readonly [string, string]> = [
  ["maintenance.auto", "false"],
  ["gc.auto", "0"],
  ["maintenance.autoDetach", "false"],
];

/** `git init -q [initArgs...]` in `dir`, then disable auto-maintenance in the repo config. */
export function gitInitQuiet(dir: string, ...initArgs: string[]): void {
  const run = (args: string[]): void => {
    const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  };
  run(["init", "-q", ...initArgs]);
  for (const [k, v] of NO_AUTO_MAINTENANCE) run(["config", k, v]);
}
