/* ============================================================
   Hourglass — app logic
   Earn time with focus sessions, spend it scrolling.
   Balance is DERIVED from the sessions table (no balances table).
   ============================================================ */

const CFG = window.HOURGLASS_CONFIG || {};
const FULL_AT = CFG.HOURGLASS_FULL_AT_MINUTES || 120;
const configured =
  CFG.SUPABASE_URL && !CFG.SUPABASE_URL.includes('__') &&
  CFG.SUPABASE_ANON_KEY && !CFG.SUPABASE_ANON_KEY.includes('__');

let sb = null;
if (configured) {
  sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY);
}

// ---------- state ----------
let me = null;                 // { id, email, display_name }
let profilesById = {};         // id -> { display_name }
let sessions = [];             // all sessions, all users
let activeSession = null;      // my currently-running session row
let scrollStartBalance = 0;    // balance captured when a scroll began
let tickTimer = null;
let timesUpShown = false;

// ---------- tiny DOM helpers ----------
const $ = (id) => document.getElementById(id);
const show = (el) => el && el.classList.remove('hidden');
const hide = (el) => el && el.classList.add('hidden');

function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), 2200);
}

// =====================================================================
//  AUTH
// =====================================================================
let authMode = 'signin'; // or 'signup'

function setAuthMode(mode) {
  authMode = mode;
  const isSignup = mode === 'signup';
  $('auth-name-wrap').classList.toggle('hidden', !isSignup);
  $('auth-submit').textContent = isSignup ? 'Create account' : 'Sign in';
  $('auth-toggle').innerHTML = isSignup
    ? `Already have an account? <span class="text-clay underline">Sign in</span>`
    : `New here? <span class="text-clay underline">Create an account</span>`;
  $('auth-password').setAttribute('autocomplete', isSignup ? 'new-password' : 'current-password');
  hide($('auth-error'));
}

function authError(msg) {
  const e = $('auth-error');
  e.textContent = msg;
  show(e);
}

async function handleAuthSubmit() {
  if (!sb) { authError('Supabase keys not set in config.js'); return; }
  const email = $('auth-email').value.trim();
  const password = $('auth-password').value;
  const name = $('auth-name').value.trim();
  if (!email || !password) { authError('Email and password please.'); return; }
  if (authMode === 'signup' && !name) { authError('Pick a display name your friends will see.'); return; }

  const btn = $('auth-submit');
  btn.disabled = true;
  btn.textContent = '…';
  hide($('auth-error'));

  try {
    if (authMode === 'signup') {
      const { data, error } = await sb.auth.signUp({ email, password });
      if (error) throw error;
      if (!data.session) {
        // email confirmation still ON — tell the user
        authError("Account made — but check your email to confirm, then sign in. (Or disable email confirmation in Supabase.)");
        setAuthMode('signin');
        return;
      }
      await afterLogin(data.user, name);
    } else {
      const { data, error } = await sb.auth.signInWithPassword({ email, password });
      if (error) throw error;
      await afterLogin(data.user, name);
    }
  } catch (err) {
    authError(prettyAuthError(err));
  } finally {
    btn.disabled = false;
    btn.textContent = authMode === 'signup' ? 'Create account' : 'Sign in';
  }
}

function prettyAuthError(err) {
  const m = (err && err.message) || 'Something went wrong.';
  if (/invalid login/i.test(m)) return 'Wrong email or password.';
  if (/already registered/i.test(m)) return 'That email already has an account — sign in instead.';
  if (/at least 6/i.test(m)) return 'Password needs at least 6 characters.';
  return m;
}

async function ensureProfile(displayName) {
  const fallback = (me.email || 'friend').split('@')[0];
  const { data } = await sb.from('profiles').select('display_name').eq('id', me.id).maybeSingle();
  if (!data) {
    const name = displayName || fallback;
    await sb.from('profiles').insert({ id: me.id, display_name: name });
    me.display_name = name;
  } else {
    me.display_name = data.display_name;
    if (displayName && displayName !== data.display_name) {
      await sb.from('profiles').update({ display_name: displayName }).eq('id', me.id);
      me.display_name = displayName;
    }
  }
}

async function afterLogin(user, displayName) {
  me = { id: user.id, email: user.email, display_name: null };
  await ensureProfile(displayName);
  enterApp();
}

async function handleSignOut() {
  await sb.auth.signOut();
  location.reload();
}

// =====================================================================
//  APP ENTRY / DATA LOADING
// =====================================================================
async function enterApp() {
  hide($('screen-auth'));
  $('screen-auth').classList.remove('flex');
  show($('app-shell'));
  $('home-name').textContent = me.display_name || 'friend';

  await loadAll();

  // resume an orphaned running session, if any
  const running = sessions.find((s) => s.user_id === me.id && !s.ended_at);
  if (running) resumeSession(running);

  subscribeRealtime();
  startTick();
  renderHome();
  renderFriends();
  renderHistory();
}

async function loadAll() {
  await Promise.all([loadProfiles(), loadSessions()]);
}

async function loadProfiles() {
  const { data, error } = await sb.from('profiles').select('id, display_name');
  if (error) { console.warn(error); return; }
  profilesById = {};
  (data || []).forEach((p) => { profilesById[p.id] = p; });
}

async function loadSessions() {
  const { data, error } = await sb
    .from('sessions')
    .select('id, user_id, type, app_target, started_at, ended_at, duration_minutes')
    .order('started_at', { ascending: false });
  if (error) { console.warn(error); return; }
  sessions = data || [];
}

// =====================================================================
//  BALANCE (derived)
// =====================================================================
function balanceFor(userId, nowMs) {
  let total = 0;
  for (const s of sessions) {
    if (s.user_id !== userId) continue;
    let mins;
    if (s.ended_at) {
      mins = Number(s.duration_minutes) || 0;
    } else {
      mins = (nowMs - Date.parse(s.started_at)) / 60000; // running
    }
    total += s.type === 'focus' ? mins : -mins;
  }
  return total;
}

function myBalance(nowMs) { return balanceFor(me.id, nowMs || Date.now()); }

function runningSessionFor(userId) {
  return sessions.find((s) => s.user_id === userId && !s.ended_at) || null;
}

// =====================================================================
//  HOURGLASS RENDER
// =====================================================================
function setHourglass(suffix, balanceMin, active) {
  const f = Math.max(0, Math.min(1, balanceMin / FULL_AT));
  const top = $('sandTop' + suffix);
  const bot = $('sandBottom' + suffix);
  const mound = $('sandMound' + suffix);
  const stream = $('sandStream' + suffix);
  if (!top) return;

  const TOP_NECK = 158, TOP_APEX = 45, TOP_SPAN = TOP_NECK - TOP_APEX;     // 113
  const BOT_BASE = 275, BOT_NECK = 162, BOT_SPAN = BOT_BASE - BOT_NECK;     // 113

  // top sand: more balance -> taller from neck upward
  top.setAttribute('y', (TOP_NECK - TOP_SPAN * f).toFixed(1));
  top.setAttribute('height', '220');

  // bottom sand: the spent portion piles at the base
  const spent = 1 - f;
  bot.setAttribute('y', (BOT_BASE - BOT_SPAN * spent).toFixed(1));
  bot.setAttribute('height', (BOT_SPAN * spent + 4).toFixed(1));
  mound.setAttribute('cy', (BOT_BASE - BOT_SPAN * spent).toFixed(1));
  mound.setAttribute('rx', (50 * spent).toFixed(1));

  if (stream) stream.style.opacity = active ? '1' : '0';
}

// =====================================================================
//  RENDER: HOME
// =====================================================================
function renderHome() {
  const bal = myBalance();
  const rounded = Math.round(bal);
  $('balance-big').innerHTML = `${rounded}<span class="text-2xl font-bold text-inklt"> min</span>`;
  $('balance-caption').textContent = captionFor(bal);
  setHourglass('', bal, !!activeSession);
}

function captionFor(bal) {
  if (bal <= 0) return "Empty — go earn some sand.";
  if (bal < 10) return "Sand's running low.";
  if (bal < 40) return "A little set aside.";
  if (bal < FULL_AT) return "Steadily filling.";
  return "The glass is full.";
}

// =====================================================================
//  RENDER: FRIENDS
// =====================================================================
function renderFriends() {
  const list = $('friends-list');
  const now = Date.now();
  const rows = Object.keys(profilesById).map((uid) => ({
    uid,
    name: profilesById[uid].display_name,
    bal: balanceFor(uid, now),
    running: runningSessionFor(uid),
    isMe: uid === me.id,
  }));
  rows.sort((a, b) => b.bal - a.bal);

  if (rows.length <= 1) { show($('friends-empty')); } else { hide($('friends-empty')); }

  list.innerHTML = rows.map((r, i) => {
    const rank = String(i + 1).padStart(2, '0');
    let status = '';
    if (r.running) {
      status = r.running.type === 'focus' ? 'focusing now' : 'scrolling now';
    }
    return `
      <div class="flex items-center gap-4 border-b border-line py-4 ${r.isMe ? 'bg-card' : ''}">
        <div class="w-6 font-display text-base font-500 text-inkmut tabular-nums">${rank}</div>
        <div class="flex-1 min-w-0">
          <p class="truncate font-display text-lg font-600 text-ink">${escapeHtml(r.name)}${r.isMe ? ' <span class="ml-1 align-middle text-[10px] font-600 uppercase tracking-[0.14em] text-inkmut">you</span>' : ''}</p>
          <p class="text-xs font-500 italic text-inkmut">${status || '&nbsp;'}</p>
        </div>
        <div class="text-right">
          <p class="font-display text-2xl font-500 text-ink tabular-nums"><span id="fbal-${r.uid}">${Math.round(r.bal)}</span><span class="ml-1 font-body text-xs font-500 lowercase text-inkmut">min</span></p>
        </div>
      </div>`;
  }).join('');
}

function updateFriendNumbers() {
  const now = Date.now();
  for (const uid of Object.keys(profilesById)) {
    const el = $('fbal-' + uid);
    if (el) el.textContent = Math.round(balanceFor(uid, now));
  }
}

// =====================================================================
//  RENDER: HISTORY
// =====================================================================
function renderHistory() {
  const list = $('history-list');
  const mine = sessions.filter((s) => s.user_id === me.id);
  if (mine.length === 0) { show($('history-empty')); list.innerHTML = ''; return; }
  hide($('history-empty'));

  list.innerHTML = mine.map((s) => {
    const isFocus = s.type === 'focus';
    const mins = s.ended_at ? Math.round(Number(s.duration_minutes) || 0) : null;
    const label = isFocus ? 'Focus' : (s.app_target ? cap(s.app_target) : 'Scrolling');
    const sign = isFocus ? '+' : '−';
    const when = fmtWhen(s.started_at);
    const amount = mins === null ? 'running' : `${sign}${mins}`;
    return `
      <div class="flex items-baseline gap-4 border-b border-line py-3.5">
        <div class="flex-1">
          <p class="font-600 text-ink">${label}</p>
          <p class="mt-0.5 text-xs font-500 text-inkmut">${when}</p>
        </div>
        <p class="font-display text-xl font-500 tabular-nums ${isFocus ? 'text-ink' : 'text-inkmut'}">${amount}<span class="ml-1 font-body text-xs font-500 lowercase text-inkmut">${mins === null ? '' : 'min'}</span></p>
      </div>`;
  }).join('');
}

// =====================================================================
//  SESSIONS: start / stop
// =====================================================================
async function startFocus() {
  if (activeSession) return;
  const { data, error } = await sb
    .from('sessions')
    .insert({ user_id: me.id, type: 'focus' })
    .select('id, user_id, type, app_target, started_at, ended_at, duration_minutes')
    .single();
  if (error) { toast('Could not start — try again'); console.warn(error); return; }
  sessions.unshift(data);
  resumeSession(data);
}

async function startScroll(target) {
  if (activeSession) return;
  scrollStartBalance = myBalance();
  const { data, error } = await sb
    .from('sessions')
    .insert({ user_id: me.id, type: 'scroll', app_target: target || null })
    .select('id, user_id, type, app_target, started_at, ended_at, duration_minutes')
    .single();
  if (error) { toast('Could not start — try again'); console.warn(error); return; }
  sessions.unshift(data);
  resumeSession(data);
}

function resumeSession(s) {
  activeSession = s;
  timesUpShown = false;
  if (s.type === 'scroll') {
    // recompute the starting balance excluding this running session's drain
    scrollStartBalance = balanceFor(me.id, Date.parse(s.started_at));
  }
  document.body.classList.add('is-active');
  openActiveOverlay();
}

async function stopSession() {
  if (!activeSession) return;
  const s = activeSession;
  const now = Date.now();
  const duration = Math.max(0, (now - Date.parse(s.started_at)) / 60000);

  // optimistic local update
  const idx = sessions.findIndex((x) => x.id === s.id);
  if (idx >= 0) {
    sessions[idx] = { ...sessions[idx], ended_at: new Date(now).toISOString(), duration_minutes: duration };
  }
  activeSession = null;
  document.body.classList.remove('is-active');
  closeActiveOverlay();

  const earned = Math.round(duration);
  toast(s.type === 'focus' ? `+${earned} min earned` : `${earned} min spent`);

  renderHome(); renderFriends(); renderHistory();

  const { error } = await sb
    .from('sessions')
    .update({ ended_at: new Date(now).toISOString(), duration_minutes: duration })
    .eq('id', s.id);
  if (error) { toast('Saved locally — sync issue'); console.warn(error); }
}

// =====================================================================
//  ACTIVE OVERLAY
// =====================================================================
function openActiveOverlay() {
  const o = $('active-overlay');
  const hg2 = $('hourglass2');
  const isFocus = activeSession.type === 'focus';
  // Focus = deep/dark (earning). Scroll = light/exposed (spending). Monochrome inversion.
  if (isFocus) {
    o.style.background = '#1B1A18';
    o.style.color = '#F4F1EA';
    hg2.style.color = '#F4F1EA';
  } else {
    o.style.background = '#F4F1EA';
    o.style.color = '#1B1A18';
    hg2.style.color = '#1B1A18';
  }
  $('active-label').textContent = isFocus
    ? 'Focusing'
    : `Scrolling${activeSession.app_target ? ' — ' + cap(activeSession.app_target) : ''}`;
  $('active-sub').textContent = isFocus ? "The glass is filling." : "The glass is draining.";
  $('sandStream2').style.opacity = '1';
  show(o);
  o.classList.add('flex');
  updateActive();
}

function closeActiveOverlay() {
  const o = $('active-overlay');
  hide(o);
  o.classList.remove('flex');
}

function updateActive() {
  if (!activeSession) return;
  const now = Date.now();
  const elapsedSec = Math.floor((now - Date.parse(activeSession.started_at)) / 1000);
  const isFocus = activeSession.type === 'focus';

  if (isFocus) {
    $('active-timer').textContent = fmtClock(elapsedSec);
    $('active-balance').textContent = `+${Math.floor(elapsedSec / 60)} min and counting`;
    setHourglass('2', myBalance(now), true);
  } else {
    const remainingSec = Math.round(scrollStartBalance * 60 - elapsedSec);
    $('active-timer').textContent = fmtClock(Math.max(0, remainingSec));
    $('active-balance').textContent = remainingSec > 0
      ? `${Math.ceil(remainingSec / 60)} min left`
      : `${Math.abs(Math.floor(remainingSec / 60))} min into the red`;
    setHourglass('2', myBalance(now), true);
    if (remainingSec <= 0 && !timesUpShown) {
      timesUpShown = true;
      show($('timesup-modal'));
      if ('vibrate' in navigator) navigator.vibrate([120, 60, 120]);
    }
  }
}

// =====================================================================
//  TICK (1s heartbeat)
// =====================================================================
function startTick() {
  if (tickTimer) clearInterval(tickTimer);
  tickTimer = setInterval(() => {
    if (activeSession) updateActive();
    renderHome();
    if (!$('screen-friends').classList.contains('hidden')) updateFriendNumbers();
  }, 1000);
}

// =====================================================================
//  REALTIME
// =====================================================================
function subscribeRealtime() {
  sb
    .channel('public:sessions')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'sessions' }, async () => {
      await loadSessions();
      // keep my active session reference fresh
      if (activeSession) {
        const fresh = sessions.find((s) => s.id === activeSession.id);
        if (fresh && fresh.ended_at) { activeSession = null; document.body.classList.remove('is-active'); closeActiveOverlay(); }
      }
      renderHome(); renderFriends(); renderHistory();
    })
    .subscribe();

  // new profiles (new friends signing up) won't fire a sessions event — poll lightly
  setInterval(loadProfiles, 30000);
}

// =====================================================================
//  NAV
// =====================================================================
function go(screen) {
  ['home', 'friends', 'history'].forEach((s) => {
    $('screen-' + s).classList.toggle('hidden', s !== screen);
    $('screen-' + s).classList.toggle('flex', s === screen);
  });
  document.querySelectorAll('.nav-btn').forEach((b) => {
    const on = b.dataset.nav === screen;
    b.classList.toggle('text-clay', on);
    b.classList.toggle('text-inklt', !on);
  });
  if (screen === 'friends') renderFriends();
  if (screen === 'history') renderHistory();
}

// =====================================================================
//  UTILS
// =====================================================================
const cap = (s) => s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
function escapeHtml(s) { return (s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function fmtClock(sec) {
  const m = Math.floor(sec / 60), s = sec % 60;
  if (m >= 60) { const h = Math.floor(m / 60); return `${h}:${String(m % 60).padStart(2, '0')}:${String(s).padStart(2, '0')}`; }
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
function fmtWhen(iso) {
  const d = new Date(iso), now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (sameDay) return `Today, ${time}`;
  const yest = new Date(now); yest.setDate(now.getDate() - 1);
  if (d.toDateString() === yest.toDateString()) return `Yesterday, ${time}`;
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + `, ${time}`;
}

// =====================================================================
//  WIRE UP EVENTS
// =====================================================================
function wireEvents() {
  $('auth-submit').addEventListener('click', handleAuthSubmit);
  $('auth-password').addEventListener('keydown', (e) => { if (e.key === 'Enter') handleAuthSubmit(); });
  $('auth-toggle').addEventListener('click', () => setAuthMode(authMode === 'signin' ? 'signup' : 'signin'));
  $('btn-signout').addEventListener('click', handleSignOut);

  $('btn-start-focus').addEventListener('click', startFocus);
  $('btn-start-scroll').addEventListener('click', () => { show($('picker-modal')); $('picker-modal').classList.add('flex'); });
  $('picker-cancel').addEventListener('click', () => { hide($('picker-modal')); $('picker-modal').classList.remove('flex'); });
  document.querySelectorAll('.picker-opt').forEach((b) =>
    b.addEventListener('click', () => {
      hide($('picker-modal')); $('picker-modal').classList.remove('flex');
      startScroll(b.dataset.target);
    }));

  $('btn-stop').addEventListener('click', stopSession);
  $('timesup-stop').addEventListener('click', () => { hide($('timesup-modal')); stopSession(); });
  $('timesup-keep').addEventListener('click', () => hide($('timesup-modal')));

  document.querySelectorAll('.nav-btn').forEach((b) => b.addEventListener('click', () => go(b.dataset.nav)));
}

// =====================================================================
//  BOOT
// =====================================================================
async function boot() {
  wireEvents();
  setAuthMode('signin');

  if (!configured) {
    show($('screen-auth'));
    $('screen-auth').classList.add('flex');
    show($('auth-config-warn'));
    return;
  }

  const { data } = await sb.auth.getSession();
  if (data && data.session) {
    me = { id: data.session.user.id, email: data.session.user.email, display_name: null };
    await ensureProfile(null);
    await enterApp();
  } else {
    show($('screen-auth'));
    $('screen-auth').classList.add('flex');
  }
}

// service worker
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}

boot();
