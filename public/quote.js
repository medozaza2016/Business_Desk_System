/* Quotation record page — edit details, live A4 sheet preview, print. */

/** @param {string} id @returns {any} */
const $ = (id) => document.getElementById(id);
const A4_W = 793.7;   // 210mm at 96dpi
const A4_H = 1122.5;  // 297mm at 96dpi

const state = { id: null, quote: null, previewCount: 0 };
state.id = new URLSearchParams(location.search).get("id");

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

let toastTimer = null;
function toast(message, kind = "ok") {
  const node = $("toast");
  node.textContent = message;
  node.className = `toast show${kind === "error" ? " error" : ""}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.className = "toast"; }, 3200);
}

const message = (error) => {
  const map = {
    quotation_not_found: "This quotation no longer exists.",
    quotation_number_already_exists: "That quotation number is already used.",
    invalid_amount: "Enter a value between 0 and 99,999,999.99.",
    invalid_quote_date: "Enter a valid date.",
  };
  return map[error?.message] || error?.message || "Something went wrong.";
};

function fitPreview() {
  const stage = $("previewStage");
  const frame = $("previewFrame");
  const iframe = $("preview");
  const available = stage.clientWidth - 32;
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

function paint(quote) {
  state.quote = quote;
  document.title = `${quote.quote_number} · Challenger Quotation`;
  $("recordNumber").textContent = quote.quote_number;
  $("metaDate").textContent = quote.quote_date_text || quote.quote_date;
  $("metaVehicle").textContent = `${quote.model} · ${quote.year}`;
  $("metaChassis").textContent = quote.chassis;
  $("metaValue").textContent = `${quote.currency || "AED"} ${quote.amount}`;
  $("companyChip").textContent = quote.company?.name || "company";
  $("statusChip").textContent = "issued";

  $("fNumber").value = quote.quote_number;
  $("fDate").value = quote.quote_date;
  $("fModel").value = quote.model;
  $("fYear").value = quote.year;
  $("fChassis").value = quote.chassis;
  $("fCurrency").textContent = quote.currency || "AED";
  $("fAmount").value = quote.amount;
  $("fWords").value = quote.amount_words || "";

  const sheet = `/api/quotations/${encodeURIComponent(quote.id)}/print`;
  $("previewTab").href = sheet;
  refreshPreview();
}

async function load() {
  if (!state.id) { location.href = "/"; return; }
  try {
    const data = await api(`/api/quotations/${encodeURIComponent(state.id)}`);
    paint(data.quotation);
  } catch (error) {
    if (error.status === 401) { location.href = "/"; return; }
    toast(message(error), "error");
    $("statusChip").textContent = "unavailable";
  }
}

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
        amount: $("fAmount").value.trim(),
      },
    });
    paint(data.quotation);
    toast("Record updated. The sheet was rebuilt.");
  } catch (error) {
    toast(message(error), "error");
  } finally {
    button.disabled = false;
  }
}

function printSheet() {
  if (!state.id) return;
  window.open(`/api/quotations/${encodeURIComponent(state.id)}/print?print=1`, "_blank", "noopener");
}

async function cancelRecord() {
  if (!state.quote) return;
  if (!confirm(`Cancel quotation ${state.quote.quote_number}? It leaves the desk records.`)) return;
  try {
    await api(`/api/quotations/${encodeURIComponent(state.id)}`, { method: "DELETE" });
    location.href = "/";
  } catch (error) {
    toast(message(error), "error");
  }
}

$("recordForm").addEventListener("submit", save);
$("saveBtn").addEventListener("click", save);
$("printBtn").addEventListener("click", printSheet);
$("cancelBtn").addEventListener("click", cancelRecord);
$("reprintBtn").addEventListener("click", refreshPreview);
window.addEventListener("resize", fitPreview);
$("preview").addEventListener("load", fitPreview);

fitPreview();
load();

export {};
