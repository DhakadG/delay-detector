// Replaces a native <select>'s popup with a styled listbox — the native
// options list is OS-chrome and can't be restyled cross-browser. The
// <select> stays in the DOM as the source of truth (value, hidden,
// dispatchEvent('change')) so the rest of the app never has to know this
// exists; this only changes what the user clicks.
export function enhanceSelect(select) {
  select.classList.add('dd-native');

  const wrap = document.createElement('div');
  wrap.className = 'dd';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'dd-btn';
  const list = document.createElement('div');
  list.className = 'dd-list';
  list.hidden = true;
  wrap.append(btn, list);
  select.after(wrap);

  function close() {
    list.hidden = true;
    document.removeEventListener('pointerdown', onDocPointer);
  }
  function onDocPointer(e) {
    if (!wrap.contains(e.target)) close();
  }
  function open() {
    if (select.disabled || !select.options.length) return;
    list.hidden = false;
    document.addEventListener('pointerdown', onDocPointer);
  }

  function sync() {
    list.innerHTML = '';
    [...select.options].forEach((opt, i) => {
      const item = document.createElement('div');
      item.className = 'dd-item' + (opt.selected ? ' sel' : '') + (opt.dataset.virtual ? ' virtual' : '');
      item.setAttribute('role', 'option');
      item.textContent = opt.textContent;
      item.onclick = () => {
        select.selectedIndex = i;
        select.dispatchEvent(new Event('change'));
        close();
      };
      list.appendChild(item);
    });
    const current = select.options[select.selectedIndex];
    btn.textContent = current ? current.textContent : '(no devices found)';
    btn.disabled = select.disabled || !select.options.length;
    wrap.hidden = select.hidden;
  }

  btn.onclick = () => (list.hidden ? open() : close());
  select.addEventListener('change', sync);
  // fill() in app.js rebuilds <option> children directly and flips
  // .hidden — a MutationObserver is the only way to stay in sync without
  // every caller having to remember to call refresh() by hand.
  new MutationObserver(sync).observe(select, {
    childList: true, attributes: true, attributeFilter: ['hidden', 'disabled'],
  });

  sync();
}
