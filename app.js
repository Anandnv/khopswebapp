let centers = [
  { name: "Tirur", username: "tirur", password: "1234", tillDate: 10, yesterday: 2, target: 25, cagToday: 1, cagTotal: 7, kasp: 7, general: 5, medisep: 0 },
  { name: "Calicut", username: "calicut", password: "1234", tillDate: 5, yesterday: 0, target: 20, cagToday: 0, cagTotal: 5, kasp: 2, general: 2, medisep: 1 },
  { name: "Kochi", username: "kochi", password: "1234", tillDate: 7, yesterday: 0, target: 25, cagToday: 2, cagTotal: 18, kasp: 0, general: 4, medisep: 3 },
  { name: "Malappuram", username: "malappuram", password: "1234", tillDate: 15, yesterday: 0, target: 25, cagToday: 1, cagTotal: 7, kasp: 2, general: 13, medisep: 0 },
  { name: "Perumpilavu", username: "perumpilavu", password: "1234", tillDate: 3, yesterday: 0, target: 15, cagToday: 0, cagTotal: 2, kasp: 1, general: 2, medisep: 0 },
  { name: "Edappal", username: "edappal", password: "1234", tillDate: 0, yesterday: 0, target: 7, cagToday: 0, cagTotal: 0, kasp: 0, general: 0, medisep: 0 },
  { name: "Valanchery", username: "valanchery", password: "1234", tillDate: 4, yesterday: 0, target: 23, cagToday: 0, cagTotal: 4, kasp: 1, general: 3, medisep: 0 }
];

let currentRole = "admin";
let loggedInCentreIndex = 0;
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
const STORAGE_KEY = "kh-cardio-ops-state-v1";
const CONFIG = window.KH_CONFIG || {};
let supabaseClient = null;
let persistenceReady = false;
let saveTimer = null;

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

/** Persist a lightweight session token (role + centreIndex) in sessionStorage */
function saveSession(role, centreIndex) {
  sessionStorage.setItem(
    SESSION_KEY,
    JSON.stringify({ role, centreIndex, ts: Date.now() })
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

// ─── Entry metadata helpers ──────────────────────────────────────────────────

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



function getAppState() {
  return {
    centers,
    procedureSettings,
    entries,
    entryMeta,
    unlockRequests,
    reportDate
  };
}

function applyAppState(state) {
  if (!state) return false;
  if (Array.isArray(state.centers)) centers = state.centers;
  if (Array.isArray(state.procedureSettings)) procedureSettings = state.procedureSettings;
  if (state.entries && typeof state.entries === "object") {
    Object.keys(entries).forEach((key) => delete entries[key]);
    Object.assign(entries, state.entries);
  }
  if (state.entryMeta && typeof state.entryMeta === "object") {
    Object.keys(entryMeta).forEach((key) => delete entryMeta[key]);
    Object.assign(entryMeta, state.entryMeta);
  }
  if (Array.isArray(state.unlockRequests)) unlockRequests = state.unlockRequests;
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

async function loadPersistedState() {
  if (supabaseClient) {
    const { data, error } = await supabaseClient
      .from("app_state")
      .select("state")
      .eq("id", "main")
      .maybeSingle();
    if (!error && data?.state) return applyAppState(data.state);
    if (error) console.warn("Supabase load failed, falling back to localStorage", error);
  }
  const saved = localStorage.getItem(STORAGE_KEY);
  if (!saved) return false;
  try {
    return applyAppState(JSON.parse(saved));
  } catch (error) {
    console.warn("Saved local state could not be parsed", error);
    return false;
  }
}

function persistSoon() {
  if (!persistenceReady) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveAppState, 250);
}

async function saveAppState() {
  const state = getAppState();

  // Always save locally as backup
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));

  if (!supabaseClient) {
    showToast("Saved locally (offline mode)");
    return;
  }

  try {
    const { error } = await supabaseClient
      .from("app_state")
      .upsert({
        id: "main",
        state,
        updated_at: new Date().toISOString()
      });

    if (error) {
      console.error("Supabase save failed:", error);
      showToast("❌ Save failed (server error)");
      return;
    }

    showToast("✅ Data saved successfully");
  } catch (err) {
    console.error("Unexpected save error:", err);
    showToast("❌ Save failed (network issue)");
  }
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

function activeProcedures() {
  return procedureSettings.filter((procedure) => procedure.active).map((procedure) => procedure.name);
}

function countedProcedures() {
  return procedureSettings.filter((procedure) => procedure.active && procedure.counted).map((procedure) => procedure.name);
}

function cagProcedures() {
  return procedureSettings.filter((procedure) => procedure.active && procedure.isCag).map((procedure) => procedure.name);
}

function isCountedProcedure(procedureName) {
  return procedureSettings.some((procedure) => procedure.name === procedureName && procedure.active && procedure.counted);
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
  const value = document.getElementById("exportCentre")?.value || "all";
  if (value === "all") return centers.map((_, index) => index);
  return [Number(value)];
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

function renderPendingAlert() {
  const container = document.getElementById("pendingAlert");
  if (!container) return;

  // ✅ ONLY SHOW FOR ADMIN
  if (currentRole !== "admin") {
    container.innerHTML = "";
    return;
  }

  const missing = centers.filter((_, index) => {
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
    container.innerHTML = `
      <div style="background:#e6f7ee;padding:10px;border-radius:8px;font-weight:600;color:#1b7f4b">
        ✅ All centres updated today
      </div>
    `;
    return;
  }

  const names = missing.map(c => c.name).join(", ");

  container.innerHTML = `
    <div style="background:#ffe6e6;padding:12px;border-radius:8px;font-weight:700;color:#b30000">
      ❌ ${missing.length} centre(s) pending today<br/>
      <small style="font-weight:500">${names}</small>
    </div>
  `;
}

function renderConsolidated() {
  refreshCenterRollups(reportDate);

  document.getElementById("procedureReportTitle").textContent = `KH - Procedures Till ${displayDate(reportDate)}`;
  document.querySelector("#summaryPercent").nextElementSibling.textContent = `Till ${displayDate(reportDate)}`;

  const centerIndexes = centers.map((_, index) => index);
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
    ? `<span style="color:green;font-weight:700">✔ Updated</span>`
    : `<span style="color:red;font-weight:700">❌ Missing</span>`;
    }   

    const row = document.createElement("tr");

    row.innerHTML = `
      <td>
        ${center.name}<br/>
        <small>${statusBadge}</small>
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

  document.getElementById("summaryIntervention").textContent = grandTotal;
  document.getElementById("summaryCag").textContent = totals.cagTotal;
  document.getElementById("summaryTarget").textContent = totals.target;
  document.getElementById("summaryPercent").textContent = `${percent}%`;

  renderOpsConsolidated();
  renderPendingAlert();
}

function renderOpsConsolidated() {
  const tbody = document.querySelector("#opsConsolidatedTable tbody");
  if (!tbody) return;
  document.getElementById("opsReportTitle").textContent = `OP & Diagnostics Till ${displayDate(reportDate)}`;
  tbody.innerHTML = centers.map((center, index) => {
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
  centers.forEach((center) => {
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
  const totals = centers.reduce(
    (acc, center) => {
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
  document.getElementById("payerDonut").style.background = `conic-gradient(var(--blue) 0 ${generalPct}%, var(--teal) ${generalPct}% ${generalPct + kaspPct}%, var(--purple) ${generalPct + kaspPct}% 100%)`;
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
    unlock: "Edit Requests"
  };
  document.getElementById("pageTitle").textContent = titles[name] || titles.admin;
  updateTopbarActions(name);
  if (name === "unlock") requestAnimationFrame(() => renderUnlockRequests());
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function updateTopbarActions(name) {
  document.getElementById("saveBtn").classList.toggle("hidden", currentRole !== "centre" || name !== "entry");
  document.getElementById("monthSelect").classList.toggle("hidden", currentRole === "centre");
}

function setRole(role, centreIndex = loggedInCentreIndex) {
  currentRole = role;
  loggedInCentreIndex = centreIndex;
  document.body.classList.toggle("centre-mode", role === "centre");

  if (role === "centre") {
    const centre = centers[loggedInCentreIndex];
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

  document.getElementById("signedInName").textContent = "Admin User";
  document.getElementById("signedInAccess").textContent = "Full centre access, view only";
  document.getElementById("exportCentre").disabled = false;
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
            🔒 <strong>${displayDate(date)}</strong> is locked.
            <span>Unlock request sent — waiting for admin approval.</span>
           </div>`
        : `<div class="lock-banner locked">
            🔒 <strong>${displayDate(date)}</strong> is locked (past date).
            <button class="button secondary" id="requestUnlockBtn">Request Edit Access</button>
           </div>`;
      banner.classList.remove("hidden");
      if (!pending) {
        document.getElementById("requestUnlockBtn")?.addEventListener("click", () => openUnlockModal(date));
      }
    } else if (approved) {
      const unlock = getApprovedUnlock(loggedInCentreIndex, date);
      const timeLeft = unlock?.expiresAt ? ` — ${formatTimeRemaining(unlock.expiresAt)}` : "";
      banner.innerHTML = `<div class="lock-banner unlocked">✅ <strong>${displayDate(date)}</strong> is unlocked for editing by admin approval${timeLeft}.</div>`;
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
    showToast("🔒 This date is locked. Request admin approval to edit past data.");
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

  // Record last-updated metadata
  setEntryMeta(loggedInCentreIndex, date, center.name);

  setReportDate(date);
  refreshCenterRollups(reportDate);
  renderConsolidated();
  renderBars();
  renderPayerSplit();
  renderEntryForCurrentDate();
  persistSoon();
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
  centers.forEach((center) => {
    const card = document.createElement("div");
    card.className = "target-card";
    card.innerHTML = `
      <div><strong>${center.name}</strong><span>April 2026 target</span></div>
      <input type="number" min="0" value="${center.target}" aria-label="${center.name} target" />
    `;
    const input = card.querySelector("input");
    input.addEventListener("input", () => {
      center.target = currencySafeNumber(input.value);
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
  list.innerHTML = centers.map((center, index) => `
    <div class="user-card">
      <div>
        <strong>${center.name}</strong>
        <span>Username and new password for centre login</span>
      </div>
      <input type="text" value="${escapeHtml(center.username)}" aria-label="${center.name} username" data-user-field="username" data-center-index="${index}" />
      <input type="password" placeholder="New password" aria-label="${center.name} new password" data-user-field="password" data-center-index="${index}" />
      <button class="button secondary" data-remove-center="${index}">Remove</button>
    </div>
  `).join("");

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
  tbody.innerHTML = procedureSettings.map((procedure, index) => `
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
  if (procedureSettings.some((item, itemIndex) => itemIndex !== index && item.name.toLowerCase() === cleanedName.toLowerCase())) {
    renderProcedures();
    showToast("Procedure name already exists");
    return;
  }
  procedure.name = cleanedName;
  Object.values(entries).forEach((centreEntries) => {
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
  if (procedureSettings.some((procedure) => procedure.name.toLowerCase() === name.toLowerCase())) {
    showToast("Procedure already exists");
    return;
  }
  procedureSettings.push({ name, counted: true, isCag: false, active: true });
  input.value = "";
  refreshAfterProcedureChange();
  persistSoon();
  showToast("Procedure added");
}

function addCenter() {
  const input = document.getElementById("newCentreName");
  const name = input.value.trim();
  if (!name) return;
  centers.push({
    name,
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
  if (loginSelect) loginSelect.innerHTML = centers.map((center, index) => `<option value="${index}">${center.name}</option>`).join("");
  const exportSelect = document.getElementById("exportCentre");
  if (exportSelect) exportSelect.innerHTML = `<option value="all">All Centres</option>` + centers.map((center, index) => `<option value="${index}">${center.name}</option>`).join("");
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
  centreSelect.innerHTML = centers.map((center, index) => `<option value="${index}">${center.name}</option>`).join("");

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
      document.querySelector(".centre-login-field").classList.toggle("hidden", loginType === "admin");
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

function downloadFilteredCsvReport() {
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

function professionalReportHtml() {
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
  const reportWindow = window.open("", "_blank");
  if (!reportWindow) {
    downloadBlob(professionalReportHtml(), `kh-professional-report-${range.fromDate}-to-${range.toDate}.html`, "text/html;charset=utf-8");
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

function downloadImageReport(format) {
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

  if (loginType === "admin") {
    // Admin hash lives in CONFIG so it's never in app.js source
    const adminHash = CONFIG.adminPasswordHash || await sha256("admin123");
    if (passwordHash !== adminHash) {
      recordFailedAttempt();
      const remaining = lockoutSecondsLeft();
      error.textContent = remaining > 0
        ? `Too many failed attempts. Locked for ${remaining}s.`
        : "Invalid admin password.";
      return;
    }
    resetAttempts();
    saveSession("admin", -1);
    document.getElementById("loginScreen").classList.add("hidden");
    document.getElementById("appShell").classList.remove("hidden");
    setRole("admin");
    return;
  }

  // Centre login — compare against stored hash (falls back gracefully if
  // the password field still holds a plaintext legacy value during migration)
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

// ─── Unlock request modal ────────────────────────────────────────────────────

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
  unlockRequests.push({
    id: Date.now(),
    centreIndex: loggedInCentreIndex,
    centreName: centers[loggedInCentreIndex].name,
    date,
    reason,
    status: "pending",
    requestedAt: new Date().toISOString(),
    resolvedAt: null
  });
  persistSoon();
  closeUnlockModal();
  renderEntryForCurrentDate();
  showToast("Unlock request sent to admin.");
}

// ─── Admin unlock panel ──────────────────────────────────────────────────────

function renderUnlockRequests() {
  const container = document.getElementById("unlockRequestList");
  if (!container) return;

  // Mark any approved requests that have since expired
  let dirty = false;
  unlockRequests.forEach(r => {
    if (r.status === "approved" && isUnlockExpired(r)) {
      r.status = "expired";
      dirty = true;
    }
  });
  if (dirty) persistSoon();

  const pending  = unlockRequests.filter(r => r.status === "pending");
  const resolved = unlockRequests.filter(r => r.status !== "pending").slice(-20).reverse();

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
  persistSoon();
  renderUnlockRequests();
  const label = status === "approved"
    ? `✅ Approved for ${durationMins >= 60 ? durationMins / 60 + "h" : durationMins + "min"} — ${req.centreName} / ${displayDate(req.date)}`
    : `❌ Rejected — ${req.centreName} / ${displayDate(req.date)}`;
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

async function init() {
  const loadedState = await setupPersistence();
  const hasAnyEntries = Object.keys(entries).some(
    (k) => Object.keys(entries[k] || {}).length > 0
  );
  if (!loadedState && !hasAnyEntries) {
    seedInitialEntries();
    persistSoon();
  } else {
    refreshCenterRollups(reportDate);
  }

  // Hash any legacy plaintext passwords silently on first run
  await migrateLegacyPasswords();

  setupLogin();
  setupNavigation();
  setupEntryDate();
  setupMonthSelect();
  setupExportFilters();
  setupExportMenus();
  setupAdminControls();

  // Ensure entry date input always starts on today
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const entryDateInput = document.getElementById("entryDate");
  if (entryDateInput) entryDateInput.value = today;

  // Sync export date range to current month so To Date is never stale
  const currentMonth = today.slice(0, 7);
  syncExportDatesToMonth(currentMonth);
  renderConsolidated();
  setReportDate(reportDate);
  renderBars();
  renderPayerSplit();
  renderAdminReportPreview();
  renderEntryForCurrentDate();
  renderTargets();
  renderUsers();
  renderProcedures();
  renderUnlockRequests();
  document.getElementById("saveBtn").addEventListener("click", updateFromDailyEntry);

  // Restore session if the tab is still open (sessionStorage survives refresh)
  const session = loadSession();
  if (session) {
    if (session.role === "admin") {
      document.getElementById("loginScreen").classList.add("hidden");
      document.getElementById("appShell").classList.remove("hidden");
      setRole("admin");
    } else if (session.role === "centre" && centers[session.centreIndex]) {
      document.getElementById("loginScreen").classList.add("hidden");
      document.getElementById("appShell").classList.remove("hidden");
      setRole("centre", session.centreIndex);
    }
  }
}

init();