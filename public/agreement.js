/* Agreement record page — the signed paper first, then the figures and the terms.
   Everything the desk can do to an issued agreement lives here: file the signed copy,
   hand it over on WhatsApp or as a link, correct the details, close it, cancel it. */

import { confirmAction } from "./dialog.js";
import { openScanner, processPhotoFile } from "./scan.js";
import { loadAppVersion } from "./version.js";

/** @param {string} id @returns {any} */
const $ = (id) => document.getElementById(id);
const A4_W = 793.7;   // 210mm at 96dpi
const A4_H = 1122.5;  // 297mm at 96dpi

const state = {
  id: new URLSearchParams(location.search).get("id"),
  agreement: null,
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

/** Server codes this page can meet, said in the desk's own words. */
const message = (error) => {
  const map = {
    agreement_not_found: "This agreement no longer exists.",
    agreement_fields_required: "Fill the required fields before saving.",
    invalid_agreement_date: "Enter a valid agreement date.",
    invalid_full_amount: "Enter the agreed price between 0 and 99,999,999.99.",
    invalid_paid_amount: "Enter the amount paid between 0 and 99,999,999.99.",
    paid_amount_exceeds_full: "The amount paid cannot be larger than the agreed price.",
    agreement_completed: "This agreement is completed. Reopen it before changing anything.",
    no_fields_to_update: "Nothing changed, so nothing was saved.",
    invalid_status: "That status is not one the desk knows.",
    scan_required: "File the signed page before completing the agreement.",
    scan_not_found: "The signed page is no longer on file.",
    scan_file_required: "The upload came back empty. Try again.",
    scan_too_large: "That signed copy is too large. A picture must be under 4 MB, a PDF under 12 MB.",
    unsupported_scan_type: "That file is not a JPEG, PNG, WebP picture or a PDF.",
    storage_unavailable: "File storage is not configured on this deployment.",
    share_link_unavailable: "The link could not be created.",
    agreement_not_deleted: "That agreement is not cancelled.",
    agreement_must_be_deleted_first: "Cancel the agreement before deleting it permanently.",
    agreement_confirmation_required: "Type the agreement number to confirm.",
  };
  return map[error?.message] || error?.message || "The action could not be completed.";
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
  $("preview").src = `/api/agreements/${encodeURIComponent(state.id)}/print?sheet=${state.previewCount}`;
}

function printSheet() {
  if (!state.id) return;
  window.open(`/api/agreements/${encodeURIComponent(state.id)}/print?print=1`, "_blank", "noopener");
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

/** "PDF", "JPEG", "PNG" — what the file actually is, in the desk's capitals. */
const kindLabel = (contentType) => {
  const type = String(contentType || "").toLowerCase();
  if (type === "application/pdf") return "PDF";
  return type.replace("image/", "").toUpperCase() || "—";
};

const money = (agreement, value) => `${agreement.currency || "AED"} ${value}`;

/** The header band: kind, number, meta strip, status chip and the two workflow buttons. */
function paintShell(agreement) {
  document.title = `${agreement.agreement_number} · Challenger Agreement`;
  $("recordKind").textContent = `${agreement.kind_label || "Agreement"} record`;
  $("recordNumber").textContent = agreement.agreement_number;
  $("topbarRecordNumber").textContent = agreement.agreement_number;
  $("metaDate").textContent = agreement.agreement_date_text || agreement.agreement_date;
  $("metaVehicle").textContent = [agreement.vehicle_model, agreement.vehicle_year].filter(Boolean).join(" · ") || "—";
  $("metaChassis").textContent = agreement.vehicle_chassis || "—";
  $("metaParties").textContent = `${agreement.seller_name} → ${agreement.buyer_name}`;
  $("metaAgreed").textContent = money(agreement, agreement.full_amount);
  $("metaBalance").textContent = money(agreement, agreement.balance);
  $("companyChip").textContent = agreement.company?.name || "company";

  const completed = agreement.status === "completed";
  const chip = $("statusChip");
  chip.textContent = completed ? "completed" : agreement.has_scan ? "signed" : "issued";
  chip.className = `chip ${completed || agreement.has_scan ? "ok" : "off"}`;

  $("completeBtn").textContent = completed ? "Reopen record" : "Mark completed";
  $("completeBtn").className = completed ? "btn ghost small" : "btn primary small";
  $("cancelBtn").disabled = completed;
  $("cancelBtn").title = completed ? "A completed agreement is filed: reopen it before cancelling." : "";
}

/** The signed-copy card: picture, measurements, send controls, completion stamp. */
function paintSigned(agreement) {
  const scan = agreement.scan || null;
  const completed = agreement.status === "completed";
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

  /* a PDF has no picture to show, so the frame becomes the file it is */
  const doc = $("signedDoc");
  doc.hidden = !pdf;
  if (pdf) {
    doc.href = scan.url;
    $("signedDocName").textContent = `${agreement.agreement_number}-signed.pdf`;
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

  $("shareBtn").textContent = agreement.share_path ? "Rotate link" : "Create link";
  $("revokeLinkBtn").hidden = !agreement.share_path;
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
  const hasLink = Boolean(state.agreement?.share_path);
  if (wanted === "link") {
    $("sendLabel").textContent = hasLink ? "Send the link on WhatsApp" : "Create a link and send";
    $("signedHint").textContent = "The customer gets a private page with the terms and the signed sheet. Rotate the link if it ever leaks.";
  } else {
    $("sendLabel").textContent = "Send the signed file on WhatsApp";
    $("signedHint").textContent = "WhatsApp opens with the page already attached and you choose the chat. On a computer the picture downloads instead, ready to attach.";
  }
}

/** Amounts live in minor units; the form speaks decimal strings. */
const decimal = (cents) => (Number(cents || 0) / 100).toFixed(2);

function paintForm(agreement) {
  $("fNumber").value = agreement.agreement_number;
  $("fDate").value = agreement.agreement_date;
  $("fModel").value = agreement.vehicle_model || "";
  $("fYear").value = agreement.vehicle_year || "";
  $("fChassis").value = agreement.vehicle_chassis || "";
  $("fPlate").value = agreement.vehicle_plate || "";
  $("fColor").value = agreement.vehicle_color || "";
  $("fOdometer").value = agreement.vehicle_odometer || "";
  $("fRegistration").value = agreement.vehicle_registration_place || "";
  $("fSellerName").value = agreement.seller_name || "";
  $("fSellerId").value = agreement.seller_id_number || "";
  $("fSellerPhone").value = agreement.seller_phone || "";
  $("fSellerAddress").value = agreement.seller_address || "";
  $("fBuyerName").value = agreement.buyer_name || "";
  $("fBuyerId").value = agreement.buyer_id_number || "";
  $("fBuyerPhone").value = agreement.buyer_phone || "";
  $("fBuyerAddress").value = agreement.buyer_address || "";
  $("fIntermediaryName").value = agreement.intermediary_name || "";
  $("fIntermediaryId").value = agreement.intermediary_id_number || "";
  $("fIntermediaryPhone").value = agreement.intermediary_phone || "";
  $("fIntermediaryAddress").value = agreement.intermediary_address || "";
  $("fCurrency").textContent = agreement.currency || "AED";
  $("fFull").value = decimal(agreement.full_amount_cents);
  $("fPaid").value = decimal(agreement.paid_amount_cents);
  $("fFullWords").value = agreement.full_amount_words || "";
  $("fPaidWords").value = agreement.paid_amount_words || "";
  $("fBalance").value = `${agreement.currency} ${agreement.balance}`;
  $("fNotes").value = agreement.notes || "";

  const completed = agreement.status === "completed";
  $("saveBtn").disabled = completed;
  for (const id of ["fDate", "fModel", "fYear", "fChassis", "fPlate", "fColor", "fOdometer",
    "fRegistration", "fSellerName", "fSellerId", "fSellerPhone", "fSellerAddress",
    "fBuyerName", "fBuyerId", "fBuyerPhone", "fBuyerAddress", "fIntermediaryName",
    "fIntermediaryId", "fIntermediaryPhone", "fIntermediaryAddress", "fFull", "fPaid", "fNotes"]) {
    $(id).readOnly = completed;
  }
  $("formNote").textContent = completed
    ? "This agreement is completed, so its terms are frozen. Reopen it in the header to make changes."
    : "The sheet is rendered from the template captured when this agreement was issued. Later template versions never change an existing agreement.";
}

function paint(agreement) {
  state.agreement = agreement;
  paintShell(agreement);
  paintSigned(agreement);
  paintForm(agreement);
  refreshPreview();
}

/* ------------------------------------------------------------------- load --- */

const ACTIVITY_LABELS = {
  "agreement.created": "Agreement issued",
  "agreement.updated": "Details corrected",
  "agreement.completed": "Marked completed",
  "agreement.reopened": "Reopened for changes",
  "agreement.cancelled": "Record cancelled",
  "agreement.restored": "Record restored",
  "agreement.permanently_deleted": "Deleted permanently",
  "agreement.scan_uploaded": "Signed page filed",
  "agreement.scan_removed": "Signed page removed",
  "agreement.share_link_created": "Link created",
  "agreement.share_link_rotated": "Link rotated",
  "agreement.share_link_revoked": "Link revoked",
};

async function load() {
  if (!state.id) { location.href = "/?view=agreements"; return; }
  try {
    const [record, settings] = await Promise.all([
      api(`/api/agreements/${encodeURIComponent(state.id)}`),
      api("/api/settings").catch(() => null),
    ]);
    state.settings = settings?.settings || null;
    /* the desk default is read on every load, so a change in Settings applies here
       without a stale browser preference getting in the way */
    state.sendMode = state.settings?.share_mode === "link" ? "link" : "file";
    paint(record.agreement);
    void loadActivity();
  } catch (error) {
    if (error.status === 401) { location.href = "/"; return; }
    /* a cancelled agreement is not readable: its ledger row is where it comes back from */
    if (error.status === 404) {
      toast("That agreement was cancelled. Restore it from the ledger.", "error");
      setTimeout(() => { location.href = "/?view=agreements"; }, 1600);
      return;
    }
    toast(message(error), "error");
    $("statusChip").textContent = "unavailable";
  }
}

/**
 * The audit trail is one desk-wide feed; the record shows the slice that names it.
 * The window is stated in the panel so an old record never looks eventless.
 */
async function loadActivity() {
  const body = $("activityBody");
  body.textContent = "";
  try {
    const data = await api("/api/audit?limit=200&offset=0");
    const events = (data.events || []).filter(
      (event) => event.entity === "agreement" && event.entity_id === state.id
    );
    for (const event of events.slice(0, 12)) {
      const row = document.createElement("tr");
      const when = document.createElement("td");
      when.className = "audit-time";
      when.textContent = stampDate(event.created_at);
      const who = document.createElement("td");
      who.textContent = event.actor || "desk";
      const what = document.createElement("td");
      what.textContent = ACTIVITY_LABELS[event.action] || event.action;
      row.append(when, who, what);
      body.appendChild(row);
    }
    $("activityEmpty").hidden = events.length > 0;
    $("activityChip").textContent = events.length ? `${Math.min(events.length, 12)} entries` : "none";
  } catch {
    $("activityEmpty").hidden = false;
    $("activityChip").textContent = "unavailable";
  }
}

/* ------------------------------------------------------------------- save --- */

/** Form id → API field, in the order the PATCH sends them. */
const TEXT_INPUTS = [
  ["fModel", "vehicle_model"],
  ["fYear", "vehicle_year"],
  ["fChassis", "vehicle_chassis"],
  ["fPlate", "vehicle_plate"],
  ["fColor", "vehicle_color"],
  ["fOdometer", "vehicle_odometer"],
  ["fRegistration", "vehicle_registration_place"],
  ["fSellerName", "seller_name"],
  ["fSellerId", "seller_id_number"],
  ["fSellerPhone", "seller_phone"],
  ["fSellerAddress", "seller_address"],
  ["fBuyerName", "buyer_name"],
  ["fBuyerId", "buyer_id_number"],
  ["fBuyerPhone", "buyer_phone"],
  ["fBuyerAddress", "buyer_address"],
  ["fIntermediaryName", "intermediary_name"],
  ["fIntermediaryId", "intermediary_id_number"],
  ["fIntermediaryPhone", "intermediary_phone"],
  ["fIntermediaryAddress", "intermediary_address"],
];

async function save(event) {
  event?.preventDefault();
  if (!state.agreement) return;
  const button = $("saveBtn");
  button.disabled = true;
  try {
    const payload = { agreement_date: $("fDate").value };
    for (const [id, field] of TEXT_INPUTS) payload[field] = $(id).value.trim();
    payload.full_amount = $("fFull").value.trim();
    payload.paid_amount = $("fPaid").value.trim();
    payload.notes = $("fNotes").value.trim();
    const data = await api(`/api/agreements/${encodeURIComponent(state.id)}`, {
      method: "PATCH",
      body: payload,
    });
    paint(data.agreement);
    toast("Agreement updated. The sheet was rebuilt.");
    void loadActivity();
  } catch (error) {
    toast(message(error), "error");
  } finally {
    button.disabled = state.agreement?.status === "completed";
  }
}

/* -------------------------------------------------------------- workflow ---- */

async function toggleCompleted() {
  const agreement = state.agreement;
  if (!agreement) return;
  const completed = agreement.status === "completed";
  if (!completed) {
    if (!agreement.has_scan) {
      toast("File the signed page first — a completed agreement must carry its paperwork.", "error");
      $("scanBtn").focus();
      return;
    }
    const okay = await confirmAction({
      title: `Mark ${agreement.agreement_number} completed?`,
      message: "The record keeps the signed page and its terms are frozen.",
      confirm: "Mark completed",
      danger: false,
    });
    if (!okay) return;
  }
  try {
    const data = await api(`/api/agreements/${encodeURIComponent(state.id)}/status`, {
      method: "PATCH",
      body: { status: completed ? "issued" : "completed" },
    });
    paint(data.agreement);
    toast(completed ? "Agreement reopened for changes." : "Agreement completed. The stamp is on the paperwork.");
    void loadActivity();
  } catch (error) {
    toast(message(error), "error");
  }
}

/** Cancelling keeps the row (and the signed page) recoverable from the deleted view. */
async function cancelRecord() {
  const agreement = state.agreement;
  if (!agreement) return;
  const okay = await confirmAction({
    title: `Cancel agreement ${agreement.agreement_number}?`,
    message: "It leaves the ledger and moves to Deleted, where it can still be restored.",
    confirm: "Cancel agreement",
  });
  if (!okay) return;
  try {
    await api(`/api/agreements/${encodeURIComponent(state.id)}`, { method: "DELETE" });
    location.href = "/?view=agreements";
  } catch (error) {
    toast(message(error), "error");
  }
}

/* ------------------------------------------------------------ signed copy --- */

/** The tail every signed-copy flow shares: post the bytes, repaint, say what next. */
async function storeSignedPage(form, note) {
  const data = await apiUpload(`/api/agreements/${encodeURIComponent(state.id)}/scan`, form);
  paint(data.agreement);
  toast(note);
  void loadActivity();
}

/** Runs one of the three ways in, with the busy flag held for its whole length. */
async function signedCopyAction(button, run) {
  if (state.busy || !state.agreement) return;
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
    const page = await openScanner({ title: "Scan the signed agreement" });
    if (!page) return;
    const form = new FormData();
    form.append("file", new File([page.blob], "signed-page.jpg", { type: "image/jpeg" }));
    form.append("width", String(page.width));
    form.append("height", String(page.height));
    form.append("source", "scan");
    await storeSignedPage(form, "Signed page filed. Send it on WhatsApp below.");
  });
}

/** A photo from the gallery: corrected, flattened and stored like a capture. */
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
    await storeSignedPage(form, "Photo corrected and filed as the signed page.");
  });
}

/** A PDF from a scanner app: stored byte for byte, never re-encoded. */
async function uploadPdf(file, button) {
  await signedCopyAction(button, async () => {
    const form = new FormData();
    form.append("file", file, file.name || "signed-page.pdf");
    form.append("source", "upload");
    await storeSignedPage(form, "PDF filed as the signed page.");
  });
}

/** The hidden inputs are reopened through a click, so the same file can be re-picked. */
function pickFile(inputId) {
  const input = $(inputId);
  input.value = "";
  input.click();
}

async function removeScan() {
  if (!state.agreement) return;
  const okay = await confirmAction({
    title: "Remove the signed page?",
    message: "The agreement keeps its terms; the stored file is deleted.",
    confirm: "Remove the signed page",
  });
  if (!okay) return;
  try {
    await api(`/api/agreements/${encodeURIComponent(state.id)}/scan`, { method: "DELETE" });
    const data = await api(`/api/agreements/${encodeURIComponent(state.id)}`);
    paint(data.agreement);
    toast("Signed page removed.");
    void loadActivity();
  } catch (error) {
    toast(message(error), "error");
  }
}

/* ---------------------------------------------------------- share & send --- */

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

/** Mints (or rotates) the public link and reflects it in the payload. */
async function createShareLink() {
  if (!state.agreement) return null;
  try {
    const data = await api(`/api/agreements/${encodeURIComponent(state.id)}/share-link`, { method: "POST" });
    state.agreement = {
      ...state.agreement,
      share_path: data.share_path,
      share_token_created_at: data.share_token_created_at,
    };
    paintSigned(state.agreement);
    void loadActivity();
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
  toast(copied ? "Link created and copied. Any previous link now fails." : "Link created.");
  if (!copied) window.prompt("Agreement link", url);
  if (state.sendMode !== "link") setSendMode("link");
}

async function revokeLink() {
  if (!state.agreement?.share_path) return;
  const okay = await confirmAction({
    title: "Revoke the customer link?",
    message: "The page stops opening immediately. The signed copy stays on the record.",
    confirm: "Revoke link",
  });
  if (!okay) return;
  try {
    await api(`/api/agreements/${encodeURIComponent(state.id)}/share-link`, { method: "DELETE" });
    state.agreement = { ...state.agreement, share_path: null, share_token_created_at: null };
    paintSigned(state.agreement);
    toast("Link revoked.");
    void loadActivity();
  } catch (error) {
    toast(message(error), "error");
  }
}

/** The stored file as a File, so it can go through the OS share sheet. */
async function scanAsFile() {
  const scan = state.agreement?.scan;
  if (!scan) return null;
  const response = await fetch(scan.download_url, { credentials: "same-origin" });
  if (!response.ok) throw new Error("scan_not_found");
  const blob = await response.blob();
  const type = blob.type || scan.content_type || "image/jpeg";
  const ext = type === "image/png" ? "png" : type === "image/webp" ? "webp" : type === "application/pdf" ? "pdf" : "jpg";
  return new File([blob], `${state.agreement.agreement_number}-signed.${ext}`, { type });
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

async function downloadScan() {
  try {
    const file = await scanAsFile();
    if (file) downloadBlob(file);
  } catch (error) {
    toast(message(error), "error");
  }
}

const caption = (agreement) =>
  `Agreement ${agreement.agreement_number} — ${agreement.vehicle_model} ${agreement.vehicle_year}, ` +
  `${agreement.currency || "AED"} ${agreement.full_amount}` +
  (Number(agreement.balance_cents) ? ` (balance ${agreement.currency || "AED"} ${agreement.balance})` : "");

async function sendOnWhatsApp() {
  const agreement = state.agreement;
  if (!agreement) return;
  const button = $("sendBtn");
  button.disabled = true;
  try {
    const text = caption(agreement);

    if (state.sendMode === "link") {
      const path = agreement.share_path || (await createShareLink());
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
    if (!file) { toast("File the signed page first.", "error"); return; }
    /* wa.me links carry text only, so the file goes through the OS share sheet when
       the device can, and through the download folder when it cannot. */
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], text });
      toast("Shared. Pick the chat in the sheet.");
      return;
    }
    downloadBlob(file);
    await copyText(text);
    openWhatsApp(text);
    toast("File saved to downloads and the caption copied — attach it in WhatsApp.");
  } catch (error) {
    /* closing the OS share sheet is not a failure */
    if (error?.name === "AbortError") return;
    toast(message(error), "error");
  } finally {
    button.disabled = !state.agreement?.scan;
  }
}

function setSendMode(mode) {
  state.sendMode = mode === "link" ? "link" : "file";
  paintSendMode();
}

/* ------------------------------------------------------------------ bind --- */

$("recordForm").addEventListener("submit", save);
$("printBtn").addEventListener("click", printSheet);
$("refreshBtn").addEventListener("click", refreshPreview);
$("cancelBtn").addEventListener("click", cancelRecord);
$("completeBtn").addEventListener("click", toggleCompleted);
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
$("sendBtn").addEventListener("click", sendOnWhatsApp);
$("shareBtn").addEventListener("click", shareLinkButton);
$("revokeLinkBtn").addEventListener("click", revokeLink);
$("downloadBtn").addEventListener("click", downloadScan);
$("sendMode").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-mode]");
  if (button) setSendMode(button.dataset.mode);
});
window.addEventListener("resize", fitPreview);
$("preview").addEventListener("load", fitPreview);

/* The big number scrolls away, so the bar takes it over: the record keeps its name
   at any scroll depth. The -70px margin accounts for the bar's own height. */
const recordNumber = $("recordNumber");
if (recordNumber && "IntersectionObserver" in window) {
  new IntersectionObserver(([entry]) => {
    $("topbarRecord").hidden = entry.isIntersecting;
  }, { rootMargin: "-70px 0px 0px 0px" }).observe(recordNumber);
} else {
  $("topbarRecord").hidden = false;
}

fitPreview();
loadAppVersion();
load();

/** Exported so the module stays an ES module and the bindings above run once. */
export {};
