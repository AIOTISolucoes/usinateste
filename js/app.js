// =============================================================================
// 🔒 AUTH GUARD (ESTÁVEL E PROFISSIONAL)
// =============================================================================
(function authGuard() {
  const user = localStorage.getItem("user");
  if (!user) {
    window.location.href = "index.html";
    return;
  }
})();

/**
 * Limpa a sessão e redireciona para o login.
 */
function logout() {
  localStorage.removeItem("user");
  localStorage.removeItem("currentView");
  window.location.href = "index.html";
}

// =============================================================================
// API FETCH COM CONTEXTO DO USUÁRIO LOGADO
// =============================================================================
const API_BASE = "https://jgeg9i0js1.execute-api.us-east-1.amazonaws.com";
const INVERTER_NO_COMM_AFTER_MS = 15 * 60 * 1000; // legado (chips usam status do mart)
const DASHBOARD_REFRESH_INTERVAL_MS = 10000;
const EVENTS_REFRESH_INTERVAL_MS = 10000;

function apiFetch(path, options = {}) {
  const user = JSON.parse(localStorage.getItem("user") || "{}");

  const headers = {
    ...(options.headers || {})
  };

  if (user.customer_id) headers["X-Customer-Id"] = user.customer_id;
  if (user.is_superuser === true) headers["X-Is-Superuser"] = "true";

  return fetch(`${API_BASE}${path}`, {
    ...options,
    headers
  });
}

// =============================================================================
// CONFIGURAÇÃO GLOBAL E ESTADO
// =============================================================================
let lastValidPlants = [];
let lastAlarmSeverityByPlant = new Map();
let CURRENT_PLANT_ID = null; // planta selecionada no dashboard

function loadSelectedPlantId() {
  const v = localStorage.getItem("selectedPlantId");
  return v && /^\d+$/.test(v) ? Number(v) : null;
}

function saveSelectedPlantId(id) {
  if (id == null) return;
  localStorage.setItem("selectedPlantId", String(id));
}

// EVENTS
let EVENTS_STATE = {
  page: 1,
  page_size: 30,
  total: 0,
  total_pages: 0,
  wired: false,

  // ✅ anti dupla chamada + auto refresh
  loading: false,
  autoTimer: null
};

// DATA STUDIO
let DATASTUDIO_STATE = {
  wired: false,
  loadingTags: false,
  loadingSeries: false,
  savingSelection: false,

  startDate: "",
  endDate: "",
  selectedPlantId: null,

  selectedDataKind: "all", // all | analog | discrete
  selectedSource: "all", // all | historico | consolidado
  selectedContext: "all", // all | PLANT | inverter | relay | meter etc
  searchText: "",

  availableTags: [],
  selectedTags: [],

  selectionId: null,

  aggregationMode: "historico", // historico | consolidado
  aggregationType: "avg", // avg | integral | median | max | mode | propagation | sum | none
  consolidationPeriod: "5min", // 5min | daily | weekly | monthly | yearly | hdaily etc

  chartData: null,
  forceHeroState: false,
  catalogOpen: false,
  catalogConfirmed: false
};

let DATASTUDIO_CHART = null;

// Abort controller pra evitar race condition
let eventsAbortController = null;
let ALARMS_RENDER_SEQ = 0;
let LAST_ACTIVE_ALARMS_RENDER_KEY = "";
let LAST_RECOGNIZED_ALARMS_RENDER_KEY = "";
let LAST_EVENTS_RENDER_KEY = "";
let LOCAL_ACKED_ALARMS = [];
let CURRENT_ALARMS_TAB_MODE = null; // "active" | "recognized"

// ✅ MODO PADRÃO DO EVENTS
let EVENTS_VIEW_MODE = "normal";

// ✅ quantas “rodadas/seqüências” você quer ver (T1..T5)
let EVENTS_ROUNDS = 5;

// =============================================================================
// FUNÇÕES DE UTILIDADE
// =============================================================================
function valueOrDash(v) {
  return v === null || v === undefined || v === "" ? "—" : v;
}

function severityColor(sev) {
  const s = String(sev || "").toLowerCase();
  if (s === "high") return "#f44336";
  if (s === "medium") return "#ff9800";
  if (s === "low") return "#4caf50";
  return "#ccc";
}

function normalizeAlarmSeverity(sev) {
  if (!sev) return null;
  const normalized = String(sev).toLowerCase();
  if (normalized === "high" || normalized === "medium") return normalized;
  return null;
}

function buildAlarmRenderKey(list, isRecognized) {
  const base = Array.isArray(list) ? list : [];
  const compact = base.map((a) => ({
    id: a?.event_row_id ?? a?.id ?? null,
    state: String(a?.alarm_state ?? a?.state ?? "").toUpperCase(),
    acknowledged: a?.acknowledged === true,
    acknowledged_at: a?.acknowledged_at ?? null,
    acknowledged_by: a?.acknowledged_by ?? null,
    acknowledgment_note: a?.acknowledgment_note ?? null,
    started_at: a?.started_at ?? a?.timestamp ?? a?.last_event_ts ?? null,
    event_name: a?.event_name ?? null
  }));
  return JSON.stringify({ mode: isRecognized ? "recognized" : "active", compact });
}

function buildEventsRenderKey(list, page, filters) {
  const compact = (Array.isArray(list) ? list : []).map((ev) => ({
    id: ev?.event_row_id ?? ev?.id ?? null,
    ts: ev?.event_ts ?? ev?.timestamp ?? null,
    state: ev?.state ?? ev?.event_status ?? null,
    severity: ev?.severity ?? null,
    acknowledged_by: ev?.acknowledged_by ?? null,
    acknowledgment_note: ev?.acknowledgment_note ?? null
  }));
  return JSON.stringify({ page, f: filters, compact });
}

function getHigherSeverity(a, b) {
  const rank = { high: 2, medium: 1 };
  if (!a) return b;
  if (!b) return a;
  return (rank[b] || 0) > (rank[a] || 0) ? b : a;
}

function buildPlantAlarmSeverityMap(alarms) {
  const map = new Map();
  const validAlarms = Array.isArray(alarms) ? alarms : [];

  validAlarms.forEach(alarm => {
    const severity = normalizeAlarmSeverity(
      alarm.severity || alarm.alarm_severity || alarm.level || alarm.alarm_level
    );
    if (!severity) return;

    const plantId = alarm.power_plant_id || alarm.plant_id || alarm.plantId;
    const plantName = alarm.power_plant_name || alarm.plant_name || alarm.plantName;

    if (plantId != null) map.set(plantId, getHigherSeverity(map.get(plantId), severity));
    if (plantName) map.set(plantName, getHigherSeverity(map.get(plantName), severity));
  });

  return map;
}

function getAlarmDescription(eventCode) {
  const map = {
    17: "Falha geral",
    59: "Proteção acionada",
    7: "Subtensão",
    9: "Sobretensão"
  };
  return map[eventCode] || `Evento ${eventCode}`;
}


function dedupeAlarms(list) {
  const items = Array.isArray(list) ? list : [];
  const seen = new Set();
  const out = [];

  items.forEach(a => {
    const key =
      a.event_row_id ??
      a.alarm_id ??
      a.id ??
      [
        a.power_plant_id ?? a.power_plant_name ?? "",
        a.device_id ?? a.device_name ?? "",
        a.event_code ?? a.event_name ?? "",
        a.alarm_state ?? a.state ?? "",
        a.started_at ?? a.last_event_ts ?? a.ack_at ?? a.cleared_at ?? ""
      ].join("|");

    const normalized = String(key || "").trim();
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    out.push(a);
  });

  return out;
}

// =============================================================================
// ✅ TOP CHIPS (GEN / NO COMM / OFF) — TELEMETRIA POR USINA
// ----------------------------------------------------------------------------
// Regras por status (mart_inverter_realtime, sem depender do clock do browser):
// Gen     = RUNNING (code 2)
// No comm = OFFLINE (code 0)
// Off     = STANDBY + FAULT (codes 1 + 3)
// =============================================================================
function parseTsToMs(anyTs) {
  if (!anyTs) return 0;
  const ms = Date.parse(anyTs);
  return Number.isFinite(ms) ? ms : 0;
}

function dedupInvertersById(list) {
  const map = new Map();

  for (const inv of (list || [])) {
    const id = inv.inverter_id ?? inv.device_id ?? inv.id;
    if (id == null) continue;

    const ts = parseTsToMs(
      inv.last_ts ??
      inv.timestamp ??
      inv.event_ts ??
      inv.ts ??
      inv.last_reading_at ??
      inv.last_reading_ts
    );

    const prev = map.get(id);
    const prevTs = prev ? parseTsToMs(
      prev.last_ts ??
      prev.timestamp ??
      prev.event_ts ??
      prev.ts ??
      prev.last_reading_at ??
      prev.last_reading_ts
    ) : -1;

    if (!prev || ts >= prevTs) map.set(id, inv);
  }

  return [...map.values()];
}

function normalizeInvStatus(inv) {
  const s =
    inv.status ??
    inv.inverter_status ??
    inv.inverterStatus ??
    null;

  if (s) return String(s).trim().toUpperCase();

  const code =
    inv.inverter_status_code ??
    inv.status_code ??
    inv.inverterStatusCode ??
    null;

  if (code === 0) return "OFFLINE";
  if (code === 1) return "STANDBY";
  if (code === 2) return "RUNNING";
  if (code === 3) return "FAULT";
  return "UNKNOWN";
}

function computeInverterChipsByTelemetry(invertersRaw) {
  const inverters = dedupInvertersById(invertersRaw);

  let noComm = 0;
  let gen = 0;
  let off = 0;

  for (const inv of inverters) {
    const st = normalizeInvStatus(inv);

    if (st === "OFFLINE") noComm++;
    else if (st === "RUNNING") gen++;
    else if (st === "STANDBY" || st === "FAULT") off++;
    else {
      // se vier UNKNOWN, joga em off pra não sumir
      off++;
    }
  }

  const total = inverters.length;
  return { total, gen, off, noComm };
}


function computeGlobalChipsFromPlants(plantsRaw) {
  const plants = Array.isArray(plantsRaw) ? plantsRaw : [];

  let total = 0;
  let gen = 0;
  let noComm = 0;
  let off = 0;

  for (const p of plants) {
    total += Number(p.inverter_total ?? 0) || 0;
    gen += Number(p.inverter_generating ?? 0) || 0;
    noComm += Number(p.inverter_no_comm ?? 0) || 0;
    off += Number(p.inverter_off ?? 0) || 0;
  }

  total = Math.max(0, total);
  gen = Math.max(0, gen);
  noComm = Math.max(0, noComm);
  off = Math.max(0, off);

  const sum = gen + noComm + off;
  if (total === 0 && sum > 0) total = sum;

  return { total, gen, noComm, off };
}

function refreshTopChipsGlobalFromPlants(plants) {
  const r = computeGlobalChipsFromPlants(plants);

  setChipCount("countGen", r.gen, `Gerando (global): ${r.gen} de ${r.total}`);
  setChipCount("countNoComm", r.noComm, `Sem comunicação (global): ${r.noComm} de ${r.total}`);
  setChipCount("countOff", r.off, `Off (global): ${r.off} de ${r.total}`);

  console.log("[INV CHIPS - GLOBAL]", r);
}

function setChipCount(id, value, title = "") {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = String(value);
  if (title) el.title = title;
}

async function fetchInvertersRealtimeByPlant(plantId) {
  const res = await apiFetch(`/plants/${plantId}/inverters/realtime`);
  if (!res.ok) {
    console.warn(`[INV CHIPS] HTTP ${res.status} em /plants/${plantId}/inverters/realtime`);
    return [];
  }

  const data = await res.json();
  const normalized = (data && data.body)
    ? (typeof data.body === "string" ? JSON.parse(data.body) : data.body)
    : data;

  return (Array.isArray(normalized?.inverters) ? normalized.inverters : null) ||
         (Array.isArray(normalized?.items) ? normalized.items : null) ||
         (Array.isArray(normalized) ? normalized : []);
}

async function refreshInverterStatusChipsForPlant(plantId) {
  if (plantId == null) {
    setChipCount("countGen", 0);
    setChipCount("countNoComm", 0);
    setChipCount("countOff", 0);
    return;
  }

  try {
    const inverters = await fetchInvertersRealtimeByPlant(plantId);
    const r = computeInverterChipsByTelemetry(inverters);

    setChipCount("countGen", r.gen, `Gerando: ${r.gen} de ${r.total}`);
    setChipCount("countNoComm", r.noComm, `Sem comunicação: ${r.noComm} de ${r.total}`);
    setChipCount("countOff", r.off, `Desligados: ${r.off} de ${r.total}`);

    console.log("[INV CHIPS - PLANT]", { plantId, ...r });
  } catch (e) {
    console.warn("[INV CHIPS] falha:", e?.message || e);
    setChipCount("countGen", 0);
    setChipCount("countNoComm", 0);
    setChipCount("countOff", 0);
  }
}

// =============================================================================
// HELPERS DE DATA (EVENTS)
// =============================================================================
function safeTrim(v) {
  if (v == null) return "";
  return String(v).trim();
}

function todayYYYYMMDD() {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function isoFromDateAndTime(dateYYYYMMDD, timeHHMM, isEnd = false) {
  if (!dateYYYYMMDD) return null;

  const [yyyy, mm, dd] = dateYYYYMMDD.split("-").map(Number);
  if (!yyyy || !mm || !dd) return null;

  let HH = 0, MI = 0, SS = 0;
  if (timeHHMM) {
    const [h, m] = String(timeHHMM).split(":").map(Number);
    HH = Number.isFinite(h) ? h : 0;
    MI = Number.isFinite(m) ? m : 0;
    SS = isEnd ? 59 : 0;
  } else if (isEnd) {
    HH = 23;
    MI = 59;
    SS = 59;
  }

  const d = new Date(yyyy, mm - 1, dd, HH, MI, SS);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function clampEventRange(startISO, endISO) {
  if (!startISO || !endISO) return { startISO, endISO };

  const s = new Date(startISO).getTime();
  const e = new Date(endISO).getTime();

  if (!Number.isFinite(s) || !Number.isFinite(e)) return { startISO, endISO };

  if (e < s) {
    return { startISO: endISO, endISO: startISO };
  }

  return { startISO, endISO };
}

function parseEquipmentFilter(input) {
  const raw = safeTrim(input);
  if (!raw) return { source: null, device_id: null };

  const compact = raw.replace(/\s+/g, "").replace(/[^\w]/g, "");
  const lower = compact.toLowerCase();

  const invMatch =
    lower.match(/^inversor(\d+)$/) ||
    lower.match(/^inverter(\d+)$/) ||
    lower.match(/^inv(\d+)$/);
  if (invMatch) return { source: "inverter", device_id: parseInt(invMatch[1], 10) };

  const relayMatch =
    lower.match(/^relay(\d+)$/) ||
    lower.match(/^rele(\d+)$/) ||
    lower.match(/^rel(\d+)$/);
  if (relayMatch) return { source: "relay", device_id: parseInt(relayMatch[1], 10) };

  if (lower === "weather" || lower === "clima") return { source: "weather", device_id: null };

  return { source: null, device_id: null };
}

// =============================================================================
// CONTROLE DE TEMA E RELÓGIO
// =============================================================================
const themeToggleBtn = document.getElementById("themeToggleBtn");
const themeIcon = document.getElementById("themeIcon");
const body = document.body;

const savedTheme = localStorage.getItem("theme") || "dark";
body.classList.add(`theme-${savedTheme}`);
if (themeIcon) themeIcon.className = savedTheme === "dark" ? "fa-solid fa-sun" : "fa-solid fa-moon";

themeToggleBtn?.addEventListener("click", () => {
  const isDark = body.classList.contains("theme-dark");
  const newTheme = isDark ? "light" : "dark";
  body.classList.remove("theme-light", "theme-dark");
  body.classList.add(`theme-${newTheme}`);
  localStorage.setItem("theme", newTheme);
  if (themeIcon) themeIcon.className = newTheme === "dark" ? "fa-solid fa-sun" : "fa-solid fa-moon";
});

function updateClock() {
  const el = document.getElementById("clock");
  if (!el) return;
  const now = new Date();
  el.textContent =
    now.toLocaleDateString("pt-BR") +
    " • " +
    now.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
}
setInterval(updateClock, 1000);
updateClock();

// =============================================================================
// CONSUMO DE API
// =============================================================================
async function fetchPlants() {
  const res = await apiFetch("/plants");
  if (!res.ok) throw new Error("Erro ao buscar plantas");
  const data = await res.json();

  if (data && data.body) {
    const parsed = typeof data.body === "string" ? JSON.parse(data.body) : data.body;
    return Array.isArray(parsed) ? parsed : [];
  }
  return Array.isArray(data) ? data : [];
}

async function fetchPlantDeviceOptions(plantId) {
  if (plantId == null || !String(plantId).match(/^\d+$/)) return [];

  const res = await apiFetch(`/plants/${plantId}/devices/options`);
  if (!res.ok) throw new Error("Erro ao buscar equipamentos da usina");

  const data = await res.json();
  if (data && data.body) {
    const parsed = typeof data.body === "string" ? JSON.parse(data.body) : data.body;
    return Array.isArray(parsed?.items) ? parsed.items : (Array.isArray(parsed) ? parsed : []);
  }
  return Array.isArray(data?.items) ? data.items : (Array.isArray(data) ? data : []);
}


async function fetchPlantsSummary() {
  const res = await apiFetch("/plants/summary");
  if (!res.ok) throw new Error("Erro ao buscar summary global");

  const data = await res.json();
  if (data && data.body) {
    return typeof data.body === "string" ? JSON.parse(data.body) : data.body;
  }
  return data; // esperado: {gen,no_comm,off,total}
}

function refreshTopChipsGlobalFromSummary(summary) {
  const gen = Number(summary?.gen ?? 0) || 0;
  const noComm = Number(summary?.no_comm ?? summary?.noComm ?? 0) || 0;
  const off = Number(summary?.off ?? 0) || 0;
  const total = Number(summary?.total ?? (gen + noComm + off) ?? 0) || 0;

  setChipCount("countGen", gen, `Gerando (global): ${gen} de ${total}`);
  setChipCount("countNoComm", noComm, `Sem comunicação (global): ${noComm} de ${total}`);
  setChipCount("countOff", off, `Off (global): ${off} de ${total}`);

  console.log("[INV CHIPS - GLOBAL SUMMARY]", { total, gen, noComm, off });
}

// ✅ ALARMES: NÃO MEXI
async function fetchActiveAlarms() {
  const res = await apiFetch("/alarms/active");
  if (!res.ok) throw new Error("Erro ao buscar alarmes ativos");
  const data = await res.json();

  if (data && data.body) {
    const parsed = typeof data.body === "string" ? JSON.parse(data.body) : data.body;
    return Array.isArray(parsed) ? parsed : [];
  }
  return Array.isArray(data) ? data : [];
}

async function fetchAcknowledgedAlarms() {
  const res = await apiFetch("/alarms/history");
  if (!res.ok) throw new Error("Erro ao buscar alarmes reconhecidos");
  const data = await res.json();
  const parsed = (data && data.body)
    ? (typeof data.body === "string" ? JSON.parse(data.body) : data.body)
    : data;
  return Array.isArray(parsed) ? parsed : [];
}

async function acknowledgeAlarm(alarm, acknowledgmentNote = "") {
  const user = JSON.parse(localStorage.getItem("user") || "{}");

  const alarmId = alarm?.id || alarm?.event_row_id;
  if (!alarmId) {
    throw new Error("Alarme sem id/event_row_id");
  }

  const res = await apiFetch(`/alarms/${alarmId}/ack`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      event_row_id: alarm.event_row_id || alarm.id,
      power_plant_id: alarm.power_plant_id,
      acknowledged_by: user?.username || user?.name || user?.email || "operador",
      acknowledgment_note: acknowledgmentNote && String(acknowledgmentNote).trim()
        ? String(acknowledgmentNote).trim()
        : null
    })
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Falha ao reconhecer alarme (${res.status}) ${txt}`);
  }

  const data = await res.json().catch(() => ({}));
  return data && data.body
    ? (typeof data.body === "string" ? JSON.parse(data.body) : data.body)
    : data;
}

/**
 * ✅ Busca eventos (corrigido)
 */
async function fetchEventsSafeBackend({
  start_time,
  end_time,
  page = 1,
  page_size = 30,
  severity,
  event_type,
  status,
  q,
  source,
  device_id,
  plant_id,
  mode = "normal",
  rounds = 5,
  include_total = true,
  _retry = 0
} = {}) {
  if (!start_time || !end_time) {
    const end = new Date();
    const start = new Date();
    start.setDate(end.getDate() - 7);
    start_time = start.toISOString();
    end_time = end.toISOString();
  }

  const fixed = clampEventRange(start_time, end_time);
  start_time = fixed.startISO;
  end_time = fixed.endISO;

  const params = new URLSearchParams({
    start_time,
    end_time,
    page: String(page),
    page_size: String(page_size)
  });

  const md = String(mode || "").toLowerCase();
  if (md) params.append("mode", md);
  if (md === "round_robin") params.append("rounds", String(rounds || 5));
  if (include_total) params.append("include_total", "1");

  if (plant_id != null && String(plant_id).match(/^\d+$/)) params.append("plant_id", String(plant_id));

  const sev = String(severity || "").toLowerCase();
  if (sev && sev !== "all") params.append("severity", sev);

  const et = String(event_type || "").toLowerCase();
  const allowedEventTypes = new Set(["all", "alarm", "event", "status"]);
  if (allowedEventTypes.has(et) && et !== "all") params.append("event_type", et);

  const st = String(status || "").toLowerCase();
  const allowedStatus = new Set(["all", "active", "inactive"]);
  if (allowedStatus.has(st) && st !== "all") params.append("status", st);

  const src = String(source || "").toLowerCase();
  const allowedSources = new Set(["inverter", "relay", "weather"]);
  if (allowedSources.has(src)) params.append("source", src);

  if (device_id != null && String(device_id).match(/^\d+$/)) params.append("device_id", String(device_id));

  const qv = safeTrim(q);
  if (qv) params.append("q", qv);

  if (eventsAbortController) eventsAbortController.abort();
  eventsAbortController = new AbortController();

  const url = `/events?${params.toString()}`;
  console.log("[EVENTS] GET", url);

  let res;
  try {
    res = await apiFetch(url, { signal: eventsAbortController.signal });
  } catch (e) {
    if (String(e?.name) === "AbortError") throw e;
    throw e;
  }

  if (!res.ok && res.status >= 500 && _retry < 1) {
    const waitMs = 600;
    console.warn(`[EVENTS] server ${res.status}. retry em ${waitMs}ms...`);
    await new Promise(r => setTimeout(r, waitMs));
    return fetchEventsSafeBackend({
      start_time, end_time, page, page_size, severity, event_type, status, q, source, device_id, plant_id, mode, rounds, include_total,
      _retry: _retry + 1
    });
  }

  if (!res.ok) {
    let bodyText = "";
    try { bodyText = await res.text(); } catch {}
    const err = new Error(`Erro ao buscar eventos (HTTP ${res.status})`);
    err.status = res.status;
    err.body = bodyText;
    err.url = url;
    throw err;
  }

  const data = await res.json();
  if (data && data.body) {
    const parsed = typeof data.body === "string" ? JSON.parse(data.body) : data.body;
    return parsed;
  }
  return data;
}

// =============================================================================
// EVENTS UI: elementos do filtro (IDs FIXOS)
// =============================================================================
function findButtonByText(text) {
  const t = String(text || "").toLowerCase();
  const btns = Array.from(document.querySelectorAll("button"));
  return btns.find(b => String(b.textContent || "").trim().toLowerCase() === t) || null;
}

function getEventsUIElements() {
  const startDateTime = document.getElementById("eventsStartDateTimeInput");
  const endDateTime = document.getElementById("eventsEndDateTimeInput");
  const severitySelect = document.getElementById("eventsSeveritySelect");
  const typeSelect = document.getElementById("eventsTypeSelect");
  const statusSelect = document.getElementById("eventsStatusSelect");
  const plantSelect = document.getElementById("eventsPlantSelect");
  const equipmentSelect = document.getElementById("eventsEquipmentSelect");
  const desc = document.getElementById("eventsDescriptionInput");

  const applyBtn = document.getElementById("eventsApplyBtn") || findButtonByText("apply");
  const clearBtn = document.getElementById("eventsClearBtn") || findButtonByText("clear");

  const prevBtn = document.getElementById("eventsPrevBtn");
  const nextBtn = document.getElementById("eventsNextBtn");
  const pageLabel = document.getElementById("eventsPageLabel");

  return {
    startDateTime, endDateTime,
    severitySelect, typeSelect, statusSelect,
    plantSelect, equipmentSelect, desc,
    applyBtn, clearBtn, prevBtn, nextBtn, pageLabel
  };
}

function ensureSeveritySelectOptions() {
  const ui = getEventsUIElements();
  const sel = ui.severitySelect;
  if (!sel || sel.tagName !== "SELECT") return;

  sel.innerHTML = "";
  [
    { value: "all", text: "All" },
    { value: "high", text: "High" },
    { value: "medium", text: "Medium" },
    { value: "low", text: "Low" }
  ].forEach(o => {
    const opt = document.createElement("option");
    opt.value = o.value;
    opt.textContent = o.text;
    sel.appendChild(opt);
  });

  if (!sel.value) sel.value = "all";
}

function ensureTypeSelectOptions() {
  const ui = getEventsUIElements();
  const sel = ui.typeSelect;
  if (!sel || sel.tagName !== "SELECT") return;

  const previous = String(sel.value || "all");
  sel.innerHTML = "";
  [
    { value: "all", text: "All" },
    { value: "alarm", text: "Alarm" },
    { value: "event", text: "Event" },
    { value: "status", text: "Status" }
  ].forEach(o => {
    const opt = document.createElement("option");
    opt.value = o.value;
    opt.textContent = o.text;
    sel.appendChild(opt);
  });

  sel.value = [...sel.options].some(o => o.value === previous) ? previous : "all";
}

function ensureStatusSelectOptions() {
  const ui = getEventsUIElements();
  const sel = ui.statusSelect;
  if (!sel || sel.tagName !== "SELECT") return;

  const previous = String(sel.value || "all");
  sel.innerHTML = "";
  [
    { value: "all", text: "All" },
    { value: "active", text: "Active" },
    { value: "inactive", text: "Inactive" }
  ].forEach(o => {
    const opt = document.createElement("option");
    opt.value = o.value;
    opt.textContent = o.text;
    sel.appendChild(opt);
  });

  sel.value = [...sel.options].some(o => o.value === previous) ? previous : "all";
}

function datetimeLocalToISO(value) {
  const raw = safeTrim(value);
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function toDateTimeLocalInputValue(d) {
  const dt = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(dt.getTime())) return "";
  const yyyy = dt.getFullYear();
  const mm = String(dt.getMonth() + 1).padStart(2, "0");
  const dd = String(dt.getDate()).padStart(2, "0");
  const hh = String(dt.getHours()).padStart(2, "0");
  const mi = String(dt.getMinutes()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}T${hh}:${mi}`;
}

function ensureDefaultEventsDateTimes() {
  const ui = getEventsUIElements();
  if (!ui.startDateTime || !ui.endDateTime) return;

  if (!safeTrim(ui.endDateTime.value)) {
    ui.endDateTime.value = toDateTimeLocalInputValue(new Date());
  }

  if (!safeTrim(ui.startDateTime.value)) {
    const start = new Date();
    start.setHours(start.getHours() - 1);
    ui.startDateTime.value = toDateTimeLocalInputValue(start);
  }
}

function populateEventsPlantSelect(plants) {
  const ui = getEventsUIElements();
  const sel = ui.plantSelect;
  if (!sel || sel.tagName !== "SELECT") return;

  const previous = String(sel.value || "all");
  sel.innerHTML = "";

  const allOpt = document.createElement("option");
  allOpt.value = "all";
  allOpt.textContent = "Todas";
  sel.appendChild(allOpt);

  (Array.isArray(plants) ? plants : []).forEach((p) => {
    const plantId = p.power_plant_id ?? p.plant_id ?? p.id;
    const plantName = p.power_plant_name ?? p.plant_name ?? p.name ?? `Usina ${plantId}`;
    if (plantId == null) return;
    const opt = document.createElement("option");
    opt.value = String(plantId);
    opt.textContent = String(plantName);
    sel.appendChild(opt);
  });

  sel.value = [...sel.options].some(o => o.value === previous) ? previous : "all";
}

function populateEventsEquipmentSelect(devices) {
  const ui = getEventsUIElements();
  const sel = ui.equipmentSelect;
  if (!sel || sel.tagName !== "SELECT") return;

  const previous = String(sel.value || "all");
  sel.innerHTML = "";

  const allOpt = document.createElement("option");
  allOpt.value = "all";
  allOpt.textContent = "Todos";
  sel.appendChild(allOpt);

  (Array.isArray(devices) ? devices : []).forEach((d) => {
    const deviceId = d.device_id ?? d.id;
    if (deviceId == null) return;
    const label = d.label || [d.device_type, d.device_name].filter(Boolean).join(" • ") || `Device ${deviceId}`;
    const opt = document.createElement("option");
    opt.value = String(deviceId);
    opt.textContent = String(label);
    sel.appendChild(opt);
  });

  sel.value = [...sel.options].some(o => o.value === previous) ? previous : "all";
}

async function refreshEventsEquipmentOptionsForPlant(plantId) {
  if (plantId == null || !String(plantId).match(/^\d+$/)) {
    populateEventsEquipmentSelect([]);
    return;
  }

  try {
    const devices = await fetchPlantDeviceOptions(plantId);
    populateEventsEquipmentSelect(devices);
  } catch (e) {
    console.warn("[EVENTS] erro ao carregar equipamentos:", e?.message || e);
    populateEventsEquipmentSelect([]);
  }
}

// =============================================================================
// filtros: Events legado (datetime-local + selects)
// =============================================================================
function getEventsFiltersFromUI() {
  const ui = getEventsUIElements();

  let start_time = datetimeLocalToISO(ui.startDateTime?.value);
  let end_time = datetimeLocalToISO(ui.endDateTime?.value);

  const fixed = clampEventRange(start_time, end_time);
  start_time = fixed.startISO;
  end_time = fixed.endISO;

  let severity = "all";
  if (ui.severitySelect) severity = String(ui.severitySelect.value || "all").trim().toLowerCase() || "all";

  let event_type = "all";
  if (ui.typeSelect) event_type = String(ui.typeSelect.value || "all").trim().toLowerCase() || "all";

  let status = "all";
  if (ui.statusSelect) status = String(ui.statusSelect.value || "all").trim().toLowerCase() || "all";

  const q = safeTrim(ui.desc?.value);

  const plant_id = (ui.plantSelect && ui.plantSelect.value !== "all" && String(ui.plantSelect.value).match(/^\d+$/))
    ? Number(ui.plantSelect.value)
    : null;

  const device_id = (ui.equipmentSelect && ui.equipmentSelect.value !== "all" && String(ui.equipmentSelect.value).match(/^\d+$/))
    ? Number(ui.equipmentSelect.value)
    : null;

  return { start_time, end_time, plant_id, severity, event_type, status, q, source: null, device_id };
}

function updateEventsPaginationUI(pagination) {
  EVENTS_STATE.page = pagination?.page || EVENTS_STATE.page;
  EVENTS_STATE.page_size = pagination?.page_size || EVENTS_STATE.page_size;

  const total = pagination?.total;
  const total_pages = pagination?.total_pages;

  if (total != null) EVENTS_STATE.total = Number.isFinite(Number(total)) ? Number(total) : EVENTS_STATE.total;
  if (total_pages != null) EVENTS_STATE.total_pages = Number.isFinite(Number(total_pages)) ? Number(total_pages) : EVENTS_STATE.total_pages;

  const { prevBtn, nextBtn, pageLabel } = getEventsUIElements();

  if (pageLabel) {
    const tp = EVENTS_STATE.total_pages ? Math.max(1, EVENTS_STATE.total_pages) : "?";
    const tt = (EVENTS_STATE.total != null && Number.isFinite(Number(EVENTS_STATE.total))) ? Number(EVENTS_STATE.total) : "—";
    pageLabel.textContent = `Página ${EVENTS_STATE.page} / ${tp} • Total ${tt}`;
  }

  if (prevBtn) prevBtn.disabled = EVENTS_STATE.page <= 1;
  if (nextBtn) nextBtn.disabled = EVENTS_STATE.total_pages > 0 ? EVENTS_STATE.page >= EVENTS_STATE.total_pages : false;
}

function wireEventsFiltersOnce() {
  if (EVENTS_STATE.wired) return;
  EVENTS_STATE.wired = true;

  ensureSeveritySelectOptions();
  ensureTypeSelectOptions();
  ensureStatusSelectOptions();
  populateEventsPlantSelect(lastValidPlants);
  populateEventsEquipmentSelect([]);

  const ui = getEventsUIElements();

  if (ui.severitySelect) {
    ui.severitySelect.addEventListener("change", () => {
      EVENTS_STATE.page = 1;
      loadEvents(1);
    });
  }

  if (ui.typeSelect) {
    ui.typeSelect.addEventListener("change", () => {
      EVENTS_STATE.page = 1;
      loadEvents(1);
    });
  }

  if (ui.statusSelect) {
    ui.statusSelect.addEventListener("change", () => {
      EVENTS_STATE.page = 1;
      loadEvents(1);
    });
  }

  if (ui.plantSelect) {
    ui.plantSelect.addEventListener("change", async () => {
      await refreshEventsEquipmentOptionsForPlant(ui.plantSelect.value);
      EVENTS_STATE.page = 1;
      loadEvents(1);
    });
  }

  if (ui.equipmentSelect) {
    ui.equipmentSelect.addEventListener("change", () => {
      EVENTS_STATE.page = 1;
      loadEvents(1);
    });
  }

  const textInputs = [ui.desc].filter(Boolean);
  textInputs.forEach(el => {
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        EVENTS_STATE.page = 1;
        loadEvents(1);
      }
    });
  });

  if (ui.applyBtn) {
    ui.applyBtn.addEventListener("click", () => {
      EVENTS_STATE.page = 1;
      loadEvents(1);
    });
  }

  if (ui.clearBtn) {
    ui.clearBtn.addEventListener("click", () => {
      const ui2 = getEventsUIElements();

      if (ui2.desc) ui2.desc.value = "";
      if (ui2.typeSelect) ui2.typeSelect.value = "all";
      if (ui2.statusSelect) ui2.statusSelect.value = "all";
      if (ui2.severitySelect) ui2.severitySelect.value = "all";
      if (ui2.plantSelect) ui2.plantSelect.value = "all";
      populateEventsEquipmentSelect([]);
      if (ui2.startDateTime) ui2.startDateTime.value = "";
      if (ui2.endDateTime) ui2.endDateTime.value = "";
      ensureDefaultEventsDateTimes();

      EVENTS_STATE.page = 1;
      loadEvents(1);
    });
  }

  if (ui.prevBtn) ui.prevBtn.addEventListener("click", () => { if (EVENTS_STATE.page > 1) loadEvents(EVENTS_STATE.page - 1); });
  if (ui.nextBtn) ui.nextBtn.addEventListener("click", () => { loadEvents(EVENTS_STATE.page + 1); });
}

// =============================================================================
// AUTO-REFRESH DO EVENTS (sem F5)
// =============================================================================
function startEventsAutoRefresh() {
  stopEventsAutoRefresh();
  EVENTS_STATE.autoTimer = setInterval(() => {
    const evView = document.getElementById("eventsView");
    const isVisible = evView && !evView.classList.contains("hidden");
    if (isVisible) loadEvents(EVENTS_STATE.page || 1, { silent: true });
  }, EVENTS_REFRESH_INTERVAL_MS);
}

function stopEventsAutoRefresh() {
  if (EVENTS_STATE.autoTimer) clearInterval(EVENTS_STATE.autoTimer);
  EVENTS_STATE.autoTimer = null;
}

// =============================================================================
// RENDERIZAÇÃO DA INTERFACE (ALARMS) — NÃO MEXI
// =============================================================================
let ACK_MODAL_READY = false;

function ensureAckModal() {
  if (ACK_MODAL_READY) return;

  const style = document.createElement("style");
  style.id = "ack-modal-styles";
  style.textContent = `
    .ack-modal-overlay{
      position: fixed;
      inset: 0;
      background: rgba(0,0,0,.72);
      backdrop-filter: blur(6px);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 99999;
      padding: 20px;
    }
    .ack-modal{
      width: min(520px, 100%);
      border-radius: 18px;
      background:
        radial-gradient(600px 160px at 12% 0%, rgba(57,229,140,.10), transparent 60%),
        linear-gradient(180deg, rgba(10,18,15,.98), rgba(4,9,7,.98));
      border: 1px solid rgba(57,229,140,.18);
      box-shadow:
        0 24px 60px rgba(0,0,0,.55),
        0 0 30px rgba(57,229,140,.08),
        inset 0 1px 0 rgba(255,255,255,.04);
      overflow: hidden;
      animation: ackModalEnter .18s ease;
    }
    @keyframes ackModalEnter{
      from{ opacity:0; transform: translateY(8px) scale(.985); }
      to{ opacity:1; transform: translateY(0) scale(1); }
    }
    .ack-modal__header{
      padding: 18px 20px 12px;
      border-bottom: 1px solid rgba(255,255,255,.06);
    }
    .ack-modal__title{
      margin: 0;
      color: #eafff3;
      font-size: 18px;
      font-weight: 700;
      letter-spacing: .02em;
    }
    .ack-modal__subtitle{
      margin-top: 6px;
      color: rgba(185,235,208,.72);
      font-size: 13px;
      line-height: 1.45;
    }
    .ack-modal__body{
      padding: 18px 20px 10px;
    }
    .ack-modal__alarm{
      margin-bottom: 14px;
      padding: 12px 14px;
      border-radius: 12px;
      background: rgba(255,255,255,.03);
      border: 1px solid rgba(57,229,140,.10);
      color: rgba(233,255,243,.92);
      line-height: 1.45;
      font-size: 13px;
    }
    .ack-modal__label{
      display: block;
      margin-bottom: 8px;
      color: #9adbb8;
      font-size: 12px;
      font-weight: 700;
      letter-spacing: .05em;
      text-transform: uppercase;
    }
    .ack-modal__textarea{
      width: 100%;
      min-height: 120px;
      resize: vertical;
      border-radius: 14px;
      border: 1px solid rgba(57,229,140,.18);
      background: rgba(6,12,10,.92);
      color: #e9fff3;
      padding: 14px 14px;
      outline: none;
      font-size: 14px;
      line-height: 1.5;
      box-shadow: inset 0 1px 0 rgba(255,255,255,.03);
    }
    .ack-modal__textarea:focus{
      border-color: rgba(57,229,140,.42);
      box-shadow:
        0 0 0 3px rgba(57,229,140,.08),
        0 0 16px rgba(57,229,140,.12);
    }
    .ack-modal__hint{
      margin-top: 8px;
      font-size: 12px;
      color: rgba(185,235,208,.62);
    }
    .ack-modal__footer{
      display: flex;
      justify-content: flex-end;
      gap: 10px;
      padding: 16px 20px 20px;
    }
    .ack-btn{
      height: 42px;
      border-radius: 12px;
      border: 1px solid rgba(255,255,255,.08);
      padding: 0 16px;
      font-size: 13px;
      font-weight: 700;
      cursor: pointer;
      transition: all .16s ease;
    }
    .ack-btn--ghost{
      background: rgba(255,255,255,.04);
      color: rgba(233,255,243,.86);
    }
    .ack-btn--ghost:hover{
      background: rgba(255,255,255,.07);
    }
    .ack-btn--confirm{
      background: rgba(57,229,140,.10);
      border-color: rgba(57,229,140,.28);
      color: #cffff0;
      box-shadow: 0 0 18px rgba(57,229,140,.08);
    }
    .ack-btn--confirm:hover{
      background: rgba(57,229,140,.16);
      border-color: rgba(57,229,140,.42);
      box-shadow: 0 0 24px rgba(57,229,140,.14);
    }
    .ack-modal__confirm-box{
      margin-top: 14px;
      padding: 12px 14px;
      border-radius: 12px;
      border: 1px solid rgba(255,186,65,.18);
      background: rgba(255,186,65,.06);
      color: rgba(255,241,214,.92);
      font-size: 13px;
      line-height: 1.45;
    }
    .ack-modal__confirm-actions{
      display: flex;
      justify-content: flex-end;
      gap: 10px;
      margin-top: 12px;
    }
    .ack-modal .hidden{ display: none; }
  `;
  document.head.appendChild(style);
  ACK_MODAL_READY = true;
}

function openAckModal(alarm) {
  ensureAckModal();
  return new Promise((resolve) => {
    const plantLabel = alarm?.power_plant_name || "—";
    const deviceTypeLabel = alarm?.device_type_name || alarm?.device_type || "—";
    const deviceLabel = alarm?.device_name ? `${deviceTypeLabel} • ${alarm.device_name}` : (alarm?.device_id || "—");
    const eventName =
      alarm?.event_name && String(alarm.event_name).trim()
        ? String(alarm.event_name).trim()
        : getAlarmDescription(alarm?.event_code);

    const overlay = document.createElement("div");
    overlay.className = "ack-modal-overlay";
    overlay.innerHTML = `
      <div class="ack-modal" role="dialog" aria-modal="true" aria-labelledby="ackModalTitle">
        <div class="ack-modal__header">
          <h3 class="ack-modal__title" id="ackModalTitle">Reconhecer alerta</h3>
          <div class="ack-modal__subtitle">
            Confirme o reconhecimento do alerta e registre uma observação para histórico.
          </div>
        </div>
        <div class="ack-modal__body">
          <div class="ack-modal__alarm">
            <strong>${plantLabel}</strong><br>
            ${deviceLabel}<br>
            ${eventName}
          </div>
          <label class="ack-modal__label" for="ackModalTextarea">Observação do reconhecimento</label>
          <textarea id="ackModalTextarea" class="ack-modal__textarea" placeholder="Ex.: equipe acionada, verificação em campo, evento validado..."></textarea>
          <div class="ack-modal__hint">
            Essa descrição será salva no banco em <strong>acknowledgment_note</strong>.
          </div>
          <div class="ack-modal__confirm-box hidden" id="ackModalConfirmBox">
            Tem certeza que deseja reconhecer este alerta com essa observação?
            <div class="ack-modal__confirm-actions">
              <button type="button" class="ack-btn ack-btn--ghost" id="ackModalBackBtn">Voltar</button>
              <button type="button" class="ack-btn ack-btn--confirm" id="ackModalFinalConfirmBtn">Confirmar envio</button>
            </div>
          </div>
        </div>
        <div class="ack-modal__footer">
          <button type="button" class="ack-btn ack-btn--ghost" id="ackModalCancelBtn">Cancelar</button>
          <button type="button" class="ack-btn ack-btn--confirm" id="ackModalContinueBtn">Continuar</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    const textarea = overlay.querySelector("#ackModalTextarea");
    const cancelBtn = overlay.querySelector("#ackModalCancelBtn");
    const continueBtn = overlay.querySelector("#ackModalContinueBtn");
    const confirmBox = overlay.querySelector("#ackModalConfirmBox");
    const backBtn = overlay.querySelector("#ackModalBackBtn");
    const finalConfirmBtn = overlay.querySelector("#ackModalFinalConfirmBtn");

    const close = (result) => {
      overlay.remove();
      resolve(result);
    };

    requestAnimationFrame(() => textarea?.focus());
    cancelBtn?.addEventListener("click", () => close(null));
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) close(null);
    });
    document.addEventListener("keydown", function escHandler(e) {
      if (e.key === "Escape") {
        document.removeEventListener("keydown", escHandler);
        close(null);
      }
    }, { once: true });
    continueBtn?.addEventListener("click", () => confirmBox?.classList.remove("hidden"));
    backBtn?.addEventListener("click", () => confirmBox?.classList.add("hidden"));
    finalConfirmBtn?.addEventListener("click", () => close(textarea?.value ?? ""));
  });
}

function openAckDetailsModal(alarm) {
  ensureAckModal();
  const overlay = document.createElement("div");
  overlay.className = "ack-modal-overlay";

  const plantLabel = alarm?.power_plant_name || "—";
  const deviceTypeLabel = alarm?.device_type_name || alarm?.device_type || "—";
  const deviceLabel = alarm?.device_name ? `${deviceTypeLabel} • ${alarm.device_name}` : (alarm?.device_id || "—");
  const baseDesc =
    alarm?.event_name && String(alarm.event_name).trim()
      ? String(alarm.event_name).trim()
      : getAlarmDescription(alarm?.event_code);
  const ackBy = alarm?.acknowledged_by ? String(alarm.acknowledged_by).trim() : "—";
  const ackAt = alarm?.acknowledged_at ? new Date(alarm.acknowledged_at).toLocaleString("pt-BR") : "—";
  const ackNote = alarm?.acknowledgment_note ? String(alarm.acknowledgment_note).trim() : "—";

  overlay.innerHTML = `
    <div class="ack-modal" role="dialog" aria-modal="true" aria-labelledby="ackDetailsTitle">
      <div class="ack-modal__header">
        <h3 class="ack-modal__title" id="ackDetailsTitle">Detalhes do reconhecimento</h3>
        <div class="ack-modal__subtitle">Acknowledge note</div>
      </div>
      <div class="ack-modal__body">
        <div class="ack-modal__alarm">
          <strong>${plantLabel}</strong><br>
          ${deviceLabel}<br>
          ${baseDesc}
        </div>
        <div class="ack-modal__hint"><strong>Ack by:</strong> ${ackBy}</div>
        <div class="ack-modal__hint"><strong>Acknowledged at:</strong> ${ackAt}</div>
        <label class="ack-modal__label">Acknowledge note</label>
        <div class="ack-modal__alarm" style="white-space:pre-wrap;">${ackNote}</div>
      </div>
      <div class="ack-modal__footer">
        <button type="button" class="ack-btn ack-btn--confirm" id="ackDetailsCloseBtn">Fechar</button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.querySelector("#ackDetailsCloseBtn")?.addEventListener("click", close);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });
}

function sortRecognizedAlarms(list) {
  const arr = Array.isArray(list) ? list.slice() : [];
  const ts = (a) => Date.parse(a?.acknowledged_at || "") || 0;
  return arr.sort((a, b) => ts(b) - ts(a));
}

function sortActiveAlarms(list) {
  const arr = Array.isArray(list) ? list.slice() : [];
  const ts = (a) => Date.parse(a?.started_at || a?.timestamp || "") || 0;
  return arr.sort((a, b) => ts(b) - ts(a));
}

function ensureAlarmsHeader(isRecognized) {
  const tr = document.querySelector(".alarms-table thead tr");
  if (!tr) return;
  tr.innerHTML = isRecognized
    ? "<th>Pathname</th><th>Description</th><th>Ack By</th><th>Ack Note</th><th>State</th><th>Timestamp</th>"
    : "<th>Pathname</th><th>Description</th><th>State</th><th>Timestamp</th>";
}

async function renderAlarmsTable(isRecognized = false, { force = false } = {}) {
  const tbody = document.getElementById("alarmsTbody");
  if (!tbody) return;

  const renderSeq = ++ALARMS_RENDER_SEQ;
  ensureAlarmsHeader(isRecognized);

  let alarms = [];
  try {
    if (isRecognized) {
      const fetched = await fetchAcknowledgedAlarms();
      alarms = [...LOCAL_ACKED_ALARMS, ...fetched].filter(a => {
        return a?.acknowledged === true || a?.acknowledged === "true";
      });
      LOCAL_ACKED_ALARMS = sortRecognizedAlarms(dedupeAlarms(alarms)).slice(0, 500);
      alarms = LOCAL_ACKED_ALARMS.slice();
    } else {
      alarms = (await fetchActiveAlarms()).filter(a => {
        const state = String(a.alarm_state || a.state || "").toUpperCase();
        const id = String(a?.event_row_id ?? a?.id ?? "");
        const locallyAcked = LOCAL_ACKED_ALARMS.some((x) => String(x?.event_row_id ?? x?.id ?? "") === id);
        return state === "ACTIVE" && !locallyAcked;
      });
      alarms = sortActiveAlarms(alarms);
    }
  } catch (err) {
    console.error("Erro ao buscar alarmes:", err);
  }

  if (renderSeq !== ALARMS_RENDER_SEQ) return;

  alarms = dedupeAlarms(alarms);
  alarms = isRecognized ? sortRecognizedAlarms(alarms) : sortActiveAlarms(alarms);

  const renderKey = buildAlarmRenderKey(alarms, isRecognized);
  const nextMode = isRecognized ? "recognized" : "active";
  const modeChanged = CURRENT_ALARMS_TAB_MODE !== nextMode;

  if (!force && !modeChanged) {
    if (isRecognized) {
      if (renderKey === LAST_RECOGNIZED_ALARMS_RENDER_KEY) return;
    } else {
      if (renderKey === LAST_ACTIVE_ALARMS_RENDER_KEY) return;
    }
  }

  if (isRecognized) {
    LAST_RECOGNIZED_ALARMS_RENDER_KEY = renderKey;
  } else {
    LAST_ACTIVE_ALARMS_RENDER_KEY = renderKey;
  }
  CURRENT_ALARMS_TAB_MODE = nextMode;

  tbody.innerHTML = "";

  if (!alarms || alarms.length === 0) {
    tbody.innerHTML = `<tr><td colspan="${isRecognized ? 6 : 4}" style="text-align:center; opacity:0.6; padding:40px;">${isRecognized ? "Nenhum alerta reconhecido" : "Nenhum alerta ativo"}</td></tr>`;
    return;
  }

  alarms.forEach(alarm => {
    if (renderSeq !== ALARMS_RENDER_SEQ) return;
    const tr = document.createElement("tr");
    const sev = normalizeAlarmSeverity(
      alarm.severity || alarm.alarm_severity || alarm.level || alarm.alarm_level
    ) || "low";

    const timestamp = isRecognized
      ? (
          alarm.acknowledged_at ||
          alarm.cleared_at ||
          alarm.timestamp ||
          alarm.started_at ||
          "—"
        )
      : (
          alarm.started_at ||
          alarm.timestamp ||
          alarm.last_event_ts ||
          "—"
        );

    const tsFormatted = timestamp !== "—" ? new Date(timestamp).toLocaleString("pt-BR") : "—";

    const rawState = String(alarm.alarm_state || alarm.state || "—").toUpperCase();
    const state = isRecognized ? "ACK" : rawState;
    const stateColor =
      state === "ACTIVE" ? "#f44336" :
      state === "ACK" ? "#ff9800" :
      state === "CLEARED" ? "#4caf50" :
      "#ccc";

    const plantLabel = alarm.power_plant_name ? alarm.power_plant_name : "—";
    const deviceTypeLabel =
      alarm.device_type_name ||
      alarm.device_type ||
      "—";

    const deviceLabel = alarm.device_name
      ? `${deviceTypeLabel} • ${alarm.device_name}`
      : (alarm.device_id || "—");

    const baseDesc =
      alarm.event_name && String(alarm.event_name).trim() !== ""
        ? alarm.event_name
        : getAlarmDescription(alarm.event_code);
    const ackBy = alarm.acknowledged_by ? String(alarm.acknowledged_by).trim() : "";
    const ackNote = alarm.acknowledgment_note ? String(alarm.acknowledgment_note).trim() : "";
    if (isRecognized) {
      tr.innerHTML = `
        <td>${plantLabel} • ${deviceLabel}</td>
        <td>${baseDesc}</td>
        <td>${valueOrDash(ackBy)}</td>
        <td>${ackNote ? `<button type="button" class="ack-note-link">Ver note</button>` : "—"}</td>
        <td class="alarm-state-pill" style="font-weight:bold; color:${stateColor};">${state}</td>
        <td>${tsFormatted}</td>
      `;
    } else {
      tr.innerHTML = `
        <td>${plantLabel} • ${deviceLabel}</td>
        <td>${baseDesc}</td>
        <td class="alarm-state-pill" style="font-weight:bold; color:${stateColor};">${state}</td>
        <td>${tsFormatted}</td>
      `;
    }

    if (!isRecognized) {
      tr.classList.add("alarm-row-attention", `alarm-row-attention--${sev}`);
      tr.style.cursor = "pointer";
      tr.title = "Clique duplo para reconhecer";
      tr.addEventListener("dblclick", async () => {
        try {
          if (!alarm?.event_row_id && !alarm?.id) return;
          const note = await openAckModal(alarm);
          if (note === null) return;
          const ackPayload = await acknowledgeAlarm(alarm, note);

          const user = JSON.parse(localStorage.getItem("user") || "{}");
          const ackByLocal = user?.username || user?.name || user?.email || "operador";
          const ackNowIso = new Date().toISOString();
          const recognizedAlarm = {
            ...alarm,
            ...(ackPayload && typeof ackPayload === "object" ? ackPayload : {}),
            acknowledged: true,
            acknowledged_by: (ackPayload?.acknowledged_by ?? ackByLocal),
            acknowledgment_note: (ackPayload?.acknowledgment_note ?? (note || null)),
            acknowledged_at: (ackPayload?.acknowledged_at ?? ackNowIso),
            alarm_state: (ackPayload?.alarm_state ?? "ACK"),
            state: (ackPayload?.state ?? "ACK")
          };

          const recognizedTab = document.querySelectorAll(".tab-btn")[1];
          if (recognizedTab) {
            document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
            recognizedTab.classList.add("active");
          }

          LAST_ACTIVE_ALARMS_RENDER_KEY = "";
          LAST_RECOGNIZED_ALARMS_RENDER_KEY = "";
          LOCAL_ACKED_ALARMS = sortRecognizedAlarms(dedupeAlarms([recognizedAlarm, ...LOCAL_ACKED_ALARMS])).slice(0, 500);

          await renderAlarmsTable(true);
        } catch (err) {
          console.error("Erro ao reconhecer alarme:", err);
          alert(err?.message || "Não foi possível reconhecer o alarme.");
        }
      });
    }

    if (isRecognized && ackNote) {
      requestAnimationFrame(() => {
        tr.querySelector(".ack-note-link")?.addEventListener("click", (e) => {
          e.stopPropagation();
          openAckDetailsModal(alarm);
        });
      });
    }

    tbody.appendChild(tr);
  });
}

// =============================================================================
// EVENTS: render + load
// =============================================================================
function ensureEventsHeaderHasSeverity(tbody) {
  const eventsTable = tbody?.closest("table");
  const thead = eventsTable?.querySelector("thead");
  const tr = thead?.querySelector("tr");
  if (!tr) return;

  tr.innerHTML = `<th>TIMESTAMP</th><th>USINA</th><th>EQUIPMENT</th><th>DESCRIPTION</th><th>TYPE</th><th>STATUS</th><th>SEVERITY</th>`;
}

async function loadEvents(page = 1, { silent = false } = {}) {
  const tbody = document.getElementById("eventsTbody");
  if (!tbody) return;

  if (EVENTS_STATE.loading) return;
  EVENTS_STATE.loading = true;

  try {
    wireEventsFiltersOnce();
    ensureDefaultEventsDateTimes();
    ensureSeveritySelectOptions();
    ensureTypeSelectOptions();
    ensureStatusSelectOptions();
    ensureEventsHeaderHasSeverity(tbody);

    if (!silent) {
      tbody.innerHTML = `
        <tr><td colspan="7" style="text-align:center; opacity:0.7; padding:40px;">Carregando...</td></tr>
      `;
    }

    const filters = getEventsFiltersFromUI();

    if (!filters.start_time || !filters.end_time) {
      const end = new Date();
      const start = new Date();
      start.setDate(end.getDate() - 7);
      filters.start_time = start.toISOString();
      filters.end_time = end.toISOString();
    }

    const response = await fetchEventsSafeBackend({
      start_time: filters.start_time,
      end_time: filters.end_time,
      page,
      page_size: EVENTS_STATE.page_size,
      severity: filters.severity,
      event_type: filters.event_type,
      status: filters.status,
      source: filters.source,
      device_id: filters.device_id,
      q: filters.q,
      plant_id: filters.plant_id,
      mode: EVENTS_VIEW_MODE,
      rounds: EVENTS_ROUNDS,
      include_total: true
    });

    const events = response?.items || [];
    const eventsRenderKey = buildEventsRenderKey(events, page, {
      start_time: filters.start_time,
      end_time: filters.end_time,
      severity: filters.severity,
      event_type: filters.event_type,
      status: filters.status,
      q: filters.q,
      plant_id: filters.plant_id,
      device_id: filters.device_id
    });

    updateEventsPaginationUI({
      page,
      page_size: EVENTS_STATE.page_size,
      total: response?.pagination?.total ?? null,
      total_pages: response?.pagination?.total_pages ?? null
    });

    if (!events.length) {
      LAST_EVENTS_RENDER_KEY = eventsRenderKey;
      tbody.innerHTML = `
        <tr><td colspan="7" style="text-align:center; opacity:0.6; padding:40px;">
          Nenhum evento registrado
        </td></tr>
      `;
      return;
    }

    if (eventsRenderKey === LAST_EVENTS_RENDER_KEY) {
      EVENTS_STATE.page = page;
      return;
    }
    LAST_EVENTS_RENDER_KEY = eventsRenderKey;

    tbody.innerHTML = "";

    events.forEach(ev => {
      const tr = document.createElement("tr");

      const ts = ev.event_ts ? new Date(ev.event_ts).toLocaleString("pt-BR") : "—";
      const plant = valueOrDash(ev.power_plant_name ?? ev.plant_name ?? ev.power_plant_id ?? ev.plant_id);

      const deviceLabel =
        ev.device_type && ev.device_name
          ? `${ev.device_type} • ${ev.device_name}`
          : (ev.device_name || ev.device_id || "—");

      const baseDesc = valueOrDash(ev.event_name ?? ev.description ?? ev.point_name ?? ev.event_code ?? ev.raw_key ?? "—");
      const ackBy = ev.acknowledged_by ? String(ev.acknowledged_by).trim() : "";
      const ackNote = ev.acknowledgment_note ? String(ev.acknowledgment_note).trim() : "";
      const desc = `
        <div>${baseDesc}</div>
        ${ackBy ? `<div class="ack-inline-meta">Ack by: ${ackBy}</div>` : ""}
        ${ackNote ? `<button type="button" class="ack-note-link">Ver note</button>` : ""}
      `;
      const type = valueOrDash(ev.event_type);
      const status = valueOrDash(ev.status ?? ev.event_status ?? ev.state);
      const sev = valueOrDash(ev.severity);

      tr.innerHTML = `
        <td>${ts}</td>
        <td>${plant}</td>
        <td>${deviceLabel}</td>
        <td>${desc}</td>
        <td>${type}</td>
        <td>${status}</td>
        <td style="font-weight:bold; color:${severityColor(sev)};">
          ${sev}
        </td>
      `;

      tbody.appendChild(tr);
      if (ackNote) {
        tr.querySelector(".ack-note-link")?.addEventListener("click", (e) => {
          e.stopPropagation();
          openAckDetailsModal(ev);
        });
      }
    });

    EVENTS_STATE.page = page;
  } catch (err) {
    if (String(err?.name) === "AbortError") return;

    console.error("Erro ao buscar eventos:", err?.message, err?.url, err?.body);
    tbody.innerHTML = `
      <tr><td colspan="7" style="text-align:center; color:#f44336; padding:40px;">
        Erro ao carregar eventos
      </td></tr>
    `;
  } finally {
    EVENTS_STATE.loading = false;
  }
}

// =============================================================================
// SUMMARY + PORTFOLIO
// =============================================================================
function updateSummaryUI(plants) {
  const validPlants = Array.isArray(plants) ? plants : [];

  let totalActivePower = 0;
  let totalRatedPower = 0;

  validPlants.forEach(p => {
    totalActivePower += Number(p?.active_power_kw ?? 0) || 0;
    totalRatedPower += Number(p?.rated_power_kw ?? p?.rated_power_kwp ?? 0) || 0;
  });

  const loadPct = totalRatedPower > 0 ? (totalActivePower / totalRatedPower) * 100 : 0;

  const elActive = document.querySelector("#activePower");
  const elRated = document.querySelector("#ratedPower");
  const elPercent = document.querySelector("#progressPercent");

  if (elActive) elActive.innerText = totalActivePower.toFixed(1) + " kW";
  if (elRated) elRated.innerText = totalRatedPower.toFixed(1) + " kWp";
  if (elPercent) elPercent.innerText = loadPct.toFixed(1) + "%";

  const elPsfActive = document.getElementById("psfActivePower");
  const elPsfRated = document.getElementById("psfRatedPower");
  const elPsfPercent = document.getElementById("psfCapacityPct");

  if (elPsfActive) elPsfActive.textContent = totalActivePower.toFixed(1) + " kW";
  if (elPsfRated) elPsfRated.textContent = totalRatedPower.toFixed(1) + " kWp";
  if (elPsfPercent) elPsfPercent.textContent = loadPct.toFixed(1) + "%";
}

function renderPortfolioTable(plants) {
  const tbody = document.getElementById("portfolioTbody");
  if (!tbody) return;

  const validPlants = Array.isArray(plants) ? plants : [];
  if (validPlants.length === 0) return;

  tbody.innerHTML = "";

  validPlants.forEach(plant => {
    const plantId = plant.power_plant_id ?? plant.plant_id ?? plant.id;
    const plantName = plant.power_plant_name ?? plant.plant_name ?? plant.name;
    const openPlantPage = () => {
      if (plantId == null) return;
      window.location.href = `plant.html?plant_id=${encodeURIComponent(plantId)}`;
    };

    const tr = document.createElement("tr");
    tr.classList.add("portfolio-row-linkable");
    tr.setAttribute("role", "link");
    tr.setAttribute("tabindex", "0");

    const alarmSeverity =
      normalizeAlarmSeverity(lastAlarmSeverityByPlant.get(plantId)) ||
      normalizeAlarmSeverity(lastAlarmSeverityByPlant.get(plantName)) ||
      null;
    const plantIconClass = alarmSeverity
      ? `plant-icon plant-icon--${alarmSeverity}`
      : "plant-icon plant-icon--ok";

    tr.innerHTML = `
      <td>
        <button class="plant-cell-btn" title="Abrir usina ${valueOrDash(plantName)}">
          <span class="plant-cell">
            <span class="${plantIconClass}" title="${alarmSeverity || "ok"}">
              <i class="fa-solid fa-seedling"></i>
            </span>
            <span class="plant-name-text">${valueOrDash(plantName)}</span>
          </span>
        </button>
      </td>
      <td class="metric-neutral">${Number(plant.rated_power_kw ?? 0).toFixed(1)} kWp</td>
      <td class="metric-active">${Number(plant.active_power_kw ?? 0).toFixed(1)} kW</td>
      <td class="metric-active">${Number(plant.energy_today_kwh ?? 0).toFixed(1)} kWh</td>
      <td>${plant.irradiance_wm2 != null ? Number(plant.irradiance_wm2).toFixed(0) + " W/m²" : "—"}</td>
      <td>${plant.inverter_availability_pct != null ? Number(plant.inverter_availability_pct).toFixed(1) + "%" : "—"}</td>
      <td>${plant.relay_availability_pct != null ? Number(plant.relay_availability_pct).toFixed(1) + "%" : "—"}</td>
      <td>${plant.pr_daily_pct != null ? Number(plant.pr_daily_pct).toFixed(1) + "%" : "—"}</td>
      <td>${plant.pr_accumulated_pct != null ? Number(plant.pr_accumulated_pct).toFixed(1) + "%" : "—"}</td>
      <td style="text-align:center;">
        <button class="plant-link-btn" title="Abrir usina" data-plant-id="${plantId}">
          <i class="fa-solid fa-arrow-up-right-from-square"></i>
        </button>
      </td>
    `;

    tr.querySelector(".plant-link-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      openPlantPage();
    });

    tr.querySelector(".plant-cell-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      openPlantPage();
    });

    tr.addEventListener("click", (e) => {
      if (e.target.closest("button")) return;
      openPlantPage();
    });

    tr.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      openPlantPage();
    });

    tbody.appendChild(tr);
  });
}

// =============================================================================
// DATA STUDIO
// =============================================================================

function dsSafeTrim(v) {
  if (v == null) return "";
  return String(v).trim();
}

function dsIsoStartOfDay(dateYYYYMMDD) {
  if (!dateYYYYMMDD) return null;
  const [y, m, d] = String(dateYYYYMMDD).split("-").map(Number);
  if (!y || !m || !d) return null;
  const dt = new Date(y, m - 1, d, 0, 0, 0, 0);
  return Number.isNaN(dt.getTime()) ? null : dt.toISOString();
}

function dsIsoEndOfDay(dateYYYYMMDD) {
  if (!dateYYYYMMDD) return null;
  const [y, m, d] = String(dateYYYYMMDD).split("-").map(Number);
  if (!y || !m || !d) return null;
  const dt = new Date(y, m - 1, d, 23, 59, 59, 999);
  return Number.isNaN(dt.getTime()) ? null : dt.toISOString();
}

function dsClampRange(startISO, endISO) {
  if (!startISO || !endISO) return { startISO, endISO };
  const s = new Date(startISO).getTime();
  const e = new Date(endISO).getTime();
  if (!Number.isFinite(s) || !Number.isFinite(e)) return { startISO, endISO };
  if (e < s) return { startISO: endISO, endISO: startISO };
  return { startISO, endISO };
}

function dsNormalizeApiBody(data) {
  if (data && Object.prototype.hasOwnProperty.call(data, "body")) {
    return typeof data.body === "string" ? JSON.parse(data.body) : data.body;
  }
  return data;
}

function dsNormalizeContextText(value) {
  return dsSafeTrim(value)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function dsContextMatches(tagContext, selectedContext) {
  if (!selectedContext || selectedContext === "all") return true;

  const tagNorm = dsNormalizeContextText(tagContext);
  const selectedNorm = dsNormalizeContextText(selectedContext);
  if (!tagNorm) return false;

  const tagNum = tagNorm.match(/\d+/)?.[0] || null;
  const selectedNum = selectedNorm.match(/\d+/)?.[0] || null;
  if (tagNum && selectedNum && tagNum === selectedNum) return true;

  return tagNorm.includes(selectedNorm) || selectedNorm.includes(tagNorm);
}

function getDataStudioUIElements() {
  return {
    startDateInput: document.getElementById("dsStartDateInput"),
    endDateInput: document.getElementById("dsEndDateInput"),
    plantSelect: document.getElementById("dsPlantSelect"),
    openTagsBtn: document.getElementById("dsOpenTagsBtn"),
    backToHeroBtn: document.getElementById("dsBackToHeroBtn"),
    exportBtn: document.getElementById("dsExportBtn"),
    zoomInBtn: document.getElementById("dsZoomInBtn"),
    zoomOutBtn: document.getElementById("dsZoomOutBtn"),
    zoomResetBtn: document.getElementById("dsZoomResetBtn"),

    catalogSection: document.getElementById("dsCatalogSection"),
    contextInfo: document.getElementById("dsContextInfo"),

    dataKindSelect: document.getElementById("dsDataKindSelect"),
    sourceSelect: document.getElementById("dsSourceSelect"),
    contextSelect: document.getElementById("dsContextSelect"),
    searchInput: document.getElementById("dsSearchInput"),
    tagsApplyBtn: document.getElementById("dsTagsApplyBtn"),
    tagsClearBtn: document.getElementById("dsTagsClearBtn"),
    confirmSelectionBtn: document.getElementById("dsConfirmSelectionBtn"),
    tagsTableBody: document.getElementById("dsTagsTbody"),
    selectedCount: document.getElementById("dsSelectedCount"),
    selectedTagsList: document.getElementById("dsSelectedTagsList"),
    emptyState: document.getElementById("dsEmptyState"),
    workspace: document.getElementById("dsWorkspace"),

    bulkPanel: document.getElementById("dsBulkPanel"),
    modeSelect: document.getElementById("dsModeSelect"),
    aggregationSelect: document.getElementById("dsAggregationSelect"),
    consolidationSelect: document.getElementById("dsConsolidationSelect"),
    saveSelectionBtn: document.getElementById("dsSaveSelectionBtn"),
    loadSeriesBtn: document.getElementById("dsLoadSeriesBtn"),

    chartCanvas: document.getElementById("dsChart")
  };
}


function selectedTagKey(tagOrPath) {
  if (typeof tagOrPath === "string") return `path:${dsSafeTrim(tagOrPath)}`;
  const id = tagOrPath?.id ?? tagOrPath?.tag_id;
  if (id !== undefined && id !== null && String(id) !== "") return `id:${id}`;
  return `path:${dsSafeTrim(tagOrPath?.pathname)}`;
}

function renderSelectedTagsList() {
  const { selectedTagsList } = getDataStudioUIElements();
  if (!selectedTagsList) return;

  selectedTagsList.innerHTML = "";
  const tags = Array.isArray(DATASTUDIO_STATE.selectedTags) ? DATASTUDIO_STATE.selectedTags : [];

  if (!tags.length) {
    selectedTagsList.classList.add("hidden");
    return;
  }

  selectedTagsList.classList.remove("hidden");
  tags.forEach((tag) => {
    const chip = document.createElement("div");
    chip.className = "ds-selected-tag-chip";

    const label = `${valueOrDash(tag?.context)} • ${valueOrDash(tag?.point_name || tag?.description || tag?.pathname)}`;
    chip.innerHTML = `
      <span class="ds-selected-tag-chip__text">${label}</span>
      <button type="button" class="ds-selected-tag-chip__remove" aria-label="Remover medida">×</button>
    `;

    chip.querySelector(".ds-selected-tag-chip__remove")?.addEventListener("click", () => {
      removeSelectedTag(tag);
      renderDataStudioTagsTable(DATASTUDIO_STATE.availableTags);
      updateSelectedTagsCounter();
    });

    selectedTagsList.appendChild(chip);
  });
}

function populateDataStudioContextSelect(tags) {
  const { contextSelect } = getDataStudioUIElements();
  if (!contextSelect) return;

  const prev = dsSafeTrim(contextSelect.value || DATASTUDIO_STATE.selectedContext) || "all";
  const contexts = Array.from(new Set((Array.isArray(tags) ? tags : [])
    .map((t) => dsSafeTrim(t?.context))
    .filter(Boolean))).sort((a, b) => a.localeCompare(b, "pt-BR"));

  contextSelect.innerHTML = "";
  const allOpt = document.createElement("option");
  allOpt.value = "all";
  allOpt.textContent = "Todos contextos";
  contextSelect.appendChild(allOpt);

  contexts.forEach((ctx) => {
    const opt = document.createElement("option");
    opt.value = ctx;
    opt.textContent = ctx;
    contextSelect.appendChild(opt);
  });

  if (contexts.includes(prev)) contextSelect.value = prev;
  else contextSelect.value = "all";

  DATASTUDIO_STATE.selectedContext = contextSelect.value || "all";
}


function updateDataStudioStageUI() {
  const { emptyState, workspace, catalogSection, openTagsBtn } = getDataStudioUIElements();
  if (!emptyState || !workspace) return;

  const hasSelection = Array.isArray(DATASTUDIO_STATE.selectedTags) && DATASTUDIO_STATE.selectedTags.length > 0;
  const showWorkspace = hasSelection && DATASTUDIO_STATE.catalogConfirmed && !DATASTUDIO_STATE.forceHeroState;

  if (showWorkspace) {
    emptyState.classList.add("hidden");
    workspace.classList.remove("hidden");
  } else {
    emptyState.classList.remove("hidden");
    workspace.classList.add("hidden");
  }

  if (catalogSection) {
    catalogSection.classList.toggle("is-open", Boolean(DATASTUDIO_STATE.catalogOpen));
  }

  if (openTagsBtn && !DATASTUDIO_STATE.loadingTags) {
    openTagsBtn.textContent = DATASTUDIO_STATE.catalogOpen ? "−" : "+";
  }

  renderSelectedTagsList();
}

function isTagSelected(tagOrPath) {
  const key = selectedTagKey(tagOrPath);
  if (!key || key.endsWith(":")) return false;
  return DATASTUDIO_STATE.selectedTags.some((t) => selectedTagKey(t) === key);
}

function addSelectedTag(tag) {
  if (!tag || !dsSafeTrim(tag.pathname)) return false;
  if (isTagSelected(tag)) return true;
  if (DATASTUDIO_STATE.selectedTags.length >= 50) {
    window.alert("Você pode selecionar no máximo 50 medidas.");
    return false;
  }
  DATASTUDIO_STATE.selectedTags.push(tag);
  DATASTUDIO_STATE.forceHeroState = false;
  updateDataStudioStageUI();
  return true;
}

function removeSelectedTag(tagOrPath) {
  const key = selectedTagKey(tagOrPath);
  DATASTUDIO_STATE.selectedTags = DATASTUDIO_STATE.selectedTags.filter(
    (t) => selectedTagKey(t) !== key
  );
  updateDataStudioStageUI();
}

function updateSelectedTagsCounter() {
  const count = String(DATASTUDIO_STATE.selectedTags.length);
  ["dsSelectedCount", "dsSelectedCountTop", "dsSelectedCountBottom"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.textContent = count;
  });
}

function renderDataStudioTagsTable(tags) {
  const { tagsTableBody } = getDataStudioUIElements();
  if (!tagsTableBody) return;

  const rows = Array.isArray(tags) ? tags : [];
  tagsTableBody.innerHTML = "";

  if (!rows.length) {
    const tr = document.createElement("tr");
    tr.innerHTML = '<td colspan="8" style="text-align:center;opacity:.8;">Nenhuma medida encontrada</td>';
    tagsTableBody.appendChild(tr);
    updateSelectedTagsCounter();
    return;
  }

  rows.forEach((tag) => {
    const pathname = dsSafeTrim(tag?.pathname || tag?.path_name || tag?.tag);
    if (!pathname) return;

    const tr = document.createElement("tr");
    tr.classList.add("ds-table-row-clickable");
    const checked = isTagSelected(tag) ? "checked" : "";

    tr.innerHTML = `
      <td><input type="checkbox" data-ds-pathname="${pathname.replaceAll('"', '&quot;')}" ${checked}></td>
      <td>${valueOrDash(tag?.context)}</td>
      <td>${valueOrDash(tag?.description)}</td>
      <td>${valueOrDash(tag?.source)}</td>
      <td>${valueOrDash(tag?.data_kind)}</td>
      <td>${valueOrDash(tag?.unit)}</td>
      <td>${valueOrDash(tag?.power_plant_id)}</td>
      <td class="ds-pathname-cell" title="${pathname.replaceAll('"', '&quot;')}">${valueOrDash(pathname)}</td>
    `;

    const checkbox = tr.querySelector("input[type='checkbox']");
    const syncRowSelectionState = () => {
      tr.classList.toggle("is-selected", Boolean(checkbox?.checked));
    };

    const applySelection = (checkedState) => {
      if (checkedState) {
        const ok = addSelectedTag({
          id: tag?.id ?? null,
          tag_id: tag?.id ?? null,
          device_type: tag?.device_type ?? null,
          device_id: tag?.device_id ?? null,
          point_name: tag?.point_name ?? null,
          power_plant_id: tag?.power_plant_id ?? null,
          context: dsSafeTrim(tag?.context) || "PLANT",
          pathname,
          source: dsSafeTrim(tag?.source) || "historico",
          data_kind: dsSafeTrim(tag?.data_kind) || "analog",
          unit: tag?.unit ?? null,
          description: tag?.description ?? null
        });
        if (!ok && checkbox) checkbox.checked = false;
      } else {
        removeSelectedTag(tag);
      }
      updateSelectedTagsCounter();
      syncRowSelectionState();
    };

    checkbox?.addEventListener("change", (ev) => {
      applySelection(Boolean(ev.target.checked));
    });

    tr.addEventListener("click", (ev) => {
      if (ev.target?.closest("input, button, a")) return;
      if (!checkbox) return;
      checkbox.checked = !checkbox.checked;
      applySelection(Boolean(checkbox.checked));
    });

    syncRowSelectionState();
    tagsTableBody.appendChild(tr);
  });

  updateSelectedTagsCounter();
  updateDataStudioStageUI();
}


function setDataStudioLoadingTags(isLoading) {
  DATASTUDIO_STATE.loadingTags = Boolean(isLoading);
  const { openTagsBtn, tagsApplyBtn, tagsClearBtn } = getDataStudioUIElements();
  if (openTagsBtn) {
    openTagsBtn.disabled = DATASTUDIO_STATE.loadingTags;
    openTagsBtn.textContent = DATASTUDIO_STATE.loadingTags
      ? "Carregando..."
      : (DATASTUDIO_STATE.catalogOpen ? "−" : "+");
  }
  if (tagsApplyBtn) tagsApplyBtn.disabled = DATASTUDIO_STATE.loadingTags;
  if (tagsClearBtn) tagsClearBtn.disabled = DATASTUDIO_STATE.loadingTags;
}

function setDataStudioSavingSelection(isLoading) {
  DATASTUDIO_STATE.savingSelection = Boolean(isLoading);
  const { saveSelectionBtn } = getDataStudioUIElements();
  if (!saveSelectionBtn) return;
  saveSelectionBtn.disabled = DATASTUDIO_STATE.savingSelection;
  saveSelectionBtn.textContent = DATASTUDIO_STATE.savingSelection ? "Salvando..." : "Salvar seleção";
}

function setDataStudioLoadingSeries(isLoading) {
  DATASTUDIO_STATE.loadingSeries = Boolean(isLoading);
  const { loadSeriesBtn } = getDataStudioUIElements();
  if (!loadSeriesBtn) return;
  loadSeriesBtn.disabled = DATASTUDIO_STATE.loadingSeries;
  loadSeriesBtn.textContent = DATASTUDIO_STATE.loadingSeries ? "Carregando..." : "Carregar séries";
}

function getDataStudioMainFilters() {
  const { startDateInput, endDateInput, plantSelect } = getDataStudioUIElements();

  const rawStart = dsSafeTrim(startDateInput?.value || DATASTUDIO_STATE.startDate);
  const rawEnd = dsSafeTrim(endDateInput?.value || DATASTUDIO_STATE.endDate);
  const plantRaw = dsSafeTrim(plantSelect?.value || DATASTUDIO_STATE.selectedPlantId);

  const start_ts_raw = dsIsoStartOfDay(rawStart);
  const end_ts_raw = dsIsoEndOfDay(rawEnd);
  const { startISO, endISO } = dsClampRange(start_ts_raw, end_ts_raw);

  return {
    power_plant_id: plantRaw ? Number(plantRaw) : null,
    start_ts: startISO,
    end_ts: endISO
  };
}

function buildDataStudioSelectionPayload() {
  const filters = getDataStudioMainFilters();

  if (!filters.power_plant_id) {
    throw new Error("Selecione uma usina para continuar.");
  }
  if (!filters.start_ts || !filters.end_ts) {
    throw new Error("Preencha um período válido (data inicial e final).");
  }
  if (!Array.isArray(DATASTUDIO_STATE.selectedTags) || !DATASTUDIO_STATE.selectedTags.length) {
    throw new Error("Selecione ao menos uma medida.");
  }
  if (DATASTUDIO_STATE.selectedTags.length > 50) {
    throw new Error("Limite de 50 medidas excedido.");
  }

  const allowedAgg = new Set(["none", "avg", "integral", "median", "max", "sum"]);
  const allowedPeriod = new Set(["5min", "daily", "weekly", "monthly", "yearly", "hdaily", "hweekly", "hmonthly", "hyearly"]);

  const aggregationType = allowedAgg.has(DATASTUDIO_STATE.aggregationType)
    ? DATASTUDIO_STATE.aggregationType
    : "avg";
  const consolidationPeriod = allowedPeriod.has(DATASTUDIO_STATE.consolidationPeriod)
    ? DATASTUDIO_STATE.consolidationPeriod
    : "5min";

  const invalidTag = DATASTUDIO_STATE.selectedTags.find(
    (t) => Number(t?.power_plant_id) !== Number(filters.power_plant_id)
  );

  if (invalidTag) {
    throw new Error("Há medidas selecionadas de outra usina. Limpe a seleção e selecione novamente.");
  }

  const items = DATASTUDIO_STATE.selectedTags.slice(0, 50).map((t, idx) => ({
    tag_id: t?.id ?? t?.tag_id ?? null,
    pathname: dsSafeTrim(t.pathname),
    display_type: "line",
    series_order: idx + 1,
    source: dsSafeTrim(t.source) || "historico",
    data_kind: dsSafeTrim(t.data_kind) || "analog",
    unit: t.unit ?? null,
    label: dsSafeTrim(t.point_name || t.description || t.pathname) || null
  }));

  return {
    selection_name: "Seleção Data Studio",
    power_plant_id: filters.power_plant_id,
    start_ts: filters.start_ts,
    end_ts: filters.end_ts,
    timezone: "America/Fortaleza",
    historico_aggregation_default:
      DATASTUDIO_STATE.aggregationMode === "historico" ? aggregationType : "avg",
    consolidado_period_default:
      DATASTUDIO_STATE.aggregationMode === "consolidado" ? consolidationPeriod : "5min",
    items
  };
}

function updateDataStudioContextInfo() {
  const { contextInfo } = getDataStudioUIElements();
  if (!contextInfo) return;

  const selectedContext = dsSafeTrim(DATASTUDIO_STATE.selectedContext) || "all";
  if (selectedContext && selectedContext !== "all") {
    contextInfo.textContent = `Exibindo medidas de: ${selectedContext}`;
    contextInfo.classList.remove("hidden");
  } else {
    contextInfo.textContent = "Exibindo medidas de: todos contextos";
    contextInfo.classList.remove("hidden");
  }
}

function updateDataStudioExportButton() {
  const { exportBtn } = getDataStudioUIElements();
  if (!exportBtn) return;
  exportBtn.disabled = !DATASTUDIO_STATE.selectionId;
}

async function exportDataStudioSelection() {
  if (!DATASTUDIO_STATE.selectionId) {
    window.alert("Salve uma seleção antes de exportar.");
    return;
  }

  const { exportBtn } = getDataStudioUIElements();
  const oldHtml = exportBtn ? exportBtn.innerHTML : "";

  try {
    if (exportBtn) {
      exportBtn.disabled = true;
      exportBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
    }

    const url = `${API_BASE}/datastudio/export?selection_id=${encodeURIComponent(DATASTUDIO_STATE.selectionId)}`;

    const user = JSON.parse(localStorage.getItem("user") || "{}");
    const headers = {};
    if (user.customer_id) headers["X-Customer-Id"] = user.customer_id;
    if (user.is_superuser === true) headers["X-Is-Superuser"] = "true";

    const res = await fetch(url, { headers });

    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(`Falha ao exportar (${res.status}) ${txt}`);
    }

    const blob = await res.blob();

    let filename = `datastudio_export_${DATASTUDIO_STATE.selectionId}.csv`;
    const contentDisposition = res.headers.get("Content-Disposition");
    const match = contentDisposition && contentDisposition.match(/filename="([^"]+)"/i);
    if (match && match[1]) {
      filename = match[1];
    }

    const blobUrl = window.URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = blobUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.URL.revokeObjectURL(blobUrl);
  } catch (err) {
    console.error("[DataStudio] erro ao exportar CSV:", err);
    window.alert(`Não foi possível exportar o CSV: ${err.message || err}`);
  } finally {
    if (exportBtn) {
      exportBtn.innerHTML = oldHtml || '<i class="fa-solid fa-file-csv"></i>';
      updateDataStudioExportButton();
    }
  }
}

function zoomDataStudioChart(factor = 1.2) {
  if (!DATASTUDIO_CHART || typeof DATASTUDIO_CHART.zoom !== "function") return;

  try {
    DATASTUDIO_CHART.zoom({ x: factor, y: factor });
  } catch (err) {
    console.warn("[DataStudio] erro ao aplicar zoom:", err);
  }
}

function resetDataStudioChartZoom() {
  if (!DATASTUDIO_CHART || typeof DATASTUDIO_CHART.resetZoom !== "function") return;

  try {
    DATASTUDIO_CHART.resetZoom();
  } catch (err) {
    console.warn("[DataStudio] erro ao resetar zoom:", err);
  }
}

function isMobileViewport() {
  return window.innerWidth <= 768;
}

function clearDataStudioChartActiveState() {
  if (!DATASTUDIO_CHART) return;

  try {
    DATASTUDIO_CHART.setActiveElements([]);
    if (DATASTUDIO_CHART.tooltip && typeof DATASTUDIO_CHART.tooltip.setActiveElements === "function") {
      DATASTUDIO_CHART.tooltip.setActiveElements([], { x: 0, y: 0 });
    }
    DATASTUDIO_CHART.update("none");
  } catch (err) {
    console.warn("[DataStudio] erro ao limpar seleção do gráfico:", err);
  }
}

function wireDataStudioChartOutsideTapOnce() {
  if (window.__dsOutsideTapWired) return;
  window.__dsOutsideTapWired = true;

  const clearIfOutside = (event) => {
    if (!DATASTUDIO_CHART) return;
    const { chartCanvas } = getDataStudioUIElements();
    if (!chartCanvas) return;
    if (!chartCanvas.contains(event.target)) {
      clearDataStudioChartActiveState();
    }
  };

  document.addEventListener("touchstart", clearIfOutside, { passive: true });
  document.addEventListener("click", clearIfOutside);
}

function openDataStudioCatalogInline({ resetFilters = false } = {}) {
  const { plantSelect, startDateInput, endDateInput } = getDataStudioUIElements();

  DATASTUDIO_STATE.startDate = dsSafeTrim(startDateInput?.value);
  DATASTUDIO_STATE.endDate = dsSafeTrim(endDateInput?.value);
  DATASTUDIO_STATE.selectedPlantId = dsSafeTrim(plantSelect?.value) || null;

  const filters = getDataStudioMainFilters();
  if (!filters.power_plant_id || !filters.start_ts || !filters.end_ts) {
    window.alert("Selecione usina e período válido antes de abrir as medidas.");
    return;
  }

  if (resetFilters) {
    DATASTUDIO_STATE.selectedDataKind = "all";
    DATASTUDIO_STATE.selectedSource = "all";
    DATASTUDIO_STATE.selectedContext = "all";
    DATASTUDIO_STATE.searchText = "";

    const { dataKindSelect, sourceSelect, contextSelect, searchInput } = getDataStudioUIElements();
    if (dataKindSelect) dataKindSelect.value = "all";
    if (sourceSelect) sourceSelect.value = "all";
    if (contextSelect) contextSelect.value = "all";
    if (searchInput) searchInput.value = "";
  }

  DATASTUDIO_STATE.catalogOpen = true;
  DATASTUDIO_STATE.forceHeroState = false;
  updateDataStudioStageUI();
  updateDataStudioContextInfo();
  fetchDataStudioTags();
}

function toggleDataStudioCatalogInline() {
  if (!DATASTUDIO_STATE.catalogOpen) {
    openDataStudioCatalogInline({ resetFilters: !DATASTUDIO_STATE.availableTags.length });
    return;
  }
  DATASTUDIO_STATE.catalogOpen = false;
  updateDataStudioStageUI();
}

function confirmDataStudioCatalogSelection() {
  if (!Array.isArray(DATASTUDIO_STATE.selectedTags) || !DATASTUDIO_STATE.selectedTags.length) {
    window.alert("Selecione ao menos uma medida antes de confirmar.");
    return;
  }

  DATASTUDIO_STATE.catalogConfirmed = true;
  DATASTUDIO_STATE.forceHeroState = false;
  DATASTUDIO_STATE.catalogOpen = false;
  updateDataStudioStageUI();

  setTimeout(() => {
    const { bulkPanel } = getDataStudioUIElements();
    bulkPanel?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, 120);
}

async function fetchDataStudioTags() {
  const { plantSelect, dataKindSelect, sourceSelect, contextSelect, searchInput } = getDataStudioUIElements();

  const plantId = dsSafeTrim(plantSelect?.value || DATASTUDIO_STATE.selectedPlantId);
  const dataKind = dsSafeTrim(dataKindSelect?.value || DATASTUDIO_STATE.selectedDataKind);
  const source = dsSafeTrim(sourceSelect?.value || DATASTUDIO_STATE.selectedSource);
  const context = dsSafeTrim(contextSelect?.value || DATASTUDIO_STATE.selectedContext);
  const q = dsSafeTrim(searchInput?.value || DATASTUDIO_STATE.searchText);

  DATASTUDIO_STATE.selectedPlantId = plantId || null;
  DATASTUDIO_STATE.selectedDataKind = dataKind || "all";
  DATASTUDIO_STATE.selectedSource = source || "all";
  DATASTUDIO_STATE.selectedContext = context || "all";
  DATASTUDIO_STATE.searchText = q;

  const params = new URLSearchParams();
  if (plantId) params.set("plant_id", plantId);
  if (dataKind && dataKind !== "all") params.set("data_kind", dataKind);
  if (source && source !== "all") params.set("source", source);
  if (q) params.set("q", q);
  params.set("limit", "1000");

  const normalizeTagsResponse = (parsed) => {
    if (Array.isArray(parsed)) return parsed;
    if (Array.isArray(parsed?.items)) return parsed.items;
    if (Array.isArray(parsed?.data)) return parsed.data;
    return [];
  };

  setDataStudioLoadingTags(true);

  try {
    const qs = params.toString();
    const res = await apiFetch(`/datastudio/tags${qs ? `?${qs}` : ""}`);
    if (!res.ok) throw new Error(`Falha ao buscar medidas (${res.status})`);
    const data = await res.json();
    const parsed = dsNormalizeApiBody(data);

    const allTags = normalizeTagsResponse(parsed);
    console.log("[DataStudio] TAGS RECEBIDAS:", allTags.length);

    populateDataStudioContextSelect(allTags);

    const contextAfterPopulate = dsSafeTrim(contextSelect?.value || DATASTUDIO_STATE.selectedContext || "all");
    DATASTUDIO_STATE.selectedContext = contextAfterPopulate || "all";

    const filteredTags = (contextAfterPopulate && contextAfterPopulate !== "all")
      ? allTags.filter((tag) => dsContextMatches(tag?.context, contextAfterPopulate))
      : allTags;

    DATASTUDIO_STATE.availableTags = filteredTags;
    updateDataStudioContextInfo();
    renderDataStudioTagsTable(filteredTags);
  } catch (err) {
    console.error("[DataStudio] erro ao buscar tags:", err);
    DATASTUDIO_STATE.availableTags = [];
    updateDataStudioContextInfo();
    renderDataStudioTagsTable([]);
  } finally {
    setDataStudioLoadingTags(false);
  }
}

async function saveDataStudioSelection() {
  setDataStudioSavingSelection(true);
  try {
    const payload = buildDataStudioSelectionPayload();
    const res = await apiFetch("/datastudio/selection", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    const data = await res.json().catch(() => ({}));
    const parsed = dsNormalizeApiBody(data);

    if (!res.ok) {
      const msg = parsed?.message || `Falha ao salvar seleção (${res.status})`;
      throw new Error(msg);
    }

    const selectionId = parsed?.selection_id ?? parsed?.id ?? parsed?.selectionId ?? null;
    DATASTUDIO_STATE.selectionId = selectionId;

    const { loadSeriesBtn } = getDataStudioUIElements();
    if (loadSeriesBtn) loadSeriesBtn.disabled = false;
    updateDataStudioExportButton();

    DATASTUDIO_STATE.forceHeroState = false;
    updateDataStudioStageUI();
    window.alert(selectionId ? `Seleção salva! ID ${selectionId}` : "Seleção salva com sucesso.");

    if (selectionId) {
      await fetchDataStudioSeriesBySelection();
    }
  } catch (err) {
    console.error("[DataStudio] erro ao salvar seleção:", err);
    window.alert(`Não foi possível salvar a seleção: ${err.message || err}`);
  } finally {
    setDataStudioSavingSelection(false);
  }
}

async function fetchDataStudioSeriesBySelection() {
  if (!DATASTUDIO_STATE.selectionId) {
    window.alert("Salve uma seleção antes de carregar séries.");
    return;
  }

  setDataStudioLoadingSeries(true);
  try {
    const params = new URLSearchParams({ selection_id: String(DATASTUDIO_STATE.selectionId) });
    const res = await apiFetch(`/datastudio/series?${params.toString()}`);
    if (!res.ok) throw new Error(`Falha ao carregar séries (${res.status})`);

    const data = await res.json();
    const parsed = dsNormalizeApiBody(data);
    DATASTUDIO_STATE.chartData = parsed;
    updateDataStudioStageUI();
    renderDataStudioChart(parsed);
  } catch (err) {
    console.error("[DataStudio] erro ao carregar séries:", err);
    window.alert(`Não foi possível carregar séries: ${err.message || err}`);
    renderDataStudioChart(null);
  } finally {
    setDataStudioLoadingSeries(false);
  }
}

function renderDataStudioChart(seriesPayload) {
  const { chartCanvas } = getDataStudioUIElements();
  if (!chartCanvas || typeof Chart === "undefined") return;

  if (DATASTUDIO_CHART) {
    DATASTUDIO_CHART.destroy();
    DATASTUDIO_CHART = null;
  }

  const labels = [];
  const datasets = [];

  const seriesList = Array.isArray(seriesPayload?.series)
    ? seriesPayload.series
    : (Array.isArray(seriesPayload?.items) ? seriesPayload.items : []);

  const scales = {
    x: { ticks: { color: "#9fb0bf" }, grid: { color: "rgba(255,255,255,.08)" } },
    y: { type: "linear", position: "left", ticks: { color: "#9fb0bf" }, grid: { color: "rgba(255,255,255,.08)" } }
  };
  const axisByUnit = new Map([["_default_", "y"]]);

  if (seriesList.length) {
    const palette = ["#4da3ff", "#39e58c", "#ffd84d", "#ff8a65", "#b39ddb", "#80cbc4"];
    seriesList.forEach((serie, idx) => {
      const points = Array.isArray(serie?.points)
        ? serie.points
        : (Array.isArray(serie?.data) ? serie.data : []);

      if (!labels.length) {
        points.forEach((pt) => {
          const ts = pt?.ts || pt?.timestamp || pt?.x;
          labels.push(ts ? new Date(ts).toLocaleString("pt-BR") : "");
        });
      }

      const unitKey = dsSafeTrim(serie?.unit || "") || "_default_";
      if (!axisByUnit.has(unitKey)) {
        const axisIdx = axisByUnit.size;
        const axisId = axisIdx === 1 ? "y1" : `y${axisIdx}`;
        axisByUnit.set(unitKey, axisId);
        scales[axisId] = {
          type: "linear",
          position: axisIdx % 2 === 0 ? "left" : "right",
          grid: { drawOnChartArea: false, color: "rgba(255,255,255,.08)" },
          ticks: { color: "#9fb0bf" }
        };
      }

      datasets.push({
        label: serie?.label || serie?.pathname || `Série ${idx + 1}`,
        data: points.map((pt) => Number(pt?.value ?? pt?.y ?? null)),
        borderColor: palette[idx % palette.length],
        backgroundColor: palette[idx % palette.length],
        borderWidth: 2,
        tension: 0.25,
        pointRadius: 0,
        pointHoverRadius: 6,
        pointHitRadius: 16,
        fill: false,
        yAxisID: axisByUnit.get(unitKey) || "y"
      });
    });
  } else {
    labels.push("Sem dados");
    datasets.push({
      label: "Data Studio",
      data: [0],
      borderColor: "#4da3ff",
      backgroundColor: "#4da3ff",
      borderWidth: 2,
      tension: 0.25,
      pointRadius: 0,
      pointHoverRadius: 6,
      pointHitRadius: 16,
      fill: false,
      yAxisID: "y"
    });
  }

  const mobile = isMobileViewport();

  DATASTUDIO_CHART = new Chart(chartCanvas.getContext("2d"), {
    type: "line",
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: {
        mode: mobile ? "nearest" : "index",
        intersect: false,
        axis: "x"
      },
      hover: {
        mode: mobile ? "nearest" : "index",
        intersect: false
      },
      elements: {
        point: {
          radius: 0,
          hoverRadius: mobile ? 8 : 6,
          hitRadius: mobile ? 24 : 16
        },
        line: {
          borderWidth: 2
        }
      },
      plugins: {
        legend: {
          labels: {
            color: "#dbe7ef",
            boxWidth: 12,
            usePointStyle: true,
            pointStyle: "line"
          }
        },
        tooltip: {
          enabled: true,
          mode: mobile ? "nearest" : "index",
          intersect: false,
          displayColors: true,
          backgroundColor: "rgba(6, 18, 14, 0.96)",
          borderColor: "rgba(127,208,85,.22)",
          borderWidth: 1,
          titleColor: "#dbe7ef",
          bodyColor: "#dbe7ef",
          padding: 10,
          caretSize: 6
        },
        zoom: {
          limits: {
            x: { minRange: 5 },
            y: { minRange: 1 }
          },
          pan: {
            enabled: true,
            mode: "xy"
          },
          zoom: {
            wheel: {
              enabled: true
            },
            pinch: {
              enabled: true
            },
            drag: {
              enabled: false
            },
            mode: "xy"
          }
        }
      },
      scales
    }
  });
}


function populateDataStudioPlantSelect(plants) {
  const { plantSelect } = getDataStudioUIElements();
  if (!plantSelect) return;

  const list = Array.isArray(plants) ? plants : [];
  const currentValue =
  dsSafeTrim(plantSelect.value) ||
  dsSafeTrim(DATASTUDIO_STATE.selectedPlantId) ||
  "";

  const nextOptions = [
    { value: "", text: "Selecione uma usina" },
    ...list
      .map((p) => {
        const id = p.power_plant_id ?? p.plant_id ?? p.id;
        const name = p.power_plant_name ?? p.name ?? `Usina ${id}`;
        return id == null ? null : { value: String(id), text: String(name) };
      })
      .filter(Boolean)
  ];

  const currentSerialized = [...plantSelect.options].map(o => `${o.value}|${o.textContent}`).join("||");
  const nextSerialized = nextOptions.map(o => `${o.value}|${o.text}`).join("||");

  if (currentSerialized !== nextSerialized) {
    plantSelect.innerHTML = "";
    nextOptions.forEach(({ value, text }) => {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = text;
      plantSelect.appendChild(option);
    });
  }

  if (currentValue && nextOptions.some(o => o.value === currentValue)) {
    plantSelect.value = currentValue;
  } else if (!plantSelect.value) {
    plantSelect.value = "";
  }

  DATASTUDIO_STATE.selectedPlantId = dsSafeTrim(plantSelect.value) || null;

  console.log("[DS] plant options:", [...plantSelect.options].map(o => ({
    value: o.value,
    text: o.textContent
  })));
}

function syncDataStudioAggregationUI() {
  const { modeSelect, aggregationSelect, consolidationSelect } = getDataStudioUIElements();
  if (modeSelect) modeSelect.value = DATASTUDIO_STATE.aggregationMode;
  if (aggregationSelect) {
    aggregationSelect.value = DATASTUDIO_STATE.aggregationType;
    aggregationSelect.disabled = DATASTUDIO_STATE.aggregationMode !== "historico";
  }
  if (consolidationSelect) {
    consolidationSelect.value = DATASTUDIO_STATE.consolidationPeriod;
    consolidationSelect.disabled = DATASTUDIO_STATE.aggregationMode !== "consolidado";
  }
}

function markDataStudioSeriesDirty() {
  DATASTUDIO_STATE.selectionId = null;
  DATASTUDIO_STATE.chartData = null;

  const { loadSeriesBtn, saveSelectionBtn } = getDataStudioUIElements();

  if (loadSeriesBtn) {
    loadSeriesBtn.disabled = true;
    loadSeriesBtn.textContent = "Carregar séries";
  }

  if (saveSelectionBtn) {
    saveSelectionBtn.disabled = false;
  }

  renderDataStudioChart(null);
  updateDataStudioExportButton();
}

function formatDateInputValue(dateObj) {
  const y = dateObj.getFullYear();
  const m = String(dateObj.getMonth() + 1).padStart(2, "0");
  const d = String(dateObj.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function autoAdjustDataStudioDateRangeByMode() {
  const { startDateInput, endDateInput } = getDataStudioUIElements();
  if (!startDateInput || !endDateInput) return;

  const now = new Date();
  const start = new Date(now);

  const mode = dsSafeTrim(DATASTUDIO_STATE.aggregationMode || "historico");
  const period = dsSafeTrim(DATASTUDIO_STATE.consolidationPeriod || "5min");

  if (mode === "historico") {
    start.setDate(now.getDate() - 7);
  } else {
    switch (period) {
      case "5min":
        start.setDate(now.getDate() - 1);
        break;
      case "daily":
      case "hdaily":
        start.setDate(now.getDate() - 30);
        break;
      case "weekly":
      case "hweekly":
        start.setDate(now.getDate() - 90);
        break;
      case "monthly":
      case "hmonthly":
        start.setMonth(now.getMonth() - 12);
        break;
      case "yearly":
      case "hyearly":
        start.setFullYear(now.getFullYear() - 5);
        break;
      default:
        start.setDate(now.getDate() - 30);
        break;
    }
  }

  const startStr = formatDateInputValue(start);
  const endStr = formatDateInputValue(now);

  startDateInput.value = startStr;
  endDateInput.value = endStr;

  DATASTUDIO_STATE.startDate = startStr;
  DATASTUDIO_STATE.endDate = endStr;
}

function wireDataStudioOnce() {
  if (DATASTUDIO_STATE.wired) return;

  const ui = getDataStudioUIElements();
  if (!ui.openTagsBtn && !ui.startDateInput && !ui.endDateInput) return;

  DATASTUDIO_STATE.wired = true;

  const now = new Date();
  const week = new Date();
  week.setDate(now.getDate() - 7);
  const asDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

  if (ui.startDateInput && !ui.startDateInput.value) ui.startDateInput.value = asDate(week);
  if (ui.endDateInput && !ui.endDateInput.value) ui.endDateInput.value = asDate(now);

  DATASTUDIO_STATE.startDate = dsSafeTrim(ui.startDateInput?.value);
  DATASTUDIO_STATE.endDate = dsSafeTrim(ui.endDateInput?.value);

  autoAdjustDataStudioDateRangeByMode();

  ui.startDateInput?.addEventListener("change", (e) => {
    DATASTUDIO_STATE.startDate = dsSafeTrim(e.target.value);
    DATASTUDIO_STATE.catalogConfirmed = false;
    markDataStudioSeriesDirty();
  });

  ui.endDateInput?.addEventListener("change", (e) => {
    DATASTUDIO_STATE.endDate = dsSafeTrim(e.target.value);
    DATASTUDIO_STATE.catalogConfirmed = false;
    markDataStudioSeriesDirty();
  });

  ui.plantSelect?.addEventListener("change", (e) => {
    const nextPlantId = dsSafeTrim(e.target.value) || null;
    DATASTUDIO_STATE.selectedPlantId = nextPlantId;

    DATASTUDIO_STATE.selectedTags = [];
    DATASTUDIO_STATE.availableTags = [];
    DATASTUDIO_STATE.selectionId = null;
    DATASTUDIO_STATE.chartData = null;
    DATASTUDIO_STATE.selectedContext = "all";
    DATASTUDIO_STATE.searchText = "";

    if (ui.contextSelect) {
      ui.contextSelect.innerHTML = "";
      const opt = document.createElement("option");
      opt.value = "all";
      opt.textContent = "Todos contextos";
      ui.contextSelect.appendChild(opt);
      ui.contextSelect.value = "all";
    }

    if (ui.searchInput) ui.searchInput.value = "";

    renderDataStudioTagsTable([]);
    renderDataStudioChart(null);
    updateSelectedTagsCounter();
    updateDataStudioExportButton();
    updateDataStudioStageUI();
  });

  ui.dataKindSelect?.addEventListener("change", (e) => {
    DATASTUDIO_STATE.selectedDataKind = dsSafeTrim(e.target.value) || "all";
  });

  ui.sourceSelect?.addEventListener("change", (e) => {
    DATASTUDIO_STATE.selectedSource = dsSafeTrim(e.target.value) || "all";
  });

  ui.contextSelect?.addEventListener("change", (e) => {
    DATASTUDIO_STATE.selectedContext = dsSafeTrim(e.target.value) || "all";
    updateDataStudioContextInfo();
    fetchDataStudioTags();
  });

  ui.searchInput?.addEventListener("input", (e) => {
    DATASTUDIO_STATE.searchText = dsSafeTrim(e.target.value);
  });

  ui.modeSelect?.addEventListener("change", (e) => {
    DATASTUDIO_STATE.aggregationMode = dsSafeTrim(e.target.value) || "historico";

    syncDataStudioAggregationUI();
    autoAdjustDataStudioDateRangeByMode();
    markDataStudioSeriesDirty();
  });

  ui.aggregationSelect?.addEventListener("change", (e) => {
    DATASTUDIO_STATE.aggregationType = dsSafeTrim(e.target.value) || "avg";
    markDataStudioSeriesDirty();
  });

  ui.consolidationSelect?.addEventListener("change", (e) => {
    DATASTUDIO_STATE.consolidationPeriod = dsSafeTrim(e.target.value) || "5min";

    autoAdjustDataStudioDateRangeByMode();
    markDataStudioSeriesDirty();
  });

  ui.openTagsBtn?.addEventListener("click", toggleDataStudioCatalogInline);
  ui.tagsApplyBtn?.addEventListener("click", fetchDataStudioTags);
  ui.confirmSelectionBtn?.addEventListener("click", confirmDataStudioCatalogSelection);

  ui.tagsClearBtn?.addEventListener("click", () => {
    DATASTUDIO_STATE.selectedTags = [];
    DATASTUDIO_STATE.selectionId = null;
    DATASTUDIO_STATE.chartData = null;
    DATASTUDIO_STATE.forceHeroState = false;
    DATASTUDIO_STATE.catalogConfirmed = false;
    DATASTUDIO_STATE.catalogOpen = true;
    renderDataStudioTagsTable(DATASTUDIO_STATE.availableTags);
    updateDataStudioExportButton();
    updateDataStudioStageUI();
  });

  ui.saveSelectionBtn?.addEventListener("click", saveDataStudioSelection);
  ui.loadSeriesBtn?.addEventListener("click", async () => {
    await saveDataStudioSelection();
  });
  ui.exportBtn?.addEventListener("click", exportDataStudioSelection);
  ui.zoomInBtn?.addEventListener("click", () => zoomDataStudioChart(1.2));
  ui.zoomOutBtn?.addEventListener("click", () => zoomDataStudioChart(0.8));
  ui.zoomResetBtn?.addEventListener("click", resetDataStudioChartZoom);
  ui.backToHeroBtn?.addEventListener("click", () => {
    DATASTUDIO_STATE.forceHeroState = true;
    DATASTUDIO_STATE.catalogConfirmed = false;
    DATASTUDIO_STATE.catalogOpen = true;
    updateDataStudioStageUI();
    setTimeout(() => {
      const { catalogSection } = getDataStudioUIElements();
      catalogSection?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 120);
  });

  wireDataStudioChartOutsideTapOnce();

  syncDataStudioAggregationUI();
  updateSelectedTagsCounter();
  updateDataStudioExportButton();
  updateDataStudioStageUI();
}

// =============================================================================
// NAVEGAÇÃO E INICIALIZAÇÃO
// =============================================================================

function animateViewEntrance(viewEl) {
  if (!viewEl) return;
  viewEl.classList.remove("view-enter");
  // força reflow para reiniciar animação sem mexer em API/state
  void viewEl.offsetWidth;
  viewEl.classList.add("view-enter");

  const done = () => viewEl.classList.remove("view-enter");
  viewEl.addEventListener("animationend", done, { once: true });
}

const views = {
  overview: document.getElementById("overviewView"),
  alarms: document.getElementById("alarmsView"),
  events: document.getElementById("eventsView"),
  diagram: document.getElementById("diagramView"),
  datastudio: document.getElementById("dataStudioView")
};

function syncTopSummaryLayout() {
  const topSummary = document.getElementById("topSummary");
  if (!topSummary) return;

  const isOverviewVisible = !!views.overview && !views.overview.classList.contains("hidden");
  topSummary.classList.toggle("hidden", !isOverviewVisible);

  requestAnimationFrame(() => {
    const summaryHeight = isOverviewVisible ? Math.ceil(topSummary.getBoundingClientRect().height) : 0;
    document.documentElement.style.setProperty("--top-summary-height", `${summaryHeight}px`);
  });
}

function showView(viewName) {
  localStorage.setItem("currentView", viewName);
  Object.values(views).forEach(v => { if (v) v.classList.add("hidden"); });
  if (views[viewName]) {
    views[viewName].classList.remove("hidden");
    animateViewEntrance(views[viewName]);
  }

  document.querySelectorAll(".sidebar-btn").forEach(b => b.classList.remove("active"));
  const btnMap = {
    overview: "btnOverview",
    alarms: "btnAlarms",
    events: "btnEvents",
    datastudio: "btnDataStudio"
  };
  const activeBtn = document.getElementById(btnMap[viewName]);
  if (activeBtn) activeBtn.classList.add("active");

  syncTopSummaryLayout();

  if (viewName === "events") {
    EVENTS_STATE.page = 1;
    loadEvents(1);
    startEventsAutoRefresh();
  } else {
    stopEventsAutoRefresh();
  }

  if (viewName === "datastudio") {
    wireDataStudioOnce();
    populateDataStudioPlantSelect(lastValidPlants);
    syncDataStudioAggregationUI();
  }
}

document.getElementById("btnOverview")?.addEventListener("click", () => showView("overview"));

document.getElementById("btnAlarms")?.addEventListener("click", async () => {
  showView("alarms");
  document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
  const firstTab = document.querySelector(".tab-btn");
  if (firstTab) firstTab.classList.add("active");
  CURRENT_ALARMS_TAB_MODE = null;
  await renderAlarmsTable(false, { force: true });
});

document.getElementById("btnEvents")?.addEventListener("click", () => showView("events"));
document.getElementById("btnDataStudio")?.addEventListener("click", () => showView("datastudio"));

document.querySelectorAll(".tab-btn").forEach(btn => {
  btn.addEventListener("click", async () => {
    document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    const isRecognized = btn.textContent.toUpperCase().includes("RECONHECIDOS");
    await renderAlarmsTable(isRecognized, { force: true });

    const alarmsView = document.getElementById("alarmsView");
    animateViewEntrance(alarmsView);
  });
});

function isAlarmsRecognizedTabActive() {
  const activeTab = document.querySelector(".alarms-tabs .tab-btn.active");
  return Boolean(activeTab?.textContent?.toUpperCase().includes("RECONHECID"));
}

async function refreshVisibleViewData() {
  const alarmsView = document.getElementById("alarmsView");
  const eventsView = document.getElementById("eventsView");

  if (alarmsView && !alarmsView.classList.contains("hidden")) {
    await renderAlarmsTable(isAlarmsRecognizedTabActive());
  }

  if (eventsView && !eventsView.classList.contains("hidden")) {
    await loadEvents(EVENTS_STATE.page || 1, { silent: true });
  }
}


async function refreshDashboard() {
  let plants = [];
  let alarms = [];

  try {
    plants = await fetchPlants();
    if (Array.isArray(plants) && plants.length > 0) {
      lastValidPlants = plants;
    }
  } catch (err) {
    console.error("Erro ao buscar plantas:", err);
    plants = lastValidPlants;
  }

  const dsViewEl = document.getElementById("dataStudioView");
  const dsViewVisible = dsViewEl && !dsViewEl.classList.contains("hidden");

  const dsPlantSelect = document.getElementById("dsPlantSelect");
  const dsNeedPopulate =
    !dsPlantSelect ||
    dsPlantSelect.options.length <= 1;

  if (!dsViewVisible || dsNeedPopulate) {
    populateDataStudioPlantSelect(lastValidPlants);
  }
  populateEventsPlantSelect(lastValidPlants);

  try {
    alarms = await fetchActiveAlarms();
  } catch (err) {
    console.error("Erro ao buscar alarmes ativos:", err);
    alarms = [];
  }

  lastAlarmSeverityByPlant = buildPlantAlarmSeverityMap(alarms);

  try {
    const summary = await fetchPlantsSummary();
    refreshTopChipsGlobalFromSummary(summary);
  } catch (e) {
    console.warn("[SUMMARY] falhou, fallback via /plants:", e?.message || e);
    refreshTopChipsGlobalFromPlants(lastValidPlants);
  }
  // topo sempre global: soma de todas as usinas visíveis para o usuário
  updateSummaryUI(lastValidPlants);

  renderPortfolioTable(lastValidPlants);
  await refreshVisibleViewData();
  syncTopSummaryLayout();
}

document.addEventListener("DOMContentLoaded", async () => {
  wireDataStudioOnce();

  const savedView = localStorage.getItem("currentView") || "overview";
  showView(savedView);
  syncTopSummaryLayout();

  await refreshDashboard();
  setInterval(refreshDashboard, DASHBOARD_REFRESH_INTERVAL_MS);

  document.addEventListener("visibilitychange", async () => {
    if (!document.hidden) {
      await refreshDashboard();
    }
  });

  window.addEventListener("focus", async () => {
    await refreshDashboard();
  });

  window.addEventListener("resize", () => {
    syncTopSummaryLayout();
  });

  document.querySelector(".logout-icon")?.addEventListener("click", logout);
  document.querySelector(".sidebar-logout")?.addEventListener("click", logout);
});
