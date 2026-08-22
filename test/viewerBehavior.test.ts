// SPDX-License-Identifier: MIT
// @vitest-environment jsdom
//
// Behavioral tests for the live viewer page (src/render/viewer.html, shipped
// as the VIEWER_HTML constant) in a real DOM: the inline script is executed
// against jsdom with EventSource/fetch/requestAnimationFrame stubbed, and the
// tests drive it the way a browser session would — SSE pushes, wheel events,
// review-mode clicks — asserting on the DOM it produces. Complements the
// string-presence tests in test/serve.test.ts.
//
// Harness notes:
// - jsdom's DOMParser reports malformed image/svg+xml by making the document
//   root itself a <parsererror> element (verified empirically: truncated XML,
//   unclosed tags, non-XML text, and empty input all yield root.localName ===
//   "parsererror" and doc.querySelector("parsererror") non-null). A well-formed
//   non-SVG root (e.g. <div>) parses cleanly and is caught by the viewer's
//   root.localName !== "svg" check instead. The bad-SVG fixtures here are
//   truncated mid-attribute, which triggers the parsererror path for real.
// - Fake timers fake only setTimeout/clearTimeout/Date: the retry backoff and
//   the requestAnimationFrame stub (setTimeout(cb(performance.now()+1000), 0),
//   so any flyTo completes in one queued tick) run on the fake clock, while
//   performance.now() stays real — flyTo's `now - t0` is then always past the
//   280ms animation, finishing the fly in a single frame. Load completion is
//   awaited with vi.waitFor on the observable DOM change (marker element /
//   banner visibility); with fake timers active, waitFor advances the fake
//   clock between checks, which also flushes the fetch chain's microtasks.
// - Camera expectations are closed-form values hand-computed for the fixed
//   fixtures (natural viewBox 0 0 100 100, stage rect 800x600 unless a test
//   changes it) plus implementation-independent invariants — never a replica
//   of the viewer's own formulas.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { VIEWER_HTML } from "../src/render/viewerHtml.js";
import { splitViewerHtml } from "./helpers/viewerScript.js";

const g = globalThis as any;

const { script: SCRIPT, bodyMarkup: BODY_MARKUP } = splitViewerHtml(VIEWER_HTML);

// --- fixtures ---
const SVG_NS = 'xmlns="http://www.w3.org/2000/svg"';
/** Plain valid SVG, no slice metadata; marker id identifies which load is on screen. */
const plainSvg = (marker: string): string =>
  `<svg ${SVG_NS} viewBox="0 0 100 100"><g id="${marker}"><rect width="100" height="100"/></g></svg>`;
/** Same shape sliceOverlay.ts embeds: <metadata id="em-slices"> JSON + data-slice groups. */
const SLICE_META =
  '{"slices":[{"index":0,"name":"A","x0":0,"x1":50},{"index":1,"name":"B","x0":50,"x1":100}],"rowLabels":null}';
const slicedSvg = (marker: string): string =>
  `<svg ${SVG_NS} viewBox="0 0 100 100">` +
  `<metadata id="em-slices">${SLICE_META}</metadata>` +
  `<g data-slice="0" id="${marker}"><rect width="50" height="100"/></g>` +
  `<g data-slice="1"><rect x="50" width="50" height="100"/></g></svg>`;
/** Truncated mid-attribute — jsdom's DOMParser yields a parsererror root for this. */
const TRUNCATED_SVG = '<svg viewBox="0 0 100 100"><g><rect x="1';

// --- closed-form expected cameras for the fixtures above ---
interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}
// Full fit of the 100x100 diagram in an 800x600 stage: stage aspect 4/3 > 1,
// so the view widens to 100·(800/600) = 400/3 ≈ 133.33 and centers:
// x = (100 − 400/3)/2 ≈ −16.67; height stays 100.
const FIT_800x600: Box = { x: (100 - 400 / 3) / 2, y: 0, w: 400 / 3, h: 100 };
// Review frame for slice A, by hand: pad its x-range [0,50] by 24 and clamp to
// the natural box → [0,74]; frame 74x100 into the 800x600 stage: 74/100 < 4/3,
// so the width pads out to the same 400/3 and centers on the padded range:
// x = (74 − 400/3)/2 ≈ −29.67, y = 0, w = 400/3, h = 100.
const SLICE_A_FRAME: Box = { x: (74 - 400 / 3) / 2, y: 0, w: 400 / 3, h: 100 };

// --- stubs ---
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  url: string;
  onopen: ((e?: unknown) => void) | null = null;
  onmessage: ((e?: unknown) => void) | null = null;
  onerror: ((e?: unknown) => void) | null = null;
  private listeners = new Map<string, Array<(e: unknown) => void>>();
  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, handler: (e: unknown) => void): void {
    const arr = this.listeners.get(type) ?? [];
    arr.push(handler);
    this.listeners.set(type, arr);
  }
  emit(type: string, e: unknown = {}): void {
    for (const h of this.listeners.get(type) ?? []) h(e);
  }
  close(): void {}
}
/** The EventSource the most recent script execution opened. */
const es = (): FakeEventSource => FakeEventSource.instances[FakeEventSource.instances.length - 1];

type QueuedResponse = { ok?: boolean; status?: number; text?: string } | "pending";
let responses: QueuedResponse[] = [];
const fetchMock = vi.fn((_url: unknown) => {
  const next = responses.shift() ?? "pending";
  if (next === "pending") return new Promise<never>(() => {}); // stays in flight forever
  return Promise.resolve({
    ok: next.ok ?? true,
    status: next.status ?? 200,
    text: async () => next.text ?? "",
  });
});
/** Fetched paths with the ?t= cache-buster stripped. */
const fetchedPaths = (): string[] => fetchMock.mock.calls.map((c) => String(c[0]).split("?t=")[0]);

// The stage's mocked bounding rect — mutable so the resize test can change it.
let rect: { left: number; top: number; x: number; y: number; width: number; height: number; right: number; bottom: number };
function setRect(width: number, height: number): void {
  rect = { left: 0, top: 0, x: 0, y: 0, width, height, right: width, bottom: height };
}

// --- DOM handles (no DOM lib in tsconfig, hence the any-typed accessors) ---
const byId = (id: string): any => g.document.getElementById(id);
const stageSvg = (): any => g.document.querySelector("#stage svg");

/** Execute the viewer's inline script against the installed DOM + stubs. */
function runViewer(): void {
  new Function(SCRIPT)();
}

/** Wait until the load carrying this marker element has swapped onto the stage. */
const untilShows = (marker: string): Promise<void> =>
  vi.waitFor(() => {
    expect(stageSvg()?.querySelector(`#${marker}`)).toBeTruthy();
  });
/** Wait until the error banner's visibility flips to the given state. */
const untilBannerVisible = (visible: boolean): Promise<void> =>
  vi.waitFor(() => {
    expect(byId("errorBanner").hidden).toBe(!visible);
  });

/** Let a queued flyTo rAF tick (a 0ms fake timer) run to completion. */
async function settleFly(): Promise<void> {
  await vi.advanceTimersByTimeAsync(5);
}

/** Boot the viewer with one queued response and let the initial load finish. */
async function boot(svgText: string, marker: string): Promise<void> {
  responses.push({ text: svgText });
  runViewer();
  await untilShows(marker);
}

/** Standard xMidYMid-meet client-px → model mapping for a given viewBox: the
 *  minimum needed to even phrase "the model point under the cursor" — SVG spec
 *  behavior, not viewer internals. */
function toModel(c: Box, cx: number, cy: number): { x: number; y: number } {
  const s = Math.max(c.w / rect.width, c.h / rect.height);
  const ox = c.x - (rect.width * s - c.w) / 2;
  const oy = c.y - (rect.height * s - c.h) / 2;
  return { x: ox + (cx - rect.left) * s, y: oy + (cy - rect.top) * s };
}

/** The camera as the on-screen svg's viewBox. */
function camBox(): Box {
  const parts = stageSvg().getAttribute("viewBox").split(" ").map(Number);
  return { x: parts[0], y: parts[1], w: parts[2], h: parts[3] };
}
function expectBoxClose(actual: Box, expected: Box, eps = 1e-6): void {
  expect(Math.abs(actual.x - expected.x)).toBeLessThan(eps);
  expect(Math.abs(actual.y - expected.y)).toBeLessThan(eps);
  expect(Math.abs(actual.w - expected.w)).toBeLessThan(eps);
  expect(Math.abs(actual.h - expected.h)).toBeLessThan(eps);
}

function wheel(init: { deltaX?: number; deltaY?: number; ctrlKey?: boolean; clientX?: number; clientY?: number }): void {
  byId("stage").dispatchEvent(
    new g.WheelEvent("wheel", { bubbles: true, cancelable: true, ...init }),
  );
}

beforeEach(() => {
  // Fake only the timer clock (retry backoff, the rAF stub) and Date (the
  // fetch cache-buster) — performance.now() stays real so flyTo's elapsed-time
  // math sees the stub's now+1000ms and finishes in one frame.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  responses = [];
  FakeEventSource.instances = [];
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.stubGlobal("requestAnimationFrame", (cb: (t: number) => void) =>
    g.setTimeout(() => cb(g.performance.now() + 1000), 0),
  );
  vi.stubGlobal("cancelAnimationFrame", (h: unknown) => g.clearTimeout(h));

  g.window.history.replaceState(null, "", "/"); // reset any ?svg= from a prior test
  g.document.body.innerHTML = BODY_MARKUP;
  setRect(800, 600);
  const stage = byId("stage");
  stage.getBoundingClientRect = () => rect; // deterministic camera math
  // jsdom lacks pointer-capture; the viewer only calls these inside pointer
  // handlers, but polyfill defensively so nothing can throw.
  stage.setPointerCapture ??= () => {};
  stage.releasePointerCapture ??= () => {};
  stage.hasPointerCapture ??= () => false;
});

afterEach(() => {
  vi.clearAllTimers(); // drop any pending retry timers from failed loads
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("?svg= allowlist", () => {
  it("accepts a bare *.svg filename with a space and fetches it URI-encoded", () => {
    g.window.history.replaceState(null, "", "/?svg=" + encodeURIComponent("my model.svg"));
    responses.push("pending");
    runViewer();
    expect(fetchedPaths().pop()).toBe("my%20model.svg");
  });

  it("falls back to model.svg for traversal, absolute URLs, colons, and non-.svg", () => {
    for (const bad of ["../evil.svg", "https://evil.example/x.svg", "a:b.svg", "x.png"]) {
      g.window.history.replaceState(null, "", "/?svg=" + encodeURIComponent(bad));
      responses.push("pending");
      runViewer();
      expect(fetchedPaths().pop(), `?svg=${bad}`).toBe("model.svg");
    }
  });
});

describe("load pipeline keeps the last good frame", () => {
  it("inlines a valid SVG, survives a malformed reload behind the banner, and retries with backoff", async () => {
    await boot(plainSvg("first-load"), "first-load");
    expect(byId("errorBanner").hidden).toBe(true);

    // SSE says the file changed, but the refetch returns a truncated write.
    responses.push({ text: TRUNCATED_SVG });
    es().onmessage!({});
    await untilBannerVisible(true);
    // The original frame is still up — the malformed text never touched the DOM.
    expect(stageSvg().querySelector("#first-load")).toBeTruthy();
    expect(byId("errorText").textContent).toContain("model.svg");
    expect(byId("errorText").textContent).toContain("SVG parse error");

    // First backoff step is 500ms; advancing the fake clock refetches.
    const callsBefore = fetchMock.mock.calls.length;
    responses.push({ text: plainSvg("second-load") });
    await vi.advanceTimersByTimeAsync(500);
    expect(fetchMock.mock.calls.length).toBe(callsBefore + 1);
    await untilShows("second-load");
    expect(byId("errorBanner").hidden).toBe(true);
  });
});

describe("renderError SSE", () => {
  it("shows the push message over the last good diagram without refetching", async () => {
    await boot(plainSvg("good"), "good");
    const callsBefore = fetchMock.mock.calls.length;

    es().emit("renderError", { data: 'error :3 event "X" is unreadable' });
    expect(byId("errorBanner").hidden).toBe(false);
    expect(byId("errorText").textContent).toContain('error :3 event "X" is unreadable');
    expect(byId("errorText").textContent).toContain("showing last good diagram");
    expect(stageSvg().querySelector("#good")).toBeTruthy(); // diagram untouched

    // No retry loop for render errors: refetching would only return the old
    // file. Even well past every backoff step, no new fetch happens.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetchMock.mock.calls.length).toBe(callsBefore);
  });
});

describe("review-state survival across reloads", () => {
  const sliceButtons = (): any[] => Array.from(byId("filmstrip").querySelectorAll("button.slice"));
  const dimmed = (sliceIndex: number): boolean =>
    stageSvg().querySelector(`[data-slice="${sliceIndex}"]`).classList.contains("em-slice-dim");

  it("keeps review mode and the active slice through metadata-present, metadata-less, and restored reloads", async () => {
    await boot(slicedSvg("v1"), "v1");
    expect(byId("storyboard").hidden).toBe(false);
    expect(byId("reviewToggle").disabled).toBe(false);

    // Enter review mode: slice 0 becomes active, slice 1 dims, camera flies to A.
    byId("reviewToggle").click();
    await settleFly();
    expect(byId("reviewToggle").classList.contains("active")).toBe(true);
    expect(sliceButtons().map((b) => b.classList.contains("active"))).toEqual([true, false]);
    expect(dimmed(0)).toBe(false);
    expect(dimmed(1)).toBe(true);
    expectBoxClose(camBox(), SLICE_A_FRAME);

    // Reload with the same metadata: still in review, same slice, same frame.
    responses.push({ text: slicedSvg("v2") });
    es().onmessage!({});
    await untilShows("v2");
    await settleFly();
    expect(byId("reviewToggle").classList.contains("active")).toBe(true);
    expect(sliceButtons().map((b) => b.classList.contains("active"))).toEqual([true, false]);
    expect(dimmed(1)).toBe(true);
    expectBoxClose(camBox(), SLICE_A_FRAME);

    // Reload with NO metadata (transient bad render): review mode is sticky,
    // the storyboard just hides until slices come back.
    responses.push({ text: plainSvg("v3") });
    es().onmessage!({});
    await untilShows("v3");
    await settleFly();
    expect(byId("storyboard").hidden).toBe(true);
    expect(byId("reviewToggle").classList.contains("active")).toBe(true);

    // Metadata returns: position restored — slice 0 active again, camera back
    // on its frame, slice 1 dimmed.
    responses.push({ text: slicedSvg("v4") });
    es().onmessage!({});
    await untilShows("v4");
    await settleFly();
    expect(byId("storyboard").hidden).toBe(false);
    expect(sliceButtons().map((b) => b.classList.contains("active"))).toEqual([true, false]);
    expect(dimmed(0)).toBe(false);
    expect(dimmed(1)).toBe(true);
    expectBoxClose(camBox(), SLICE_A_FRAME);
  });
});

describe("camera math", () => {
  it("fits the natural viewBox to the stage aspect on load", async () => {
    await boot(plainSvg("cam"), "cam");
    expectBoxClose(camBox(), FIT_800x600, 1e-9);
  });

  it("ctrl+wheel zooms about the cursor: same model point stays under it", async () => {
    await boot(plainSvg("cam"), "cam");
    const before = camBox();
    const cursor = { clientX: 200, clientY: 150 };
    wheel({ ctrlKey: true, deltaY: -100, ...cursor });
    const after = camBox();

    // deltaY −100 means a zoom factor of exp(1): the view narrows by exactly
    // that (no clamp binds at this level), preserving aspect.
    expect(after.w).toBeCloseTo(before.w / Math.E, 6);
    expect(after.w / after.h).toBeCloseTo(before.w / before.h, 9);

    // And the invariant zoom-about-cursor exists for: the model point under
    // the cursor is fixed.
    const pBefore = toModel(before, cursor.clientX, cursor.clientY);
    const pAfter = toModel(after, cursor.clientX, cursor.clientY);
    expect(Math.abs(pAfter.x - pBefore.x)).toBeLessThan(1e-6);
    expect(Math.abs(pAfter.y - pBefore.y)).toBeLessThan(1e-6);
  });

  it("repeated zoom-in clamps at 30x fit and never shrinks below it", async () => {
    await boot(plainSvg("cam"), "cam");
    const minW = FIT_800x600.w / 30;
    for (let i = 0; i < 10; i++) {
      wheel({ ctrlKey: true, deltaY: -300, clientX: 200, clientY: 150 });
      expect(camBox().w).toBeGreaterThanOrEqual(minW - 1e-9);
    }
    expect(camBox().w).toBeCloseTo(minW, 6);
  });

  it("plain wheel pans by deltaX/deltaY times the view scale", async () => {
    await boot(plainSvg("cam"), "cam");
    // At fit the px→model scale is (400/3)/800 = 100/600 = 1/6 exactly, and
    // this small pan stays well inside the pan clamp: deltaX 30 → +5 model
    // units, deltaY 40 → +20/3.
    wheel({ deltaX: 30, deltaY: 40 });
    expectBoxClose(
      camBox(),
      { x: FIT_800x600.x + 5, y: FIT_800x600.y + 20 / 3, w: FIT_800x600.w, h: FIT_800x600.h },
      1e-9,
    );
  });
});

describe("resize semantics", () => {
  it("re-fits on resize while at fit, but leaves a hand-panned camera alone", async () => {
    await boot(plainSvg("rs"), "rs");
    expectBoxClose(camBox(), FIT_800x600, 1e-9);

    // Still at fit: a resize re-fits to the new stage aspect. 1000x500 has
    // aspect 2, so the view widens to 100·2 = 200, centered: x = −50.
    setRect(1000, 500);
    g.window.dispatchEvent(new g.Event("resize"));
    expectBoxClose(camBox(), { x: -50, y: 0, w: 200, h: 100 }, 1e-9);

    // A manual pan marks the camera as hand-placed…
    wheel({ deltaX: 10, deltaY: 0 });
    const panned = camBox();
    // …so a later resize must not move it.
    setRect(600, 600);
    g.window.dispatchEvent(new g.Event("resize"));
    expectBoxClose(camBox(), panned, 1e-12);
  });
});
