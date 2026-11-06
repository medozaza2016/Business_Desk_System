/* Node unit tests for the public share page in src/share-page.js.
   Run with `npm run test:share`.

   renderSharePage() is a pure function of the row, so the three shapes the desk can
   hand a customer are pinned here: a scanned picture, a PDF, and no signed copy at
   all. What matters is which control each one gets — a picture page prints itself,
   a PDF page must not pretend it can, because window.print() prints the summary and
   leaves the signed page out. */

import assert from "node:assert/strict";
import { renderSharePage, SHARE_PRINT_SCRIPT } from "../src/share-page.js";

let passed = 0;
const test = (name, run) => {
  try {
    run();
    passed += 1;
    console.log(`ok   ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    console.error(error.message);
    process.exitCode = 1;
  }
};

const quotation = {
  quote_number: "QA-2026-00007",
  quote_date_text: "05 Nov 2026",
  model: "Porsche Cayenne",
  year: "2014",
  chassis: "WP1ZZZ9PZELA12345",
  amount: "44,000.00",
  currency: "AED",
  amount_words: "forty-four thousand",
  comments: "",
  status: "issued",
};
const company = {
  name: "Challenger",
  legal_name: "CHALLENGER USED CARS EXHB. LLC",
  legal_name_ar: "شانجر",
  phone: "+971505646899",
  email: "INFO@CHALLENGERUSEDCARS.COM",
};
const links = { image: "/s/tok/scan", download: "/s/tok/scan?download=1" };
const page = (scan) => renderSharePage({ quotation, company, scan, links });

test("a picture signed copy prints the page itself", () => {
  const html = page({ bytes: 30040, width: 1240, height: 1754, content_type: "image/jpeg" });
  assert.match(html, /<button class="btn ghost" type="button" data-print>Print<\/button>/);
  assert.doesNotMatch(html, /Print the PDF/);
  assert.match(html, /<img src="\/s\/tok\/scan"/);
  assert.match(html, /property="og:image" content="\/s\/tok\/scan"/);
});

test("a PDF signed copy hands printing to the file, not to the summary page", () => {
  const html = page({ bytes: 430080, width: 0, height: 0, content_type: "application/pdf" });
  assert.match(html, /<a class="btn ghost" href="\/s\/tok\/scan" target="_blank" rel="noopener">Print the PDF<\/a>/);
  assert.doesNotMatch(html, /data-print>/, "the page must not offer to print itself: the signed page would be left out");
  assert.match(html, /scan-doc/);
  assert.doesNotMatch(html, /<img /, "a file that is not a picture must not be drawn as one");
  assert.doesNotMatch(html, /property="og:image"/, "a PDF is not a preview image");
  assert.match(html, /420 KB/);
});

test("a quotation without a signed copy says so", () => {
  const html = page(null);
  assert.match(html, /not on file yet/);
  assert.match(html, /data-print>/, "the figures are still worth a sheet of paper");
  assert.doesNotMatch(html, /Print the PDF/);
  assert.doesNotMatch(html, /<img /);
});

test("every page carries exactly one script, the hashed Print handler", () => {
  for (const scan of [null, { bytes: 430080, width: 0, height: 0, content_type: "application/pdf" }]) {
    const html = page(scan);
    assert.equal(html.split("<script>").length - 1, 1, "one inline script, or the CSP hash would not match");
    assert.ok(html.includes(SHARE_PRINT_SCRIPT));
  }
});

test("the download button follows the file, not the picture", () => {
  assert.match(page({ bytes: 430080, width: 0, height: 0, content_type: "application/pdf" }), /Download the PDF/);
  assert.match(page({ bytes: 30040, width: 1240, height: 1754, content_type: "image/jpeg" }), /Download the picture/);
});

console.log(`\n${passed} test(s) passed${process.exitCode ? " — with failures" : ""}`);
