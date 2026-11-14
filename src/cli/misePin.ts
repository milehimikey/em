// SPDX-License-Identifier: MIT
// The mise pin of the em CLI (GH #298, part 2 of GH #223). A repo that runs em through mise carries
// `[tools] "npm:@milehimikey/em" = "<ver>"` in `mise.toml` / `.mise.toml`; `em skill check` compares
// that against the plugin pin (or the installed em), and `em upgrade` moves it.
//
// No TOML dependency and no external program (em never runs `mise`): a line scanner that reads only
// the em entry, in the shapes mise writes (a plain string, an inline table with `version`, or a
// `[tools."npm:@milehimikey/em"]` table with a `version` line), and tolerates everything else in the
// file. A rewrite replaces exactly the characters of the version value, so comments, ordering,
// quoting and line endings (LF or CRLF) are untouched.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import type { PluginDeclaration } from "./pluginPin.js";
import type { SkillCheckFinding } from "./skillCheck.js";

export const MISE_PACKAGE = "npm:@milehimikey/em";
/** The files mise reads for a directory, in the order this check consults them. */
export const MISE_FILES = ["mise.toml", ".mise.toml"] as const;

export interface MisePinLocation {
  /** The version exactly as written (not necessarily a full semver, e.g. `latest`). */
  version: string;
  /** Offsets into the scanned text of the version value, quotes excluded: `[start, end)`. */
  start: number;
  end: number;
}

/** The fix line for a mise pin at `version`. */
export function miseUseCommand(version: string): string {
  return `mise use ${MISE_PACKAGE}@${version}`;
}

const KEY_RE = /^\s*(?:"([^"]*)"|'([^']*)'|([A-Za-z0-9_-]+))\s*=\s*/;
const PKG_TABLE_RE = /^tools\s*\.\s*(?:"npm:@milehimikey\/em"|'npm:@milehimikey\/em')$/;

function quoted(s: string, from: number): { value: string; start: number; end: number } | null {
  const q = s[from];
  if (q !== '"' && q !== "'") return null;
  const close = s.indexOf(q, from + 1);
  if (close === -1) return null;
  return { value: s.slice(from + 1, close), start: from + 1, end: close };
}

/**
 * Locate the em pin's version value in the text of a mise config. `null` when the file does not
 * declare the package (or declares it in a shape this reader does not understand, which is treated
 * as "not declared" so such a file behaves exactly as before).
 */
export function findMiseEmPin(text: string): MisePinLocation | null {
  let section: "tools" | "pkg" | "other" | "root" = "root";
  let offset = 0;
  for (const raw of text.split("\n")) {
    const lineStart = offset;
    offset += raw.length + 1;
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;

    const header = /^\s*(\[\[?)\s*([^\]]*?)\s*\]\]?\s*(?:#.*)?$/.exec(line);
    if (header) {
      if (header[1] === "[[") section = "other";
      else if (header[2] === "tools") section = "tools";
      else if (PKG_TABLE_RE.test(header[2])) section = "pkg";
      else section = "other";
      continue;
    }

    if (section === "pkg") {
      const m = /^\s*version\s*=\s*/.exec(line);
      if (m) {
        const q = quoted(line, m[0].length);
        if (q) return { version: q.value, start: lineStart + q.start, end: lineStart + q.end };
      }
      continue;
    }

    if (section !== "tools" && section !== "root") continue;
    let rest: string;
    let keyEnd: number;
    if (section === "root") {
      // A dotted key at the top level: `tools."npm:@milehimikey/em" = ...`.
      const d = /^\s*(tools\s*\.\s*(?:"npm:@milehimikey\/em"|'npm:@milehimikey\/em'))\s*=\s*/.exec(line);
      if (!d) continue;
      keyEnd = d[0].length;
      rest = line.slice(keyEnd);
    } else {
      const k = KEY_RE.exec(line);
      if (!k || (k[1] ?? k[2] ?? k[3]) !== MISE_PACKAGE) continue;
      keyEnd = k[0].length;
      rest = line.slice(keyEnd);
    }

    if (rest.startsWith('"') || rest.startsWith("'")) {
      const q = quoted(line, keyEnd);
      if (q) return { version: q.value, start: lineStart + q.start, end: lineStart + q.end };
    } else if (rest.startsWith("{")) {
      const close = rest.indexOf("}");
      const inner = close === -1 ? rest : rest.slice(0, close);
      const v = /(?:^|[{,\s])version\s*=\s*/.exec(inner);
      if (v) {
        const q = quoted(line, keyEnd + v.index + v[0].length);
        if (q) return { version: q.value, start: lineStart + q.start, end: lineStart + q.end };
      }
    }
  }
  return null;
}

/** Replace the pin's version value in `text`, touching nothing else. */
export function rewriteMiseEmPin(text: string, version: string): string | null {
  const loc = findMiseEmPin(text);
  if (!loc) return null;
  return text.slice(0, loc.start) + version + text.slice(loc.end);
}

export interface MisePin {
  /** Absolute path of the mise config that declares the pin. */
  file: string;
  version: string;
}

/**
 * The nearest mise config that declares the em package, walking up from `startDir` (mise's own
 * resolution: closest directory wins; within a directory `mise.toml` then `.mise.toml`). When
 * `stopAt` is given, the walk does not leave that directory.
 */
export function detectMisePin(startDir: string, stopAt?: string): MisePin | null {
  let dir = resolve(startDir);
  const stop = stopAt ? resolve(stopAt) : null;
  for (;;) {
    for (const name of MISE_FILES) {
      const file = join(dir, name);
      if (!existsSync(file)) continue;
      let text: string;
      try {
        text = readFileSync(file, "utf8");
      } catch {
        continue;
      }
      const loc = findMiseEmPin(text);
      if (loc) return { file, version: loc.version };
    }
    const parent = dirname(dir);
    if (parent === dir || (stop !== null && dir === stop)) return null;
    dir = parent;
  }
}

/** The version a plugin declaration pins: `source.ref` minus its `v`, else the marketplace name. */
export function pluginPinVersion(plugin: PluginDeclaration): string {
  if (plugin.ref !== null) return plugin.ref.replace(/^v/, "");
  return plugin.name.replace(/^em-/, "").replace(/-/g, ".");
}

export interface MisePinCheck {
  pin: MisePin;
  /** `null` when the pin agrees. */
  finding: SkillCheckFinding | null;
}

/**
 * Compare the mise pin found from `repoRoot` against the plugin pin's version (when the repo
 * declares the plugin) or the installed em. `null` when no mise config declares the package.
 */
export function checkMisePin(repoRoot: string, installedVersion: string, plugin: PluginDeclaration | null): MisePinCheck | null {
  const pin = detectMisePin(repoRoot);
  if (!pin) return null;
  const expected = plugin ? pluginPinVersion(plugin) : installedVersion;
  if (pin.version === expected) return { pin, finding: null };
  const fix = miseUseCommand(expected);
  const shown = relative(resolve(repoRoot), pin.file) || pin.file;
  const against = plugin ? `the em plugin pin (${plugin.name} at ${plugin.ref ?? "(no ref)"})` : `installed em ${installedVersion}`;
  return {
    pin,
    finding: {
      code: "mise-pin-mismatch",
      message: `mise pin mismatch: ${shown} pins ${MISE_PACKAGE} at ${pin.version}, but ${against} is ${expected} - run:\n  ${fix}`,
      misePin: pin.version,
      miseFile: shown,
      installedVersion,
      installCommands: [fix],
    },
  };
}
