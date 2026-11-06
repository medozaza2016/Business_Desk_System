/* ============================================================================
   Public agreement page — /a/<token>
   ----------------------------------------------------------------------------
   The customer-facing view of one sale or purchase agreement: the vehicle, both
   parties, the three money figures, and the signed sheet itself.

   It is a sibling of share-page.js, not a reuse of it: an agreement prints a
   balance where a quotation prints a single value, so its facts differ. Everything
   is inline, the only subresource is the signed copy, and the only script is the
   shared Print handler, pinned by hash in the response's CSP (see htmlResponse).
   ========================================================================= */

import { SHARE_PRINT_SCRIPT } from "./share-page.js";

const escapeHtml = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const STYLE = `
:root {
  --paper: #f4f2ee; --sheet: #ffffff; --ink: #111111; --ink-soft: #3a3833;
  --muted: #6e6a62; --line: #dbd6cc; --red: #c51e25; --red-deep: #9d1319;
  --mono: ui-monospace, "SF Mono", "Cascadia Mono", Menlo, Consolas, monospace;
  --sans: Arial, "Helvetica Neue", Helvetica, "Segoe UI", Tahoma, sans-serif;
}
* { box-sizing: border-box; }
body {
  margin: 0; padding: 22px 16px 48px; background: var(--paper); color: var(--ink);
  font: 14px/1.55 var(--sans); font-variant-numeric: tabular-nums;
  -webkit-font-smoothing: antialiased; -webkit-text-size-adjust: 100%;
}
.sheet {
  max-width: 720px; margin: 0 auto; background: var(--sheet); border: 1px solid var(--line);
  border-radius: 3px; box-shadow: 0 20px 50px -34px #1114, 0 1px 0 #fff inset; overflow: hidden;
}
.rule { height: 5px; background: repeating-linear-gradient(90deg, var(--red) 0 22px, #111 22px 44px); }
.head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; padding: 22px 22px 16px; }
.brand { font-size: 13px; font-weight: 800; letter-spacing: .14em; text-transform: uppercase; }
.brand b { color: var(--red); }
.brand small { display: block; margin-top: 4px; font-size: 10px; font-weight: 400; letter-spacing: .12em; color: var(--muted); }
.brand-ar { font-size: 13px; line-height: 1.5; text-align: right; color: var(--ink-soft); max-width: 46%; }
.band { display: flex; align-items: flex-end; justify-content: space-between; gap: 14px; flex-wrap: wrap;
  padding: 16px 22px; border-top: 1px solid var(--line); border-bottom: 3px solid var(--red); background: #fbfaf7; }
.label { margin: 0; font-size: 9.5px; font-weight: 700; letter-spacing: .18em; text-transform: uppercase; color: var(--muted); }
.number { margin: 3px 0 0; font-family: var(--mono); font-size: 27px; font-weight: 700; letter-spacing: -.01em; }
.band-date { font-family: var(--mono); font-size: 12px; color: var(--ink-soft); }
.facts { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px 22px; margin: 0; padding: 20px 22px 4px; }
.facts dt { margin: 0 0 3px; font-size: 9.5px; font-weight: 700; letter-spacing: .16em; text-transform: uppercase; color: var(--muted); }
.facts dd { margin: 0; font-size: 13.5px; }
.facts dd.mono { font-family: var(--mono); font-size: 12.5px; letter-spacing: .01em; }
.money { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 1px; margin: 18px 22px 0;
  background: var(--line); border: 1px solid var(--line); }
.money div { background: #fbfaf7; padding: 12px 14px; }
.money dt { margin: 0 0 4px; font-size: 9px; font-weight: 700; letter-spacing: .16em; text-transform: uppercase; color: var(--muted); }
.money dd { margin: 0; font-family: var(--mono); font-size: 15px; font-weight: 700; }
.money .due dd { color: var(--red-deep); }
.words { margin: 14px 22px 0; padding: 11px 14px; border-left: 3px solid var(--red); background: #fbfaf7;
  font-size: 12.5px; color: var(--ink-soft); }
.words b { display: block; margin-bottom: 3px; font-size: 9px; letter-spacing: .16em; text-transform: uppercase; color: var(--muted); }
.note { margin: 16px 22px 0; padding: 12px 14px; border: 1px dashed var(--line); font-size: 12.5px; color: var(--ink-soft); }

.section-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px;
  margin: 24px 22px 12px; padding-bottom: 7px; border-bottom: 1px solid var(--line); }
.section-head h2 { margin: 0; font-size: 11px; font-weight: 800; letter-spacing: .18em; text-transform: uppercase; }
.section-head span { font-family: var(--mono); font-size: 10px; letter-spacing: .1em; text-transform: uppercase; color: var(--muted); }
.scan-stage { margin: 0 22px; padding: 10px; border: 1px solid var(--line); background: #fbfaf7; }
.scan-stage a { display: block; }
.scan-stage img { display: block; width: 100%; height: auto; background: #fff; box-shadow: 0 12px 28px -22px #1119; }
.scan-doc { display: flex; align-items: center; gap: 14px; margin: 0 22px; padding: 16px;
  border: 1px solid var(--line); background: #fbfaf7; color: inherit; text-decoration: none; }
.scan-doc-kind { flex: 0 0 auto; padding: 5px 8px; background: var(--red); color: #fff;
  font-family: var(--mono); font-size: 10px; font-weight: 700; letter-spacing: .1em; }
.scan-doc-body { display: block; }
.scan-doc-name { display: block; font-size: 13px; font-weight: 700; }
.scan-doc-meta { display: block; font-family: var(--mono); font-size: 10.5px; color: var(--muted); }
.actions { display: flex; flex-wrap: wrap; gap: 9px; margin: 14px 22px 0; }
.btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; padding: 11px 15px;
  border: 1px solid var(--ink); border-radius: 2px; font: 700 11px/1 var(--sans);
  letter-spacing: .1em; text-transform: uppercase; text-decoration: none; cursor: pointer; background: none; color: var(--ink); }
.btn.primary { background: var(--red); border-color: var(--red); color: #fff; }
.btn.primary:hover { background: var(--red-deep); }
.btn.ghost:hover { background: #f1eee8; }
.actions-hint { flex: 1 1 100%; margin: 0; font-size: 11px; color: var(--muted); }
.status-line { display: flex; align-items: center; gap: 8px; margin: 18px 22px 0; font-size: 11.5px; color: var(--muted); }
.dot { width: 7px; height: 7px; border-radius: 50%; background: var(--red); }
.dot.done { background: #1f7a3f; }
.foot { margin-top: 26px; padding: 13px 22px; border-top: 1px solid var(--line); background: #fbfaf7;
  font-family: var(--mono); font-size: 10px; letter-spacing: .06em; text-transform: uppercase; color: var(--muted); }
@media (max-width: 480px) {
  .head { flex-direction: column; gap: 8px; }
  .brand-ar { max-width: 100%; text-align: left; }
  .facts { grid-template-columns: minmax(0, 1fr); gap: 12px; }
  .money { grid-template-columns: minmax(0, 1fr); }
  .number { font-size: 24px; }
  .actions .btn { flex: 1 1 100%; }
}
@page { size: A4; margin: 12mm; }
@media print {
  body { padding: 0; background: #fff; }
  .sheet { max-width: none; border: 0; border-radius: 0; box-shadow: none; overflow: visible; }
  .actions { display: none; }
  .scan-stage { margin: 0; padding: 0; border: 0; background: none; }
  .scan-stage img { width: 100%; height: auto; box-shadow: none; }
  .scan-doc { break-inside: avoid; margin: 0; }
  /* the signed page gets its own sheet of paper, so it prints as large as it can */
  .sheet.has-scan .section-head { break-before: page; }
}
`;

/** Shared shell so the "link is gone" page cannot drift from the real one. */
const shell = ({ title, description, image, body, sheetClass = "" }) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light">
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description)}">
<meta property="og:type" content="website">
<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="${escapeHtml(description)}">
${image ? `<meta property="og:image" content="${escapeHtml(image)}">` : ""}
<style>${STYLE}</style>
</head>
<body>
<div class="sheet${sheetClass ? ` ${sheetClass}` : ""}">
  <div class="rule"></div>
${body}
</div>
<script>${SHARE_PRINT_SCRIPT}</script>
</body>
</html>`;

const fileSize = (bytes) => {
  const size = Number(bytes) || 0;
  if (!size) return "document";
  if (size < 1024 * 1024) return `${Math.max(1, Math.round(size / 1024))} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
};

/**
 * The customer's view of one agreement.
 * @param {object} view
 * @param {{agreement_number:string,kind_label:string,agreement_date_text:string,status:string,
 *          vehicle_model:string,vehicle_year:string,vehicle_chassis:string,vehicle_plate:string,
 *          vehicle_color:string,seller_name:string,buyer_name:string,full_amount:string,
 *          paid_amount:string,balance:string,currency:string,full_amount_words:string,
 *          balance_words:string,notes:string}} view.agreement
 * @param {{name:string,legal_name:string,legal_name_ar:string,phone:string,email:string}} view.company
 * @param {{bytes:number,width:number,height:number,content_type:string}|null} view.scan
 * @param {{image:string,download:string}} view.links
 */
export function renderAgreementSharePage({ agreement, company, scan, links }) {
  const legalEn = company.legal_name || company.name || "Agreement";
  const parts = String(legalEn).split(/\s+/);
  const head = parts.shift() || "Agreement";
  const legalAr = company.legal_name_ar || "";
  const currency = agreement.currency || "AED";
  const kindLabel = agreement.kind_label || "Agreement";
  /* a PDF is a document, not a picture: the page shows the file instead of an <img> */
  const isPdf = Boolean(scan) && String(scan.content_type || "").toLowerCase() === "application/pdf";
  const isDone = agreement.status === "completed";
  /* three states, not two: a page can be signed but not yet closed at the desk, and
     saying "awaiting the signed copy" while the picture sits right below it reads as a bug */
  const statusText = isDone
    ? "Signed by both parties — this document is complete"
    : scan
      ? "Signed copy on file — the desk is closing the record"
      : "Awaiting the signed copy at the desk";
  const facts = [
    ["Vehicle", [agreement.vehicle_model, agreement.vehicle_year].filter(Boolean).join(" · "), ""],
    ["Chassis number", agreement.vehicle_chassis || "—", "mono"],
    ["Plate", agreement.vehicle_plate || "—", "mono"],
    ["Colour", agreement.vehicle_color || "—", ""],
    ["Seller", agreement.seller_name || "—", ""],
    ["Buyer", agreement.buyer_name || "—", ""],
  ];

  const body = `  <div class="head">
    <div class="brand"><b>${escapeHtml(head)}</b> ${escapeHtml(parts.join(" "))}
      <small>signed ${escapeHtml(kindLabel.toLowerCase())}</small>
    </div>
    ${legalAr ? `<div class="brand-ar" lang="ar" dir="rtl">${escapeHtml(legalAr)}</div>` : ""}
  </div>

  <div class="band">
    <div>
      <p class="label">${escapeHtml(kindLabel)}</p>
      <p class="number">${escapeHtml(agreement.agreement_number)}</p>
    </div>
    <div class="band-date">${escapeHtml(agreement.agreement_date_text || "")}</div>
  </div>

  <dl class="facts">
    ${facts.map(([label, value, kind]) => `<div><dt>${escapeHtml(label)}</dt><dd${kind ? ` class="${kind}"` : ""}>${escapeHtml(value)}</dd></div>`).join("\n    ")}
  </dl>

  <dl class="money">
    <div><dt>Agreed value</dt><dd>${escapeHtml(`${currency} ${agreement.full_amount}`)}</dd></div>
    <div><dt>Received</dt><dd>${escapeHtml(`${currency} ${agreement.paid_amount}`)}</dd></div>
    <div class="due"><dt>Balance due</dt><dd>${escapeHtml(`${currency} ${agreement.balance}`)}</dd></div>
  </dl>

  <p class="words"><b>Amount in words</b>${escapeHtml(agreement.full_amount_words || "")}</p>
  ${agreement.notes ? `<p class="note"><em>Note</em><br>${escapeHtml(agreement.notes)}</p>` : ""}

  <div class="status-line"><span class="dot${isDone ? " done" : ""}"></span>${escapeHtml(statusText)}</div>

  <div class="section-head">
    <h2>Signed copy</h2>
    <span>${scan ? "on file" : "pending"}</span>
  </div>
  ${scan
    ? `${isPdf
      ? `<a class="scan-doc" href="${escapeHtml(links.image)}" target="_blank" rel="noopener">
    <span class="scan-doc-kind">PDF</span>
    <span class="scan-doc-body">
      <span class="scan-doc-name">Signed ${escapeHtml(kindLabel.toLowerCase())} ${escapeHtml(agreement.agreement_number)}</span>
      <span class="scan-doc-meta">${escapeHtml(fileSize(scan.bytes))} · tap to open</span>
    </span>
  </a>`
      : `<div class="scan-stage">
    <a href="${escapeHtml(links.image)}" target="_blank" rel="noopener">
      <img src="${escapeHtml(links.image)}" alt="Signed copy of agreement ${escapeHtml(agreement.agreement_number)}" width="${Number(scan.width) || 1240}" height="${Number(scan.height) || 1754}">
    </a>
  </div>`}
  <div class="actions">
    <a class="btn primary" href="${escapeHtml(links.download)}" download>Download the ${isPdf ? "PDF" : "picture"}</a>
    ${isPdf
      /* the signed page is a PDF: only its own viewer can put it on paper, so Print
         hands the file over instead of printing this summary and calling it done */
      ? `<a class="btn ghost" href="${escapeHtml(links.image)}" target="_blank" rel="noopener">Print the PDF</a>
    <p class="actions-hint">The PDF opens in your reader — print it from there</p>`
      : `<button class="btn ghost" type="button" data-print>Print</button>`}
  </div>`
    : `<p class="note">The signed copy is not on file yet — ask the desk to scan the page both parties signed.</p>
  <div class="actions">
    <button class="btn primary" type="button" data-print>Print</button>
  </div>`}

  <div class="foot">${escapeHtml([company.phone, company.email].filter(Boolean).join(" · ") || legalEn)}</div>`;

  return shell({
    title: `${kindLabel} ${agreement.agreement_number} · ${legalEn}`,
    description: `${facts[0][1]} · ${currency} ${agreement.full_amount} · balance ${currency} ${agreement.balance}`,
    image: scan && !isPdf ? links.image : "",
    sheetClass: scan ? "has-scan" : "",
    body,
  });
}

/**
 * Shown for a revoked token, a cancelled record or a typo. It says nothing about
 * whether the agreement exists: the link, not the record, is what expired.
 */
export function renderAgreementShareMissing() {
  return shell({
    title: "This link is no longer active",
    description: "The agreement link has expired or was revoked by the desk.",
    image: "",
    body: `  <div class="head"><div class="brand"><b>AGREEMENT</b> DESK<small>link unavailable</small></div></div>
  <div class="band"><div><p class="label">Link status</p><p class="number">no longer active</p></div></div>
  <p class="note" style="margin:18px 22px 0">This link has expired or was revoked. Ask the desk for a fresh one — the agreement itself is unchanged.</p>`,
  });
}
