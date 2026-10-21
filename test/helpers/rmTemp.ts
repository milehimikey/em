// SPDX-License-Identifier: MIT
// Backstop temp-dir cleanup (GH #330). The root cause of the CI ENOTEMPTY flake is a detached git
// auto-maintenance child writing under .git after `git commit` returns; fixtures disable that at
// the source (see multiModelRepo.ts). This only retries ENOTEMPTY/EBUSY (Node does so itself when
// `recursive` is set) in case anything else is still releasing files.

import { rmSync } from "node:fs";

export function rmTemp(dir: string): void {
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
