let centers = [
  { name: "Tirur", company: "KH", username: "tirur", password: "1234", tillDate: 0, yesterday: 0, target: 0, cagToday: 0, cagTotal: 0, kasp: 0, general: 0, medisep: 0 },
  { name: "Calicut", company: "KH", username: "calicut", password: "1234", tillDate: 0, yesterday: 0, target: 0, cagToday: 0, cagTotal: 0, kasp: 0, general: 0, medisep: 0 },
  { name: "Kochi", company: "KH", username: "kochi", password: "1234", tillDate: 0, yesterday: 0, target: 0, cagToday: 0, cagTotal: 0, kasp: 0, general: 0, medisep: 0 },
  { name: "Malappuram", company: "KH", username: "malappuram", password: "1234", tillDate: 0, yesterday: 0, target: 0, cagToday: 0, cagTotal: 0, kasp: 0, general: 0, medisep: 0 },
  { name: "Perumpilavu", company: "KH", username: "perumpilavu", password: "1234", tillDate: 0, yesterday: 0, target: 0, cagToday: 0, cagTotal: 0, kasp: 0, general: 0, medisep: 0 },
  { name: "Edappal", company: "KH", username: "edappal", password: "1234", tillDate: 0, yesterday: 0, target: 0, cagToday: 0, cagTotal: 0, kasp: 0, general: 0, medisep: 0 },
  { name: "Valanchery", company: "KH", username: "valanchery", password: "1234", tillDate: 0, yesterday: 0, target: 0, cagToday: 0, cagTotal: 0, kasp: 0, general: 0, medisep: 0 }
];
const DEFAULT_CENTERS = JSON.parse(JSON.stringify(centers));
const COMPANY_OPTIONS = ["KH", "Swizton"];
let activeCompany = "KH";

let currentRole = "admin"; // "superadmin" | "admin" | "centre"
let loggedInCentreIndex = 0;
let loggedInAdminIndex = -1; // index into admins[] for regular admin; -1 = superadmin
let loginType = "centre";
let reportDate = new Date().toLocaleDateString('en-CA', {
  timeZone: 'Asia/Kolkata'
});
let activeCentreDashboardIndex = 0;
const entries = {};
// entryMeta[centreIndex][date] = { savedAt: ISO string, savedBy: centreName }
const entryMeta = {};
// unlockRequests: array of { id, centreIndex, centreName, date, reason, status, requestedAt, resolvedAt }
let unlockRequests = [];
// auditLog: array of { id, centreIndex, centreName, date, savedAt, savedBy, type, unlockRequestId, before, after }
let auditLog = [];
// adminAuditLog: tracks admin actions (approve/reject unlock, target change, revert, etc.)
// { id, adminName, action, detail, centreIndexes, timestamp }
let adminAuditLog = [];
// admins: [{ id, name, username, passwordHash, assignedCentres: [0,1,...], createdAt }]
let admins = [];
let swiztonEntries = [];
let swiztonEditingId = null;
let swiztonConsolidatedMapping = {
  ufeLeadsGenerated: "ufeLeadsGenerated",
  vericoseLeadsGenerated: "vericoseLeadsGenerated",
  ufeOpGenerated: "ufeOpSeen",
  vericoseOpGenerated: "vericoseOpSeen",
  ufeAdvices: "ufeAdvices",
  vericoseAdvices: "vericoseAdvices",
  ufeDigitalProcedures: "ufeProcedureDone",
  vericoseDigitalProcedures: "vericoseProcedureDone",
  ufeTotalProcedures: "ufeProcedureDone",
  vericoseTotalProcedures: "vericoseProcedureDone"
};
const STORAGE_KEY = "kh-cardio-ops-state-v1";
const CONFIG = window.KH_CONFIG || {};
let supabaseClient = null;
let persistenceReady = false;
let saveTimer = null;
let partialRestoreContext = null;

function getMonthEndDate(dateStr) {
  const d = new Date(dateStr + "T00:00:00");
  const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0);
  return lastDay.toLocaleDateString('en-CA', {
    timeZone: 'Asia/Kolkata'
  });
}
const monthStartDates = {
  "2026-04": "2026-04-01",
  "2026-03": "2026-03-01",
  "2026-02": "2026-02-01"
};

// ─── Security helpers ────────────────────────────────────────────────────────

const SESSION_KEY = "kh-session-v1";
const LOCKOUT_KEY = "kh-lockout-v1";
const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 30_000; // 30 seconds

/** SHA-256 a plaintext string → lowercase hex digest */
async function sha256(text) {
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text)
  );
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Read or create the rate-limit bucket stored in sessionStorage */
function getLockout() {
  try {
    return JSON.parse(sessionStorage.getItem(LOCKOUT_KEY) || "{}");
  } catch {
    return {};
  }
}

function saveLockout(data) {
  sessionStorage.setItem(LOCKOUT_KEY, JSON.stringify(data));
}

/** Returns seconds remaining in lockout, or 0 if not locked */
function lockoutSecondsLeft() {
  const { until = 0 } = getLockout();
  return Math.max(0, Math.ceil((until - Date.now()) / 1000));
}

function recordFailedAttempt() {
  const lock = getLockout();
  lock.attempts = (lock.attempts || 0) + 1;
  if (lock.attempts >= MAX_ATTEMPTS) {
    lock.until = Date.now() + LOCKOUT_MS;
    lock.attempts = 0; // reset counter after locking
  }
  saveLockout(lock);
}

function resetAttempts() {
  saveLockout({});
}

/** Persist a lightweight session token (role + centreIndex + adminIndex) in sessionStorage */
function saveSession(role, centreIndex, adminIndex = -1) {
  sessionStorage.setItem(
    SESSION_KEY,
    JSON.stringify({ role, centreIndex, adminIndex, ts: Date.now() })
  );
}

function clearSession() {
  sessionStorage.removeItem(SESSION_KEY);
}

function loadSession() {
  try {
    return JSON.parse(sessionStorage.getItem(SESSION_KEY) || "null");
  } catch {
    return null;
  }
}

// ─── Date lock helpers ───────────────────────────────────────────────────────

function todayIST() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

/** Returns true if the date is in the past (not today) for the current centre */
function isDateLocked(date, centreIndex) {
  if (date > todayIST()) return false; // future — blocked elsewhere
  if (date === todayIST()) return false; // today — always editable
  // Past date: editable only if an approved unlock exists for this centre+date
  return !getApprovedUnlock(centreIndex, date);
}

/** Returns true if an approved unlock has passed its expiresAt time */
function isUnlockExpired(req) {
  if (!req || req.status !== "approved") return true;
  if (!req.expiresAt) return false; // legacy — no expiry set, treat as valid
  return Date.now() > new Date(req.expiresAt).getTime();
}

/** Returns the approved, non-expired unlock request for a centre+date, or null */
function getApprovedUnlock(centreIndex, date) {
  const req = unlockRequests.find(
    (r) => r.centreIndex === centreIndex && r.date === date && r.status === "approved"
  );
  if (!req || isUnlockExpired(req)) return null;
  return req;
}

/** Format remaining time on an unlock window */
function formatTimeRemaining(expiresAt) {
  if (!expiresAt) return "";
  const ms = new Date(expiresAt).getTime() - Date.now();
  if (ms <= 0) return "Expired";
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins}m remaining`;
  const hrs = Math.floor(mins / 60);
  const rem = mins % 60;
  return rem ? `${hrs}h ${rem}m remaining` : `${hrs}h remaining`;
}

/** Returns a pending request for this centre+date, or null */
function getPendingUnlock(centreIndex, date) {
  return unlockRequests.find(
    (r) => r.centreIndex === centreIndex && r.date === date && r.status === "pending"
  ) || null;
}

// ─── Admin audit log helpers ─────────────────────────────────────────────────

function writeAdminAuditLog(action, detail, centreIndexes = []) {
  const actorName = currentRole === "superadmin"
    ? "Super Admin"
    : (admins[loggedInAdminIndex]?.name || "Admin");
  adminAuditLog.push({
    id: Date.now(),
    adminName: actorName,
    role: currentRole,
    action,
    detail,
    centreIndexes,
    timestamp: new Date().toISOString()
  });
  if (adminAuditLog.length > 1000) adminAuditLog.splice(0, adminAuditLog.length - 1000);
}

function getCurrentActorLabel() {
  if (currentRole === "superadmin") return "Super Admin";
  if (currentRole === "admin") {
    const admin = admins[loggedInAdminIndex];
    return admin?.name || admin?.username || "Admin";
  }
  if (currentRole === "centre") {
    return centers[loggedInCentreIndex]?.name || "Centre User";
  }
  return "System";
}

/** Returns the centre indexes visible to the current admin session */
function getAssignedCentreIndexes() {
  if (currentRole === "superadmin") return centers.map((_, i) => i);
  if (currentRole === "admin" && loggedInAdminIndex >= 0) {
    const admin = admins[loggedInAdminIndex];
    if (!admin) return [];
    if (!admin.assignedCentres || admin.assignedCentres.length === 0) return centers.map((_, i) => i);
    return admin.assignedCentres.filter(i => i < centers.length);
  }
  return centers.map((_, i) => i);
}

function ensureCenterCompanies() {
  centers.forEach((center) => {
    if (!center.company) center.company = "KH";
  });
}

function centerMatchesActiveCompany(center) {
  return (center?.company || "KH") === activeCompany;
}

function ensureProcedureCompanies() {
  if (!Array.isArray(procedureSettings)) procedureSettings = [];
  procedureSettings.forEach((procedure) => {
    if (!procedure.company) procedure.company = "KH";
  });
}

function procedureMatchesCompany(procedure, company = activeCompany) {
  return (procedure?.company || "KH") === company;
}

function activeCompanyProcedureRows(company = activeCompany) {
  ensureProcedureCompanies();
  return procedureSettings
    .map((procedure, index) => ({ procedure, index }))
    .filter(({ procedure }) => procedureMatchesCompany(procedure, company));
}

function getCompanyScopedCentreIndexes() {
  const assigned = getAssignedCentreIndexes();
  if (currentRole === "centre") return assigned;
  return assigned.filter((index) => centerMatchesActiveCompany(centers[index]));
}



function setEntryMeta(centreIndex, date, centreName) {
  if (!entryMeta[centreIndex]) entryMeta[centreIndex] = {};
  entryMeta[centreIndex][date] = {
    savedAt: new Date().toISOString(),
    savedBy: centreName
  };
}

function getEntryMeta(centreIndex, date) {
  return entryMeta[centreIndex]?.[date] || null;
}

function formatSavedAt(isoString) {
  if (!isoString) return "";
  const d = new Date(isoString);
  return d.toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: true
  });
}



// ─── Audit log helpers ───────────────────────────────────────────────────────

function deepCloneEntry(entry) {
  return JSON.parse(JSON.stringify(entry));
}

function deepCloneValue(value, fallback = null) {
  if (value === undefined) return fallback;
  return JSON.parse(JSON.stringify(value));
}

function confirmRestoreAction(title, detail) {
  const firstStep = window.confirm(`${title}\n\n${detail}\n\nDo you want to continue?`);
  if (!firstStep) return false;
  return window.confirm(`Final confirmation\n\n${title}\n\nPlease confirm once more to proceed.`);
}

function writeAuditLog(centreIndex, date, before, after) {
  const center = centers[centreIndex];
  const isUnlocked = !!getApprovedUnlock(centreIndex, date);
  const unlockReq = isUnlocked
    ? unlockRequests.find(r => r.centreIndex === centreIndex && r.date === date && r.status === "approved")
    : null;

  auditLog.push({
    id: Date.now(),
    centreIndex,
    centreName: center.name,
    date,
    savedAt: new Date().toISOString(),
    savedBy: center.name,
    type: isUnlocked ? "unlocked-edit" : "normal",
    unlockRequestId: unlockReq?.id || null,
    before: deepCloneEntry(before),
    after:  deepCloneEntry(after)
  });

  // Keep last 500 entries to avoid bloating state
  if (auditLog.length > 500) auditLog.splice(0, auditLog.length - 500);
}

function revertAuditEntry(auditId) {
  const log = auditLog.find(l => l.id === auditId);
  if (!log) return;

  const ok = window.confirm(
    `Revert ${log.centreName} — ${displayDate(log.date)} to the version saved before ${formatSavedAt(log.savedAt)}?\n\nThis will overwrite current data for that date.`
  );
  if (!ok) return;

  // Write a new audit entry recording the revert itself
  const current = deepCloneEntry(getEntry(log.centreIndex, log.date));
  const entry = getEntry(log.centreIndex, log.date);
  entry.op         = deepCloneEntry(log.before.op || {});
  entry.referrals  = deepCloneEntry(log.before.referrals || {});
  entry.procedures = deepCloneEntry(log.before.procedures || {});

  auditLog.push({
    id: Date.now(),
    centreIndex: log.centreIndex,
    centreName:  log.centreName,
    date:        log.date,
    savedAt:     new Date().toISOString(),
    savedBy:     "Admin (revert)",
    type:        "revert",
    revertedFromId: auditId,
    before:      current,
    after:       deepCloneEntry(entry)
  });

  setEntryMeta(log.centreIndex, log.date, "Admin (revert)");
  writeAdminAuditLog(
    "revert_entry",
    `Reverted ${log.centreName} / ${displayDate(log.date)} to version from ${formatSavedAt(log.savedAt)}`,
    [log.centreIndex]
  );
  refreshCenterRollups(reportDate);
  renderConsolidated();
  renderBars();
  renderPayerSplit();
  if (currentRole === "centre") renderEntryForCurrentDate();
  saveLocalBackup();
  if (supabaseClient) {
    Promise.all([
      saveOneEntry(log.centreIndex, log.date),
      saveOneMeta(log.centreIndex, log.date),
      saveLatestAuditEntry()
    ]).catch(console.error);
  }
  renderAuditLog();
  showToast(`Reverted ${log.centreName} / ${displayDate(log.date)}`);
}

function getAppState() {
  return {
    centers,
    procedureSettings,
    swiztonEntries,
    swiztonConsolidatedMapping,
    entries,
    entryMeta,
    unlockRequests,
    auditLog,
    adminAuditLog,
    admins,
    reportDate
  };
}

function applyAppState(state) {
  if (!state) return false;
  if (Array.isArray(state.centers)) centers = state.centers;
  if (Array.isArray(state.procedureSettings)) procedureSettings = state.procedureSettings;
  if (Array.isArray(state.swiztonEntries)) swiztonEntries = state.swiztonEntries;
  if (state.swiztonConsolidatedMapping && typeof state.swiztonConsolidatedMapping === "object") {
    swiztonConsolidatedMapping = { ...swiztonConsolidatedMapping, ...state.swiztonConsolidatedMapping };
  }
  if (state.entries && typeof state.entries === "object") {
    Object.keys(entries).forEach((key) => delete entries[key]);
    Object.assign(entries, state.entries);
  }
  if (state.entryMeta && typeof state.entryMeta === "object") {
    Object.keys(entryMeta).forEach((key) => delete entryMeta[key]);
    Object.assign(entryMeta, state.entryMeta);
  }
  if (Array.isArray(state.unlockRequests)) unlockRequests = state.unlockRequests;
  if (Array.isArray(state.auditLog)) auditLog = state.auditLog;
  if (Array.isArray(state.adminAuditLog)) adminAuditLog = state.adminAuditLog;
  if (Array.isArray(state.admins)) admins = state.admins;
  // Always use today — never restore a stale saved date
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  setReportDate(today);
  return true;
}

async function setupPersistence() {
  const hasSupabaseConfig = CONFIG.supabaseUrl && CONFIG.supabaseAnonKey && window.supabase;
  if (hasSupabaseConfig) {
    supabaseClient = window.supabase.createClient(CONFIG.supabaseUrl, CONFIG.supabaseAnonKey);
  }
  persistenceReady = true;
  return loadPersistedState();
}

// ─── LOAD ─────────────────────────────────────────────────────────────────────

async function loadPersistedState() {
  if (supabaseClient) {
    try {
      const ok = await loadFromSupabase();
      if (ok) {
        mergeLocalSupplementalState();
        return true;
      }
      console.warn("Supabase load failed or empty — falling back to localStorage");
    } catch (err) {
      console.warn("Supabase load threw:", err);
    }
  }
  return loadFromLocalStorage();
}

async function loadFromSupabase() {
  // 1. App config (centers + procedures + admin state when available)
  const { data: cfg, error: cfgErr } = await supabaseClient
    .from("app_config")
    .select("*")
    .eq("id", "main")
    .maybeSingle();

  if (cfgErr || !cfg) return false;

  centers = cfg.centers || centers;
  procedureSettings = cfg.procedures || procedureSettings;
  if (Array.isArray(cfg.swizton_entries)) swiztonEntries = cfg.swizton_entries;
  if (cfg.swizton_mapping && typeof cfg.swizton_mapping === "object") {
    swiztonConsolidatedMapping = { ...swiztonConsolidatedMapping, ...cfg.swizton_mapping };
  }
  if (Array.isArray(cfg.admins)) admins = cfg.admins;
  if (Array.isArray(cfg.admin_audit_log)) adminAuditLog = cfg.admin_audit_log;

  // 2. Daily entries → rebuild nested entries object
  const { data: rows, error: rowsErr } = await supabaseClient
    .from("daily_entries")
    .select("centre_index, entry_date, op, referrals, procedures");

  if (!rowsErr && rows) {
    Object.keys(entries).forEach(k => delete entries[k]);
    rows.forEach(r => {
      if (!entries[r.centre_index]) entries[r.centre_index] = {};
      entries[r.centre_index][r.entry_date] = {
        op:         r.op         || {},
        referrals:  r.referrals  || {},
        procedures: r.procedures || {}
      };
    });
  }

  // 3. Entry metadata
  const { data: metas, error: metaErr } = await supabaseClient
    .from("entry_meta")
    .select("centre_index, entry_date, saved_at, saved_by");

  if (!metaErr && metas) {
    Object.keys(entryMeta).forEach(k => delete entryMeta[k]);
    metas.forEach(m => {
      if (!entryMeta[m.centre_index]) entryMeta[m.centre_index] = {};
      entryMeta[m.centre_index][m.entry_date] = {
        savedAt: m.saved_at,
        savedBy: m.saved_by
      };
    });
  }

  // 4. Unlock requests
  const { data: reqs, error: reqsErr } = await supabaseClient
    .from("unlock_requests")
    .select("*")
    .order("requested_at", { ascending: false });

  if (!reqsErr && reqs) {
    unlockRequests = reqs.map(r => ({
      id:             r.id,
      centreIndex:    r.centre_index,
      centreName:     r.centre_name,
      date:           r.entry_date,
      reason:         r.reason,
      status:         r.status,
      requestedAt:    r.requested_at,
      resolvedAt:     r.resolved_at,
      expiresAt:      r.expires_at
    }));
  }

  // 5. Audit log (most recent 500)
  const { data: logs, error: logsErr } = await supabaseClient
    .from("audit_log")
    .select("*")
    .order("saved_at", { ascending: false })
    .limit(500);

  if (!logsErr && logs) {
    auditLog = logs.reverse().map(l => ({
      id:               l.id,
      centreIndex:      l.centre_index,
      centreName:       l.centre_name,
      date:             l.entry_date,
      savedAt:          l.saved_at,
      savedBy:          l.saved_by,
      type:             l.type,
      unlockRequestId:  l.unlock_request_id,
      revertedFromId:   l.reverted_from_id,
      before:           l.before_state || {},
      after:            l.after_state  || {}
    }));
  }

  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  setReportDate(today);
  return true;
}

function mergeLocalSupplementalState() {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (!saved) return;
  try {
    const state = JSON.parse(saved);
    if ((!Array.isArray(admins) || admins.length === 0) && Array.isArray(state.admins) && state.admins.length) {
      admins = state.admins;
    }
    if ((!Array.isArray(adminAuditLog) || adminAuditLog.length === 0) && Array.isArray(state.adminAuditLog) && state.adminAuditLog.length) {
      adminAuditLog = state.adminAuditLog;
    }
  } catch (err) {
    console.warn("Could not merge local supplemental state:", err);
  }
}

function loadFromLocalStorage() {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (!saved) return false;
  try {
    const state = JSON.parse(saved);
    if (Array.isArray(state.centers)) centers = state.centers;
    if (Array.isArray(state.procedureSettings)) procedureSettings = state.procedureSettings;
    if (Array.isArray(state.swiztonEntries)) swiztonEntries = state.swiztonEntries;
    if (state.swiztonConsolidatedMapping && typeof state.swiztonConsolidatedMapping === "object") {
      swiztonConsolidatedMapping = { ...swiztonConsolidatedMapping, ...state.swiztonConsolidatedMapping };
    }
    if (state.entries && typeof state.entries === "object") {
      Object.keys(entries).forEach(k => delete entries[k]);
      Object.assign(entries, state.entries);
    }
    if (state.entryMeta && typeof state.entryMeta === "object") {
      Object.keys(entryMeta).forEach(k => delete entryMeta[k]);
      Object.assign(entryMeta, state.entryMeta);
    }
    if (Array.isArray(state.unlockRequests)) unlockRequests = state.unlockRequests;
    if (Array.isArray(state.auditLog)) auditLog = state.auditLog;
    if (Array.isArray(state.adminAuditLog)) adminAuditLog = state.adminAuditLog;
    if (Array.isArray(state.admins)) admins = state.admins;
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    setReportDate(today);
    return true;
  } catch (err) {
    console.warn("localStorage parse failed:", err);
    return false;
  }
}

// ─── SAVE ─────────────────────────────────────────────────────────────────────

// Granular save: only persist what changed.
// Call persistSoon() for debounced full save.
// Call persistEntry(centreIndex, date) for a targeted entry + meta + audit save.

function persistSoon() {
  if (!persistenceReady) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveAll, 250);
}

async function saveAll() {
  saveLocalBackup();
  if (!supabaseClient) { showToast("Saved locally (offline mode)"); return; }

  try {
    await Promise.all([
      saveConfig(),
      saveAllEntries(),
      saveAllMeta(),
      saveAllUnlockRequests(),
      saveAllAuditLog()
    ]);
    showToast("Data saved successfully");
  } catch (err) {
    console.error("saveAll failed:", err);
    showToast("Save failed due to a network issue");
  }
  await createBackup();
  await cleanupBackups();
}

// Targeted save called right after a centre submits daily entry
async function persistEntry(centreIndex, date) {
  saveLocalBackup();
  if (!supabaseClient) { showToast("Saved locally (offline mode)"); return; }
  try {
    await Promise.all([
      saveOneEntry(centreIndex, date),
      saveOneMeta(centreIndex, date),
      saveLatestAuditEntry()
    ]);
    showToast("Data saved successfully");
  } catch (err) {
    console.error("persistEntry failed:", err);
    showToast("Save failed. Check your connection");
  }
}

// ─── Individual save helpers ──────────────────────────────────────────────────

function saveLocalBackup() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(getAppState()));
}

async function saveConfig() {
  const payload = {
    id: "main",
    centers,
    procedures: procedureSettings,
    swizton_entries: swiztonEntries,
    swizton_mapping: swiztonConsolidatedMapping,
    admins,
    admin_audit_log: adminAuditLog,
    updated_at: new Date().toISOString()
  };

  let { error } = await supabaseClient
    .from("app_config")
    .upsert(payload);

  // Backward-compatible fallback for older schemas. Local backup still keeps every field.
  if (error && /admins|admin_audit_log|swizton_entries|swizton_mapping/i.test(error.message || "")) {
    const fallbackPayload = { ...payload };
    if (/admins|admin_audit_log/i.test(error.message || "")) {
      delete fallbackPayload.admins;
      delete fallbackPayload.admin_audit_log;
    }
    if (/swizton_entries/i.test(error.message || "")) {
      delete fallbackPayload.swizton_entries;
    }
    if (/swizton_mapping/i.test(error.message || "")) {
      delete fallbackPayload.swizton_mapping;
    }
    ({ error } = await supabaseClient.from("app_config").upsert(fallbackPayload));
    if (!error) {
      console.warn("Supabase app_config is missing newer columns. Re-run schema.sql so all app data is stored in the cloud.");
    }
  }

  if (error) throw error;
}

async function saveOneEntry(centreIndex, date) {
  const entry = getEntry(centreIndex, date);
  const { error } = await supabaseClient
    .from("daily_entries")
    .upsert({
      centre_index: centreIndex,
      centre_name:  centers[centreIndex]?.name || "",
      entry_date:   date,
      op:           entry.op         || {},
      referrals:    entry.referrals  || {},
      procedures:   entry.procedures || {},
      updated_at:   new Date().toISOString()
    }, { onConflict: "centre_index,entry_date" });
  if (error) throw error;
}

async function saveAllEntries() {
  const rows = [];
  Object.keys(entries).forEach(ci => {
    Object.keys(entries[ci]).forEach(date => {
      const e = entries[ci][date];
      rows.push({
        centre_index: Number(ci),
        centre_name:  centers[ci]?.name || "",
        entry_date:   date,
        op:           e.op         || {},
        referrals:    e.referrals  || {},
        procedures:   e.procedures || {},
        updated_at:   new Date().toISOString()
      });
    });
  });
  if (!rows.length) return;
  const { error } = await supabaseClient
    .from("daily_entries")
    .upsert(rows, { onConflict: "centre_index,entry_date" });
  if (error) throw error;
}

async function saveOneMeta(centreIndex, date) {
  const meta = getEntryMeta(centreIndex, date);
  if (!meta) return;
  const { error } = await supabaseClient
    .from("entry_meta")
    .upsert({
      centre_index: centreIndex,
      entry_date:   date,
      saved_at:     meta.savedAt,
      saved_by:     meta.savedBy
    }, { onConflict: "centre_index,entry_date" });
  if (error) throw error;
}

async function saveAllMeta() {
  const rows = [];
  Object.keys(entryMeta).forEach(ci => {
    Object.keys(entryMeta[ci]).forEach(date => {
      const m = entryMeta[ci][date];
      rows.push({ centre_index: Number(ci), entry_date: date, saved_at: m.savedAt, saved_by: m.savedBy });
    });
  });
  if (!rows.length) return;
  const { error } = await supabaseClient
    .from("entry_meta")
    .upsert(rows, { onConflict: "centre_index,entry_date" });
  if (error) throw error;
}

async function saveAllUnlockRequests() {
  if (!unlockRequests.length) return;
  const rows = unlockRequests.map(r => ({
    id:           r.id,
    centre_index: r.centreIndex,
    centre_name:  r.centreName,
    entry_date:   r.date,
    reason:       r.reason,
    status:       r.status,
    requested_at: r.requestedAt,
    resolved_at:  r.resolvedAt || null,
    expires_at:   r.expiresAt  || null
  }));
  const { error } = await supabaseClient
    .from("unlock_requests")
    .upsert(rows, { onConflict: "id" });
  if (error) throw error;
}

async function saveOneUnlockRequest(req) {
  const { error } = await supabaseClient
    .from("unlock_requests")
    .upsert({
      id:           req.id,
      centre_index: req.centreIndex,
      centre_name:  req.centreName,
      entry_date:   req.date,
      reason:       req.reason,
      status:       req.status,
      requested_at: req.requestedAt,
      resolved_at:  req.resolvedAt || null,
      expires_at:   req.expiresAt  || null
    }, { onConflict: "id" });
  if (error) throw error;
}

async function saveLatestAuditEntry() {
  if (!auditLog.length) return;
  const l = auditLog[auditLog.length - 1];
  const { error } = await supabaseClient
    .from("audit_log")
    .upsert({
      id:                l.id,
      centre_index:      l.centreIndex,
      centre_name:       l.centreName,
      entry_date:        l.date,
      saved_at:          l.savedAt,
      saved_by:          l.savedBy,
      type:              l.type,
      unlock_request_id: l.unlockRequestId || null,
      reverted_from_id:  l.revertedFromId  || null,
      before_state:      l.before || {},
      after_state:       l.after  || {}
    }, { onConflict: "id" });
  if (error) throw error;
}

async function saveAllAuditLog() {
  if (!auditLog.length) return;
  const rows = auditLog.map(l => ({
    id:                l.id,
    centre_index:      l.centreIndex,
    centre_name:       l.centreName,
    entry_date:        l.date,
    saved_at:          l.savedAt,
    saved_by:          l.savedBy,
    type:              l.type,
    unlock_request_id: l.unlockRequestId || null,
    reverted_from_id:  l.revertedFromId  || null,
    before_state:      l.before || {},
    after_state:       l.after  || {}
  }));
  const { error } = await supabaseClient
    .from("audit_log")
    .upsert(rows, { onConflict: "id" });
  if (error) throw error;
}
let procedureSettings = [
  { name: "CAG", counted: false, isCag: true, active: true },
  { name: "PTCA", counted: true, isCag: false, active: true },
  { name: "POBA only", counted: true, isCag: false, active: true },
  { name: "Attempted PTCA", counted: true, isCag: false, active: true },
  { name: "PTCA + POBA", counted: true, isCag: false, active: true },
  { name: "PAG", counted: true, isCag: false, active: true },
  { name: "PTA", counted: true, isCag: false, active: true },
  { name: "TPI", counted: true, isCag: false, active: true },
  { name: "PPI", counted: true, isCag: false, active: true },
  { name: "DEVICE CLOSURE", counted: true, isCag: false, active: true },
  { name: "ROTA / PLNRY", counted: true, isCag: false, active: true },
  { name: "TMBRY", counted: true, isCag: false, active: true },
  { name: "PERICARDIOCENTESIS", counted: false, isCag: false, active: true }
];
const DEFAULT_PROCEDURE_SETTINGS = JSON.parse(JSON.stringify(procedureSettings));

function ensureBootstrapData() {
  let changed = false;
  if (!Array.isArray(centers) || centers.length === 0) {
    centers = JSON.parse(JSON.stringify(DEFAULT_CENTERS));
    changed = true;
  }
  if (!Array.isArray(procedureSettings) || procedureSettings.length === 0) {
    procedureSettings = JSON.parse(JSON.stringify(DEFAULT_PROCEDURE_SETTINGS));
    changed = true;
  }
  const hadUntaggedProcedures = procedureSettings.some((procedure) => !procedure.company);
  ensureProcedureCompanies();
  if (hadUntaggedProcedures) changed = true;
  if (!Array.isArray(swiztonEntries)) {
    swiztonEntries = [];
    changed = true;
  }
  return changed;
}

function activeProcedures() {
  return activeCompanyProcedureRows().filter(({ procedure }) => procedure.active).map(({ procedure }) => procedure.name);
}

function countedProcedures() {
  return activeCompanyProcedureRows().filter(({ procedure }) => procedure.active && procedure.counted).map(({ procedure }) => procedure.name);
}

function cagProcedures() {
  return activeCompanyProcedureRows().filter(({ procedure }) => procedure.active && procedure.isCag).map(({ procedure }) => procedure.name);
}

function isCountedProcedure(procedureName) {
  return activeCompanyProcedureRows().some(({ procedure }) => procedure.name === procedureName && procedure.active && procedure.counted);
}
const opMetrics = ["Total OP", "IP", "New OP", "ECG", "ECHO", "TMT"];
const adminOpsMetrics = ["Total OP", "IP", "New OP", "ECG", "ECHO", "TMT"];
const referralMetrics = [
  "Patient Referral - OP",
  "Patient Referral - ECG",
  "Patient Referral - ECHO",
  "Patient Referral - TMT",
  "Patient Referral - CAG",
  "Patient Referral - PTCA",
  "Patient Referral - Others"
];

function emptyEntry() {
  return {
    op: {},
    referrals: {},
    procedures: {}
  };
}

function ensureCentreEntries(centerIndex) {
  if (!entries[centerIndex]) entries[centerIndex] = {};
  return entries[centerIndex];
}

function getEntry(centerIndex, date) {
  const centreEntries = ensureCentreEntries(centerIndex);
  if (!centreEntries[date]) centreEntries[date] = emptyEntry();
  return centreEntries[date];
}

function sameMonth(dateA, dateB) {
  return dateA.slice(0, 7) === dateB.slice(0, 7);
}

function displayDate(date) {
  const [year, month, day] = date.split("-");
  return `${day}-${month}-${year}`;
}

function selectedMonthLabel() {
  const select = document.getElementById("monthSelect");
  return select.options[select.selectedIndex].text;
}

function exportMonthLabel() {
  const select = document.getElementById("exportMonth");
  return select.options[select.selectedIndex].text;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  })[char]);
}

function datesBefore(centerIndex, date) {
  return Object.keys(ensureCentreEntries(centerIndex))
    .filter((entryDate) => sameMonth(entryDate, date) && entryDate < date)
    .sort();
}

function datesBetween(centerIndex, fromDate, toDate) {
  return Object.keys(ensureCentreEntries(centerIndex))
    .filter((entryDate) => entryDate >= fromDate && entryDate <= toDate)
    .sort();
}

function getProcedure(entry, procedure, payer) {
  return currencySafeNumber(entry.procedures[procedure]?.[payer]);
}

function setProcedure(entry, procedure, payer, value) {
  if (!entry.procedures[procedure]) entry.procedures[procedure] = {};
  entry.procedures[procedure][payer] = currencySafeNumber(value);
}

function sumOpBefore(centerIndex, date, metric, source = "op") {
  return datesBefore(centerIndex, date).reduce((total, entryDate) => {
    return total + currencySafeNumber(entries[centerIndex][entryDate][source][metric]);
  }, 0);
}

function sumProcedureBefore(centerIndex, date, procedure, payer) {
  return datesBefore(centerIndex, date).reduce((total, entryDate) => {
    return total + getProcedure(entries[centerIndex][entryDate], procedure, payer);
  }, 0);
}

function procedureValuesFor(centerIndex, date, procedure) {
  const entry = getEntry(centerIndex, date);
  return {
    generalPrev: sumProcedureBefore(centerIndex, date, procedure, "general"),
    generalToday: getProcedure(entry, procedure, "general"),
    kaspPrev: sumProcedureBefore(centerIndex, date, procedure, "kasp"),
    kaspToday: getProcedure(entry, procedure, "kasp"),
    medisepPrev: sumProcedureBefore(centerIndex, date, procedure, "medisep"),
    medisepToday: getProcedure(entry, procedure, "medisep")
  };
}

function interventionRollup(centerIndex, date) {
  return countedProcedures().reduce(
    (totals, procedure) => {
      const values = procedureValuesFor(centerIndex, date, procedure);
      totals.tillYesterday += values.generalPrev + values.kaspPrev + values.medisepPrev;
      totals.today += values.generalToday + values.kaspToday + values.medisepToday;
      totals.general += values.generalPrev + values.generalToday;
      totals.kasp += values.kaspPrev + values.kaspToday;
      totals.medisep += values.medisepPrev + values.medisepToday;
      return totals;
    },
    { tillYesterday: 0, today: 0, general: 0, kasp: 0, medisep: 0 }
  );
}

function cagRollup(centerIndex, date) {
  return cagProcedures().reduce(
    (totals, procedure) => {
      const values = procedureValuesFor(centerIndex, date, procedure);
      totals.today += values.generalToday + values.kaspToday + values.medisepToday;
      totals.total += values.generalPrev + values.generalToday + values.kaspPrev + values.kaspToday + values.medisepPrev + values.medisepToday;
      return totals;
    },
    { today: 0, total: 0 }
  );
}

function opRollup(centerIndex, date, metric, source = "op") {
  const entry = getEntry(centerIndex, date);
  const tillYesterday = sumOpBefore(centerIndex, date, metric, source);
  const today = currencySafeNumber(entry[source][metric]);
  return { tillYesterday, today, total: tillYesterday + today };
}

function entryInterventionTotal(entry) {
  return countedProcedures().reduce((total, procedure) => {
    return total + getProcedure(entry, procedure, "general") + getProcedure(entry, procedure, "kasp") + getProcedure(entry, procedure, "medisep");
  }, 0);
}

function entryCagTotal(entry) {
  return cagProcedures().reduce((total, procedure) => {
    return total + getProcedure(entry, procedure, "general") + getProcedure(entry, procedure, "kasp") + getProcedure(entry, procedure, "medisep");
  }, 0);
}

function entryPayerTotals(entry) {
  return countedProcedures().reduce(
    (totals, procedure) => {
      totals.general += getProcedure(entry, procedure, "general");
      totals.kasp += getProcedure(entry, procedure, "kasp");
      totals.medisep += getProcedure(entry, procedure, "medisep");
      return totals;
    },
    { general: 0, kasp: 0, medisep: 0 }
  );
}

function getFilteredCenterIndexes() {
  if (currentRole === "centre") return [loggedInCentreIndex];
  const assigned = getAssignedCentreIndexes();
  const value = document.getElementById("exportCentre")?.value || "all";
  if (value === "all") return assigned;
  const idx = Number(value);
  // Only allow selecting a centre the admin is assigned to
  return assigned.includes(idx) ? [idx] : assigned;
}

function getExportRange() {
  return {
    fromDate: document.getElementById("exportFromDate").value,
    toDate: document.getElementById("exportToDate").value
  };
}

function filteredDailyRows() {
  const { fromDate, toDate } = getExportRange();
  const rows = [];
  getFilteredCenterIndexes().forEach((centerIndex) => {
    datesBetween(centerIndex, fromDate, toDate).forEach((date) => {
      const entry = entries[centerIndex][date];
      const payers = entryPayerTotals(entry);
      rows.push({
        date,
        center: centers[centerIndex].name,
        intervention: entryInterventionTotal(entry),
        cag: entryCagTotal(entry),
        general: payers.general,
        kasp: payers.kasp,
        medisep: payers.medisep,
        op: currencySafeNumber((entry.op || {})["Total OP"]),
        ip: currencySafeNumber((entry.op || {}).IP),
        newOp: currencySafeNumber((entry.op || {})["New OP"]),
        ecg: currencySafeNumber((entry.op || {}).ECG),
        echo: currencySafeNumber((entry.op || {}).ECHO),
        tmt: currencySafeNumber((entry.op || {}).TMT)
      });
    });
  });
  return rows.sort((a, b) => a.date.localeCompare(b.date) || a.center.localeCompare(b.center));
}

function filteredConsolidatedRows() {
  const { toDate } = getExportRange();
  return getFilteredCenterIndexes().map((centerIndex) => {
    const center = centers[centerIndex];
    const intervention = interventionRollup(centerIndex, toDate);
    const cag = cagRollup(centerIndex, toDate);
    const op = Object.fromEntries(adminOpsMetrics.map((metric) => [metric, opRollup(centerIndex, toDate, metric)]));
    const total = intervention.tillYesterday + intervention.today;
    return {
      center: center.name,
      target: center.target,
      tillYesterday: intervention.tillYesterday,
      today: intervention.today,
      total,
      percent: center.target ? Math.round((total / center.target) * 100) : 0,
      cagToday: cag.today,
      cagTotal: cag.total,
      general: intervention.general,
      kasp: intervention.kasp,
      medisep: intervention.medisep,
      opTotal: op["Total OP"].total,
      ipTotal: op.IP.total,
      newOpTotal: op["New OP"].total,
      ecgTotal: op.ECG.total,
      echoTotal: op.ECHO.total,
      tmtTotal: op.TMT.total
    };
  });
}

function consolidatedTotals(rows) {
  return rows.reduce(
    (totals, row) => {
      ["target", "tillYesterday", "today", "total", "cagToday", "cagTotal", "general", "kasp", "medisep", "opTotal", "ipTotal", "newOpTotal", "ecgTotal", "echoTotal", "tmtTotal"].forEach((key) => {
        totals[key] += row[key] || 0;
      });
      return totals;
    },
    { target: 0, tillYesterday: 0, today: 0, total: 0, cagToday: 0, cagTotal: 0, general: 0, kasp: 0, medisep: 0, opTotal: 0, ipTotal: 0, newOpTotal: 0, ecgTotal: 0, echoTotal: 0, tmtTotal: 0 }
  );
}

function selectedReportType() {
  return document.getElementById("exportReportType")?.value || "consolidated";
}

const SWIZTON_NUMERIC_FIELDS = [
  "ufeLeadsGenerated",
  "ufeGenuineLeads",
  "ufeInvalidLeads",
  "ufeOpBooked",
  "ufeOpSeen",
  "vericoseLeadsGenerated",
  "vericoseGenuineLeads",
  "vericoseInvalidLeads",
  "vericoseOpBooked",
  "vericoseOpSeen",
  "ufeAdvices",
  "ufeProcedureDone",
  "ufeProcedureScheduled",
  "ufeCashIssue",
  "ufeInsuranceIssue",
  "ufeOtherReasons",
  "ufeProcedureMissed",
  "ufeTotalProcedureDone",
  "vericoseAdvices",
  "vericoseProcedureDone",
  "vericoseProcedureScheduled",
  "vericoseCashIssue",
  "vericoseInsuranceIssue",
  "vericoseOtherReasons",
  "vericoseProcedureMissed",
  "vericoseTotalProcedureDone"
];

const SWIZTON_FIELD_IDS = {
  month: "swiztonMonth",
  centre: "swiztonCentre",
  campaign: "swiztonCampaign",
  campaignDate: "swiztonCampaignDate",
  ufeLeadsGenerated: "swUfeLeadsGenerated",
  ufeGenuineLeads: "swUfeGenuineLeads",
  ufeInvalidLeads: "swUfeInvalidLeads",
  ufeOpBooked: "swUfeOpBooked",
  ufeOpSeen: "swUfeOpSeen",
  vericoseLeadsGenerated: "swVericoseLeadsGenerated",
  vericoseGenuineLeads: "swVericoseGenuineLeads",
  vericoseInvalidLeads: "swVericoseInvalidLeads",
  vericoseOpBooked: "swVericoseOpBooked",
  vericoseOpSeen: "swVericoseOpSeen",
  ufeAdvices: "swUfeAdvices",
  ufeProcedureDone: "swUfeProcedureDone",
  ufeProcedureScheduled: "swUfeProcedureScheduled",
  ufeCashIssue: "swUfeCashIssue",
  ufeInsuranceIssue: "swUfeInsuranceIssue",
  ufeOtherReasons: "swUfeOtherReasons",
  ufeProcedureMissed: "swUfeProcedureMissed",
  ufeTotalProcedureDone: "swUfeTotalProcedureDone",
  vericoseAdvices: "swVericoseAdvices",
  vericoseProcedureDone: "swVericoseProcedureDone",
  vericoseProcedureScheduled: "swVericoseProcedureScheduled",
  vericoseCashIssue: "swVericoseCashIssue",
  vericoseInsuranceIssue: "swVericoseInsuranceIssue",
  vericoseOtherReasons: "swVericoseOtherReasons",
  vericoseProcedureMissed: "swVericoseProcedureMissed",
  vericoseTotalProcedureDone: "swVericoseTotalProcedureDone"
};

const SWIZTON_CONSOLIDATED_COLUMNS = [
  { key: "ufeLeadsGenerated", label: "No. of Leads Generated (UFE)" },
  { key: "vericoseLeadsGenerated", label: "No. of Leads Generated (Vericose)" },
  { key: "ufeOpGenerated", label: "No. of OP generated (UFE)" },
  { key: "vericoseOpGenerated", label: "No. of OP generated (Vericose)" },
  { key: "ufeAdvices", label: "No. of Advices (UFE)" },
  { key: "vericoseAdvices", label: "No. of Advices (Vericose)" },
  { key: "ufeDigitalProcedures", label: "Digital Procedures Done (UFE)" },
  { key: "vericoseDigitalProcedures", label: "Digital Procedures Done (Vericose)" },
  { key: "ufeTotalProcedures", label: "Total Procedures Done (UFE)" },
  { key: "vericoseTotalProcedures", label: "Total Procedures Done (Vericose)" }
];

const SWIZTON_SOURCE_OPTIONS = [
  { value: "", label: "Blank / Manual later" },
  { value: "ufeLeadsGenerated", label: "Leads - UFE - Leads Generated" },
  { value: "ufeGenuineLeads", label: "Leads - UFE - Genuine Leads" },
  { value: "ufeInvalidLeads", label: "Leads - UFE - RNR/WCB/Wrong Queries" },
  { value: "ufeOpBooked", label: "Leads - UFE - OP Booked" },
  { value: "ufeOpSeen", label: "Leads - UFE - OP Seen" },
  { value: "vericoseLeadsGenerated", label: "Leads - Vericose - Leads Generated" },
  { value: "vericoseGenuineLeads", label: "Leads - Vericose - Genuine Leads" },
  { value: "vericoseInvalidLeads", label: "Leads - Vericose - RNR/WCB/Wrong Queries" },
  { value: "vericoseOpBooked", label: "Leads - Vericose - OP Booked" },
  { value: "vericoseOpSeen", label: "Leads - Vericose - OP Seen" },
  { value: "ufeAdvices", label: "Advices - UFE - No. of Advices" },
  { value: "ufeProcedureDone", label: "Advices - UFE - Procedure Done" },
  { value: "ufeProcedureScheduled", label: "Advices - UFE - Procedure Scheduled" },
  { value: "ufeCashIssue", label: "Advices - UFE - Cash Issue" },
  { value: "ufeInsuranceIssue", label: "Advices - UFE - Insurance Issue" },
  { value: "ufeOtherReasons", label: "Advices - UFE - Other Reasons" },
  { value: "ufeProcedureMissed", label: "Advices - UFE - Procedure Missed" },
  { value: "vericoseAdvices", label: "Advices - Vericose - No. of Advices" },
  { value: "vericoseProcedureDone", label: "Advices - Vericose - Procedure Done" },
  { value: "vericoseProcedureScheduled", label: "Advices - Vericose - Procedure Scheduled" },
  { value: "vericoseCashIssue", label: "Advices - Vericose - Cash Issue" },
  { value: "vericoseInsuranceIssue", label: "Advices - Vericose - Insurance Issue" },
  { value: "vericoseOtherReasons", label: "Advices - Vericose - Other Reasons" },
  { value: "vericoseProcedureMissed", label: "Advices - Vericose - Procedure Missed" }
];

function selectedSwiztonMonth() {
  return document.getElementById("monthSelect")?.value || reportDate.slice(0, 7);
}

function getSwiztonRows(month = selectedSwiztonMonth()) {
  return swiztonEntries
    .filter((entry) => (entry.month || "").slice(0, 7) === month)
    .sort((a, b) =>
      (a.campaignDate || "").localeCompare(b.campaignDate || "") ||
      (a.centre || "").localeCompare(b.centre || "") ||
      (a.campaign || "").localeCompare(b.campaign || "")
    );
}

function swiztonTotalProcedure(entry, type) {
  const totalKey = `${type}TotalProcedureDone`;
  const doneKey = `${type}ProcedureDone`;
  return currencySafeNumber(entry[totalKey]) || currencySafeNumber(entry[doneKey]);
}

function swiztonMappedValue(entry, columnKey) {
  const sourceKey = swiztonConsolidatedMapping[columnKey];
  if (!sourceKey) return "";
  return currencySafeNumber(entry[sourceKey]);
}

function swiztonConsolidatedRow(entry, index = 0) {
  const values = Object.fromEntries(
    SWIZTON_CONSOLIDATED_COLUMNS.map((column) => [column.key, swiztonMappedValue(entry, column.key)])
  );
  return {
    slNo: index + 1,
    month: entry.month || "",
    centre: entry.centre || "",
    campaign: entry.campaign || "",
    campaignDate: entry.campaignDate || "",
    id: entry.id,
    ...values
  };
}

function swiztonTotals(rows = getSwiztonRows()) {
  return rows.reduce((totals, entry) => {
    SWIZTON_CONSOLIDATED_COLUMNS.forEach((column) => {
      totals[column.key] += currencySafeNumber(swiztonMappedValue(entry, column.key));
    });
    return totals;
  }, Object.fromEntries(SWIZTON_CONSOLIDATED_COLUMNS.map((column) => [column.key, 0])));
}

function reportTotals(rows) {
  return rows.reduce(
    (totals, row) => {
      Object.keys(totals).forEach((key) => {
        if (key !== "days") totals[key] += row[key] || 0;
      });
      totals.days.add(row.date);
      return totals;
    },
    { intervention: 0, cag: 0, general: 0, kasp: 0, medisep: 0, op: 0, ip: 0, newOp: 0, ecg: 0, echo: 0, tmt: 0, days: new Set() }
  );
}

function reportForecast(rows) {
  const totals = reportTotals(rows);
  const dayCount = Math.max(1, totals.days.size);
  const average = totals.intervention / dayCount;
  const toDate = new Date(`${getExportRange().toDate}T00:00:00`);
  const lastDay = new Date(toDate.getFullYear(), toDate.getMonth() + 1, 0).getDate();
  const selectedTarget = getFilteredCenterIndexes().reduce((sum, index) => sum + currencySafeNumber(centers[index].target), 0);
  const projected = Math.round(average * lastDay);
  const achievement = selectedTarget ? Math.round((totals.intervention / selectedTarget) * 100) : 0;
  const projectedAchievement = selectedTarget ? Math.round((projected / selectedTarget) * 100) : 0;
  const remainingDays = Math.max(0, lastDay - toDate.getDate());
  const requiredPerDay = selectedTarget && remainingDays ? Math.max(0, (selectedTarget - totals.intervention) / remainingDays) : 0;
  return {
    average,
    projected,
    selectedTarget,
    achievement,
    projectedAchievement,
    remainingDays,
    requiredPerDay,
    dayCount,
    lastDay
  };
}

function refreshCenterRollups(date = reportDate) {
  centers.forEach((center, index) => {
    const intervention = interventionRollup(index, date);
    const cag = cagRollup(index, date);
    center.tillDate = intervention.tillYesterday;
    center.yesterday = intervention.today;
    center.cagToday = cag.today;
    center.cagTotal = cag.total;
    center.general = intervention.general;
    center.kasp = intervention.kasp;
    center.medisep = intervention.medisep;
    center.ops = Object.fromEntries(adminOpsMetrics.map((metric) => [metric, opRollup(index, date, metric)]));
  });
}

function seedInitialEntries() {
  if (CONFIG.enableDemoData !== true) return;
  centers.forEach((center, index) => {
    const previous = getEntry(index, "2026-04-19");
    const today = getEntry(index, "2026-04-20");
    previous.op = {
      "Total OP": 520 + index * 18,
      IP: 80 + index * 3,
      "New OP": 91 + index * 5,
      ECG: 188 + index * 8,
      ECHO: 334 + index * 6,
      TMT: 43 + index
    };
    today.op = {
      "Total OP": 62 - index * 3 > 0 ? 62 - index * 3 : 12,
      IP: 11 + index,
      "New OP": 6 + index,
      ECG: 23 + index,
      ECHO: 36 - index > 0 ? 36 - index : 8,
      TMT: 6
    };
    previous.referrals = Object.fromEntries(referralMetrics.map((metric) => [metric, index % 3]));
    today.referrals = Object.fromEntries(referralMetrics.map((metric) => [metric, 0]));
    setProcedure(previous, "PTCA", "general", Math.max(0, center.general - center.yesterday));
    setProcedure(previous, "PTCA", "kasp", center.kasp);
    setProcedure(previous, "PTCA", "medisep", center.medisep);
    setProcedure(today, "PTCA", "general", center.yesterday);
    setProcedure(previous, "CAG", "general", Math.max(0, center.cagTotal - center.cagToday));
    setProcedure(today, "CAG", "general", center.cagToday);

    const marchPrevious = getEntry(index, "2026-03-30");
    const marchToday = getEntry(index, "2026-03-31");
    marchPrevious.op = {
      "Total OP": 410 + index * 14,
      IP: 65 + index * 2,
      "New OP": 74 + index * 3,
      ECG: 142 + index * 6,
      ECHO: 255 + index * 5,
      TMT: 31 + index
    };
    marchToday.op = {
      "Total OP": 36 + index,
      IP: 8 + index,
      "New OP": 5 + index,
      ECG: 15 + index,
      ECHO: 22 + index,
      TMT: 3
    };
    setProcedure(marchPrevious, "PTCA", "general", 3 + index);
    setProcedure(marchPrevious, "PTCA", "kasp", index % 4);
    setProcedure(marchPrevious, "CAG", "general", 9 + index);
    setProcedure(marchToday, "PTCA", "general", index % 2);
    setProcedure(marchToday, "CAG", "general", 1);

    const febPrevious = getEntry(index, "2026-02-27");
    const febToday = getEntry(index, "2026-02-28");
    febPrevious.op = {
      "Total OP": 300 + index * 12,
      IP: 48 + index,
      "New OP": 58 + index * 2,
      ECG: 110 + index * 4,
      ECHO: 190 + index * 4,
      TMT: 25 + index
    };
    febToday.op = {
      "Total OP": 29 + index,
      IP: 5 + index,
      "New OP": 4 + index,
      ECG: 11 + index,
      ECHO: 18 + index,
      TMT: 2
    };
    setProcedure(febPrevious, "PTCA", "general", 2 + index);
    setProcedure(febPrevious, "PTCA", "kasp", index % 3);
    setProcedure(febPrevious, "CAG", "general", 7 + index);
    setProcedure(febToday, "PTCA", "general", index % 2);
    setProcedure(febToday, "CAG", "general", 1);
  });
  refreshCenterRollups(reportDate);
}

function totalFor(center) {
  return center.tillDate + center.yesterday;
}

function percentFor(center) {
  return center.target ? Math.round((totalFor(center) / center.target) * 100) : 0;
}

function statusClass(percent) {
  if (percent >= 80) return "status-good";
  if (percent >= 40) return "status-watch";
  return "status-risk";
}

function statusColor(percent) {
  if (percent >= 80) return "var(--green)";
  if (percent >= 40) return "var(--yellow)";
  return "var(--red)";
}

function currencySafeNumber(value) {
  return Number(value || 0);
}

function setReportDate(date) {
  reportDate = date;
  // Sync month selector only — never touch entryDate input
  const month = date.slice(0, 7);
  const monthSelect = document.getElementById("monthSelect");
  if (monthSelect && monthSelect.value !== month) {
    monthSelect.value = month;
  }
}

function getSelectedEntryDate() {
  return document.getElementById("entryDate")?.value || reportDate;
}

function toggleCompanyDashboardSections() {
  const isSwizton = activeCompany === "Swizton";
  document.querySelectorAll(".kh-company-section").forEach((section) => {
    section.classList.toggle("hidden", isSwizton);
  });
  document.getElementById("swiztonPerformancePanel")?.classList.toggle("hidden", !isSwizton);
}

function setSummaryCards(config) {
  const cards = Array.from(document.querySelectorAll(".metric-card"));
  config.forEach((item, index) => {
    const card = cards[index];
    if (!card) return;
    card.querySelector("span").textContent = item.label;
    card.querySelector("strong").textContent = item.value;
    card.querySelector("small").textContent = item.note;
  });
}

function renderKhSummaryCards(totals, grandTotal, percent) {
  setSummaryCards([
    { label: "Intervention Total", value: grandTotal, note: "Selected procedures only" },
    { label: "CAG Total", value: totals.cagTotal, note: "All payers combined" },
    { label: "Network Target", value: totals.target, note: "Admin assigned monthly" },
    { label: "Achievement", value: `${percent}%`, note: `Till ${displayDate(reportDate)}` }
  ]);
}

function renderSwiztonDashboard() {
  toggleCompanyDashboardSections();
  const rows = getSwiztonRows();
  const totals = swiztonTotals(rows);
  const consolidatedRows = rows.map(swiztonConsolidatedRow);
  const tbody = document.querySelector("#swiztonConsolidatedTable tbody");
  const tfoot = document.querySelector("#swiztonConsolidatedTable tfoot");
  if (!tbody || !tfoot) return;
  renderSwiztonMappingGrid();
  updateSwiztonEntryPreviews();

  tbody.innerHTML = consolidatedRows.length
    ? consolidatedRows.map((row) => `
        <tr>
          <td>${row.slNo}</td>
          <td>${escapeHtml(row.month || "")}</td>
          <td>${escapeHtml(row.centre)}</td>
          <td>${escapeHtml(row.campaign)}</td>
          <td>${row.campaignDate ? displayDate(row.campaignDate) : ""}</td>
          <td>${row.ufeLeadsGenerated}</td>
          <td>${row.vericoseLeadsGenerated}</td>
          <td>${row.ufeOpGenerated}</td>
          <td>${row.vericoseOpGenerated}</td>
          <td>${row.ufeAdvices}</td>
          <td>${row.vericoseAdvices}</td>
          <td>${row.ufeDigitalProcedures}</td>
          <td>${row.vericoseDigitalProcedures}</td>
          <td>${row.ufeTotalProcedures}</td>
          <td>${row.vericoseTotalProcedures}</td>
          <td>
            <button class="button secondary" data-swizton-edit="${row.id}">Edit</button>
            <button class="button secondary" data-swizton-delete="${row.id}">Delete</button>
          </td>
        </tr>
      `).join("")
    : `<tr><td colspan="16" style="color:var(--muted);text-align:center;padding:18px">No Swizton performance entries for the selected month.</td></tr>`;

  tfoot.innerHTML = `
    <tr>
      <td colspan="5">Total</td>
      <td>${totals.ufeLeadsGenerated}</td>
      <td>${totals.vericoseLeadsGenerated}</td>
      <td>${totals.ufeOpGenerated}</td>
      <td>${totals.vericoseOpGenerated}</td>
      <td>${totals.ufeAdvices}</td>
      <td>${totals.vericoseAdvices}</td>
      <td>${totals.ufeDigitalProcedures}</td>
      <td>${totals.vericoseDigitalProcedures}</td>
      <td>${totals.ufeTotalProcedures}</td>
      <td>${totals.vericoseTotalProcedures}</td>
      <td></td>
    </tr>
  `;

  setSummaryCards([
    { label: "Total Leads", value: totals.ufeLeadsGenerated + totals.vericoseLeadsGenerated, note: "UFE and Vericose combined" },
    { label: "OP Generated", value: totals.ufeOpGenerated + totals.vericoseOpGenerated, note: "Mapped from selected lead fields" },
    { label: "Advices", value: totals.ufeAdvices + totals.vericoseAdvices, note: "UFE and Vericose advices" },
    { label: "Procedure Done", value: totals.ufeTotalProcedures + totals.vericoseTotalProcedures, note: "Total UFE and Vericose procedures" }
  ]);

  tbody.querySelectorAll("[data-swizton-edit]").forEach((button) => {
    button.addEventListener("click", () => editSwiztonEntry(Number(button.dataset.swiztonEdit)));
  });
  tbody.querySelectorAll("[data-swizton-delete]").forEach((button) => {
    button.addEventListener("click", () => deleteSwiztonEntry(Number(button.dataset.swiztonDelete)));
  });
}

function renderSwiztonMappingGrid() {
  const grid = document.getElementById("swiztonMappingGrid");
  if (!grid) return;
  grid.innerHTML = SWIZTON_CONSOLIDATED_COLUMNS.map((column) => `
    <label>
      <span>${escapeHtml(column.label)}</span>
      <select data-swizton-map="${column.key}">
        ${SWIZTON_SOURCE_OPTIONS.map((option) => `
          <option value="${option.value}" ${swiztonConsolidatedMapping[column.key] === option.value ? "selected" : ""}>
            ${escapeHtml(option.label)}
          </option>
        `).join("")}
      </select>
    </label>
  `).join("");
  grid.querySelectorAll("[data-swizton-map]").forEach((select) => {
    select.addEventListener("change", () => {
      swiztonConsolidatedMapping[select.dataset.swiztonMap] = select.value;
      renderSwiztonDashboard();
      renderAdminReportPreview();
      persistSoon();
    });
  });
}

function swiztonPercent(numerator, denominator) {
  return denominator ? `${Math.round((currencySafeNumber(numerator) / currencySafeNumber(denominator)) * 100)}%` : "0%";
}

function updateSwiztonEntryPreviews() {
  const read = (id) => currencySafeNumber(document.getElementById(id)?.value);
  document.querySelectorAll(".sw-common-preview").forEach((cell) => {
    const field = cell.dataset.preview;
    const id = SWIZTON_FIELD_IDS[field];
    const value = document.getElementById(id)?.value || "";
    cell.textContent = field === "campaignDate" && value ? displayDate(value) : value;
  });
  const ufeLead = document.getElementById("swUfeLeadConversionPreview");
  const vericoseLead = document.getElementById("swVericoseLeadConversionPreview");
  const ufeAdvice = document.getElementById("swUfeAdviceConversionPreview");
  const vericoseAdvice = document.getElementById("swVericoseAdviceConversionPreview");
  if (ufeLead) ufeLead.textContent = swiztonPercent(read("swUfeOpSeen"), read("swUfeLeadsGenerated"));
  if (vericoseLead) vericoseLead.textContent = swiztonPercent(read("swVericoseOpSeen"), read("swVericoseLeadsGenerated"));
  if (ufeAdvice) ufeAdvice.textContent = swiztonPercent(read("swUfeProcedureDone"), read("swUfeAdvices"));
  if (vericoseAdvice) vericoseAdvice.textContent = swiztonPercent(read("swVericoseProcedureDone"), read("swVericoseAdvices"));
}

function readSwiztonForm() {
  const data = {
    id: swiztonEditingId || Date.now(),
    month: document.getElementById("swiztonMonth")?.value || selectedSwiztonMonth(),
    centre: document.getElementById("swiztonCentre")?.value.trim() || "",
    campaign: document.getElementById("swiztonCampaign")?.value.trim() || "",
    campaignDate: document.getElementById("swiztonCampaignDate")?.value || "",
    updatedAt: new Date().toISOString(),
    updatedBy: getCurrentActorLabel()
  };

  SWIZTON_NUMERIC_FIELDS.forEach((field) => {
    data[field] = currencySafeNumber(document.getElementById(SWIZTON_FIELD_IDS[field])?.value);
  });

  if (!data.ufeTotalProcedureDone) data.ufeTotalProcedureDone = data.ufeProcedureDone;
  if (!data.vericoseTotalProcedureDone) data.vericoseTotalProcedureDone = data.vericoseProcedureDone;

  return data;
}

function fillSwiztonForm(entry) {
  Object.entries(SWIZTON_FIELD_IDS).forEach(([field, id]) => {
    const input = document.getElementById(id);
    if (!input) return;
    if (SWIZTON_NUMERIC_FIELDS.includes(field)) {
      input.value = currencySafeNumber(entry?.[field]);
    } else {
      input.value = entry?.[field] || "";
    }
  });
  updateSwiztonEntryPreviews();
}

function clearSwiztonForm() {
  swiztonEditingId = null;
  fillSwiztonForm({
    month: selectedSwiztonMonth(),
    centre: "",
    campaign: "",
    campaignDate: "",
    ...Object.fromEntries(SWIZTON_NUMERIC_FIELDS.map((field) => [field, 0]))
  });
  document.getElementById("swiztonSaveBtn").textContent = "Save Entry";
  updateSwiztonEntryPreviews();
}

function saveSwiztonEntry() {
  if (currentRole !== "admin" && currentRole !== "superadmin") {
    showToast("Only admins can enter Swizton performance data");
    return;
  }

  const entry = readSwiztonForm();
  if (!entry.month || !entry.centre || !entry.campaign) {
    showToast("Enter month, centre, and campaign before saving");
    return;
  }

  const index = swiztonEntries.findIndex((item) => item.id === entry.id);
  if (index >= 0) {
    swiztonEntries[index] = { ...swiztonEntries[index], ...entry };
  } else {
    swiztonEntries.push(entry);
  }

  clearSwiztonForm();
  renderSwiztonDashboard();
  renderAdminReportPreview();
  persistSoon();
  showToast("Swizton entry saved");
}

function editSwiztonEntry(id) {
  const entry = swiztonEntries.find((item) => item.id === id);
  if (!entry) return;
  swiztonEditingId = id;
  fillSwiztonForm(entry);
  document.getElementById("swiztonSaveBtn").textContent = "Update Entry";
  document.getElementById("swiztonPerformancePanel")?.scrollIntoView({ behavior: "smooth", block: "start" });
}

function deleteSwiztonEntry(id) {
  const entry = swiztonEntries.find((item) => item.id === id);
  if (!entry) return;
  const ok = window.confirm(`Delete Swizton entry for ${entry.centre} / ${entry.campaign}?`);
  if (!ok) return;
  swiztonEntries = swiztonEntries.filter((item) => item.id !== id);
  if (swiztonEditingId === id) clearSwiztonForm();
  renderSwiztonDashboard();
  renderAdminReportPreview();
  persistSoon();
  showToast("Swizton entry deleted");
}

function renderPendingAlert() {
  const container = document.getElementById("pendingAlert");
  if (!container) return;

  if (activeCompany === "Swizton" || (currentRole !== "admin" && currentRole !== "superadmin")) {
    container.innerHTML = "";
    return;
  }

  const missing = getCompanyScopedCentreIndexes().filter((index) => {
    const entry = entries[index] && entries[index][reportDate];
    const hasEntry = entry && (
      Object.values(entry.op || {}).some(v => v > 0) ||
      Object.values(entry.procedures || {}).some(p =>
        Object.values(p || {}).some(v => v > 0)
      )
    );
    return !hasEntry;
  });

  if (missing.length === 0) {
    container.innerHTML = `<div class="alert-banner success">All assigned centres have submitted today's data.</div>`;
    return;
  }

  const names = missing.map(i => centers[i].name).join(", ");

  container.innerHTML = `<div class="alert-banner error">${missing.length} centre(s) pending for today's submission.<small>${names}</small></div>`;
}

function renderConsolidated() {
  if (activeCompany === "Swizton") {
    renderSwiztonDashboard();
    renderPendingAlert();
    return;
  }

  toggleCompanyDashboardSections();
  refreshCenterRollups(reportDate);

  document.getElementById("procedureReportTitle").textContent = `${activeCompany} - Procedures Till ${displayDate(reportDate)}`;

  const centerIndexes = getCompanyScopedCentreIndexes();
  const tbody = document.querySelector("#consolidatedTable tbody");
  const tfoot = document.querySelector("#consolidatedTable tfoot");
  tbody.innerHTML = "";

  centerIndexes.forEach((index) => {
    const center = centers[index];
    const percent = percentFor(center);

    // 🔴 NEW: Check if entry exists today
    const entry = entries[index] && entries[index][reportDate];

    const hasEntry = entry && (
    Object.values(entry.op || {}).some(v => v > 0) ||
    Object.values(entry.procedures || {}).some(p =>
    Object.values(p || {}).some(v => v > 0)
     )
    );

    let statusBadge = "";

if (currentRole === "admin") {
  statusBadge = hasEntry
    ? `<span class="entry-status updated">Updated today</span>`
    : `<span class="entry-status missing">Pending today</span>`;
    }   

    const row = document.createElement("tr");

    row.innerHTML = `
      <td>
        ${center.name}<br/>
        ${statusBadge}
      </td>
      <td>${center.tillDate}</td>
      <td>${center.yesterday}</td>
      <td class="${statusClass(percent)}">${totalFor(center)}</td>
      <td>${center.target}</td>
      <td>${center.cagToday}</td>
      <td>${center.cagTotal}</td>
      <td>${center.kasp}</td>
      <td>${center.general}</td>
      <td>${center.medisep}</td>
      <td>${percent}</td>
    `;

    row.addEventListener("click", () => {
      if (currentRole === "centre" && index !== loggedInCentreIndex) {
        showToast("You can open only your own centre details");
        return;
      }
      openCentre(index);
    });

    tbody.appendChild(row);
  });

  const totals = centerIndexes.reduce(
    (acc, idx) => {
      const center = centers[idx];
      acc.tillDate += center.tillDate;
      acc.yesterday += center.yesterday;
      acc.target += center.target;
      acc.cagToday += center.cagToday;
      acc.cagTotal += center.cagTotal;
      acc.kasp += center.kasp;
      acc.general += center.general;
      acc.medisep += center.medisep;
      return acc;
    },
    { tillDate: 0, yesterday: 0, target: 0, cagToday: 0, cagTotal: 0, kasp: 0, general: 0, medisep: 0 }
  );

  const grandTotal = totals.tillDate + totals.yesterday;
  const percent = totals.target ? Math.round((grandTotal / totals.target) * 100) : 0;

  tfoot.innerHTML = `
    <tr>
      <td>Total</td>
      <td>${totals.tillDate}</td>
      <td>${totals.yesterday}</td>
      <td>${grandTotal}</td>
      <td>${totals.target}</td>
      <td>${totals.cagToday}</td>
      <td>${totals.cagTotal}</td>
      <td>${totals.kasp}</td>
      <td>${totals.general}</td>
      <td>${totals.medisep}</td>
      <td>${percent}</td>
    </tr>
  `;

  renderKhSummaryCards(totals, grandTotal, percent);

  renderOpsConsolidated();
  renderPendingAlert();
}

function renderOpsConsolidated() {
  const tbody = document.querySelector("#opsConsolidatedTable tbody");
  if (!tbody) return;
  document.getElementById("opsReportTitle").textContent = `${activeCompany} - OP & Diagnostics Till ${displayDate(reportDate)}`;
  tbody.innerHTML = getCompanyScopedCentreIndexes().map((index) => {
    const center = centers[index];
    const cells = adminOpsMetrics.flatMap((metric) => {
      const values = center.ops?.[metric] || opRollup(index, reportDate, metric);
      return [`<td>${values.tillYesterday}</td>`, `<td>${values.today}</td>`, `<td>${values.total}</td>`];
    }).join("");
    return `<tr><td>${center.name}</td>${cells}</tr>`;
  }).join("");
}

function renderBars() {
  const container = document.getElementById("achievementBars");
  container.innerHTML = "";
  getCompanyScopedCentreIndexes().forEach((i) => {
    const center = centers[i];
    const percent = percentFor(center);
    const row = document.createElement("div");
    row.className = "bar-row";
    row.innerHTML = `
      <span>${center.name}</span>
      <div class="bar-track"><div class="bar-fill" style="width:${Math.min(percent, 100)}%; background:${statusColor(percent)}"></div></div>
      <span>${percent}%</span>
    `;
    container.appendChild(row);
  });
}

function renderPayerSplit() {
  const totals = getCompanyScopedCentreIndexes().reduce(
    (acc, i) => {
      const center = centers[i];
      acc.kasp += center.kasp;
      acc.general += center.general;
      acc.medisep += center.medisep;
      return acc;
    },
    { kasp: 0, general: 0, medisep: 0 }
  );
  const sum = totals.kasp + totals.general + totals.medisep || 1;
  const generalPct = Math.round((totals.general / sum) * 100);
  const kaspPct = Math.round((totals.kasp / sum) * 100);
  const medisepPct = 100 - generalPct - kaspPct;
  document.getElementById("payerDonut").style.background = `conic-gradient(var(--blue) 0 ${generalPct}%, var(--teal) ${generalPct}% ${generalPct + kaspPct}%, #7a8797 ${generalPct + kaspPct}% 100%)`;
  document.getElementById("payerSplit").innerHTML = `
    <div class="split-item"><span>General</span><strong>${totals.general} (${generalPct}%)</strong></div>
    <div class="split-item"><span>KASP</span><strong>${totals.kasp} (${kaspPct}%)</strong></div>
    <div class="split-item"><span>MEDISEP</span><strong>${totals.medisep} (${medisepPct}%)</strong></div>
  `;
}

function showView(name) {
  if (currentRole === "admin" && name === "entry") name = "admin";
  if (name === "consolidated") name = "admin"; // centre-only nav alias
  if (currentRole === "centre" && !["admin", "entry", "centre"].includes(name)) name = "admin";
  if (activeCompany === "Swizton" && ["targets", "procedures", "users", "unlock", "centre"].includes(name)) name = "admin";
  // Superadmin-only views: block regular admin from accessing
  if (currentRole === "admin" && name === "superadmin") name = "admin";
  document.querySelectorAll(".view").forEach((view) => view.classList.remove("active"));
  document.getElementById(`${name}View`).classList.add("active");
  document.querySelectorAll(".nav-item").forEach((item) => item.classList.toggle("active", item.dataset.view === name));
  const titles = {
    admin: "Consolidated Dashboard",
    entry: "Daily Entry",
    targets: "Monthly Targets",
    procedures: "Procedure Settings",
    users: "User Controls",
    centre: "Centre Dashboard",
    unlock: "Edit Requests",
    audit: "Audit Log",
    backup: "Backup & Restore",
    superadmin: "Super Admin Panel"
  };
  document.getElementById("pageTitle").textContent = titles[name] || titles.admin;
  updateTopbarActions(name);
  if (name === "unlock") {
    renderUnlockRequests();
    setTimeout(() => { window.scrollTo({ top: 0, behavior: "smooth" }); }, 50);
  }
  if (name === "audit") {
    const sel = document.getElementById("auditFilterCentre");
    if (sel) {
      const current = sel.value;
      sel.innerHTML = `<option value="all">All Centres</option>` +
        getAssignedCentreIndexes().map(i => `<option value="${i}">${escapeHtml(centers[i].name)}</option>`).join("");
      sel.value = current;
    }
    renderAuditLog();
    setTimeout(() => { window.scrollTo({ top: 0, behavior: "smooth" }); }, 50);
  }
  if (name === "backup") {
    renderBackups();
    setTimeout(() => { window.scrollTo({ top: 0, behavior: "smooth" }); }, 50);
  }
  if (name === "procedures") {
    renderProcedures();
  }
  if (name === "superadmin") {
    renderSuperAdminPanel();
    setTimeout(() => { window.scrollTo({ top: 0, behavior: "smooth" }); }, 50);
  }
}

function updateTopbarActions(name) {
  document.getElementById("saveBtn").classList.toggle("hidden", currentRole !== "centre" || name !== "entry");
  document.getElementById("monthSelect").classList.toggle("hidden", currentRole === "centre");
}

function setRole(role, centreIndex = loggedInCentreIndex, adminIndex = -1) {
  currentRole = role;
  loggedInCentreIndex = centreIndex;
  loggedInAdminIndex = adminIndex;
  document.body.classList.toggle("centre-mode", role === "centre");
  document.body.classList.toggle("superadmin-mode", role === "superadmin");
  document.body.classList.toggle("admin-mode", role === "admin");
  renderCompanyTabs();

  if (role === "centre") {
    const centre = centers[loggedInCentreIndex];
    activeCompany = centre?.company || "KH";
    renderCompanyTabs();
    document.getElementById("signedInName").textContent = `${centre.name} Centre User`;
    document.getElementById("signedInAccess").textContent = `Can update only ${centre.name} daily data`;
    document.getElementById("entryCentreName").textContent = `${centre.name} Centre Login`;
    document.getElementById("entryAccessMessage").textContent = `This user can enter only ${centre.name} data. Other centres are not selectable.`;
    document.getElementById("lockedCentreName").textContent = centre.name;
    renderEntryForCurrentDate();
    document.getElementById("exportCentre").value = String(loggedInCentreIndex);
    document.getElementById("exportCentre").disabled = true;
    renderConsolidated();
    renderAdminReportPreview();
    showView("entry");
    return;
  }

  if (role === "superadmin") {
    document.getElementById("signedInName").textContent = "Super Admin";
    document.getElementById("signedInAccess").textContent = "Full system control";
    document.getElementById("exportCentre").disabled = false;
    refreshCenterLists();
    renderConsolidated();
    renderAdminReportPreview();
    showView("admin");
    return;
  }

  // Regular admin
  const admin = admins[adminIndex];
  const adminLabel = admin ? admin.name : "Admin User";
  const assigned = getAssignedCentreIndexes();
  document.getElementById("signedInName").textContent = adminLabel;
  document.getElementById("signedInAccess").textContent =
    admin && admin.assignedCentres?.length
      ? `Assigned: ${admin.assignedCentres.map(i => centers[i]?.name).filter(Boolean).join(", ")}`
      : "All centres";
  document.getElementById("exportCentre").disabled = false;
  refreshCenterLists();
  renderConsolidated();
  renderAdminReportPreview();
  showView("admin");
}

function renderEntryForCurrentDate() {
  const date = getSelectedEntryDate();
  const today = todayIST();
  const locked = date !== today && isDateLocked(date, loggedInCentreIndex);
  const approved = !locked && date !== today; // past but unlocked

  // ── Lock banner ──
  const banner = document.getElementById("entryLockBanner");
  if (banner) {
    if (date > today) {
      banner.innerHTML = `<div class="lock-banner future">🚫 Future dates cannot be edited.</div>`;
      banner.classList.remove("hidden");
    } else if (locked) {
      const pending = getPendingUnlock(loggedInCentreIndex, date);
      banner.innerHTML = pending
        ? `<div class="lock-banner locked">
            <strong>${displayDate(date)}</strong> is locked.
            <span>Unlock request sent — waiting for admin approval.</span>
           </div>`
        : `<div class="lock-banner locked">
            <strong>${displayDate(date)}</strong> is locked (past date).
            <button class="button secondary" id="requestUnlockBtn">Request Edit Access</button>
           </div>`;
      banner.classList.remove("hidden");
      if (!pending) {
        document.getElementById("requestUnlockBtn")?.addEventListener("click", () => openUnlockModal(date));
      }
    } else if (approved) {
      const unlock = getApprovedUnlock(loggedInCentreIndex, date);
      const timeLeft = unlock?.expiresAt ? ` — ${formatTimeRemaining(unlock.expiresAt)}` : "";
      banner.innerHTML = `<div class="lock-banner unlocked"><strong>${displayDate(date)}</strong> is unlocked for editing by admin approval${timeLeft}.</div>`;
      banner.classList.remove("hidden");
    } else {
      banner.classList.add("hidden");
    }
  }

  // ── Last updated ──
  const metaEl = document.getElementById("entryLastUpdated");
  if (metaEl) {
    const meta = getEntryMeta(loggedInCentreIndex, date);
    metaEl.textContent = meta
      ? `Last saved: ${formatSavedAt(meta.savedAt)}`
      : "";
  }

  // Render inputs — pass editable=false when locked
  const editable = !locked && date <= today;
  renderEntryList("opEntry", opMetrics, "op", loggedInCentreIndex, date, editable);
  renderEntryList("referralEntry", referralMetrics, "referrals", loggedInCentreIndex, date, editable);
  renderProcedureTable("procedureEntryTable", editable, loggedInCentreIndex, date);

  // Show/hide save button
  const saveBtn = document.getElementById("saveBtn");
  if (saveBtn) saveBtn.classList.toggle("hidden", !editable);
}

function updateFromDailyEntry() {
  if (currentRole !== "centre") {
    showToast("Admin is view only. Login as a centre to enter daily data.");
    return;
  }

  const date = document.getElementById("entryDate").value;

  // Guard: disallow future dates
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  if (date > today) {
    showToast("Cannot save data for a future date.");
    return;
  }

  // Guard: disallow locked past dates
  if (isDateLocked(date, loggedInCentreIndex)) {
    showToast("This date is locked. Request admin approval to edit past data.");
    return;
  }

  // Guard: warn if entry date is in a different month from reportDate
  if (!sameMonth(date, reportDate)) {
    const ok = window.confirm(
      `The entry date (${displayDate(date)}) is in a different month from the current report month (${displayDate(reportDate)}).\n\nThe report month will be updated to match. Continue?`
    );
    if (!ok) return;
  }

  const center = centers[loggedInCentreIndex];
  const entry = getEntry(loggedInCentreIndex, date);

  // Snapshot before overwriting
  const beforeSnapshot = deepCloneEntry(entry);

  entry.op = {};
  entry.referrals = {};
  entry.procedures = {};

  document.querySelectorAll("#opEntry .entry-row:not(.header)").forEach((row) => {
    const metric = row.dataset.metric;
    entry.op[metric] = currencySafeNumber(row.querySelector("input").value);
  });

  document.querySelectorAll("#referralEntry .entry-row:not(.header)").forEach((row) => {
    const metric = row.dataset.metric;
    entry.referrals[metric] = currencySafeNumber(row.querySelector("input").value);
  });

  document.querySelectorAll("#procedureEntryTable tbody tr").forEach((row) => {
    const cells = row.querySelectorAll("td");
    const procedure = cells[0].textContent.trim();
    const generalToday = currencySafeNumber(cells[2].querySelector("input")?.value);
    const kaspToday = currencySafeNumber(cells[5].querySelector("input")?.value);
    const medisepToday = currencySafeNumber(cells[8].querySelector("input")?.value);
    setProcedure(entry, procedure, "general", generalToday);
    setProcedure(entry, procedure, "kasp", kaspToday);
    setProcedure(entry, procedure, "medisep", medisepToday);
  });

  // Record audit log (before → after)
  writeAuditLog(loggedInCentreIndex, date, beforeSnapshot, entry);

  // Record last-updated metadata
  setEntryMeta(loggedInCentreIndex, date, center.name);

  setReportDate(date);
  refreshCenterRollups(reportDate);
  renderConsolidated();
  renderBars();
  renderPayerSplit();
  renderEntryForCurrentDate();
  persistEntry(loggedInCentreIndex, date);
  showToast(`${center.name} entry saved and reflected in reports`);
}

function openCentre(index) {
  activeCentreDashboardIndex = index;
  const center = centers[index];
  const percent = percentFor(center);
  document.getElementById("centreName").textContent = center.name;
  document.getElementById("centreTarget").textContent = center.target;
  document.getElementById("centreTotal").textContent = totalFor(center);
  document.getElementById("centrePercent").textContent = `${percent}%`;
  renderTrend(center);
  renderSnapshot(center);
  renderProcedureTable("centreProcedureTable", false, index, reportDate);
  showView("centre");
}

function renderTrend(center) {
  const chart = document.getElementById("trendChart");
  const index = centers.indexOf(center);
  // Build real daily intervention values from stored entries for the current month
  const centreEntries = ensureCentreEntries(index);
  const monthDates = Object.keys(centreEntries)
    .filter((d) => sameMonth(d, reportDate))
    .sort();

  // Fallback to a small placeholder if no data yet
  const values = monthDates.length
    ? monthDates.map((d) => entryInterventionTotal(centreEntries[d]))
    : [0];

  const max = Math.max(...values, 1);
  chart.innerHTML = "";
  values.forEach((value, i) => {
    const bar = document.createElement("div");
    bar.className = "trend-bar";
    bar.style.height = `${Math.max(12, (value / max) * 210)}px`;
    bar.title = `${monthDates[i] ? displayDate(monthDates[i]) : ""}: ${value} procedures`;
    bar.innerHTML = `<span>${monthDates[i] ? monthDates[i].slice(-2) : i + 1}</span>`;
    chart.appendChild(bar);
  });
}

function renderSnapshot(center) {
  const index = centers.indexOf(center);
  const op = (metric) => center.ops?.[metric]?.today ?? opRollup(index, reportDate, metric).today;
  document.getElementById("snapshotGrid").innerHTML = `
    <div class="snapshot-item"><span>OP Today</span><strong>${op("Total OP")}</strong></div>
    <div class="snapshot-item"><span>IP Today</span><strong>${op("IP")}</strong></div>
    <div class="snapshot-item"><span>CAG Today</span><strong>${center.cagToday}</strong></div>
    <div class="snapshot-item"><span>Intervention Today</span><strong>${center.yesterday}</strong></div>
    <div class="snapshot-item"><span>ECG Today</span><strong>${op("ECG")}</strong></div>
    <div class="snapshot-item"><span>Echo Today</span><strong>${op("ECHO")}</strong></div>
  `;
}

function procedureRowHtml(procedure, index, editable = false, centerIndex = loggedInCentreIndex, date = getSelectedEntryDate()) {
  const values = procedureValuesFor(centerIndex, date, procedure);
  const generalTotal = values.generalPrev + values.generalToday;
  const kaspTotal = values.kaspPrev + values.kaspToday;
  const medisepTotal = values.medisepPrev + values.medisepToday;
  const totalPrev = values.generalPrev + values.kaspPrev + values.medisepPrev;
  const totalToday = values.generalToday + values.kaspToday + values.medisepToday;
  const grandTotal = totalPrev + totalToday;
  const todayCell = (value) => editable ? `<input type="number" min="0" value="${value}" />` : value;

  return `
    <tr>
      <td>${procedure}</td>
      <td>${values.generalPrev}</td>
      <td>${todayCell(values.generalToday)}</td>
      <td><output>${generalTotal}</output></td>
      <td>${values.kaspPrev}</td>
      <td>${todayCell(values.kaspToday)}</td>
      <td><output>${kaspTotal}</output></td>
      <td>${values.medisepPrev}</td>
      <td>${todayCell(values.medisepToday)}</td>
      <td><output>${medisepTotal}</output></td>
      <td><output>${totalPrev}</output></td>
      <td><output>${totalToday}</output></td>
      <td><output>${grandTotal}</output></td>
    </tr>
  `;
}

function renderProcedureTable(tableId, editable = false, centerIndex = loggedInCentreIndex, date = getSelectedEntryDate()) {
  const tbody = document.querySelector(`#${tableId} tbody`);
  tbody.innerHTML = activeProcedures().map((procedure, index) => procedureRowHtml(procedure, index, editable, centerIndex, date)).join("");
  if (editable) bindProcedureInputs(tbody);
}

function bindProcedureInputs(tbody) {
  tbody.querySelectorAll("input").forEach((input) => {
    input.addEventListener("input", () => {
      const row = input.closest("tr");
      const cells = row.querySelectorAll("td");
      const generalPrev = currencySafeNumber(cells[1].textContent);
      const generalToday = currencySafeNumber(cells[2].querySelector("input").value);
      const kaspPrev = currencySafeNumber(cells[4].textContent);
      const kaspToday = currencySafeNumber(cells[5].querySelector("input").value);
      const medisepPrev = currencySafeNumber(cells[7].textContent);
      const medisepToday = currencySafeNumber(cells[8].querySelector("input").value);
      cells[3].querySelector("output").textContent = generalPrev + generalToday;
      cells[6].querySelector("output").textContent = kaspPrev + kaspToday;
      cells[9].querySelector("output").textContent = medisepPrev + medisepToday;
      cells[10].querySelector("output").textContent = generalPrev + kaspPrev + medisepPrev;
      cells[11].querySelector("output").textContent = generalToday + kaspToday + medisepToday;
      cells[12].querySelector("output").textContent = generalPrev + generalToday + kaspPrev + kaspToday + medisepPrev + medisepToday;
    });
  });
}

function renderEntryList(id, metrics, source = "op", centerIndex = loggedInCentreIndex, date = getSelectedEntryDate(), editable = true) {
  const container = document.getElementById(id);
  container.innerHTML = `
    <div class="entry-row header">
      <span>Item</span>
      <span>Till Yesterday</span>
      <span>Today</span>
      <span>Total</span>
    </div>
  `;
  const entry = getEntry(centerIndex, date);
  metrics.forEach((metric) => {
    const prev = sumOpBefore(centerIndex, date, metric, source);
    const todayVal = currencySafeNumber(entry[source][metric]);
    const row = document.createElement("div");
    row.className = "entry-row";
    row.dataset.metric = metric;
    if (editable) {
      row.innerHTML = `
        <span>${metric}</span>
        <output>${prev}</output>
        <input type="number" min="0" value="${todayVal}" aria-label="${metric} current day" />
        <output>${prev + todayVal}</output>
      `;
      const input = row.querySelector("input");
      const total = row.querySelectorAll("output")[1];
      input.addEventListener("input", () => {
        total.textContent = prev + currencySafeNumber(input.value);
      });
    } else {
      row.innerHTML = `
        <span>${metric}</span>
        <output>${prev}</output>
        <output class="locked-value">${todayVal}</output>
        <output>${prev + todayVal}</output>
      `;
    }
    container.appendChild(row);
  });
}

function renderTargets() {
  const grid = document.getElementById("targetGrid");
  grid.innerHTML = "";
  getCompanyScopedCentreIndexes().forEach((index) => {
    const center = centers[index];
    const card = document.createElement("div");
    card.className = "target-card";
    card.innerHTML = `
      <div><strong>${center.name}</strong><span>April 2026 target</span></div>
      <input type="number" min="0" value="${center.target}" aria-label="${center.name} target" />
    `;
    const input = card.querySelector("input");
    input.addEventListener("input", () => {
      const oldTarget = center.target;
      center.target = currencySafeNumber(input.value);
      logTargetChange(center.name, oldTarget, center.target);
      renderConsolidated();
      renderBars();
      renderAdminReportPreview();
      persistSoon();
    });
    grid.appendChild(card);
  });
}

function renderUsers() {
  const list = document.getElementById("userList");
  list.innerHTML = getCompanyScopedCentreIndexes().map((index) => {
    const center = centers[index];
    return `
    <div class="user-card">
      <div>
        <strong>${center.name}</strong>
        <span>${center.company || "KH"} company centre login</span>
      </div>
      <input type="text" value="${escapeHtml(center.username)}" aria-label="${center.name} username" data-user-field="username" data-center-index="${index}" />
      <input type="password" placeholder="New password" aria-label="${center.name} new password" data-user-field="password" data-center-index="${index}" />
      <button class="button secondary" data-remove-center="${index}">Remove</button>
    </div>
  `;
  }).join("");

  // Username change — plaintext, just update directly
  list.querySelectorAll("input[data-user-field='username']").forEach((input) => {
    input.addEventListener("change", () => {
      centers[Number(input.dataset.centerIndex)].username = input.value.trim() || input.value;
      refreshCenterLists();
      persistSoon();
      showToast("Username updated");
    });
  });

  // Password change — hash before storing, remove legacy plaintext field
  list.querySelectorAll("input[data-user-field='password']").forEach((input) => {
    input.addEventListener("change", async () => {
      const raw = input.value.trim();
      if (!raw) return;
      const idx = Number(input.dataset.centerIndex);
      centers[idx].passwordHash = await sha256(raw);
      delete centers[idx].password; // remove legacy plaintext
      input.value = "";
      persistSoon();
      showToast("Password updated and secured");
    });
  });

  list.querySelectorAll("[data-remove-center]").forEach((button) => {
    button.addEventListener("click", () => removeCenter(Number(button.dataset.removeCenter)));
  });
}

function renderProcedures() {
  const tbody = document.querySelector("#procedureSettingsTable tbody");
  document.querySelector("#proceduresView h2").textContent = `${activeCompany} Procedure Settings`;
  document.querySelector("#proceduresView .panel-head p").textContent =
    activeCompany === "KH"
      ? "Admin can decide which KH procedures are included in consolidated interventional counts."
      : "Admin can add Swizton procedures from scratch without mixing KH procedure settings.";
  const rows = activeCompanyProcedureRows();
  if (!rows.length) {
    tbody.innerHTML = `
      <tr>
        <td colspan="5" style="color:var(--muted);text-align:center;padding:18px">
          No ${activeCompany} procedures added yet. Add the first procedure above.
        </td>
      </tr>
    `;
    return;
  }
  tbody.innerHTML = rows.map(({ procedure, index }) => `
    <tr>
      <td><input type="text" value="${procedure.name}" data-procedure-name="${index}" aria-label="Procedure name" /></td>
      <td><input type="checkbox" data-procedure-field="counted" data-procedure-index="${index}" ${procedure.counted ? "checked" : ""} /></td>
      <td><input type="checkbox" data-procedure-field="isCag" data-procedure-index="${index}" ${procedure.isCag ? "checked" : ""} /></td>
      <td>${procedure.active ? "Active" : "Inactive"}</td>
      <td><button class="button secondary" data-remove-procedure="${index}">${procedure.active ? "Remove" : "Restore"}</button></td>
    </tr>
  `).join("");
  tbody.querySelectorAll("[data-procedure-name]").forEach((input) => {
    input.addEventListener("change", () => renameProcedure(Number(input.dataset.procedureName), input.value));
  });
  tbody.querySelectorAll("input").forEach((input) => {
    if (input.dataset.procedureName) return;
    input.addEventListener("change", () => {
      procedureSettings[Number(input.dataset.procedureIndex)][input.dataset.procedureField] = input.checked;
      refreshAfterProcedureChange();
      persistSoon();
    });
  });
  tbody.querySelectorAll("[data-remove-procedure]").forEach((button) => {
    button.addEventListener("click", () => {
      const procedure = procedureSettings[Number(button.dataset.removeProcedure)];
      procedure.active = !procedure.active;
      refreshAfterProcedureChange();
      persistSoon();
    });
  });
}

function renameProcedure(index, newName) {
  const cleanedName = newName.trim();
  const procedure = procedureSettings[index];
  const oldName = procedure.name;
  if (!cleanedName) {
    renderProcedures();
    showToast("Procedure name cannot be blank");
    return;
  }
  const company = procedure.company || activeCompany;
  if (procedureSettings.some((item, itemIndex) => itemIndex !== index && procedureMatchesCompany(item, company) && item.name.toLowerCase() === cleanedName.toLowerCase())) {
    renderProcedures();
    showToast("Procedure name already exists");
    return;
  }
  procedure.name = cleanedName;
  Object.entries(entries).forEach(([centreIndex, centreEntries]) => {
    if ((centers[Number(centreIndex)]?.company || "KH") !== company) return;
    Object.values(centreEntries).forEach((entry) => {
      if (entry.procedures[oldName]) {
        entry.procedures[cleanedName] = entry.procedures[oldName];
        delete entry.procedures[oldName];
      }
    });
  });
  refreshAfterProcedureChange();
  persistSoon();
  showToast("Procedure name updated");
}

function refreshAfterProcedureChange() {
  refreshCenterRollups(reportDate);
  renderProcedures();
  renderConsolidated();
  renderBars();
  renderPayerSplit();
  renderEntryForCurrentDate();
  renderAdminReportPreview();
}

function addProcedure() {
  const input = document.getElementById("newProcedureName");
  const name = input.value.trim();
  if (!name) return;
  if (procedureSettings.some((procedure) => procedureMatchesCompany(procedure, activeCompany) && procedure.name.toLowerCase() === name.toLowerCase())) {
    showToast(`${activeCompany} procedure already exists`);
    return;
  }
  procedureSettings.push({ name, company: activeCompany, counted: true, isCag: false, active: true });
  input.value = "";
  refreshAfterProcedureChange();
  persistSoon();
  showToast(`${activeCompany} procedure added`);
}

function addCenter() {
  const input = document.getElementById("newCentreName");
  const companyInput = document.getElementById("newCentreCompany");
  const name = input.value.trim();
  const company = companyInput?.value?.trim() || "";
  if (!name || !company) {
    showToast("Enter the centre name and choose whether it belongs to KH or Swizton");
    return;
  }
  if (company === "Swizton") {
    showToast("Swizton does not use centre login accounts. Add the centre name inside Swizton performance entry.");
    return;
  }
  centers.push({
    name,
    company,
    username: name.toLowerCase().replace(/\s+/g, ""),
    password: "1234",
    tillDate: 0,
    yesterday: 0,
    target: 0,
    cagToday: 0,
    cagTotal: 0,
    kasp: 0,
    general: 0,
    medisep: 0
  });
  input.value = "";
  if (companyInput) companyInput.value = "";
  refreshCenterLists();
  renderTargets();
  renderUsers();
  renderConsolidated();
  renderBars();
  renderPayerSplit();
  renderAdminReportPreview();
  persistSoon();
  showToast("Centre added");
}

function removeCenter(index) {
  if (centers.length <= 1) {
    showToast("At least one centre is required");
    return;
  }
  const ok = window.confirm(
    `Remove "${centers[index].name}"? All entry data for this centre will be permanently deleted.`
  );
  if (!ok) return;
  centers.splice(index, 1);
  const shifted = {};
  Object.keys(entries).forEach((key) => {
    const oldIndex = Number(key);
    if (oldIndex < index) shifted[oldIndex] = entries[oldIndex];
    if (oldIndex > index) shifted[oldIndex - 1] = entries[oldIndex];
  });
  Object.keys(entries).forEach((key) => delete entries[key]);
  Object.assign(entries, shifted);
  loggedInCentreIndex = Math.min(loggedInCentreIndex, centers.length - 1);
  refreshCenterLists();
  renderTargets();
  renderUsers();
  renderConsolidated();
  renderBars();
  renderPayerSplit();
  renderAdminReportPreview();
  persistSoon();
  showToast("Centre removed");
}

function refreshCenterLists() {
  const loginSelect = document.getElementById("loginCentre");
  if (loginSelect) {
    loginSelect.innerHTML = centers
      .map((center, index) => ({ center, index }))
      .filter(({ center }) => (center.company || "KH") === "KH")
      .map(({ center, index }) => `<option value="${index}">${center.name}</option>`)
      .join("");
  }
  const exportSelect = document.getElementById("exportCentre");
  if (exportSelect) {
    const assigned = getCompanyScopedCentreIndexes();
    exportSelect.innerHTML = `<option value="all">All Centres</option>` +
      assigned.map(i => `<option value="${i}">${centers[i].name}</option>`).join("");
  }
  if (currentRole === "centre" && exportSelect) {
    exportSelect.value = String(loggedInCentreIndex);
    exportSelect.disabled = true;
  }
}

function setupNavigation() {
  document.querySelectorAll(".nav-item").forEach((item) => {
    item.addEventListener("click", () => {
      showView(item.dataset.view);
      closeSidebar();
    });
  });
  document.getElementById("backToAdmin").addEventListener("click", () => showView("admin"));

  // Mobile sidebar toggle
  const toggle = document.getElementById("sidebarToggle");
  const overlay = document.getElementById("sidebarOverlay");
  const sidebar = document.getElementById("sidebar");
  if (toggle) {
    toggle.addEventListener("click", () => {
      const open = sidebar.classList.toggle("open");
      overlay.classList.toggle("open", open);
      toggle.innerHTML = open ? "&#10005;" : "&#9776;";
    });
  }
  if (overlay) {
    overlay.addEventListener("click", closeSidebar);
  }
}

function closeSidebar() {
  const sidebar = document.getElementById("sidebar");
  const overlay = document.getElementById("sidebarOverlay");
  const toggle = document.getElementById("sidebarToggle");
  if (sidebar) sidebar.classList.remove("open");
  if (overlay) overlay.classList.remove("open");
  if (toggle) toggle.innerHTML = "&#9776;";
}

function setupLogin() {
  const centreSelect = document.getElementById("loginCentre");
  centreSelect.innerHTML = centers
    .map((center, index) => ({ center, index }))
    .filter(({ center }) => (center.company || "KH") === "KH")
    .map(({ center, index }) => `<option value="${index}">${center.name}</option>`)
    .join("");

  // Live lockout countdown
  setInterval(() => {
    const secs = lockoutSecondsLeft();
    const el = document.getElementById("loginLockout");
    const btn = document.getElementById("loginBtn");
    if (!el) return;
    if (secs > 0) {
      el.textContent = `Login locked — too many failed attempts. Try again in ${secs}s.`;
      el.classList.remove("hidden");
      btn.disabled = true;
    } else {
      el.classList.add("hidden");
      btn.disabled = false;
    }
  }, 500);

  document.querySelectorAll(".login-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      loginType = tab.dataset.loginType;
      document.querySelectorAll(".login-tab").forEach((item) => item.classList.toggle("active", item === tab));
      document.querySelector(".centre-login-field").classList.toggle("hidden", loginType !== "centre");
      document.querySelector(".admin-login-field").classList.toggle("hidden", loginType !== "admin");
      document.getElementById("loginPassword").value = "";
      document.getElementById("loginError").textContent = "";
    });
  });

  document.getElementById("loginBtn").addEventListener("click", () => login());
  document.getElementById("loginPassword").addEventListener("keydown", (event) => {
    if (event.key === "Enter") login();
  });
  document.getElementById("logoutBtn").addEventListener("click", logout);
}

function setupEntryDate() {
  document.getElementById("entryDate").addEventListener("change", () => {
    renderEntryForCurrentDate();
  });
}

function lastEntryDateForMonth(month) {
  // Find the latest date across all centres that has data in this month
  let latest = "";
  centers.forEach((_, index) => {
    const centreEntries = ensureCentreEntries(index);
    Object.keys(centreEntries)
      .filter((d) => d.slice(0, 7) === month)
      .forEach((d) => { if (d > latest) latest = d; });
  });
  // Fall back to today if it's the current month, else month-end
  if (!latest) {
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    if (today.slice(0, 7) === month) return today;
    return getMonthEndDate(month + "-01");
  }
  return latest;
}

function setupMonthSelect() {
  const monthSelect = document.getElementById("monthSelect");
  monthSelect.addEventListener("change", () => {
    const selectedMonth = monthSelect.value;
    const newReportDate = lastEntryDateForMonth(selectedMonth);
    setReportDate(newReportDate);
    if (!swiztonEditingId && document.getElementById("swiztonMonth")) {
      document.getElementById("swiztonMonth").value = selectedMonth;
    }
    document.getElementById("exportMonth").value = selectedMonth;
    syncExportDatesToMonth(selectedMonth);
    refreshCenterRollups(reportDate);
    renderConsolidated();
    renderBars();
    renderPayerSplit();
    renderAdminReportPreview();
    if (document.getElementById("centreView").classList.contains("active")) {
      openCentre(activeCentreDashboardIndex);
    }
  });
}

function setupExportFilters() {
  refreshCenterLists();
  document.getElementById("exportMonth").addEventListener("change", (event) => {
    syncExportDatesToMonth(event.target.value);
    renderAdminReportPreview();
  });
  ["exportCentre", "exportReportType", "exportFromDate", "exportToDate"].forEach((id) => {
    document.getElementById(id).addEventListener("change", renderAdminReportPreview);
  });
}

function setupExportMenus() {
  document.querySelectorAll(".export-menu-button").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      const dropdown = button.nextElementSibling;
      document.querySelectorAll(".export-dropdown").forEach((menu) => {
        if (menu !== dropdown) menu.classList.add("hidden");
      });
      dropdown.classList.toggle("hidden");
    });
  });

  document.querySelectorAll("[data-export-format]").forEach((button) => {
    button.addEventListener("click", () => {
      document.querySelectorAll(".export-dropdown").forEach((menu) => menu.classList.add("hidden"));
      const format = button.dataset.exportFormat;
      if (format === "pdf") downloadProfessionalReport();
      if (format === "csv") downloadFilteredCsvReport();
      if (format === "png") downloadImageReport("png");
      if (format === "jpg") downloadImageReport("jpg");
    });
  });

  document.addEventListener("click", () => {
    document.querySelectorAll(".export-dropdown").forEach((menu) => menu.classList.add("hidden"));
  });
}

function setupAdminControls() {
  document.getElementById("addProcedureBtn").addEventListener("click", addProcedure);
  document.getElementById("newProcedureName").addEventListener("keydown", (event) => {
    if (event.key === "Enter") addProcedure();
  });
  document.getElementById("addCentreBtn").addEventListener("click", addCenter);
  document.getElementById("newCentreName").addEventListener("keydown", (event) => {
    if (event.key === "Enter") addCenter();
  });
  document.getElementById("newCentreCompany")?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") addCenter();
  });
  document.getElementById("swiztonSaveBtn")?.addEventListener("click", saveSwiztonEntry);
  document.getElementById("swiztonClearBtn")?.addEventListener("click", clearSwiztonForm);
  document.querySelectorAll("#swiztonPerformancePanel input").forEach((input) => {
    input.addEventListener("input", updateSwiztonEntryPreviews);
    input.addEventListener("change", updateSwiztonEntryPreviews);
  });

  // Unlock modal
  document.getElementById("unlockModalClose")?.addEventListener("click", closeUnlockModal);
  document.getElementById("unlockModalCancel")?.addEventListener("click", closeUnlockModal);
  document.getElementById("unlockModalSubmit")?.addEventListener("click", submitUnlockRequest);
  document.getElementById("unlockModal")?.addEventListener("click", (e) => {
    if (e.target === document.getElementById("unlockModal")) closeUnlockModal();
  });
}

function syncExportDatesToMonth(month) {
  document.getElementById("exportFromDate").value = monthStartDates[month] || month + "-01";
  // Use the last known entry date for this month, not the hard month-end,
  // so the export range always matches what the consolidated table shows
  document.getElementById("exportToDate").value = lastEntryDateForMonth(month);
}

function renderAdminReportPreview() {
  if (activeCompany === "Swizton") {
    const chart = document.getElementById("adminTrendChart");
    if (chart) chart.innerHTML = `<p>No Swizton performance entries for this filter.</p>`;
    const forecast = document.getElementById("forecastCard");
    if (forecast) {
      forecast.innerHTML = `
        <span>Swizton Report Model</span>
        <strong>Leads & Advices</strong>
        <small>Swizton reporting follows the uploaded workbook format: Leads, OP seen, Advices, and Procedure Done split by UFE and Vericose.</small>
      `;
    }
    return;
  }

  const rows = filteredDailyRows();
  const forecast = reportForecast(rows);
  renderAdminTrend(rows);
  document.getElementById("forecastCard").innerHTML = `
    <span>Projected Intervention</span>
    <strong>${forecast.projected}</strong>
    <small>${forecast.projectedAchievement}% projected achievement against target ${forecast.selectedTarget}. Required run rate: ${forecast.requiredPerDay.toFixed(1)} per remaining day. Use CSV / Excel for raw data, Professional PDF for management presentation.</small>
  `;
}

function renderAdminTrend(rows) {
  const chart = document.getElementById("adminTrendChart");
  const byDate = rows.reduce((acc, row) => {
    acc[row.date] = (acc[row.date] || 0) + row.intervention;
    return acc;
  }, {});
  const values = Object.entries(byDate);
  chart.innerHTML = "";
  if (!values.length) {
    chart.innerHTML = `<p>No saved data for this filter.</p>`;
    return;
  }
  const max = Math.max(...values.map(([, value]) => value), 1);
  values.forEach(([date, value]) => {
    const bar = document.createElement("div");
    bar.className = "trend-bar";
    bar.style.height = `${Math.max(12, (value / max) * 140)}px`;
    bar.title = `${displayDate(date)}: ${value}`;
    bar.innerHTML = `<span>${date.slice(-2)}</span>`;
    chart.appendChild(bar);
  });
}

function csvEscape(value) {
  const text = String(value ?? "");
  if (/[",\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

function tableToCsv(title, tableId) {
  const table = document.getElementById(tableId);
  const rows = Array.from(table.querySelectorAll("tr"));
  const csvRows = [[title], []];
  rows.forEach((row) => {
    const cells = Array.from(row.children).map((cell) => csvEscape(cell.textContent.trim()));
    csvRows.push(cells);
  });
  return csvRows.map((row) => row.join(",")).join("\n");
}

function filteredRowsToCsv(rows) {
  const totals = reportTotals(rows);
  const header = [
    "Date",
    "Centre",
    "Intervention",
    "CAG",
    "General",
    "KASP",
    "MEDISEP",
    "OP",
    "IP",
    "New OP",
    "ECG",
    "Echo",
    "TMT"
  ];
  const body = rows.map((row) => [
    displayDate(row.date),
    row.center,
    row.intervention,
    row.cag,
    row.general,
    row.kasp,
    row.medisep,
    row.op,
    row.ip,
    row.newOp,
    row.ecg,
    row.echo,
    row.tmt
  ]);
  const totalRow = [
    "TOTAL",
    "",
    totals.intervention,
    totals.cag,
    totals.general,
    totals.kasp,
    totals.medisep,
    totals.op,
    totals.ip,
    totals.newOp,
    totals.ecg,
    totals.echo,
    totals.tmt
  ];
  return [header, ...body, totalRow].map((row) => row.map(csvEscape).join(",")).join("\n");
}

function consolidatedRowsToCsv(rows) {
  const totals = consolidatedTotals(rows);
  const totalPercent = totals.target ? Math.round((totals.total / totals.target) * 100) : 0;
  const header = [
    "Centre",
    "Target",
    "Till Yesterday",
    "Today",
    "Total",
    "%",
    "CAG Today",
    "CAG Total",
    "General",
    "KASP",
    "MEDISEP",
    "OP Total",
    "IP Total",
    "New OP Total",
    "ECG Total",
    "Echo Total",
    "TMT Total"
  ];
  const body = rows.map((row) => [
    row.center,
    row.target,
    row.tillYesterday,
    row.today,
    row.total,
    row.percent,
    row.cagToday,
    row.cagTotal,
    row.general,
    row.kasp,
    row.medisep,
    row.opTotal,
    row.ipTotal,
    row.newOpTotal,
    row.ecgTotal,
    row.echoTotal,
    row.tmtTotal
  ]);
  const totalRow = [
    "TOTAL",
    totals.target,
    totals.tillYesterday,
    totals.today,
    totals.total,
    totalPercent,
    totals.cagToday,
    totals.cagTotal,
    totals.general,
    totals.kasp,
    totals.medisep,
    totals.opTotal,
    totals.ipTotal,
    totals.newOpTotal,
    totals.ecgTotal,
    totals.echoTotal,
    totals.tmtTotal
  ];
  return [header, ...body, totalRow].map((row) => row.map(csvEscape).join(",")).join("\n");
}

function swiztonRowsToCsv(rows) {
  const totals = swiztonTotals(rows);
  const percent = (numerator, denominator) => denominator ? Math.round((currencySafeNumber(numerator) / currencySafeNumber(denominator)) * 100) : 0;
  const leadsHeader = ["Sl. No.", "Month", "Centre", "Campaign", "Campaign Date", "UFE Leads Generated", "UFE Genuine Leads", "UFE RNR/WCB/Wrong Queries", "UFE OP Booked", "UFE OP Seen", "UFE Lead Conversion %", "Vericose Leads Generated", "Vericose Genuine Leads", "Vericose RNR/WCB/Wrong Queries", "Vericose OP Booked", "Vericose OP Seen", "Vericose Lead Conversion %"];
  const leadsRows = rows.map((row, index) => [index + 1, row.month, row.centre, row.campaign, row.campaignDate ? displayDate(row.campaignDate) : "", row.ufeLeadsGenerated, row.ufeGenuineLeads, row.ufeInvalidLeads, row.ufeOpBooked, row.ufeOpSeen, percent(row.ufeOpSeen, row.ufeLeadsGenerated), row.vericoseLeadsGenerated, row.vericoseGenuineLeads, row.vericoseInvalidLeads, row.vericoseOpBooked, row.vericoseOpSeen, percent(row.vericoseOpSeen, row.vericoseLeadsGenerated)]);
  const adviceHeader = ["Sl. No.", "Month", "Centre", "Campaign", "Campaign Date", "UFE Advices", "UFE Procedure Done", "UFE Procedure Scheduled", "UFE Cash Issue", "UFE Insurance Issue", "UFE Other Reasons", "UFE Procedure Missed", "UFE Advice Conversion %", "Vericose Advices", "Vericose Procedure Done", "Vericose Procedure Scheduled", "Vericose Cash Issue", "Vericose Insurance Issue", "Vericose Other Reasons", "Vericose Procedure Missed", "Vericose Advice Conversion %"];
  const adviceRows = rows.map((row, index) => [index + 1, row.month, row.centre, row.campaign, row.campaignDate ? displayDate(row.campaignDate) : "", row.ufeAdvices, row.ufeProcedureDone, row.ufeProcedureScheduled, row.ufeCashIssue, row.ufeInsuranceIssue, row.ufeOtherReasons, row.ufeProcedureMissed, percent(row.ufeProcedureDone, row.ufeAdvices), row.vericoseAdvices, row.vericoseProcedureDone, row.vericoseProcedureScheduled, row.vericoseCashIssue, row.vericoseInsuranceIssue, row.vericoseOtherReasons, row.vericoseProcedureMissed, percent(row.vericoseProcedureDone, row.vericoseAdvices)]);
  const consolidatedHeader = ["Sl. No.", "Month", "Centre", "Campaign", "Campaign Date", "No. of Leads Generated (UFE)", "No. of Leads Generated (Vericose)", "No. of OP generated (UFE)", "No. of OP generated (Vericose)", "No. of Advices (UFE)", "No. of Advices (Vericose)", "Digital Procedures Done (UFE)", "Digital Procedures Done (Vericose)", "Total Procedures Done (UFE)", "Total Procedures Done (Vericose)"];
  const consolidatedRows = rows.map((row, index) => {
    const item = swiztonConsolidatedRow(row, index);
    return [item.slNo, item.month, item.centre, item.campaign, item.campaignDate ? displayDate(item.campaignDate) : "", item.ufeLeadsGenerated, item.vericoseLeadsGenerated, item.ufeOpGenerated, item.vericoseOpGenerated, item.ufeAdvices, item.vericoseAdvices, item.ufeDigitalProcedures, item.vericoseDigitalProcedures, item.ufeTotalProcedures, item.vericoseTotalProcedures];
  });
  const consolidatedTotalRow = ["TOTAL", "", "", "", "", totals.ufeLeadsGenerated, totals.vericoseLeadsGenerated, totals.ufeOpGenerated, totals.vericoseOpGenerated, totals.ufeAdvices, totals.vericoseAdvices, totals.ufeDigitalProcedures, totals.vericoseDigitalProcedures, totals.ufeTotalProcedures, totals.vericoseTotalProcedures];
  const sections = [
    ["Leads Entry", leadsHeader, ...leadsRows],
    [],
    ["Advices Entry", adviceHeader, ...adviceRows],
    [],
    ["Consolidated Report", consolidatedHeader, ...consolidatedRows, consolidatedTotalRow]
  ];
  return sections.map((row) => row.map(csvEscape).join(",")).join("\n");
}

function downloadSwiztonCsvReport() {
  const month = selectedSwiztonMonth();
  const rows = getSwiztonRows(month);
  const csv = [
    `Swizton Performance Report - ${month}`,
    "",
    swiztonRowsToCsv(rows)
  ].join("\n");
  downloadBlob(csv, `swizton-performance-${month}.csv`, "text/csv;charset=utf-8");
  showToast("Swizton CSV downloaded");
}

function downloadFilteredCsvReport() {
  if (activeCompany === "Swizton") {
    downloadSwiztonCsvReport();
    return;
  }
  const isDaily = selectedReportType() === "daily";
  const rows = isDaily ? filteredDailyRows() : filteredConsolidatedRows();
  const range = getExportRange();
  const forecast = reportForecast(filteredDailyRows());
  const csv = [
    `KH ${isDaily ? "Daily Wise Detail" : "Consolidated Summary"} Report`,
    `Centre,${csvEscape(document.getElementById("exportCentre").selectedOptions[0].textContent)}`,
    `From,${displayDate(range.fromDate)}`,
    `To,${displayDate(range.toDate)}`,
    `Target,${forecast.selectedTarget}`,
    `Projected Month End,${forecast.projected}`,
    "",
    isDaily ? filteredRowsToCsv(rows) : consolidatedRowsToCsv(rows)
  ].join("\n");
  downloadBlob(csv, `kh-${isDaily ? "daily" : "consolidated"}-report-${range.fromDate}-to-${range.toDate}.csv`, "text/csv;charset=utf-8");
  showToast("Filtered CSV downloaded");
}

function downloadBlob(content, filename, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function svgBarChart(rows) {
  const byDate = rows.reduce((acc, row) => {
    acc[row.date] = (acc[row.date] || 0) + row.intervention;
    return acc;
  }, {});
  const values = Object.entries(byDate);
  const width = 760;
  const height = 250;
  const pad = 34;
  const max = Math.max(...values.map(([, value]) => value), 1);
  const barWidth = values.length ? Math.max(16, (width - pad * 2) / values.length - 8) : 16;
  const bars = values.map(([date, value], index) => {
    const x = pad + index * (barWidth + 8);
    const barHeight = (value / max) * 170;
    const y = height - pad - barHeight;
    return `
      <rect x="${x}" y="${y}" width="${barWidth}" height="${barHeight}" rx="4" fill="#2563eb"></rect>
      <text x="${x + barWidth / 2}" y="${height - 10}" text-anchor="middle" font-size="10" fill="#657184">${date.slice(-2)}</text>
      <text x="${x + barWidth / 2}" y="${y - 6}" text-anchor="middle" font-size="10" fill="#18212f">${value}</text>
    `;
  }).join("");
  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Intervention trend chart"><line x1="${pad}" y1="${height - pad}" x2="${width - pad}" y2="${height - pad}" stroke="#dce3ea"></line>${bars}</svg>`;
}

function svgPayerChart(totals) {
  const sum = totals.general + totals.kasp + totals.medisep || 1;
  const items = [
    { label: "General", value: totals.general, color: "#2563eb" },
    { label: "KASP", value: totals.kasp, color: "#0f9f8f" },
    { label: "MEDISEP", value: totals.medisep, color: "#7c3aed" }
  ];
  let y = 22;
  const bars = items.map((item) => {
    const width = Math.round((item.value / sum) * 380);
    const row = `
      <text x="0" y="${y}" font-size="13" fill="#18212f">${item.label}</text>
      <rect x="90" y="${y - 13}" width="380" height="16" rx="4" fill="#e8edf3"></rect>
      <rect x="90" y="${y - 13}" width="${width}" height="16" rx="4" fill="${item.color}"></rect>
      <text x="485" y="${y}" font-size="13" fill="#18212f">${item.value}</text>
    `;
    y += 38;
    return row;
  }).join("");
  return `<svg viewBox="0 0 540 130" role="img" aria-label="Payer split chart">${bars}</svg>`;
}

function swiztonProfessionalReportHtml() {
  const month = selectedSwiztonMonth();
  const rows = getSwiztonRows(month);
  const totals = swiztonTotals(rows);
  const percent = (numerator, denominator) => denominator ? Math.round((currencySafeNumber(numerator) / currencySafeNumber(denominator)) * 100) : 0;
  const tableRows = rows.map((entry, index) => {
    const row = swiztonConsolidatedRow(entry, index);
    return `
    <tr>
      <td>${row.slNo}</td>
      <td>${escapeHtml(row.month || "")}</td>
      <td>${escapeHtml(row.centre || "")}</td>
      <td>${escapeHtml(row.campaign || "")}</td>
      <td>${row.campaignDate ? displayDate(row.campaignDate) : ""}</td>
      <td>${row.ufeLeadsGenerated}</td>
      <td>${row.vericoseLeadsGenerated}</td>
      <td>${row.ufeOpGenerated}</td>
      <td>${row.vericoseOpGenerated}</td>
      <td>${row.ufeAdvices}</td>
      <td>${row.vericoseAdvices}</td>
      <td>${row.ufeDigitalProcedures}</td>
      <td>${row.vericoseDigitalProcedures}</td>
      <td>${row.ufeTotalProcedures}</td>
      <td>${row.vericoseTotalProcedures}</td>
    </tr>
  `;
  }).join("");
  const totalProcedures = totals.ufeTotalProcedures + totals.vericoseTotalProcedures;
  const totalLeads = totals.ufeLeadsGenerated + totals.vericoseLeadsGenerated;
  const totalOpSeen = totals.ufeOpGenerated + totals.vericoseOpGenerated;
  const totalAdvices = totals.ufeAdvices + totals.vericoseAdvices;
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Swizton Performance Report</title>
  <style>
    body { font-family: Arial, sans-serif; color: #18212f; margin: 0; background: #f5f7fa; }
    main { max-width: 1180px; margin: 0 auto; padding: 30px; }
    header { background: #101927; color: white; padding: 26px; border-radius: 8px; margin-bottom: 18px; }
    h1, h2, p { margin: 0; }
    h1 { font-size: 28px; }
    p { color: #657184; margin-top: 6px; }
    header p { color: #c8d4e4; }
    .grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 18px; }
    .card, section { background: white; border: 1px solid #dce3ea; border-radius: 8px; padding: 16px; }
    .card span { display: block; color: #657184; font-size: 12px; text-transform: uppercase; font-weight: 700; }
    .card strong { display: block; font-size: 26px; margin-top: 8px; }
    table { width: 100%; border-collapse: collapse; background: white; font-size: 12px; }
    th, td { border: 1px solid #dce3ea; padding: 8px; text-align: right; }
    th:first-child, td:first-child, th:nth-child(2), td:nth-child(2), th:nth-child(3), td:nth-child(3) { text-align: left; }
    th { background: #e9f0f7; text-transform: uppercase; font-size: 11px; }
    @media print { body { background: white; } main { padding: 0; } }
  </style>
</head>
<body>
  <main>
    <header>
      <h1>Swizton Performance Report</h1>
      <p>${escapeHtml(month)} | Leads, Advices, and Procedure Performance</p>
    </header>
    <div class="grid">
      <div class="card"><span>Total Leads</span><strong>${totalLeads}</strong></div>
      <div class="card"><span>OP Seen</span><strong>${totalOpSeen}</strong></div>
      <div class="card"><span>Advices</span><strong>${totalAdvices}</strong></div>
      <div class="card"><span>Procedure Done</span><strong>${totalProcedures}</strong></div>
      <div class="card"><span>UFE Lead Conversion</span><strong>${percent(totals.ufeOpGenerated, totals.ufeLeadsGenerated)}%</strong></div>
      <div class="card"><span>Vericose Lead Conversion</span><strong>${percent(totals.vericoseOpGenerated, totals.vericoseLeadsGenerated)}%</strong></div>
      <div class="card"><span>UFE Advice Conversion</span><strong>${percent(totals.ufeDigitalProcedures, totals.ufeAdvices)}%</strong></div>
      <div class="card"><span>Vericose Advice Conversion</span><strong>${percent(totals.vericoseDigitalProcedures, totals.vericoseAdvices)}%</strong></div>
    </div>
    <section>
      <h2>Consolidated Summary</h2>
      <table>
        <thead><tr><th>Sl. No.</th><th>Month</th><th>Centre</th><th>Campaign</th><th>Campaign Date</th><th>UFE Leads</th><th>Vericose Leads</th><th>UFE OP Generated</th><th>Vericose OP Generated</th><th>UFE Advices</th><th>Vericose Advices</th><th>UFE Digital Proc.</th><th>Vericose Digital Proc.</th><th>UFE Total Proc.</th><th>Vericose Total Proc.</th></tr></thead>
        <tbody>${tableRows || `<tr><td colspan="15">No Swizton data for selected month.</td></tr>`}</tbody>
        <tfoot><tr style="font-weight:700;background:#e9f0f7"><td colspan="5">Total</td><td>${totals.ufeLeadsGenerated}</td><td>${totals.vericoseLeadsGenerated}</td><td>${totals.ufeOpGenerated}</td><td>${totals.vericoseOpGenerated}</td><td>${totals.ufeAdvices}</td><td>${totals.vericoseAdvices}</td><td>${totals.ufeDigitalProcedures}</td><td>${totals.vericoseDigitalProcedures}</td><td>${totals.ufeTotalProcedures}</td><td>${totals.vericoseTotalProcedures}</td></tr></tfoot>
      </table>
    </section>
  </main>
</body>
</html>`;
}

function professionalReportHtml() {
  if (activeCompany === "Swizton") return swiztonProfessionalReportHtml();

  const range = getExportRange();
  const isDaily = selectedReportType() === "daily";
  const dailyRows = filteredDailyRows();
  const totals = reportTotals(dailyRows);
  const forecast = reportForecast(dailyRows);
  const consolidatedRows = filteredConsolidatedRows();
  const consolidatedTotal = consolidatedTotals(consolidatedRows);
  const consolidatedPercent = consolidatedTotal.target ? Math.round((consolidatedTotal.total / consolidatedTotal.target) * 100) : 0;
  const centreName = document.getElementById("exportCentre").selectedOptions[0].textContent;
  const dailyTableRows = dailyRows.map((row) => `
    <tr>
      <td>${displayDate(row.date)}</td>
      <td>${escapeHtml(row.center)}</td>
      <td>${row.intervention}</td>
      <td>${row.cag}</td>
      <td>${row.general}</td>
      <td>${row.kasp}</td>
      <td>${row.medisep}</td>
      <td>${row.op}</td>
      <td>${row.ip}</td>
      <td>${row.newOp}</td>
      <td>${row.ecg}</td>
      <td>${row.echo}</td>
      <td>${row.tmt}</td>
    </tr>
  `).join("");
  const dailyTotalRow = `
    <tr style="font-weight:700;background:#e9f0f7">
      <td>Total</td>
      <td></td>
      <td>${totals.intervention}</td>
      <td>${totals.cag}</td>
      <td>${totals.general}</td>
      <td>${totals.kasp}</td>
      <td>${totals.medisep}</td>
      <td>${totals.op}</td>
      <td>${totals.ip}</td>
      <td>${totals.newOp}</td>
      <td>${totals.ecg}</td>
      <td>${totals.echo}</td>
      <td>${totals.tmt}</td>
    </tr>
  `;
  const consolidatedTableRows = consolidatedRows.map((row) => `
    <tr>
      <td>${escapeHtml(row.center)}</td>
      <td>${row.target}</td>
      <td>${row.tillYesterday}</td>
      <td>${row.today}</td>
      <td>${row.total}</td>
      <td>${row.percent}%</td>
      <td>${row.cagToday}</td>
      <td>${row.cagTotal}</td>
      <td>${row.general}</td>
      <td>${row.kasp}</td>
      <td>${row.medisep}</td>
      <td>${row.opTotal}</td>
      <td>${row.ipTotal}</td>
    </tr>
  `).join("");
  const consolidatedTotalRow = `
    <tr style="font-weight:700;background:#e9f0f7">
      <td>Total</td>
      <td>${consolidatedTotal.target}</td>
      <td>${consolidatedTotal.tillYesterday}</td>
      <td>${consolidatedTotal.today}</td>
      <td>${consolidatedTotal.total}</td>
      <td>${consolidatedPercent}%</td>
      <td>${consolidatedTotal.cagToday}</td>
      <td>${consolidatedTotal.cagTotal}</td>
      <td>${consolidatedTotal.general}</td>
      <td>${consolidatedTotal.kasp}</td>
      <td>${consolidatedTotal.medisep}</td>
      <td>${consolidatedTotal.opTotal}</td>
      <td>${consolidatedTotal.ipTotal}</td>
    </tr>
  `;
  const tableSection = isDaily ? `
    <section>
      <h2>Daily Wise Detailed Data</h2>
      <table>
        <thead><tr><th>Date</th><th>Centre</th><th>Intervention</th><th>CAG</th><th>General</th><th>KASP</th><th>MEDISEP</th><th>OP</th><th>IP</th><th>New OP</th><th>ECG</th><th>Echo</th><th>TMT</th></tr></thead>
        <tbody>${dailyTableRows ? `${dailyTableRows}${dailyTotalRow}` : `<tr><td colspan="13">No saved data for selected filters.</td></tr>`}</tbody>
      </table>
    </section>
  ` : `
    <section>
      <h2>Consolidated Summary</h2>
      <table>
        <thead><tr><th>Centre</th><th>Target</th><th>Till Yesterday</th><th>Today</th><th>Total</th><th>%</th><th>CAG Today</th><th>CAG Total</th><th>General</th><th>KASP</th><th>MEDISEP</th><th>OP Total</th><th>IP Total</th></tr></thead>
        <tbody>${consolidatedTableRows ? `${consolidatedTableRows}${consolidatedTotalRow}` : `<tr><td colspan="13">No saved data for selected filters.</td></tr>`}</tbody>
      </table>
    </section>
  `;
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>KH Operations Report</title>
  <style>
    body { font-family: Arial, sans-serif; color: #18212f; margin: 0; background: #f5f7fa; }
    main { max-width: 1120px; margin: 0 auto; padding: 30px; }
    header { background: #101927; color: white; padding: 26px; border-radius: 8px; margin-bottom: 18px; }
    h1, h2, p { margin: 0; }
    h1 { font-size: 28px; }
    p { color: #657184; margin-top: 6px; }
    header p { color: #c8d4e4; }
    .grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 18px; }
    .card, section { background: white; border: 1px solid #dce3ea; border-radius: 8px; padding: 16px; }
    .card span { display: block; color: #657184; font-size: 12px; text-transform: uppercase; font-weight: 700; }
    .card strong { display: block; font-size: 26px; margin-top: 8px; }
    section { margin-bottom: 18px; }
    table { width: 100%; border-collapse: collapse; background: white; font-size: 12px; }
    th, td { border: 1px solid #dce3ea; padding: 8px; text-align: right; }
    th:first-child, td:first-child, th:nth-child(2), td:nth-child(2) { text-align: left; }
    th { background: #e9f0f7; text-transform: uppercase; font-size: 11px; }
    .two { display: grid; grid-template-columns: 1.3fr .7fr; gap: 14px; }
    @media print { body { background: white; } main { padding: 0; } }
  </style>
</head>
<body>
  <main>
    <header>
      <h1>KH Operations Report</h1>
      <p>${escapeHtml(centreName)} | ${isDaily ? "Daily Wise Detail" : "Consolidated Summary"} | ${displayDate(range.fromDate)} to ${displayDate(range.toDate)}</p>
    </header>
    <div class="grid">
      <div class="card"><span>Intervention</span><strong>${totals.intervention}</strong></div>
      <div class="card"><span>CAG</span><strong>${totals.cag}</strong></div>
      <div class="card"><span>Achievement</span><strong>${forecast.achievement}%</strong></div>
      <div class="card"><span>Projected Month End</span><strong>${forecast.projected}</strong></div>
      <div class="card"><span>Target</span><strong>${forecast.selectedTarget}</strong></div>
      <div class="card"><span>Projected Achievement</span><strong>${forecast.projectedAchievement}%</strong></div>
      <div class="card"><span>Required / Remaining Day</span><strong>${forecast.requiredPerDay.toFixed(1)}</strong></div>
      <div class="card"><span>OP</span><strong>${totals.op}</strong></div>
    </div>
    <div class="two">
      <section>
        <h2>Intervention Trend</h2>
        <p>Daily selected interventional procedure count.</p>
        ${svgBarChart(dailyRows)}
      </section>
      <section>
        <h2>Payer Split</h2>
        <p>Selected procedures only.</p>
        ${svgPayerChart(totals)}
      </section>
    </div>
    <section>
      <h2>Forecast</h2>
      <p>Average ${forecast.average.toFixed(1)} interventions per saved day across ${forecast.dayCount} saved day${forecast.dayCount === 1 ? "" : "s"}. Projected month-end total is ${forecast.projected} for a ${forecast.lastDay}-day month. Current achievement is ${forecast.achievement}% against target ${forecast.selectedTarget}; projected achievement is ${forecast.projectedAchievement}%. Required run rate is ${forecast.requiredPerDay.toFixed(1)} per remaining day.</p>
    </section>
    ${tableSection}
  </main>
</body>
</html>`;
}

function downloadProfessionalReport() {
  const range = getExportRange();
  const fallbackName = activeCompany === "Swizton"
    ? `swizton-performance-report-${selectedSwiztonMonth()}.html`
    : `kh-professional-report-${range.fromDate}-to-${range.toDate}.html`;
  const reportWindow = window.open("", "_blank");
  if (!reportWindow) {
    downloadBlob(professionalReportHtml(), fallbackName, "text/html;charset=utf-8");
    showToast("Popup blocked. HTML report downloaded instead.");
    return;
  }
  reportWindow.document.open();
  reportWindow.document.write(professionalReportHtml());
  reportWindow.document.close();
  reportWindow.addEventListener("load", () => {
    reportWindow.focus();
    reportWindow.print();
  });
  showToast("PDF-ready report opened");
}

function downloadSwiztonImageReport(format) {
  const month = selectedSwiztonMonth();
  const rows = getSwiztonRows(month);
  const totals = swiztonTotals(rows);
  const totalLeads = totals.ufeLeadsGenerated + totals.vericoseLeadsGenerated;
  const totalOpSeen = totals.ufeOpGenerated + totals.vericoseOpGenerated;
  const totalAdvices = totals.ufeAdvices + totals.vericoseAdvices;
  const totalProcedures = totals.ufeTotalProcedures + totals.vericoseTotalProcedures;
  const canvas = document.createElement("canvas");
  canvas.width = 1400;
  canvas.height = 900;
  const ctx = canvas.getContext("2d");

  ctx.fillStyle = "#f5f7fa";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#101927";
  ctx.fillRect(50, 50, 1300, 150);
  ctx.fillStyle = "#ffffff";
  ctx.font = "700 42px Arial";
  ctx.fillText("Swizton Performance Report", 90, 115);
  ctx.font = "400 24px Arial";
  ctx.fillText(`${month} | Leads, Advices, and Procedures`, 90, 160);

  const cards = [
    ["Total Leads", totalLeads],
    ["OP Seen", totalOpSeen],
    ["Advices", totalAdvices],
    ["Procedure Done", totalProcedures],
    ["UFE Procedures", totals.ufeTotalProcedures],
    ["Vericose Procedures", totals.vericoseTotalProcedures]
  ];
  cards.forEach(([label, value], index) => {
    const x = 50 + (index % 3) * 430;
    const y = 230 + Math.floor(index / 3) * 130;
    ctx.fillStyle = "#ffffff";
    ctx.strokeStyle = "#dce3ea";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.roundRect(x, y, 400, 100, 8);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#657184";
    ctx.font = "700 18px Arial";
    ctx.fillText(label.toUpperCase(), x + 24, y + 34);
    ctx.fillStyle = "#18212f";
    ctx.font = "700 38px Arial";
    ctx.fillText(String(value), x + 24, y + 78);
  });

  ctx.fillStyle = "#ffffff";
  ctx.strokeStyle = "#dce3ea";
  ctx.beginPath();
  ctx.roundRect(50, 520, 1300, 270, 8);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = "#18212f";
  ctx.font = "700 24px Arial";
  ctx.fillText("Campaign Summary", 80, 565);
  ctx.font = "700 18px Arial";
  ctx.fillText("Centre", 80, 615);
  ctx.fillText("Campaign", 290, 615);
  ctx.fillText("Leads", 500, 615);
  ctx.fillText("OP Gen.", 650, 615);
  ctx.fillText("Advices", 820, 615);
  ctx.fillText("Procedures", 1000, 615);
  ctx.font = "18px Arial";
  rows.slice(0, 6).forEach((entry, index) => {
    const row = swiztonConsolidatedRow(entry, index);
    const y = 655 + index * 32;
    ctx.fillText(String(row.centre || ""), 80, y);
    ctx.fillText(String(row.campaign || ""), 290, y);
    ctx.fillText(String(currencySafeNumber(row.ufeLeadsGenerated) + currencySafeNumber(row.vericoseLeadsGenerated)), 500, y);
    ctx.fillText(String(currencySafeNumber(row.ufeOpGenerated) + currencySafeNumber(row.vericoseOpGenerated)), 650, y);
    ctx.fillText(String(currencySafeNumber(row.ufeAdvices) + currencySafeNumber(row.vericoseAdvices)), 820, y);
    ctx.fillText(String(currencySafeNumber(row.ufeTotalProcedures) + currencySafeNumber(row.vericoseTotalProcedures)), 1000, y);
  });
  if (!rows.length) {
    ctx.fillText("No Swizton data for the selected month.", 80, 660);
  }

  const mime = format === "jpg" ? "image/jpeg" : "image/png";
  const extension = format === "jpg" ? "jpg" : "png";
  const link = document.createElement("a");
  link.href = canvas.toDataURL(mime, 0.92);
  link.download = `swizton-performance-${month}.${extension}`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  showToast(`Swizton ${extension.toUpperCase()} report downloaded`);
}

function downloadImageReport(format) {
  if (activeCompany === "Swizton") {
    downloadSwiztonImageReport(format);
    return;
  }

  const rows = filteredDailyRows();
  const totals = reportTotals(rows);
  const forecast = reportForecast(rows);
  const range = getExportRange();
  const centreName = document.getElementById("exportCentre").selectedOptions[0].textContent;
  const reportTypeLabel = selectedReportType() === "daily" ? "Daily Wise Detail" : "Consolidated Summary";
  const canvas = document.createElement("canvas");
  canvas.width = 1400;
  canvas.height = 1000;
  const ctx = canvas.getContext("2d");

  ctx.fillStyle = "#f5f7fa";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#101927";
  ctx.fillRect(50, 50, 1300, 150);
  ctx.fillStyle = "#ffffff";
  ctx.font = "700 42px Arial";
  ctx.fillText("KH Operations Report", 90, 115);
  ctx.font = "400 24px Arial";
  ctx.fillText(`${centreName} | ${reportTypeLabel} | ${displayDate(range.fromDate)} to ${displayDate(range.toDate)}`, 90, 160);

  const cards = [
    ["Intervention", totals.intervention],
    ["CAG", totals.cag],
    ["Achievement", `${forecast.achievement}%`],
    ["Projected", forecast.projected],
    ["Target", forecast.selectedTarget],
    ["Required / Day", forecast.requiredPerDay.toFixed(1)]
  ];
  cards.forEach(([label, value], index) => {
    const x = 50 + (index % 3) * 430;
    const y = 230 + Math.floor(index / 3) * 130;
    ctx.fillStyle = "#ffffff";
    ctx.strokeStyle = "#dce3ea";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.roundRect(x, y, 400, 100, 8);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#657184";
    ctx.font = "700 18px Arial";
    ctx.fillText(label.toUpperCase(), x + 24, y + 34);
    ctx.fillStyle = "#18212f";
    ctx.font = "700 38px Arial";
    ctx.fillText(String(value), x + 24, y + 78);
  });

  ctx.fillStyle = "#ffffff";
  ctx.strokeStyle = "#dce3ea";
  ctx.beginPath();
  ctx.roundRect(50, 520, 820, 340, 8);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = "#18212f";
  ctx.font = "700 24px Arial";
  ctx.fillText("Intervention Trend", 80, 565);

  const byDate = rows.reduce((acc, row) => {
    acc[row.date] = (acc[row.date] || 0) + row.intervention;
    return acc;
  }, {});
  const values = Object.entries(byDate);
  const max = Math.max(...values.map(([, value]) => value), 1);
  const chartX = 90;
  const chartY = 810;
  const barGap = 12;
  const barWidth = values.length ? Math.min(46, Math.max(18, (730 - values.length * barGap) / values.length)) : 24;
  values.forEach(([date, value], index) => {
    const height = (value / max) * 200;
    const x = chartX + index * (barWidth + barGap);
    const y = chartY - height;
    ctx.fillStyle = "#2563eb";
    ctx.fillRect(x, y, barWidth, height);
    ctx.fillStyle = "#657184";
    ctx.font = "14px Arial";
    ctx.fillText(date.slice(-2), x + 4, chartY + 24);
    ctx.fillStyle = "#18212f";
    ctx.fillText(String(value), x + 2, y - 8);
  });

  ctx.fillStyle = "#ffffff";
  ctx.strokeStyle = "#dce3ea";
  ctx.beginPath();
  ctx.roundRect(910, 520, 440, 340, 8);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = "#18212f";
  ctx.font = "700 24px Arial";
  ctx.fillText("Payer Split", 940, 565);
  const payerItems = [
    ["General", totals.general, "#2563eb"],
    ["KASP", totals.kasp, "#0f9f8f"],
    ["MEDISEP", totals.medisep, "#7c3aed"]
  ];
  const payerSum = totals.general + totals.kasp + totals.medisep || 1;
  payerItems.forEach(([label, value, color], index) => {
    const y = 620 + index * 70;
    ctx.fillStyle = "#18212f";
    ctx.font = "700 18px Arial";
    ctx.fillText(label, 940, y);
    ctx.fillStyle = "#e8edf3";
    ctx.fillRect(1040, y - 18, 230, 22);
    ctx.fillStyle = color;
    ctx.fillRect(1040, y - 18, Math.round((value / payerSum) * 230), 22);
    ctx.fillStyle = "#18212f";
    ctx.fillText(String(value), 1290, y);
  });

  ctx.fillStyle = "#657184";
  ctx.font = "18px Arial";
  ctx.fillText(`Generated from filtered report data. Average interventions/day: ${forecast.average.toFixed(1)}. Projected achievement: ${forecast.projectedAchievement}%.`, 50, 940);

  const mime = format === "jpg" ? "image/jpeg" : "image/png";
  const extension = format === "jpg" ? "jpg" : "png";
  const link = document.createElement("a");
  link.href = canvas.toDataURL(mime, 0.92);
  link.download = `kh-report-${range.fromDate}-to-${range.toDate}.${extension}`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  showToast(`${extension.toUpperCase()} report downloaded`);
}

function downloadSelectedMonthReport() {
  refreshCenterRollups(reportDate);
  renderConsolidated();
  const month = selectedMonthLabel();
  const csv = [
    `KH Operations Report - ${month}`,
    `Report Till,${displayDate(reportDate)}`,
    "",
    tableToCsv("Procedure Consolidated", "consolidatedTable"),
    "",
    tableToCsv("OP & Diagnostics Consolidated", "opsConsolidatedTable")
  ].join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `kh-operations-${document.getElementById("monthSelect").value}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  showToast(`${month} report downloaded`);
}

async function login() {
  const error = document.getElementById("loginError");

  // Brute-force check
  const wait = lockoutSecondsLeft();
  if (wait > 0) {
    error.textContent = `Too many failed attempts. Try again in ${wait}s.`;
    return;
  }

  const passwordRaw = document.getElementById("loginPassword").value;
  if (!passwordRaw) {
    error.textContent = "Please enter a password.";
    return;
  }
  const passwordHash = await sha256(passwordRaw);
  const centreIndex = Number(document.getElementById("loginCentre").value);
  error.textContent = "";

  // ── Super Admin ──
  if (loginType === "superadmin") {
    const superHash = CONFIG.superAdminPasswordHash || await sha256("superadmin123");
    if (passwordHash !== superHash) {
      recordFailedAttempt();
      const remaining = lockoutSecondsLeft();
      error.textContent = remaining > 0
        ? `Too many failed attempts. Locked for ${remaining}s.`
        : "Invalid super admin password.";
      return;
    }
    resetAttempts();
    saveSession("superadmin", -1, -1);
    document.getElementById("loginScreen").classList.add("hidden");
    document.getElementById("appShell").classList.remove("hidden");
    setRole("superadmin");
    return;
  }

  // ── Admin (by username + password) ──
  if (loginType === "admin") {
    const adminUsername = document.getElementById("loginAdminUsername")?.value?.trim() || "";

    // First check if it's a named admin account
    const matchedAdminIdx = admins.findIndex(a => a.username === adminUsername);
    if (matchedAdminIdx >= 0) {
      const admin = admins[matchedAdminIdx];
      const storedHash = admin.passwordHash || await sha256(admin.password || "");
      if (passwordHash !== storedHash) {
        recordFailedAttempt();
        const remaining = lockoutSecondsLeft();
        error.textContent = remaining > 0
          ? `Too many failed attempts. Locked for ${remaining}s.`
          : "Invalid admin password.";
        return;
      }
      resetAttempts();
      saveSession("admin", -1, matchedAdminIdx);
      document.getElementById("loginScreen").classList.add("hidden");
      document.getElementById("appShell").classList.remove("hidden");
      setRole("admin", -1, matchedAdminIdx);
      return;
    }

    // Legacy: single admin password from CONFIG (no username match needed)
    const adminHash = CONFIG.adminPasswordHash || await sha256("admin123");
    if (passwordHash !== adminHash) {
      recordFailedAttempt();
      const remaining = lockoutSecondsLeft();
      error.textContent = remaining > 0
        ? `Too many failed attempts. Locked for ${remaining}s.`
        : "Invalid admin credentials.";
      return;
    }
    resetAttempts();
    saveSession("admin", -1, -1);
    document.getElementById("loginScreen").classList.add("hidden");
    document.getElementById("appShell").classList.remove("hidden");
    setRole("admin", -1, -1);
    return;
  }

  // ── Centre login ──
  const centre = centers[centreIndex];
  const storedCredential = centre.passwordHash || await sha256(centre.password || "");
  if (passwordHash !== storedCredential) {
    recordFailedAttempt();
    const remaining = lockoutSecondsLeft();
    error.textContent = remaining > 0
      ? `Too many failed attempts. Locked for ${remaining}s.`
      : "Invalid centre password.";
    return;
  }
  resetAttempts();
  saveSession("centre", centreIndex);
  document.getElementById("loginScreen").classList.add("hidden");
  document.getElementById("appShell").classList.remove("hidden");
  setRole("centre", centreIndex);
}

function logout() {
  clearSession();
  document.getElementById("appShell").classList.add("hidden");
  document.getElementById("loginScreen").classList.remove("hidden");
  document.getElementById("loginPassword").value = "";
  document.getElementById("loginError").textContent = "";
}

function showToast(message) {
  const toast = document.getElementById("toast");
  toast.textContent = message;
  toast.classList.add("show");
  setTimeout(() => toast.classList.remove("show"), 1800);
}

// ─── Audit Log UI ────────────────────────────────────────────────────────────

function renderAuditLog() {
  const container = document.getElementById("auditLogList");
  if (!container) return;

  // Read filter values
  const filterCentre = document.getElementById("auditFilterCentre")?.value || "all";
  const filterType   = document.getElementById("auditFilterType")?.value   || "all";
  const filterFrom   = document.getElementById("auditFilterFrom")?.value   || "";
  const filterTo     = document.getElementById("auditFilterTo")?.value     || "";

  const assigned = getAssignedCentreIndexes();
  let logs = [...auditLog].reverse().filter(l => assigned.includes(l.centreIndex) || l.centreIndex === -1); // newest first

  if (filterCentre !== "all") logs = logs.filter(l => l.centreIndex === Number(filterCentre));
  if (filterType   !== "all") logs = logs.filter(l => l.type === filterType);
  if (filterFrom)             logs = logs.filter(l => l.date >= filterFrom);
  if (filterTo)               logs = logs.filter(l => l.date <= filterTo);

  if (logs.length === 0) {
    container.innerHTML = `<p style="color:var(--muted);padding:16px 0">No audit entries match the current filter.</p>`;
    return;
  }

  const typeBadge = (type) => {
    const map = {
      "normal":        ["audit-badge-normal",   "Normal Save"],
      "unlocked-edit": ["audit-badge-unlock",   "Unlocked Edit"],
      "revert":        ["audit-badge-revert",   "Revert"]
    };
    const [cls, label] = map[type] || ["audit-badge-normal", type];
    return `<span class="audit-badge ${cls}">${label}</span>`;
  };

  function diffSummary(before, after) {
    const changes = [];

    // OP diff
    const allOp = new Set([...Object.keys(before.op || {}), ...Object.keys(after.op || {})]);
    allOp.forEach(k => {
      const b = before.op?.[k] ?? 0;
      const a = after.op?.[k]  ?? 0;
      if (b !== a) changes.push({ section: "OP", field: k, before: b, after: a });
    });

    // Referrals diff
    const allRef = new Set([...Object.keys(before.referrals || {}), ...Object.keys(after.referrals || {})]);
    allRef.forEach(k => {
      const b = before.referrals?.[k] ?? 0;
      const a = after.referrals?.[k]  ?? 0;
      if (b !== a) changes.push({ section: "Referral", field: k, before: b, after: a });
    });

    // Procedures diff
    const allProc = new Set([...Object.keys(before.procedures || {}), ...Object.keys(after.procedures || {})]);
    allProc.forEach(proc => {
      ["general", "kasp", "medisep"].forEach(payer => {
        const b = before.procedures?.[proc]?.[payer] ?? 0;
        const a = after.procedures?.[proc]?.[payer]  ?? 0;
        if (b !== a) changes.push({ section: proc, field: payer, before: b, after: a });
      });
    });

    return changes;
  }

  container.innerHTML = logs.map(log => {
    const changes = diffSummary(log.before || {}, log.after || {});
    const hasChanges = changes.length > 0;

    const diffRows = hasChanges
      ? changes.map(c => `
          <tr>
            <td>${escapeHtml(c.section)}</td>
            <td>${escapeHtml(c.field)}</td>
            <td class="audit-diff-before">${c.before}</td>
            <td class="audit-diff-after">${c.after}</td>
            <td class="${c.after > c.before ? "audit-up" : "audit-down"}">${c.after > c.before ? "▲" : "▼"} ${Math.abs(c.after - c.before)}</td>
          </tr>`).join("")
      : `<tr><td colspan="5" style="color:var(--muted);font-style:italic">No field changes detected (same values re-saved)</td></tr>`;

    const canRevert = log.type !== "revert" && hasChanges;

    return `
      <div class="audit-card" data-audit-id="${log.id}">
        <div class="audit-card-head">
          <div class="audit-card-title">
            <strong>${escapeHtml(log.centreName)}</strong>
            <span class="audit-date-tag">${displayDate(log.date)}</span>
            ${typeBadge(log.type)}
          </div>
          <div class="audit-card-meta">
            <span>${formatSavedAt(log.savedAt)}</span>
            <span>by <strong>${escapeHtml(log.savedBy)}</strong></span>
            ${canRevert
              ? `<button class="button secondary audit-revert-btn" data-revert-id="${log.id}">Revert</button>`
              : ""}
          </div>
        </div>
        <details class="audit-diff">
          <summary>${hasChanges ? `${changes.length} field${changes.length > 1 ? "s" : ""} changed` : "No changes"}</summary>
          <div class="audit-diff-wrap">
            <table class="audit-diff-table">
              <thead>
                <tr><th>Section</th><th>Field</th><th>Before</th><th>After</th><th>Δ</th></tr>
              </thead>
              <tbody>${diffRows}</tbody>
            </table>
          </div>
        </details>
      </div>`;
  }).join("");

  // Bind revert buttons
  container.querySelectorAll(".audit-revert-btn").forEach(btn => {
    btn.addEventListener("click", () => revertAuditEntry(Number(btn.dataset.revertId)));
  });
}

function setupAuditFilters() {
  const ids = ["auditFilterCentre", "auditFilterType", "auditFilterFrom", "auditFilterTo"];
  ids.forEach(id => {
    document.getElementById(id)?.addEventListener("change", renderAuditLog);
  });
  document.getElementById("auditClearFilter")?.addEventListener("click", () => {
    document.getElementById("auditFilterCentre").value = "all";
    document.getElementById("auditFilterType").value   = "all";
    document.getElementById("auditFilterFrom").value   = "";
    document.getElementById("auditFilterTo").value     = "";
    renderAuditLog();
  });
}



function openUnlockModal(date) {
  document.getElementById("unlockModalDate").textContent = displayDate(date);
  document.getElementById("unlockReason").value = "";
  document.getElementById("unlockModal").classList.remove("hidden");
  document.getElementById("unlockReason").focus();
}

function closeUnlockModal() {
  document.getElementById("unlockModal").classList.add("hidden");
}

function submitUnlockRequest() {
  const reason = document.getElementById("unlockReason").value.trim();
  if (!reason) {
    showToast("Please enter a reason for the request.");
    return;
  }
  const date = getSelectedEntryDate();
  // Prevent duplicate pending request
  if (getPendingUnlock(loggedInCentreIndex, date)) {
    showToast("A request for this date is already pending.");
    closeUnlockModal();
    return;
  }
  const newReq = {
    id: Date.now(),
    centreIndex: loggedInCentreIndex,
    centreName: centers[loggedInCentreIndex].name,
    date,
    reason,
    status: "pending",
    requestedAt: new Date().toISOString(),
    resolvedAt: null
  };
  unlockRequests.push(newReq);
  saveLocalBackup();
  if (supabaseClient) saveOneUnlockRequest(newReq).catch(console.error);
  closeUnlockModal();
  renderEntryForCurrentDate();
  showToast("Unlock request sent to admin.");
}

// ─── Admin unlock panel ──────────────────────────────────────────────────────

function renderUnlockRequests() {
  const container = document.getElementById("unlockRequestList");
  if (!container) return;
  container.innerHTML = "";
  
  // Mark any approved requests that have since expired
  let dirty = false;
  unlockRequests.forEach(r => {
    if (r.status === "approved" && isUnlockExpired(r)) {
      r.status = "expired";
      dirty = true;
    }
  });
  if (dirty) persistSoon();

  const assigned = getAssignedCentreIndexes();
  const visibleRequests = unlockRequests.filter(r => assigned.includes(r.centreIndex));
  const pending  = visibleRequests.filter(r => r.status === "pending");
  const resolved = visibleRequests.filter(r => r.status !== "pending").slice(-20).reverse();

  // Update nav badge — count pending only
  const badge = document.getElementById("unlockNavBadge");
  if (badge) {
    badge.textContent = pending.length || "";
    badge.classList.toggle("hidden", pending.length === 0);
  }

  if (pending.length === 0 && resolved.length === 0) {
    container.innerHTML = `<p style="color:var(--muted);padding:16px 0">No unlock requests yet.</p>`;
    return;
  }

  const statusBadgeHtml = (req) => {
    const map = {
      pending:  ["pending",  "Pending"],
      approved: ["approved", "Approved"],
      rejected: ["rejected", "Rejected"],
      expired:  ["expired",  "Expired"]
    };
    const [cls, label] = map[req.status] || ["rejected", req.status];
    return `<span class="unlock-badge ${cls}">${label}</span>`;
  };

  const renderCard = (req) => {
    const isPending = req.status === "pending";
    const isApproved = req.status === "approved";

    const expiryLine = isApproved && req.expiresAt
      ? `<small style="color:var(--muted)">Expires: ${formatSavedAt(req.expiresAt)} (${formatTimeRemaining(req.expiresAt)})</small>`
      : req.resolvedAt
        ? `<small style="color:var(--muted)">${formatSavedAt(req.resolvedAt)}</small>`
        : "";

    const actions = isPending ? `
      <div class="unlock-actions">
        <div class="duration-picker">
          <span>Access for</span>
          <button type="button" class="dur-btn" data-mins="30">30 min</button>
          <button type="button" class="dur-btn" data-mins="60">1 h</button>
          <button type="button" class="dur-btn" data-mins="240">4 h</button>
        </div>
        <button class="button secondary" data-reject="${req.id}">Reject</button>
      </div>` : expiryLine;

    return `
      <div class="unlock-card ${req.status}" data-req-id="${req.id}">
        <div class="unlock-card-head">
          <div>
            <strong>${req.centreName}</strong>
            <span>${displayDate(req.date)}</span>
          </div>
          ${statusBadgeHtml(req)}
        </div>
        <p class="unlock-reason">"${escapeHtml(req.reason)}"</p>
        <div class="unlock-meta">
          <small>Requested: ${formatSavedAt(req.requestedAt)}</small>
          ${actions}
        </div>
      </div>`;
  };

  container.innerHTML = `
    ${pending.length  ? `<h3 style="margin-bottom:10px">Pending (${pending.length})</h3>`       + pending.map(renderCard).join("")  : ""}
    ${resolved.length ? `<h3 style="margin:16px 0 10px">Recent resolved</h3>` + resolved.map(renderCard).join("") : ""}
  `;

  // Duration buttons — approve with chosen window
  container.querySelectorAll(".dur-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const card = btn.closest("[data-req-id]");
      const id = Number(card.dataset.reqId);
      const mins = Number(btn.dataset.mins);
      // Highlight selected
      card.querySelectorAll(".dur-btn").forEach(b => b.classList.remove("dur-selected"));
      btn.classList.add("dur-selected");
      resolveUnlock(id, "approved", mins);
    });
  });

  container.querySelectorAll("[data-reject]").forEach(btn => {
    btn.addEventListener("click", () => resolveUnlock(Number(btn.dataset.reject), "rejected", 0));
  });
}

function resolveUnlock(id, status, durationMins = 0) {
  const req = unlockRequests.find(r => r.id === id);
  if (!req) return;
  req.status = status;
  req.resolvedAt = new Date().toISOString();
  if (status === "approved" && durationMins > 0) {
    req.expiresAt = new Date(Date.now() + durationMins * 60 * 1000).toISOString();
  }
  // Log admin action
  const durationLabel = durationMins >= 60 ? durationMins / 60 + "h" : durationMins + "min";
  writeAdminAuditLog(
    status === "approved" ? "approve_unlock" : "reject_unlock",
    status === "approved"
      ? `Approved unlock for ${req.centreName} / ${displayDate(req.date)} (${durationLabel}). Reason: "${req.reason}"`
      : `Rejected unlock for ${req.centreName} / ${displayDate(req.date)}. Reason: "${req.reason}"`,
    [req.centreIndex]
  );
  saveLocalBackup();
  if (supabaseClient) saveOneUnlockRequest(req).catch(console.error);
  renderUnlockRequests();
  const label = status === "approved"
    ? `Approved for ${durationMins >= 60 ? durationMins / 60 + "h" : durationMins + "min"} - ${req.centreName} / ${displayDate(req.date)}`
    : `Rejected - ${req.centreName} / ${displayDate(req.date)}`;
  showToast(label);
}



async function migrateLegacyPasswords() {
  let changed = false;
  for (const center of centers) {
    if (center.password && !center.passwordHash) {
      center.passwordHash = await sha256(center.password);
      delete center.password;
      changed = true;
    }
  }
  if (changed) persistSoon();
}

// ================= BACKUP SYSTEM =================

// ─── Export to local file ─────────────────────────────────────────────────────

function exportToFile() {
  const backup = {
    exportedAt:        new Date().toISOString(),
    exportedBy:        currentRole === "admin" ? "Admin" : (centers[loggedInCentreIndex]?.name || "unknown"),
    appVersion:        "KHOPS_v2",
    centers,
    procedureSettings,
    swiztonEntries,
    swiztonConsolidatedMapping,
    entries,
    entryMeta,
    unlockRequests,
    auditLog
  };
  const date = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  downloadBlob(JSON.stringify(backup, null, 2), `kh-backup-${date}.json`, "application/json");
  showToast("Backup file downloaded");
}

// Download a specific Supabase backup entry as a local file
async function downloadBackupFromSupabase(backupId) {
  if (!supabaseClient) { showToast("No database connection"); return; }
  showToast("Preparing backup download");
  const { data, error } = await supabaseClient
    .from("app_backups")
    .select("backup_data, created_at")
    .eq("id", backupId)
    .single();

  if (error || !data) { showToast("Could not fetch the backup"); return; }

  const date = new Date(data.created_at).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  const payload = {
    exportedAt:  data.created_at,
    exportedBy:  "Supabase backup",
    appVersion:  "KHOPS_v2",
    ...data.backup_data
  };
  downloadBlob(JSON.stringify(payload, null, 2), `kh-backup-supabase-${date}.json`, "application/json");
  showToast("Backup file downloaded");
}

// ─── Import from local file ───────────────────────────────────────────────────

function triggerImport() {
  document.getElementById("importFileInput").click();
}

async function handleImportFile(event) {
  const file = event.target.files[0];
  if (!file) return;
  event.target.value = ""; // allow re-selecting same file

  // Parse JSON
  let backup;
  try {
    backup = JSON.parse(await file.text());
  } catch {
    setImportStatus("error", "Could not read the file. Make sure you selected a valid KH backup JSON file.");
    return;
  }

  // Validate
  if (!backup.centers || !backup.entries || !backup.procedureSettings) {
    setImportStatus("error", "This file does not appear to be a KH backup. Required fields are missing.");
    return;
  }

  const centreCount = backup.centers.length;
  const entryCount  = Object.values(backup.entries).reduce((n, c) => n + Object.keys(c).length, 0);
  const auditCount  = (backup.auditLog || []).length;
  const exportedAt  = backup.exportedAt ? formatSavedAt(backup.exportedAt) : "unknown date";

  const confirmed = window.confirm(
    `Import this backup?\n\n` +
    `Exported:      ${exportedAt}\n` +
    `Centres:       ${centreCount}\n` +
    `Daily entries: ${entryCount}\n` +
    `Audit records: ${auditCount}\n\n` +
    `Warning: this will overwrite all current data in the app and database.\n` +
    `This cannot be undone. Proceed?`
  );
  if (!confirmed) return;

  setImportStatus("loading", "Restoring backup. Please wait and keep this tab open.");

  try {
    // Apply to memory
    centers           = backup.centers;
    procedureSettings = backup.procedureSettings;
    Object.keys(entries).forEach(k => delete entries[k]);
    Object.assign(entries, backup.entries || {});
    Object.keys(entryMeta).forEach(k => delete entryMeta[k]);
    Object.assign(entryMeta, backup.entryMeta || {});
    unlockRequests = backup.unlockRequests || [];
    auditLog       = backup.auditLog       || [];

    // Record the restore event in audit log
    auditLog.push({
      id:          Date.now(),
      centreIndex: -1,
      centreName:  "System",
      date:        new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }),
      savedAt:     new Date().toISOString(),
      savedBy:     "Admin (file restore)",
      type:        "revert",
      before:      {},
      after:       { note: `Restored from local backup file exported ${exportedAt}` }
    });

    // Push to Supabase
    if (supabaseClient) {
      await Promise.all([
        saveConfig(),
        saveAllEntries(),
        saveAllMeta(),
        saveAllUnlockRequests(),
        saveAllAuditLog()
      ]);
    }
    saveLocalBackup();

    // Re-render entire app
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
    setReportDate(today);
    refreshCenterRollups(reportDate);
    refreshCenterLists();
    renderConsolidated();
    renderBars();
    renderPayerSplit();
    renderTargets();
    renderUsers();
    renderProcedures();
    renderUnlockRequests();
    renderAuditLog();
    renderEntryForCurrentDate();
    renderAdminReportPreview();
    renderBackups();

    setImportStatus("success",
      `Restore complete. ${centreCount} centres, ${entryCount} daily entries, and ${auditCount} audit records were loaded successfully.`
    );
    showToast("Backup restored from file");

  } catch (err) {
    console.error("Import failed:", err);
    setImportStatus("error", `Restore failed: ${err.message || "unknown error"}. Your previous data is still safe.`);
  }
}

function setImportStatus(type, message) {
  const el = document.getElementById("importStatus");
  if (!el) return;
  const s = {
    success: { bg: "#e6f7ee", border: "#a8d5b0", color: "#1b7f4b" },
    error:   { bg: "#fff0f1", border: "#f5c6cb", color: "#b30000" },
    loading: { bg: "#eff4ff", border: "#bfcfff", color: "#1e3a6e" }
  }[type] || {};
  el.innerHTML = `<div style="background:${s.bg};border:1px solid ${s.border};color:${s.color};
    padding:12px 16px;border-radius:8px;font-weight:600;font-size:.875rem;margin-top:16px">
    ${message}</div>`;
}

function renderCompanyTabs() {
  const container = document.getElementById("companyTabs");
  if (!container) return;
  container.classList.toggle("hidden", currentRole === "centre");
  container.querySelectorAll(".company-tab").forEach((button) => {
    button.classList.toggle("active", button.dataset.company === activeCompany);
  });
  updateCompanyNavigation();
}

function updateCompanyNavigation() {
  const hideForSwizton = activeCompany === "Swizton" && currentRole !== "centre";
  ["targets", "procedures", "users", "unlock"].forEach((view) => {
    document.querySelector(`.nav-item[data-view="${view}"]`)?.classList.toggle("hidden", hideForSwizton);
  });
}

function setActiveCompany(company) {
  activeCompany = company;
  renderCompanyTabs();
  if (company === "Swizton") {
    const activeView = document.querySelector(".view.active")?.id?.replace("View", "");
    if (["targets", "procedures", "users", "unlock", "centre"].includes(activeView)) showView("admin");
  }
  refreshCenterLists();
  renderProcedures();
  renderConsolidated();
  renderBars();
  renderPayerSplit();
  renderAdminReportPreview();
  renderTargets();
  renderUsers();
  if (currentRole === "superadmin") renderAdminList();
}

function setupCompanyTabs() {
  document.querySelectorAll(".company-tab").forEach((button) => {
    button.addEventListener("click", () => setActiveCompany(button.dataset.company));
  });
}

function backupStateMarkup(type, title, message) {
  return `
    <div class="backup-state ${type}">
      <strong>${escapeHtml(title)}</strong>
      <div>${message}</div>
    </div>
  `;
}

function setBackupStatus(type, title, message = "") {
  const el = document.getElementById("backupStatus");
  if (!el) return;
  el.className = `backup-feedback ${type}`;
  el.innerHTML = `
    <strong>${escapeHtml(title)}</strong>
    ${message ? `<div>${message}</div>` : ""}
  `;
}

function setPanelState(elementId, type, title, message) {
  const el = document.getElementById(elementId);
  if (!el) return;
  el.innerHTML = backupStateMarkup(type, title, message);
}


async function createBackup() {
  if (!supabaseClient) return;
  setBackupStatus("loading", "Creating backup", "Saving the current live state to Supabase.");

  const data = getAppState();

  try {
    const createdBy = getCurrentActorLabel();
    await supabaseClient
  .from("app_backups")
  .insert({
    backup_data: data,
    version: "1.0",
    app_version: "KHOPS_v1",
    created_by: createdBy,
    created_at: new Date().toISOString()  
  });

    console.log("Backup created");

    setBackupStatus(
      "success",
      "Backup created",
      `Last backup saved ${new Date().toLocaleString()} by ${escapeHtml(createdBy)}.`
    );

  } catch (err) {
    console.error("Backup failed", err);
    setBackupStatus("error", "Backup failed", "Supabase could not save the snapshot right now.");
  }
}

// Cleanup old backups (90 days)
async function cleanupBackups() {
  if (!supabaseClient) return;

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 90);

  try {
    await supabaseClient
      .from("app_backups")
      .delete()
      .lt("created_at", cutoff.toISOString());

    console.log("Old backups cleaned");
  } catch (err) {
    console.error("Cleanup failed", err);
  }
}

// Load backups list
async function loadBackups() {
  const { data, error } = await supabaseClient
    .from("app_backups")
    .select("id, created_at, created_by")
    .order("created_at", { ascending: false })
    .limit(30);

  if (error) {
    throw error;
  }

  return data;
}

async function deleteBackup(backupId) {
  if (!supabaseClient) {
    showToast("No database connection");
    return;
  }

  const ok = window.confirm(
    `Delete backup #${backupId}?\n\nThis removes only the saved backup snapshot. It will not change the current live app data.`
  );
  if (!ok) return;

  setBackupStatus("loading", `Deleting backup #${backupId}`, "Removing the selected cloud snapshot.");

  const { error } = await supabaseClient
    .from("app_backups")
    .delete()
    .eq("id", backupId);

  if (error) {
    console.error(error);
    setBackupStatus("error", `Delete failed for backup #${backupId}`, "The backup could not be removed from Supabase.");
    showToast("Could not delete backup");
    return;
  }

  if (partialRestoreContext?.backupId === backupId) clearPartialRestore();
  const compareHtml = document.getElementById("backupComparePreview")?.innerHTML || "";
  const restoreHtml = document.getElementById("restorePreviewPanel")?.innerHTML || "";
  if (compareHtml.includes(`Backup #${backupId}`)) clearBackupComparison();
  if (restoreHtml.includes(`Backup #${backupId}`)) clearRestorePreview();

  setBackupStatus("success", `Deleted backup #${backupId}`, "The cloud snapshot was removed. Live app data is unchanged.");

  await renderBackups();
  showToast(`Deleted backup #${backupId}`);
}

function countDailyEntries(state) {
  return Object.values(state?.entries || {}).reduce((count, centreEntries) => {
    return count + Object.keys(centreEntries || {}).length;
  }, 0);
}

function countAuditEntries(state) {
  return Array.isArray(state?.auditLog) ? state.auditLog.length : 0;
}

function countAdmins(state) {
  return Array.isArray(state?.admins) ? state.admins.length : 0;
}

function stableStringify(value) {
  if (value === null || value === undefined) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function centreStateSummary(state, centreName) {
  const centreIndex = (state?.centers || []).findIndex((centre) => centre?.name === centreName);
  if (centreIndex === -1) return null;

  const centre = state.centers?.[centreIndex] || {};
  const centreEntries = state?.entries?.[centreIndex] || {};
  const dates = Object.keys(centreEntries).sort();

  let interventionTotal = 0;
  let cagTotal = 0;
  let opTotal = 0;
  let ipTotal = 0;

  dates.forEach((date) => {
    const entry = centreEntries[date] || emptyEntry();
    interventionTotal += entryInterventionTotal(entry);
    cagTotal += entryCagTotal(entry);
    opTotal += currencySafeNumber((entry.op || {})["Total OP"]);
    ipTotal += currencySafeNumber((entry.op || {}).IP);
  });

  return {
    name: centreName,
    target: currencySafeNumber(centre.target),
    username: centre.username || "",
    datesCount: dates.length,
    latestDate: dates[dates.length - 1] || "-",
    interventionTotal,
    cagTotal,
    opTotal,
    ipTotal,
    entryMeta: state?.entryMeta?.[centreIndex] || {}
  };
}

function formatCentreSummary(summary) {
  if (!summary) return "Missing";
  return `Target ${summary.target} | Dates ${summary.datesCount} | Intv ${summary.interventionTotal} | CAG ${summary.cagTotal} | OP ${summary.opTotal} | IP ${summary.ipTotal} | Last ${summary.latestDate}`;
}

function buildCentreDiffText(currentSummary, backupSummary) {
  if (!currentSummary && backupSummary) return "Missing in current app";
  if (currentSummary && !backupSummary) return "Missing in backup";
  if (!currentSummary && !backupSummary) return "No data";

  const diffs = [];
  const fields = [
    ["target", "Target"],
    ["datesCount", "Saved dates"],
    ["interventionTotal", "Intervention"],
    ["cagTotal", "CAG"],
    ["opTotal", "OP"],
    ["ipTotal", "IP"]
  ];

  fields.forEach(([key, label]) => {
    if (currentSummary[key] !== backupSummary[key]) {
      diffs.push(`${label}: ${backupSummary[key]} -> ${currentSummary[key]}`);
    }
  });

  if (currentSummary.latestDate !== backupSummary.latestDate) {
    diffs.push(`Last date: ${backupSummary.latestDate} -> ${currentSummary.latestDate}`);
  }

  return diffs.length ? diffs.join(" | ") : "No field change";
}

function buildCentreComparisonRows(currentState, backupState) {
  const currentNames = (currentState?.centers || []).map((centre) => centre?.name).filter(Boolean);
  const backupNames = (backupState?.centers || []).map((centre) => centre?.name).filter(Boolean);
  const keys = [...new Set([...currentNames, ...backupNames])].sort();
  return keys.map((key) => {
    const currentSummary = centreStateSummary(currentState, key);
    const backupSummary = centreStateSummary(backupState, key);
    const currentSignature = currentSummary ? stableStringify(currentSummary) : null;
    const backupSignature = backupSummary ? stableStringify(backupSummary) : null;
    return {
      key,
      current: !!currentSummary,
      backup: !!backupSummary,
      changed: currentSignature !== backupSignature,
      currentText: formatCentreSummary(currentSummary),
      backupText: formatCentreSummary(backupSummary),
      diffText: buildCentreDiffText(currentSummary, backupSummary)
    };
  });
}

function procedureStateSummary(state, procedureName) {
  const procedureExists = (state?.procedureSettings || []).some((procedure) => procedure?.name === procedureName);
  if (!procedureExists) return null;

  let general = 0;
  let kasp = 0;
  let medisep = 0;
  let datesCount = 0;

  Object.values(state?.entries || {}).forEach((centreEntries) => {
    Object.values(centreEntries || {}).forEach((entry) => {
      const procedureEntry = entry?.procedures?.[procedureName];
      if (!procedureEntry) return;
      const rowGeneral = currencySafeNumber(procedureEntry.general);
      const rowKasp = currencySafeNumber(procedureEntry.kasp);
      const rowMedisep = currencySafeNumber(procedureEntry.medisep);
      if (rowGeneral || rowKasp || rowMedisep) {
        datesCount += 1;
      }
      general += rowGeneral;
      kasp += rowKasp;
      medisep += rowMedisep;
    });
  });

  const setting = (state?.procedureSettings || []).find((procedure) => procedure?.name === procedureName) || {};
  return {
    name: procedureName,
    counted: !!setting.counted,
    isCag: !!setting.isCag,
    active: !!setting.active,
    general,
    kasp,
    medisep,
    total: general + kasp + medisep,
    datesCount
  };
}

function formatProcedureSummary(summary) {
  if (!summary) return "Missing";
  return `Total ${summary.total} | General ${summary.general} | KASP ${summary.kasp} | Medisep ${summary.medisep} | Dates ${summary.datesCount}`;
}

function buildProcedureDiffText(currentSummary, backupSummary) {
  if (!currentSummary && backupSummary) return "Missing in current app";
  if (currentSummary && !backupSummary) return "Missing in backup";
  if (!currentSummary && !backupSummary) return "No data";

  const diffs = [];
  const fields = [
    ["total", "Total"],
    ["general", "General"],
    ["kasp", "KASP"],
    ["medisep", "Medisep"],
    ["datesCount", "Saved dates"]
  ];

  fields.forEach(([key, label]) => {
    if (currentSummary[key] !== backupSummary[key]) {
      diffs.push(`${label}: ${backupSummary[key]} -> ${currentSummary[key]}`);
    }
  });

  if (currentSummary.counted !== backupSummary.counted) {
    diffs.push(`Counted: ${backupSummary.counted ? "Yes" : "No"} -> ${currentSummary.counted ? "Yes" : "No"}`);
  }
  if (currentSummary.isCag !== backupSummary.isCag) {
    diffs.push(`CAG type: ${backupSummary.isCag ? "Yes" : "No"} -> ${currentSummary.isCag ? "Yes" : "No"}`);
  }
  if (currentSummary.active !== backupSummary.active) {
    diffs.push(`Active: ${backupSummary.active ? "Yes" : "No"} -> ${currentSummary.active ? "Yes" : "No"}`);
  }

  return diffs.length ? diffs.join(" | ") : "No field change";
}

function buildProcedureComparisonRows(currentState, backupState) {
  const currentNames = (currentState?.procedureSettings || []).map((procedure) => procedure?.name).filter(Boolean);
  const backupNames = (backupState?.procedureSettings || []).map((procedure) => procedure?.name).filter(Boolean);
  const keys = [...new Set([...currentNames, ...backupNames])].sort();
  return keys.map((key) => {
    const currentSummary = procedureStateSummary(currentState, key);
    const backupSummary = procedureStateSummary(backupState, key);
    const currentSignature = currentSummary ? stableStringify(currentSummary) : null;
    const backupSignature = backupSummary ? stableStringify(backupSummary) : null;
    return {
      key,
      current: !!currentSummary,
      backup: !!backupSummary,
      changed: currentSignature !== backupSignature,
      currentText: formatProcedureSummary(currentSummary),
      backupText: formatProcedureSummary(backupSummary),
      diffText: buildProcedureDiffText(currentSummary, backupSummary)
    };
  });
}

function buildComparisonRows(currentList, backupList, keyField = "name", projector = (item) => item) {
  const currentMap = new Map((currentList || []).map((item) => [item?.[keyField], item]));
  const backupMap = new Map((backupList || []).map((item) => [item?.[keyField], item]));
  const keys = [...new Set([...currentMap.keys(), ...backupMap.keys()])].filter(Boolean).sort();
  return keys.map((key) => ({
    key,
    current: currentMap.has(key),
    backup: backupMap.has(key),
    changed: stableStringify(projector(currentMap.get(key))) !== stableStringify(projector(backupMap.get(key))),
    currentText: currentMap.has(key) ? "Present" : "Missing",
    backupText: backupMap.has(key) ? "Present" : "Missing"
  }));
}

function deltaClass(delta) {
  if (delta > 0) return "backup-compare-up";
  if (delta < 0) return "backup-compare-down";
  return "";
}

function deltaLabel(delta) {
  if (delta > 0) return `+${delta}`;
  if (delta < 0) return `${delta}`;
  return "No change";
}

function differenceLabel(delta) {
  if (delta > 0) return `${delta} more in backup`;
  if (delta < 0) return `${Math.abs(delta)} more in live app`;
  return "No difference";
}

function comparisonStatusLabel(row) {
  if (!row.current) return "Missing in current";
  if (!row.backup) return "Missing in backup";
  return row.changed ? "Changed" : "Same";
}

function comparisonStatusClass(row) {
  if (!row.current || !row.backup || row.changed) return "backup-compare-down";
  return "backup-compare-up";
}

function renderBackupComparison(backupMeta, backupState) {
  const currentState = getAppState();
  const preview = document.getElementById("backupComparePreview");
  if (!preview) return;

  const currentEntryCount = countDailyEntries(currentState);
  const backupEntryCount = countDailyEntries(backupState);
  const currentAuditCount = countAuditEntries(currentState);
  const backupAuditCount = countAuditEntries(backupState);
  const currentAdminCount = countAdmins(currentState);
  const backupAdminCount = countAdmins(backupState);

  const centreRows = buildCentreComparisonRows(currentState, backupState);
  const procedureRows = buildProcedureComparisonRows(currentState, backupState);
  const adminRows = buildComparisonRows(currentState.admins, backupState.admins, "username", (item) => item ? {
    name: item.name,
    username: item.username,
    assignedCentres: [...(item.assignedCentres || [])].sort()
  } : null);

  const centreSection = `
    <details class="backup-compare-section">
      <summary>Centres</summary>
      <table class="backup-compare-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Status</th>
            <th>Current</th>
            <th>Backup</th>
            <th>Difference</th>
          </tr>
        </thead>
        <tbody>
          ${
            centreRows.length
              ? centreRows.map((row) => `
                <tr>
                  <td>${escapeHtml(row.key)}</td>
                  <td class="${comparisonStatusClass(row)}">${comparisonStatusLabel(row)}</td>
                  <td>${escapeHtml(row.currentText)}</td>
                  <td>${escapeHtml(row.backupText)}</td>
                  <td>${escapeHtml(row.diffText)}</td>
                </tr>
              `).join("")
              : `<tr><td colspan="5">No centres to compare.</td></tr>`
          }
        </tbody>
      </table>
    </details>
  `;

  const procedureSection = `
    <details class="backup-compare-section">
      <summary>Procedures</summary>
      <table class="backup-compare-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Status</th>
            <th>Current</th>
            <th>Backup</th>
            <th>Difference</th>
          </tr>
        </thead>
        <tbody>
          ${
            procedureRows.length
              ? procedureRows.map((row) => `
                <tr>
                  <td>${escapeHtml(row.key)}</td>
                  <td class="${comparisonStatusClass(row)}">${comparisonStatusLabel(row)}</td>
                  <td>${escapeHtml(row.currentText)}</td>
                  <td>${escapeHtml(row.backupText)}</td>
                  <td>${escapeHtml(row.diffText)}</td>
                </tr>
              `).join("")
              : `<tr><td colspan="5">No procedures to compare.</td></tr>`
          }
        </tbody>
      </table>
    </details>
  `;

  const section = (title, rows, currentLabel, backupLabel) => `
    <details class="backup-compare-section">
      <summary>${title}</summary>
      <table class="backup-compare-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Status</th>
            <th>${currentLabel}</th>
            <th>${backupLabel}</th>
          </tr>
        </thead>
        <tbody>
          ${
            rows.length
              ? rows.map((row) => `
                <tr>
                  <td>${escapeHtml(row.key)}</td>
                  <td class="${comparisonStatusClass(row)}">${comparisonStatusLabel(row)}</td>
                  <td>${escapeHtml(row.currentText || (row.current ? "Present" : "Missing"))}</td>
                  <td>${escapeHtml(row.backupText || (row.backup ? "Present" : "Missing"))}</td>
                </tr>
              `).join("")
              : `<tr><td colspan="4">No items to compare.</td></tr>`
          }
        </tbody>
      </table>
    </details>
  `;

  preview.innerHTML = `
    <div class="backup-compare-grid">
      <div class="backup-compare-card">
        <span>Daily Entries</span>
        <strong>${backupEntryCount}</strong>
        <div class="backup-compare-delta ${deltaClass(backupEntryCount - currentEntryCount)}">
          In backup: ${backupEntryCount} | In live record: ${currentEntryCount}
        </div>
      </div>
      <div class="backup-compare-card">
        <span>Audit Records</span>
        <strong>${backupAuditCount}</strong>
        <div class="backup-compare-delta ${deltaClass(backupAuditCount - currentAuditCount)}">
          In backup: ${backupAuditCount} | In live record: ${currentAuditCount}
        </div>
      </div>
      <div class="backup-compare-card">
        <span>Admin Accounts</span>
        <strong>${backupAdminCount}</strong>
        <div class="backup-compare-delta ${deltaClass(backupAdminCount - currentAdminCount)}">
          In backup: ${backupAdminCount} | In live record: ${currentAdminCount}
        </div>
      </div>
    </div>
    <p style="margin:0 0 8px;color:var(--muted)">
      Comparing current live state against backup <strong>#${backupMeta.id}</strong> created
      ${new Date(backupMeta.created_at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}
      ${backupMeta.created_by ? `by ${escapeHtml(backupMeta.created_by)}` : ""}.
    </p>
    ${centreSection}
    ${procedureSection}
    ${section("Admin Accounts", adminRows, "Current", "Backup")}
  `;
}

async function compareBackup(backupId) {
  if (!supabaseClient) {
    showToast("No database connection");
    return;
  }
  setPanelState("backupComparePreview", "loading", "Loading comparison", "Reading the selected backup and comparing it with the current live state.");
  const { data, error } = await supabaseClient
    .from("app_backups")
    .select("id, created_at, created_by, backup_data")
    .eq("id", backupId)
    .single();

  if (error || !data) {
    setPanelState("backupComparePreview", "error", "Comparison unavailable", "The selected backup could not be loaded for comparison.");
    showToast("Could not compare the selected backup");
    return;
  }

  renderBackupComparison(data, data.backup_data || {});
  showToast(`Compared backup #${backupId}`);
}

function clearBackupComparison() {
  const preview = document.getElementById("backupComparePreview");
  if (!preview) return;
  preview.innerHTML = backupStateMarkup("empty", "No comparison selected", "Choose “Compare” on any backup to inspect before-vs-after differences.");
}

function renderRestorePreview(backupMeta, backupState) {
  const panel = document.getElementById("restorePreviewPanel");
  if (!panel) return;

  const currentState = getAppState();
  const currentEntryCount = countDailyEntries(currentState);
  const backupEntryCount = countDailyEntries(backupState);
  const currentAuditCount = countAuditEntries(currentState);
  const backupAuditCount = countAuditEntries(backupState);
  const currentAdminCount = countAdmins(currentState);
  const backupAdminCount = countAdmins(backupState);

  const centreRows = buildCentreComparisonRows(currentState, backupState);
  const procedureRows = buildProcedureComparisonRows(currentState, backupState);
  const adminRows = buildComparisonRows(currentState.admins, backupState.admins, "username", (item) => item ? {
    name: item.name,
    username: item.username,
    assignedCentres: [...(item.assignedCentres || [])].sort()
  } : null);

  const changedCentres = centreRows.filter((row) => row.changed).length;
  const changedProcedures = procedureRows.filter((row) => row.changed).length;
  const changedAdmins = adminRows.filter((row) => row.changed).length;

  const centreSection = `
    <details class="backup-compare-section">
      <summary>Centres Affected (${changedCentres})</summary>
      <table class="backup-compare-table">
        <thead><tr><th>Name</th><th>Status</th><th>Current</th><th>Backup</th><th>Difference</th></tr></thead>
        <tbody>
          ${
            centreRows.length
              ? centreRows.map((row) => `
                <tr>
                  <td>${escapeHtml(row.key)}</td>
                  <td class="${comparisonStatusClass(row)}">${comparisonStatusLabel(row)}</td>
                  <td>${escapeHtml(row.currentText)}</td>
                  <td>${escapeHtml(row.backupText)}</td>
                  <td>${escapeHtml(row.diffText)}</td>
                </tr>
              `).join("")
              : `<tr><td colspan="5">No centres to preview.</td></tr>`
          }
        </tbody>
      </table>
    </details>
  `;

  const procedureSection = `
    <details class="backup-compare-section">
      <summary>Procedures Affected (${changedProcedures})</summary>
      <table class="backup-compare-table">
        <thead><tr><th>Name</th><th>Status</th><th>Current</th><th>Backup</th><th>Difference</th></tr></thead>
        <tbody>
          ${
            procedureRows.length
              ? procedureRows.map((row) => `
                <tr>
                  <td>${escapeHtml(row.key)}</td>
                  <td class="${comparisonStatusClass(row)}">${comparisonStatusLabel(row)}</td>
                  <td>${escapeHtml(row.currentText)}</td>
                  <td>${escapeHtml(row.backupText)}</td>
                  <td>${escapeHtml(row.diffText)}</td>
                </tr>
              `).join("")
              : `<tr><td colspan="5">No procedures to preview.</td></tr>`
          }
        </tbody>
      </table>
    </details>
  `;

  const section = (title, rows) => `
    <details class="backup-compare-section">
      <summary>${title} (${rows.filter((row) => row.changed).length})</summary>
      <table class="backup-compare-table">
        <thead><tr><th>Name</th><th>Status</th><th>Current</th><th>Backup</th></tr></thead>
        <tbody>
          ${
            rows.length
              ? rows.map((row) => `
                <tr>
                  <td>${escapeHtml(row.key)}</td>
                  <td class="${comparisonStatusClass(row)}">${comparisonStatusLabel(row)}</td>
                  <td>${escapeHtml(row.currentText || (row.current ? "Present" : "Missing"))}</td>
                  <td>${escapeHtml(row.backupText || (row.backup ? "Present" : "Missing"))}</td>
                </tr>
              `).join("")
              : `<tr><td colspan="4">No items to preview.</td></tr>`
          }
        </tbody>
      </table>
    </details>
  `;

  panel.innerHTML = `
    <div class="backup-compare-grid">
      <div class="backup-compare-card">
        <span>Daily Entries To Restore</span>
        <strong>${backupEntryCount}</strong>
        <div class="backup-compare-delta ${deltaClass(backupEntryCount - currentEntryCount)}">
          In backup: ${backupEntryCount} | In live record: ${currentEntryCount}
        </div>
      </div>
      <div class="backup-compare-card">
        <span>Audit Records To Restore</span>
        <strong>${backupAuditCount}</strong>
        <div class="backup-compare-delta ${deltaClass(backupAuditCount - currentAuditCount)}">
          In backup: ${backupAuditCount} | In live record: ${currentAuditCount}
        </div>
      </div>
      <div class="backup-compare-card">
        <span>Admin Accounts To Restore</span>
        <strong>${backupAdminCount}</strong>
        <div class="backup-compare-delta ${deltaClass(backupAdminCount - currentAdminCount)}">
          In backup: ${backupAdminCount} | In live record: ${currentAdminCount}
        </div>
      </div>
    </div>
    <div class="backup-compare-card" style="margin-bottom:12px">
      <span>Restore Impact Summary</span>
      <strong>Backup #${backupMeta.id}</strong>
      <div class="backup-compare-delta">
        ${changedCentres} centre changes, ${changedProcedures} procedure changes, ${changedAdmins} admin account changes
      </div>
      <p style="margin:10px 0 0;color:var(--muted)">
        Created ${new Date(backupMeta.created_at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}
        ${backupMeta.created_by ? `by ${escapeHtml(backupMeta.created_by)}` : ""}.
        Restoring this backup will overwrite the current live state with the values shown above.
      </p>
    </div>
    ${centreSection}
    ${procedureSection}
    ${section("Admin Accounts Affected", adminRows)}
  `;
}

async function previewRestore(backupId) {
  if (!supabaseClient) {
    showToast("No database connection");
    return;
  }
  setPanelState("restorePreviewPanel", "loading", "Loading restore preview", "Calculating what this restore would overwrite.");
  const { data, error } = await supabaseClient
    .from("app_backups")
    .select("id, created_at, created_by, backup_data")
    .eq("id", backupId)
    .single();

  if (error || !data) {
    setPanelState("restorePreviewPanel", "error", "Restore preview unavailable", "The selected backup could not be loaded for preview.");
    showToast("Could not preview the restore");
    return;
  }

  renderRestorePreview(data, data.backup_data || {});
  showToast(`Restore preview ready for backup #${backupId}`);
}

function clearRestorePreview() {
  const panel = document.getElementById("restorePreviewPanel");
  if (!panel) return;
  panel.innerHTML = backupStateMarkup("empty", "No restore preview selected", "Choose “Preview Restore” on any backup to inspect what would be restored.");
}

function countCentreEntryDates(state, centreIndex) {
  const centreEntries = state?.entries?.[centreIndex];
  return centreEntries && typeof centreEntries === "object" ? Object.keys(centreEntries).length : 0;
}

function countCentreAuditRecords(state, centreIndex) {
  return Array.isArray(state?.auditLog)
    ? state.auditLog.filter((record) => Number(record.centreIndex) === Number(centreIndex)).length
    : 0;
}

function countCentreUnlockRecords(state, centreIndex) {
  return Array.isArray(state?.unlockRequests)
    ? state.unlockRequests.filter((record) => Number(record.centreIndex) === Number(centreIndex)).length
    : 0;
}

function clearPartialRestore() {
  partialRestoreContext = null;
  const panel = document.getElementById("partialRestorePanel");
  if (!panel) return;
  panel.innerHTML = backupStateMarkup("empty", "No centre restore selected", "Choose “Partial Restore” on any backup to load a single-centre restore option.");
}

function renderPartialRestoreSummary() {
  const panel = document.getElementById("partialRestorePanel");
  if (!panel || !partialRestoreContext) return;

  const { backupMeta, backupState, availableCentres } = partialRestoreContext;
  const select = document.getElementById("partialRestoreCentreSelect");
  const selectedName = select?.value || availableCentres[0] || "";

  if (!selectedName) {
    panel.innerHTML = `
      <div class="backup-compare-card">
        <span>Backup #${backupMeta.id}</span>
        <strong>No matching centres available</strong>
        <p style="margin:10px 0 0;color:var(--muted)">This backup does not contain any centre names that match the current live configuration.</p>
      </div>
    `;
    return;
  }

  const backupCentreIndex = (backupState.centers || []).findIndex((centre) => centre?.name === selectedName);
  const currentCentreIndex = centers.findIndex((centre) => centre?.name === selectedName);
  const backupCentre = backupState.centers?.[backupCentreIndex] || null;
  const currentCentre = centers[currentCentreIndex] || null;

  const backupEntries = countCentreEntryDates(backupState, backupCentreIndex);
  const currentEntries = countCentreEntryDates(getAppState(), currentCentreIndex);
  const backupAudit = countCentreAuditRecords(backupState, backupCentreIndex);
  const currentAudit = countCentreAuditRecords(getAppState(), currentCentreIndex);
  const backupUnlocks = countCentreUnlockRecords(backupState, backupCentreIndex);
  const currentUnlocks = countCentreUnlockRecords(getAppState(), currentCentreIndex);

  panel.innerHTML = `
    <div class="backup-compare-card" style="margin-bottom:12px">
      <span>Selected Backup</span>
      <strong>Backup #${backupMeta.id}</strong>
      <p style="margin:10px 0 0;color:var(--muted)">
        Created ${new Date(backupMeta.created_at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}
        ${backupMeta.created_by ? `by ${escapeHtml(backupMeta.created_by)}` : ""}.
      </p>
    </div>
    <div style="display:flex;gap:12px;flex-wrap:wrap;align-items:end;margin-bottom:14px">
      <label style="min-width:260px;flex:1">
        <span style="display:block;margin-bottom:6px;font-size:.82rem;color:var(--muted)">Centre To Restore</span>
        <select id="partialRestoreCentreSelect" onchange="renderPartialRestoreSummary()">
          ${availableCentres.map((centreName) => `
            <option value="${escapeHtml(centreName)}" ${centreName === selectedName ? "selected" : ""}>${escapeHtml(centreName)}</option>
          `).join("")}
        </select>
      </label>
      <button class="button primary" onclick="restoreSelectedCentre()">Restore Selected Centre</button>
    </div>
    <div class="backup-compare-grid">
      <div class="backup-compare-card">
        <span>Daily Entries</span>
        <strong>${backupEntries}</strong>
        <div class="backup-compare-delta ${deltaClass(backupEntries - currentEntries)}">
          In backup: ${backupEntries} | In live record: ${currentEntries}
        </div>
      </div>
      <div class="backup-compare-card">
        <span>Audit Records</span>
        <strong>${backupAudit}</strong>
        <div class="backup-compare-delta ${deltaClass(backupAudit - currentAudit)}">
          In backup: ${backupAudit} | In live record: ${currentAudit}
        </div>
      </div>
      <div class="backup-compare-card">
        <span>Unlock Requests</span>
        <strong>${backupUnlocks}</strong>
        <div class="backup-compare-delta ${deltaClass(backupUnlocks - currentUnlocks)}">
          In backup: ${backupUnlocks} | In live record: ${currentUnlocks}
        </div>
      </div>
    </div>
    <div class="backup-compare-card" style="margin-top:12px">
      <span>Centre Snapshot</span>
      <strong>${escapeHtml(selectedName)}</strong>
      <p style="margin:10px 0 0;color:var(--muted)">
        Monthly target in backup: <strong>${backupCentre?.target ?? 0}</strong>.
        Current target: <strong>${currentCentre?.target ?? 0}</strong>.
        This restore replaces this centre's daily entries, entry metadata, unlock requests, audit trail, and centre settings only.
      </p>
    </div>
  `;
}

async function openPartialRestore(backupId) {
  if (!supabaseClient) {
    showToast("No database connection");
    return;
  }
  setPanelState("partialRestorePanel", "loading", "Loading centre restore options", "Fetching the selected backup and matching centres.");

  const { data, error } = await supabaseClient
    .from("app_backups")
    .select("id, created_at, created_by, backup_data")
    .eq("id", backupId)
    .single();

  if (error || !data) {
    setPanelState("partialRestorePanel", "error", "Partial restore unavailable", "The selected backup could not be loaded for centre-level restore.");
    showToast("Could not load backup");
    return;
  }

  const backupState = data.backup_data || {};
  const currentCentreNames = new Set(centers.map((centre) => centre?.name).filter(Boolean));
  const availableCentres = (backupState.centers || [])
    .map((centre) => centre?.name)
    .filter((name) => name && currentCentreNames.has(name));

  partialRestoreContext = {
    backupId,
    backupMeta: data,
    backupState,
    availableCentres
  };

  renderPartialRestoreSummary();
  showToast(`Loaded centre restore options for backup #${backupId}`);
}

function buildCentreEntryRows(centreIndex) {
  return Object.keys(entries[centreIndex] || {}).map((date) => {
    const entry = entries[centreIndex][date];
    return {
      centre_index: Number(centreIndex),
      centre_name: centers[centreIndex]?.name || "",
      entry_date: date,
      op: entry.op || {},
      referrals: entry.referrals || {},
      procedures: entry.procedures || {},
      updated_at: new Date().toISOString()
    };
  });
}

function buildCentreMetaRows(centreIndex) {
  return Object.keys(entryMeta[centreIndex] || {}).map((date) => {
    const meta = entryMeta[centreIndex][date];
    return {
      centre_index: Number(centreIndex),
      entry_date: date,
      saved_at: meta.savedAt,
      saved_by: meta.savedBy
    };
  });
}

function buildCentreUnlockRows(centreIndex) {
  return unlockRequests
    .filter((record) => Number(record.centreIndex) === Number(centreIndex))
    .map((record) => ({
      id: record.id,
      centre_index: Number(centreIndex),
      centre_name: record.centreName,
      entry_date: record.date,
      reason: record.reason,
      status: record.status,
      requested_at: record.requestedAt,
      resolved_at: record.resolvedAt || null,
      expires_at: record.expiresAt || null
    }));
}

function buildCentreAuditRows(centreIndex) {
  return auditLog
    .filter((record) => Number(record.centreIndex) === Number(centreIndex))
    .map((record) => ({
      id: record.id,
      centre_index: Number(centreIndex),
      centre_name: record.centreName,
      entry_date: record.date,
      saved_at: record.savedAt,
      saved_by: record.savedBy,
      type: record.type,
      unlock_request_id: record.unlockRequestId || null,
      reverted_from_id: record.revertedFromId || null,
      before_state: record.before || {},
      after_state: record.after || {}
    }));
}

async function persistPartialRestoreCentre(centreIndex) {
  saveLocalBackup();
  if (!supabaseClient) return;

  await saveConfig();

  await Promise.all([
    supabaseClient.from("daily_entries").delete().eq("centre_index", centreIndex),
    supabaseClient.from("entry_meta").delete().eq("centre_index", centreIndex),
    supabaseClient.from("unlock_requests").delete().eq("centre_index", centreIndex),
    supabaseClient.from("audit_log").delete().eq("centre_index", centreIndex)
  ]);

  const entryRows = buildCentreEntryRows(centreIndex);
  if (entryRows.length) {
    const { error } = await supabaseClient
      .from("daily_entries")
      .upsert(entryRows, { onConflict: "centre_index,entry_date" });
    if (error) throw error;
  }

  const metaRows = buildCentreMetaRows(centreIndex);
  if (metaRows.length) {
    const { error } = await supabaseClient
      .from("entry_meta")
      .upsert(metaRows, { onConflict: "centre_index,entry_date" });
    if (error) throw error;
  }

  const unlockRows = buildCentreUnlockRows(centreIndex);
  if (unlockRows.length) {
    const { error } = await supabaseClient
      .from("unlock_requests")
      .upsert(unlockRows, { onConflict: "id" });
    if (error) throw error;
  }

  const auditRows = buildCentreAuditRows(centreIndex);
  if (auditRows.length) {
    const { error } = await supabaseClient
      .from("audit_log")
      .upsert(auditRows, { onConflict: "id" });
    if (error) throw error;
  }
}

async function restoreSelectedCentre() {
  if (!partialRestoreContext) {
    showToast("Choose a backup first");
    return;
  }

  const select = document.getElementById("partialRestoreCentreSelect");
  const centreName = select?.value;
  if (!centreName) {
    showToast("Select a centre to restore");
    return;
  }

  const { backupMeta, backupState } = partialRestoreContext;
  const backupCentreIndex = (backupState.centers || []).findIndex((centre) => centre?.name === centreName);
  const currentCentreIndex = centers.findIndex((centre) => centre?.name === centreName);
  if (backupCentreIndex === -1 || currentCentreIndex === -1) {
    showToast("Could not match that centre");
    return;
  }

  const backupEntries = countCentreEntryDates(backupState, backupCentreIndex);
  const backupAudit = countCentreAuditRecords(backupState, backupCentreIndex);
  const backupUnlocks = countCentreUnlockRecords(backupState, backupCentreIndex);

  if (!confirmRestoreAction(
    `Restore only ${centreName} from backup #${backupMeta.id}?`,
    `This will replace ${centreName}'s centre settings, ${backupEntries} daily entr${backupEntries === 1 ? "y" : "ies"}, ${backupAudit} audit record${backupAudit === 1 ? "" : "s"}, and ${backupUnlocks} unlock request${backupUnlocks === 1 ? "" : "s"}. Other centres will stay unchanged.`
  )) return;

  showToast(`Restoring ${centreName} from backup #${backupMeta.id}...`);

  const restoredCentre = deepCloneValue(backupState.centers?.[backupCentreIndex], centers[currentCentreIndex]);
  restoredCentre.name = centreName;
  centers[currentCentreIndex] = restoredCentre;

  entries[currentCentreIndex] = deepCloneValue(backupState.entries?.[backupCentreIndex], {});
  if (entryMeta[currentCentreIndex]) delete entryMeta[currentCentreIndex];
  entryMeta[currentCentreIndex] = deepCloneValue(backupState.entryMeta?.[backupCentreIndex], {});

  unlockRequests = [
    ...unlockRequests.filter((record) => Number(record.centreIndex) !== Number(currentCentreIndex)),
    ...(backupState.unlockRequests || [])
      .filter((record) => Number(record.centreIndex) === Number(backupCentreIndex))
      .map((record) => ({
        ...deepCloneValue(record, {}),
        centreIndex: currentCentreIndex,
        centreName
      }))
  ];

  auditLog = [
    ...auditLog.filter((record) => Number(record.centreIndex) !== Number(currentCentreIndex)),
    ...(backupState.auditLog || [])
      .filter((record) => Number(record.centreIndex) === Number(backupCentreIndex))
      .map((record) => ({
        ...deepCloneValue(record, {}),
        centreIndex: currentCentreIndex,
        centreName
      }))
  ];

  writeAdminAuditLog(
    "partial_restore_centre",
    `Restored ${centreName} from backup #${backupMeta.id}`,
    [currentCentreIndex]
  );

  try {
    await persistPartialRestoreCentre(currentCentreIndex);
    refreshCenterRollups(reportDate);
    renderConsolidated();
    renderTargets();
    renderUsers();
    renderUnlockRequests();
    renderAuditLog();
    renderPartialRestoreSummary();
    setBackupStatus("success", `Centre restored: ${centreName}`, `Backup #${backupMeta.id} was applied only to ${escapeHtml(centreName)}.`);
    showToast(`${centreName} restored from backup #${backupMeta.id}`);
  } catch (error) {
    console.error(error);
    setBackupStatus("error", `Partial restore failed for ${centreName}`, "The selected centre could not be restored from the backup.");
    showToast("Partial restore failed");
  }
}

// Restore backup
async function restoreBackup(backupId) {
  setBackupStatus("loading", `Preparing restore for backup #${backupId}`, "Loading the backup and validating its contents.");
  const { data: previewData, error: previewError } = await supabaseClient
    .from("app_backups")
    .select("backup_data")
    .eq("id", backupId)
    .single();

  if (previewError || !previewData) {
    setBackupStatus("error", `Restore failed for backup #${backupId}`, "The backup could not be loaded from Supabase.");
    showToast("Failed to load the backup");
    return;
  }

  const previewState = previewData.backup_data || {};
  const entryCount = countDailyEntries(previewState);
  const auditCount = countAuditEntries(previewState);
  const adminCount = countAdmins(previewState);
  const centreCount = Array.isArray(previewState.centers) ? previewState.centers.length : 0;

  if (!confirmRestoreAction(
    `Restore full backup #${backupId}?`,
    `This will overwrite the full live app state with ${centreCount} centres, ${entryCount} daily entries, ${auditCount} audit records, and ${adminCount} admin account${adminCount === 1 ? "" : "s"}.`
  )) return;

  showToast("Restoring backup");
  setBackupStatus("loading", `Restoring backup #${backupId}`, "Overwriting the live app state with the selected backup.");

  const state = previewState;

  applyAppState(state);

  try {
    await saveAll();

    setBackupStatus("success", `Backup #${backupId} restored`, "The full live state has been replaced successfully. Reloading now.");
    showToast("Backup restored");

    location.reload();

  } catch (err) {
    console.error(err);
    setBackupStatus("error", `Restore failed for backup #${backupId}`, "The app could not persist the restored state.");
    showToast("Restore failed");
  }
}
async function renderBackups() {
  const container = document.getElementById("backupList");
  if (!container) return;

  if (!supabaseClient) {
    container.innerHTML = backupStateMarkup("empty", "No database connection", "Supabase backups are unavailable right now. You can still use Export to File below.");
    return;
  }

  container.innerHTML = backupStateMarkup("loading", "Loading backups", "Fetching the latest cloud backup list from Supabase.");
  let backups = [];
  try {
    backups = await loadBackups();
  } catch (error) {
    console.error(error);
    container.innerHTML = backupStateMarkup("error", "Could not load backups", "Supabase returned an error while fetching the backup list.");
    setBackupStatus("error", "Backup list unavailable", "The cloud backup list could not be loaded.");
    return;
  }

  if (!backups.length) {
    container.innerHTML = backupStateMarkup("empty", "No backups yet", "Click “Backup Now” to create the first cloud snapshot.");
    setBackupStatus("empty", "No cloud backups yet", "Create a manual backup now, or wait for the automatic daily snapshot.");
    return;
  }

  setBackupStatus("success", "Cloud backups ready", `${backups.length} backup snapshot${backups.length === 1 ? "" : "s"} loaded from Supabase.`);

  container.innerHTML = backups.map(b => `
    <div class="unlock-card">
      <div class="unlock-card-head">
        <div>
          <strong>${new Date(b.created_at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}</strong>
          <span style="display:block;font-size:12px;color:var(--muted)">Backup ID: ${b.id}</span>
          <span style="display:block;font-size:12px;color:var(--muted)">Created by: ${escapeHtml(b.created_by || "Unknown")}</span>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="button secondary" onclick="compareBackup(${b.id})">Compare</button>
          <button class="button secondary" onclick="previewRestore(${b.id})">Restore Preview</button>
          <button class="button secondary" onclick="openPartialRestore(${b.id})">Centre Restore</button>
          <button class="button secondary" onclick="downloadBackupFromSupabase(${b.id})">Download</button>
          <button class="button secondary" onclick="restoreBackup(${b.id})">Restore</button>
          <button class="button secondary" onclick="deleteBackup(${b.id})">Delete</button>
        </div>
      </div>
    </div>
  `).join("");
}

async function ensureDailyBackup() {
  if (!supabaseClient) return;
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  const lastBackupDate = localStorage.getItem("lastBackupDate");
  if (lastBackupDate !== today) {
    await createBackup();
    localStorage.setItem("lastBackupDate", today);
    console.log("Daily backup created for", today);
  }
}

async function init() {
  const loadedState = await setupPersistence();
  ensureCenterCompanies();
  const bootstrappedDefaults = ensureBootstrapData();
  await ensureDailyBackup();
  const hasAnyEntries = Object.keys(entries).some(
    (k) => Object.keys(entries[k] || {}).length > 0
  );
  if (CONFIG.enableDemoData === true && (!loadedState || bootstrappedDefaults) && !hasAnyEntries) {
    seedInitialEntries();
    persistSoon();
  } else {
    refreshCenterRollups(reportDate);
    if (bootstrappedDefaults) persistSoon();
  }

 // Auto refresh for requests
  setInterval(() => {
  if (currentRole === "admin" || currentRole === "superadmin") {
    renderUnlockRequests();
    renderPendingAlert();
    renderConsolidated();
  }
}, 5000);

  // Hash any legacy plaintext passwords silently on first run
  await migrateLegacyPasswords();

  setupLogin();
  setupNavigation();
  setupCompanyTabs();
  setupEntryDate();
  setupMonthSelect();
  setupExportFilters();
  setupExportMenus();
  setupAdminControls();
  setupSuperAdminControls();
  document.getElementById("backupCompareClearBtn")?.addEventListener("click", clearBackupComparison);
  document.getElementById("restorePreviewClearBtn")?.addEventListener("click", clearRestorePreview);
  document.getElementById("partialRestoreClearBtn")?.addEventListener("click", clearPartialRestore);

  // Ensure entry date input always starts on today
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const entryDateInput = document.getElementById("entryDate");
  if (entryDateInput) entryDateInput.value = today;
  const swiztonMonthInput = document.getElementById("swiztonMonth");
  if (swiztonMonthInput) swiztonMonthInput.value = today.slice(0, 7);

  // Sync export date range to current month so To Date is never stale
  const currentMonth = today.slice(0, 7);
  syncExportDatesToMonth(currentMonth);
  renderCompanyTabs();
  renderConsolidated();
  setReportDate(reportDate);
  renderBars();
  renderPayerSplit();
  renderAdminReportPreview();
  renderEntryForCurrentDate();
  renderTargets();
  renderUsers();
  renderProcedures();
  clearSwiztonForm();
  renderUnlockRequests();
  renderAuditLog();
  setupAuditFilters();
  document.getElementById("saveBtn").addEventListener("click", updateFromDailyEntry);

  // Restore session if the tab is still open (sessionStorage survives refresh)
  const session = loadSession();
  if (session) {
    if (session.role === "superadmin") {
      document.getElementById("loginScreen").classList.add("hidden");
      document.getElementById("appShell").classList.remove("hidden");
      setRole("superadmin");
    } else if (session.role === "admin") {
      document.getElementById("loginScreen").classList.add("hidden");
      document.getElementById("appShell").classList.remove("hidden");
      setRole("admin", -1, session.adminIndex ?? -1);
    } else if (session.role === "centre" && centers[session.centreIndex]) {
      document.getElementById("loginScreen").classList.add("hidden");
      document.getElementById("appShell").classList.remove("hidden");
      setRole("centre", session.centreIndex);
    }
  }
 // Backup and restore — daily check runs every hour
  setInterval(ensureDailyBackup, 3600000);

}

// ─── Super Admin Panel ───────────────────────────────────────────────────────

function renderSuperAdminPanel() {
  renderAdminList();
  renderAdminAuditLog();
}

function renderAdminList() {
  const container = document.getElementById("adminList");
  if (!container) return;
  const companyCentreIndexes = centers
    .map((center, index) => ({ center, index }))
    .filter(({ center }) => centerMatchesActiveCompany(center))
    .map(({ index }) => index);

  if (admins.length === 0) {
    container.innerHTML = `<p style="color:var(--muted);padding:16px 0">No admin accounts yet. Add one below.</p>`;
    return;
  }

  container.innerHTML = admins.map((admin, idx) => `
    <div class="user-card" data-admin-idx="${idx}">
      <div>
        <strong>${escapeHtml(admin.name)}</strong>
        <span>Username: ${escapeHtml(admin.username)} · Created ${formatSavedAt(admin.createdAt)}</span>
        <span style="margin-top:4px;display:block">
          Assigned: ${
            (!admin.assignedCentres || admin.assignedCentres.length === 0)
              ? `<em style="color:var(--muted)">All ${activeCompany} centres</em>`
              : admin.assignedCentres
                  .filter(i => centerMatchesActiveCompany(centers[i]))
                  .map(i => `<span class="centre-chip">${escapeHtml(centers[i]?.name || "?")}</span>`)
                  .join("") || `<em style="color:var(--muted)">No ${activeCompany} centres assigned</em>`
          }
        </span>
      </div>
      <div style="display:flex;flex-direction:column;gap:8px;min-width:220px">
        <input type="password" placeholder="New password" class="admin-pw-input" data-admin-idx="${idx}" />
        <div class="centre-assign-wrap">
          ${companyCentreIndexes.map((ci) => {
            const c = centers[ci];
            return `
            <button type="button" class="centre-assign-chip ${admin.assignedCentres?.includes(ci) ? "selected" : ""}" data-admin-idx="${idx}" data-centre-idx="${ci}" aria-pressed="${admin.assignedCentres?.includes(ci) ? "true" : "false"}">
              ${escapeHtml(c.name)}
            </button>
          `;
          }).join("")}
        </div>
        <div style="display:flex;gap:6px;flex-wrap:wrap">
          <button class="button secondary admin-save-assign-btn" data-admin-idx="${idx}">Save Centres</button>
          <button class="button secondary admin-remove-btn" data-admin-idx="${idx}" style="color:var(--red)">Remove</button>
        </div>
      </div>
    </div>
  `).join("");

  // Password change
  container.querySelectorAll(".admin-pw-input").forEach(input => {
    input.addEventListener("change", async () => {
      const raw = input.value.trim();
      if (!raw) return;
      const idx = Number(input.dataset.adminIdx);
      admins[idx].passwordHash = await sha256(raw);
      delete admins[idx].password;
      input.value = "";
      saveLocalBackup();
      persistSoon();
      writeAdminAuditLog("change_admin_password", `Changed password for admin "${admins[idx].name}"`);
      showToast(`Password updated for ${admins[idx].name}`);
    });
  });

  // Centre chip toggle (visual only)
  container.querySelectorAll(".centre-assign-chip").forEach(chip => {
    chip.addEventListener("click", (event) => {
      event.preventDefault();
      chip.classList.toggle("selected");
      chip.setAttribute("aria-pressed", chip.classList.contains("selected") ? "true" : "false");
    });
  });

  // Save centre assignments
  container.querySelectorAll(".admin-save-assign-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const idx = Number(btn.dataset.adminIdx);
      const card = container.querySelector(`[data-admin-idx="${idx}"].user-card`);
      const selected = [...card.querySelectorAll(".centre-assign-chip.selected")]
        .map(c => Number(c.dataset.centreIdx));
      const outsideCompany = (admins[idx].assignedCentres || []).filter(i => !centerMatchesActiveCompany(centers[i]));
      admins[idx].assignedCentres = [...outsideCompany, ...selected];
      writeAdminAuditLog(
        "assign_centres",
        `Updated ${activeCompany} centre assignment for admin "${admins[idx].name}": [${selected.map(i => centers[i]?.name).join(", ") || "None"}]`
      );
      saveLocalBackup();
      persistSoon();
      renderAdminList();
      showToast(`Centre assignment saved for ${admins[idx].name}`);
    });
  });

  // Remove admin
  container.querySelectorAll(".admin-remove-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const idx = Number(btn.dataset.adminIdx);
      const name = admins[idx].name;
      if (!confirm(`Remove admin "${name}"? They will no longer be able to log in.`)) return;
      writeAdminAuditLog("remove_admin", `Removed admin account "${name}"`);
      admins.splice(idx, 1);
      saveLocalBackup();
      persistSoon();
      renderAdminList();
      showToast(`Admin "${name}" removed`);
    });
  });
}

function addAdmin() {
  const nameInput    = document.getElementById("newAdminName");
  const userInput    = document.getElementById("newAdminUsername");
  const pwInput      = document.getElementById("newAdminPassword");
  const name     = nameInput.value.trim();
  const username = userInput.value.trim().toLowerCase().replace(/\s+/g, "");
  const password = pwInput.value.trim();

  if (!name || !username || !password) {
    showToast("Please fill in name, username, and password.");
    return;
  }
  if (admins.some(a => a.username === username)) {
    showToast("Username already taken.");
    return;
  }

  sha256(password).then(hash => {
    admins.push({
      id: Date.now(),
      name,
      username,
      passwordHash: hash,
      assignedCentres: [],
      createdAt: new Date().toISOString()
    });
    nameInput.value = "";
    userInput.value = "";
    pwInput.value = "";
    writeAdminAuditLog("add_admin", `Added new admin account "${name}" (username: ${username})`);
    saveLocalBackup();
    persistSoon();
    renderAdminList();
    showToast(`Admin "${name}" added`);
  });
}

function renderAdminAuditLog() {
  const container = document.getElementById("adminAuditLogList");
  if (!container) return;

  const filterAction = document.getElementById("adminAuditFilterAction")?.value || "all";
  const filterFrom   = document.getElementById("adminAuditFilterFrom")?.value   || "";
  const filterTo     = document.getElementById("adminAuditFilterTo")?.value     || "";

  let logs = [...adminAuditLog].reverse();
  if (filterAction !== "all") logs = logs.filter(l => l.action === filterAction);
  if (filterFrom)             logs = logs.filter(l => l.timestamp >= filterFrom);
  if (filterTo)               logs = logs.filter(l => l.timestamp.slice(0,10) <= filterTo);

  if (logs.length === 0) {
    container.innerHTML = `<p style="color:var(--muted);padding:16px 0">No admin actions recorded yet.</p>`;
    return;
  }

  const actionBadgeMap = {
    approve_unlock:        ["audit-badge-unlock",  "Approved Unlock"],
    reject_unlock:         ["audit-badge-revert",  "Rejected Unlock"],
    revert_entry:          ["audit-badge-revert",  "Reverted Entry"],
    add_admin:             ["audit-badge-normal",  "Added Admin"],
    remove_admin:          ["audit-badge-revert",  "Removed Admin"],
    assign_centres:        ["audit-badge-normal",  "Assigned Centres"],
    change_admin_password: ["audit-badge-normal",  "Password Changed"],
  };

  container.innerHTML = logs.map(log => {
    const [cls, label] = actionBadgeMap[log.action] || ["audit-badge-normal", log.action];
    return `
      <div class="audit-card">
        <div class="audit-card-head">
          <div class="audit-card-title">
            <strong>${escapeHtml(log.adminName)}</strong>
            <span class="audit-date-tag">${new Date(log.timestamp).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}</span>
            <span class="audit-badge ${cls}">${label}</span>
            ${log.role === "superadmin" ? `<span class="role-badge-superadmin">Super Admin</span>` : `<span class="role-badge-admin">Admin</span>`}
          </div>
        </div>
        <p style="color:var(--ink);font-size:.875rem;margin:6px 0 0">${escapeHtml(log.detail)}</p>
      </div>`;
  }).join("");
}

function setupSuperAdminControls() {
  document.getElementById("addAdminBtn")?.addEventListener("click", addAdmin);
  document.getElementById("newAdminPassword")?.addEventListener("keydown", e => {
    if (e.key === "Enter") addAdmin();
  });
  ["adminAuditFilterAction", "adminAuditFilterFrom", "adminAuditFilterTo"].forEach(id => {
    document.getElementById(id)?.addEventListener("change", renderAdminAuditLog);
  });
  document.getElementById("adminAuditClearFilter")?.addEventListener("click", () => {
    document.getElementById("adminAuditFilterAction").value = "all";
    document.getElementById("adminAuditFilterFrom").value = "";
    document.getElementById("adminAuditFilterTo").value = "";
    renderAdminAuditLog();
  });
}

// Log admin target changes
function logTargetChange(centreName, oldTarget, newTarget) {
  writeAdminAuditLog(
    "change_target",
    `Changed target for "${centreName}" from ${oldTarget} → ${newTarget}`,
    [centers.findIndex(c => c.name === centreName)]
  );
}

init();
