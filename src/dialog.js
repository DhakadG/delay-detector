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
