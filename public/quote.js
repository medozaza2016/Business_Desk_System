/* Quotation record page — the signed copy first, then the editable details.
   The page answers one question before any other: "where is the paper the customer
   signed, and how do I hand it over?". The figures, the A4 preview and the edit form
   stay below it, unchanged. */

import { confirmAction } from "./dialog.js";
import { openScanner, processPhotoFile } from "./scan.js";

/** @param {string} id @returns {any} */
const $ = (id) => document.getElementById(id);
const A4_W = 793.7;   // 210mm at 96dpi
const A4_H = 1122.5;  // 297mm at 96dpi

const state = {
  id: new URLSearchParams(location.search).get("id"),
  quote: null,
  previewCount: 0,
  /** desk-wide default for the WhatsApp hand-off, read from /api/settings */
  settings: null,
  /** what this particular send will do; starts at the desk default */
  sendMode: "file",
  busy: false,
};

async function api(path, options = {}) {
  const { body, method = "GET", ...rest } = options;
  const response = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    ...rest,
  });
  const type = response.headers.get("content-type") || "";
  const data = type.includes("application/json") ? await response.json().catch(() => null) : null;
  if (!response.ok) {
    throw Object.assign(new Error((data && data.error) || `HTTP ${response.status}`), {
      status: response.status,
      data,
    });
  }
  return data;
}

/** Multipart upload (the browser sets the boundary itself). */
async function apiUpload(path, formData) {
  const response = await fetch(path, { method: "POST", credentials: "same-origin", body: formData });
  const type = response.headers.get("content-type") || "";
  const data = type.includes("application/json") ? await response.json().catch(() => null) : null;
  if (!response.ok) {
    throw Object.assign(new Error((data && data.error) || `HTTP ${response.status}`), {
      status: response.status,
      data,
    });
  }
  return data;
}

let toastTimer = null;
function toast(message, kind = "ok") {
  const node = $("toast");
  node.textContent = message;
  node.className = `toast show${kind === "error" ? " error" : ""}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.className = "toast"; }, 3600);
}

const message = (error) => {
  const map = {
    quotation_not_found: "This quotation no longer exists.",
    quotation_number_already_exists: "That quotation number is already used.",
    invalid_amount: "Enter a value between 0 and 99,999,999.99.",
    invalid_quote_date: "Enter a valid date.",
    quotation_completed: "This record is completed. Reopen it before changing anything.",
    scan_required: "Scan the signed page before marking the record completed.",
    scan_not_found: "The signed copy is no longer on file.",
    scan_file_required: "The scan came back empty. Try again.",
    scan_too_large: "That signed copy is too large. A picture must be under 4 MB, a PDF under 12 MB.",
    unsupported_scan_type: "That file is not a JPEG, PNG, WebP picture or a PDF.",
    unsupported_image_type: "That file is not a JPEG, PNG or WebP image.",
    storage_unavailable: "File storage is not configured on this deployment.",
    share_link_unavailable: "The share link could not be created.",
    scan_failed: "The scanner produced no page. Try again.",
  };
  return map[error?.message] || error?.message || "Something went wrong.";
};

function fitPreview() {
  const stage = $("previewStage");
  const frame = $("previewFrame");
  const iframe = $("preview");
  /* read the stage's padding instead of assuming 16px: it tightens on narrow screens */
  const style = getComputedStyle(stage);
  const available = stage.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
  if (available <= 0) return;
  const scale = Math.min(available / A4_W, 1);
  frame.style.width = `${Math.round(A4_W * scale)}px`;
  frame.style.height = `${Math.round(A4_H * scale)}px`;
  iframe.style.transform = `scale(${scale})`;
}

function refreshPreview() {
  state.previewCount += 1;
  $("preview").src = `/api/quotations/${encodeURIComponent(state.id)}/print?sheet=${state.previewCount}`;
}


/* ------------------------------------------------------------------ paint --- */

const bytes = (value) => {
  const size = Number(value) || 0;
  if (!size) return "—";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
};

const stampDate = (value) => {
  if (!value) return "—";
  const date = new Date(String(value).includes("T") ? value : String(value).replace(" ", "T") + "Z");
  if (Number.isNaN(date.getTime())) return String(value).slice(0, 16);
  return date.toLocaleString(undefined, {
    day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
  });
};

/** The header band: number, meta strip, status chip and the completion button. */
function paintShell(quote) {
  document.title = `${quote.quote_number} · Challenger Quotation`;
  $("recordNumber").textContent = quote.quote_number;
  $("metaDate").textContent = quote.quote_date_text || quote.quote_date;
  $("metaVehicle").textContent = `${quote.model} · ${quote.year}`;
  $("metaChassis").textContent = quote.chassis;
  $("metaValue").textContent = `${quote.currency || "AED"} ${quote.amount}`;
  $("metaPaperwork").textContent = quote.status === "completed"
    ? "signed · completed"
    : quote.has_scan ? "signed" : "not signed yet";
  $("companyChip").textContent = quote.company?.name || "company";

  const completed = quote.status === "completed";
  const chip = $("statusChip");
  chip.textContent = completed ? "completed" : quote.has_scan ? "signed" : "issued";
  chip.className = `chip ${completed || quote.has_scan ? "ok" : "off"}`;

  $("completeBtn").textContent = completed ? "Reopen record" : "Mark completed";
  $("completeBtn").className = completed ? "btn ghost small" : "btn primary small";
  $("cancelBtn").disabled = completed;
}

/** "PDF", "JPEG", "PNG" — what the file actually is, in the desk's capitals. */
const kindLabel = (contentType) => {
  const type = String(contentType || "").toLowerCase();
  if (type === "application/pdf") return "PDF";
  return type.replace("image/", "").toUpperCase() || "—";
};

/** The signed-copy card: picture, measurements, send controls, completion stamp. */
function paintSigned(quote) {
  const scan = quote.scan || null;
  const completed = quote.status === "completed";
  const pdf = Boolean(scan) && String(scan.content_type || "").toLowerCase() === "application/pdf";
  const image = $("signedImage");
  const chip = $("signedChip");

  $("signedCard").dataset.state = scan ? "signed" : "empty";
  chip.textContent = scan ? (completed ? "on file · completed" : "on file") : "missing";
  chip.className = `chip ${scan ? "ok" : "off"}`;

  if (scan && !pdf) {
    image.src = scan.url;
    image.hidden = false;
  } else {
    image.removeAttribute("src");
    image.hidden = true;
  }
  $("signedEmpty").hidden = Boolean(scan);

  /* a PDF has no picture to show, so the frame becomes the file it is */
  const doc = $("signedDoc");
  doc.hidden = !pdf;
  if (pdf) {
    doc.href = scan.url;
    $("signedDocName").textContent = `${quote.quote_number}-signed.pdf`;
    $("signedDocMeta").textContent = `${bytes(scan.bytes)} · opens in a new tab`;
  }

  $("scanFile").textContent = scan ? kindLabel(scan.content_type) : "—";
  $("scanSize").textContent = scan ? bytes(scan.bytes) : "—";
  $("scanDimensions").textContent = scan && scan.width ? `${scan.width} × ${scan.height} px` : "—";
  $("scanCaptured").textContent = scan ? stampDate(scan.created_at) : "—";

  /* the three ways in stay on screen: a re-scan and a re-upload are the same act */
  $("scanBtn").textContent = scan ? "Scan again" : "Scan the signed page";
  $("uploadPhotoBtn").textContent = scan ? "Replace with a photo" : "Upload a photo";
  $("uploadPdfBtn").textContent = scan ? "Replace with a PDF" : "Upload a PDF";

  $("sendBlock").hidden = !scan;
  $("signedStamp").hidden = !completed;

  $("shareBtn").textContent = quote.share_path ? "Rotate link" : "Create link";
  $("removeScanBtn").disabled = !scan;
  $("downloadBtn").disabled = !scan;
  $("sendBtn").disabled = !scan;
  paintSendMode();
}

/** The two-way switch mirrors the desk default until the operator picks otherwise. */
function paintSendMode() {
  const wanted = state.sendMode;
  for (const button of $("sendMode").querySelectorAll("button")) {
    button.setAttribute("aria-pressed", button.dataset.mode === wanted ? "true" : "false");
  }
  const hasLink = Boolean(state.quote?.share_path);
  if (wanted === "link") {
    $("sendLabel").textContent = hasLink ? "Send the link on WhatsApp" : "Create a link and send";
    $("signedHint").textContent = "The customer gets a private page with the figures and the signed page. Rotate the link if it ever leaks.";
  } else {
    $("sendLabel").textContent = "Send the signed file on WhatsApp";
    $("signedHint").textContent = "WhatsApp opens with the page already attached and you choose the chat. On a computer the picture downloads instead, ready to attach.";
  }
}

function paint(quote) {
  state.quote = quote;
  paintShell(quote);
  paintSigned(quote);

  $("fNumber").value = quote.quote_number;
  $("fDate").value = quote.quote_date;
  $("fModel").value = quote.model;
  $("fYear").value = quote.year;
  $("fChassis").value = quote.chassis;
  $("fComments").value = quote.comments || "";
  $("fCurrency").textContent = quote.currency || "AED";
  $("fAmount").value = quote.amount;
  $("fWords").value = quote.amount_words || "";

  const completed = quote.status === "completed";
  $("saveBtn").disabled = completed;
  for (const id of ["fNumber", "fDate", "fModel", "fYear", "fChassis", "fComments", "fAmount"]) {
    $(id).readOnly = completed;
  }
  $("formNote").textContent = completed
    ? "This record is completed, so its numbers are frozen. Reopen it in the header to make changes."
    : "The sheet is rendered from the template snapshot captured when this record was issued. Later template versions never change an existing quotation.";

  refreshPreview();
}

/* ------------------------------------------------------------------- load --- */

async function load() {
  if (!state.id) { location.href = "/"; return; }
  try {
    const [record, settings] = await Promise.all([
      api(`/api/quotations/${encodeURIComponent(state.id)}`),
      api("/api/settings").catch(() => null),
    ]);
    state.settings = settings?.settings || null;
    /* the desk default is read on every load, so a change in Settings applies here
       without a stale browser preference getting in the way */
    state.sendMode = state.settings?.share_mode === "link" ? "link" : "file";
    paint(record.quotation);
  } catch (error) {
    if (error.status === 401) { location.href = "/"; return; }
    toast(message(error), "error");
    $("statusChip").textContent = "unavailable";
  }
}

/* ------------------------------------------------------------------- save --- */

async function save(event) {
  event?.preventDefault();
  if (!state.quote) return;
  const button = $("saveBtn");
  button.disabled = true;
  try {
    const data = await api(`/api/quotations/${encodeURIComponent(state.id)}`, {
      method: "PATCH",
      body: {
        quote_number: $("fNumber").value.trim(),
        quote_date: $("fDate").value,
        model: $("fModel").value.trim(),
        year: $("fYear").value.trim(),
        chassis: $("fChassis").value.trim(),
        comments: $("fComments").value.trim(),
        amount: $("fAmount").value.trim(),
      },
    });
    paint(data.quotation);
    toast("Record updated. The sheet was rebuilt.");
  } catch (error) {
    toast(message(error), "error");
  } finally {
    button.disabled = state.quote?.status === "completed";
  }
}

function printSheet() {
  if (!state.id) return;
  window.open(`/api/quotations/${encodeURIComponent(state.id)}/print?print=1`, "_blank", "noopener");
}

async function cancelRecord() {
  if (!state.quote) return;
  const okay = await confirmAction({
    title: `Cancel quotation ${state.quote.quote_number}?`,
    message: "It leaves the desk records.",
    confirm: "Cancel record",
  });
  if (!okay) return;
  try {
    await api(`/api/quotations/${encodeURIComponent(state.id)}`, { method: "DELETE" });
    location.href = "/";
  } catch (error) {
    toast(message(error), "error");
  }
}

/* ------------------------------------------------------------ signed copy --- */

/** The tail every signed-copy flow shares: post the bytes, repaint, say what next. */
async function storeSignedPage(form, note) {
  const data = await apiUpload(`/api/quotations/${encodeURIComponent(state.id)}/scan`, form);
  paint(data.quotation);
  toast(note);
}

/** Runs one of the three ways in, with the busy flag held for its whole length. */
async function signedCopyAction(button, run) {
  if (state.busy || !state.quote) return;
  state.busy = true;
  button.disabled = true;
  try {
    await run();
  } catch (error) {
    toast(message(error), "error");
  } finally {
    /* the label is not restored: paint() has already renamed the buttons for the new
       state ("Scan again", "Replace with a PDF"), and putting the old text back would
       undo it */
    state.busy = false;
    button.disabled = false;
  }
}

async function scanPage(event) {
  const button = event?.currentTarget || $("scanBtn");
  await signedCopyAction(button, async () => {
    const page = await openScanner({ title: "Scan the signed page" });
    if (!page) return;
    const form = new FormData();
    form.append("file", new File([page.blob], "signed-page.jpg", { type: "image/jpeg" }));
    form.append("width", String(page.width));
    form.append("height", String(page.height));
    form.append("source", "scan");
    await storeSignedPage(form, "Signed page stored. Send it on WhatsApp below.");
  });
}

/**
 * A photo from the gallery or the file system. It runs through the same detection,
 * warp and flattening as a capture, so an uploaded picture is not left with the
 * yellow cast and the tilted paper the camera app produced.
 */
async function uploadPhoto(file, button) {
  await signedCopyAction(button, async () => {
    const page = await processPhotoFile(file);
    if (!page) {
      toast("That picture could not be read. Try a JPEG or PNG straight from the camera.", "error");
      return;
    }
    const form = new FormData();
    form.append("file", new File([page.blob], "signed-page.jpg", { type: "image/jpeg" }));
    form.append("width", String(page.width));
    form.append("height", String(page.height));
    form.append("source", "upload");
    await storeSignedPage(form, "Photo corrected and stored as the signed page.");
  });
}

/** A PDF from a scanner app: stored byte for byte, never re-encoded. */
async function uploadPdf(file, button) {
  await signedCopyAction(button, async () => {
    const form = new FormData();
    form.append("file", file, file.name || "signed-page.pdf");
    form.append("source", "upload");
    await storeSignedPage(form, "PDF stored as the signed page.");
  });
}

/** The hidden inputs are reopened through a click, so the same file can be re-picked. */
function pickFile(inputId) {
  const input = $(inputId);
  input.value = "";
  input.click();
}

async function removeScan() {
  if (!state.quote) return;
  const okay = await confirmAction({
    title: "Remove the signed page?",
    message: "The record keeps its numbers; the stored picture is deleted.",
    confirm: "Remove the scan",
  });
  if (!okay) return;
  try {
    await api(`/api/quotations/${encodeURIComponent(state.id)}/scan`, { method: "DELETE" });
    const data = await api(`/api/quotations/${encodeURIComponent(state.id)}`);
    paint(data.quotation);
    toast("Signed page removed.");
  } catch (error) {
    toast(message(error), "error");
  }
}

/** Mints (or rotates) the public link and reflects it in the payload. */
async function createShareLink() {
  if (!state.quote) return null;
  try {
    const data = await api(`/api/quotations/${encodeURIComponent(state.id)}/share-link`, { method: "POST" });
    state.quote = { ...state.quote, share_path: data.share_path, share_token_created_at: data.share_token_created_at };
    paintSigned(state.quote);
    return data.share_url || new URL(data.share_path, location.origin).toString();
  } catch (error) {
    toast(message(error), "error");
    return null;
  }
}

async function shareLinkButton() {
  const url = await createShareLink();
  if (!url) return;
  const copied = await copyText(url);
  toast(copied ? "Link created and copied. Any previous link now fails." : "Link created. Copy it from the dialog that follows.");
  if (!copied) window.prompt("Shareable link", url);
  if (state.sendMode !== "link") {
    setSendMode("link");
  }
}

/* --------------------------------------------------------------- whatsapp --- */

const caption = (quote) =>
  `Quotation ${quote.quote_number} — ${quote.model} ${quote.year}, ${quote.currency || "AED"} ${quote.amount}`;

async function copyText(value) {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
}

function openWhatsApp(text) {
  window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, "_blank", "noopener");
}

/** The stored picture as a File, so it can go through the OS share sheet. */
async function scanAsFile() {
  const scan = state.quote?.scan;
  if (!scan) return null;
  const response = await fetch(scan.download_url, { credentials: "same-origin" });
  if (!response.ok) throw new Error("scan_not_found");
  const blob = await response.blob();
  const type = blob.type || scan.content_type || "image/jpeg";
  const ext = type === "image/png" ? "png" : type === "image/webp" ? "webp" : type === "application/pdf" ? "pdf" : "jpg";
  return new File([blob], `${state.quote.quote_number}-signed.${ext}`, { type });
}

function downloadBlob(file) {
  const url = URL.createObjectURL(file);
  const link = document.createElement("a");
  link.href = url;
  link.download = file.name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

async function sendOnWhatsApp() {
  const quote = state.quote;
  if (!quote) return;
  const button = $("sendBtn");
  button.disabled = true;
  try {
    const text = caption(quote);

    if (state.sendMode === "link") {
      const path = quote.share_path || (await createShareLink());
      if (!path) return;
      const url = new URL(path, location.origin).toString();
      if (navigator.share) {
        await navigator.share({ title: text, text, url });
        toast("Shared. Pick the chat in the sheet.");
        return;
      }
      const copied = await copyText(`${text}\n${url}`);
      openWhatsApp(`${text}\n${url}`);
      toast(copied ? "WhatsApp opened — the caption and link are pasted." : "WhatsApp opened with the message prefilled.");
      return;
    }

    const file = await scanAsFile();
    if (!file) { toast("Scan the signed page first.", "error"); return; }
    /* The share sheet is the only way to hand a real file to WhatsApp from a web
       page: wa.me links carry text only, which is why the fallback below attaches
       the picture through the download folder instead. */
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], text });
      toast("Shared. Pick the chat in the sheet.");
      return;
    }
    downloadBlob(file);
    await copyText(text);
    openWhatsApp(text);
    toast("Picture saved to downloads and the caption copied — attach it in WhatsApp.");
  } catch (error) {
    /* closing the OS share sheet is not a failure */
    if (error?.name === "AbortError") return;
    toast(message(error), "error");
  } finally {
    button.disabled = !state.quote?.scan;
  }
}

function setSendMode(mode) {
  state.sendMode = mode === "link" ? "link" : "file";
  paintSendMode();
}

async function downloadScan() {
  try {
    const file = await scanAsFile();
    if (file) downloadBlob(file);
  } catch (error) {
    toast(message(error), "error");
  }
}

/* -------------------------------------------------------------- workflow ---- */

async function toggleCompleted() {
  const quote = state.quote;
  if (!quote) return;
  const completed = quote.status === "completed";
  if (!completed) {
    if (!quote.has_scan) {
      toast("Scan the signed page first — a completed record must carry its paperwork.", "error");
      $("scanBtn").focus();
      return;
    }
    const okay = await confirmAction({
      title: `Mark ${quote.quote_number} completed?`,
      message: "The record keeps the signed page and its numbers are frozen.",
      confirm: "Mark completed",
      danger: false,
    });
    if (!okay) return;
  }
  try {
    const data = await api(`/api/quotations/${encodeURIComponent(state.id)}/status`, {
      method: "PATCH",
      body: { status: completed ? "issued" : "completed" },
    });
    paint(data.quotation);
    toast(completed ? "Record reopened for changes." : "Record completed. The stamp is on the paperwork.");
  } catch (error) {
    toast(message(error), "error");
  }
}

/* ------------------------------------------------------------------ bind --- */

$("recordForm").addEventListener("submit", save);
$("saveBtn").addEventListener("click", save);
$("printBtn").addEventListener("click", printSheet);
$("cancelBtn").addEventListener("click", cancelRecord);
$("reprintBtn").addEventListener("click", refreshPreview);
$("scanBtn").addEventListener("click", scanPage);
$("uploadPhotoBtn").addEventListener("click", () => pickFile("photoInput"));
$("uploadPdfBtn").addEventListener("click", () => pickFile("pdfInput"));
$("photoInput").addEventListener("change", (event) => {
  const file = event.target.files && event.target.files[0];
  if (file) uploadPhoto(file, $("uploadPhotoBtn"));
});
$("pdfInput").addEventListener("change", (event) => {
  const file = event.target.files && event.target.files[0];
  if (file) uploadPdf(file, $("uploadPdfBtn"));
});
$("removeScanBtn").addEventListener("click", removeScan);
$("completeBtn").addEventListener("click", toggleCompleted);
$("sendBtn").addEventListener("click", sendOnWhatsApp);
$("shareBtn").addEventListener("click", shareLinkButton);
$("downloadBtn").addEventListener("click", downloadScan);
$("sendMode").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-mode]");
  if (button) setSendMode(button.dataset.mode);
});
window.addEventListener("resize", fitPreview);
$("preview").addEventListener("load", fitPreview);

fitPreview();
load();

export {};
