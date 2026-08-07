// SPDX-License-Identifier: MIT
// Debounced file watcher for `em watch`.

import chokidar from "chokidar";

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