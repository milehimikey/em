// SPDX-License-Identifier: MIT
// Debounced file watcher for `em watch`.

import chokidar from "chokidar";

export function watchFile(
  file: string,
  onChange: () => void | Promise<void>,
  debounceMs = 80,
): chokidar.FSWatcher {
  const watcher = chokidar.watch(file, { ignoreInitial: true });
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