/* ============================================================================
   Public share page — /s/<token>
   ----------------------------------------------------------------------------
   The customer-facing view of one quotation: the figures, and the signed sheet
   itself. Rendered on the Worker (not a client-side page) so it works from a
   WhatsApp tap with no session cookie and no API round-trip — one document, one
   image.

   It carries the desk aesthetic on purpose: whoever receives the link already
   holds the printed sheet, so the page reads as the same paperwork, not as a
   marketing landing page. Everything is inline; the only subresource is the
   signed copy, and the only script is the Print button below, pinned by hash in
   the response's CSP.
   ========================================================================= */

const escapeHtml = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/**
 * The page's one script: a Print button, because "open the A4 sheet in another tab
 * and print it from there" was a detour for a customer holding a phone. It is a
 * fixed string on purpose — index.js hashes it into the CSP, so the response needs
 * no per-request nonce and the page stays script-free apart from this handler.
 *
 * It is only wired to pages whose signed copy is a picture. window.print() prints
 * the HTML document in front of it, so on a PDF page it would print the figures and
 * leave the signed page out; there the Print control is a plain link to the file and
 * the viewer does the printing (see the actions block below).
 */
export const SHARE_PRINT_SCRIPT =
  "document.addEventListener('click',function(e){var b=e.target.closest('[data-print]');if(!b)return;e.preventDefault();window.print();});";

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
.number { margin: 3px 0 0; font-family: var(--mono); font-size: 30px; line-height: 1; letter-spacing: -.03em; }
.band-date { font-family: var(--mono); font-size: 12.5px; color: var(--ink-soft); text-align: right; }
.facts { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px 18px; margin: 0; padding: 20px 22px; }
.facts div { min-width: 0; }
.facts dt { font-size: 9.5px; font-weight: 700; letter-spacing: .14em; text-transform: uppercase; color: var(--muted); }
.facts dd { margin: 4px 0 0; font-size: 14px; overflow-wrap: anywhere; }
.facts .mono { font-family: var(--mono); font-size: 13px; }
.facts .total dd { font-family: var(--mono); font-size: 20px; font-weight: 700; letter-spacing: -.02em; }
.words { margin: 0 22px; padding: 12px 14px; border-left: 3px solid var(--red); background: #fbf7f4;
  font-size: 12.5px; line-height: 1.6; color: var(--ink-soft); }
.words b { display: block; font-size: 9.5px; letter-spacing: .14em; text-transform: uppercase; color: var(--muted); margin-bottom: 3px; }
.note { margin: 14px 22px 0; font-size: 12.5px; color: var(--ink-soft); }
.note em { font-style: normal; font-family: var(--mono); font-size: 11px; letter-spacing: .04em; text-transform: uppercase; color: var(--muted); }
.section-head { display: flex; align-items: baseline; justify-content: space-between; gap: 10px;
  margin: 26px 22px 0; padding-bottom: 8px; border-bottom: 2px solid var(--ink); }
.section-head h2 { margin: 0; font-size: 11px; font-weight: 700; letter-spacing: .14em; text-transform: uppercase; }
.section-head span { font-family: var(--mono); font-size: 10px; letter-spacing: .06em; text-transform: uppercase; color: var(--muted); }
.scan-stage { margin: 14px 22px 0; padding: 14px; background: repeating-linear-gradient(45deg, #eae7e1 0 8px, #eeebe5 8px 16px); border: 1px solid var(--line); }
.scan-stage a { display: block; }
.scan-stage img { display: block; width: 100%; height: auto; background: #fff; box-shadow: 0 10px 30px -18px #1119, 0 0 0 1px #d9d4ca; }
.actions { display: flex; flex-wrap: wrap; gap: 8px; padding: 16px 22px 22px; }
.btn {
  display: inline-flex; align-items: center; justify-content: center; min-height: 40px; padding: 0 16px;
  border: 1px solid transparent; border-radius: 3px; background: var(--ink); color: #fff;
  font-size: 11.5px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; text-decoration: none;
}
.btn.primary { background: var(--red); }
.btn.ghost { background: transparent; border-color: var(--line); color: var(--ink-soft); }
a.btn, button.btn { cursor: pointer; }
button.btn { font-family: inherit; }
/* a PDF opens in the browser's own reader, so the print button is a hand-off — say so */
.actions-hint { flex: 1 1 100%; margin: 0; font-family: var(--mono); font-size: 9.5px;
  letter-spacing: .06em; text-transform: uppercase; color: var(--muted); }
/* a PDF cannot be shown as a picture, so it is shown as what it is: one document */
.scan-doc { display: flex; align-items: center; gap: 13px; margin: 14px 22px 0; padding: 15px;
  border: 1px solid var(--line); background: #fbfaf7; color: var(--ink); text-decoration: none; }
.scan-doc-kind { flex: 0 0 auto; padding: 7px 9px; background: var(--red); color: #fff;
  font-family: var(--mono); font-size: 10.5px; font-weight: 700; letter-spacing: .1em; }
.scan-doc-body { min-width: 0; }
.scan-doc-name { display: block; font-size: 13.5px; font-weight: 700; }
.scan-doc-meta { display: block; margin-top: 3px; font-family: var(--mono); font-size: 10px;
  letter-spacing: .06em; text-transform: uppercase; color: var(--muted); }
.foot { margin-top: 26px; padding: 13px 22px; border-top: 1px solid var(--line); background: #fbfaf7;
  font-family: var(--mono); font-size: 10px; letter-spacing: .06em; text-transform: uppercase; color: var(--muted); }
@media (max-width: 480px) {
  .head { flex-direction: column; gap: 8px; }
  .brand-ar { max-width: 100%; text-align: left; }
  .facts { grid-template-columns: minmax(0, 1fr); gap: 12px; }
  .number { font-size: 24px; }
  .band-date { text-align: left; }
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
}`;


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
 * The customer's view of one quotation.
 * @param {object} view
 * @param {{quote_number:string,quote_date_text:string,model:string,year:string,chassis:string,
 *          amount:string,currency:string,amount_words:string,comments:string,status:string}} view.quotation
 * @param {{name:string,legal_name:string,legal_name_ar:string,phone:string,email:string}} view.company
 * @param {{bytes:number,width:number,height:number,content_type:string}|null} view.scan
 * @param {{image:string,download:string}} view.links
 */
export function renderSharePage({ quotation, company, scan, links }) {
  const legalEn = company.legal_name || company.name || "Quotation";
  const parts = String(legalEn).split(/\s+/);
  const head = parts.shift() || "Quotation";
  const legalAr = company.legal_name_ar || "";
  const currency = quotation.currency || "AED";
  const total = `${currency} ${quotation.amount}`;
  /* a PDF is a document, not a picture: the page shows the file instead of an <img> */
  const isPdf = Boolean(scan) && String(scan.content_type || "").toLowerCase() === "application/pdf";
  const facts = [
    ["Vehicle", `${quotation.model} · ${quotation.year}`, ""],
    ["Chassis number", quotation.chassis, "mono"],
    ["Quotation date", quotation.quote_date_text, "mono"],
    ["Status", quotation.status === "completed" ? "Completed" : "Issued", ""],
  ];

  const body = `  <div class="head">
    <div class="brand"><b>${escapeHtml(head)}</b> ${escapeHtml(parts.join(" "))}
      <small>signed quotation</small>
    </div>
    ${legalAr ? `<div class="brand-ar" lang="ar" dir="rtl">${escapeHtml(legalAr)}</div>` : ""}
  </div>

  <div class="band">
    <div>
      <p class="label">Quotation</p>
      <p class="number">${escapeHtml(quotation.quote_number)}</p>
    </div>
    <div class="band-date">${escapeHtml(quotation.quote_date_text)}</div>
  </div>

  <dl class="facts">
    ${facts.map(([label, value, kind]) => `<div><dt>${escapeHtml(label)}</dt><dd class="${kind}">${escapeHtml(value)}</dd></div>`).join("\n    ")}
    <div class="total" style="grid-column:1/-1"><dt>Estimated value</dt><dd>${escapeHtml(total)}</dd></div>
  </dl>

  <p class="words"><b>Amount in words</b>${escapeHtml(quotation.amount_words)}</p>
  ${quotation.comments ? `<p class="note"><em>Note</em><br>${escapeHtml(quotation.comments)}</p>` : ""}

  <div class="section-head">
    <h2>Signed copy</h2>
    <span>${scan ? "on file" : "pending"}</span>
  </div>
  ${scan
    ? `${isPdf
      ? `<a class="scan-doc" href="${escapeHtml(links.image)}" target="_blank" rel="noopener">
    <span class="scan-doc-kind">PDF</span>
    <span class="scan-doc-body">
      <span class="scan-doc-name">Signed quotation ${escapeHtml(quotation.quote_number)}</span>
      <span class="scan-doc-meta">${escapeHtml(fileSize(scan.bytes))} · tap to open</span>
    </span>
  </a>`
      : `<div class="scan-stage">
    <a href="${escapeHtml(links.image)}" target="_blank" rel="noopener">
      <img src="${escapeHtml(links.image)}" alt="Signed copy of quotation ${escapeHtml(quotation.quote_number)}" width="${Number(scan.width) || 1240}" height="${Number(scan.height) || 1754}">
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
    : `<p class="note">The signed copy is not on file yet — ask the desk to scan the page the customer signed.</p>
  <div class="actions">
    <button class="btn primary" type="button" data-print>Print</button>
  </div>`}

  <div class="foot">${escapeHtml([company.phone, company.email].filter(Boolean).join(" · ") || legalEn)}</div>`;

  return shell({
    title: `Quotation ${quotation.quote_number} · ${legalEn}`,
    description: `${quotation.model} ${quotation.year} · ${total} · ${quotation.quote_date_text}`,
    image: scan && !isPdf ? links.image : "",
    sheetClass: scan ? "has-scan" : "",
    body,
  });
}

/**
 * Shown for a revoked token, a cancelled record or a typo. It says nothing about
 * whether the quotation exists: the link, not the record, is what expired.
 */
export function renderShareMissing() {
  return shell({
    title: "This link is no longer active",
    description: "The quotation link has expired or was revoked by the desk.",
    image: "",
    body: `  <div class="head"><div class="brand"><b>QUOTATION</b> DESK<small>link unavailable</small></div></div>
  <div class="band"><div><p class="label">Link status</p><p class="number">no longer active</p></div></div>
  <p class="note" style="margin:18px 22px 0">This link has expired or was revoked. Ask the desk for a fresh one — the quotation itself is unchanged.</p>`,
  });
}
