// SPDX-License-Identifier: MIT
// End-to-end coverage for the MCP server (src/mcp/server.ts, MIL-21): exercises createServer()
// directly over the SDK's in-memory transport with a real MCP Client — no child process, no
// stdio — so every tool's request/response shape is checked exactly as an MCP client would see
// it. CLI-level coverage of `em mcp` (that the subcommand exists and is wired) lives in
// test/cli.test.ts; the stdio entry point itself (src/mcp/main.ts) is a 3-line wrapper with
// nothing of its own to unit-test.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createServer, SERVER_NAME, SERVER_VERSION } from "../src/mcp/server.js";
import { readContract } from "../src/cli/contract.js";

// Same fixtures shape as test/cli.test.ts's CLEAN/WITH_ERROR/WITH_ISSUE/etc — kept local and
// MCP-specific rather than imported, since cli.test.ts's constants aren't exported.
const CLEAN = `slice "Place" {
  ui Checkout @Customer
  command Place Order issue "who validates the discount code?"
  event Order Placed @Order public
}
slice "Open Orders" {
  view Open Orders public from "Order Placed" divergence "tracking token covers idempotency"
  ui Order List @Customer
}
`;

// Error: view sourced from an event that doesn't exist.
const WITH_ERROR = `slice "Read" {
  view Open Orders from "No Such Event"
}
`;

// export_slice scoping fixture: one genuinely complete slice ("Good") and a second, unrelated
// slice ("Bad") with its own real error — export_slice on "good" must not refuse.
const SCOPED_ERROR = `slice "Good" {
  ui Screen @Customer
  command Do Thing
  event Thing Done
}
slice "Bad" {
  view Broken View from "No Such Event"
}
`;

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "em-mcp-"));
  writeFileSync(join(dir, "clean.em"), CLEAN);
  writeFileSync(join(dir, "error.em"), WITH_ERROR);
  writeFileSync(join(dir, "scoped-error.em"), SCOPED_ERROR);

  mkdirSync(join(dir, "slices"), { recursive: true });
  writeFileSync(
    join(dir, "slices", "ready-slice.md"),
    "---\nschemaVersion: 1\npattern: state-change\nswimlane: order\nstatus: ready-to-implement\nversion: 1\n---\n" +
      "## Invariants / Business Rules\n- **INV-1:** cited\n- **INV-2:** not cited\n\n## Open Questions\n- [x] resolved\n",
  );

  mkdirSync(join(dir, "tests"), { recursive: true });
  writeFileSync(join(dir, "tests", "ready-slice.test.ts"), `it("enforces INV-1", () => {});\n`);
  // Genuinely complete (ui -> command -> event -> view -> ui), so this slice's own
  // both-ends-of-a-flow diagnostics stay silent — same fixture shape as
  // test/cli.test.ts's "em validate --slice-ready" suite.
  writeFileSync(
    join(dir, "ready.em"),
    `slice "Ready Slice" {\n  ui Screen @Customer\n  command Do Thing note "slices/ready-slice.md"\n  event Thing Done\n}\nslice "Read Model" {\n  view Thing List from "Thing Done"\n  ui List Screen @Customer\n}\n`,
  );

  // PR #116 review finding 2 (MCP parity): a doc that's bound but has no usable frontmatter —
  // the status tool should surface the join warning in its `diagnostics` field, same as the CLI.
  writeFileSync(join(dir, "slices", "broken.md"), "# Slice: Broken\nNo frontmatter fence at all.\n");
  writeFileSync(join(dir, "status-broken-doc.em"), 'slice "Broken" {\n  ui Broken Screen @Customer note "slices/broken.md"\n}\n');
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Connect a fresh server/client pair over the SDK's in-memory transport — the recommended way
 *  to test an MCP server end-to-end without a child process (per the SDK's own docs). */
async function connectedClient(): Promise<{ client: Client; close: () => Promise<void> }> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer();
  const client = new Client({ name: "em-mcp-test-client", version: "0.0.0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

async function callJson(client: Client, name: string, args: Record<string, unknown> = {}): Promise<{ result: CallToolResult; doc: any }> {
  const result = (await client.callTool({ name, arguments: args })) as unknown as CallToolResult;
  const text = (result.content?.[0] as { type: "text"; text: string } | undefined)?.text ?? "";
  return { result, doc: result.isError ? undefined : JSON.parse(text) };
}

let client: Client;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ client, close } = await connectedClient());
});
afterAll(async () => {
  await close();
});

describe("MCP server identity", () => {
  it("names itself \"em\" at the installed package version", async () => {
    // getServerVersion() is populated once the initialize handshake (part of client.connect())
    // completes.
    expect(client.getServerVersion()).toMatchObject({ name: SERVER_NAME, version: SERVER_VERSION });
  });
});

describe("tools/list", () => {
  it("exposes exactly the eight documented tools", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      ["contract", "coverage", "export_model", "export_slice", "list_markers", "slice_ready", "status", "validate"].sort(),
    );
    // Every tool carries a non-empty description an agent can route on.
    for (const t of tools) expect(t.description?.length ?? 0).toBeGreaterThan(20);
  });
});

describe("validate tool", () => {
  it("happy path: a clean model reports ok:true with no diagnostics", async () => {
    const { doc } = await callJson(client, "validate", { file: join(dir, "clean.em") });
    expect(doc.ok).toBe(true);
    expect(doc.summary.errors).toBe(0);
  });

  it("an errored model still returns the diagnostics document, not a tool error", async () => {
    const { result, doc } = await callJson(client, "validate", { file: join(dir, "error.em") });
    expect(result.isError).toBeFalsy();
    expect(doc.ok).toBe(false);
    expect(doc.summary.errors).toBeGreaterThan(0);
    expect(doc.diagnostics.length).toBeGreaterThan(0);
    expect(doc.diagnostics[0]).toHaveProperty("usageCategory");
  });

  it("a missing file is a tool error, not a crash", async () => {
    const { result } = await callJson(client, "validate", { file: join(dir, "no-such-file.em") });
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain("cannot read");
  });

  it("a parse error is a tool error", async () => {
    const badFile = join(dir, "bad-parse.em");
    writeFileSync(badFile, "this is not valid em syntax {{{");
    const { result } = await callJson(client, "validate", { file: badFile });
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain("parse error");
  });
});

describe("slice_ready tool", () => {
  it("happy path: a bound, ready, fully-checked doc reports ready:true with all gates passing", async () => {
    const { doc } = await callJson(client, "slice_ready", { file: join(dir, "ready.em"), sliceKey: "ready-slice" });
    expect(doc.validateSliceReadySchemaVersion).toBeDefined();
    expect(doc.sliceKey).toBe("ready-slice");
    expect(doc.gates).toEqual({
      docBound: true,
      frontmatterUsable: true,
      statusReady: true,
      noUncheckedOpenQuestions: true,
    });
    expect(doc.ready).toBe(true);
    expect(doc.diagnostics).toEqual([]);
  });

  it("verdict shape for an unknown slice key: gates null, ready false, not a tool error", async () => {
    const { result, doc } = await callJson(client, "slice_ready", { file: join(dir, "ready.em"), sliceKey: "no-such-key" });
    expect(result.isError).toBeFalsy();
    expect(doc.gates).toBeNull();
    expect(doc.ready).toBe(false);
    expect(doc.diagnostics.length).toBeGreaterThan(0);
    expect(doc.diagnostics[0].code).toBe("slice-ready-unknown-slice");
  });
});

describe("list_markers tool", () => {
  it("happy path: defaults to all three marker kinds", async () => {
    const { doc } = await callJson(client, "list_markers", { file: join(dir, "clean.em") });
    const kinds = doc.markers.map((m: any) => m.markerKind).sort();
    expect(kinds).toEqual(["divergence", "issue", "public", "public"]);
  });

  it("narrows to just the requested kind", async () => {
    const { doc } = await callJson(client, "list_markers", {
      file: join(dir, "clean.em"),
      divergences: false,
      public: false,
    });
    expect(doc.markers.every((m: any) => m.markerKind === "issue")).toBe(true);
    expect(doc.markers.length).toBe(1);
  });
});

describe("export_model tool", () => {
  it("happy path: returns the full export document for a clean model", async () => {
    const { doc } = await callJson(client, "export_model", { file: join(dir, "clean.em") });
    expect(doc.schemaVersion).toBeDefined();
    expect(doc.model.slices.map((s: any) => s.key)).toEqual(["place", "open-orders"]);
  });

  it("refuses (tool error) on an errored model, same as `em export`", async () => {
    const { result } = await callJson(client, "export_model", { file: join(dir, "error.em") });
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain("not exporting");
  });
});

describe("export_slice tool", () => {
  it("happy path: exports one slice, scoped, unaffected by an unrelated slice's error", async () => {
    const { result, doc } = await callJson(client, "export_slice", { file: join(dir, "scoped-error.em"), sliceKey: "good" });
    expect(result.isError).toBeFalsy();
    expect(doc.sliceKey).toBe("good");
    expect(doc.slice.key).toBe("good");
  });

  it("an unknown slice key is a tool error", async () => {
    const { result } = await callJson(client, "export_slice", { file: join(dir, "clean.em"), sliceKey: "no-such-key" });
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain("no-such-key");
  });
});

describe("coverage tool", () => {
  it("happy path: returns the same document `em coverage --json` prints", async () => {
    const { doc } = await callJson(client, "coverage", { file: join(dir, "ready.em"), testsDir: join(dir, "tests") });
    expect(doc.coverageSchemaVersion).toBe("1.0");
    expect(doc.ok).toBe(false); // INV-2 is uncovered
    expect(doc.summary).toEqual({ totalInvariants: 2, cited: 1, uncovered: 1 });
    const readySlice = doc.slices.find((s: any) => s.key === "ready-slice");
    expect(readySlice.inScope).toBe(true);
    expect(readySlice.docReason).toBeNull();
    expect(readySlice.invariants).toContainEqual(
      expect.objectContaining({ id: "INV-1", cited: true }),
    );
    expect(readySlice.invariants).toContainEqual({ id: "INV-2", cited: false, citations: [] });
  });

  it("refuses (tool error) on an errored model, same as `em coverage`", async () => {
    const { result } = await callJson(client, "coverage", { file: join(dir, "error.em"), testsDir: join(dir, "tests") });
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain("not checking coverage");
  });

  it("refuses (tool error) when testsDir doesn't exist", async () => {
    const { result } = await callJson(client, "coverage", { file: join(dir, "ready.em"), testsDir: join(dir, "no-such-dir") });
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain("--tests directory not found");
  });
});

describe("status tool", () => {
  it("happy path: returns the same document `em status --json` prints (parity, MIL-163)", async () => {
    const { doc } = await callJson(client, "status", { files: [join(dir, "ready.em")], testsDir: join(dir, "tests") });
    expect(doc.statusSchemaVersion).toBe("1.0");
    expect(doc.files).toEqual([join(dir, "ready.em")]);
    expect(doc.slices.total).toBe(2); // "Ready Slice" + "Read Model"
    expect(doc.slices.byStatus.readyToImplement).toBe(1);
    expect(doc.slices.byStatus.noDoc).toBe(1); // "Read Model" has no bound doc
    expect(doc.invariants).toEqual({ testsDir: join(dir, "tests"), total: 2, cited: 1, uncovered: 1 });
    expect(doc.conformance).toHaveLength(1);
    expect(doc.conformance[0].hasStateFile).toBe(false); // no .event-modeling.md next to ready.em
  });

  it("omits invariants (null) when testsDir isn't given", async () => {
    const { doc } = await callJson(client, "status", { files: [join(dir, "ready.em")] });
    expect(doc.invariants).toBeNull();
  });

  it("aggregates across multiple files", async () => {
    const { doc } = await callJson(client, "status", { files: [join(dir, "clean.em"), join(dir, "ready.em")] });
    expect(doc.files).toEqual([join(dir, "clean.em"), join(dir, "ready.em")]);
    expect(doc.slices.total).toBe(4); // 2 slices in clean.em + 2 in ready.em
    expect(doc.conformance).toHaveLength(2);
  });

  it("refuses (tool error) on an errored model, same as `em status`", async () => {
    const { result } = await callJson(client, "status", { files: [join(dir, "error.em")] });
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain("not reporting status");
  });

  it("refuses (tool error) when testsDir doesn't exist", async () => {
    const { result } = await callJson(client, "status", { files: [join(dir, "ready.em")], testsDir: join(dir, "no-such-dir") });
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain("--tests directory not found");
  });

  it("a missing file is a tool error, not a crash", async () => {
    const { result } = await callJson(client, "status", { files: [join(dir, "no-such-file.em")] });
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain("cannot read");
  });

  // PR #116 review finding 2 (MCP parity): the doc-join diagnostic reaches the tool's JSON
  // output — the MCP tool has no stderr channel of its own, so the document is the only place
  // this can surface for an MCP client.
  it("surfaces frontmatter-invalid doc-join diagnostics in the document, same as `em status --json`", async () => {
    const { doc } = await callJson(client, "status", { files: [join(dir, "status-broken-doc.em")] });
    expect(doc.slices.byStatus.frontmatterInvalid).toBe(1);
    expect(doc.driftSignal.frontmatterInvalid).toBe(1);
    expect(doc.diagnostics).toHaveLength(1);
    expect(doc.diagnostics[0]).toMatchObject({ file: join(dir, "status-broken-doc.em"), code: "frontmatter-invalid" });
  });
});

describe("contract tool", () => {
  it("returns the packaged implementation contract verbatim, matching `em contract`", async () => {
    const result = (await client.callTool({ name: "contract", arguments: {} })) as unknown as CallToolResult;
    expect(result.isError).toBeFalsy();
    const text = (result.content[0] as { type: "text"; text: string }).text;
    // Compare against the real packaged contract via readContract, same helper `em contract`
    // itself uses, resolved from this repo's own checkout (test runs from the repo root).
    expect(text).toBe(readContract(join(process.cwd(), ".claude", "skills", "event-modeling")));
  });
});
