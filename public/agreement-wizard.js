/* Vehicle agreement wizard — six steps, one dialog, one POST.
   The wizard collects the paper; the Worker still allocates the number, writes the
   amounts in words and snapshots the template and company profile at issue time.
   Nothing here decides a figure the record will later disagree with. */

/** @param {string} id @returns {any} */
const $ = (id) => document.getElementById(id);

const STEPS = 6;
const STEP_TITLES = { sale: "Sale agreement", purchase: "Purchase agreement" };

/** The free-text columns, in the order the form asks for them. */
const TEXT_FIELDS = {
  vehicle_model: "awModel",
  vehicle_year: "awYear",
  vehicle_chassis: "awChassis",
  vehicle_plate: "awPlate",
  vehicle_color: "awColor",
  vehicle_odometer: "awOdometer",
  vehicle_registration_place: "awRegistration",
  seller_name: "awSellerName",
  seller_id_number: "awSellerId",
  seller_phone: "awSellerPhone",
  seller_address: "awSellerAddress",
  buyer_name: "awBuyerName",
  buyer_id_number: "awBuyerId",
  buyer_phone: "awBuyerPhone",
  buyer_address: "awBuyerAddress",
  intermediary_name: "awIntermediaryName",
  intermediary_phone: "awIntermediaryPhone",
  intermediary_commission: "awIntermediaryCommission",
};

/** What each step refuses to move past, and how it says so. */
const STEP_REQUIREMENTS = {
  2: [
    ["vehicle_model", "Enter the vehicle model."],
    ["vehicle_year", "Enter the vehicle year."],
    ["vehicle_chassis", "Enter the chassis number."],
  ],
  3: [
    ["seller_name", "Enter the seller's name."],
    ["buyer_name", "Enter the buyer's name."],
  ],
};

/** @type {Array<[string, (v: Record<string, string>) => string]>} */
const REVIEW_ROWS = [
  ["Vehicle", (v) => [v.vehicle_model, v.vehicle_year].filter(Boolean).join(" · ")],
  ["Chassis", (v) => v.vehicle_chassis],
  ["Plate", (v) => v.vehicle_plate],
  ["Colour", (v) => v.vehicle_color],
  ["Odometer", (v) => v.vehicle_odometer],
  ["Registered in", (v) => v.vehicle_registration_place],
  ["Seller", (v) => [v.seller_name, v.seller_id_number && `ID ${v.seller_id_number}`, v.seller_phone]
    .filter(Boolean).join(" · ")],
  ["Seller address", (v) => v.seller_address],
  ["Buyer", (v) => [v.buyer_name, v.buyer_id_number && `ID ${v.buyer_id_number}`, v.buyer_phone]
    .filter(Boolean).join(" · ")],
  ["Buyer address", (v) => v.buyer_address],
  ["Intermediary", (v) => [v.intermediary_name, v.intermediary_phone, v.intermediary_commission]
    .filter(Boolean).join(" · ")],
  ["Notes", (v) => v.notes],
];

const state = {
  companyId: null,
  currency: "AED",
  kind: "sale",
  step: 1,
  busy: false,
  numberRequest: 0,
  onCreated: null,
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

const todayIso = () => {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
};

/** Blank is zero — a deposit may legitimately be left out. */
const parseMoney = (value) => {
  const raw = String(value ?? "").replace(/,/g, "").trim();
  if (!raw) return 0;
  const amount = Number(raw);
  if (!Number.isFinite(amount) || amount < 0 || amount > 99999999.99) return null;
  return Math.round(amount * 100);
};

const money = (cents) => (cents / 100).toLocaleString(undefined, {
  minimumFractionDigits: 2, maximumFractionDigits: 2,
});

const kindNow = () => {
  /** @type {HTMLInputElement | null} */
  const picked = document.querySelector('input[name="aw_kind"]:checked');
  return picked && picked.value === "purchase" ? "purchase" : "sale";
};

const fieldValue = (id) => String($(id).value ?? "").trim();

const collect = () => {
  const values = { notes: fieldValue("awNotes") };
  for (const [field, id] of Object.entries(TEXT_FIELDS)) values[field] = fieldValue(id);
  return values;
};

/** Server codes the wizard can meet, said in the desk's own words. */
const message = (error) => {
  const map = {
    agreement_fields_required: "Fill the required fields before issuing the agreement.",
    invalid_agreement_kind: "Pick a sale or a purchase agreement.",
    invalid_agreement_date: "Enter a valid agreement date.",
    invalid_full_amount: "Enter the agreed price between 0 and 99,999,999.99.",
    invalid_paid_amount: "Enter the amount paid between 0 and 99,999,999.99.",
    paid_amount_exceeds_full: "The amount paid cannot be larger than the agreed price.",
    company_not_found: "That company no longer exists. Reload the desk.",
    company_id_required: "Choose a company before issuing an agreement.",
    numbering_exhausted: "A number could not be allocated. Try issuing again.",
    unauthorized: "Your session expired. Reload and sign in.",
  };
  return map[error?.message] || error?.message || "The agreement could not be issued.";
};

function showError(text) {
  const node = $("awError");
  node.textContent = text;
  node.hidden = false;
}

function hideError() {
  const node = $("awError");
  node.hidden = true;
  node.textContent = "";
}

/** The running balance under the two amount fields: what the paper will print. */
function paintBalance() {
  const full = parseMoney($("awFull").value);
  const paid = parseMoney($("awPaid").value);
  const node = $("awBalance");
  if (full === null || paid === null) {
    node.textContent = "Enter both amounts as numbers.";
    node.dataset.state = "bad";
    return;
  }
  node.dataset.state = paid > full ? "bad" : "ok";
  node.textContent = paid > full
    ? "The amount paid is larger than the agreed price."
    : `Balance to be settled: ${state.currency} ${money(Math.max(full - paid, 0))}`;
}

async function refreshNumber() {
  const requestId = ++state.numberRequest;
  const field = $("awNumber");
  field.value = "";
  if (!state.companyId) return;
  const date = $("awDate").value || todayIso();
  const kind = kindNow();
  try {
    const query = new URLSearchParams({ company_id: state.companyId, kind, date });
    const data = await api(`/api/agreements/next-number?${query.toString()}`);
    if (requestId !== state.numberRequest) return;
    field.value = data.agreement_number || "";
  } catch {
    if (requestId === state.numberRequest) field.value = "";
  }
}

/** The last step repeats everything in plain sentences, so the paper is read twice. */
function paintReview() {
  const values = collect();
  const full = parseMoney($("awFull").value) ?? 0;
  const paid = parseMoney($("awPaid").value) ?? 0;
  const list = $("awReview");
  list.textContent = "";

  const rows = [
    ["Paper", `${STEP_TITLES[kindNow()]} · ${$("awDate").value || todayIso()}`],
    ...REVIEW_ROWS.map(([label, pick]) => [label, pick(values)]),
    ["Agreed price", `${state.currency} ${money(full)}`],
    ["Paid now", paid ? `${state.currency} ${money(paid)}` : "Nothing paid at signing"],
    ["Balance", `${state.currency} ${money(Math.max(full - paid, 0))}`],
  ];

  for (const [label, value] of rows) {
    const text = String(value ?? "").trim();
    /* optional columns that were left blank simply do not appear */
    if (!text) continue;
    const row = document.createElement("div");
    const term = document.createElement("dt");
    term.textContent = label;
    const detail = document.createElement("dd");
    detail.textContent = text;
    row.append(term, detail);
    list.appendChild(row);
  }
  $("awNumberReview").textContent = $("awNumber").value || "allocated at issue";
}


function paintStep() {
  for (const section of $("awForm").querySelectorAll(".wizard-step")) {
    section.hidden = Number(section.dataset.step) !== state.step;
  }
  for (const item of $("awSteps").children) {
    const index = Number(item.dataset.step);
    item.classList.toggle("is-current", index === state.step);
    item.classList.toggle("is-done", index < state.step);
    if (index === state.step) item.setAttribute("aria-current", "step");
    else item.removeAttribute("aria-current");
  }
  $("awCount").textContent = `Step ${state.step} of ${STEPS}`;
  $("awTitle").textContent = STEP_TITLES[kindNow()] || "Agreement";
  $("awBack").hidden = state.step === 1;
  $("awNext").hidden = state.step === STEPS;
  $("awCreate").hidden = state.step !== STEPS;
  hideError();
  paintBalance();
  if (state.step === STEPS) paintReview();
  const section = $("awForm").querySelector(`.wizard-step[data-step="${state.step}"]`);
  const first = section?.querySelector('input:not([type="radio"]), textarea');
  if (first) {
    try { first.focus({ preventScroll: true }); } catch { first.focus(); }
  }
}

/** Each step answers for itself; nothing is sent until the last one. */
function validate() {
  if (state.step === 1) {
    if (!$("awDate").value) return "Choose the agreement date.";
    return "";
  }
  for (const [field, said] of STEP_REQUIREMENTS[state.step] || []) {
    if (!fieldValue(TEXT_FIELDS[field])) {
      $(TEXT_FIELDS[field]).focus();
      return said;
    }
  }
  if (state.step === 4) {
    const full = parseMoney($("awFull").value);
    if (full === null || full <= 0) {
      $("awFull").focus();
      return "Enter the agreed price for the vehicle.";
    }
    const paid = parseMoney($("awPaid").value);
    if (paid === null) {
      $("awPaid").focus();
      return "Enter the amount paid as a number, or leave it blank.";
    }
    if (paid > full) {
      $("awPaid").focus();
      return "The amount paid cannot be larger than the agreed price.";
    }
  }
  return "";
}

function next() {
  const problem = validate();
  if (problem) {
    showError(problem);
    return;
  }
  if (state.step === STEPS) {
    void submit();
    return;
  }
  state.step += 1;
  paintStep();
}

function back() {
  if (state.step === 1) return;
  state.step -= 1;
  paintStep();
}

async function submit() {
  if (state.busy) return;
  if (!$("awDate").value) {
    state.step = 1;
    paintStep();
    showError("Choose the agreement date.");
    return;
  }
  const button = $("awCreate");
  const values = collect();
  const payload = {
    company_id: state.companyId,
    kind: kindNow(),
    agreement_date: $("awDate").value,
    ...values,
    full_amount: fieldValue("awFull"),
    paid_amount: fieldValue("awPaid"),
    currency: state.currency,
  };
  state.busy = true;
  button.disabled = true;
  try {
    const data = await api("/api/agreements", { method: "POST", body: payload });
    $("agreementWizard").close();
    state.onCreated?.(data.agreement);
  } catch (error) {
    if (error.status === 401) {
      location.href = "/";
      return;
    }
    showError(message(error));
  } finally {
    state.busy = false;
    button.disabled = false;
  }
}

/** A fresh sheet: kind back to the book the desk is in, date today, fields empty. */
function resetForm() {
  for (const id of Object.values(TEXT_FIELDS)) $(id).value = "";
  $("awNotes").value = "";
  $("awFull").value = "";
  $("awPaid").value = "";
  $("awDate").value = todayIso();
  $("awNumber").value = "";
  /** @type {NodeListOf<HTMLInputElement>} */
  const kinds = document.querySelectorAll('input[name="aw_kind"]');
  for (const radio of kinds) {
    radio.checked = radio.value === state.kind;
  }
  hideError();
}

/**
 * Opens the wizard on a given book. The caller owns the toast and the reload, so the
 * dialog itself never decides what the ledger does next.
 * @param {{ companyId?: string|null, currency?: string, kind?: string, onCreated?: (agreement: any) => void }} options
 * @returns {boolean} whether the wizard opened
 */
export function openAgreementWizard({ companyId = null, currency = "AED", kind = "sale", onCreated = null } = {}) {
  const dialog = $("agreementWizard");
  if (!dialog || !companyId) return false;
  state.companyId = companyId;
  state.currency = currency || "AED";
  state.kind = kind === "purchase" ? "purchase" : "sale";
  state.onCreated = onCreated;
  state.busy = false;
  state.numberRequest += 1;
  resetForm();
  $("awCurrency").textContent = state.currency;
  $("awCurrencyTag").textContent = state.currency;
  state.step = 1;
  paintStep();
  if (!dialog.open) dialog.showModal();
  void refreshNumber();
  return true;
}


/* --------------------------------------------------------------- binding ---- */

const dialog = $("agreementWizard");
if (dialog) {
  $("awNext").addEventListener("click", next);
  $("awBack").addEventListener("click", back);
  $("awClose").addEventListener("click", () => dialog.close());
  $("awForm").addEventListener("submit", (event) => {
    event.preventDefault();
    void submit();
  });
  /* Enter walks the wizard; a textarea keeps its own newlines. */
  $("awForm").addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.target.tagName === "TEXTAREA") return;
    event.preventDefault();
    next();
  });
  $("awKind").addEventListener("change", () => {
    state.kind = kindNow();
    $("awTitle").textContent = STEP_TITLES[state.kind] || "Agreement";
    void refreshNumber();
  });
  $("awDate").addEventListener("change", () => { void refreshNumber(); });
  $("awFull").addEventListener("input", paintBalance);
  $("awPaid").addEventListener("input", paintBalance);
  /* a cancelled dialog is not a failed one: the next open starts from a clean sheet */
  dialog.addEventListener("close", () => {
    state.busy = false;
    $("awCreate").disabled = false;
    hideError();
  });
}

export default openAgreementWizard;

