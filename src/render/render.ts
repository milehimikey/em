// Renders DOT to an image by shelling out to Graphviz `dot`.

import { spawn } from "node:child_process";
import { extname } from "node:path";

const DOT_BIN = process.env.EM_DOT || "dot";

export function formatFromPath(outPath: string, fallback = "svg"): string {
  const ext = extname(outPath).replace(/^\./, "").toLowerCase();
  return ext || fallback;
}

export async function renderDot(
  dot: string,
  outPath: string,
  format = formatFromPath(outPath),
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(DOT_BIN, [`-T${format}`, "-o", outPath]);
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (e) =>
      reject(
        new Error(
          `failed to run '${DOT_BIN}' (is Graphviz installed?): ${e.message}`,
        ),
      ),
    );
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`dot exited with code ${code}: ${stderr.trim()}`));
    });
    child.stdin.write(dot);
    child.stdin.end();
  });
}
