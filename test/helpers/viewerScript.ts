// SPDX-License-Identifier: MIT
// Splits the viewer page (src/render/viewer.html / the VIEWER_HTML constant)
// into its body markup and its one inline script, for tests that execute or
// parse the script for real.

export interface ViewerParts {
  /** The inline script's body (between <script> and </script>). */
  script: string;
  /** The body markup up to the script tag — everything the script expects in the DOM. */
  bodyMarkup: string;
}

/** Index-slice rather than regex the tags out (also keeps CodeQL's
 *  js/bad-tag-filter quiet) — the page has exactly one script element. */
export function splitViewerHtml(html: string): ViewerParts {
  const open = html.indexOf("<script>");
  const close = html.lastIndexOf("</script>");
  const bodyOpen = html.indexOf("<body>");
  if (bodyOpen === -1 || open === -1 || close <= open) {
    throw new Error("viewer page shape changed: expected <body> and a single <script> element");
  }
  return {
    script: html.slice(open + "<script>".length, close),
    bodyMarkup: html.slice(bodyOpen + "<body>".length, open),
  };
}
