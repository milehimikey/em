// SPDX-License-Identifier: MIT
// Debounced file watcher for `em watch`.

import chokidar, { type FSWatcher } from "chokidar";

/**
 * Wrap an async build fn so overlapping triggers never run it concurrently.
 * A trigger that lands mid-build marks it dirty and returns; the running call
 * re-runs the fn exactly once after it finishes, however many triggers piled
 * up — a boolean, not a queue, because every build reads the current file
 * state, so one trailing run always reflects the latest save. A rejection
 * propagates to the first caller and drops any pending re-run; `em watch`'s
 * build catches its own errors, so in practice the chain never breaks.
 */
export function serializeBuilds(fn: () => void | Promise<void>): () => Promise<void> {
  let running = false;
  let dirty = false;
  return async () => {
    if (running) {
      dirty = true;
      return;
    }
    running = true;
    try {
      do {
        dirty = false;
        await fn();
      } while (dirty);
    } finally {
      running = false;
    }
  };
}

export function watchFile(
  paths: string | string[],
  onChange: () => void | Promise<void>,
  debounceMs = 80,
  only?: (path: string) => boolean,
): FSWatcher {
  // Paths are files or directories, never globs: chokidar 4 dropped glob support
  // (and with it the `braces` dependency, CVE-2026-93687). A directory path picks
  // up files created after the watcher starts — needed so authoring a slice's
  // first design doc mid-session still triggers a re-render — and `only` narrows
  // which files inside it count (e.g. just `*.md`), the way the old glob did.
  const watcher = chokidar.watch(paths, { ignoreInitial: true });
  let timer: NodeJS.Timeout | null = null;
  const trigger = (path: string) => {
    if (only && !only(path)) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      void onChange();
    }, debounceMs);
  };
  watcher.on("change", trigger);
  watcher.on("add", trigger);
  return watcher;
}