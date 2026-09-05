// SPDX-License-Identifier: MIT
// MIL-193: the shared model-qualified ref helper — key derivation, fallback, collision
// dedupe + diagnostic, and the one parse/format grammar every cross-model surface uses.
import { describe, it, expect } from "vitest";
import { parse, DEFAULT_MODEL_NAME } from "../src/parser/parser.js";
import { normalize } from "../src/model/model.js";
import {
  MODEL_KEY_RE,
  computeModelKey,
  computeModelKeys,
  formatQualifiedRef,
  isQualifiedRef,
  parseQualifiedRef,
} from "../src/model/qualifiedRef.js";
import { RULES } from "../src/model/rules.js";

const modelFrom = (src: string) => normalize(parse(src));
const named = (name: string) => modelFrom(`model "${name}"\nslice "S" {\n  command Do\n}\n`);
const unnamed = () => modelFrom(`slice "S" {\n  command Do\n}\n`);

describe("computeModelKey", () => {
  it("is the kebab-slug of the declared model name", () => {
    expect(computeModelKey(named("Order Fulfilment"))).toBe("order-fulfilment");
    expect(computeModelKey(named("  Meridian: Goods 2.0 "))).toBe("meridian-goods-2-0");
  });

  it("ignores the file when the name is declared — a move or rename never changes the key", () => {
    expect(computeModelKey(named("Orders"), "/somewhere/else/legacy-name.em")).toBe("orders");
  });

  it("records whether the name was declared", () => {
    expect(named("Orders").nameDeclared).toBe(true);
    const m = unnamed();
    expect(m.nameDeclared).toBe(false);
    expect(m.name).toBe(DEFAULT_MODEL_NAME);
  });

  it("falls back to the kebab-slugged file basename (extension stripped) when no name was declared", () => {
    expect(computeModelKey(unnamed(), "models/Order_Fulfilment.em")).toBe("order-fulfilment");
    expect(computeModelKey(unnamed(), "C:\\models\\billing.v2.em")).toBe("billing-v2");
    expect(computeModelKey(unnamed(), "noext")).toBe("noext");
  });

  it("uses the default title's slug when no name was declared and no file is given", () => {
    expect(computeModelKey(unnamed())).toBe("event-model");
  });

  it("always yields a MODEL_KEY_RE-shaped key", () => {
    for (const k of [computeModelKey(named("Order Fulfilment")), computeModelKey(unnamed(), "x/Y Z.em"), computeModelKey(unnamed())]) {
      expect(k).toMatch(MODEL_KEY_RE);
    }
  });
});

describe("computeModelKeys", () => {
  it("keys every entry in order with no diagnostics when the keys are distinct", () => {
    const r = computeModelKeys([
      { model: named("Orders"), file: "a.em" },
      { model: named("Billing"), file: "b.em" },
      { model: unnamed(), file: "dir/shipping.em" },
    ]);
    expect(r.keys).toEqual(["orders", "billing", "shipping"]);
    expect(r.diagnostics).toEqual([]);
  });

  it("dedupes a collision ~2, ~3 in file-list order (first wins the bare key) and warns on each", () => {
    const r = computeModelKeys([
      { model: named("Orders"), file: "one.em" },
      { model: named("orders"), file: "two.em" },
      { model: unnamed(), file: "Orders.em" },
    ]);
    expect(r.keys).toEqual(["orders", "orders~2", "orders~3"]);
    expect(r.diagnostics.map((d) => d.code)).toEqual(["duplicate-model-key", "duplicate-model-key"]);
    expect(r.diagnostics[0].severity).toBe("warning");
    expect(r.diagnostics[0].refs).toEqual(["orders~2", "orders"]);
    expect(r.diagnostics[0].message).toContain("one.em");
    expect(r.diagnostics[0].message).toContain("two.em");
    expect(r.diagnostics[1].refs).toEqual(["orders~3", "orders"]);
    expect(r.diagnostics[1].message).toContain("Orders.em");
  });

  it("registers duplicate-model-key as a warning in the rule catalogue", () => {
    expect(RULES["duplicate-model-key"].severity).toBe("warning");
  });

  it("is a no-op for a single entry (single-model contexts never see a suffix)", () => {
    const r = computeModelKeys([{ model: named("Orders"), file: "a.em" }]);
    expect(r).toEqual({ keys: ["orders"], diagnostics: [] });
  });
});

describe("formatQualifiedRef / parseQualifiedRef", () => {
  it("round-trips element, slice, and type refs", () => {
    for (const ref of ["checkout/command.place-order", "checkout", "types/money", "checkout/view.cart~2"]) {
      for (const key of ["orders", "orders~2", "a1-b2"]) {
        const q = formatQualifiedRef(key, ref);
        expect(q).toBe(`${key}:${ref}`);
        expect(parseQualifiedRef(q)).toEqual({ modelKey: key, ref });
        expect(isQualifiedRef(q)).toBe(true);
      }
    }
  });

  it("leaves an unqualified ref or display name intact", () => {
    for (const s of ["checkout/command.place-order", "Place Order", "checkout", ""]) {
      expect(parseQualifiedRef(s)).toEqual({ modelKey: null, ref: s });
      expect(isQualifiedRef(s)).toBe(false);
    }
  });

  it("keeps a display name containing a colon whole when its prefix is not a model-key shape", () => {
    for (const s of ["Order: Paid", "Status:Pending Review", "TODO: fix", "a_b:c", ":leading", "Ürün:x"]) {
      expect(parseQualifiedRef(s)).toEqual({ modelKey: null, ref: s });
    }
  });

  it("splits on the first colon only, leaving later colons in the ref", () => {
    expect(parseQualifiedRef("orders:Order: Paid")).toEqual({ modelKey: "orders", ref: "Order: Paid" });
  });

  it("MODEL_KEY_RE is the kebab-with-optional-~n grammar", () => {
    for (const ok of ["a", "orders", "order-fulfilment", "a1-b2", "orders~2", "x~10"]) expect(ok).toMatch(MODEL_KEY_RE);
    for (const bad of ["", "Orders", "order_fulfilment", "-orders", "orders-", "orders~", "orders~2~3", "or ders", "a--b"]) {
      expect(bad).not.toMatch(MODEL_KEY_RE);
    }
  });
});
