/* Challenger Quotation Desk — in-app confirmation prompt.
   Replaces window.confirm() so the question is part of the desk instead of a
   browser chrome popup (which cannot be styled, is blocked inside some
   download/print contexts and reads like a system error on mobile).
   A native <dialog> gives focus trapping, Escape handling and top-layer
   stacking for free; the markup only has to carry the desk aesthetic. */

/**
 * @typedef {Object} ConfirmOptions
 * @property {string} title     the question, usually ending in "?"
 * @property {string} [message] one line stating the consequence
 * @property {string} [confirm] label of the action button
 * @property {string} [cancel]  label of the safe button
 * @property {boolean} [danger] paint the action as destructive (default true)
 */

let modalCount = 0;

/**
 * Ask before a destructive action.
 * @param {ConfirmOptions} options
 * @returns {Promise<boolean>} true when the user picks the action
 */
export function confirmAction({
  title,
  message = "",
  confirm: confirmLabel = "Confirm",
  cancel: cancelLabel = "Keep",
  danger = true,
  expectedText = "",
  inputLabel = "",
}) {
  /* Anything older than Safari 15.4 / Firefox 98 would throw on showModal();
     fall back to the browser prompt rather than leaving the click dead. */
  if (typeof HTMLDialogElement === "undefined" || !HTMLDialogElement.prototype.showModal) {
    if (expectedText) {
      const promptText = (message ? title + "\\n\\n" + message + "\\n\\n" : title + "\\n\\n") + "Type exactly: " + expectedText;
      return Promise.resolve(window.prompt(promptText) === expectedText);
    }
    return Promise.resolve(window.confirm(message ? title + " " + message : title));
  }

  const suffix = String(++modalCount);
  const titleId = `modalTitle${suffix}`;

  const dialog = document.createElement("dialog");
  dialog.className = "modal";
  dialog.setAttribute("aria-labelledby", titleId);

  const card = document.createElement("div");
  card.className = "modal-card";

  const body = document.createElement("div");
  body.className = "modal-body";

  const eyebrow = document.createElement("p");
  eyebrow.className = "eyebrow";
  eyebrow.textContent = danger ? "Confirm · permanent" : "Confirm";

  const heading = document.createElement("h2");
  heading.className = "modal-title";
  heading.id = titleId;
  heading.textContent = title;

  body.append(eyebrow, heading);

  if (message) {
    const text = document.createElement("p");
    text.className = "modal-message";
    text.textContent = message;
    body.append(text);
  }

  let typedConfirmation = null;
  if (expectedText) {
    const label = document.createElement("label");
    label.className = "field modal-confirm-field";
    const caption = document.createElement("span");
    caption.className = "field-label";
    caption.textContent = inputLabel || "Type " + expectedText + " to confirm";
    typedConfirmation = document.createElement("input");
    typedConfirmation.type = "text";
    typedConfirmation.autocomplete = "off";
    typedConfirmation.spellcheck = false;
    typedConfirmation.setAttribute("aria-label", caption.textContent);
    label.append(caption, typedConfirmation);
    body.append(label);
  }

  const actions = document.createElement("div");
  actions.className = "modal-actions";

  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.className = "btn ghost";
  cancelBtn.textContent = cancelLabel;

  const okBtn = document.createElement("button");
  okBtn.type = "button";
  okBtn.className = danger ? "btn danger" : "btn primary";
  okBtn.textContent = confirmLabel;
  okBtn.disabled = Boolean(expectedText);

  actions.append(cancelBtn, okBtn);
  card.append(body, actions);
  dialog.append(card);

  return new Promise((resolve) => {
    let settled = false;

    /** @param {boolean} result */
    const finish = (result) => {
      if (settled) return;
      settled = true;
      dialog.close();
      dialog.remove();
      resolve(result);
    };

    cancelBtn.addEventListener("click", () => finish(false));
    okBtn.addEventListener("click", () => finish(true));
    if (typedConfirmation) {
      typedConfirmation.addEventListener("input", () => {
        okBtn.disabled = typedConfirmation.value !== expectedText;
      });
    }

    /* Escape must not close the dialog before we know the answer */
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      finish(false);
    });

    /* a click that lands on the backdrop (outside the card) dismisses */
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) finish(false);
    });

    document.body.append(dialog);
    dialog.showModal();
    /* focus the safe choice so a stray Enter never deletes anything */
    if (typedConfirmation) typedConfirmation.focus();
    else cancelBtn.focus();
  });
}
