/* Challenger Quotation Desk — client
   No framework, no build step. Views: gate → workspace → settings. */

import { confirmAction } from "./dialog.js";

/** @param {string} id @returns {any} */
const $ = (id) => document.getElementById(id);

const state = {
  status: null,
  companies: [],
  companyId: null,
  quotes: [],
  search: "",
  /** "number" (newest serial first) or "date"; the Worker orders the rows */
  sort: "number",
  templates: [],
  templateEditId: null,
  settings: null,
  settingsOpen: false,
  settingsPane: "company",
};

const storage = {
  get(key) {
    try { return localStorage.getItem(key); } catch { return null; }
  },
  set(key, value) {
    try { localStorage.setItem(key, value); } catch { /* private mode */ }
  },
};

const todayLocal = () => {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
};

const escapeText = (value) => String(value ?? "");

const humanError = (error) => {
  const map = {
    invalid_passcode: "That passcode is not correct.",
    passcode_required: "Enter the passcode.",
    passcode_too_short: "Passcodes need at least 6 characters.",
    invalid_current_passcode: "The current passcode is not correct.",
    too_many_attempts: "Too many attempts. Wait ten minutes and try again.",
    already_configured: "This desk is already configured. Reload and sign in.",
    unauthorized: "Your session expired. Sign in again.",
    company_name_required: "Enter a company name with at least two characters.",
    company_slug_already_exists: "A company with that name already exists.",
    quotation_number_already_exists: "That quotation number is already used.",
    model_year_and_chassis_required: "Model, year and chassis are required.",
    invalid_amount: "Enter a value between 0 and 99,999,999.99.",
    invalid_quote_date: "Enter a valid date.",
    numbering_exhausted: "Could not allocate a number. Try again.",
    template_html_required: "The template cannot be empty.",
    template_too_large: "Template is larger than 200,000 characters.",
    template_not_found: "That template version no longer exists.",
    template_is_active: "The live version cannot be deleted. Activate another version first.",
    company_not_found: "That company no longer exists.",
    invalid_body: "The request could not be read.",
    logo_file_required: "Choose an image file first.",
    unsupported_image_type: "Use a PNG, JPEG or WebP image.",
    logo_too_large: "That image is larger than 512 KB. Resize it and try again.",
    logo_not_found: "This company has no logo yet.",
    storage_unavailable: "Storage is not configured on this deployment.",
    quotation_completed: "This record is completed. Reopen it on the record page.",
    scan_required: "Scan the signed page on the record before completing it.",
    invalid_share_mode: "Pick one of the two hand-off options.",
    no_fields_to_update: "Nothing to save.",
  };
  return map[error?.message] || error?.message || "Something went wrong.";
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

/** Same contract as api(), for multipart uploads (the browser sets the boundary). */
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

/* ------------------------------------------------------------------ toast --- */

let toastTimer = null;
function toast(message, kind = "ok") {
  const node = $("toast");
  node.textContent = message;
  node.className = `toast show${kind === "error" ? " error" : ""}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.className = "toast"; }, 3600);
}

/* ------------------------------------------------------------------- gate --- */

function showGate() {
  $("topbar").hidden = true;
  $("workspaceView").hidden = true;
  $("settingsView").hidden = true;
  $("gate").hidden = false;
  $("gatePasscode").focus();
}

function renderGate(status) {
  const setupMode = !status.setup;
  state.status = status;
  $("gateEyebrow").textContent = setupMode ? "First run" : "Challenger quotation desk";
  $("gateTitle").textContent = setupMode ? "Set the desk passcode" : "Enter the passcode";
  $("gateLede").textContent = setupMode
    ? "Choose the passcode your team will share. It is hashed before it touches the database and can be rotated later."
    : "One shared passcode unlocks the desk for the whole team.";
  $("gateSubmit").textContent = setupMode ? "Create passcode & open desk" : "Unlock desk";
  $("gateFoot").textContent = setupMode
    ? "A starter company (Challenger Cars) and the bilingual A4 template are created with the passcode."
    : `Sessions last ${status.session_hours || 12} hours. Rotate the passcode any time in Settings.`;
  showGate();
}

function gateError(message) {
  const node = $("gateError");
  node.textContent = message;
  node.hidden = !message;
}

async function submitGate(event) {
  event.preventDefault();
  gateError("");
  const passcode = $("gatePasscode").value;
  if (!passcode) { gateError("Enter the passcode."); return; }
  const setupMode = !state.status?.setup;
  const button = $("gateSubmit");
  button.disabled = true;
  button.textContent = setupMode ? "Creating…" : "Unlocking…";
  try {
    /* no name is collected at the gate: desk sessions are audited as "Shared user" */
    await api(setupMode ? "/api/setup" : "/api/auth/login", { method: "POST", body: { passcode } });
    $("gatePasscode").value = "";
    await boot();
    if (setupMode) toast("Desk created. Add company details in Settings.");
  } catch (error) {
    gateError(humanError(error));
  } finally {
    button.disabled = false;
    button.textContent = setupMode ? "Create passcode & open desk" : "Unlock desk";
  }
}

/* ------------------------------------------------------------- companies --- */

const activeCompany = () => state.companies.find((c) => c.id === state.companyId) || null;

function paintCompanyChrome() {
  const company = activeCompany();
  $("prefixTag").textContent = company?.quotation_prefix || "QA-";
  $("currencyTag").textContent = company?.currency || "AED";
  if (company) $("ledgerTitle").textContent = company.name;
  const csv = company ? `/api/export/quotations.csv?company_id=${encodeURIComponent(company.id)}` : "#";
  $("csvLink").href = csv;
  $("csvLink2").href = csv;
}

async function loadCompanies() {
  const data = await api("/api/companies");
  state.companies = data.companies || [];
  if (!state.companies.length) {
    state.companyId = null;
    return;
  }
  const stored = storage.get("q_company");
  const preferred = state.companies.find((c) => c.id === stored && c.active)
    || state.companies.find((c) => c.active)
    || state.companies[0];
  state.companyId = preferred.id;
  renderCompanySelect();
  paintCompanyChrome();
  paintCompanySettings();
}

function renderCompanySelect() {
  const select = $("companySelect");
  select.textContent = "";
  for (const company of state.companies) {
    const option = document.createElement("option");
    option.value = company.id;
    option.textContent = company.active ? company.name : `${company.name} (inactive)`;
    select.appendChild(option);
  }
  select.value = state.companyId || "";
}

function switchCompany(id) {
  state.companyId = id;
  storage.set("q_company", id);
  /* every version, editor buffer and preview belongs to the old company */
  state.templates = [];
  state.templateEditId = null;
  renderCompanySelect();
  paintCompanyChrome();
  paintCompanySettings();
  refreshNextNumber();
  loadQuotes();
  if (state.settingsOpen) void refreshStudio();
}

/* -------------------------------------------------------------- numbering --- */

async function refreshNextNumber() {
  const company = activeCompany();
  if (!company) { $("numberHint").textContent = "auto"; return; }
  const date = $("quoteDate").value || todayLocal();
  try {
    const data = await api(`/api/quotations/next-number?company_id=${encodeURIComponent(company.id)}&date=${encodeURIComponent(date)}`);
    const serial = data.quote_number.replace(company.quotation_prefix || "QA-", "");
    $("quoteNumber").placeholder = serial;
    $("numberHint").textContent = `auto · ${data.quote_number}`;
  } catch {
    $("numberHint").textContent = "auto";
  }
}

/* ---------------------------------------------------------------- ledger --- */

/* `label` becomes the caption shown above the value once rows render as cards on phones. */
function rowCell(text, className, label) {
  const cell = document.createElement("td");
  if (className) cell.className = className;
  if (label) cell.dataset.label = label;
  cell.textContent = escapeText(text);
  return cell;
}

function renderQuotes() {
  const body = $("quotesBody");
  body.textContent = "";
  const company = activeCompany();
  const total = state.quotes.length;
  const suffix = state.search ? ` matching “${state.search}”` : "";
  const order = state.sort === "date" ? "newest date first" : "highest number first";
  $("ledgerMeta").textContent = company
    ? `${total} record${total === 1 ? "" : "s"}${suffix} · ${order} · prefix ${company.quotation_prefix || "QA-"} · currency ${company.currency || "AED"}`
    : "No company configured yet.";
  $("emptyState").hidden = total > 0;
  paintSort();

  for (const quote of state.quotes) {
    const row = document.createElement("tr");

    const numberCell = document.createElement("td");
    numberCell.className = "num";
    const numberWrap = document.createElement("div");
    numberWrap.className = "num-stack";
    const link = document.createElement("a");
    link.href = `/quote?id=${encodeURIComponent(quote.id)}`;
    link.textContent = quote.quote_number;
    const mark = document.createElement("span");
    /* three states, one glance: filed, signed and waiting for the signature */
    mark.className = `chip ${quote.status === "completed" || quote.has_scan ? "ok" : "off"}`;
    mark.textContent = quote.status === "completed" ? "completed" : quote.has_scan ? "signed" : "unsigned";
    numberWrap.append(link, mark);
    numberCell.appendChild(numberWrap);
    row.appendChild(numberCell);

    row.appendChild(rowCell(quote.quote_date_text || quote.quote_date, "date", "Date"));

    const vehicle = document.createElement("td");
    vehicle.className = "vehicle";
    const model = document.createElement("b");
    model.textContent = `${quote.model} ${quote.year}`;
    const chassis = document.createElement("span");
    chassis.textContent = quote.chassis;
    vehicle.append(model, chassis);
    row.appendChild(vehicle);

    row.appendChild(rowCell(`${company?.currency || "AED"} ${quote.amount}`, "money", "Estimated value"));

    const actions = document.createElement("td");
    actions.className = "row-actions";
    const open = document.createElement("a");
    open.href = `/quote?id=${encodeURIComponent(quote.id)}`;
    open.textContent = "Open";
    const separator = document.createElement("span");
    separator.className = "sep";
    separator.textContent = "/";
    const print = document.createElement("a");
    print.href = `/api/quotations/${encodeURIComponent(quote.id)}/print?print=1`;
    print.target = "_blank";
    print.rel = "noopener";
    print.textContent = "Print";
    const separator2 = separator.cloneNode(true);
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.textContent = quote.status === "completed" ? "Reopen" : "Complete";
    toggle.addEventListener("click", () => toggleQuoteStatus(quote));
    const separator3 = separator.cloneNode(true);
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "Cancel";
    remove.addEventListener("click", () => cancelQuote(quote));
    actions.append(open, separator, print, separator2, toggle, separator3, remove);
    row.appendChild(actions);

    body.appendChild(row);
  }
}

/** The ledger order switch: the number is the paper's own sort key. */
function paintSort() {
  for (const button of $("ledgerSort").querySelectorAll("button")) {
    button.setAttribute("aria-pressed", button.dataset.sort === state.sort ? "true" : "false");
  }
}

async function loadQuotes() {
  if (!state.companyId) { state.quotes = []; renderQuotes(); return; }
  const query = new URLSearchParams({ company_id: state.companyId, limit: "100", sort: state.sort });
  if (state.search) query.set("q", state.search);
  try {
    const data = await api(`/api/quotations?${query.toString()}`);
    state.quotes = data.quotations || [];
    renderQuotes();
  } catch (error) {
    if (error.status === 401) return signOut("Your session expired.");
    toast(humanError(error), "error");
  }
}

/** Complete or reopen straight from the ledger; completing needs the signed page. */
async function toggleQuoteStatus(quote) {
  const completed = quote.status === "completed";
  if (!completed && !quote.has_scan) {
    /* the scan lives on the record page, so that is where this has to happen */
    toast("Scan the signed page on the record first.", "error");
    location.href = `/quote?id=${encodeURIComponent(quote.id)}`;
    return;
  }
  const okay = await confirmAction({
    title: completed ? `Reopen ${quote.quote_number}?` : `Mark ${quote.quote_number} completed?`,
    message: completed
      ? "The record becomes editable again."
      : "The record keeps its signed page and its numbers are frozen.",
    confirm: completed ? "Reopen" : "Mark completed",
    cancel: "Keep",
    danger: false,
  });
  if (!okay) return;
  try {
    await api(`/api/quotations/${encodeURIComponent(quote.id)}/status`, {
      method: "PATCH",
      body: { status: completed ? "issued" : "completed" },
    });
    toast(completed ? `${quote.quote_number} reopened` : `${quote.quote_number} completed`);
    await loadQuotes();
  } catch (error) {
    toast(humanError(error), "error");
  }
}

async function cancelQuote(quote) {
  const okay = await confirmAction({
    title: `Cancel quotation ${quote.quote_number}?`,
    message: "It will be removed from the desk.",
    confirm: "Cancel quotation",
  });
  if (!okay) return;
  try {
    await api(`/api/quotations/${encodeURIComponent(quote.id)}`, { method: "DELETE" });
    toast(`Cancelled ${quote.quote_number}`);
    await loadQuotes();
  } catch (error) {
    toast(humanError(error), "error");
  }
}

async function submitQuote(event) {
  event.preventDefault();
  const company = activeCompany();
  if (!company) { toast("Add a company first in Settings.", "error"); return; }
  const serial = $("quoteNumber").value.trim();
  const payload = {
    company_id: company.id,
    quote_date: $("quoteDate").value || todayLocal(),
    model: $("model").value.trim(),
    year: $("year").value.trim(),
    chassis: $("chassis").value.trim(),
    comments: $("comments").value.trim(),
    amount: $("amount").value.trim(),
  };
  if (serial) payload.quote_number = (company.quotation_prefix || "QA-") + serial;
  if (!payload.model || !payload.year || !payload.chassis || !payload.amount) {
    toast("Model, year, chassis and value are required.", "error");
    return;
  }
  const button = event.target.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    const data = await api("/api/quotations", { method: "POST", body: payload });
    toast(`Saved ${data.quotation.quote_number}`);
    for (const id of ["quoteNumber", "model", "year", "chassis", "comments", "amount"]) $(id).value = "";
    $("model").focus();
    await refreshNextNumber();
    await loadQuotes();
  } catch (error) {
    toast(humanError(error), "error");
  } finally {
    button.disabled = false;
  }
}

/* --------------------------------------------------------------- settings --- */

const plural = (count, one, many) => `${count} ${count === 1 ? one : many}`;

/** The passcode is one global row, so this pane never depends on the active company. */
function paintPasscodeChrome() {
  const hours = state.status?.session_hours || 12;
  $("passcodeChip").textContent = `${hours}h session`;
  const stamp = state.status?.passcode_updated_at;
  const rotated = stamp ? `Last rotated ${String(stamp).replace("T", " ").slice(0, 16)} UTC.` : "Not rotated since setup.";
  $("passcodeNote").textContent = `Rotating ends every other session on every device immediately; this tab stays signed in. ${rotated}`;
}

function paintCompanySettings() {
  const company = activeCompany();
  $("navCompanySummary").textContent = plural(state.companies.length, "company", "companies");
  $("companyStateChip").textContent = company ? (company.active ? "active" : "inactive") : "no company";
  $("companyStateChip2").textContent = company ? `active: ${company.name}` : "no companies";
  paintPasscodeChrome();
  $("cName").value = company?.name || "";
  $("cLegal").value = company?.legal_name || "";
  $("cLegalAr").value = company?.legal_name_ar || "";
  $("cPhone").value = company?.phone || "";
  $("cEmail").value = company?.email || "";
  $("cAddress").value = company?.address || "";
  $("cPrefix").value = company?.quotation_prefix || "QA-";
  $("cCurrency").value = company?.currency || "AED";
  $("deactivateBtn").disabled = !company || !company.active;
  paintLogoBlock();
  renderCompanyList();
}

/** The logo pane follows the active company: one upload serves the mark and the watermark. */
function paintLogoBlock() {
  const company = activeCompany();
  const url = company?.logo_url || "";
  const image = $("logoImage");
  if (url) {
    image.src = url;
    image.hidden = false;
  } else {
    image.removeAttribute("src");
    image.hidden = true;
  }
  $("logoEmpty").hidden = Boolean(url);
  $("logoPick").disabled = !company;
  $("logoRemove").disabled = !company || !url;
  $("logoStatus").textContent = !company
    ? "Select a company to attach a logo."
    : url
      ? "On file — prints as the header mark and repeats as a faint watermark."
      : "No logo yet — the template keeps its built-in artwork.";
}

/** Applies a company row returned by the API to the current view. */
function replaceCompany(company) {
  const index = state.companies.findIndex((c) => c.id === company.id);
  if (index >= 0) state.companies[index] = company;
  paintCompanyChrome();
  paintCompanySettings();
  renderCompanySelect();
}

async function uploadLogo(file) {
  const company = activeCompany();
  if (!company || !file) return;
  if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
    toast("Use a PNG, JPEG or WebP image.", "error");
    return;
  }
  if (file.size > 512 * 1024) {
    toast("That image is larger than 512 KB. Resize it and try again.", "error");
    return;
  }
  const form = new FormData();
  form.append("file", file);
  $("logoPick").disabled = true;
  let warning = "";
  try {
    const data = await apiUpload(`/api/companies/${encodeURIComponent(company.id)}/logo`, form);
    replaceCompany(data.company);
    if (data.template_uses_logo) {
      toast("Logo saved. New quotations print it immediately.");
    } else {
      /* the file is stored, but the live sheet has no slot for it yet */
      warning = "On file, but the live template never asks for {{logo_url}} — add it under Print template.";
      toast("Logo saved, but the live template has no {{logo_url}} slot — see Print template.", "error");
    }
  } catch (error) {
    toast(humanError(error), "error");
  } finally {
    $("logoFile").value = "";
    paintLogoBlock();
    if (warning) $("logoStatus").textContent = warning;
  }
}

async function removeLogo() {
  const company = activeCompany();
  if (!company || !company.logo_url) return;
  const okay = await confirmAction({
    title: `Remove the logo for ${company.name}?`,
    message: "Already issued quotations keep their sheet content.",
    confirm: "Remove logo",
  });
  if (!okay) return;
  try {
    const data = await api(`/api/companies/${encodeURIComponent(company.id)}/logo`, { method: "DELETE" });
    replaceCompany(data.company);
    toast("Logo removed.");
  } catch (error) {
    toast(humanError(error), "error");
  }
}

function renderCompanyList() {
  const list = $("companyList");
  list.textContent = "";
  for (const company of state.companies) {
    const item = document.createElement("li");
    const name = document.createElement("span");
    name.textContent = company.name;
    if (company.id === state.companyId) name.style.fontWeight = "700";
    const right = document.createElement("span");
    const chip = document.createElement("span");
    chip.className = `chip ${company.active ? "ok" : "off"}`;
    chip.textContent = company.active ? "active" : "inactive";
    right.appendChild(chip);
    if (company.id !== state.companyId) {
      const use = document.createElement("button");
      use.type = "button";
      use.className = "btn ghost small";
      use.style.marginLeft = "8px";
      use.textContent = "Use";
      use.addEventListener("click", () => { switchCompany(company.id); toast(`Switched to ${company.name}`); });
      right.appendChild(use);
    }
    item.append(name, right);
    list.appendChild(item);
  }
  if (!state.companies.length) {
    const item = document.createElement("li");
    item.textContent = "No companies yet.";
    list.appendChild(item);
  }
}

async function saveCompany(event) {
  event.preventDefault();
  const company = activeCompany();
  if (!company) { toast("No company selected.", "error"); return; }
  try {
    const data = await api(`/api/companies/${encodeURIComponent(company.id)}`, {
      method: "PATCH",
      body: {
        name: $("cName").value.trim(),
        legal_name: $("cLegal").value.trim(),
        legal_name_ar: $("cLegalAr").value.trim(),
        phone: $("cPhone").value.trim(),
        email: $("cEmail").value.trim(),
        address: $("cAddress").value.trim(),
        quotation_prefix: $("cPrefix").value.trim(),
        currency: $("cCurrency").value.trim(),
      },
    });
    replaceCompany(data.company);
    toast("Company details saved.");
  } catch (error) {
    toast(humanError(error), "error");
  }
}

async function deactivateCompany() {
  const company = activeCompany();
  if (!company) return;
  const okay = await confirmAction({
    title: `Deactivate ${company.name}?`,
    message: "Existing quotations stay readable.",
    confirm: "Deactivate",
    cancel: "Keep active",
  });
  if (!okay) return;
  try {
    await api(`/api/companies/${encodeURIComponent(company.id)}`, { method: "DELETE" });
    toast(`${company.name} deactivated.`);
    await loadCompanies();
    await loadQuotes();
    paintCompanySettings();
  } catch (error) {
    toast(humanError(error), "error");
  }
}

async function createCompany(event) {
  event.preventDefault();
  const name = $("newCompanyName").value.trim();
  if (name.length < 2) { toast("Company names need at least two characters.", "error"); return; }
  try {
    const data = await api("/api/companies", {
      method: "POST",
      body: { name, quotation_prefix: $("newCompanyPrefix").value.trim() || "QA-" },
    });
    $("newCompanyName").value = "";
    $("newCompanyPrefix").value = "";
    await loadCompanies();
    switchCompany(data.company.id);
    toast(`${data.company.name} added with the default A4 template.`);
  } catch (error) {
    toast(humanError(error), "error");
  }
}

/* ---- hand-off setting ---- */

/** The desk-wide default for the WhatsApp step on the record page. */
async function loadSettings() {
  try {
    const data = await api("/api/settings");
    state.settings = data.settings || null;
  } catch {
    state.settings = null;
  }
  paintShareSettings();
}

function paintShareSettings() {
  const mode = state.settings?.share_mode === "link" ? "link" : "file";
  for (const input of $("shareModeForm").querySelectorAll("input[name=share_mode]")) {
    input.checked = input.value === mode;
  }
  $("shareChip").textContent = mode === "link" ? "link" : "signed file";
  $("navShareSummary").textContent = mode === "link" ? "private link" : "signed file";
}

async function saveShareMode(input) {
  try {
    const data = await api("/api/settings", { method: "PATCH", body: { share_mode: input.value } });
    state.settings = data.settings || state.settings;
    paintShareSettings();
    toast(input.value === "link"
      ? "Record pages now offer a private link first."
      : "Record pages now attach the signed file first.");
  } catch (error) {
    toast(humanError(error), "error");
    paintShareSettings();
  }
}

/* ---- template studio ---- */

const A4_W = 793.7;   // 210mm at 96dpi
const A4_H = 1122.5;  // 297mm at 96dpi

function fitStudioPreview() {
  const stage = $("studioStage");
  const frame = $("studioFrame");
  const iframe = $("studioPreview");
  if (!stage || stage.offsetParent === null) return;
  /* read the stage's padding instead of assuming 16px: it tightens on phones */
  const style = getComputedStyle(stage);
  const available = stage.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
  if (available <= 0) return;
  const scale = Math.min(available / A4_W, 1);
  frame.style.width = `${Math.round(A4_W * scale)}px`;
  frame.style.height = `${Math.round(A4_H * scale)}px`;
  iframe.style.transform = `scale(${scale})`;
}

/** Paints a server-rendered sheet into the sandboxed preview frame. */
function paintSheet(html, source, note) {
  const chip = $("previewSourceChip");
  $("studioPreview").srcdoc = html || "";
  chip.textContent = source;
  chip.className = `chip ${source === "draft" ? "off" : "ok"}`;
  if (note) $("studioNote").textContent = note;
  fitStudioPreview();
}

function versionButton(label, handler, kind = "") {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `btn ghost small${kind ? ` ${kind}` : ""}`;
  button.textContent = label;
  button.addEventListener("click", handler);
  return button;
}

function markActiveVersion() {
  for (const row of $("templateList").querySelectorAll(".version-row")) {
    row.classList.toggle("on", row.dataset.id === state.templateEditId);
  }
}

function renderVersionList() {
  const list = $("templateList");
  list.textContent = "";
  if (!state.templates.length) {
    const item = document.createElement("li");
    item.className = "version-empty";
    item.textContent = "No versions yet — publish the default sheet below.";
    list.appendChild(item);
    return;
  }
  for (const template of state.templates) {
    const row = document.createElement("li");
    row.className = "version-row";
    row.dataset.id = template.id;

    const main = document.createElement("div");
    main.className = "version-main";
    const title = document.createElement("b");
    title.textContent = `v${template.version}`;
    if (template.active) {
      const chip = document.createElement("span");
      chip.className = "chip ok";
      chip.textContent = "live";
      title.appendChild(chip);
    }
    const sub = document.createElement("small");
    sub.textContent = [template.name, `${Math.max(1, Math.round((template.bytes || 0) / 1024))} KB`,
      (template.created_at || "").slice(0, 10)].filter(Boolean).join(" · ");
    main.append(title, sub);

    const actions = document.createElement("div");
    actions.className = "version-actions";
    actions.appendChild(versionButton("Preview", () => previewTemplate(template)));
    actions.appendChild(versionButton("Edit", () => openTemplate(template.id)));
    if (!template.active) {
      actions.appendChild(versionButton("Activate", () => activateTemplate(template)));
      actions.appendChild(versionButton("Delete", () => deleteTemplate(template), "danger"));
    }
    row.append(main, actions);
    list.appendChild(row);
  }
  markActiveVersion();
}

/** Blanks the studio and re-reads the versions of the company now in focus. */
async function refreshStudio() {
  $("templateList").textContent = "";
  $("templateHtml").value = "";
  $("templateName").value = "";
  $("editorHint").textContent = "flat {{placeholders}}";
  $("templateChip").textContent = "loading";
  $("templateMeta").textContent = "loading versions";
  paintSheet("", "draft", "loading versions");
  await loadTemplates();
}

async function loadTemplates(selectId) {
  const company = activeCompany();
  $("templateList").textContent = "";
  if (!company) {
    $("navTemplateSummary").textContent = "0 versions";
    $("templateChip").textContent = "no company";
    $("templateMeta").textContent = "no company selected";
    return;
  }
  try {
    const data = await api(`/api/companies/${encodeURIComponent(company.id)}/templates`);
    /* the desk may have changed while this request was in flight */
    if (company.id !== state.companyId) return;
    state.templates = data.templates || [];
  } catch (error) {
    toast(humanError(error), "error");
    return;
  }
  const live = state.templates.find((t) => t.active);
  $("templateChip").textContent = live ? `v${live.version} live` : "no live version";
  $("templateMeta").textContent = live ? `live v${live.version}` : "no live version";
  $("navTemplateSummary").textContent = plural(state.templates.length, "version", "versions");
  renderVersionList();
  const target = selectId
    || (state.templates.some((t) => t.id === state.templateEditId) ? state.templateEditId : null)
    || live?.id;
  if (target) await openTemplate(target);
  else if (!state.templates.length) paintSheet("", "draft", "nothing to preview yet");
}

async function openTemplate(templateId) {
  const company = activeCompany();
  if (!company) return;
  try {
    const data = await api(`/api/companies/${encodeURIComponent(company.id)}/templates/${encodeURIComponent(templateId)}`);
    $("templateHtml").value = data.template.html || "";
    $("templateName").value = "";
    state.templateEditId = templateId;
    $("editorHint").textContent = `editing v${data.template.version}`;
    markActiveVersion();
    const preview = await api(
      `/api/companies/${encodeURIComponent(company.id)}/templates/${encodeURIComponent(templateId)}/preview`
    );
    paintSheet(preview.html, `v${data.template.version}`, `sample · ${preview.sample?.quote_number || "next number"}`);
  } catch (error) {
    toast(humanError(error), "error");
  }
}

async function previewTemplate(template) {
  const company = activeCompany();
  if (!company) return;
  try {
    const data = await api(
      `/api/companies/${encodeURIComponent(company.id)}/templates/${encodeURIComponent(template.id)}/preview`
    );
    paintSheet(data.html, `v${template.version}`, `sample · ${data.sample?.quote_number || "next number"}`);
  } catch (error) {
    toast(humanError(error), "error");
  }
}

async function previewDraft() {
  const company = activeCompany();
  if (!company) return;
  const html = $("templateHtml").value;
  if (!html.trim()) { toast("The template cannot be empty.", "error"); return; }
  try {
    const data = await api(`/api/companies/${encodeURIComponent(company.id)}/templates/preview`, {
      method: "POST",
      body: { html },
    });
    paintSheet(data.html, "draft", `unsaved edits · ${data.sample?.quote_number || "sample"}`);
  } catch (error) {
    toast(humanError(error), "error");
  }
}

async function loadActiveTemplate() {
  const live = state.templates.find((t) => t.active);
  if (!live) { toast("No live template to reload.", "error"); return; }
  await openTemplate(live.id);
  toast(`Live version v${live.version} loaded.`);
}

async function publishTemplate() {
  const company = activeCompany();
  if (!company) return;
  const html = $("templateHtml").value;
  if (!html.trim()) { toast("The template cannot be empty.", "error"); return; }
  const activate = $("templateActivate").checked;
  const name = $("templateName").value.trim() || `Version ${(state.templates[0]?.version || 0) + 1}`;
  const button = $("templateSave");
  button.disabled = true;
  try {
    const data = await api(`/api/companies/${encodeURIComponent(company.id)}/templates`, {
      method: "POST",
      body: { html, name, activate },
    });
    toast(`Published v${data.template.version}${activate ? " and made it live" : ""}.`);
    $("templateName").value = "";
    state.templateEditId = data.template.id;
    await loadTemplates(data.template.id);
  } catch (error) {
    toast(humanError(error), "error");
  } finally {
    button.disabled = false;
  }
}

async function activateTemplate(template) {
  try {
    await api(`/api/templates/${encodeURIComponent(template.id)}/activate`, { method: "POST" });
    toast(`Template v${template.version} is live.`);
    state.templateEditId = template.id;
    await loadTemplates(template.id);
  } catch (error) {
    toast(humanError(error), "error");
  }
}

async function deleteTemplate(template) {
  const company = activeCompany();
  if (!company) return;
  const okay = await confirmAction({
    title: `Delete template v${template.version} (${template.name})?`,
    message: "Existing quotations keep their own snapshot.",
    confirm: `Delete v${template.version}`,
  });
  if (!okay) return;
  try {
    const data = await api(
      `/api/companies/${encodeURIComponent(company.id)}/templates/${encodeURIComponent(template.id)}`,
      { method: "DELETE" }
    );
    const detached = Number(data.detached_records || 0);
    toast(detached
      ? `v${data.version} deleted · ${detached} record(s) keep their snapshot.`
      : `Template v${data.version} deleted.`);
    if (state.templateEditId === template.id) {
      state.templateEditId = null;
      $("templateHtml").value = "";
      $("editorHint").textContent = "flat {{placeholders}}";
    }
    await loadTemplates();
  } catch (error) {
    toast(humanError(error), "error");
  }
}

async function rotatePasscode(event) {
  event.preventDefault();
  const current = $("pcCurrent").value;
  const next = $("pcNext").value;
  const repeat = $("pcRepeat").value;
  if (!current) { toast("Enter the current passcode.", "error"); $("pcCurrent").focus(); return; }
  if (next.length < 6) { toast("New passcode needs at least 6 characters.", "error"); $("pcNext").focus(); return; }
  if (next !== repeat) { toast("The new passcodes do not match.", "error"); $("pcRepeat").focus(); return; }
  if (next === current) { toast("Choose a passcode different from the current one.", "error"); $("pcNext").focus(); return; }
  try {
    const data = await api("/api/auth/passcode", { method: "POST", body: { current, next } });
    for (const id of ["pcCurrent", "pcNext", "pcRepeat"]) $(id).value = "";
    state.status = { ...state.status, passcode_updated_at: data?.rotated_at || new Date().toISOString() };
    paintPasscodeChrome();
    toast("Passcode rotated for every company and every person. Other devices are signed out.");
  } catch (error) {
    toast(humanError(error), "error");
  }
}

/* ------------------------------------------------------------------ views --- */

const SETTINGS_PANES = ["company", "template", "access", "share", "companies"];

/** Side-panel tabs: one pane at a time, mirrored in ?pane= so links can deep-link. */
function showSettingsPane(name, { remember = true } = {}) {
  const pane = SETTINGS_PANES.includes(name) ? name : "company";
  state.settingsPane = pane;
  for (const tab of $("settingsMenu").querySelectorAll(".settings-tab")) {
    tab.setAttribute("aria-current", tab.dataset.pane === pane ? "true" : "false");
  }
  for (const section of document.querySelectorAll(".settings-pane")) {
    const paneEl = /** @type {HTMLElement} */ (section);
    paneEl.hidden = paneEl.dataset.pane !== pane;
  }
  if (remember) {
    const url = new URL(location.href);
    url.searchParams.set("view", "settings");
    if (pane === "company") url.searchParams.delete("pane");
    else url.searchParams.set("pane", pane);
    history.replaceState(null, "", url);
  }
  if (pane === "template") window.requestAnimationFrame(fitStudioPreview);
}

function showView(name) {
  state.settingsOpen = name === "settings";
  $("topbar").hidden = false;
  $("gate").hidden = true;
  $("workspaceView").hidden = name !== "desk";
  $("settingsView").hidden = name !== "settings";
  /* the topbar's Settings button would only reload the page you are already on */
  $("settingsLink").hidden = name === "settings";
  const url = new URL(location.href);
  if (name === "settings") url.searchParams.set("view", "settings");
  else {
    url.searchParams.delete("view");
    url.searchParams.delete("pane");
  }
  history.replaceState(null, "", url);
  if (name === "settings") window.requestAnimationFrame(fitStudioPreview);
}

async function openSettings(pane) {
  showView("settings");
  showSettingsPane(pane || new URLSearchParams(location.search).get("pane") || state.settingsPane || "company");
  await refreshStudio();
}

async function signOut(message) {
  try { await api("/api/auth/logout", { method: "POST" }); } catch { /* already gone */ }
  state.status = { setup: true, signed_in: false, session_hours: state.status?.session_hours || 12 };
  state.quotes = [];
  state.templates = [];
  state.templateEditId = null;
  renderGate(state.status);
  if (message) gateError(message);
}

/* ------------------------------------------------------------------- boot --- */

async function boot() {
  let status;
  try {
    status = await api("/api/auth/status");
  } catch {
    $("gate").hidden = false;
    gateError("Cannot reach the Worker. Reload in a moment.");
    return;
  }
  state.status = status;
  /* the gate collects no name, so a browser session reports the "Shared user" fallback */
  const who = status.name && status.name !== "Shared user" ? status.name : "signed in";
  $("sessionChip").textContent = status.signed_in ? who : "locked";
  if (!status.setup || !status.signed_in) {
    renderGate(status);
    return;
  }
  $("topbar").hidden = false;
  $("gate").hidden = true;
  await loadCompanies();
  $("quoteDate").value = todayLocal();
  await loadSettings();
  await refreshNextNumber();
  await loadQuotes();
  const wantsSettings = new URLSearchParams(location.search).get("view") === "settings";
  if (wantsSettings) await openSettings();
  else showView("desk");
}

function bind() {
  $("gateForm").addEventListener("submit", submitGate);
  $("quoteForm").addEventListener("submit", submitQuote);
  $("companySelect").addEventListener("change", () => switchCompany($("companySelect").value));
  $("quoteDate").addEventListener("change", refreshNextNumber);
  $("logoutBtn").addEventListener("click", () => signOut());
  $("companyForm").addEventListener("submit", saveCompany);
  $("logoPick").addEventListener("click", () => $("logoFile").click());
  $("logoFile").addEventListener("change", () => {
    const file = $("logoFile").files && $("logoFile").files[0];
    if (file) uploadLogo(file);
  });
  $("logoRemove").addEventListener("click", removeLogo);
  $("deactivateBtn").addEventListener("click", deactivateCompany);
  $("newCompanyForm").addEventListener("submit", createCompany);
  $("templateSave").addEventListener("click", publishTemplate);
  $("templateLoad").addEventListener("click", loadActiveTemplate);
  $("templatePreviewDraft").addEventListener("click", previewDraft);
  $("studioRefresh").addEventListener("click", () => {
    const current = state.templates.find((t) => t.id === state.templateEditId);
    if (current) previewTemplate(current);
    else previewDraft();
  });
  $("studioPreview").addEventListener("load", fitStudioPreview);
  window.addEventListener("resize", () => { if (state.settingsOpen) fitStudioPreview(); });
  $("settingsMenu").addEventListener("click", (event) => {
    const tab = event.target.closest(".settings-tab");
    if (tab) showSettingsPane(tab.dataset.pane);
  });
  $("passcodeForm").addEventListener("submit", rotatePasscode);
  $("ledgerSort").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-sort]");
    if (!button || button.dataset.sort === state.sort) return;
    state.sort = button.dataset.sort === "date" ? "date" : "number";
    paintSort();
    loadQuotes();
  });
  $("shareModeForm").addEventListener("change", (event) => {
    const input = event.target.closest("input[name=share_mode]");
    if (input && input.checked) saveShareMode(input);
  });

  let searchTimer = null;
  $("searchInput").addEventListener("input", () => {
    clearTimeout(searchTimer);
    const value = $("searchInput").value.trim();
    searchTimer = setTimeout(() => { state.search = value; loadQuotes(); }, 260);
  });
  $("searchForm").addEventListener("submit", (event) => {
    event.preventDefault();
    state.search = $("searchInput").value.trim();
    loadQuotes();
  });

  document.addEventListener("keydown", (event) => {
    const tag = document.activeElement?.tagName;
    const typing = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
    if (event.key === "/" && !typing) {
      event.preventDefault();
      $("searchInput").focus();
    }
    if (event.key.toLowerCase() === "n" && !typing && !state.settingsOpen) {
      event.preventDefault();
      $("model").focus();
    }
  });
}

bind();
boot();

export {};




