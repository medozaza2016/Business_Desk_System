/* Challenger Quotation Desk — client
   No framework, no build step. Views: gate → modules → quotation workspace / settings / invoicing preview. */

import { confirmAction } from "./dialog.js";

/** @param {string} id @returns {any} */
const $ = (id) => document.getElementById(id);

const state = {
  status: null,
  companies: [],
  companyId: null,
  quotes: [],
  search: "",
  quoteView: "active",
  /** "number" (newest serial first) or "date"; the Worker orders the rows */
  sort: "number",
  templates: [],
  templateEditId: null,
  settings: null,
  settingsOpen: false,
  settingsPane: "company",
  auditOffset: 0,
  auditLoading: false,
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
    company_confirmation_required: "Type the exact company name to confirm permanent deletion.",
    quotation_not_deleted: "Only deleted quotations can be restored.",
    quotation_must_be_deleted_first: "Move the quotation to Deleted before permanently removing it.",
    quotation_confirmation_required: "Type the exact quotation number to confirm permanent deletion.",
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
  $("modulesView").hidden = true;
  $("workspaceView").hidden = true;
  $("settingsView").hidden = true;
  $("invoicePreviewView").hidden = true;
  $("gate").hidden = false;
  $("gatePasscode").focus();
}

function renderGate(status) {
  const setupMode = !status.setup;
  state.status = status;
  $("gateEyebrow").textContent = setupMode ? "First-time setup" : "Secure workspace access";
  $("gateTitle").textContent = setupMode ? "Set up your workspace" : "Access your workspace";
  $("gateLede").textContent = setupMode
    ? "Choose the shared passcode for your team. This creates the initial company and quotation template."
    : "Enter your shared access passcode to continue.";
  $("gateSubmit").textContent = setupMode ? "Create passcode & continue" : "Unlock workspace";
  $("gateFoot").textContent = setupMode
    ? "Your initial workspace will include a starter company and quotation template."
    : `Sessions last ${status.session_hours || 12} hours. Access is managed by your system administrator.`;
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
    storage.set("q_company", "");
    renderCompanySelect();
    paintCompanyChrome();
    paintCompanySettings();
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

let nextNumberRequest = 0;

async function refreshNextNumber() {
  const requestId = ++nextNumberRequest;
  const numberField = $("quoteNumber");
  const company = activeCompany();
  numberField.value = "";
  if (!company) {
    return;
  }
  const date = $("quoteDate").value || todayLocal();
  try {
    const data = await api(`/api/quotations/next-number?company_id=${encodeURIComponent(company.id)}&date=${encodeURIComponent(date)}`);
    if (requestId !== nextNumberRequest) return;
    numberField.value = data.quote_number;
  } catch {
    if (requestId !== nextNumberRequest) return;
    numberField.value = "";
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
  const isDeleted = state.quoteView === "deleted";
  const total = state.quotes.length;
  const suffix = state.search ? ` matching “${state.search}”` : "";
  const order = state.sort === "date" ? "newest date first" : "highest number first";
  $("ledgerTitle").textContent = isDeleted
    ? `Deleted · ${company?.name || "quotations"}`
    : (company?.name || "Quotations");
  $("ledgerMeta").textContent = company
    ? `${total} ${isDeleted ? "deleted " : ""}record${total === 1 ? "" : "s"}${suffix} · ${order} · prefix ${company.quotation_prefix || "QA-"} · currency ${company.currency || "AED"}`
    : "No company configured yet.";
  $("emptyState").hidden = total > 0;
  $("emptyState").innerHTML = isDeleted
    ? "<b>No deleted quotations</b> Deleted records for this company will appear here."
    : "<b>No quotations yet</b> Enter a vehicle on the left to issue the first record.";
  $("quoteActionsHead").hidden = !isDeleted;
  $("csvLink").hidden = isDeleted;
  for (const button of $("quoteView").querySelectorAll("button")) {
    button.setAttribute("aria-pressed", button.dataset.view === state.quoteView ? "true" : "false");
  }
  paintSort();

  for (const quote of state.quotes) {
    const row = document.createElement("tr");
    if (isDeleted) {
      row.className = "row-deleted";
    } else {
      row.className = "row-open";
      row.dataset.href = `/quote?id=${encodeURIComponent(quote.id)}`;
    }

    const numberCell = document.createElement("td");
    numberCell.className = "num";
    const numberWrap = document.createElement("div");
    numberWrap.className = "num-stack";
    const link = document.createElement(isDeleted ? "span" : "a");
    if (!isDeleted) link.href = `/quote?id=${encodeURIComponent(quote.id)}`;
    link.textContent = quote.quote_number;
    const mark = document.createElement("span");
    mark.className = `chip ${isDeleted ? "off" : quote.status === "completed" || quote.has_scan ? "ok" : "off"}`;
    mark.textContent = isDeleted ? "deleted" : quote.status === "completed" ? "completed" : quote.has_scan ? "signed" : "unsigned";
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

    if (isDeleted) {
      const actions = document.createElement("td");
      actions.className = "quote-row-actions";
      const restore = document.createElement("button");
      restore.type = "button";
      restore.className = "btn ghost small";
      restore.dataset.quoteAction = "restore";
      restore.dataset.quoteId = quote.id;
      restore.textContent = "Restore";
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "btn danger small";
      remove.dataset.quoteAction = "permanent-delete";
      remove.dataset.quoteId = quote.id;
      remove.dataset.quoteNumber = quote.quote_number;
      remove.textContent = "Delete permanently";
      actions.append(restore, remove);
      row.appendChild(actions);
    }
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
  const query = new URLSearchParams({ company_id: state.companyId, limit: "100", sort: state.sort, view: state.quoteView });
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

/** Restore a quotation that is currently in the Deleted view. */
async function restoreQuotation(id) {
  try {
    const data = await api(`/api/quotations/${encodeURIComponent(id)}/restore`, { method: "POST" });
    toast(`${data.quote_number} restored.`);
    await loadQuotes();
  } catch (error) {
    toast(humanError(error), "error");
  }
}

/** Permanently remove a soft-deleted quotation, including its signed scan. */
async function permanentlyDeleteQuotation(id, quoteNumber) {
  const okay = await confirmAction({
    title: `Permanently delete ${quoteNumber}?`,
    message: "This removes the quotation and its stored signed file. Its audit history is retained. This action cannot be undone.",
    confirm: "Delete permanently",
    cancel: "Keep record",
    expectedText: quoteNumber,
    inputLabel: "Type the quotation number to confirm",
  });
  if (!okay) return;
  try {
    const result = await api(`/api/quotations/${encodeURIComponent(id)}/permanent`, {
      method: "DELETE",
      body: { confirm_number: quoteNumber },
    });
    toast(result.asset_cleanup_failed
      ? `${quoteNumber} removed, but its stored file could not be cleared.`
      : `${quoteNumber} permanently deleted.`);
    await loadQuotes();
  } catch (error) {
    toast(humanError(error), "error");
  }
}

async function submitQuote(event) {
  event.preventDefault();
  const company = activeCompany();
  if (!company) { toast("Add a company first in Settings.", "error"); return; }
  const payload = {
    company_id: company.id,
    quote_date: $("quoteDate").value || todayLocal(),
    model: $("model").value.trim(),
    year: $("year").value.trim(),
    chassis: $("chassis").value.trim(),
    comments: $("comments").value.trim(),
    amount: $("amount").value.trim(),
  };
  if (!payload.model || !payload.year || !payload.chassis || !payload.amount) {
    toast("Model, year, chassis and value are required.", "error");
    return;
  }
  const button = event.target.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    const data = await api("/api/quotations", { method: "POST", body: payload });
    toast(`Saved ${data.quotation.quote_number}`);
    for (const id of ["model", "year", "chassis", "comments", "amount"]) $(id).value = "";
    $("model").focus();
    await refreshNextNumber();
    if (state.quoteView !== "active") state.quoteView = "active";
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
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "btn danger small";
    remove.style.marginLeft = "8px";
    remove.textContent = "Delete permanently";
    remove.addEventListener("click", () => permanentlyDeleteCompany(company));
    right.appendChild(remove);
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

/** Permanently remove a company only after showing its impact and typing its name. */
async function permanentlyDeleteCompany(company) {
  try {
    const summary = await api(`/api/companies/${encodeURIComponent(company.id)}/delete-summary`);
    const s = summary;
    const message = `This will permanently remove ${s.quotations} quotations (including deleted ones), ${s.templates} templates, ${s.numbering_sequences} numbering sequences, ${s.signed_scans} signed scans and ${s.company_files} company files. Audit history will be retained. This cannot be undone.`;
    const okay = await confirmAction({
      title: `Delete ${company.name} and all its data?`,
      message,
      confirm: "Delete company permanently",
      cancel: "Keep company",
      expectedText: company.name,
      inputLabel: "Type the exact company name to confirm",
      copyLabel: "Copy company name",
    });
    if (!okay) return;
    const result = await api(`/api/companies/${encodeURIComponent(company.id)}/permanent`, {
      method: "DELETE",
      body: { confirm_name: company.name },
    });
    state.search = "";
    $("searchInput").value = "";
    toast(result.asset_cleanup_failed
      ? `${company.name} deleted, but ${result.asset_cleanup_failed} stored files could not be cleared.`
      : `${company.name} and all its company data were permanently deleted.`);
    state.templates = [];
    state.templateEditId = null;
    await loadCompanies();
    await refreshNextNumber();
    await loadQuotes();
    if (state.settingsOpen) await refreshStudio();
    if (state.settingsPane === "audit") await loadAuditTrail();
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

const AUDIT_ACTIONS = {
  "auth.setup": ["Workspace set up", "success"],
  "auth.passcode_rotated": ["Shared passcode changed", "neutral"],
  "settings.updated": ["Workspace settings updated", "neutral"],
  "company.created": ["Company created", "success"],
  "company.updated": ["Company profile updated", "neutral"],
  "company.deactivated": ["Company deactivated", "warning"],
  "company.permanently_deleted": ["Company permanently deleted", "danger"],
  "company.logo_uploaded": ["Company logo uploaded", "success"],
  "company.logo_removed": ["Company logo removed", "neutral"],
  "template.saved": ["Quotation template saved", "success"],
  "template.activated": ["Template activated", "success"],
  "template.deleted": ["Template deleted", "warning"],
  "quotation.created": ["Quotation created", "success"],
  "quotation.updated": ["Quotation updated", "neutral"],
  "quotation.cancelled": ["Quotation moved to Deleted", "warning"],
  "quotation.restored": ["Quotation restored", "success"],
  "quotation.permanently_deleted": ["Quotation permanently deleted", "danger"],
  "quotation.scan_uploaded": ["Signed document uploaded", "success"],
  "quotation.scan_removed": ["Signed document removed", "warning"],
  "quotation.completed": ["Quotation marked completed", "success"],
  "quotation.reopened": ["Quotation reopened", "neutral"],
  "quotation.share_link_created": ["Customer link created", "success"],
  "quotation.share_link_rotated": ["Customer link renewed", "neutral"],
  "quotation.share_link_revoked": ["Customer link revoked", "warning"],
};

const AUDIT_FIELD_LABELS = {
  name: "Company name",
  legal_name: "Legal name",
  legal_name_ar: "Arabic legal name",
  phone: "Phone",
  email: "Email",
  address: "Address",
  quotation_prefix: "Quotation number prefix",
  currency: "Currency",
  active: "Active status",
  quote_number: "Quotation number",
  quote_date: "Quotation date",
  model: "Vehicle model",
  year: "Vehicle year",
  chassis: "Chassis number",
  comments: "Comments",
  amount_cents: "Quotation value",
  status: "Status",
  share_mode: "WhatsApp sharing preference",
};

const auditCompanyName = (companyId) =>
  state.companies.find((company) => company.id === companyId)?.name || "";

function auditDateParts(value) {
  const stamp = String(value || "");
  const normalized = stamp.includes("T") ? stamp : `${stamp.replace(" ", "T")}Z`;
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) return { date: stamp || "Date unavailable", time: "" };
  return {
    date: date.toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" }),
    time: date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }),
    iso: date.toISOString(),
  };
}

function auditRecordLabel(event) {
  const details = event.details || {};
  if (details.quote_number) return `Quotation · ${details.quote_number}`;
  if (details.name) return `Company · ${details.name}`;
  if (event.entity === "company") {
    return `Company · ${auditCompanyName(event.entity_id) || "previously recorded"}`;
  }
  if (event.entity === "template") {
    const company = auditCompanyName(details.company_id);
    const version = details.version ? `v${details.version}` : "Template";
    return company ? `${version} · ${company}` : version;
  }
  if (event.entity === "settings") return "Business Desk settings";
  if (event.entity === "quotation") return "Quotation record";
  return event.entity ? `${event.entity} record` : "Workspace";
}

function auditActivitySummary(event) {
  const details = event.details || {};
  const summaries = [];
  if (Array.isArray(details.fields) && details.fields.length) {
    const fields = details.fields.map((field) => AUDIT_FIELD_LABELS[field] || String(field).replaceAll("_", " "));
    summaries.push(`Updated: ${fields.join(", ")}`);
  }
  if (details.name) {
    summaries.push(event.action === "company.created"
      ? `Created ${details.name}`
      : event.action === "company.updated" ? `Updated profile for ${details.name}` : details.name);
  }
  if (details.version) summaries.push(`Template version ${details.version}`);
  if (details.detached_records) summaries.push(`${details.detached_records} quotation snapshot(s) retained`);
  if (details.quotations_deleted !== undefined) summaries.push(`${details.quotations_deleted} quotation(s) removed`);
  if (details.templates_deleted !== undefined) summaries.push(`${details.templates_deleted} template(s) removed`);
  if (details.numbering_sequences_deleted !== undefined) summaries.push(`${details.numbering_sequences_deleted} numbering sequence(s) removed`);
  if (details.signed_scans_deleted !== undefined) summaries.push(`${details.signed_scans_deleted} signed file(s) removed`);
  if (details.company_files_deleted !== undefined) summaries.push(`${details.company_files_deleted} company file(s) removed`);
  if (details.asset_cleanup_failed) summaries.push(`${details.asset_cleanup_failed} file cleanup(s) failed`);
  if (details.content_type) summaries.push(details.content_type === "application/pdf" ? "PDF document" : "Image document");
  if (details.bytes) summaries.push(`${(details.bytes / 1024).toFixed(0)} KB`);
  if (details.source) summaries.push(details.source === "scan" ? "Captured by scanner" : "Uploaded file");
  if (details.replaced === true) summaries.push("Replaced previous file");
  if (details.share_mode) summaries.push(details.share_mode === "link" ? "Share by private link" : "Share signed file");
  if (details.status) summaries.push(`Status: ${details.status}`);
  if (details.amount_cents !== undefined && Number.isFinite(Number(details.amount_cents))) {
    const company = state.companies.find((item) => item.id === details.company_id);
    const currency = company?.currency || "Value";
    const amount = (Number(details.amount_cents) / 100).toLocaleString(undefined, {
      minimumFractionDigits: 2, maximumFractionDigits: 2,
    });
    summaries.push(`${currency} ${amount}`);
  }
  if (details.active !== undefined) summaries.push(details.active ? "Set as active" : "Saved as inactive");
  if (details.slug) summaries.push(`Reference: ${details.slug}`);
  if (details.audit_events_retained) summaries.push("Audit history retained");
  if (details.signed_scan_deleted !== undefined) summaries.push(details.signed_scan_deleted ? "Signed document removed" : "No signed document attached");
  return summaries.length ? summaries.join(" · ") : "Activity recorded";
}

function auditDetailValue(key, value) {
  if (value === null || value === undefined || value === "") return "—";
  if (key === "fields" && Array.isArray(value)) {
    return value.map((field) => AUDIT_FIELD_LABELS[field] || String(field).replaceAll("_", " ")).join(", ");
  }
  if (key === "amount_cents" && Number.isFinite(Number(value))) {
    return `${(Number(value) / 100).toFixed(2)} (stored in minor currency units)`;
  }
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (Array.isArray(value)) return value.map((item) => String(item)).join(", ");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function auditDetailLabel(key) {
  const labels = {
    company_id: "Company reference",
    quote_number: "Quotation number",
    previous_quote_number: "Previous quotation number",
    name: "Company name",
    slug: "Company reference",
    fields: "Updated fields",
    version: "Template version",
    active: "Published as active",
    detached_records: "Quotations retaining old template",
    quotations_deleted: "Quotations removed",
    templates_deleted: "Templates removed",
    numbering_sequences_deleted: "Numbering sequences removed",
    signed_scans_deleted: "Signed documents removed",
    company_files_deleted: "Company files removed",
    audit_events_retained: "Audit history retained",
    asset_cleanup_failed: "File cleanup failures",
    asset_cleanup_failed_keys: "Files needing cleanup",
    asset_cleanup_failed_key: "File needing cleanup",
    signed_scan_deleted: "Signed document removed",
    content_type: "File type",
    bytes: "File size (bytes)",
    replaced: "Replaced previous file",
    source: "Upload method",
    share_mode: "Sharing preference",
    status: "Quotation status",
    amount_cents: "Quotation value",
    permanent: "Permanent deletion",
    seeded_company: "Initial company reference",
    type: "Logo file type",
  };
  return labels[key] || key.replaceAll("_", " ").replace(/^./, (letter) => letter.toUpperCase());
}

function renderAuditEvent(event) {
  const details = event.details || {};
  const [activity, tone] = AUDIT_ACTIONS[event.action] || [
    String(event.action || "Activity recorded").replaceAll(".", " ").replaceAll("_", " ").replace(/^./, (letter) => letter.toUpperCase()),
    "neutral",
  ];
  const date = auditDateParts(event.created_at);
  const row = document.createElement("tr");
  row.className = `audit-row audit-row-${tone}`;

  const timeCell = document.createElement("td");
  timeCell.className = "audit-time-cell";
  timeCell.dataset.label = "Date and time";
  const timeDate = document.createElement("span");
  timeDate.className = "audit-date";
  timeDate.textContent = date.date;
  const timeClock = document.createElement("span");
  timeClock.className = "audit-clock";
  timeClock.textContent = date.time;
  timeCell.append(timeDate, timeClock);
  if (date.iso) {
    const time = document.createElement("time");
    time.dateTime = date.iso;
    time.hidden = true;
    timeCell.append(time);
  }

  const actorCell = document.createElement("td");
  const actor = document.createElement("span");
  actor.className = "audit-actor";
  actor.textContent = event.actor && event.actor !== "shared" && event.actor !== "Shared user"
    ? event.actor
    : "Shared user";
  actorCell.dataset.label = "User";
  actorCell.append(actor);

  const activityCell = document.createElement("td");
  const badge = document.createElement("span");
  badge.className = `audit-activity-badge audit-tone-${tone}`;
  badge.textContent = activity;
  const summary = document.createElement("span");
  summary.className = "audit-summary";
  summary.textContent = auditActivitySummary(event);
  activityCell.dataset.label = "Activity";
  activityCell.append(badge, summary);

  const recordCell = document.createElement("td");
  const record = document.createElement("span");
  record.className = "audit-record";
  record.textContent = auditRecordLabel(event);
  recordCell.dataset.label = "Affected record";
  recordCell.append(record);
  const companyContext = auditCompanyName(details.company_id);
  if (companyContext) {
    const context = document.createElement("span");
    context.className = "audit-record-context";
    context.textContent = companyContext;
    recordCell.append(context);
  }

  const detailsCell = document.createElement("td");
  detailsCell.className = "audit-more-cell";
  detailsCell.dataset.label = "More";
  const detailsPanel = document.createElement("details");
  detailsPanel.className = "audit-more";
  const detailsToggle = document.createElement("summary");
  detailsToggle.textContent = "View details";
  detailsPanel.append(detailsToggle);
  const detailList = document.createElement("dl");
  detailList.className = "audit-detail-list";
  const entries = Object.entries(details);
  if (entries.length) {
    for (const [key, value] of entries) {
      const term = document.createElement("dt");
      term.textContent = auditDetailLabel(key);
      const description = document.createElement("dd");
      description.textContent = auditDetailValue(key, value);
      detailList.append(term, description);
    }
  } else {
    const empty = document.createElement("p");
    empty.className = "audit-detail-empty";
    empty.textContent = "No additional details for this activity.";
    detailsPanel.append(empty);
  }
  detailsPanel.append(detailList);
  detailsCell.append(detailsPanel);

  row.append(timeCell, actorCell, activityCell, recordCell, detailsCell);
  return row;
}

async function loadAuditTrail({ append = false } = {}) {
  if (state.auditLoading) return;
  const body = $("auditBody");
  const button = $("auditLoadMore");
  const limit = 200;
  if (!append) {
    state.auditOffset = 0;
    body.textContent = "";
    $("auditEmpty").hidden = true;
    button.hidden = true;
  }
  const offset = state.auditOffset;
  state.auditLoading = true;
  button.disabled = true;
  try {
    const data = await api(`/api/audit?limit=${limit}&offset=${offset}`);
    const events = data.events || [];
    $("auditCountChip").textContent = Number(data.total || 0).toLocaleString();
    $("navAuditSummary").textContent = Number(data.total || 0).toLocaleString() + " events";
    for (const event of events) body.append(renderAuditEvent(event));
    state.auditOffset = offset + events.length;
    $("auditEmpty").hidden = data.total > 0;
    const showing = Math.min(state.auditOffset, data.total);
    $("auditRangeNote").textContent = data.total
      ? `Showing ${showing.toLocaleString()} of ${Number(data.total).toLocaleString()} events`
      : "No activity to show";
    button.hidden = state.auditOffset >= data.total;
  } catch (error) {
    if (!append) {
      $("auditCountChip").textContent = "Unavailable";
      $("auditEmpty").hidden = false;
      $("auditEmpty").querySelector("h3").textContent = "Audit history unavailable";
      $("auditEmpty").querySelector("p").textContent = humanError(error);
    } else {
      toast(humanError(error), "error");
    }
  } finally {
    state.auditLoading = false;
    button.disabled = false;
  }
}

/* ------------------------------------------------------------------ views --- */

const SETTINGS_PANES = ["company", "template", "access", "share", "companies", "audit"];

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
  if (pane === "audit") void loadAuditTrail();
}

function showView(name) {
  const view = ["desk", "settings", "modules", "invoicing"].includes(name) ? name : "modules";
  state.settingsOpen = view === "settings";
  $("topbar").hidden = false;
  $("gate").hidden = true;
  $("modulesView").hidden = view !== "modules";
  $("workspaceView").hidden = view !== "desk";
  $("settingsView").hidden = view !== "settings";
  $("invoicePreviewView").hidden = view !== "invoicing";
  const moduleLanding = view === "modules";
  $("companySwitch").hidden = moduleLanding || view === "invoicing";
  $("topbarRule").hidden = moduleLanding || view === "invoicing";
  $("modulesLink").hidden = moduleLanding;
  $("settingsLink").hidden = view === "settings";
  const url = new URL(location.href);
  if (view === "settings") url.searchParams.set("view", "settings");
  else if (view === "desk") url.searchParams.set("view", "desk");
  else if (view === "invoicing") url.searchParams.set("view", "invoicing");
  else url.searchParams.delete("view");
  if (view !== "settings") url.searchParams.delete("pane");
  history.replaceState(null, "", url);
  if (view === "settings") window.requestAnimationFrame(fitStudioPreview);
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
  const requestedView = new URLSearchParams(location.search).get("view");
  if (requestedView === "settings") await openSettings();
  else if (requestedView === "desk") showView("desk");
  else if (requestedView === "invoicing") showView("invoicing");
  else showView("modules");
}

function openModuleCard(card) {
  if (card.dataset.module === "quotations") {
    showView("desk");
  } else if (card.dataset.module === "invoicing") {
    showView("invoicing");
  }
}

function bind() {
  $("gateForm").addEventListener("submit", submitGate);
  $("quoteForm").addEventListener("submit", submitQuote);
  $("companySelect").addEventListener("change", () => switchCompany($("companySelect").value));
  $("quoteDate").addEventListener("change", refreshNextNumber);
  $("logoutBtn").addEventListener("click", () => signOut());
  $("modulesLink").addEventListener("click", () => showView("modules"));
  const moduleGrid = document.querySelector(".module-picker-grid");
  moduleGrid.addEventListener("click", (event) => {
    const card = event.target.closest(".module-choice[data-module]");
    if (card && moduleGrid.contains(card)) openModuleCard(card);
  });
  moduleGrid.addEventListener("keydown", (event) => {
    const card = event.target.closest(".module-choice[data-module]");
    if (!card || !moduleGrid.contains(card)) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openModuleCard(card);
    }
  });
  $("backToModules").addEventListener("click", () => showView("modules"));
  $("previewBackAction").addEventListener("click", () => showView("modules"));
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
  $("auditLoadMore").addEventListener("click", () => { void loadAuditTrail({ append: true }); });
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

  $("quoteView").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-view]");
    if (!button || button.dataset.view === state.quoteView) return;
    state.quoteView = button.dataset.view === "deleted" ? "deleted" : "active";
    loadQuotes();
  });

  $("quotesBody").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-quote-action]");
    if (!button) return;
    event.preventDefault();
    event.stopPropagation();
    const id = button.dataset.quoteId;
    if (button.dataset.quoteAction === "restore") void restoreQuotation(id);
    else if (button.dataset.quoteAction === "permanent-delete") {
      void permanentlyDeleteQuotation(id, button.dataset.quoteNumber || "");
    }
  });

  /* The ledger line is the door: print, complete and cancel all live on the
     record, so a click anywhere on the line opens it. The number link keeps
     working for the keyboard, and modifier clicks and text selection are left
     to the browser. */
  $("quotesBody").addEventListener("click", (event) => {
    if (event.target.closest("a, button")) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    if (window.getSelection()?.toString()) return;
    const row = event.target.closest("tr[data-href]");
    if (row) location.href = row.dataset.href;
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




