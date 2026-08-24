// In-page dialogs built on <dialog>, replacing window.confirm().
// Native confirm() is a synchronous, OS-chrome modal that blocks the whole
// page — it cannot be styled, it says "delay.losthusky.qzz.io says", and it
// freezes the audio meter while it is open.
let host = null;

function ensureHost() {
  if (host) return host;
  host = document.createElement('dialog');
  host.className = 'modal';
  document.body.appendChild(host);
  return host;
}

/**
 * Numeric input dialog. Replaces window.prompt for the same reasons confirmDialog
 * replaces window.confirm: it cannot be styled, it is branded with the hostname,
 * and it blocks the whole page including the audio meter while it is open.
 * @returns {Promise<number|null>} the value, or null if cancelled.
 */
export function promptNumber({
  title, body, value = '', min = null, max = null, unit = '', confirmText = 'Save',
}) {
  const d = ensureHost();
  d.innerHTML = `
    <form method="dialog" class="modal-inner">
      <h3 class="modal-title"></h3>
      <p class="modal-body"></p>
      <div class="modal-field">
        <input type="number" class="modal-input" step="any">
        <span class="modal-unit"></span>
      </div>
      <p class="modal-error" hidden></p>
      <div class="modal-actions">
        <button value="cancel" class="ghost-btn" type="submit">Cancel</button>
        <button value="ok" class="btn primary" type="submit"></button>
      </div>
    </form>`;
  d.querySelector('.modal-title').textContent = title;
  d.querySelector('.modal-body').textContent = body;
  d.querySelector('.modal-unit').textContent = unit;
  d.querySelector('[value="ok"]').textContent = confirmText;

  const input = d.querySelector('.modal-input');
  const err = d.querySelector('.modal-error');
  input.value = value;
  if (min != null) input.min = String(min);
  if (max != null) input.max = String(max);

  return new Promise((resolve) => {
    const form = d.querySelector('form');
    // Validate before the dialog closes, so a bad value can be corrected in place
    // instead of silently becoming null.
    form.addEventListener('submit', (e) => {
      if (e.submitter?.value !== 'ok') return;
      const n = Number(input.value);
      if (!Number.isFinite(n) || (min != null && n < min) || (max != null && n > max)) {
        e.preventDefault();
        err.hidden = false;
        err.textContent = `Enter a number${min != null && max != null ? ` between ${min} and ${max}` : ''}.`;
        input.focus();
      }
    });
    const onClose = () => {
      d.removeEventListener('close', onClose);
      resolve(d.returnValue === 'ok' ? Number(input.value) : null);
    };
    d.addEventListener('close', onClose);
    d.showModal();
    input.focus();
    input.select();
  });
}

/**
 * @returns {Promise<boolean>} true if confirmed.
 */
export function confirmDialog({
  title, body, confirmText = 'Confirm', cancelText = 'Cancel', danger = false,
}) {
  const d = ensureHost();
  d.innerHTML = `
    <form method="dialog" class="modal-inner">
      <h3 class="modal-title"></h3>
      <p class="modal-body"></p>
      <div class="modal-actions">
        <button value="cancel" class="ghost-btn" type="submit"></button>
        <button value="ok" class="btn ${danger ? 'danger' : 'primary'}" type="submit"></button>
      </div>
    </form>`;
  d.querySelector('.modal-title').textContent = title;
  d.querySelector('.modal-body').textContent = body;
  d.querySelector('[value="cancel"]').textContent = cancelText;
  d.querySelector('[value="ok"]').textContent = confirmText;

  return new Promise((resolve) => {
    const onClose = () => {
      d.removeEventListener('close', onClose);
      resolve(d.returnValue === 'ok');
    };
    d.addEventListener('close', onClose);
    d.showModal();
    // Focus the safe option, so a stray Enter never confirms a destructive action.
    d.querySelector('[value="cancel"]').focus();
  });
}
