/* ════════════════════════════════════════════════════════
   SLOTI — app.js v2.0 (Workspaces)

   Fluxo do usuário:
   1. Login / Cadastro
   2. Se não tem workspace → tela de onboarding:
      a) Criar novo workspace (vira owner, recebe código de convite)
      b) Entrar com código de convite (vira member)
   3. Agenda filtrada pelo workspaceId do usuário

   Firestore collections:
   - users          → { uid, email, name, workspaceId, role }
   - workspaces     → { id, name, ownerId, inviteCode, createdAt }
   - appointments   → { ..., workspaceId }  ← filtro principal

   Preparado para:
   - Google Calendar API (futuro)
   - WhatsApp Business API (futuro)
   - Múltiplos workspaces por usuário (futuro)
   - Painel administrativo (futuro)
════════════════════════════════════════════════════════ */

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import {
  getAuth,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  updateProfile
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import {
  getFirestore,
  collection,
  addDoc,
  deleteDoc,
  doc,
  setDoc,
  getDoc,
  query,
  where,
  getDocs,
  onSnapshot,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

// ──────────────────────────────────
// FIREBASE
// ──────────────────────────────────
const firebaseConfig = {
  apiKey: "AIzaSyDM8-q4bxS_5ZTM9k0xYt123ziJe0-Upzg",
  authDomain: "slotiapp.firebaseapp.com",
  projectId: "slotiapp",
  storageBucket: "slotiapp.firebasestorage.app",
  messagingSenderId: "255112940906",
  appId: "1:255112940906:web:d4da2ae6ebc4e604386913"
};

const firebaseApp = initializeApp(firebaseConfig);
const auth = getAuth(firebaseApp);
const db   = getFirestore(firebaseApp);

// ──────────────────────────────────
// ESTADO GLOBAL
// ──────────────────────────────────
const State = {
  currentUser: null,         // { uid, email, name, workspaceId, role }
  currentWorkspace: null,    // { id, name, ownerId, inviteCode }
  currentDate: new Date(),
  appointments: [],
  professionals: [],
  editingId: null,
  selectedId: null,
  unsubscribeSnapshot: null,
};

const HOURS      = ['08:00','09:00','10:00','11:00','12:00','13:00','14:00','15:00','16:00','17:00','18:00'];
const START_HOUR = 8;
const END_HOUR   = 18;

// ──────────────────────────────────
// CAMADA DE DADOS
// ──────────────────────────────────
const DataLayer = {

  /* ── AUTH ── */

  async register(email, password, name) {
    const credential = await createUserWithEmailAndPassword(auth, email, password);
    const user = credential.user;
    await updateProfile(user, { displayName: name });
    // Cria doc do usuário SEM workspaceId ainda (definido no onboarding)
    await setDoc(doc(db, 'users', user.uid), {
      uid:         user.uid,
      email:       user.email,
      name,
      workspaceId: null,
      role:        null,
      createdAt:   serverTimestamp(),
    });
    return { uid: user.uid, email: user.email, name, workspaceId: null, role: null };
  },

  async login(email, password) {
    const credential = await signInWithEmailAndPassword(auth, email, password);
    const user = credential.user;
    const snap = await getDoc(doc(db, 'users', user.uid));
    const data = snap.exists() ? snap.data() : {};
    return {
      uid:         user.uid,
      email:       user.email,
      name:        data.name || user.displayName || user.email,
      workspaceId: data.workspaceId || null,
      role:        data.role || null,
    };
  },

  async logout() {
    await signOut(auth);
  },

  /* ── WORKSPACES ── */

  // Gera um código de convite curto e legível (6 chars maiúsculos)
  _generateInviteCode() {
    return Math.random().toString(36).substring(2, 8).toUpperCase();
  },

  async createWorkspace(name, ownerUid) {
    const inviteCode = this._generateInviteCode();
    // Garante unicidade do código (raro mas possível)
    const existing = await getDocs(
      query(collection(db, 'workspaces'), where('inviteCode', '==', inviteCode))
    );
    const finalCode = existing.empty ? inviteCode : this._generateInviteCode() + '1';

    const ref = await addDoc(collection(db, 'workspaces'), {
      name,
      ownerId:    ownerUid,
      inviteCode: finalCode,
      createdAt:  serverTimestamp(),
      // members: [] ← futuro: array de uids para controle avançado
    });

    // Cria ou atualiza o doc do usuário com workspaceId e role owner
    // Usa setDoc com merge para não falhar caso o doc ainda não exista
    await setDoc(doc(db, 'users', ownerUid), {
      workspaceId: ref.id,
      role:        'owner',
    }, { merge: true });

    return { id: ref.id, name, ownerId: ownerUid, inviteCode: finalCode };
  },

  async joinWorkspace(inviteCode, uid, userName) {
    // Busca workspace pelo código
    const q    = query(collection(db, 'workspaces'), where('inviteCode', '==', inviteCode.trim().toUpperCase()));
    const snap = await getDocs(q);

    if (snap.empty) throw new Error('Código de convite inválido. Verifique e tente novamente.');

    const wsDoc = snap.docs[0];
    const ws    = { id: wsDoc.id, ...wsDoc.data() };

    // Cria ou atualiza o doc do usuário com workspaceId e role member
    await setDoc(doc(db, 'users', uid), {
      workspaceId: ws.id,
      role:        'member',
    }, { merge: true });

    return { id: ws.id, name: ws.name, ownerId: ws.ownerId, inviteCode: ws.inviteCode };
  },

  async getWorkspace(workspaceId) {
    const snap = await getDoc(doc(db, 'workspaces', workspaceId));
    if (!snap.exists()) return null;
    return { id: snap.id, ...snap.data() };
  },

  /* ── APPOINTMENTS ── */

  async addAppointment(data) {
    const ref = await addDoc(collection(db, 'appointments'), {
      ...data,
      createdAt: serverTimestamp(),
      // googleCalendarEventId: null,  // Google Calendar (futuro)
      // whatsappNotified: false,      // WhatsApp (futuro)
      // status: 'confirmed',          // painel admin (futuro)
    });
    return { id: ref.id, ...data };
  },

  async deleteAppointment(id) {
    await deleteDoc(doc(db, 'appointments', id));
  },

  // Filtra por date E workspaceId — isolamento total entre salões
  watchAppointments(dateStr, workspaceId, callback) {
    const q = query(
      collection(db, 'appointments'),
      where('date',        '==', dateStr),
      where('workspaceId', '==', workspaceId)
    );
    const unsubscribe = onSnapshot(q, (snapshot) => {
      const appts = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
      callback(appts);
    }, (error) => {
      console.error('Firestore onSnapshot error:', error);
      showToast('Erro ao sincronizar agenda. Verifique sua conexão.', 'error');
    });
    return unsubscribe;
  },
};

// ──────────────────────────────────
// AUTH STATE — ponto de entrada
// ──────────────────────────────────
onAuthStateChanged(auth, async (firebaseUser) => {
  document.getElementById('loading').style.display = 'none';

  if (!firebaseUser) {
    showScreen('login-screen');
    return;
  }

  // Usuário logado: busca dados completos
  let userData = { uid: firebaseUser.uid, email: firebaseUser.email,
                   name: firebaseUser.displayName || firebaseUser.email,
                   workspaceId: null, role: null };
  try {
    const snap = await getDoc(doc(db, 'users', firebaseUser.uid));
    if (snap.exists()) {
      const d = snap.data();
      userData = { ...userData, name: d.name || userData.name,
                   workspaceId: d.workspaceId || null, role: d.role || null };
    }
  } catch(_) {}

  State.currentUser = userData;

  if (!userData.workspaceId) {
    // Ainda não pertence a nenhum workspace → onboarding
    showScreen('workspace-screen');
  } else {
    // Já tem workspace → carrega e entra no app
    try {
      const ws = await DataLayer.getWorkspace(userData.workspaceId);
      if (ws) {
        State.currentWorkspace = ws;
        enterApp();
      } else {
        // Workspace foi deletado (edge case)
        showScreen('workspace-screen');
      }
    } catch(_) {
      showScreen('workspace-screen');
    }
  }
});

// ──────────────────────────────────
// TELAS
// ──────────────────────────────────
function showScreen(id) {
  ['loading','login-screen','workspace-screen','app'].forEach(s => {
    const el = document.getElementById(s);
    if (!el) return;
    if (s === 'app') el.classList.remove('visible');
    else el.style.display = 'none';
  });
  const target = document.getElementById(id);
  if (!target) return;
  if (id === 'app') target.classList.add('visible');
  else target.style.display = 'flex';
}

// ──────────────────────────────────
// LOGIN / CADASTRO
// ──────────────────────────────────
function toggleForm(type) {
  document.getElementById('form-login').style.display    = type === 'login'    ? 'block' : 'none';
  document.getElementById('form-register').style.display = type === 'register' ? 'block' : 'none';
  hideError();
}

async function handleLogin() {
  const email = document.getElementById('login-email').value.trim();
  const pass  = document.getElementById('login-password').value;
  if (!email || !pass) return showError('Preencha e-mail e senha.');
  try {
    // onAuthStateChanged cuida do redirecionamento após login
    await DataLayer.login(email, pass);
  } catch(e) {
    showError(friendlyAuthError(e.code));
  }
}

async function handleRegister() {
  const name  = document.getElementById('reg-name').value.trim();
  const email = document.getElementById('reg-email').value.trim();
  const pass  = document.getElementById('reg-password').value;
  if (!name)           return showError('Informe seu nome.');
  if (!email)          return showError('Informe um e-mail.');
  if (pass.length < 6) return showError('A senha deve ter pelo menos 6 caracteres.');
  try {
    await DataLayer.register(email, pass, name);
    // onAuthStateChanged vai detectar e redirecionar para workspace-screen
  } catch(e) {
    showError(friendlyAuthError(e.code));
  }
}

async function handleLogout() {
  closeDropdown();
  if (State.unsubscribeSnapshot) State.unsubscribeSnapshot();
  State.currentUser      = null;
  State.currentWorkspace = null;
  await DataLayer.logout();
}

function friendlyAuthError(code) {
  const map = {
    'auth/user-not-found':         'E-mail não encontrado.',
    'auth/wrong-password':         'Senha incorreta.',
    'auth/invalid-credential':     'E-mail ou senha incorretos.',
    'auth/email-already-in-use':   'Este e-mail já está cadastrado.',
    'auth/weak-password':          'Senha muito fraca. Use pelo menos 6 caracteres.',
    'auth/invalid-email':          'E-mail inválido.',
    'auth/too-many-requests':      'Muitas tentativas. Aguarde alguns minutos.',
    'auth/network-request-failed': 'Sem conexão. Verifique sua internet.',
  };
  return map[code] || 'Ocorreu um erro. Tente novamente.';
}

// ──────────────────────────────────
// ONBOARDING DE WORKSPACE
// ──────────────────────────────────

// Alterna entre os painéis "criar" e "entrar"
function showWorkspacePanel(panel) {
  document.getElementById('ws-panel-choose').style.display = 'none';
  document.getElementById('ws-panel-create').style.display = 'none';
  document.getElementById('ws-panel-join').style.display   = 'none';
  document.getElementById(`ws-panel-${panel}`).style.display = 'block';
  hideWsError();
}

async function handleCreateWorkspace() {
  const name = document.getElementById('ws-name').value.trim();
  if (!name) return showWsError('Informe o nome do seu salão.');
  try {
    setWsLoading(true);
    const ws = await DataLayer.createWorkspace(name, State.currentUser.uid);
    State.currentWorkspace           = ws;
    State.currentUser.workspaceId    = ws.id;
    State.currentUser.role           = 'owner';
    // Exibe o código gerado antes de entrar
    showInviteCode(ws.inviteCode, ws.name);
  } catch(e) {
    showWsError('Erro ao criar workspace: ' + e.message);
  } finally {
    setWsLoading(false);
  }
}

async function handleJoinWorkspace() {
  const code = document.getElementById('ws-invite-code').value.trim();
  if (!code) return showWsError('Digite o código de convite.');
  try {
    setWsLoading(true);
    const ws = await DataLayer.joinWorkspace(code, State.currentUser.uid, State.currentUser.name);
    State.currentWorkspace        = ws;
    State.currentUser.workspaceId = ws.id;
    State.currentUser.role        = 'member';
    showToast(`Bem-vinda ao ${ws.name}! 🎉`, 'success');
    enterApp();
  } catch(e) {
    showWsError(e.message);
  } finally {
    setWsLoading(false);
  }
}

function showInviteCode(code, wsName) {
  // Mostra painel de confirmação com o código de convite
  document.getElementById('ws-panel-create').style.display = 'none';
  const panel = document.getElementById('ws-panel-code');
  panel.style.display = 'block';
  document.getElementById('ws-created-name').textContent = wsName;
  document.getElementById('ws-code-display').textContent = code;
}

function copyInviteCode() {
  const code = document.getElementById('ws-code-display').textContent;
  navigator.clipboard.writeText(code).then(() => {
    showToast('Código copiado!', 'success');
  });
}

function finishOnboarding() {
  enterApp();
}

function setWsLoading(on) {
  const btns = document.querySelectorAll('#workspace-screen .btn-primary');
  btns.forEach(b => { b.disabled = on; b.style.opacity = on ? '0.6' : '1'; });
}

function showWsError(msg) {
  const el = document.getElementById('ws-error');
  el.textContent = msg;
  el.classList.add('show');
}

function hideWsError() {
  const el = document.getElementById('ws-error');
  if (el) el.classList.remove('show');
}

// ──────────────────────────────────
// ENTRAR NO APP
// ──────────────────────────────────
function enterApp() {
  const user = State.currentUser;
  const ws   = State.currentWorkspace;

  // Header
  const initials = user.name.split(' ').map(w => w[0]).join('').substring(0,2).toUpperCase();
  document.getElementById('user-avatar-header').textContent = initials;
  document.getElementById('user-name-header').textContent   = user.name.split(' ')[0];
  document.getElementById('dd-name').textContent            = user.name;
  document.getElementById('dd-email').textContent           = user.email;

  // Nome do workspace no header
  const wsNameEl = document.getElementById('workspace-name');
  if (wsNameEl && ws) wsNameEl.textContent = ws.name;

  // Código de convite no dropdown (só para owner)
  const ddInvite = document.getElementById('dd-invite');
  if (ddInvite) ddInvite.style.display = user.role === 'owner' ? 'flex' : 'none';

  // Profissional no formulário
  document.getElementById('f-prof-option').textContent = user.name;
  document.getElementById('f-prof-option').value       = user.uid;

  showScreen('app');
  goToToday();
}

// Copia código de convite do workspace atual (ação do dropdown)
function copyWorkspaceCode() {
  if (!State.currentWorkspace?.inviteCode) return;
  navigator.clipboard.writeText(State.currentWorkspace.inviteCode).then(() => {
    showToast(`Código ${State.currentWorkspace.inviteCode} copiado!`, 'success');
  });
  closeDropdown();
}

// ──────────────────────────────────
// CALENDÁRIO
// ──────────────────────────────────
function goToToday() {
  State.currentDate = new Date();
  loadDay();
}

function changeDay(offset) {
  const d = new Date(State.currentDate);
  d.setDate(d.getDate() + offset);
  State.currentDate = d;
  loadDay();
}

function loadDay() {
  updateDateDisplay();
  const dateStr = formatDate(State.currentDate);
  if (State.unsubscribeSnapshot) State.unsubscribeSnapshot();
  // onSnapshot filtra por workspaceId — isolamento total
  State.unsubscribeSnapshot = DataLayer.watchAppointments(
    dateStr,
    State.currentUser.workspaceId,
    (appts) => {
      State.appointments = appts;
      renderCalendar();
    }
  );
}

function updateDateDisplay() {
  const d        = State.currentDate;
  const today    = new Date();
  const isToday  = formatDate(d) === formatDate(today);
  const weekdays = ['Domingo','Segunda','Terça','Quarta','Quinta','Sexta','Sábado'];
  const months   = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];
  const mFull    = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];
  const label    = isToday
    ? `Hoje, ${d.getDate()} de ${mFull[d.getMonth()]}`
    : `${weekdays[d.getDay()]}, ${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()}`;
  document.getElementById('date-display').textContent = label;
}

function renderCalendar() {
  const grid = document.getElementById('calendar-grid');
  const profMap = {};
  State.appointments.forEach(a => { profMap[a.professionalUid] = a.professionalName; });
  if (State.currentUser) profMap[State.currentUser.uid] = State.currentUser.name;

  const professionals = Object.entries(profMap).map(([uid, name], i) => ({
    uid, name, colorIdx: i % 4
  }));
  State.professionals = professionals;

  let html = '';
  html += `<div class="time-col">`;
  HOURS.forEach(h => { html += `<div class="time-slot"><span>${h}</span></div>`; });
  html += `</div><div class="professionals-area">`;

  professionals.forEach(prof => {
    const myAppts = State.appointments.filter(a => a.professionalUid === prof.uid);
    html += `<div class="professional-col">
      <div class="professional-header">
        <div class="professional-avatar">${getInitials(prof.name)}</div>
        <span>${prof.name.split(' ')[0]}</span>
      </div>
      <div class="col-body" onclick="onColClick(event,'${prof.uid}')">`;

    HOURS.forEach((h, i) => {
      if (i < HOURS.length - 1) html += `<div class="hour-line" data-hour="${h}"></div>`;
    });

    const now = new Date();
    if (formatDate(now) === formatDate(State.currentDate)) {
      const pct = timeToPercent(`${now.getHours()}:${String(now.getMinutes()).padStart(2,'0')}`);
      if (pct >= 0 && pct <= 100) html += `<div class="current-time-line" style="top:${pct}%"></div>`;
    }

    myAppts.forEach(appt => {
      const top    = timeToPercent(appt.startTime);
      const height = Math.max(timeToPercent(appt.endTime) - top, 4);
      if (top < 0 || top > 100) return;
      html += `<div class="appointment-block appt-color-${prof.colorIdx}"
        style="top:${top}%;height:${height}%;min-height:48px;"
        onclick="event.stopPropagation();openDetail('${appt.id}')"
        title="${appt.clientName} — ${appt.procedure}">
        <div class="appt-name">${escHtml(appt.clientName)}</div>
        <div class="appt-proc">${escHtml(appt.procedure)}</div>
        <div class="appt-time">${appt.startTime} – ${appt.endTime}</div>
      </div>`;
    });

    html += `</div></div>`;
  });

  html += `</div>`;
  grid.innerHTML = html;

  setTimeout(() => {
    const now = new Date();
    if (formatDate(now) === formatDate(State.currentDate)) {
      const pct    = timeToPercent(`${now.getHours()}:${String(now.getMinutes()).padStart(2,'0')}`);
      const totalH = (END_HOUR - START_HOUR) * 72;
      document.getElementById('calendar-container').scrollTop =
        Math.max(0, (pct / 100) * totalH - 120);
    }
  }, 50);
}

// ──────────────────────────────────
// AGENDAMENTOS
// ──────────────────────────────────
function openNewModal(startTime = '') {
  State.editingId = null;
  document.getElementById('modal-title').textContent = 'Novo Agendamento';
  document.getElementById('f-client').value    = '';
  document.getElementById('f-procedure').value = '';
  document.getElementById('f-contact').value   = '';
  document.getElementById('f-start').value     = startTime;
  document.getElementById('f-end').value       = '';
  hideModalError();
  openModal('modal-new');
}

function onColClick(event, profUid) {
  const rect     = event.currentTarget.getBoundingClientRect();
  const y        = event.clientY - rect.top - 40;
  const totalH   = (END_HOUR - START_HOUR) * 72;
  const pct      = Math.max(0, Math.min(1, y / totalH));
  const minutes  = Math.round(pct * (END_HOUR - START_HOUR) * 60 / 30) * 30;
  const totalMin = START_HOUR * 60 + minutes;
  const timeStr  = `${String(Math.floor(totalMin/60)).padStart(2,'0')}:${String(totalMin%60).padStart(2,'0')}`;
  const endMin   = Math.min(totalMin + 60, END_HOUR * 60);
  const endStr   = `${String(Math.floor(endMin/60)).padStart(2,'0')}:${String(endMin%60).padStart(2,'0')}`;
  openNewModal(timeStr);
  document.getElementById('f-end').value = endStr;
}

async function saveAppointment() {
  hideModalError();
  const client    = document.getElementById('f-client').value.trim();
  const procedure = document.getElementById('f-procedure').value.trim();
  const contact   = document.getElementById('f-contact').value.trim();
  const start     = document.getElementById('f-start').value;
  const end       = document.getElementById('f-end').value;

  if (!client)    return showModalError('Informe o nome da cliente.');
  if (!procedure) return showModalError('Informe o procedimento.');
  if (!start)     return showModalError('Informe o horário de início.');
  if (!end)       return showModalError('Informe o horário de término.');
  if (start >= end) return showModalError('O término deve ser depois do início.');
  if (toMinutes(start) < START_HOUR * 60) return showModalError('Horário mínimo: 08:00.');
  if (toMinutes(end)   > END_HOUR   * 60) return showModalError('Horário máximo: 18:00.');

  const dateStr  = formatDate(State.currentDate);
  const conflict = State.appointments.find(a =>
    a.professionalUid === State.currentUser.uid &&
    a.id !== State.editingId &&
    a.date === dateStr &&
    toMinutes(a.startTime) < toMinutes(end) &&
    toMinutes(a.endTime)   > toMinutes(start)
  );
  if (conflict) return showModalError(
    `⚠️ Conflito! Você já tem "${conflict.clientName}" das ${conflict.startTime} às ${conflict.endTime}.`
  );

  const data = {
    clientName:       client,
    procedure,
    contact,
    startTime:        start,
    endTime:          end,
    date:             dateStr,
    workspaceId:      State.currentUser.workspaceId,  // ← isolamento
    professionalUid:  State.currentUser.uid,
    professionalName: State.currentUser.name,
  };

  try {
    await DataLayer.addAppointment(data);
    closeModal('modal-new');
    showToast('Agendamento salvo!', 'success');
  } catch(e) {
    showModalError('Erro ao salvar: ' + e.message);
  }
}

function openDetail(id) {
  const appt = State.appointments.find(a => a.id === id);
  if (!appt) return;
  State.selectedId = id;
  const isOwner = appt.professionalUid === State.currentUser.uid;

  document.getElementById('detail-body').innerHTML = `
    <div class="detail-row">
      <div class="detail-icon">👤</div>
      <div class="detail-content"><label>Cliente</label><span>${escHtml(appt.clientName)}</span></div>
    </div>
    <div class="detail-row">
      <div class="detail-icon">✂️</div>
      <div class="detail-content"><label>Procedimento</label><span>${escHtml(appt.procedure)}</span></div>
    </div>
    <div class="detail-row">
      <div class="detail-icon">📱</div>
      <div class="detail-content"><label>Contato</label><span>${escHtml(appt.contact || '—')}</span></div>
    </div>
    <div class="detail-row">
      <div class="detail-icon">🕐</div>
      <div class="detail-content"><label>Horário</label><span>${appt.startTime} – ${appt.endTime}</span></div>
    </div>
    <div class="detail-row">
      <div class="detail-icon">💆</div>
      <div class="detail-content"><label>Profissional</label><span>${escHtml(appt.professionalName)}</span></div>
    </div>
    ${!isOwner ? '<p style="font-size:.78rem;color:var(--text-muted);margin-top:12px;text-align:center">Apenas a profissional responsável pode excluir este agendamento.</p>' : ''}
  `;
  const delBtn = document.querySelector('#modal-detail .modal-footer .btn-ghost:first-child');
  if (delBtn) delBtn.style.display = isOwner ? 'inline-flex' : 'none';
  openModal('modal-detail');
}

async function deleteAppointment() {
  if (!State.selectedId) return;
  if (!confirm('Deseja realmente excluir este agendamento?')) return;
  try {
    await DataLayer.deleteAppointment(State.selectedId);
    closeModal('modal-detail');
    showToast('Agendamento removido.', 'success');
  } catch(e) {
    showToast('Erro ao excluir: ' + e.message, 'error');
  }
}

// ──────────────────────────────────
// UI HELPERS
// ──────────────────────────────────
function openModal(id)    { document.getElementById(id).classList.add('open'); }
function closeModal(id)   { document.getElementById(id).classList.remove('open'); }
function toggleUserMenu() { document.getElementById('user-dropdown').classList.toggle('open'); }
function closeDropdown()  { document.getElementById('user-dropdown').classList.remove('open'); }

document.addEventListener('click', (e) => {
  const wrapper = document.querySelector('.user-chip-wrapper');
  if (wrapper && !wrapper.contains(e.target)) closeDropdown();
});

function showError(msg) {
  const el = document.getElementById('error-msg');
  el.textContent = msg; el.classList.add('show');
}
function hideError() { document.getElementById('error-msg').classList.remove('show'); }

function showModalError(msg) {
  const el = document.getElementById('modal-error');
  el.textContent = msg; el.classList.add('show');
}
function hideModalError() { document.getElementById('modal-error').classList.remove('show'); }

function showToast(msg, type = '') {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  const icons = { success: '✓', error: '✕', warning: '⚠' };
  toast.innerHTML = `<span>${icons[type] || 'ℹ'}</span> ${escHtml(msg)}`;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 3500);
}

function openDatePicker() {
  const input = document.createElement('input');
  input.type = 'date';
  input.value = formatDate(State.currentDate);
  input.style.cssText = 'position:absolute;opacity:0;pointer-events:none';
  document.body.appendChild(input);
  input.showPicker?.();
  input.addEventListener('change', () => {
    if (input.value) {
      const [y,m,d] = input.value.split('-').map(Number);
      State.currentDate = new Date(y, m-1, d);
      loadDay();
    }
    input.remove();
  });
  input.addEventListener('blur', () => input.remove());
}

// ──────────────────────────────────
// HELPERS PUROS
// ──────────────────────────────────
function formatDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function toMinutes(t) {
  const [h,m] = t.split(':').map(Number); return h*60+m;
}
function timeToPercent(t) {
  const [h,m] = t.split(':').map(Number);
  return ((h*60+m - START_HOUR*60) / ((END_HOUR-START_HOUR)*60)) * 100;
}
function getInitials(name) {
  return name.split(' ').map(w=>w[0]).join('').substring(0,2).toUpperCase();
}
function escHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ──────────────────────────────────
// INICIALIZAÇÃO
// ──────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  setInterval(() => { if (State.currentUser?.workspaceId) renderCalendar(); }, 60000);
  document.getElementById('login-password')?.addEventListener('keydown', e => { if(e.key==='Enter') handleLogin(); });
  document.getElementById('login-email')?.addEventListener('keydown',    e => { if(e.key==='Enter') handleLogin(); });
  document.getElementById('ws-invite-code')?.addEventListener('keydown', e => { if(e.key==='Enter') handleJoinWorkspace(); });
  document.getElementById('ws-name')?.addEventListener('keydown',        e => { if(e.key==='Enter') handleCreateWorkspace(); });
});

// Expõe funções para o HTML inline
window.toggleForm            = toggleForm;
window.handleLogin           = handleLogin;
window.handleRegister        = handleRegister;
window.handleLogout          = handleLogout;
window.showWorkspacePanel    = showWorkspacePanel;
window.handleCreateWorkspace = handleCreateWorkspace;
window.handleJoinWorkspace   = handleJoinWorkspace;
window.copyInviteCode        = copyInviteCode;
window.finishOnboarding      = finishOnboarding;
window.copyWorkspaceCode     = copyWorkspaceCode;
window.goToToday             = goToToday;
window.changeDay             = changeDay;
window.openDatePicker        = openDatePicker;
window.openNewModal          = openNewModal;
window.onColClick            = onColClick;
window.saveAppointment       = saveAppointment;
window.openDetail            = openDetail;
window.deleteAppointment     = deleteAppointment;
window.openModal             = openModal;
window.closeModal            = closeModal;
window.toggleUserMenu        = toggleUserMenu;