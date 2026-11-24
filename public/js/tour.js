// Démo guidée : met en lumière une zone de l'écran et l'explique, étape par étape.
// step : { target?: sélecteur, title, body (HTML), before?: () => void, actions?: [{ label, primary, run }] }

export function startTour(steps, { onClose, start = 0 } = {}) {
  let i = 0;
  const returnFocus = document.activeElement;
  const root = document.createElement('div');
  root.className = 'tour';
  root.innerHTML = `
    <div class="tour-spot"></div>
    <div class="tour-card" role="dialog" aria-modal="true" aria-labelledby="tour-title" tabindex="-1">
      <div class="tour-step" role="status" aria-live="polite"></div>
      <h3 class="tour-title" id="tour-title"></h3>
      <div class="tour-body"></div>
      <div class="tour-nav">
        <button class="ghost small tour-skip">Passer la démo</button>
        <span class="grow"></span>
        <button class="ghost tour-prev">Précédent</button>
        <button class="primary tour-next">Suivant</button>
      </div>
    </div>`;
  document.body.append(root);
  const spot = root.querySelector('.tour-spot');
  const card = root.querySelector('.tour-card');

  const close = () => {
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', place);
    root.remove();
    if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
    onClose?.();
  };

  function place() {
    const step = steps[i];
    const el = step.target && document.querySelector(step.target);
    const vw = window.innerWidth, vh = window.innerHeight;
    if (!el) {
      spot.style.cssText = `left:${vw / 2}px;top:${vh / 2}px;width:0;height:0`;
      card.style.left = `${Math.max(16, (vw - card.offsetWidth) / 2)}px`;
      card.style.top = `${Math.max(16, (vh - card.offsetHeight) / 2)}px`;
      return;
    }
    const r = el.getBoundingClientRect();
    const pad = 6;
    spot.style.cssText = `left:${r.left - pad}px;top:${r.top - pad}px;width:${r.width + pad * 2}px;height:${r.height + pad * 2}px`;
    const cw = card.offsetWidth, ch = card.offsetHeight, gap = 16;
    const clampX = (x) => Math.min(Math.max(16, x), vw - cw - 16);
    const clampY = (y) => Math.min(Math.max(16, y), vh - ch - 16);
    let x, y;
    if (r.right + gap + cw < vw - 8) { x = r.right + gap; y = clampY(r.top); }
    else if (r.left - gap - cw > 8) { x = r.left - gap - cw; y = clampY(r.top); }
    else if (r.bottom + gap + ch < vh - 8) { x = clampX(r.left); y = r.bottom + gap; }
    else if (r.top - gap - ch > 8) { x = clampX(r.left); y = r.top - gap - ch; }
    else { x = clampX((vw - cw) / 2); y = clampY(vh - ch - 16); }
    card.style.left = `${x}px`;
    card.style.top = `${y}px`;
  }

  function show(n) {
    i = Math.max(0, Math.min(steps.length - 1, n));
    const step = steps[i];
    step.before?.();
    root.querySelector('.tour-step').textContent = `${i + 1} / ${steps.length}`;
    root.querySelector('.tour-title').textContent = step.title;
    root.querySelector('.tour-body').innerHTML = step.body;
    root.querySelector('.tour-prev').disabled = i === 0;
    const next = root.querySelector('.tour-next');
    const last = i === steps.length - 1;
    next.textContent = last ? 'Terminer' : 'Suivant';
    root.querySelector('.tour-skip').hidden = last;
    const extra = root.querySelector('.tour-actions');
    extra?.remove();
    if (step.actions) {
      const box = document.createElement('div');
      box.className = 'tour-actions';
      for (const a of step.actions) {
        const b = document.createElement('button');
        b.textContent = a.label;
        b.className = a.primary ? 'primary' : 'ghost';
        b.onclick = () => { close(); a.run(); };
        box.append(b);
      }
      root.querySelector('.tour-body').after(box);
    }
    const el = step.target && document.querySelector(step.target);
    if (el) el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    requestAnimationFrame(place);
    next.focus({ preventScroll: true });
  }

  // Capture : les flèches pilotent la démo, pas la machine.
  function onKey(e) {
    if (e.key === 'Tab') {
      const focusable = [...card.querySelectorAll('button:not(:disabled):not([hidden])')];
      if (!focusable.length) {
        e.preventDefault();
        card.focus();
      } else if (e.shiftKey && document.activeElement === focusable[0]) {
        e.preventDefault();
        focusable[focusable.length - 1].focus();
      } else if (!e.shiftKey && document.activeElement === focusable[focusable.length - 1]) {
        e.preventDefault();
        focusable[0].focus();
      }
      return;
    }
    if (['ArrowRight', 'ArrowLeft', 'ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', '+', '=', '-', 'Escape'].includes(e.key)) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
    if (e.key === 'Escape') close();
    else if (e.key === 'ArrowRight') { if (i === steps.length - 1) close(); else show(i + 1); }
    else if (e.key === 'ArrowLeft') show(i - 1);
  }

  root.querySelector('.tour-next').onclick = () => (i === steps.length - 1 ? close() : show(i + 1));
  root.querySelector('.tour-prev').onclick = () => show(i - 1);
  root.querySelector('.tour-skip').onclick = close;
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('resize', place);
  show(start);
  return { close };
}
