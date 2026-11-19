import { Viewer, outline } from './viewer.js';
import { startTour } from './tour.js';
import { Preview } from './preview.js';
import { splitProgram, analyze, buildResume } from './shared/gcode.js';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const store = {
  get(k, d) { try { const v = localStorage.getItem('copeau.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('copeau.' + k, JSON.stringify(v)); } catch {} },
};

const S = {
  machine: { connected: false, ready: false, status: { state: 'Déconnecté', wpos: { X: 0, Y: 0, Z: 0 }, mpos: { X: 0, Y: 0, Z: 0 }, ov: {} }, modal: {} },
  job: null,
  lines: [],
  info: null,
  settings: {},
  macros: [],
  zones: { table: null, zone: null },
};

// ---- WebSocket ------------------------------------------------------------

let ws;
let reqId = 0;
const pending = new Map();

function connectWs() {
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`);
  ws.onopen = () => { refreshPorts(); loadMacros(); };
  ws.onmessage = (e) => onMessage(JSON.parse(e.data));
  ws.onclose = () => {
    for (const p of pending.values()) p.reject(new Error('Serveur injoignable'));
    pending.clear();
    setBadge('Serveur perdu', 'alarm');
    setTimeout(connectWs, 1500);
  };
}

function request(t, payload = {}) {
  return new Promise((resolve, reject) => {
    if (ws?.readyState !== 1) return reject(new Error('Serveur injoignable'));
    const id = ++reqId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ t, id, ...payload }));
  });
}

// Requête dont l'erreur s'affiche en toast.
const act = (t, payload) => request(t, payload).catch((e) => { toast(e.message, 'err'); throw e; });
const cmd = (line) => act('cmd', { line }).catch(() => {});
const rt = (name) => act('realtime', { name }).catch(() => {});

function onMessage(m) {
  switch (m.t) {
    case 'reply': {
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      m.ok ? p.resolve(m.result) : p.reject(new Error(m.error));
      return;
    }
    case 'state': S.machine = m.s; return renderMachine();
    case 'job': S.job = m.j; return renderJob();
    case 'job-text': return onJobText(m.name, m.text);
    case 'settings': S.settings = m.s; return renderSettings();
    case 'logs': $('#console').innerHTML = ''; m.list.forEach(addLog); return;
    case 'log': return addLog(m.entry);
    case 'macros': S.macros = m.list; return renderMacros();
    case 'config': S.zones = { table: null, zone: null, ...(m.config.zones || {}) }; resetDrafts(); return renderZones();
  }
}

// ---- Toasts & console -----------------------------------------------------

function toast(text, kind = 'info') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = text;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), kind === 'err' ? 6000 : 3500);
}

function addLog({ dir, text }) {
  const box = $('#console');
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 30;
  const el = document.createElement('div');
  el.className = dir;
  el.textContent = text;
  box.append(el);
  while (box.childElementCount > 1000) box.firstChild.remove();
  if (atBottom) box.scrollTop = box.scrollHeight;
  if (dir === 'err' && /Alarme/.test(text)) $('#alarm-bar').dataset.text = text;
}

// ---- Connexion ------------------------------------------------------------

async function refreshPorts() {
  const list = await request('ports').catch(() => []);
  const sel = $('#port');
  const prev = sel.value || store.get('port', 'simulateur');
  sel.innerHTML = list.map((p) => `<option value="${p.path}">${escapeHtml(p.label)}</option>`).join('');
  if (list.some((p) => p.path === prev)) sel.value = prev;
}

$('#btn-refresh').onclick = refreshPorts;
$('#baud').value = store.get('baud', '115200');
$('#btn-connect').onclick = async () => {
  if (S.machine.connected) return act('disconnect').catch(() => {});
  store.set('port', $('#port').value);
  store.set('baud', $('#baud').value);
  await act('connect', { port: $('#port').value, baud: $('#baud').value }).catch(() => {});
};
$('#btn-unlock').onclick = () => cmd('$X');
$('#btn-home').onclick = () => cmd('$H');
$('#btn-reset').onclick = () => rt('reset');

// ---- Rendu machine ----------------------------------------------------------

const STATE_LABEL = {
  Idle: 'Prêt', Run: 'Usinage', Hold: 'Pause', Jog: 'Jog', Alarm: 'Alarme', Door: 'Porte',
  Check: 'Vérif.', Home: 'Origine', Sleep: 'Veille',
};

function setBadge(text, cls) {
  const b = $('#state-badge');
  b.textContent = text;
  b.className = `badge ${cls || ''}`;
}

const drO = {};
let lastWcoKey = null;
function buildDro() {
  $('#dro').innerHTML = ['X', 'Y', 'Z'].map((a) => `
    <div class="dro-row">
      <span class="dro-axis ${a}">${a}</span>
      <span class="dro-val">
        <button class="dro-num" data-edit="${a}" title="Cliquer pour saisir la position actuelle de ${a}"><span data-w="${a}">0.000</span></button>
        <input class="dro-input" data-input="${a}" type="number" step="any" inputmode="decimal" hidden>
        <small data-m="${a}">M 0.000</small>
      </span>
      <button class="ghost" data-zero="${a}" title="Définir la position actuelle comme ${a}0">${a} = 0</button>
    </div>`).join('');
  for (const a of ['X', 'Y', 'Z']) drO[a] = { w: $(`[data-w="${a}"]`), m: $(`[data-m="${a}"]`) };
}
buildDro();

// Pose l'origine travail : la position actuelle de l'axe devient `value`.
// G10 L20 P0 écrit dans le repère actif (G54…), conservé par Grbl à l'arrêt.
function setWork(axes) {
  const words = Object.entries(axes).map(([a, v]) => `${a}${v}`).join('');
  const label = Object.entries(axes).map(([a, v]) => `${a} = ${v}`).join(', ');
  return act('cmd', { line: `G10L20P0${words}` })
    .then(() => toast(`Origine posée : ${label}`, 'ok'))
    .catch(() => {});
}

// Saisie directe : clic sur la valeur, Entrée pour valider, Échap pour annuler.
$('#dro').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-edit]');
  if (!btn || btn.disabled) return;
  const a = btn.dataset.edit;
  const input = $(`[data-input="${a}"]`);
  btn.hidden = true;
  input.hidden = false;
  input.value = S.machine.status.wpos[a].toFixed(3);
  input.focus();
  input.select();
});
$('#dro').addEventListener('keydown', (e) => {
  const input = e.target.closest('[data-input]');
  if (!input) return;
  if (e.key === 'Enter') {
    const v = Number(input.value.replace(',', '.'));
    if (input.value.trim() === '' || !Number.isFinite(v)) return toast('Valeur invalide', 'err');
    setWork({ [input.dataset.input]: Math.round(v * 1000) / 1000 });
    input.blur();
  } else if (e.key === 'Escape') {
    e.stopPropagation();
    input.blur();
  }
});
$('#dro').addEventListener('focusout', (e) => {
  const input = e.target.closest('[data-input]');
  if (!input) return;
  input.hidden = true;
  $(`[data-edit="${input.dataset.input}"]`).hidden = false;
});

function renderMachine() {
  const m = S.machine;
  const s = m.status;
  const state = s.state;
  $('#btn-connect').textContent = m.connected ? 'Déconnecter' : 'Connecter';
  $('#btn-connect').className = m.connected ? 'ghost' : 'primary';
  $('#port').disabled = m.connected;
  $('#baud').disabled = m.connected;

  if (!m.connected) setBadge('Déconnecté');
  else if (!m.ready) setBadge('Connexion…');
  else setBadge(STATE_LABEL[state] || state, state.toLowerCase());

  for (const a of ['X', 'Y', 'Z']) {
    drO[a].w.textContent = s.wpos[a].toFixed(3);
    drO[a].m.textContent = `M ${s.mpos[a].toFixed(3)}`;
  }
  $('#wcs-name').textContent = m.modal?.wcs || 'G54';
  $('#units').textContent = m.modal?.units === 'G20' ? 'pouces' : 'mm';
  $('#ov-feed').textContent = `${s.ov?.feed ?? 100}%`;
  $('#ov-spindle').textContent = `${s.ov?.spindle ?? 100}%`;
  $('#ov-rapid').textContent = `${s.ov?.rapid ?? 100}%`;
  $('#live-feed').textContent = `F ${s.feed ?? 0}`;
  $('#live-speed').textContent = `S ${s.speed ?? 0}`;
  $('#live-modal').textContent = m.modal ? [m.modal.distance, m.modal.spindle, m.modal.coolant].filter(Boolean).join(' ') : '';

  const alarm = m.ready && state === 'Alarm';
  const bar = $('#alarm-bar');
  bar.hidden = !alarm;
  if (alarm) bar.textContent = `${bar.dataset.text || 'Machine en alarme'}. Faites l'origine ($H) ou déverrouillez ($X) si la position est sûre.`;

  viewer.setTool(s.wpos);
  const wcoKey = `${s.wco?.X},${s.wco?.Y}`;
  if (wcoKey !== lastWcoKey) { lastWcoKey = wcoKey; renderZones(); }
  updateEnabled();
}

function updateEnabled() {
  const m = S.machine;
  const state = m.status.state;
  const idle = m.ready && state === 'Idle';
  const jobActive = ['running', 'paused', 'finishing', 'stopping', 'toolchange'].includes(S.job?.state);
  const canJog = m.ready && (state === 'Idle' || state === 'Jog') && !(jobActive && S.job.state !== 'toolchange');
  $$('[data-jog], #jog-stop').forEach((b) => (b.disabled = !canJog));
  $$('[data-zero], [data-edit], #btn-goto-zero').forEach((b) => (b.disabled = !idle || (jobActive && S.job.state !== 'toolchange')));
  $('#btn-unlock').disabled = !m.ready;
  $('#btn-home').disabled = !m.ready || jobActive;
  $('#btn-reset').disabled = !m.connected;
  $$('[data-rt]').forEach((b) => (b.disabled = !m.ready));

  const j = S.job;
  const canRun = idle && j && !jobActive && S.lines.length;
  $('#btn-run').disabled = !canRun;
  $('#btn-resume-run').disabled = !canRun;
  const machineHeld = state === 'Hold';
  const pauseBtn = $('#btn-pause');
  pauseBtn.disabled = !(j && (j.state === 'running' || j.state === 'paused'));
  pauseBtn.textContent = j?.state === 'paused' || (j?.state === 'running' && machineHeld) ? 'Reprendre' : 'Pause';
  $('#btn-stop').disabled = !jobActive || j.state === 'stopping';
  $('#btn-probe').disabled = !idle || (jobActive && j.state !== 'toolchange');
  $('#btn-place').disabled = !canRun && !$('#btn-place').classList.contains('active');
  $('#btn-preview').disabled = !S.lines.length || (jobActive && !preview?.active);
  const zoneOutline = $('.zone-card[data-target="zone"] [data-outline]');
  if (zoneOutline) {
    zoneOutline.disabled = !S.zones.zone || !canJog;
    $('#btn-outline-job').disabled = !(S.info && Number.isFinite(S.info.min.X)) || !canJog;
  }
}

// ---- Zéro / déplacements ----------------------------------------------------

document.addEventListener('click', (e) => {
  const z = e.target.closest('[data-zero]');
  if (z && !z.disabled) setWork(Object.fromEntries(z.dataset.zero.split('').map((a) => [a, 0])));
  const c = e.target.closest('[data-cmd]');
  if (c) cmd(c.dataset.cmd);
  const r = e.target.closest('[data-rt]');
  if (r) rt(r.dataset.rt);
});
$('#btn-goto-zero').onclick = () => cmd('G90G0X0Y0');

let jogStep = store.get('jogStep', 1);
function renderSteps() {
  $$('#jog-steps button').forEach((b) => b.classList.toggle('active', Number(b.dataset.step) === jogStep));
}
$('#jog-steps').onclick = (e) => {
  const b = e.target.closest('[data-step]');
  if (!b) return;
  jogStep = Number(b.dataset.step);
  store.set('jogStep', jogStep);
  renderSteps();
};
renderSteps();
$('#jog-feed').value = store.get('jogFeed', 2000);
$('#jog-feed').onchange = () => store.set('jogFeed', Number($('#jog-feed').value));

const parseJog = (spec) => Object.fromEntries(spec.split(' ').map((p) => [p[0], Number(p.slice(1))]));

// Appui court = un pas, appui maintenu = jog continu jusqu'au relâchement.
function makeJogger() {
  let timer = null, continuous = false;
  return {
    press(dir) {
      if (timer || continuous) return;
      timer = setTimeout(() => {
        timer = null;
        continuous = true;
        act('jog', { axes: dir, feed: Number($('#jog-feed').value), continuous: true }).catch(() => {});
      }, 280);
    },
    release(dir) {
      if (timer) {
        clearTimeout(timer);
        timer = null;
        const axes = Object.fromEntries(Object.entries(dir).map(([a, v]) => [a, v * jogStep]));
        act('jog', { axes, feed: Number($('#jog-feed').value) }).catch(() => {});
      } else if (continuous) {
        continuous = false;
        act('jogStop').catch(() => {});
      }
    },
  };
}

for (const b of $$('[data-jog]')) {
  const j = makeJogger();
  const dir = parseJog(b.dataset.jog);
  b.addEventListener('pointerdown', (e) => { if (b.disabled) return; b.setPointerCapture(e.pointerId); b.classList.add('active'); j.press(dir); });
  const up = () => { b.classList.remove('active'); j.release(dir); };
  b.addEventListener('pointerup', up);
  b.addEventListener('pointercancel', up);
}
$('#jog-stop').onclick = () => act('jogStop').catch(() => {});

const KEYS = { ArrowLeft: { X: -1 }, ArrowRight: { X: 1 }, ArrowUp: { Y: 1 }, ArrowDown: { Y: -1 }, PageUp: { Z: 1 }, PageDown: { Z: -1 } };
const KEY_BUTTON = { ArrowLeft: 'X-1', ArrowRight: 'X1', ArrowUp: 'Y1', ArrowDown: 'Y-1', PageUp: 'Z1', PageDown: 'Z-1' };
const keyJoggers = {};
// Seuls les champs de saisie gardent les flèches ; un menu ou un bouton qui a
// le focus ne doit pas empêcher de déplacer la machine.
const typing = (e) => e.target.tagName === 'TEXTAREA' ||
  (e.target.tagName === 'INPUT' && !['range', 'checkbox', 'radio', 'button'].includes(e.target.type));

function jogBlockedReason() {
  const m = S.machine;
  if (!m.connected) return 'Connectez la machine pour la déplacer.';
  if (!m.ready) return 'Connexion en cours…';
  if (m.status.state === 'Alarm') return 'Machine en alarme : cliquez sur Origine (ou Déverrouiller).';
  return `Déplacement impossible pendant l'état « ${STATE_LABEL[m.status.state] || m.status.state} ».`;
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { act('jogStop').catch(() => {}); closeGoto(); stopDraw(); stopPlace(); return; }
  if (e.key === ' ' && preview.active && !typing(e) && e.target.tagName !== 'BUTTON') {
    e.preventDefault();
    preview.playing ? preview.pause() : preview.play();
    return;
  }
  if (!KEYS[e.key] || typing(e) || e.metaKey || e.ctrlKey || e.altKey) return;
  e.preventDefault();
  if (e.target.tagName === 'SELECT') e.target.blur();
  if (e.repeat) return;
  if ($('#jog-stop').disabled) { toastOnce(jogBlockedReason()); return; }
  $(`[data-jog="${KEY_BUTTON[e.key]}"]`)?.classList.add('active');
  (keyJoggers[e.key] ||= makeJogger()).press(KEYS[e.key]);
});
document.addEventListener('keyup', (e) => {
  if (!keyJoggers[e.key]) return;
  $(`[data-jog="${KEY_BUTTON[e.key]}"]`)?.classList.remove('active');
  keyJoggers[e.key].release(KEYS[e.key]);
});
// Après un choix dans un menu, on rend le focus à la page pour le clavier.
$$('select').forEach((sel) => sel.addEventListener('change', () => sel.blur()));
window.addEventListener('blur', () => act('jogStop').catch(() => {}));

// ---- Visualiseur & job ------------------------------------------------------

const viewer = new Viewer($('#viewer'));
$$('[data-view]').forEach((b) => (b.onclick = () => viewer.view(b.dataset.view)));

function onJobText(name, text) {
  S.lines = splitProgram(text);
  const rapid = Number(S.settings[110]) || 3000;
  S.info = analyze(S.lines, { rapidRate: rapid });
  viewer.load(S.lines);
  const i = S.info;
  const dims = Number.isFinite(i.min.X)
    ? `${fmtNum(i.max.X - i.min.X)} × ${fmtNum(i.max.Y - i.min.Y)} × ${fmtNum(i.max.Z - i.min.Z)} mm`
    : '';
  $('#job-name').textContent = name;
  $('#job-meta').textContent = [`${i.lines} lignes`, `≈ ${fmtDuration(i.seconds)}`, dims,
    i.toolChanges ? `${i.toolChanges} changement(s) d'outil` : ''].filter(Boolean).join(' · ');
  if (Number.isFinite(i.min.Z) && i.min.Z >= 0) toast('Attention : aucune passe sous Z0. Le zéro Z est-il au bon endroit ?', 'err');
  closePreview();
  setupResume();
  renderZones();
  const fit = fitCheck();
  if (fit && !fit.ok) toast(fit.text, 'err');
  renderJob();
}

async function loadFile(file) {
  if (!file) return;
  if (file.size > 60 * 1024 * 1024) return toast('Fichier trop gros (60 Mo max)', 'err');
  const text = await file.text();
  await act('load', { name: file.name, text }).then(() => toast(`${file.name} chargé`, 'ok')).catch(() => {});
}
$('#file-input').onchange = (e) => { loadFile(e.target.files[0]); e.target.value = ''; };
const wrap = $('.viewer-wrap');
wrap.addEventListener('dragover', (e) => { e.preventDefault(); wrap.classList.add('dragging'); });
wrap.addEventListener('dragleave', (e) => { if (!wrap.contains(e.relatedTarget)) wrap.classList.remove('dragging'); });
wrap.addEventListener('drop', (e) => { e.preventDefault(); wrap.classList.remove('dragging'); loadFile(e.dataTransfer.files[0]); });

const JOB_STATE = {
  loaded: 'Prêt', running: 'En cours', paused: 'En pause', toolchange: 'Changement d\'outil',
  finishing: 'Finition', stopping: 'Arrêt…', stopped: 'Arrêté', done: 'Terminé',
};

function renderJob() {
  const j = S.job;
  if (j && ['running', 'finishing'].includes(j.state)) closePreview();
  const bar = $('#job-progress');
  if (!j) { bar.style.width = '0'; updateEnabled(); return; }
  const pct = j.total ? (j.acked / j.total) * 100 : 0;
  bar.style.width = `${pct}%`;
  viewer.setProgress(j.state === 'loaded' ? 0 : j.acked);
  renderTimes();
  if (j.error && j.error !== lastJobError) { lastJobError = j.error; toast(j.error, 'err'); }
  $('#toolchange').hidden = j.state !== 'toolchange';
  if (j.state === 'toolchange') $('#tool-number').textContent = `T${j.tool}`;
  if (j.state === 'done' && lastJobState !== 'done') toast(`Job terminé en ${fmtDuration((j.finishedAt - j.startedAt) / 1000)}`, 'ok');
  lastJobState = j.state;
  updateEnabled();
}
let lastJobState = null;
let lastError = null;
let lastJobError = null;
function toastOnce(msg) {
  if (msg === lastError) return;
  lastError = msg;
  toast(msg, 'err');
  setTimeout(() => { if (lastError === msg) lastError = null; }, 4000);
}

function renderTimes() {
  const j = S.job;
  if (!j) return;
  const label = JOB_STATE[j.state] || j.state;
  const pct = j.total ? Math.round((j.acked / j.total) * 100) : 0;
  if (!j.startedAt || j.state === 'loaded') {
    $('#job-elapsed').textContent = label;
    $('#job-remaining').textContent = S.info ? `durée estimée ${fmtDuration(S.info.seconds)}` : '';
    return;
  }
  const end = j.finishedAt || Date.now();
  const elapsed = (end - j.startedAt) / 1000;
  $('#job-elapsed').textContent = `${label} · ${pct}% · ${j.acked}/${j.total} · ${fmtDuration(elapsed)}`;
  const doneFrac = (j.acked - j.startIndex) / Math.max(1, j.total - j.startIndex);
  const active = ['running', 'paused', 'toolchange'].includes(j.state);
  $('#job-remaining').textContent = active && doneFrac > 0.02 ? `reste ≈ ${fmtDuration(elapsed / doneFrac - elapsed)}` : '';
}
setInterval(renderTimes, 1000);

$('#btn-run').onclick = () => {
  const fit = fitCheck();
  if (fit && !fit.ok && !confirm(`${fit.text}\n\nDémarrer quand même ?`)) return;
  if (S.info && Number.isFinite(S.info.min.Z) && S.info.min.Z < 0 && !confirm('Démarrer l\'usinage ? Vérifiez l\'origine, le serrage et la broche.')) return;
  act('run', { from: 0 }).catch(() => {});
};
$('#btn-pause').onclick = () => {
  const j = S.job;
  if (j?.state === 'paused') act('resume').catch(() => {});
  else if (j?.state === 'running' && S.machine.status.state === 'Hold') rt('start'); // M0 / M1
  else act('pause').catch(() => {});
};
$('#btn-stop').onclick = () => act('stop').catch(() => {});
$('#btn-tool-continue').onclick = () => act('toolDone').catch(() => {});
$('#btn-tool-stop').onclick = () => act('stop').catch(() => {});
$('#btn-tool-probe').onclick = () => runProbe('z', probeValues('z')).catch(() => {});

// ---- Reprise ---------------------------------------------------------------

function setupResume() {
  const n = Math.max(1, S.lines.length);
  for (const el of [$('#resume-line'), $('#resume-slider')]) { el.max = n; }
  const suggested = S.job && ['stopped', 'paused'].includes(S.job.state) ? Math.max(1, S.job.acked - 1) : 1;
  setResumeLine(suggested);
}

function setResumeLine(n) {
  const max = Math.max(1, S.lines.length);
  n = Math.max(1, Math.min(max, Math.round(n) || 1));
  $('#resume-line').value = n;
  $('#resume-slider').value = n;
  const i = n - 1;
  const ctx = [];
  for (let k = Math.max(0, i - 3); k <= Math.min(S.lines.length - 1, i + 3); k++) {
    const t = `${String(k + 1).padStart(6)}  ${escapeHtml(S.lines[k])}`;
    ctx.push(k === i ? `<span class="cur">${t}</span>` : t);
  }
  $('#resume-context').innerHTML = ctx.join('\n') || 'Aucun programme chargé';
  const pre = S.lines.length && i > 0 ? buildResume(S.lines, i, { spinUpSeconds: Number($('#resume-spinup').value) }).lines : [];
  $('#resume-preamble').textContent = pre.length ? `Préambule envoyé avant la ligne ${n} :\n${pre.join('\n')}` : 'Départ au début : pas de préambule.';
  if (activeTab === 'resume') viewer.setMarker(i);
}
$('#resume-line').oninput = (e) => setResumeLine(Number(e.target.value));
$('#resume-slider').oninput = (e) => setResumeLine(Number(e.target.value));
$('#resume-spinup').oninput = () => setResumeLine(Number($('#resume-line').value));
// Clic dans la vue 3D : choix de la ligne de reprise dans l'onglet Reprise,
// sinon proposition d'amener la tête au point cliqué du plateau.
viewer.onClick = ({ line, point, screen }) => {
  if (draw) { if (point) drawClick(point); return; }
  if (activeTab === 'resume') {
    if (line !== null) setResumeLine(line + 1);
    return;
  }
  if (point) openGoto(point, screen);
};

let gotoPoint = null;
const safeZ = () => { const v = Number($('#zone-safe-z').value); return Number.isFinite(v) ? v : 5; };
function openGoto(point, screen) {
  if ($('#jog-stop').disabled) { toastOnce(jogBlockedReason()); return; }
  const table = shapeToWork(S.zones.table);
  if (table && !insideShape(table, point)) { toastOnce('Ce point est en dehors du plateau.'); return; }
  gotoPoint = { X: Math.round(point.X * 10) / 10, Y: Math.round(point.Y * 10) / 10 };
  viewer.setTarget(gotoPoint);
  $('#goto-coords').innerHTML = `<b>X</b> ${gotoPoint.X.toFixed(1)} &nbsp; <b>Y</b> ${gotoPoint.Y.toFixed(1)}`;
  $('#goto-safe').textContent = safeZ();
  $('#goto-lift').checked = S.machine.status.wpos.Z < safeZ();
  const pop = $('#goto-pop');
  pop.hidden = false;
  const box = $('#viewer').getBoundingClientRect();
  pop.style.left = `${Math.min(Math.max(8, screen.x + 14), box.width - pop.offsetWidth - 8)}px`;
  pop.style.top = `${Math.min(Math.max(8, screen.y + 14), box.height - pop.offsetHeight - 8)}px`;
  $('#goto-go').focus();
}
function closeGoto() {
  gotoPoint = null;
  $('#goto-pop').hidden = true;
  viewer.setTarget(null);
}
$('#goto-cancel').onclick = closeGoto;
$('#goto-go').onclick = () => {
  if (!gotoPoint) return;
  act('jogTo', { ...gotoPoint, liftZ: $('#goto-lift').checked ? safeZ() : null, feed: Number($('#jog-feed').value) })
    .catch(() => {});
  $('#goto-pop').hidden = true;
  setTimeout(() => viewer.setTarget(null), 600);
};

$('#btn-resume-run').onclick = () => {
  const n = Number($('#resume-line').value);
  if (!confirm(`Reprendre à la ligne ${n} ?\n${S.lines[n - 1]}\n\nL'outil va monter au Z de sécurité puis se placer au-dessus du point de reprise.`)) return;
  act('run', { from: n - 1, spinUp: Number($('#resume-spinup').value) }).catch(() => {});
};

// ---- Onglets ---------------------------------------------------------------

let activeTab = $(`.tab[data-pane="${location.hash.slice(1)}"]`) ? location.hash.slice(1) : store.get('tab', 'console');
function showTab(name) {
  activeTab = name;
  store.set('tab', name);
  $$('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  $$('.tab').forEach((p) => (p.hidden = p.dataset.pane !== name));
  if (name === 'resume') setResumeLine(Number($('#resume-line').value));
  else viewer.setMarker(0);
}
$('.tabs').onclick = (e) => { const b = e.target.closest('[data-tab]'); if (b) showTab(b.dataset.tab); };
showTab(activeTab);

// ---- Console ---------------------------------------------------------------

const history = store.get('history', []);
let histPos = history.length;
$('#console-form').onsubmit = (e) => {
  e.preventDefault();
  const input = $('#console-input');
  const line = input.value.trim();
  if (!line) return;
  cmd(line);
  if (history[history.length - 1] !== line) history.push(line);
  history.splice(0, Math.max(0, history.length - 100));
  store.set('history', history);
  histPos = history.length;
  input.value = '';
};
$('#console-input').onkeydown = (e) => {
  if (e.key === 'ArrowUp' && histPos > 0) { histPos--; e.target.value = history[histPos]; e.preventDefault(); }
  if (e.key === 'ArrowDown') { histPos = Math.min(history.length, histPos + 1); e.target.value = history[histPos] ?? ''; e.preventDefault(); }
};
$('#btn-clear-console').onclick = () => { $('#console').innerHTML = ''; };

// ---- Palpage ---------------------------------------------------------------

const PROBE_FIELDS = {
  z: [
    ['plate', 'Épaisseur de la cale (mm)', 0],
    ['travel', 'Course max (mm)', 25],
    ['fastFeed', 'Avance rapide (mm/min)', 150],
    ['slowFeed', 'Avance fine (mm/min)', 30],
    ['retract', 'Dégagement final (mm)', 5],
  ],
  corner: [
    ['toolDia', 'Diamètre outil (mm)', 6],
    ['plate', 'Épaisseur cale en Z (mm)', 0],
    ['wall', 'Épaisseur paroi cale XY (mm)', 0],
    ['inset', 'Distance outil / bords (mm)', 10],
    ['depth', 'Profondeur palpage latéral (mm)', 3],
    ['travel', 'Course max Z (mm)', 25],
    ['fastFeed', 'Avance rapide (mm/min)', 150],
    ['slowFeed', 'Avance fine (mm/min)', 30],
  ],
  center: [
    ['toolDia', 'Diamètre outil (mm)', 6],
    ['maxRadius', 'Rayon max du trou (mm)', 30],
    ['fastFeed', 'Avance rapide (mm/min)', 150],
    ['slowFeed', 'Avance fine (mm/min)', 30],
  ],
};
const PROBE_HELP = {
  z: 'Placez l\'outil 5 à 20 mm au-dessus de la pièce (ou de la cale). Copeau palpe deux fois (rapide puis fin) et pose Z0 sur le dessus de la pièce.',
  corner: 'Placez l\'outil au-dessus de la pièce, à la distance indiquée des deux bords du coin choisi. Copeau palpe Z, puis X et Y sur les flancs, et pose X0 Y0 Z0 sur le coin.',
  center: 'Descendez l\'outil dans le trou, sous le bord, à peu près au centre. Copeau palpe ±X, ±Y puis ±X à nouveau et pose X0 Y0 au centre.',
};
let probeKind = 'z';
let probeCorner = store.get('probeCorner', 'FL');

function probeValues(kind) {
  const saved = store.get(`probe.${kind}`, {});
  const out = {};
  for (const [k, , d] of PROBE_FIELDS[kind]) out[k] = saved[k] ?? d;
  if (kind === 'corner') out.corner = probeCorner;
  return out;
}

function renderProbe() {
  $$('#probe-kind button').forEach((b) => b.classList.toggle('active', b.dataset.kind === probeKind));
  $('#probe-help').textContent = PROBE_HELP[probeKind];
  $('#probe-corners').hidden = probeKind !== 'corner';
  $$('#probe-corners button').forEach((b) => b.classList.toggle('active', b.dataset.corner === probeCorner));
  const vals = probeValues(probeKind);
  $('#probe-fields').innerHTML = PROBE_FIELDS[probeKind].map(([k, label]) =>
    `<label class="field">${label}<input type="number" step="any" data-pk="${k}" value="${vals[k]}"></label>`).join('');
}
$('#probe-kind').onclick = (e) => { const b = e.target.closest('[data-kind]'); if (b) { probeKind = b.dataset.kind; renderProbe(); } };
$('#probe-corners').onclick = (e) => { const b = e.target.closest('[data-corner]'); if (b) { probeCorner = b.dataset.corner; store.set('probeCorner', probeCorner); renderProbe(); } };
$('#probe-fields').oninput = () => {
  const v = {};
  $$('#probe-fields [data-pk]').forEach((i) => (v[i.dataset.pk] = Number(i.value)));
  store.set(`probe.${probeKind}`, v);
};
renderProbe();

async function runProbe(kind, params) {
  const box = $('#probe-result');
  box.hidden = false;
  box.className = 'probe-result';
  box.textContent = 'Palpage en cours…';
  try {
    const r = await request('probe', { kind, params });
    box.textContent = r.message;
    toast(r.message, 'ok');
  } catch (e) {
    box.className = 'probe-result err';
    box.textContent = e.message;
    toast(e.message, 'err');
    throw e;
  }
}
$('#btn-probe').onclick = () => {
  if (!$('#probe-confirm').checked) return toast('Confirmez que la sonde est branchée et testée.', 'err');
  runProbe(probeKind, probeValues(probeKind)).catch(() => {});
};


// ---- Plateau et zone de travail ---------------------------------------------
// Formes enregistrées en coordonnées machine : { kind: 'rect', a, b } ou
// { kind: 'circle', c, r }. Affichage et saisie en coordonnées travail.

const wcoXY = () => S.machine.status.wco || { X: 0, Y: 0 };
const toWork = (p) => p && { X: p.X - wcoXY().X, Y: p.Y - wcoXY().Y };
const toMachine = (p) => p && { X: p.X + wcoXY().X, Y: p.Y + wcoXY().Y };
const r3 = (v) => Math.round(v * 1000) / 1000;

function shapeToWork(sh) {
  if (!sh) return null;
  return sh.kind === 'circle' ? { kind: 'circle', c: toWork(sh.c), r: sh.r } : { kind: 'rect', a: toWork(sh.a), b: toWork(sh.b) };
}

function insideShape(sh, p, tol = 0.001) {
  if (sh.kind === 'circle') return Math.hypot(p.X - sh.c.X, p.Y - sh.c.Y) <= sh.r + tol;
  return p.X >= Math.min(sh.a.X, sh.b.X) - tol && p.X <= Math.max(sh.a.X, sh.b.X) + tol &&
    p.Y >= Math.min(sh.a.Y, sh.b.Y) - tol && p.Y <= Math.max(sh.a.Y, sh.b.Y) + tol;
}

function shapeSize(sh) {
  if (!sh) return 'non défini';
  if (sh.kind === 'circle') return `Ø ${fmtNum(sh.r * 2)} mm`;
  return `${fmtNum(Math.abs(sh.b.X - sh.a.X))} × ${fmtNum(Math.abs(sh.b.Y - sh.a.Y))} mm`;
}

// Brouillons en cours de saisie (coordonnées machine), un par carte.
const drafts = {};
let zoneKind = 'rect';
function resetDrafts() {
  drafts.table = { kind: 'rect', ...(S.zones.table || {}) };
  const z = S.zones.zone;
  if (z) zoneKind = z.kind;
  drafts.zone = { kind: zoneKind, ...(z || {}) };
}
resetDrafts();

function complete(d) {
  if (d.kind === 'circle') return d.c && d.r > 0 ? { kind: 'circle', c: d.c, r: r3(d.r) } : null;
  if (!d.a || !d.b || Math.abs(d.a.X - d.b.X) < 0.1 || Math.abs(d.a.Y - d.b.Y) < 0.1) return null;
  return { kind: 'rect', a: d.a, b: d.b };
}

function saveShape(target, shape) {
  const zones = { ...S.zones, [target]: shape };
  return act('setConfig', { key: 'zones', value: zones })
    .then(() => toast(shape ? `${target === 'table' ? 'Plateau' : 'Zone de travail'} : ${shapeSize(shape)}` : 'Forme effacée', 'ok'))
    .catch(() => {});
}

function commitDraft(target) {
  const shape = complete(drafts[target]);
  if (shape) saveShape(target, shape);
  else renderZones();
}

function pointRow(label, key, p, capLabel) {
  const w = toWork(p);
  const v = (a) => (w ? r3(w[a]) : '');
  return `<div class="zone-pt"><span>${label}</span>
    <input type="number" step="any" data-pt="${key}" data-axis="X" placeholder="X" value="${v('X')}" class="${w ? '' : 'empty'}">
    <input type="number" step="any" data-pt="${key}" data-axis="Y" placeholder="Y" value="${v('Y')}" class="${w ? '' : 'empty'}">
    <button class="ghost small" data-cap="${key}" title="Prendre la position actuelle de l'outil">${capLabel}</button></div>`;
}

function renderZoneCard(target) {
  const card = $(`.zone-card[data-target="${target}"]`);
  const saved = S.zones[target];
  card.querySelector('[data-size]').textContent = shapeSize(saved);
  const d = drafts[target];
  card.querySelectorAll('[data-kind]').forEach((b) => b.classList.toggle('active', b.dataset.kind === d.kind));
  const drawBtn = card.querySelector('[data-draw]');
  drawBtn.textContent = draw?.target === target ? 'Annuler le tracé' : 'Tracer sur la vue';
  const form = card.querySelector('[data-form]');
  if (form.contains(document.activeElement)) return; // ne pas écraser une saisie
  form.innerHTML = d.kind === 'circle'
    ? pointRow('Centre', 'c', d.c, 'Capturer') +
      `<div class="zone-pt"><span>Rayon</span>
        <input type="number" step="any" min="0" data-radius placeholder="R" value="${d.r ? r3(d.r) : ''}" class="${d.r ? '' : 'empty'}">
        <span></span>
        <button class="ghost small" data-cap="edge" title="Rayon = distance entre le centre et la position actuelle">Point du bord</button></div>`
    : pointRow('Coin 1', 'a', d.a, 'Capturer') + pointRow('Coin 2', 'b', d.b, 'Capturer');
}

// offset : décalage du programme à tester (mode « Placer »), repère travail.
function fitCheck(offset = { X: 0, Y: 0 }) {
  const i = S.info;
  if (!i || !Number.isFinite(i.min.X)) return null;
  const corners = [
    { X: i.min.X, Y: i.min.Y }, { X: i.max.X, Y: i.min.Y }, { X: i.max.X, Y: i.max.Y }, { X: i.min.X, Y: i.max.Y },
  ].map((p) => ({ X: p.X + offset.X, Y: p.Y + offset.Y }));
  const zone = shapeToWork(S.zones.zone);
  const table = shapeToWork(S.zones.table);
  const size = `${fmtNum(i.max.X - i.min.X)} × ${fmtNum(i.max.Y - i.min.Y)} mm`;
  if (table && !corners.every((p) => insideShape(table, p))) return { ok: false, text: `Le programme (${size}) dépasse du plateau avec le zéro actuel.` };
  if (zone && !corners.every((p) => insideShape(zone, p))) return { ok: false, text: `Le programme (${size}) sort de la zone de travail avec le zéro actuel.` };
  if (!zone && !table) return { ok: true, text: `Programme : ${size}. Définissez une zone pour vérifier qu'il tient.` };
  return { ok: true, text: `Le programme (${size}) tient dans la ${zone ? 'zone de travail' : 'surface du plateau'}.` };
}

function renderZones() {
  if (!$('.zone-card')) return;
  const preview = draw?.first && draw.hover ? drawShape(draw.first, draw.hover) : null;
  viewer.setShapes({
    table: shapeToWork(S.zones.table),
    zone: shapeToWork(S.zones.zone),
    preview: preview && shapeToWork(preview),
  });
  renderZoneCard('table');
  renderZoneCard('zone');
  const fit = fitCheck();
  const st = $('#fit-status');
  st.textContent = fit ? fit.text : 'Aucun programme chargé';
  st.className = `fit-status ${fit ? (fit.ok ? 'ok' : 'bad') : 'muted'}`;
  const canJog = !$('#jog-stop').disabled;
  $('.zone-card[data-target="zone"] [data-outline]').disabled = !S.zones.zone || !canJog;
  $('#btn-outline-job').disabled = !fit || !canJog;
}

// Tracé à la souris : premier clic = coin (ou centre), second = coin opposé (ou bord).
let draw = null;
function drawShape(first, second) {
  return draw.kind === 'circle'
    ? { kind: 'circle', c: first, r: Math.hypot(second.X - first.X, second.Y - first.Y) }
    : { kind: 'rect', a: first, b: second };
}
function setHint() {
  const hint = $('#viewer-hint');
  hint.classList.toggle('drawing', !!draw);
  if (!draw) { hint.textContent = 'Cliquez sur le plateau pour y amener la tête · flèches / PgUp / PgDn pour déplacer · Échap = stop'; return; }
  const what = draw.target === 'table' ? 'du plateau' : 'de la zone';
  hint.textContent = draw.kind === 'circle'
    ? (draw.first ? `Cliquez un point du bord ${what} (Échap pour annuler)` : `Cliquez le centre ${what}`)
    : (draw.first ? `Cliquez le coin opposé ${what} (Échap pour annuler)` : `Cliquez un premier coin ${what}`);
}
function startDraw(target) {
  closeGoto();
  draw = { target, kind: drafts[target].kind, first: null, hover: null };
  viewer.onHover = (p) => { if (draw?.first) { draw.hover = toMachine(p); renderZones(); } };
  viewer.view('top');
  setHint();
  renderZones();
}
function stopDraw() {
  if (!draw) return;
  draw = null;
  viewer.onHover = null;
  setHint();
  renderZones();
}
function drawClick(point) {
  const p = toMachine({ X: r3(point.X), Y: r3(point.Y) });
  if (!draw.first) { draw.first = p; setHint(); return; }
  const shape = complete(drawShape(draw.first, p));
  const target = draw.target;
  stopDraw();
  if (!shape) return toast('Forme trop petite', 'err');
  drafts[target] = { ...shape };
  saveShape(target, shape);
}

for (const card of $$('.zone-card[data-target]')) {
  const target = card.dataset.target;
  card.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b || b.disabled) return;
    if (b.dataset.kind) {
      zoneKind = b.dataset.kind;
      drafts.zone = { kind: zoneKind, ...(S.zones.zone?.kind === zoneKind ? S.zones.zone : {}) };
      renderZones();
    } else if (b.dataset.cap) {
      if (!S.machine.ready) return toast('Connectez la machine pour capturer sa position', 'err');
      const m = S.machine.status.mpos;
      const d = drafts[target];
      if (b.dataset.cap === 'edge') {
        if (!d.c) return toast('Capturez d\'abord le centre', 'err');
        d.r = Math.hypot(m.X - d.c.X, m.Y - d.c.Y);
      } else {
        d[b.dataset.cap] = { X: r3(m.X), Y: r3(m.Y) };
      }
      commitDraft(target);
    } else if ('draw' in b.dataset) {
      draw?.target === target ? stopDraw() : startDraw(target);
    } else if ('clear' in b.dataset) {
      drafts[target] = { kind: drafts[target].kind };
      saveShape(target, null);
    } else if ('fromGrbl' in b.dataset) {
      const w = Number(S.settings[130]), h = Number(S.settings[131]);
      if (!w || !h) return toast('Réglages $130 / $131 indisponibles : connectez la machine', 'err');
      toast('Valable si la prise d\'origine a été faite', 'info');
      drafts.table = { kind: 'rect', a: { X: 0, Y: 0 }, b: { X: -w, Y: -h } };
      commitDraft('table');
    } else if ('fromJob' in b.dataset) {
      const i = S.info;
      if (!i || !Number.isFinite(i.min.X)) return toast('Aucun programme chargé', 'err');
      zoneKind = 'rect';
      drafts.zone = { kind: 'rect', a: toMachine({ X: i.min.X, Y: i.min.Y }), b: toMachine({ X: i.max.X, Y: i.max.Y }) };
      commitDraft('zone');
    } else if ('outline' in b.dataset) {
      const z = shapeToWork(S.zones.zone);
      const pts = outline(z, 48);
      runPath([...pts, pts[0]]);
    }
  });
  card.addEventListener('change', (e) => {
    const d = drafts[target];
    const input = e.target;
    if (input.dataset.radius !== undefined) {
      const r = Number(input.value);
      d.r = input.value !== '' && r > 0 ? r : null;
    } else if (input.dataset.pt) {
      const key = input.dataset.pt;
      const row = input.closest('.zone-pt');
      const x = row.querySelector('[data-axis="X"]').value, y = row.querySelector('[data-axis="Y"]').value;
      d[key] = x !== '' && y !== '' ? toMachine({ X: Number(x), Y: Number(y) }) : null;
    } else return;
    input.blur();
    commitDraft(target);
  });
  card.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.tagName === 'INPUT') e.target.blur(); });
}

function runPath(points) {
  if ($('#jog-stop').disabled) return toastOnce(jogBlockedReason());
  act('jogPath', { points, liftZ: safeZ(), feed: Number($('#jog-feed').value) }).catch(() => {});
}
$('#btn-outline-job').onclick = () => {
  const i = S.info;
  if (!i || !Number.isFinite(i.min.X)) return;
  runPath([
    { X: i.min.X, Y: i.min.Y }, { X: i.max.X, Y: i.min.Y }, { X: i.max.X, Y: i.max.Y },
    { X: i.min.X, Y: i.max.Y }, { X: i.min.X, Y: i.min.Y },
  ]);
};
$('#zone-safe-z').value = store.get('safeZ', 5);
$('#zone-safe-z').onchange = () => store.set('safeZ', safeZ());



// ---- Simulation avant usinage --------------------------------------------------

const preview = new Preview(viewer, { onFrame: renderPlaybar });
let scrubbing = false;

function renderPlaybar(st) {
  $('#pb-play').textContent = st.playing ? '⏸' : '▶';
  if (!scrubbing) $('#pb-scrub').value = st.total ? Math.round((st.t / st.total) * 1000) : 0;
  $('#pb-time').textContent = `${fmtClock(st.t)} / ${fmtClock(st.total)}`;
  $('#pb-line').textContent = S.lines.length ? `L${st.line + 1}  ${S.lines[st.line]}` : '';
}
const fmtClock = (sec) => {
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  const mm = String(m).padStart(h ? 2 : 1, '0'), ss = String(s).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
};

function openPreview() {
  if (!S.lines.length) return toast('Chargez d\'abord un programme', 'err');
  const jobActive = ['running', 'paused', 'finishing', 'stopping', 'toolchange'].includes(S.job?.state);
  if (jobActive) return toast('Simulation indisponible pendant un usinage', 'err');
  closeGoto();
  stopDraw();
  stopPlace();
  try {
    preview.open({ rapidRate: Number(S.settings[110]) || 3000, toolDia: Number($('#pb-tool').value) || 6 });
  } catch (e) { return toast(e.message, 'err'); }
  preview.speed = Number($('#pb-speed').value);
  preview.setShowStock($('#pb-stock').checked);
  $('#playbar').hidden = false;
  $('#btn-preview').classList.add('active');
  $('#btn-preview').textContent = '■ Simulation';
  if (!preview.cutBounds) toast('Aucune passe sous Z0 : pas de matière à creuser', 'info');
  viewer.view('iso', { programOnly: true });
  preview.play();
}
function closePreview() {
  if (!preview.active) return;
  preview.close();
  $('#playbar').hidden = true;
  $('#btn-preview').classList.remove('active');
  $('#btn-preview').textContent = '▶ Simuler';
  renderJob();
}
$('#btn-preview').onclick = () => (preview.active ? closePreview() : openPreview());
$('#pb-close').onclick = closePreview;
$('#pb-play').onclick = () => (preview.playing ? preview.pause() : preview.play());
$('#pb-restart').onclick = () => preview.seek(0);
$('#pb-scrub').addEventListener('pointerdown', () => { scrubbing = true; });
$('#pb-scrub').addEventListener('input', (e) => preview.seekFraction(Number(e.target.value) / 1000));
$('#pb-scrub').addEventListener('change', () => { scrubbing = false; });
$('#pb-speed').value = String(store.get('pbSpeed', 5));
$('#pb-speed').onchange = (e) => { preview.speed = Number(e.target.value); store.set('pbSpeed', preview.speed); };
$('#pb-tool').value = store.get('pbTool', store.get('probe.corner', {}).toolDia ?? 6);
$('#pb-tool').onchange = (e) => {
  const d = Number(e.target.value);
  if (!(d > 0)) return;
  store.set('pbTool', d);
  preview.setToolDia(d);
};
$('#pb-stock').onchange = (e) => preview.setShowStock(e.target.checked);

// ---- Placer le programme sur le plateau ------------------------------------
// On glisse le parcours ; à la validation, l'origine X/Y est décalée d'autant
// (G10 L20 sur la position actuelle). Le fichier G-code ne change pas.

let placeDelta = null;
function canPlace() {
  const j = S.job;
  const jobActive = ['running', 'paused', 'finishing', 'stopping', 'toolchange'].includes(j?.state);
  return S.machine.ready && S.machine.status.state === 'Idle' && !jobActive;
}
function startPlace() {
  if (!S.lines.length) return toast('Chargez d\'abord un programme', 'err');
  if (!canPlace()) return toast('La machine doit être Prêt, sans usinage en cours', 'err');
  closePreview();
  closeGoto();
  stopDraw();
  placeDelta = null;
  $('#btn-place').classList.add('active');
  const hint = $('#viewer-hint');
  hint.classList.add('drawing');
  hint.textContent = 'Glissez le parcours pour le placer · clic droit = déplacer la vue · Échap pour annuler';
  if (S.zones.table || S.zones.zone) viewer.view('top');
  viewer.setPlaceMode({
    onMove: (d) => { placeDelta = d; showPlacePop(false); },
    onDrop: (d) => { placeDelta = d; showPlacePop(true); },
  });
}
function showPlacePop(final) {
  const d = placeDelta;
  $('#viewer-hint').textContent = `Décalage X ${fmtSigned(d.X)}  Y ${fmtSigned(d.Y)} mm`;
  const pop = $('#place-pop');
  pop.hidden = !final;
  if (!final) return;
  $('#place-delta').innerHTML = `<b>ΔX</b> ${fmtSigned(d.X)} &nbsp; <b>ΔY</b> ${fmtSigned(d.Y)} mm`;
  const fit = fitCheck(d);
  const el = $('#place-fit');
  el.textContent = fit ? fit.text.replace('avec le zéro actuel', 'à cette position') : '';
  el.className = `small ${fit ? (fit.ok ? 'fit-status ok' : 'fit-status bad') : ''}`;
  pop.style.left = '50%';
  pop.style.top = '64px';
  pop.style.transform = 'translateX(-50%)';
}
function stopPlace() {
  if (!$('#btn-place').classList.contains('active')) return;
  $('#btn-place').classList.remove('active');
  $('#place-pop').hidden = true;
  placeDelta = null;
  viewer.setPlaceMode(null);
  setHint();
}
const fmtSigned = (v) => `${v >= 0 ? '+' : ''}${(Math.round(v * 10) / 10).toFixed(1)}`;
$('#btn-place').onclick = () => ($('#btn-place').classList.contains('active') ? stopPlace() : startPlace());
$('#place-cancel').onclick = stopPlace;
$('#place-apply').onclick = async () => {
  const d = placeDelta;
  if (!d || !canPlace()) return toast('La machine doit être Prêt', 'err');
  const fit = fitCheck(d);
  if (fit && !fit.ok && !confirm(`${fit.text.replace('avec le zéro actuel', 'à cette position')}\n\nPlacer quand même ?`)) return;
  // Le zéro se déplace de +d : la position actuelle vaut alors (travail - d).
  const w = S.machine.status.wpos;
  const x = Math.round((w.X - d.X) * 1000) / 1000, y = Math.round((w.Y - d.Y) * 1000) / 1000;
  await act('cmd', { line: `G10L20P0X${x}Y${y}` }).then(() => {
    toast(`Programme déplacé de X ${fmtSigned(d.X)} Y ${fmtSigned(d.Y)} mm (origine décalée)`, 'ok');
  }).catch(() => {});
  stopPlace();
};

// ---- Démo guidée -------------------------------------------------------------

const TOUR = [
  {
    title: 'Bienvenue dans Copeau',
    body: `<p>Copeau pilote une CNC <b>Grbl / grblHAL</b> depuis le navigateur.</p>
      <p>Cette démo présente l'écran en 13 étapes. Utilisez <kbd>→</kbd> / <kbd>←</kbd> ou les boutons. À la fin, vous pourrez tout essayer sur une <b>machine simulée</b>, sans risque.</p>
      <p class="muted">Gardez toujours l'arrêt d'urgence de la vraie machine à portée de main.</p>`,
  },
  {
    target: '.connect', title: 'Connexion',
    body: `<p>Choisissez le port USB de la carte (ou <b>Simulateur Grbl</b>), laissez <b>115200</b>, puis <b>Connecter</b>.</p>
      <p><b>↻</b> rafraîchit la liste si vous venez de brancher la machine.</p>`,
  },
  {
    target: '.machine-state', title: 'État de la machine',
    body: `<p>Le badge indique l'état : <b>Prêt</b>, <b>Usinage</b>, <b>Pause</b> ou <b>Alarme</b>.</p>
      <ul><li><b>Origine</b> : prise d'origine sur les fins de course (à faire au démarrage).</li>
      <li><b>Déverrouiller</b> : lève une alarme si la position est sûre.</li>
      <li><b>Reset</b> : réinitialise la carte (ce n'est pas un arrêt d'urgence).</li></ul>`,
  },
  {
    target: '.dro', title: 'Position et zéro',
    body: `<p>Les grands chiffres sont la <b>position travail</b>, la petite ligne <b>M</b> la position machine.</p>
      <p><b>X = 0</b>, <b>Y = 0</b>, <b>Z = 0</b> posent l'origine de la pièce là où est l'outil. <b>Cliquez sur un chiffre</b> pour taper une valeur précise (ex. épaisseur d'une cale).</p>`,
  },
  {
    target: '.jog', title: 'Déplacer la tête',
    body: `<p><b>Appui court</b> = un pas de la taille choisie, <b>appui maintenu</b> = mouvement continu jusqu'au relâchement.</p>
      <p>Au clavier : <kbd>←</kbd><kbd>→</kbd><kbd>↑</kbd><kbd>↓</kbd> pour X/Y, <kbd>PgUp</kbd><kbd>PgDn</kbd> pour Z, <kbd>Échap</kbd> pour arrêter.</p>`,
  },
  {
    target: '.viewer-wrap', title: 'Vue 3D et suivi en temps réel',
    body: `<p>Le parcours d'outil s'affiche en <b>bleu</b> (usinage) et <b>gris</b> (rapides). Le cône jaune est l'outil, mis à jour 5 fois par seconde.</p>
      <p>Pendant l'usinage, la partie faite passe en <b>orange</b> en direct.</p>
      <p>Glisser = tourner, molette = zoom. <b>Cliquez sur le plateau</b> pour y amener la tête.</p>`,
  },
  {
    target: '#btn-place', title: 'Placer le programme',
    body: `<p><b>Placer</b> permet de glisser le parcours sur le plateau. Copeau indique si la nouvelle position tient dans la zone, puis décale l'origine X/Y d'autant.</p>`,
  },
  {
    target: '#btn-preview', title: 'Simuler avant de lancer',
    body: `<p><b>▶ Simuler</b> joue l'usinage dans la vue : un outil vert suit le parcours à la vitesse du programme et <b>creuse la matière</b> au fur et à mesure.</p>
      <p>Barre de lecture : ▶ / ⏸ (ou <kbd>Espace</kbd>), curseur pour aller à n'importe quel moment, vitesse 1× à 100×, diamètre de fraise. Rien n'est envoyé à la machine.</p>`,
  },
  {
    target: '.job-bar', title: 'Programme',
    body: `<p><b>Ouvrir</b> ou glissez un fichier G-code sur la vue. Vous voyez la durée estimée et les dimensions.</p>
      <p><b>Démarrer</b>, <b>Pause</b> / <b>Reprendre</b>, <b>Arrêter</b> (arrêt propre, la position est conservée). La barre montre la progression et le temps restant.</p>`,
  },
  {
    target: '.overrides', title: 'Corrections en direct',
    body: `<p>Accélérez ou ralentissez l'<b>avance</b>, la <b>broche</b> et les <b>rapides</b> pendant l'usinage, sans toucher au fichier.</p>`,
  },
  {
    target: '.panel.right', title: 'Palpage', before: () => showTab('probe'),
    body: `<p>Avec une sonde (pince sur l'outil + plaque), Copeau trouve l'origine tout seul : <b>Z</b> sur le dessus, un <b>coin XYZ</b>, ou le <b>centre d'un trou</b>.</p>`,
  },
  {
    target: '.panel.right', title: 'Plateau et zone de travail', before: () => showTab('zones'),
    body: `<p>Définissez le <b>plateau</b> et la <b>zone de travail</b> (rectangle par 2 coins, ou cercle) : en capturant la position de l'outil, en traçant sur la vue, ou en tapant les valeurs.</p>
      <p>Copeau vérifie que le programme tient dedans et peut <b>parcourir le contour</b>.</p>`,
  },
  {
    target: '.panel.right', title: 'Reprise, console, macros', before: () => showTab('resume'),
    body: `<p><b>Reprise</b> : relance un usinage interrompu à une ligne choisie (ou en cliquant sur le parcours).</p>
      <p><b>Console</b> pour les commandes, <b>Macros</b> pour vos séquences favorites, <b>Réglages</b> pour les paramètres $ de la carte.</p>`,
  },
  {
    target: '.help', title: 'À vous de jouer', before: () => showTab('console'),
    body: `<p>Le bouton <b>?</b> relance cette démo, <b>Manuel</b> ouvre le mode d'emploi complet.</p>
      <p>Pour essayer maintenant : Copeau connecte la machine simulée, fait l'origine, pose le zéro sur une pièce virtuelle et charge un programme de démonstration.</p>`,
    actions: [{ label: 'Essayer avec le simulateur', primary: true, run: () => tryDemo() }],
  },
];

function runTour(start = 0) {
  closeGoto();
  stopDraw();
  stopPlace();
  startTour(TOUR, { start, onClose: () => store.set('tourDone', true) });
}
$('#btn-tour').onclick = () => runTour();

async function waitUntil(fn, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('La machine simulée ne répond pas');
}

// Installe une séance d'essai sur le simulateur. Ne touche jamais une vraie machine.
async function tryDemo() {
  try {
    const m = S.machine;
    if (m.connected && m.port !== 'simulateur') {
      return toast('Une vraie machine est connectée : déconnectez-la pour essayer le simulateur.', 'err');
    }
    if (['running', 'paused', 'toolchange', 'finishing'].includes(S.job?.state)) return toast('Un usinage est en cours', 'err');
    toast('Préparation de la démo…');
    if (!m.connected) {
      $('#port').value = 'simulateur';
      await request('connect', { port: 'simulateur' });
    }
    await waitUntil(() => S.machine.ready);
    if (S.machine.status.state === 'Alarm') {
      await request('cmd', { line: '$H' });
      await waitUntil(() => S.machine.status.state === 'Idle', 30000);
    }
    // Zéro sur le coin avant gauche de la pièce virtuelle, dessus à Z −50 machine,
    // avec 10 mm de marge.
    await request('cmd', { line: 'G10L2P1X-210Y-190Z-50\nG90G0Z5\n$#\n$G' });
    const text = await fetch('/demo/copeau-demo.nc').then((r) => r.text());
    await request('load', { name: 'copeau-demo.nc', text });
    if (!S.zones.zone && !S.zones.table) {
      await request('setConfig', { key: 'zones', value: {
        table: { kind: 'rect', a: { X: -1, Y: -1 }, b: { X: -300, Y: -300 } },
        zone: { kind: 'rect', a: { X: -220, Y: -200 }, b: { X: -120, Y: -100 } },
      } });
    }
    showTab('zones');
    toast('Démo prête : cliquez sur Démarrer pour lancer l\'usinage simulé', 'ok');
    const run = $('#btn-run');
    run.classList.remove('pulse');
    void run.offsetWidth;
    run.classList.add('pulse');
  } catch (e) {
    toast(e.message, 'err');
  }
}

// ---- Macros ----------------------------------------------------------------

let editingMacro = null;
async function loadMacros() {
  S.macros = await request('macros').catch(() => []);
  renderMacros();
}
function renderMacros() {
  $('#macro-list').innerHTML = S.macros.map((m) => `
    <div class="macro" data-id="${escapeHtml(m.id)}">
      <span title="${escapeHtml(m.gcode)}">${escapeHtml(m.name)}</span>
      <button class="primary small" data-macro-run>Lancer</button>
      <button class="ghost small" data-macro-edit>Modifier</button>
      <button class="ghost small" data-macro-del>✕</button>
    </div>`).join('') || '<p class="muted">Aucune macro.</p>';
}
$('#macro-list').onclick = async (e) => {
  const row = e.target.closest('.macro');
  if (!row) return;
  const m = S.macros.find((x) => x.id === row.dataset.id);
  if (e.target.closest('[data-macro-run]')) act('runMacro', { id: m.id }).catch(() => {});
  if (e.target.closest('[data-macro-edit]')) {
    editingMacro = m.id;
    $('#macro-name').value = m.name;
    $('#macro-gcode').value = m.gcode;
    $('.macro-edit').open = true;
  }
  if (e.target.closest('[data-macro-del]') && confirm(`Supprimer « ${m.name} » ?`)) {
    act('saveMacros', { list: S.macros.filter((x) => x.id !== m.id) }).catch(() => {});
  }
};
$('#btn-macro-new').onclick = () => { editingMacro = null; $('#macro-name').value = ''; $('#macro-gcode').value = ''; };
$('#btn-macro-save').onclick = () => {
  const name = $('#macro-name').value.trim();
  const gcode = $('#macro-gcode').value.trim();
  if (!name || !gcode) return toast('Nom et G-code requis', 'err');
  const list = editingMacro
    ? S.macros.map((m) => (m.id === editingMacro ? { ...m, name, gcode } : m))
    : [...S.macros, { id: `m${Date.now().toString(36)}`, name, gcode }];
  act('saveMacros', { list }).then(() => { toast('Macro enregistrée', 'ok'); $('#btn-macro-new').click(); }).catch(() => {});
};

// ---- Réglages Grbl -----------------------------------------------------------

const SETTING_NAMES = {
  0: 'Durée impulsion de pas (µs)', 1: 'Délai avant mise en veille moteurs (ms)', 2: 'Inversion impulsion de pas (masque)',
  3: 'Inversion direction (masque)', 4: 'Inversion activation moteurs', 5: 'Inversion fins de course', 6: 'Inversion sonde',
  10: 'Contenu du rapport d\'état (masque)', 11: 'Écart de jonction (mm)', 12: 'Tolérance des arcs (mm)', 13: 'Rapport en pouces',
  20: 'Limites logicielles', 21: 'Limites matérielles', 22: 'Prise d\'origine activée', 23: 'Sens de prise d\'origine (masque)',
  24: 'Avance fine prise d\'origine (mm/min)', 25: 'Recherche prise d\'origine (mm/min)', 26: 'Anti-rebond fins de course (ms)',
  27: 'Dégagement après origine (mm)', 30: 'Vitesse broche max (tr/min)', 31: 'Vitesse broche min (tr/min)', 32: 'Mode laser',
  100: 'Pas/mm X', 101: 'Pas/mm Y', 102: 'Pas/mm Z', 110: 'Vitesse max X (mm/min)', 111: 'Vitesse max Y (mm/min)',
  112: 'Vitesse max Z (mm/min)', 120: 'Accélération X (mm/s²)', 121: 'Accélération Y (mm/s²)', 122: 'Accélération Z (mm/s²)',
  130: 'Course max X (mm)', 131: 'Course max Y (mm)', 132: 'Course max Z (mm)',
};

function renderSettings() {
  const keys = Object.keys(S.settings).sort((a, b) => a - b);
  const list = $('#settings-list');
  if (!keys.length) { list.innerHTML = '<p class="muted">Connectez une machine pour lire ses réglages ($$).</p>'; return; }
  if (list.contains(document.activeElement)) return; // ne pas écraser une saisie en cours
  list.innerHTML = keys.map((k) => `
    <div class="setting" data-k="${k}">
      <code>$${k}</code><span>${SETTING_NAMES[k] || 'Réglage'}</span>
      <input value="${escapeHtml(S.settings[k])}" data-orig="${escapeHtml(S.settings[k])}">
    </div>`).join('');
  filterSettings();
}
function filterSettings() {
  const q = $('#settings-filter').value.toLowerCase();
  $$('.setting').forEach((r) => (r.hidden = q && !r.textContent.toLowerCase().includes(q) && !`$${r.dataset.k}`.includes(q)));
}
$('#settings-filter').oninput = filterSettings;
$('#settings-list').addEventListener('input', (e) => e.target.classList.toggle('dirty', e.target.value !== e.target.dataset.orig));
$('#settings-list').addEventListener('change', async (e) => {
  const input = e.target;
  const k = input.closest('.setting').dataset.k;
  if (input.value === input.dataset.orig) return;
  if (!confirm(`Écrire $${k}=${input.value} dans la carte ?`)) { input.value = input.dataset.orig; input.classList.remove('dirty'); return; }
  await act('cmd', { line: `$${k}=${input.value}\n$$` }).catch(() => {});
  input.blur();
});

// ---- Utilitaires -------------------------------------------------------------

function fmtDuration(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '–';
  sec = Math.round(sec);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h ? `${h} h ${String(m).padStart(2, '0')}` : m ? `${m} min ${String(s).padStart(2, '0')}` : `${s} s`;
}
function fmtNum(n) { return (Math.round(n * 10) / 10).toString(); }
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

renderMachine();
connectWs();
const tourParam = new URLSearchParams(location.search).get('tour');
if (tourParam !== null) setTimeout(() => runTour(Math.max(0, Number(tourParam) || 0)), 600);
else if (!store.get('tourDone', false)) setTimeout(() => runTour(), 600);
