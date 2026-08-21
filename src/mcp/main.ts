#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// `em-mcp`'s stdio entry point (MIL-21). Thin on purpose: build the server (src/mcp/server.ts),
// connect it to stdio, done. The stdio transport IS the protocol channel — nothing here or in
// server.ts may write to stdout outside it, so every diagnostic goes to stderr instead.

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";
import { isMainModule } from "../util/isMainModule.js";

export async function main(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
