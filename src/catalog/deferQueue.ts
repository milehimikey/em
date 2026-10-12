// SPDX-License-Identifier: MIT
// GH #236: the deferral QUEUE — where `em slice defer` parks a question for a slice doc that must
// not be edited. A ratified (`ready-to-implement` + `ratifiedBy:`) or shipped (`implemented`) doc's
// body is the signed spec: editing it breaks `ratifiedHash`, so `defer` leaves the body alone and
// records the item in the model's `.event-modeling.md` parking lot instead, as ONE bullet:
//
//   - <question> (from slice <key>, queued for <key>@v<N+1>, until v<U>, <on>[, by <who>]; decision: <text>)
//
// `em slice revise` / `mark-implemented` read the bullet back when they open v<N+1> as a draft,
// inject it into the new draft's `## Open Questions`, and turn it into the ordinary
// `- <question> (from slice <key>, deferred to v<U>)` parking-lot bullet (the queue is "cleared").
// Everything here is read-side and pure except `queuedCount`, which `em status` / `em export` call
// (via docJoin) to show the room how much known work waits on the next version.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { STATE_FILE_NAME } from "../cli/stateFile.js";

export interface QueuedItem {
  question: string;
  sliceKey: string;
  /** The version the item is injected into: the doc's version when it was queued, plus one. */
  targetVersion: number;
  /** The `--until` version that must answer it (>= targetVersion). */
  until: number;
  on: string;
  by?: string;
  decision: string;
}

const QUEUED =
  /^- (.+?) \(from slice ([^\s,]+), queued for ([^\s,@]+)@v(\d+), until v(\d+), (\d{4}-\d{2}-\d{2})(?:, by (.+?))?; decision: (.*)\)\s*$/;

/** The parking-lot bullet that records `item` as queued. */
export function queuedBullet(item: QueuedItem): string {
  return (
    `- ${item.question} (from slice ${item.sliceKey}, queued for ${item.sliceKey}@v${item.targetVersion}, ` +
    `until v${item.until}, ${item.on}${item.by !== undefined ? `, by ${item.by}` : ""}; decision: ${item.decision})`
  );
}

/** Parses one state-file line; null for anything that is not a queued bullet. */
export function parseQueuedBullet(line: string): QueuedItem | null {
  const m = QUEUED.exec(line.replace(/\r?\n$/, ""));
  if (!m || m[2] !== m[3]) return null;
  return {
    question: m[1],
    sliceKey: m[2],
    targetVersion: Number(m[4]),
    until: Number(m[5]),
    on: m[6],
    ...(m[7] !== undefined ? { by: m[7] } : {}),
    decision: m[8],
  };
}

/** Every queued item in `stateRaw` for `sliceKey` aimed at `targetVersion`, in file order. */
export function queuedItems(stateRaw: string, sliceKey: string, targetVersion: number): QueuedItem[] {
  const out: QueuedItem[] = [];
  for (const line of stateRaw.split("\n")) {
    const item = parseQueuedBullet(line);
    if (item && item.sliceKey === sliceKey && item.targetVersion === targetVersion) out.push(item);
  }
  return out;
}

/** How many questions wait in `<baseDir>/.event-modeling.md` for `<sliceKey>@v<docVersion + 1>`;
 *  0 when the file is absent or unreadable (the queue is advisory for readers). */
export function queuedCount(baseDir: string, sliceKey: string, docVersion: number | null): number {
  if (docVersion === null) return 0;
  const p = join(baseDir, STATE_FILE_NAME);
  if (!existsSync(p)) return 0;
  try {
    return queuedItems(readFileSync(p, "utf8"), sliceKey, docVersion + 1).length;
  } catch {
    return 0;
  }
}
