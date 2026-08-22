// SPDX-License-Identifier: MIT
// Debounced file watcher for `em watch`.

import chokidar from "chokidar";

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
): chokidar.FSWatcher {
  // A glob path (e.g. a slices/*.md pattern) picks up files created after the
  // watcher starts, not just ones that already exist — needed so authoring a
  // slice's first design doc mid-session still triggers a re-render.
  const watcher = chokidar.watch(paths, { ignoreInitial: true });
  let timer: NodeJS.Timeout | null = null;
  const trigger = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      void onChange();
    }, debounceMs);
  };
  watcher.on("change", trigger);
  watcher.on("add", trigger);
  return watcher;
}