// SPDX-License-Identifier: MIT
// Temp-dir cleanup that survives a straggling child (git/CLI) still releasing files (GH #330):
// `rmSync(dir, { recursive: true, force: true })`, retried once after a short delay on
// ENOTEMPTY/EBUSY (CI runners report these when a just-exited process's handles linger).

import { rmSync } from "node:fs";

export function rmTemp(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== "ENOTEMPTY" && code !== "EBUSY") throw e;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}
