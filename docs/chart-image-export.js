// The app supplies a complete, synchronously captured SVG with resolved theme
// colours, forecast bounds and source metadata. Rasterization needs no network.
export async function renderChartImage(snapshot) {
  const image = new Image();
  const url = URL.createObjectURL(new Blob([snapshot.svg], {type:'image/svg+xml;charset=utf-8'}));
  try {
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = () => reject(Error('Unable to render this chart image. You can still save its SVG.'));
      image.src = url;
    });
    const canvas = document.createElement('canvas'), scale = 2;
    canvas.width = Math.ceil(snapshot.width * scale);
    canvas.height = Math.ceil(snapshot.height * scale);
    const context = canvas.getContext('2d');
    if (!context) throw Error('PNG rendering is unavailable. You can still save the SVG.');
    // Fill the captured theme colour before SVG rasterization to keep edge pixels opaque.
    context.fillStyle = snapshot.background;
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(Error('Unable to create PNG. You can still save the SVG.')), 'image/png'));
    return {blob, filename:snapshot.filename, title:snapshot.title};
  } finally { URL.revokeObjectURL(url); }
}

export function downloadFile(blob, filename) {
  const url = URL.createObjectURL(blob), link = document.createElement('a');
  link.href = url; link.download = filename; document.body.append(link);
  link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

export function createChartImageMenu({root, getSnapshot, onOpen = () => {}}) {
  const menu = document.createElement('div');
  menu.id = 'chart-image-menu'; menu.className = 'chart-image-menu'; menu.hidden = true; menu.tabIndex = -1;
  menu.setAttribute('role', 'menu'); menu.setAttribute('aria-label', 'Chart image');
  const actions = ['copy','png','svg'].map((kind, i) => {
    const button = document.createElement('button'); button.type = 'button';
    button.dataset.action = kind; button.textContent = ['Copy image','Save PNG','Save SVG'][i];
    button.setAttribute('role', 'menuitem'); menu.append(button); return button;
  });
  const [copy, png, svg] = actions, message = document.createElement('p');
  message.setAttribute('role', 'status'); menu.append(message); document.body.append(menu);
  let snapshot = null, job = null, serial = 0, focusBack = null, closeTimer, preview, previewURL, openedScroll, renderError = null, busy = false;

  function close(restore = false) {
    serial++; clearTimeout(closeTimer); menu.hidden = true; snapshot = null; job = null; openedScroll = null; busy = false;
    focusBack?.setAttribute('aria-expanded', 'false');
    if (restore && focusBack?.isConnected) focusBack.focus({preventScroll:true});
  }

  function previewImage(result) {
    if (!preview) {
      preview = document.createElement('dialog'); preview.id = 'chart-image-preview'; preview.className = 'chart-image-preview';
      preview.setAttribute('aria-label', 'Chart image preview');
      const dismiss = document.createElement('button'), note = document.createElement('p'), link = document.createElement('a'), image = document.createElement('img');
      dismiss.type = 'button'; dismiss.className = 'secondary'; dismiss.textContent = 'Close'; dismiss.onclick = () => preview.close();
      note.textContent = 'Direct copying is unavailable in this browser. Hold or right-click the image to copy it, or use Save PNG.';
      link.textContent = 'Save PNG'; preview.append(dismiss, note, link, image); document.body.append(preview);
      preview.addEventListener('close', () => {
        URL.revokeObjectURL(previewURL); previewURL = null; image.removeAttribute('src'); link.removeAttribute('href');
        if (focusBack?.isConnected) focusBack.focus({preventScroll:true});
      });
    }
    if (previewURL) URL.revokeObjectURL(previewURL);
    previewURL = URL.createObjectURL(result.blob);
    const image = preview.querySelector('img'), link = preview.querySelector('a');
    image.src = previewURL; image.alt = result.title + ' forecast chart';
    link.href = previewURL; link.download = result.filename;
    if (!preview.open) preview.showModal();
  }

  async function perform(kind) {
    if (!snapshot || busy) return;
    const capture = snapshot, pending = job, token = serial;
    busy = true; actions.forEach(button => { button.disabled = true; });
    message.textContent = kind === 'copy' ? 'Copying image…' : kind === 'png' ? 'Preparing PNG…' : 'Preparing SVG…';
    try {
      if (kind === 'svg') {
        downloadFile(new Blob([capture.svg], {type:'image/svg+xml;charset=utf-8'}), capture.filename.replace(/\.png$/i, '.svg'));
      } else if (kind === 'copy') {
        try {
          if (!navigator.clipboard?.write || !globalThis.ClipboardItem) throw Error('Clipboard unavailable');
          // Initiate clipboard.write in the click handler, before any await.
          // The promise-backed item preserves Safari's user activation.
          await navigator.clipboard.write([new ClipboardItem({'image/png':pending.then(result => result.blob)})]);
        } catch {
          const result = await pending;
          if (token !== serial) return;
          close(); previewImage(result); return;
        }
      } else {
        const result = await pending;
        if (token !== serial) return;
        downloadFile(result.blob, result.filename);
      }
      if (token === serial) {
        message.textContent = kind === 'copy' ? 'Image copied.' : kind === 'png' ? 'PNG download started.' : 'SVG download started.';
        closeTimer = setTimeout(() => close(true), 1200);
      }
    } catch (error) {
      if (token === serial) message.textContent = error.message || 'Unable to prepare this chart image.';
    } finally {
      if (token === serial) { busy = false; copy.disabled = png.disabled = !!renderError; svg.disabled = false; }
    }
  }
  actions.forEach(button => button.addEventListener('click', () => { void perform(button.dataset.action); }));

  function open(chart, position, trigger = chart) {
    close(); focusBack = trigger; const token = serial;
    message.textContent = ''; renderError = null; actions.forEach(button => { button.disabled = false; });
    try {
      onOpen(); snapshot = getSnapshot(chart); job = renderChartImage(snapshot);
      job.catch(error => {
        if (token !== serial) return;
        renderError = error; copy.disabled = png.disabled = true;
        if (!busy) message.textContent = error.message;
      });
    } catch (error) {
      snapshot = null; actions.forEach(button => { button.disabled = true; }); message.textContent = error.message;
    }
    menu.hidden = false; trigger.setAttribute('aria-expanded', 'true');
    openedScroll = {x:scrollX,y:scrollY};
    const box = menu.getBoundingClientRect(), anchor = trigger.getBoundingClientRect();
    menu.style.left = Math.max(8, Math.min(position?.x ?? anchor.left, document.documentElement.clientWidth - box.width - 8)) + 'px';
    menu.style.top = Math.max(8, Math.min(position?.y ?? anchor.bottom, document.documentElement.clientHeight - box.height - 8)) + 'px';
    (copy.disabled ? menu : copy).focus({preventScroll:true});
  }

  function setup() {
    for (const panel of root.querySelectorAll('.chart-card')) {
      const chart = panel.querySelector('.plot'), button = panel.querySelector('.chart-image-button');
      if (!chart || !button || button.dataset.imageMenuReady) continue;
      button.dataset.imageMenuReady = 'true';
      for (const trigger of [button, chart]) {
        trigger.setAttribute('aria-haspopup', 'menu'); trigger.setAttribute('aria-expanded', 'false'); trigger.setAttribute('aria-controls', menu.id);
      }
      button.addEventListener('click', () => { if (!menu.hidden && focusBack === button) close(true); else open(chart, null, button); });
      chart.addEventListener('keydown', event => {
        if (event.key === 'ContextMenu' || event.shiftKey && event.key === 'F10') {
          event.preventDefault(); event.stopPropagation(); open(chart, null, chart);
        }
      });
    }
  }
  root.addEventListener('contextmenu', event => {
    const chart = event.target.closest('.plot');
    if (!chart || !root.contains(chart)) return;
    event.preventDefault(); event.stopPropagation(); open(chart, {x:event.clientX,y:event.clientY});
  });
  document.addEventListener('pointerdown', event => { if (!menu.hidden && !menu.contains(event.target) && !(focusBack?.matches('.chart-image-button') && focusBack.contains(event.target))) close(); }, true);
  document.addEventListener('keydown', event => {
    if (menu.hidden) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); }
    else if (['ArrowDown','ArrowUp','Home','End'].includes(event.key)) {
      event.preventDefault(); event.stopPropagation();
      const enabled = actions.filter(button => !button.disabled), current = enabled.indexOf(document.activeElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? enabled.length - 1 : (current + (event.key === 'ArrowUp' ? -1 : 1) + enabled.length) % enabled.length;
      enabled[next]?.focus();
    } else if (event.key === 'Tab') close(true);
  }, true);
  window.addEventListener('resize', () => close());
  window.addEventListener('scroll', () => { if (openedScroll && (scrollX !== openedScroll.x || scrollY !== openedScroll.y)) close(); }, true);
  return {open, close, setup};
}
