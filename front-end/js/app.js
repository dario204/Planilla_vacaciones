const API = 'https://planilla-vacaciones.onrender.com/api';
const PAGE_SIZE = 15;
const TOKEN_KEY = 'vac_token';
const EXPIRY_KEY= 'vac_expiry';

let allEmps    = [];
let filtered   = [];
let page       = 0;
let selectedId = null;

/* ══ AUTENTICACIÓN ══════════════════════════════════════════════════════════ */

function getToken() { return sessionStorage.getItem(TOKEN_KEY); }

function saveToken(token, expiresIn) {
  sessionStorage.setItem(TOKEN_KEY, token);
  sessionStorage.setItem(EXPIRY_KEY, Date.now() + expiresIn * 1000);
}

function clearToken() {
  sessionStorage.removeItem(TOKEN_KEY);
  sessionStorage.removeItem(EXPIRY_KEY);
}

function isTokenValid() {
  const token  = getToken();
  const expiry = parseInt(sessionStorage.getItem(EXPIRY_KEY) || '0');
  return token && Date.now() < expiry;
}

// Wrapper de fetch que agrega el header Authorization
async function apiFetch(url, options = {}) {
  const token = getToken();
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(url, { ...options, headers });

  if (res.status === 401) {
    clearToken();
    showLogin();
    throw new Error('Sesión expirada');
  }
  return res;
}

function showLogin() {
  document.getElementById('login-screen').style.display = 'flex';
  document.getElementById('app-screen').style.display   = 'none';
  document.getElementById('login-pass').value = '';
  document.getElementById('login-alert').className = 'alert';
  document.getElementById('login-pass').focus();
}

function showApp() {
  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('app-screen').style.display   = 'block';
}

/* ── Login ── */
async function handleLogin() {
  const pass  = document.getElementById('login-pass').value;
  const alert = document.getElementById('login-alert');
  const btn   = document.getElementById('btn-login');

  if (!pass) {
    alert.className = 'alert alert-error show';
    alert.textContent = 'Ingresá la contraseña.';
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Verificando…';

  try {
    const r = await fetch(`${API}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: pass })
    });
    const data = await r.json();

    if (!r.ok) {
      alert.className = 'alert alert-error show';
      alert.textContent = data.error || 'Contraseña incorrecta.';
      return;
    }

    saveToken(data.token, data.expiresIn);
    showApp();
    initApp();
  } catch {
    alert.className = 'alert alert-error show';
    alert.textContent = 'No se pudo conectar al servidor.';
  } finally {
    btn.disabled = false;
    btn.innerHTML = `<svg style="width:16px;height:16px" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M15 3h4a2 2 0 012 2v14a2 2 0 01-2 2h-4M10 17l5-5-5-5M15 12H3"/></svg> Ingresar`;
  }
}

/* ══ BLOQUE INDEX.HTML — solo ejecutar si estamos en index.html ══════════════ */
if (document.getElementById('btn-login')) {

document.getElementById('btn-login').addEventListener('click', handleLogin);
document.getElementById('login-pass').addEventListener('keydown', e => { if (e.key === 'Enter') handleLogin(); });

document.getElementById('btn-logout').addEventListener('click', () => {
  clearToken();
  allEmps = []; filtered = []; selectedId = null;
  showLogin();
});

/* ══ APP PRINCIPAL ══════════════════════════════════════════════════════════ */

function initApp() {
  document.getElementById('header-date').textContent =
    new Date().toLocaleDateString('es-AR', { weekday:'long', year:'numeric', month:'long', day:'numeric' });
  Promise.all([loadDeps(), loadEmpleados()]);
}

async function loadDeps() {
  try {
    const r    = await apiFetch(`${API}/dependencias`);
    const deps = await r.json();
    const sel  = document.getElementById('dep-filter');
    // Limpiar opciones previas salvo "Todas las áreas"
    while (sel.options.length > 1) sel.remove(1);
    deps.forEach(d => {
      const o = document.createElement('option');
      o.value = d; o.textContent = d;
      sel.appendChild(o);
    });
  } catch { /* silencioso si sesión expiró */ }
}

async function loadEmpleados() {
  try {
    const r = await apiFetch(`${API}/empleados`);
    allEmps = await r.json();
    applyFilter();
  } catch {
    document.getElementById('emp-tbody').innerHTML =
      `<tr><td colspan="6" style="text-align:center;padding:2rem;color:var(--red)">
        ⚠️ No se pudo cargar la lista de empleados.
      </td></tr>`;
  }
}

/* ── Filtros ── */
function applyFilter() {
  const q   = document.getElementById('search-input').value.trim().toUpperCase();
  const dep = document.getElementById('dep-filter').value;
  filtered  = allEmps.filter(e => {
    const matchQ   = !q   || e.nombre_apellido.toUpperCase().includes(q) || e.dni.includes(q);
    const matchDep = !dep || e.dependencia === dep;
    return matchQ && matchDep;
  });
  page = 0;
  renderTable();
}

function clearFilters() {
  document.getElementById('search-input').value = '';
  document.getElementById('dep-filter').value   = '';
  applyFilter();
}

/* ── Tabla ── */
function renderTable() {
  const start = page * PAGE_SIZE;
  const slice = filtered.slice(start, start + PAGE_SIZE);
  const tbody = document.getElementById('emp-tbody');
  const total = filtered.length;

  document.getElementById('table-count').textContent = `${total} empleados`;
  document.getElementById('page-info').textContent   = total
    ? `Mostrando ${start+1}–${Math.min(start+PAGE_SIZE, total)} de ${total}`
    : 'Sin resultados';
  document.getElementById('btn-prev').disabled = page === 0;
  document.getElementById('btn-next').disabled = start + PAGE_SIZE >= total;

  if (!slice.length) {
    tbody.innerHTML = `<tr><td colspan="6"><div class="placeholder" style="padding:2rem">Sin resultados para esta búsqueda</div></td></tr>`;
    return;
  }

  tbody.innerHTML = slice.map(e => {
    const saldoCls = e.saldo_disponible === 0 ? 'badge-red'
                   : e.saldo_disponible <= 7  ? 'badge-amber'
                   : 'badge-green';
    const sel = selectedId === e.id ? 'selected' : '';
    return `
    <tr class="${sel}" onclick="selectEmpleado(${e.id})">
      <td class="td-name">${e.nombre_apellido}</td>
      <td><span class="td-dep">${e.dependencia || '—'}</span></td>
      <td class="td-num">${e.dias_totales}</td>
      <td class="td-num">${e.dias_tomados}</td>
      <td><span class="badge ${saldoCls}">${e.saldo_disponible}d</span></td>
      <td>
        <button class="btn-delete-row" title="Eliminar empleado"
          onclick="event.stopPropagation(); eliminarEmpleado(${e.id}, '${(e.nombre_apellido || '').replace(/'/g,"\\'")}')">          
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/></svg>
        </button>
      </td>
    </tr>`;
  }).join('');
}

/* ── Seleccionar empleado ── */
function selectEmpleado(id) {
  selectedId = id;
  renderTable();
  const e = allEmps.find(x => x.id === id);
  if (!e) return;

  document.getElementById('form-placeholder').style.display = 'none';
  document.getElementById('form-content').style.display     = 'block';
  document.getElementById('history-panel').style.display    = 'block';

  hideAlert();
  document.getElementById('inp-dias').value  = '';
  document.getElementById('inp-desc').value  = '';
  document.getElementById('inp-fecha').value = new Date().toISOString().split('T')[0];

  updateCard(e);
  loadHistory(id);
}

function updateCard(e) {
  document.getElementById('card-name').textContent    = e.nombre_apellido;
  document.getElementById('card-dep').textContent     = `${e.dependencia || '—'} · DNI ${e.dni}`;
  document.getElementById('card-total').textContent   = e.dias_totales;
  document.getElementById('card-tomados').textContent = e.dias_tomados;
  document.getElementById('card-saldo').textContent   = e.saldo_disponible;
  const pct = e.dias_totales > 0 ? Math.round((e.dias_tomados / e.dias_totales) * 100) : 0;
  document.getElementById('card-progress').style.width = pct + '%';
}

/* ── Eliminar empleado ── */
async function eliminarEmpleado(id, nombre) {
  if (!confirm(`¿Eliminar a ${nombre}?\nSe borrarán todos sus movimientos. Esta acción no se puede deshacer.`)) return;
  try {
    const r = await apiFetch(`${API}/empleados/${id}`, { method: 'DELETE' });
    const d = await r.json();
    if (!r.ok) { alert(d.error); return; }
    allEmps = allEmps.filter(x => x.id !== id);
    applyFilter();
    if (selectedId === id) {
      selectedId = null;
      document.getElementById('form-placeholder').style.display = 'block';
      document.getElementById('form-content').style.display     = 'none';
      document.getElementById('history-panel').style.display    = 'none';
    }
  } catch (err) {
    if (err.message !== 'Sesión expirada') alert('Error al eliminar el empleado.');
  }
}

/* ── Cargar días ── */
document.getElementById('btn-cargar').addEventListener('click', async () => {
  if (!selectedId) return;
  const dias  = parseInt(document.getElementById('inp-dias').value);
  const fecha = document.getElementById('inp-fecha').value;
  const desc  = document.getElementById('inp-desc').value;

  if (!dias || dias <= 0) { showAlert('error', 'Ingresá una cantidad válida de días.'); return; }
  if (!fecha)             { showAlert('error', 'Seleccioná una fecha de inicio.'); return; }

  const btn = document.getElementById('btn-cargar');
  btn.disabled = true; btn.textContent = 'Cargando…';

  try {
    const r = await apiFetch(`${API}/empleados/${selectedId}/vacaciones`, {
      method: 'POST',
      body: JSON.stringify({ dias, fecha, descripcion: desc })
    });
    const data = await r.json();
    if (!r.ok) { showAlert('error', data.error); return; }

    showAlert('success', data.message);
    const idx = allEmps.findIndex(x => x.id === selectedId);
    if (idx !== -1) allEmps[idx] = data.empleado;
    updateCard(data.empleado);
    renderTable();
    loadHistory(selectedId);
    document.getElementById('inp-dias').value = '';
    document.getElementById('inp-desc').value = '';
  } catch (err) {
    if (err.message !== 'Sesión expirada') showAlert('error', 'Error de conexión con el servidor.');
  } finally {
    btn.disabled = false;
    btn.innerHTML = `<svg style="width:16px;height:16px" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 5v14M5 12l7 7 7-7"/></svg> Cargar Días`;
  }
});

/* ── Historial ── */
async function loadHistory(id) {
  const list = document.getElementById('history-list');
  list.innerHTML = '<div class="history-empty">Cargando…</div>';
  try {
    const r    = await apiFetch(`${API}/empleados/${id}/movimientos`);
    const movs = await r.json();
    if (!movs.length) { list.innerHTML = '<div class="history-empty">Sin movimientos registrados</div>'; return; }
    list.innerHTML = movs.map(m => `
      <div class="history-item">
        <div class="history-meta">
          <div class="history-desc">${m.descripcion || 'Sin descripción'}</div>
          <div class="history-date">${formatDate(m.fecha)}</div>
        </div>
        <div style="display:flex;align-items:center;gap:.5rem">
          <span class="history-days">-${m.dias}d</span>
          <button class="btn btn-danger" onclick="deleteMovimiento(${m.id})">✕</button>
        </div>
      </div>`).join('');
  } catch { list.innerHTML = '<div class="history-empty" style="color:var(--red)">Error al cargar historial</div>'; }
}

async function deleteMovimiento(movId) {
  if (!confirm('¿Eliminar este movimiento? Se revertirán los días descontados.')) return;
  try {
    const r = await apiFetch(`${API}/movimientos/${movId}`, { method: 'DELETE' });
    const d = await r.json();
    if (!r.ok) { alert(d.error); return; }
    const r2  = await apiFetch(`${API}/empleados/${selectedId}`);
    const emp = await r2.json();
    const idx = allEmps.findIndex(x => x.id === selectedId);
    if (idx !== -1) allEmps[idx] = emp;
    updateCard(emp);
    renderTable();
    loadHistory(selectedId);
    showAlert('success', d.message);
  } catch (err) {
    if (err.message !== 'Sesión expirada') alert('Error al eliminar el movimiento');
  }
}

/* ── CSV ── */
function descargarCSV() {
  const datos = filtered.length > 0 ? filtered : allEmps;
  const filas = [
    ['Region', 'Dependencia', 'Apellido y Nombre', 'DNI', 'Dias Totales', 'Dias Tomados', 'Saldo Disponible'],
    ...datos.map(e => [e.region||'', e.dependencia||'', e.nombre_apellido, e.dni, e.dias_totales, e.dias_tomados, e.saldo_disponible])
  ];
  const csv  = filas.map(f => f.map(c => `"${String(c).replace(/"/g,'""')}"`).join(';')).join('\r\n');
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url;
  a.download = `vacaciones_${new Date().toLocaleDateString('es-AR').replace(/\//g,'-')}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

/* ── Eventos ── */
let debounceTimer;
document.getElementById('search-input').addEventListener('input', () => {
  clearTimeout(debounceTimer); debounceTimer = setTimeout(applyFilter, 280);
});
document.getElementById('dep-filter').addEventListener('change', applyFilter);
document.getElementById('btn-clear').addEventListener('click', clearFilters);
document.getElementById('btn-csv').addEventListener('click', descargarCSV);
document.getElementById('btn-prev').addEventListener('click', () => { page--; renderTable(); });
document.getElementById('btn-next').addEventListener('click', () => { page++; renderTable(); });
document.getElementById('btn-refresh-hist').addEventListener('click', () => selectedId && loadHistory(selectedId));

/* ── Helpers ── */
function showAlert(type, msg) {
  const el = document.getElementById('form-alert');
  el.className = `alert alert-${type} show`;
  el.textContent = msg;
}
function hideAlert() { document.getElementById('form-alert').className = 'alert'; }
function formatDate(d) {
  if (!d) return '—';
  try {
    const fecha = new Date(d);
    if (isNaN(fecha.getTime())) return '—';
    return fecha.toLocaleDateString('es-AR', { day:'2-digit', month:'short', year:'numeric', timeZone: 'UTC' });
  } catch {
    return '—';
  }
}

/* ── Modal: nuevo empleado ── */
const modalOverlay = document.getElementById('modal-overlay');

document.getElementById('btn-nuevo').addEventListener('click', () => {
  ['m-nombre','m-dni','m-dep','m-dias'].forEach(id => document.getElementById(id).value = '');
  document.getElementById('m-region').value = 'CORDOBA';
  document.getElementById('modal-alert').className = 'alert';
  modalOverlay.style.display = 'flex';
  document.getElementById('m-nombre').focus();
});
document.getElementById('btn-modal-close').addEventListener('click', () => { modalOverlay.style.display = 'none'; });
modalOverlay.addEventListener('click', e => { if (e.target === modalOverlay) modalOverlay.style.display = 'none'; });

document.getElementById('btn-modal-guardar').addEventListener('click', async () => {
  const nombre = document.getElementById('m-nombre').value.trim();
  const dni    = document.getElementById('m-dni').value.trim();
  const dep    = document.getElementById('m-dep').value.trim();
  const region = document.getElementById('m-region').value.trim();
  const dias   = parseInt(document.getElementById('m-dias').value);
  const alertEl = document.getElementById('modal-alert');
  const showMA  = msg => { alertEl.className = 'alert alert-error show'; alertEl.textContent = msg; };

  if (!nombre)                    { showMA('El nombre es obligatorio.'); return; }
  if (!dni || !/^\d+$/.test(dni)) { showMA('Ingresá un DNI válido (solo números).'); return; }
  if (!dep)                       { showMA('La dependencia es obligatoria.'); return; }
  if (!dias || dias <= 0)         { showMA('Ingresá una cantidad válida de días.'); return; }

  const btn = document.getElementById('btn-modal-guardar');
  btn.disabled = true; btn.textContent = 'Guardando…';

  try {
    const r = await apiFetch(`${API}/empleados`, {
      method: 'POST',
      body: JSON.stringify({ nombre_apellido: nombre, dni, dependencia: dep, region, dias_totales: dias })
    });
    const data = await r.json();
    if (!r.ok) { showMA(data.error); return; }

    allEmps.push(data);
    allEmps.sort((a, b) => a.nombre_apellido.localeCompare(b.nombre_apellido));
    applyFilter();

    const depFilter = document.getElementById('dep-filter');
    if (data.dependencia && !Array.from(depFilter.options).some(o => o.value === data.dependencia)) {
      const o = document.createElement('option');
      o.value = data.dependencia; o.textContent = data.dependencia;
      depFilter.appendChild(o);
    }
    modalOverlay.style.display = 'none';
    selectEmpleado(data.id);
  } catch (err) {
    if (err.message !== 'Sesión expirada') showMA('Error de conexión con el servidor.');
  } finally {
    btn.disabled = false;
    btn.innerHTML = `<svg style="width:15px;height:15px" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 5v14M5 12h14"/></svg> Guardar Empleado`;
  }
});

/* ── Modal: cambiar contraseña ── */
const modalPassOverlay = document.getElementById('modal-pass-overlay');

document.getElementById('btn-cambiar-pass').addEventListener('click', () => {
  document.getElementById('p-nueva').value    = '';
  document.getElementById('p-confirma').value = '';
  document.getElementById('modal-pass-alert').className = 'alert';
  modalPassOverlay.style.display = 'flex';
  document.getElementById('p-nueva').focus();
});

document.getElementById('btn-modal-pass-close').addEventListener('click', () => {
  modalPassOverlay.style.display = 'none';
});
modalPassOverlay.addEventListener('click', e => {
  if (e.target === modalPassOverlay) modalPassOverlay.style.display = 'none';
});

document.getElementById('btn-modal-pass-guardar').addEventListener('click', async () => {
  const nueva    = document.getElementById('p-nueva').value;
  const confirma = document.getElementById('p-confirma').value;
  const alertEl  = document.getElementById('modal-pass-alert');
  const showPA   = (msg, tipo = 'error') => {
    alertEl.className = `alert alert-${tipo} show`;
    alertEl.textContent = msg;
  };

  if (!nueva || nueva.length < 6) { showPA('La contraseña debe tener al menos 6 caracteres.'); return; }
  if (nueva !== confirma)          { showPA('Las contraseñas no coinciden.'); return; }

  const btn = document.getElementById('btn-modal-pass-guardar');
  btn.disabled = true; btn.textContent = 'Guardando…';

  try {
    const r = await apiFetch(`${API}/cambiar-password`, {
      method: 'POST',
      body: JSON.stringify({ nueva })
    });
    const data = await r.json();
    if (!r.ok) { showPA(data.error); return; }
    showPA(data.message, 'success');
    setTimeout(() => { modalPassOverlay.style.display = 'none'; }, 2500);
  } catch (err) {
    if (err.message !== 'Sesión expirada') showPA('Error de conexión con el servidor.');
  } finally {
    btn.disabled = false;
    btn.innerHTML = `<svg style="width:15px;height:15px" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg> Guardar Contraseña`;
  }
});


/* ══ INICIO ═════════════════════════════════════════════════════════════════ */
// Si ya hay sesión válida, mostrar app directamente
if (isTokenValid()) {
  showApp();
  initApp();
} else {
  showLogin();
}

} // fin if index.html

/* ══ GRILLA DE VACACIONES ════════════════════════════════════════════════════ */
// Solo ejecutar si estamos en grilla.html
if (document.getElementById('grilla-contenido')) {

const MESES = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
const MESES_COMPLETO = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
const LIMITE_MES = 10; // Noviembre = índice 10

let grillaAnio = new Date().getFullYear();
let grillaData = [];

/* ── Navegación ── */
document.getElementById('btn-volver').addEventListener('click', () => {
  window.location.href = 'index.html';
});

document.getElementById('grilla-year-label').textContent = grillaAnio;

document.getElementById('grilla-year-prev').addEventListener('click', () => {
  grillaAnio--;
  document.getElementById('grilla-year-label').textContent = grillaAnio;
  cargarGrilla();
});
document.getElementById('grilla-year-next').addEventListener('click', () => {
  grillaAnio++;
  document.getElementById('grilla-year-label').textContent = grillaAnio;
  cargarGrilla();
});

/* ── Auth ── */
function grillaGetToken()    { return sessionStorage.getItem('vac_token'); }
function grillaTokenValido() {
  const expiry = parseInt(sessionStorage.getItem('vac_expiry') || '0');
  return grillaGetToken() && Date.now() < expiry;
}
if (!grillaTokenValido()) { window.location.href = 'index.html'; }

async function grillaFetch(url) {
  const token = grillaGetToken();
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(url, { headers });
  if (res.status === 401) { window.location.href = 'index.html'; throw new Error('Sesión expirada'); }
  return res;
}

/* ── Carga de datos ── */
async function cargarGrilla() {
  document.getElementById('grilla-loading').style.display   = 'block';
  document.getElementById('grilla-contenido').style.display = 'none';
  document.getElementById('grilla-contenido').innerHTML     = '';
  try {
    const r = await grillaFetch(`${API}/grilla?anio=${grillaAnio}`);
    grillaData = await r.json();
    renderGrilla(grillaData);
  } catch (err) {
    if (err.message !== 'Sesión expirada')
      document.getElementById('grilla-loading').innerHTML =
        '<p style="color:var(--red);text-align:center;padding:2rem">⚠️ Error al cargar la grilla.</p>';
  }
}

/* ── Semáforo ── */
function getSemaforo(e) {
  const pct = e.dias_totales > 0 ? e.dias_programados_anio / e.dias_totales : 0;
  if (pct >= 1)   return 'green';
  if (pct >= 0.5) return 'amber';
  return 'red';
}

/* ── Render ── */
function renderGrilla(data) {
  const porDep = {};
  data.forEach(e => {
    const dep = e.dependencia || 'SIN ÁREA';
    if (!porDep[dep]) porDep[dep] = [];
    porDep[dep].push(e);
  });

  const totalEmp     = data.length;
  const completos    = data.filter(e => getSemaforo(e) === 'green').length;
  const sinProgramar = data.filter(e => getSemaforo(e) === 'red').length;
  document.getElementById('grilla-resumen').textContent =
    `${completos} de ${totalEmp} completos · ${sinProgramar} sin programar`;

  const contenedor = document.getElementById('grilla-contenido');
  contenedor.innerHTML = '';

  Object.keys(porDep).sort().forEach(dep => {
    const empleados    = porDep[dep];
    const section      = document.createElement('div');
    section.className  = 'grilla-section';

    const depHeader    = document.createElement('div');
    depHeader.className = 'grilla-dep-header';
    const completosDep = empleados.filter(e => getSemaforo(e) === 'green').length;
    depHeader.innerHTML = `
      <span class="grilla-dep-name">${dep}</span>
      <span class="grilla-dep-stats">${completosDep}/${empleados.length} completos</span>
    `;
    section.appendChild(depHeader);

    const tableWrap    = document.createElement('div');
    tableWrap.className = 'grilla-table-wrap';
    const table        = document.createElement('table');
    table.className    = 'grilla-table';

    const thead = document.createElement('thead');
    thead.innerHTML = `<tr>
      <th class="grilla-th-name">Empleado</th>
      <th class="grilla-th-stat">Días</th>
      ${MESES.map((m, i) => `<th class="grilla-th-mes${i > LIMITE_MES ? ' grilla-mes-extra' : ''}">${m}</th>`).join('')}
    </tr>`;
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    empleados.forEach(e => {
      const sem = getSemaforo(e);
      const tr  = document.createElement('tr');
      tr.className = 'grilla-row';

      const tdNombre = document.createElement('td');
      tdNombre.className = 'grilla-td-name';
      tdNombre.innerHTML = `
        <span class="semaforo semaforo-${sem}" title="${e.dias_programados_anio}/${e.dias_totales} días"></span>
        <span class="grilla-emp-name">${e.nombre_apellido}</span>
      `;
      tr.appendChild(tdNombre);

      const tdDias = document.createElement('td');
      tdDias.className   = 'grilla-td-stat';
      tdDias.textContent = `${e.dias_programados_anio}/${e.dias_totales}`;
      tr.appendChild(tdDias);

      const cobertura = calcularCobertura(e.movimientos, grillaAnio);
      for (let mes = 0; mes < 12; mes++) {
        const td = document.createElement('td');
        td.className = 'grilla-td-mes' + (mes > LIMITE_MES ? ' grilla-mes-extra' : '');
        if (cobertura[mes] && cobertura[mes].length > 0) {
          cobertura[mes].forEach(bloque => {
            const div       = document.createElement('div');
            div.className   = 'grilla-bloque';
            div.title       = `${bloque.dias}d${bloque.desc ? ' — ' + bloque.desc : ''}\n${grillaFormatDate(bloque.fechaStr)}`;
            div.textContent = bloque.dias + 'd';
            td.appendChild(div);
          });
        }
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    });

    table.appendChild(tbody);
    tableWrap.appendChild(table);
    section.appendChild(tableWrap);
    contenedor.appendChild(section);
  });

  document.getElementById('grilla-loading').style.display   = 'none';
  document.getElementById('grilla-contenido').style.display = 'block';
}

/* ── Cobertura por mes ── */
function calcularCobertura(movimientos, anio) {
  const cobertura = {};
  movimientos.forEach(m => {
    const inicio = new Date(m.fecha     + 'T00:00:00Z');
    const fin    = new Date(m.fecha_fin + 'T00:00:00Z');
    let cur = new Date(inicio);
    while (cur <= fin) {
      if (cur.getUTCFullYear() === anio) {
        const mes = cur.getUTCMonth();
        if (!cobertura[mes]) cobertura[mes] = [];
        if (!cobertura[mes].find(b => b.id === m.id))
          cobertura[mes].push({ id: m.id, dias: m.dias, desc: m.descripcion, fechaStr: m.fecha });
      }
      cur.setUTCMonth(cur.getUTCMonth() + 1);
      cur.setUTCDate(1);
    }
  });
  return cobertura;
}

function grillaFormatDate(d) {
  if (!d) return '—';
  try {
    const fecha = new Date(d);
    if (isNaN(fecha.getTime())) return '—';
    return fecha.toLocaleDateString('es-AR', { day:'2-digit', month:'short', year:'numeric', timeZone:'UTC' });
  } catch { return '—'; }
}

/* ── CSV ── */
document.getElementById('btn-grilla-csv').addEventListener('click', () => {
  if (!grillaData.length) return;
  const filas = [
    ['Dependencia','Apellido y Nombre','DNI','Días Totales','Días Programados', ...MESES_COMPLETO]
  ];
  grillaData.forEach(e => {
    const cobertura = calcularCobertura(e.movimientos, grillaAnio);
    filas.push([
      e.dependencia || '',
      e.nombre_apellido,
      e.dni,
      e.dias_totales,
      e.dias_programados_anio,
      ...MESES_COMPLETO.map((_, i) => cobertura[i] ? cobertura[i].map(b => b.dias + 'd').join('+') : '')
    ]);
  });
  const csv  = filas.map(f => f.map(c => `"${String(c).replace(/"/g,'""')}"`).join(';')).join('\r\n');
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url;
  a.download = `grilla_vacaciones_${grillaAnio}.csv`;
  a.click();
  URL.revokeObjectURL(url);
});

/* ── Inicio ── */
cargarGrilla();

} 
//.