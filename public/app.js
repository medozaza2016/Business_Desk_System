/* Challenger Quotation Desk — client
   No framework, no build step. Views: gate → modules → quotation workspace / vehicle
   agreement ledger / settings. The agreement wizard lives in agreement-wizard.js and
   the record page has its own agreement.js; this file owns the ledgers. */

import { confirmAction } from "./dialog.js";
import { openAgreementWizard } from "./agreement-wizard.js";
import { loadAppVersion } from "./version.js";

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
  /** the agreement ledger keeps its own filters, one book at a time */
  agreements: [],
  agreementKind: "sale",
  agreementView: "active",
  agreementSearch: "",
  agreementSort: "number",
  agreementCounts: { sale: 0, purchase: 0 },
  templates: [],
  templateEditId: null,
  /** which sheet the studio is editing: "quotation", "sale" or "purchase" */
  templateKind: "quotation",
  /** versions of every kind, keyed by kind, so the tabs can show each one's live page */
  templateSheets: {},
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
    security_check_failed: "Security verification failed or expired. Complete the check and try again.",
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
    agreement_not_found: "That agreement no longer exists.",
    agreement_confirmation_required: "Type the exact agreement number to confirm permanent deletion.",
    agreement_must_be_deleted_first: "Move the agreement to Deleted before permanently removing it.",
    agreement_not_deleted: "Only deleted agreements can be restored.",
    invalid_agreement_kind: "Pick either a sale or a purchase agreement.",
    invalid_agreement_date: "Enter a valid agreement date.",
    agreement_fields_required: "Fill the vehicle model, year and chassis, and both party names.",
    invalid_full_amount: "Enter the agreed price between 0 and 99,999,999.99.",
    invalid_paid_amount: "Enter the amount paid between 0 and 99,999,999.99.",
    paid_amount_exceeds_full: "The amount paid cannot be larger than the agreed price.",
    agreement_completed: "This agreement is completed. Reopen it on the record page.",
    invalid_status: "Pick either issued or completed for this agreement.",
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

let turnstileScriptPromise = null;
let turnstileWidgetId = null;
let turnstileToken = "";

function loadTurnstileApi() {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  if (turnstileScriptPromise) return turnstileScriptPromise;
  turnstileScriptPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    script.async = true;
    script.defer = true;
    script.onload = () => resolve(window.turnstile);
    script.onerror = () => {
      turnstileScriptPromise = null;
      reject(new Error("turnstile_script_load_failed"));
    };
    document.head.appendChild(script);
  });
  return turnstileScriptPromise;
}

async function mountTurnstile(status) {
  const target = $("turnstileWidget");
  const submit = $("gateSubmit");
  if (!target || !submit) return;
  turnstileToken = "";
  submit.disabled = true;
  gateError("");
  if (turnstileWidgetId !== null && window.turnstile) {
    try { window.turnstile.remove(turnstileWidgetId); } catch { /* widget already removed */ }
  }
  turnstileWidgetId = null;
  target.replaceChildren();
  const sitekey = status.turnstile_site_key;
  if (!sitekey) {
    gateError("Security verification is not configured. Contact the administrator.");
    return;
  }
  const action = status.setup ? "business_desk_login" : "business_desk_setup";
  try {
    const turnstile = await loadTurnstileApi();
    turnstileWidgetId = turnstile.render(target, {
      sitekey,
      action,
      callback(token) {
        turnstileToken = token;
        submit.disabled = false;
        gateError("");
      },
      "expired-callback"() {
        turnstileToken = "";
        submit.disabled = true;
      },
      "error-callback"() {
        turnstileToken = "";
        submit.disabled = true;
        gateError("Security verification failed to load. Refresh the page and try again.");
      },
    });
  } catch {
    gateError("Security verification could not load. Check your connection and refresh.");
  }
}

function showGate() {
  $("appVersionFooter").hidden = true;
  $("topbar").hidden = true;
  $("modulesView").hidden = true;
  $("workspaceView").hidden = true;
  $("settingsView").hidden = true;
  $("agreementsView").hidden = true;
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
  $("gateFoot").textContent = "Your initial workspace will include a starter company and quotation template.";
  $("gateFoot").hidden = !setupMode;
  showGate();
  mountTurnstile(status);
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
  if (!turnstileToken) { gateError("Complete the security check before continuing."); return; }
  const setupMode = !state.status?.setup;
  const button = $("gateSubmit");
  button.disabled = true;
  button.textContent = setupMode ? "Creating…" : "Unlocking…";
  try {
    /* no name is collected at the gate: desk sessions are audited as "Shared user" */
    await api(setupMode ? "/api/setup" : "/api/auth/login", {
      method: "POST",
      body: { passcode, turnstile_token: turnstileToken },
    });
    turnstileToken = "";
    $("gatePasscode").value = "";
    await boot();
    if (setupMode) toast("Desk created. Add company details in Settings.");
  } catch (error) {
    gateError(humanError(error));
    turnstileToken = "";
    if (window.turnstile && turnstileWidgetId !== null) {
      try { window.turnstile.reset(turnstileWidgetId); } catch { /* widget unavailable */ }
    }
  } finally {
    button.disabled = !turnstileToken;
    button.textContent = setupMode ? "Create passcode & open desk" : "Unlock desk";
  }
}

/* ------------------------------------------------------------- companies --- */

const activeCompany = () => state.companies.find((c) => c.id === state.companyId) || null;

function paintCompanyChrome() {
  const company = activeCompany();
  $("currencyTag").textContent = company?.currency || "AED";
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
  state.templateSheets = {};
  state.templateEditId = null;
  state.agreements = [];
  state.agreementCounts = { sale: 0, purchase: 0 };
  renderCompanySelect();
  paintCompanyChrome();
  paintCompanySettings();
  refreshNextNumber();
  loadQuotes();
  if (!$("agreementsView").hidden) void loadAgreements();
  else renderAgreements();
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
    if (!isDeleted) /** @type {HTMLAnchorElement} */ (link).href = `/quote?id=${encodeURIComponent(quote.id)}`;
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

/* ------------------------------------------------------ agreement ledger --- */

const AGREEMENT_KIND_TEXT = {
  sale: { title: "Sale agreements", lede: "Vehicles the company sells, priced and signed." },
  purchase: { title: "Purchase agreements", lede: "Vehicles the company buys, priced and signed." },
};

/** One line per record: the number is the door, the balance is the argument. */
function renderAgreements() {
  const body = $("agreementsBody");
  body.textContent = "";
  const company = activeCompany();
  const isDeleted = state.agreementView === "deleted";
  const text = AGREEMENT_KIND_TEXT[state.agreementKind] || AGREEMENT_KIND_TEXT.sale;
  $("agreementsTitle").textContent = text.title;
  $("agreementsLede").textContent = text.lede;
  $("agreementsEmpty").hidden = state.agreements.length > 0;
  $("agreementsEmpty").innerHTML = isDeleted
    ? "<b>Nothing deleted</b> Cancelled agreements for this company will appear here."
    : state.agreementSearch
      ? "<b>No matches</b> Nothing in this book matches that search."
      : `<b>No ${state.agreementKind} agreements yet</b> Issue the first one to keep the paper in one place.`;
  $("agreementActionsHead").hidden = !isDeleted;

  for (const button of $("agreementKind").querySelectorAll("button[data-kind]")) {
    button.setAttribute("aria-pressed", button.dataset.kind === state.agreementKind ? "true" : "false");
  }
  for (const badge of $("agreementKind").querySelectorAll("b[data-count]")) {
    badge.textContent = String(state.agreementCounts[badge.dataset.count] || 0);
  }
  for (const button of $("agreementView").querySelectorAll("button[data-view]")) {
    button.setAttribute("aria-pressed", button.dataset.view === state.agreementView ? "true" : "false");
  }
  for (const button of $("agreementSort").querySelectorAll("button[data-sort]")) {
    button.setAttribute("aria-pressed", button.dataset.sort === state.agreementSort ? "true" : "false");
  }

  $("agreementCsv").href = company
    ? `/api/export/agreements.csv?company_id=${encodeURIComponent(company.id)}&kind=${state.agreementKind}`
    : "#";
  $("agreementCsv").hidden = isDeleted || !company;
  $("agreementSheetBtn").hidden = isDeleted || !company;
  $("newAgreementBtn").disabled = !company;

  for (const agreement of state.agreements) {
    const row = document.createElement("tr");
    if (isDeleted) {
      row.className = "row-deleted";
    } else {
      row.className = "row-open";
      row.dataset.href = `/agreement?id=${encodeURIComponent(agreement.id)}`;
    }

    const numberCell = document.createElement("td");
    numberCell.className = "num";
    const numberWrap = document.createElement("div");
    numberWrap.className = "num-stack";
    const link = document.createElement(isDeleted ? "span" : "a");
    if (!isDeleted) /** @type {HTMLAnchorElement} */ (link).href = `/agreement?id=${encodeURIComponent(agreement.id)}`;
    link.textContent = agreement.agreement_number;
    const mark = document.createElement("span");
    const settled = Number(agreement.balance_cents || 0) === 0;
    mark.className = `chip ${isDeleted ? "off" : agreement.status === "completed" || settled ? "ok" : "off"}`;
    mark.textContent = isDeleted
      ? "deleted"
      : agreement.status === "completed"
        ? "filed"
        : agreement.signed ? "signed" : "unsigned";
    numberWrap.append(link, mark);
    numberCell.appendChild(numberWrap);
    row.appendChild(numberCell);

    row.appendChild(rowCell(agreement.agreement_date_text || agreement.agreement_date, "date", "Date"));

    const vehicle = document.createElement("td");
    vehicle.className = "vehicle";
    const model = document.createElement("b");
    model.textContent = `${agreement.vehicle_model} ${agreement.vehicle_year}`;
    const chassis = document.createElement("span");
    chassis.textContent = [agreement.vehicle_chassis, agreement.vehicle_plate].filter(Boolean).join(" · ");
    vehicle.append(model, chassis);
    row.appendChild(vehicle);

    const parties = document.createElement("td");
    parties.className = "parties";
    const seller = document.createElement("span");
    seller.textContent = agreement.seller_name;
    const arrow = document.createElement("i");
    arrow.textContent = "→";
    arrow.setAttribute("aria-hidden", "true");
    const buyer = document.createElement("span");
    buyer.textContent = agreement.buyer_name;
    parties.append(seller, arrow, buyer);
    row.appendChild(parties);

    row.appendChild(rowCell(`${agreement.currency} ${agreement.full_amount}`, "money", "Agreed"));
    row.appendChild(rowCell(`${agreement.currency} ${agreement.balance}`, "money", "Balance"));

    if (isDeleted) {
      const actions = document.createElement("td");
      actions.className = "quote-row-actions";
      const restore = document.createElement("button");
      restore.type = "button";
      restore.className = "btn ghost small";
      restore.dataset.agreementAction = "restore";
      restore.dataset.agreementId = agreement.id;
      restore.textContent = "Restore";
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "btn danger small";
      remove.dataset.agreementAction = "permanent-delete";
      remove.dataset.agreementId = agreement.id;
      remove.dataset.agreementNumber = agreement.agreement_number;
      remove.textContent = "Delete permanently";
      actions.append(restore, remove);
      row.appendChild(actions);
    }
    body.appendChild(row);
  }
}

async function loadAgreements() {
  if (!state.companyId) {
    state.agreements = [];
    state.agreementCounts = { sale: 0, purchase: 0 };
    renderAgreements();
    return;
  }
  const query = new URLSearchParams({
    company_id: state.companyId,
    kind: state.agreementKind,
    limit: "100",
    sort: state.agreementSort,
    view: state.agreementView,
  });
  if (state.agreementSearch) query.set("q", state.agreementSearch);
  try {
    const data = await api(`/api/agreements?${query.toString()}`);
    state.agreements = data.agreements || [];
    state.agreementCounts = data.counts || { sale: 0, purchase: 0 };
    renderAgreements();
  } catch (error) {
    if (error.status === 401) return signOut("Your session expired.");
    toast(humanError(error), "error");
  }
}

/** Restore a cancelled agreement from the Deleted view. */
async function restoreAgreement(id) {
  try {
    const data = await api(`/api/agreements/${encodeURIComponent(id)}/restore`, { method: "POST" });
    toast(`${data.agreement_number || "Agreement"} restored.`);
    await loadAgreements();
  } catch (error) {
    toast(humanError(error), "error");
  }
}

/** Permanently remove a cancelled agreement, including its signed scan. */
async function permanentlyDeleteAgreement(id, agreementNumber) {
  const okay = await confirmAction({
    title: `Permanently delete ${agreementNumber}?`,
    message: "This removes the agreement and its stored signed file. Its audit history is retained. This action cannot be undone.",
    confirm: "Delete permanently",
    cancel: "Keep record",
    expectedText: agreementNumber,
    inputLabel: "Type the agreement number to confirm",
  });
  if (!okay) return;
  try {
    const result = await api(`/api/agreements/${encodeURIComponent(id)}/permanent`, {
      method: "DELETE",
      body: { confirm_number: agreementNumber },
    });
    toast(result.asset_cleanup_failed
      ? `${agreementNumber} removed, but its stored file could not be cleared.`
      : `${agreementNumber} permanently deleted.`);
    await loadAgreements();
  } catch (error) {
    toast(humanError(error), "error");
  }
}

/** The wizard is opened from wherever the desk is standing; it owns nothing but itself. */
function openAgreementWizardFor(kind) {
  const company = activeCompany();
  if (!company) {
    toast("Add a company first in Settings.", "error");
    return;
  }
  openAgreementWizard({
    companyId: company.id,
    currency: company.currency || "AED",
    kind: kind || state.agreementKind,
    onCreated(agreement) {
      toast(`${agreement.agreement_number} issued.`);
      state.agreementKind = agreement.kind === "purchase" ? "purchase" : "sale";
      state.agreementView = "active";
      state.agreementSearch = "";
      $("agreementSearch").value = "";
      void loadAgreements();
    },
  });
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
    state.templateSheets = {};
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

/* The three sheets a company owns: one quotation page and two agreement pages. Versions,
   live flags and numbering are per kind, so the studio asks the Worker for one kind at a
   time with ?kind=. */
const SHEET_KINDS = [
  { kind: "quotation", label: "Quotation" },
  { kind: "sale", label: "Sale agreement" },
  { kind: "purchase", label: "Purchase agreement" },
];
const isSheetKind = (kind) => SHEET_KINDS.some((sheet) => sheet.kind === kind);
const sheetLabel = (kind) => (SHEET_KINDS.find((sheet) => sheet.kind === kind) || SHEET_KINDS[0]).label;

/* The placeholder reference in the studio guide. It restates docs/template-placeholders.md
   inside the app, grouped so a redesign can be done without leaving the editor. The tokens
   are exactly the ones the Worker hydrates for that sheet. */
const GUIDE_COMPANY_TOKENS = [
  ["company_name", "legal name, falling back to the short name"],
  ["company_legal_name_en", "legal name in English"],
  ["company_legal_name_en_head", "first word of it, for an accent-coloured brand word"],
  ["company_legal_name_en_tail", "the rest of it"],
  ["company_legal_name_ar", "legal name in Arabic, empty when the profile has none"],
  ["company_legal_name_ar_head", "first word of it"],
  ["company_legal_name_ar_tail", "the rest of it"],
  ["company_address", "may be empty"],
  ["company_phone", "may be empty"],
  ["company_email", "may be empty"],
  ["letterhead_url", "same-origin path to the letterhead artwork"],
  ["logo_url", "uploaded logo; a 1×1 transparent GIF when there is none"],
  ["logo_state", "has-logo / no-logo, for a class attribute"],
];

const GUIDE_QUOTATION_TOKENS = [
  ["quote_number", "prefix + year + serial, or the number typed by the desk"],
  ["quote_date", "DD/MM/YYYY"],
  ["model", "vehicle model, ≤ 120 chars"],
  ["year", "model year, kept as text"],
  ["chassis", "chassis number"],
  ["comments", "optional desk note, ≤ 300 chars; empty when none"],
  ["currency", "from the company profile at issue time"],
  ["amount", "major units, thousands separated, 2 decimals"],
  ["amount_words", "English words, generated by the Worker"],
];

const GUIDE_AGREEMENT_TOKENS = [
  ["agreement_number", "SA-… for a sale, PA-… for a purchase"],
  ["agreement_date", "DD/MM/YYYY"],
  ["agreement_kind", "sale / purchase — for a class attribute"],
  ["agreement_kind_label", "Sale / Purchase — the word the heading prints"],
  ["currency", "from the snapshot taken at issue time"],
  ["notes", "optional desk note, ≤ 600 chars, one line"],
  ["notes_state", "has-notes / no-notes"],
];

const GUIDE_VEHICLE_TOKENS = [
  ["vehicle_model", "required"],
  ["vehicle_year", "required, kept as text"],
  ["vehicle_chassis", "required"],
  ["vehicle_plate", "optional — hide with {{vehicle_plate_state}}"],
  ["vehicle_color", "optional — hide with {{vehicle_color_state}}"],
  ["vehicle_odometer", "optional free text — hide with {{vehicle_odometer_state}}"],
  ["vehicle_registration_place", "optional — hide with {{vehicle_registration_place_state}}"],
];

const GUIDE_PARTY_TOKENS = [
  ["seller_name", "required"],
  ["seller_id_number", "optional — hide with {{seller_id_number_state}}"],
  ["seller_phone", "optional — hide with {{seller_phone_state}}"],
  ["seller_address", "optional — hide with {{seller_address_state}}"],
  ["buyer_name", "required"],
  ["buyer_id_number", "optional — hide with {{buyer_id_number_state}}"],
  ["buyer_phone", "optional — hide with {{buyer_phone_state}}"],
  ["buyer_address", "optional — hide with {{buyer_address_state}}"],
  ["intermediary_name", "optional: the broker is a party like the other two"],
  ["intermediary_id_number", "optional — hide with {{intermediary_id_number_state}}"],
  ["intermediary_phone", "optional — hide with {{intermediary_phone_state}}"],
  ["intermediary_address", "optional — hide with {{intermediary_address_state}}"],
  ["intermediary_state", "has-intermediary / no-intermediary — drops the whole block"],
];

const GUIDE_MONEY_TOKENS = [
  ["full_amount", "agreed price, 2 decimals"],
  ["full_amount_words", "generated by the Worker"],
  ["paid_amount", "deposit received; 0.00 when none"],
  ["paid_amount_words", "empty when nothing was paid"],
  ["balance", "full − paid, computed on every print"],
  ["balance_words", "generated on every print, so it always matches {{balance}}"],
];

/** The groups the guide shows for one sheet kind. */
function guideGroups(kind) {
  if (kind === "quotation") {
    return [
      { title: "Company profile — every sheet", tokens: GUIDE_COMPANY_TOKENS },
      { title: "Quotation record", tokens: GUIDE_QUOTATION_TOKENS },
    ];
  }
  return [
    { title: "Company profile — every sheet", tokens: GUIDE_COMPANY_TOKENS },
    { title: `${sheetLabel(kind)} record`, tokens: GUIDE_AGREEMENT_TOKENS },
    { title: "Vehicle", tokens: GUIDE_VEHICLE_TOKENS },
    { title: "Parties", tokens: GUIDE_PARTY_TOKENS },
    { title: "Money", tokens: GUIDE_MONEY_TOKENS },
  ];
}

/** Paints the placeholder table for the tab in focus. Text only: no template markup. */
function paintGuide() {
  const body = $("guideTokens");
  if (!body) return;
  const kind = state.templateKind;
  body.textContent = "";
  let count = 0;
  for (const group of guideGroups(kind)) {
    const wrap = document.createElement("div");
    wrap.className = "guide-group";
    const head = document.createElement("h5");
    head.textContent = group.title;
    const list = document.createElement("ul");
    for (const [name, note] of group.tokens) {
      const item = document.createElement("li");
      const code = document.createElement("code");
      code.textContent = `{{${name}}}`;
      const text = document.createElement("span");
      text.textContent = note;
      item.append(code, text);
      list.appendChild(item);
      count += 1;
    }
    wrap.append(head, list);
    body.appendChild(wrap);
  }
  $("guideKind").textContent = sheetLabel(kind);
  $("guideCount").textContent = `${count} placeholders`;
}

/**
 * Opens the tab a proof sheet gets written into, straight from the click handler and before any
 * await: a window opened after a round trip has lost the operator's gesture and gets blocked.
 * A4 pinned next to the editor used to cover the guide underneath it, so proofs are on request
 * and in their own tab now. Returns null when the browser refused the window.
 */
function openProofWindow() {
  const win = window.open("", "_blank");
  if (!win) {
    toast("Allow pop-ups for this site to open a proof sheet.", "error");
    return null;
  }
  win.document.write(
    "<!doctype html><title>Proof sheet</title>"
    + "<p style=\"margin:0;padding:28px;font:13px/1.5 Arial,Helvetica,sans-serif;color:#6e6a62\">"
    + "Rendering the sheet&hellip;</p>"
  );
  win.document.close();
  return win;
}

/**
 * Writes a server-rendered sheet into its proof tab. The new document inherits this tab's origin,
 * so the sheet's same-origin logo and letterhead load, but it does not inherit its path — hence
 * the <base>, without which every root-relative URL inside the sheet would go nowhere.
 */
function fillProofWindow(win, html, note) {
  if (!win || win.closed) return;
  const base = `<base href="${location.origin}/">`;
  const sheet = /<head[^>]*>/i.test(html)
    ? html.replace(/<head([^>]*)>/i, (tag) => `${tag}${base}`)
    : `${base}${html}`;
  win.document.open();
  win.document.write(sheet);
  win.document.close();
  if (note) studioHint(note);
}

/** Sets the status line under the editor's buttons: what the last proof was rendered from. */
function studioHint(text) {
  const note = $("studioNote");
  if (note) note.textContent = text;
}

/** One line under the preview: which sample record the sheet was proofed with. */
function sampleNote(data, prefix = "sample") {
  const sample = data?.sample || {};
  const number = sample.agreement_number || sample.quote_number || "next number";
  const kind = data?.kind && data.kind !== "quotation" ? sample.kind_label || sheetLabel(data.kind) : "";
  return [prefix, kind, number].filter(Boolean).join(" · ");
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
    item.textContent = `No versions yet — the built-in ${sheetLabel(state.templateKind).toLowerCase()} sheet prints until you publish one. Press "Load built-in" to start from it.`;
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

/** Paints the three sheet tabs: which kind is open and whether each one is live. */
function paintSheetKinds() {
  for (const tab of $("templateKinds").querySelectorAll(".studio-kind")) {
    const kind = tab.dataset.kind;
    const versions = state.templateSheets[kind] || [];
    const live = versions.find((t) => t.active);
    const status = tab.querySelector("small");
    if (status) {
      status.textContent = live ? `v${live.version} live`
        : versions.length ? "nothing live" : "built-in sheet";
    }
    tab.setAttribute("aria-selected", kind === state.templateKind ? "true" : "false");
  }
  paintGuide();
}

/** Blanks the studio and re-reads the versions of the company now in focus. */
async function refreshStudio() {
  $("templateList").textContent = "";
  $("templateHtml").value = "";
  $("templateName").value = "";
  $("editorHint").textContent = "flat {{placeholders}}";
  $("templateChip").textContent = "loading";
  $("templateMeta").textContent = "loading versions";
  studioHint("loading versions");
  await loadTemplates();
}

/** Switches the studio to another sheet kind; the editor buffer belongs to one kind only. */
async function selectSheetKind(kind) {
  if (!isSheetKind(kind) || kind === state.templateKind) return;
  state.templateKind = kind;
  state.templateEditId = null;
  state.templates = [];
  $("templateList").textContent = "";
  $("templateHtml").value = "";
  $("templateName").value = "";
  $("editorHint").textContent = "flat {{placeholders}}";
  $("templateChip").textContent = "loading";
  $("templateMeta").textContent = "loading versions";
  paintSheetKinds();
  const url = new URL(location.href);
  if (url.searchParams.get("view") === "settings") url.searchParams.set("sheet", kind);
  history.replaceState(null, "", url);
  studioHint(`loading ${sheetLabel(kind).toLowerCase()} versions`);
  await loadTemplates();
}

/**
 * Reads the versions of all three kinds at once, so the tabs can say which sheet is live
 * without a round trip every time the operator clicks between them. One kind's list also
 * becomes the editor's working set (state.templates).
 */
async function loadTemplates(selectId) {
  const company = activeCompany();
  $("templateList").textContent = "";
  if (!company) {
    state.templates = [];
    state.templateSheets = {};
    $("navTemplateSummary").textContent = "0 versions";
    $("templateChip").textContent = "no company";
    $("templateMeta").textContent = "no company selected";
    paintSheetKinds();
    return;
  }
  try {
    const lists = await Promise.all(SHEET_KINDS.map(({ kind }) =>
      api(`/api/companies/${encodeURIComponent(company.id)}/templates?kind=${encodeURIComponent(kind)}`)
        .then((data) => [kind, data.templates || []])
    ));
    /* the desk may have changed while this request was in flight */
    if (company.id !== state.companyId) return;
    state.templateSheets = {};
    for (const [kind, list] of lists) state.templateSheets[kind] = list;
  } catch (error) {
    toast(humanError(error), "error");
    return;
  }
  const versions = state.templateSheets[state.templateKind] || [];
  const label = sheetLabel(state.templateKind);
  const live = versions.find((t) => t.active);
  state.templates = versions;
  $("templateChip").textContent = live ? `${label} v${live.version} live` : `${label} · built-in`;
  $("templateMeta").textContent = live ? `live v${live.version}` : "no live version — the built-in sheet prints";
  const liveKinds = SHEET_KINDS.filter(({ kind }) => (state.templateSheets[kind] || []).some((t) => t.active));
  $("navTemplateSummary").textContent = `${liveKinds.length} of ${SHEET_KINDS.length} sheets live`;
  paintSheetKinds();
  renderVersionList();
  const target = selectId
    || (versions.some((t) => t.id === state.templateEditId) ? state.templateEditId : null)
    || live?.id;
  if (target) await openTemplate(target);
  else studioHint(`the built-in ${label.toLowerCase()} sheet prints until you publish one`);
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
    studioHint(`editing v${data.template.version} — Preview edits proofs the buffer in a new tab`);
  } catch (error) {
    toast(humanError(error), "error");
  }
}

/** Proofs one saved version in its own tab; the version rows' Preview button lands here. */
async function previewTemplate(template) {
  const company = activeCompany();
  if (!company) return;
  const win = openProofWindow();
  if (!win) return;
  try {
    const data = await api(
      `/api/companies/${encodeURIComponent(company.id)}/templates/${encodeURIComponent(template.id)}/preview`
    );
    fillProofWindow(win, data.html, sampleNote(data, `v${template.version}`));
  } catch (error) {
    if (!win.closed) win.close();
    toast(humanError(error), "error");
  }
}

/** Proofs the editor's buffer — unsaved edits included — without touching the stored versions. */
async function previewDraft() {
  const company = activeCompany();
  if (!company) return;
  const html = $("templateHtml").value;
  if (!html.trim()) { toast("The template cannot be empty.", "error"); return; }
  const win = openProofWindow();
  if (!win) return;
  try {
    const data = await api(`/api/companies/${encodeURIComponent(company.id)}/templates/preview`, {
      method: "POST",
      body: { html, kind: state.templateKind },
    });
    fillProofWindow(win, data.html, sampleNote(data, "unsaved edits"));
  } catch (error) {
    if (!win.closed) win.close();
    toast(humanError(error), "error");
  }
}

async function loadActiveTemplate() {
  const live = state.templates.find((t) => t.active);
  if (!live) { toast(`No live ${sheetLabel(state.templateKind).toLowerCase()} to reload — the built-in sheet prints.`, "error"); return; }
  await openTemplate(live.id);
  toast(`Live version v${live.version} loaded.`);
}

/** Loads the bundled sheet for the open kind into the editor, ready to customise. */
async function loadBuiltinSheet() {
  const company = activeCompany();
  if (!company) return;
  try {
    const data = await api(
      `/api/companies/${encodeURIComponent(company.id)}/templates/default?kind=${encodeURIComponent(state.templateKind)}`
    );
    state.templateEditId = null;
    markActiveVersion();
    $("templateHtml").value = data.html || "";
    $("templateName").value = "";
    $("editorHint").textContent = `built-in ${(data.label || sheetLabel(state.templateKind)).toLowerCase()}`;
    studioHint(`built-in ${(data.label || sheetLabel(state.templateKind)).toLowerCase()} loaded — Preview edits proofs it`);
    toast(`Built-in ${(data.label || sheetLabel(state.templateKind)).toLowerCase()} loaded — publish to make it yours.`);
  } catch (error) {
    toast(humanError(error), "error");
  }
}

async function publishTemplate() {
  const company = activeCompany();
  if (!company) return;
  const html = $("templateHtml").value;
  if (!html.trim()) { toast("The template cannot be empty.", "error"); return; }
  const activate = $("templateActivate").checked;
  const label = sheetLabel(state.templateKind);
  const name = $("templateName").value.trim() || `${label} v${(state.templates[0]?.version || 0) + 1}`;
  const button = $("templateSave");
  button.disabled = true;
  try {
    const data = await api(`/api/companies/${encodeURIComponent(company.id)}/templates`, {
      method: "POST",
      body: { html, name, activate, kind: state.templateKind },
    });
    toast(`${label} v${data.template.version} published${activate ? " and made live" : ""}.`);
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
    toast(`${sheetLabel(template.kind || state.templateKind)} v${template.version} is live.`);
    state.templateEditId = template.id;
    await loadTemplates(template.id);
  } catch (error) {
    toast(humanError(error), "error");
  }
}

async function deleteTemplate(template) {
  const company = activeCompany();
  if (!company) return;
  const label = sheetLabel(template.kind || state.templateKind);
  const okay = await confirmAction({
    title: `Delete ${label} v${template.version} (${template.name})?`,
    message: template.kind === "quotation"
      ? "Existing quotations keep their own snapshot."
      : "Existing agreements keep their own snapshot.",
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
  "template.saved": ["Print sheet published", "success"],
  "template.activated": ["Print sheet activated", "success"],
  "template.deleted": ["Print sheet deleted", "warning"],
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
  "agreement.created": ["Agreement issued", "success"],
  "agreement.updated": ["Agreement updated", "neutral"],
  "agreement.cancelled": ["Agreement moved to Deleted", "warning"],
  "agreement.restored": ["Agreement restored", "success"],
  "agreement.permanently_deleted": ["Agreement permanently deleted", "danger"],
  "agreement.scan_uploaded": ["Signed agreement uploaded", "success"],
  "agreement.scan_removed": ["Signed agreement removed", "warning"],
  "agreement.completed": ["Agreement marked completed", "success"],
  "agreement.reopened": ["Agreement reopened", "neutral"],
  "agreement.share_link_created": ["Agreement link created", "success"],
  "agreement.share_link_rotated": ["Agreement link renewed", "neutral"],
  "agreement.share_link_revoked": ["Agreement link revoked", "warning"],
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
  agreement_number: "Agreement number",
  kind: "Agreement type",
  full_amount_cents: "Agreed price",
  paid_amount_cents: "Paid on signing",
  vehicle_model: "Vehicle model",
  vehicle_year: "Vehicle year",
  vehicle_chassis: "Chassis number",
  vehicle_plate: "Plate",
  seller_name: "Seller",
  buyer_name: "Buyer",
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
  if (details.agreement_number) return `Agreement · ${details.agreement_number}`;
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
  if (event.entity === "agreement") return "Agreement record";
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
  if (event.action.startsWith("template.") && details.kind) {
    summaries.push(details.kind === "quotation" ? "Quotation sheet"
      : details.kind === "sale" ? "Sale agreement sheet" : "Purchase agreement sheet");
  }
  if (details.detached_records) summaries.push(`${details.detached_records} record(s) keep their snapshot`);
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
  if (details.full_amount_cents !== undefined && Number.isFinite(Number(details.full_amount_cents))) {
    const company = state.companies.find((item) => item.id === details.company_id);
    const currency = company?.currency || "Value";
    const amount = (Number(details.full_amount_cents) / 100).toLocaleString(undefined, {
      minimumFractionDigits: 2, maximumFractionDigits: 2,
    });
    summaries.push(`Agreed ${currency} ${amount}`);
  }
  if (details.kind) summaries.push(details.kind === "purchase" ? "Purchase agreement" : "Sale agreement");
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
  if ((key === "full_amount_cents" || key === "paid_amount_cents") && Number.isFinite(Number(value))) {
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
    detached_records: "Records retaining their snapshot",
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
    agreement_number: "Agreement number",
    kind: "Agreement type",
    full_amount_cents: "Agreed price (minor units)",
    paid_amount_cents: "Paid on signing (minor units)",
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
  if (pane === "audit") void loadAuditTrail();
}

function showView(name) {
  const view = ["desk", "settings", "modules", "agreements"].includes(name) ? name : "modules";
  state.settingsOpen = view === "settings";
  $("topbar").hidden = false;
  $("gate").hidden = true;
  $("modulesView").hidden = view !== "modules";
  $("workspaceView").hidden = view !== "desk";
  $("settingsView").hidden = view !== "settings";
  $("agreementsView").hidden = view !== "agreements";
  $("appVersionFooter").hidden = view === "modules";
  const moduleLanding = view === "modules";
  $("companySwitch").hidden = moduleLanding;
  $("topbarRule").hidden = moduleLanding;
  $("modulesLink").hidden = moduleLanding;
  $("settingsLink").hidden = view === "settings";
  const url = new URL(location.href);
  if (view === "settings") url.searchParams.set("view", "settings");
  else if (view === "desk") url.searchParams.set("view", "desk");
  else if (view === "agreements") url.searchParams.set("view", "agreements");
  else url.searchParams.delete("view");
  if (view !== "settings") {
    url.searchParams.delete("pane");
    url.searchParams.delete("sheet");
  }
  history.replaceState(null, "", url);
  if (view === "agreements") void loadAgreements();
}

async function openSettings(pane, sheet) {
  showView("settings");
  showSettingsPane(pane || new URLSearchParams(location.search).get("pane") || state.settingsPane || "company");
  /* ?sheet=sale opens the studio on that agreement page instead of the quotation */
  const wanted = sheet || new URLSearchParams(location.search).get("sheet");
  if (isSheetKind(wanted)) {
    state.templateKind = wanted;
    const url = new URL(location.href);
    url.searchParams.set("sheet", wanted);
    history.replaceState(null, "", url);
  }
  await refreshStudio();
}

async function signOut(message) {
  const previousStatus = state.status || {};
  try { await api("/api/auth/logout", { method: "POST" }); } catch { /* already gone */ }

  let freshStatus = null;
  try {
    freshStatus = await api("/api/auth/status", { cache: "no-store" });
  } catch { /* use the last known public authentication configuration */ }

  state.status = {
    ...(freshStatus || previousStatus),
    setup: freshStatus?.setup ?? previousStatus.setup ?? true,
    signed_in: false,
    session_hours: freshStatus?.session_hours || previousStatus.session_hours || 12,
    turnstile_site_key: freshStatus?.turnstile_site_key || previousStatus.turnstile_site_key || null,
  };
  state.quotes = [];
  state.agreements = [];
  state.agreementCounts = { sale: 0, purchase: 0 };
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
  else if (requestedView === "agreements" || requestedView === "invoicing") showView("agreements");
  else showView("modules");
}

function openModuleCard(card) {
  if (card.dataset.module === "quotations") {
    showView("desk");
  } else if (card.dataset.module === "agreements") {
    showView("agreements");
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
    const card = /** @type {Element} */ (event.target).closest(".module-choice[data-module]");
    if (card && moduleGrid.contains(card)) openModuleCard(card);
  });
  moduleGrid.addEventListener("keydown", (event) => {
    const card = /** @type {Element} */ (event.target).closest(".module-choice[data-module]");
    if (!card || !moduleGrid.contains(card)) return;
    const key = /** @type {KeyboardEvent} */ (event).key;
    if (key === "Enter" || key === " ") {
      event.preventDefault();
      openModuleCard(card);
    }
  });
  $("agreementsBack").addEventListener("click", () => showView("modules"));
  $("newAgreementBtn").addEventListener("click", () => openAgreementWizardFor());
  $("agreementKind").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-kind]");
    if (!button || button.dataset.kind === state.agreementKind) return;
    state.agreementKind = button.dataset.kind === "purchase" ? "purchase" : "sale";
    state.agreementSearch = "";
    $("agreementSearch").value = "";
    loadAgreements();
  });
  /* jumps straight to the sheet the open book prints with */
  $("agreementSheetBtn").addEventListener("click", () => {
    void openSettings("template", state.agreementKind);
  });
  $("agreementView").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-view]");
    if (!button || button.dataset.view === state.agreementView) return;
    state.agreementView = button.dataset.view === "deleted" ? "deleted" : "active";
    loadAgreements();
  });
  $("agreementSort").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-sort]");
    if (!button || button.dataset.sort === state.agreementSort) return;
    state.agreementSort = button.dataset.sort === "date" ? "date" : "number";
    loadAgreements();
  });
  let agreementSearchTimer = null;
  $("agreementSearch").addEventListener("input", () => {
    clearTimeout(agreementSearchTimer);
    const value = $("agreementSearch").value.trim();
    agreementSearchTimer = setTimeout(() => { state.agreementSearch = value; loadAgreements(); }, 260);
  });
  $("agreementSearchForm").addEventListener("submit", (event) => {
    event.preventDefault();
    state.agreementSearch = $("agreementSearch").value.trim();
    loadAgreements();
  });
  $("agreementsBody").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-agreement-action]");
    if (button) {
      event.preventDefault();
      event.stopPropagation();
      const id = button.dataset.agreementId;
      if (button.dataset.agreementAction === "restore") void restoreAgreement(id);
      else if (button.dataset.agreementAction === "permanent-delete") {
        void permanentlyDeleteAgreement(id, button.dataset.agreementNumber || "");
      }
      return;
    }
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    if (window.getSelection()?.toString()) return;
    const row = event.target.closest("tr[data-href]");
    if (row) location.href = row.dataset.href;
  });
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
  $("templateDefault").addEventListener("click", loadBuiltinSheet);
  $("templateKinds").addEventListener("click", (event) => {
    const tab = event.target.closest(".studio-kind");
    if (tab) void selectSheetKind(tab.dataset.kind);
  });
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
      if (!$("agreementsView").hidden) openAgreementWizardFor();
      else $("model").focus();
    }
  });
}

loadAppVersion();
bind();
boot();

export {};




