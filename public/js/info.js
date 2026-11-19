// Bulles d'aide « i » : <button class="ibtn" data-info="clé">i</button>.
// Un clic ouvre la bulle, un second clic, Échap ou un clic ailleurs la ferme.

export const ibtn = (key) => `<button type="button" class="ibtn" data-info="${key}" aria-label="Plus d'informations" aria-expanded="false">i</button>`;

export function initInfo(texts) {
  const pop = document.createElement('div');
  pop.className = 'info-pop';
  pop.setAttribute('role', 'tooltip');
  pop.hidden = true;
  document.body.append(pop);
  let owner = null;

  const close = () => {
    if (!owner) return;
    owner.setAttribute('aria-expanded', 'false');
    owner.classList.remove('open');
    owner = null;
    pop.hidden = true;
  };

  const open = (btn) => {
    const t = texts[btn.dataset.info];
    if (!t) return;
    close();
    owner = btn;
    btn.classList.add('open');
    btn.setAttribute('aria-expanded', 'true');
    pop.innerHTML = `${t.title ? `<b>${t.title}</b>` : ''}${t.html}`;
    pop.hidden = false;
    const r = btn.getBoundingClientRect();
    const vw = window.innerWidth, vh = window.innerHeight;
    const w = pop.offsetWidth, h = pop.offsetHeight;
    let x = Math.min(Math.max(12, r.left + r.width / 2 - w / 2), vw - w - 12);
    let y = r.bottom + 8;
    if (y + h > vh - 12) y = Math.max(12, r.top - h - 8);
    pop.style.left = `${x}px`;
    pop.style.top = `${y}px`;
  };

  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.ibtn');
    if (btn) {
      // Ne pas cocher une case ni ouvrir un <details> parent.
      e.preventDefault();
      e.stopPropagation();
      btn === owner ? close() : open(btn);
      return;
    }
    if (owner && !pop.contains(e.target)) close();
  }, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  window.addEventListener('resize', close);
  // Fermer seulement si c'est le conteneur du bouton qui défile (pas la console qui reçoit des lignes).
  document.addEventListener('scroll', (e) => {
    if (owner && (e.target === document || e.target.contains?.(owner))) close();
  }, true);
}
