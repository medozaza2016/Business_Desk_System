/* Node unit tests for the public agreement page in src/agreement-share.js.
   Run with `npm run test:agreement-share`.

   renderAgreementSharePage() is a pure function of the row, so the shapes the desk
   can hand a customer are pinned here: a scanned picture, a PDF, and no signed copy
   at all. The stakes are the same as on the quotation page — a picture page prints
   itself, a PDF page must not pretend it can — with one difference that matters: an
   agreement prints three money figures, and it says which of the three is due. */

import assert from "node:assert/strict";
import { SHARE_PRINT_SCRIPT } from "../src/share-page.js";
import { renderAgreementSharePage, renderAgreementShareMissing } from "../src/agreement-share.js";

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

const agreement = {
  agreement_number: "SA-2026-00011",
  kind_label: "Sale",
  agreement_date_text: "06 Nov 2026",
  status: "completed",
  vehicle_model: "Toyota Land Cruiser",
  vehicle_year: "2025",
  vehicle_chassis: "JTMHV05J204123456",
  vehicle_plate: "DXB R 48213",
  vehicle_color: "White",
  seller_name: "Ahmed Al Marri",
  buyer_name: "Sunrise Trading LLC",
  full_amount: "185,000.00",
  paid_amount: "25,000.00",
  balance: "160,000.00",
  currency: "AED",
  full_amount_words: "one hundred eighty five thousand",
  balance_words: "one hundred sixty thousand",
  notes: "",
};
const company = {
  name: "Challenger",
  legal_name: "CHALLENGER USED CARS EXHB. LLC",
  legal_name_ar: "شانجر",
  phone: "+971505646899",
  email: "INFO@CHALLENGERUSEDCARS.COM",
};
const links = { image: "/a/tok/scan", download: "/a/tok/scan?download=1" };
const page = (scan, changes = {}) => renderAgreementSharePage({
  agreement: { ...agreement, ...changes },
  company,
  scan,
  links,
});


test("a picture signed copy prints the page itself", () => {
  const html = page({ bytes: 30040, width: 1240, height: 1754, content_type: "image/jpeg" });
  assert.match(html, /<button class="btn ghost" type="button" data-print>Print<\/button>/);
  assert.doesNotMatch(html, /Print the PDF/);
  assert.match(html, /<img src="\/a\/tok\/scan"/);
  assert.match(html, /property="og:image" content="\/a\/tok\/scan"/);
});

test("a PDF signed copy hands printing to the file, not to the summary page", () => {
  const html = page({ bytes: 430080, width: 0, height: 0, content_type: "application/pdf" });
  assert.match(html, /<a class="btn ghost" href="\/a\/tok\/scan" target="_blank" rel="noopener">Print the PDF<\/a>/);
  assert.doesNotMatch(html, /data-print>/, "the page must not offer to print itself: the signed page would be left out");
  assert.match(html, /scan-doc/);
  assert.doesNotMatch(html, /<img /, "a file that is not a picture must not be drawn as one");
  assert.doesNotMatch(html, /property="og:image"/, "a PDF is not a preview image");
  assert.match(html, /420 KB/);
});

test("an agreement without a signed copy says so", () => {
  const html = page(null);
  assert.match(html, /The signed copy is not on file yet/);
  assert.match(html, /<span>pending<\/span>/);
  assert.match(html, /data-print>/, "the figures are still worth a sheet of paper");
  assert.doesNotMatch(html, /Print the PDF/);
  assert.doesNotMatch(html, /<img /);
});

test("the three money figures are named, and the balance is the one marked due", () => {
  const html = page({ bytes: 30040, width: 1240, height: 1754, content_type: "image/jpeg" });
  assert.match(html, /<dt>Agreed value<\/dt><dd>AED 185,000\.00<\/dd>/);
  assert.match(html, /<dt>Received<\/dt><dd>AED 25,000\.00<\/dd>/);
  assert.match(html, /<div class="due"><dt>Balance due<\/dt><dd>AED 160,000\.00<\/dd><\/div>/);
  assert.match(html, /one hundred eighty five thousand/);
});

test("the status line distinguishes signed-but-open from completed", () => {
  const settled = page({ bytes: 30040, width: 1240, height: 1754, content_type: "image/jpeg" });
  assert.match(settled, /Signed by both parties — this document is complete/);
  const open = page({ bytes: 30040, width: 1240, height: 1754, content_type: "image/jpeg" }, { status: "issued" });
  assert.match(open, /Signed copy on file — the desk is closing the record/);
  assert.match(page(null, { status: "issued" }), /Awaiting the signed copy at the desk/);
});

test("a purchase agreement prints its own word, not the sale one", () => {
  const html = page(null, { kind_label: "Purchase", agreement_number: "PA-2026-00004" });
  assert.match(html, /<small>signed purchase<\/small>/);
  assert.match(html, /<p class="label">Purchase<\/p>/);
  assert.match(html, /PA-2026-00004/);
  assert.match(html, /<title>Purchase PA-2026-00004/);
});

test("a note is escaped, never allowed to become markup", () => {
  const html = page(null, { notes: "<script>alert(1)</script> sold as seen" });
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt; sold as seen/);
  assert.doesNotMatch(html, /<script>alert/);
});

test("a missing field is a dash, not the word undefined", () => {
  const html = page(null, { vehicle_plate: "", vehicle_color: null, seller_name: "" });
  assert.doesNotMatch(html, /undefined|null/);
  assert.match(html, /<dt>Plate<\/dt><dd class="mono">—<\/dd>/);
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

test("the expired link says only that the link expired", () => {
  const html = renderAgreementShareMissing();
  assert.match(html, /no longer active/);
  assert.doesNotMatch(html, /SA-2026|PA-2026/, "a dead link must not confirm which agreement it pointed at");
  assert.equal(html.split("<script>").length - 1, 1);
});

console.log(`\n${passed} test(s) passed${process.exitCode ? " — with failures" : ""}`);

