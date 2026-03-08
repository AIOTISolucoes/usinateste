// ======================================================
// ESTADO ÚNICO DA USINA (FONTE DA VERDADE NO FRONT)
// ======================================================
let PLANT_STATE = {
  name: "—",
  rated_power_kwp: 0,
  active_power_kw: 0,
  capacity_percent: 0,
  inverter_total: 0,
  inverter_online: 0,
  pr_percent: 0
};

// ======================================================
// CONFIG (ONLINE/OFFLINE)
// ======================================================
const INVERTER_ONLINE_AFTER_MS = 15 * 60 * 1000; // 15 min
const INVERTER_NO_COMM_AFTER_MS = 15 * 60 * 1000; // 15 min
let REFRESH_RUNNING = false;

// ======================================================
// FUNÇÕES AUXILIARES
// ======================================================
function asNumber(value, fallback = 0) {
  if (value === null || value === undefined) return fallback;
  const s = typeof value === "string" ? value.replace(",", ".").trim() : value;
  const parsed = Number(s);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function formatNumberPtBR(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  return new Intl.NumberFormat("pt-BR").format(n);
}

function formatKwhPtBR(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  return `${formatNumberPtBR(n)} kWh`;
}

// ======================================================
// WEATHER: parse robusto + stale timeout (30 min)
// ======================================================
const WEATHER_STALE_AFTER_MS = 30 * 60 * 1000;
let WEATHER_CACHE = { data: null, ok_ms: 0 };

function toNumOrNull(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim().replace(",", ".").toLowerCase();
  if (!s || s === "null" || s === "nan" || s === "undefined") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function parseTsToMsSafe(ts) {
  if (!ts) return 0;
  const ms = Date.parse(ts);
  return Number.isFinite(ms) ? ms : 0;
}

function isWeatherStale(weatherObj) {
  const ts =
    weatherObj?.last_update ??
    weatherObj?.lastUpdate ??
    weatherObj?.ts ??
    weatherObj?.timestamp ??
    null;

  const ms = parseTsToMsSafe(ts);
  if (!ms) return true;
  return (Date.now() - ms) > WEATHER_STALE_AFTER_MS;
}

function buildLastNDaysLabels(n) {
  const labels = [];
  const today = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    const dd = String(d.getDate()).padStart(2, "0");
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    labels.push(`${dd}/${mm}`);
  }
  return labels;
}

function looksLikeDayOnlyLabel(label) {
  const s = String(label ?? "").trim();
  if (!s) return false;
  if (s.includes("/") || s.includes("-")) return false;
  return /^\d{1,2}$/.test(s);
}

function hasDuplicateLabels(labels) {
  const set = new Set();
  for (const l of labels) {
    const key = String(l);
    if (set.has(key)) return true;
    set.add(key);
  }
  return false;
}

function valueOrDash(v) {
  return v === null || v === undefined || v === "" ? "—" : v;
}

function fmtDatePtBR(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return isNaN(d.getTime()) ? "—" : d.toLocaleString("pt-BR");
}

function numFixedOrDash(v, digits = 1) {
  // ✅ IMPORTANT: 0 deve aparecer como "0.0", não "—"
  const n = Number(typeof v === "string" ? v.replace(",", ".") : v);
  return Number.isFinite(n) ? n.toFixed(digits) : "—";
}

function normalizePercentMaybe(v) {
  const n = Number(typeof v === "string" ? v.replace(",", ".") : v);
  if (!Number.isFinite(n)) return null;
  if (n <= 1.0) return n * 100;
  return n;
}

function fmtAmp(v) {
  const n = Number(typeof v === "string" ? v.replace(",", ".") : v);
  if (!Number.isFinite(n)) return "—";
  return `${n.toFixed(2)} A`;
}

// ======================================================
// ✅ HELPERS NUMÉRICOS PARA MENSAL (UNIDADE + OUTLIER)
// ======================================================
function median(arr) {
  const a = arr.filter(x => Number.isFinite(x)).slice().sort((x, y) => x - y);
  if (!a.length) return 0;
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

function p95(arr) {
  const a = arr.filter(x => Number.isFinite(x)).slice().sort((x, y) => x - y);
  if (!a.length) return 0;
  const idx = Math.max(0, Math.min(a.length - 1, Math.floor((a.length - 1) * 0.95)));
  return a[idx];
}

/**
 * Converte Wh->kWh se detectar escala absurda.
 * - Para 30 dias de uma usina ~2MW, MTD em kWh não deveria ir pra milhões.
 */
function maybeConvertWhToKwh(dailyArr, mtdArr) {
  const maxCum = Math.max(...(mtdArr || []), 0);
  const looksLikeWh = maxCum > 500000; // gatilho conservador
  if (!looksLikeWh) return { daily: dailyArr, mtd: mtdArr, converted: false };
  return {
    daily: dailyArr.map(v => v / 1000),
    mtd: mtdArr.map(v => v / 1000),
    converted: true
  };
}

/**
 * Trata outliers: se um dia é MUITO maior que o normal, capamos pra não destruir o gráfico.
 * Regra: se v > max(mediana*25, p95*4) => cap = max(mediana*10, p95*1.5)
 */
function capMonthlyOutliers(dailyArr) {
  const daily = dailyArr.map(v => Number(v) || 0);

  const med = median(daily);
  const q95 = p95(daily);

  const spikeThreshold = Math.max(med * 25, q95 * 4);
  const capValue = Math.max(med * 10, q95 * 1.5);

  let changed = false;
  const capped = daily.map(v => {
    if (med <= 0 && q95 <= 0) return v;
    if (v > spikeThreshold && capValue > 0) {
      changed = true;
      return capValue;
    }
    return v;
  });

  return { daily: capped, changed, med, q95, spikeThreshold, capValue };
}

// ======================================================
// ✅ NORMALIZA PAYLOAD DIÁRIO (00:00 até último dado do dia)
// - Filtra apenas pontos do dia atual quando houver timestamp por ponto
// - Preenche faltas com 0 para evitar buracos visuais
// ======================================================
function normalizeDailyPayload(payload) {
  if (!payload) return payload;

  const labelsRaw = Array.isArray(payload.labels) ? payload.labels.slice() : [];

  const powerRaw =
    Array.isArray(payload.activePower) ? payload.activePower.slice() :
    Array.isArray(payload.active_power_kw) ? payload.active_power_kw.slice() :
    Array.isArray(payload.power_kw) ? payload.power_kw.slice() :
    [];

  const irrRaw =
    Array.isArray(payload.irradiance) ? payload.irradiance.slice() :
    Array.isArray(payload.irradiance_wm2) ? payload.irradiance_wm2.slice() :
    [];

  if (!labelsRaw.length) return payload;

  // timestamp por ponto (se existir), para filtrar estritamente o DIA ATUAL
  const pointTsRaw =
    Array.isArray(payload.timestamps) ? payload.timestamps :
    Array.isArray(payload.ts) ? payload.ts :
    Array.isArray(payload.point_timestamps) ? payload.point_timestamps :
    Array.isArray(payload.time) ? payload.time :
    null;

  const hasPointTimestamps = Array.isArray(pointTsRaw) && pointTsRaw.length > 0;

  // "HH:mm" -> minutos desde 00:00
  const toMin = (hhmm) => {
    const m = String(hhmm || "").trim().match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return null;
    const hh = Number(m[1]), mm = Number(m[2]);
    if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null;
    if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
    return hh * 60 + mm;
  };

  const dateKeyInSaoPaulo = (d) => {
    if (!(d instanceof Date) || Number.isNaN(d.getTime())) return null;
    return d.toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
  };

  const todayKeySP = new Date().toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });

  const points = [];
  for (let i = 0; i < labelsRaw.length; i++) {
    const minute = toMin(labelsRaw[i]);
    if (minute == null) continue;

    if (hasPointTimestamps) {
      const ts = pointTsRaw[i];
      const d = ts ? new Date(ts) : null;
      const key = dateKeyInSaoPaulo(d);
      if (!key || key !== todayKeySP) continue;
    }

    points.push({
      minute,
      power: powerRaw[i] != null ? asNumber(powerRaw[i], 0) : 0,
      irr: irrRaw[i] != null ? asNumber(irrRaw[i], 0) : 0
    });
  }

  if (!points.length) {
    return {
      ...payload,
      labels: [],
      activePower: [],
      irradiance: []
    };
  }

  const mins = points.map(p => p.minute).sort((a, b) => a - b);

  let step = 5; // ✅ trava em 5 min (SCADA)

  const mapP = new Map();
  const mapI = new Map();

  // ✅ bucket: sempre pro INÍCIO do intervalo (floor), não "round"
  const toBucket = (minute) => {
    const b = Math.floor(minute / step) * step;
    return Math.max(0, Math.min(23 * 60 + 55, b));
  };

  // ✅ se cair 2+ pontos no mesmo bucket:
  // - power: mantém o ÚLTIMO (mais recente)
  // - irradiância: mantém o MAIOR (evita zerar/oscilar)
  points.forEach(p => {
    const b = toBucket(p.minute);

    // power: último ganha
    mapP.set(b, p.power);

    // irradiância: não deixa um 0 sobrescrever um valor bom
    const prevI = mapI.get(b);
    const nextI = p.irr;

    if (prevI === undefined) {
      mapI.set(b, nextI);
    } else {
      // pega o maior (pico no bucket) e ignora "0" se já tinha algo >0
      mapI.set(b, Math.max(Number(prevI) || 0, Number(nextI) || 0));
    }
  });

  // ✅ vai só até o último bucket com dado (não até 23:55)
  const lastMin = Math.max(...mins);
  const lastBucket = Math.floor(lastMin / step) * step;

  const labels = [];
  const activePower = [];
  const irradiance = [];

  let lastIrr = 0;

  for (let m = 0; m <= lastBucket; m += step) {
    const hh = String(Math.floor(m / 60)).padStart(2, "0");
    const mm = String(m % 60).padStart(2, "0");
    labels.push(`${hh}:${mm}`);

    activePower.push(mapP.has(m) ? mapP.get(m) : 0);

    // irradiância: carry-forward dentro do range
    if (mapI.has(m)) lastIrr = mapI.get(m);
    irradiance.push(lastIrr);
  }

  return { ...payload, labels, activePower, irradiance };
}


// ======================================================
// SÉRIES REAIS (API)
// ======================================================
let DAILY = null;
let MONTHLY = null;
let LAST_DAILY_FETCH_MS = 0;
const DAILY_REFRESH_EVERY_MS = 60 * 1000; // 1 min
let DAILY_DAY_KEY = null;
let ACTIVE_ALARMS = [];
let INVERTERS_REALTIME = [];
let INVERTERS_CACHE = { items: [], ok_ms: 0 };
const INVERTERS_CACHE_TTL_MS = 2 * 60 * 1000; // 2 min
let RELAY_REALTIME = null; // ✅ NEW
let OPEN_INVERTER_REAL_ID = null;
let STRINGS_REFRESH_SEQ = 0;
let INVERTER_EXTRAS_BY_ID = new Map(); // inverter_id (string) -> objeto inv completo

let PLANT_CATALOG = {
  inverters: [],
  hasRelay: false
};

let RELAY_SUPPORTED = null; // null = desconhecido / true / false

const API_BASE = "https://jgeg9i0js1.execute-api.us-east-1.amazonaws.com";
const PLANT_REFRESH_INTERVAL_MS = 10000;
const PLANT_ID = new URLSearchParams(window.location.search).get("plant_id");

function normalizeApiBody(data) {
  if (data && data.body) {
    return typeof data.body === "string" ? JSON.parse(data.body) : data.body;
  }
  return data;
}

function getUserContext() {
  try {
    const user = JSON.parse(localStorage.getItem("user"));
    return {
      customer_id: user?.customer_id ?? null,
      is_superuser: user?.is_superuser ?? false
    };
  } catch {
    return { customer_id: null, is_superuser: false };
  }
}

function buildAuthHeaders() {
  const ctx = getUserContext();
  const headers = { "Content-Type": "application/json" };
  if (ctx.customer_id) headers["X-Customer-Id"] = ctx.customer_id;
  if (ctx.is_superuser) headers["X-Is-Superuser"] = "true";
  return headers;
}

// ======================================================
// ✅ PREFERÊNCIAS — STRINGS DESABILITADAS (LOCALSTORAGE)
// ======================================================
function getPrefKey() {
  const ctx = getUserContext();
  const customer = ctx.customer_id ?? "anon";
  return `scada:strings_disabled:${customer}:${PLANT_ID}`;
}

function readDisabledPrefs() {
  try {
    return JSON.parse(localStorage.getItem(getPrefKey())) || {};
  } catch {
    return {};
  }
}

function isDisabledPref(inverterRealId, stringIndex) {
  const prefs = readDisabledPrefs();
  return !!prefs?.[String(inverterRealId)]?.[String(stringIndex)];
}

function setDisabledPref(inverterRealId, stringIndex, disabled) {
  const prefs = readDisabledPrefs();
  const invKey = String(inverterRealId);
  const sKey = String(stringIndex);

  prefs[invKey] = prefs[invKey] || {};
  if (disabled) prefs[invKey][sKey] = true;
  else delete prefs[invKey][sKey];

  localStorage.setItem(getPrefKey(), JSON.stringify(prefs));
}

// ======================================================
// FETCH — TEMPO REAL, WEATHER, ALARMES, ENERGIA
// ======================================================
async function fetchPlantRealtime(plantId) {
  const res = await fetch(`${API_BASE}/plants/${plantId}/realtime`, {
    headers: buildAuthHeaders()
  });
  const data = await res.json();
  return normalizeApiBody(data);
}

async function fetchActiveAlarms(plantId) {
  const res = await fetch(`${API_BASE}/plants/${plantId}/alarms/active`, {
    headers: buildAuthHeaders()
  });
  const data = await res.json();
  return normalizeApiBody(data);
}

async function fetchDailyEnergy(plantId) {
  const res = await fetch(`${API_BASE}/plants/${plantId}/energy/daily`, {
    headers: buildAuthHeaders()
  });
  const data = await res.json();
  return normalizeApiBody(data);
}

async function fetchMonthlyEnergy(plantId) {
  const res = await fetch(`${API_BASE}/plants/${plantId}/energy/monthly`, {
    headers: buildAuthHeaders()
  });
  const data = await res.json();
  return normalizeApiBody(data);
}

async function safeFetchRelayIfSupported(plantId) {
  if (RELAY_SUPPORTED === false) return null;

  const url = `${API_BASE}/plants/${plantId}/relay/realtime`;
  const res = await fetch(url, { headers: buildAuthHeaders() });

  if (res.status === 404) {
    RELAY_SUPPORTED = false;
    return null;
  }

  if (!res.ok) {
    console.warn(`[relay/realtime] HTTP ${res.status} em ${url}`);
    return null;
  }

  RELAY_SUPPORTED = true;
  const payload = normalizeApiBody(await res.json());
  return payload?.item ?? null;
}

function setRelaySectionVisible(visible) {
  const relaySection = document.getElementById("relaySection");
  if (relaySection) relaySection.style.display = visible ? "" : "none";
}

function setMultimeterSectionVisible(visible) {
  const multimeterSection = document.getElementById("multimeterSection");
  if (multimeterSection) multimeterSection.style.display = visible ? "" : "none";
}

// ✅ realtime por inversor
async function fetchInvertersRealtime(plantId) {
  const candidates = [
    `${API_BASE}/plants/${plantId}/inverters/realtime`,
    `${API_BASE}/plants/${plantId}/inverters`
  ];

  for (const url of candidates) {
    try {
      const res = await fetch(url, { headers: buildAuthHeaders() });
      if (!res.ok) {
        if (res.status === 404) continue;
        console.warn(`[inverters realtime] HTTP ${res.status} em ${url}`);
        continue;
      }

      const data = normalizeApiBody(await res.json());
      const items = Array.isArray(data) ? data : (data?.items || []);

      // ✅ só atualiza cache se vier algo minimamente válido
      if (Array.isArray(items) && items.length > 0) {
        INVERTERS_CACHE = { items, ok_ms: Date.now() };
        return items;
      }

      // se vier vazio, NÃO derruba. tenta próximo endpoint.
    } catch (e) {
      console.warn(`[inverters realtime] fetch fail ${url}`, e);
    }
  }

  // ✅ fallback no cache (igual weather)
  const canUseCache =
    Array.isArray(INVERTERS_CACHE.items) &&
    INVERTERS_CACHE.items.length > 0 &&
    (Date.now() - INVERTERS_CACHE.ok_ms) <= INVERTERS_CACHE_TTL_MS;

  if (canUseCache) return INVERTERS_CACHE.items;

  // último caso: mantém vazio mesmo
  return [];
}


// config (enabled/has_data)
async function fetchInverterStrings(plantId, inverterRealId) {
  const url = `${API_BASE}/plants/${plantId}/inverters/${inverterRealId}/strings`;
  const res = await fetch(url, { headers: buildAuthHeaders() });

  if (!res.ok) {
    console.warn(`[strings] ${res.status} em ${url}`);
    return null;
  }
  return normalizeApiBody(await res.json());
}

// medida (current_a)
async function fetchInverterStringsRealtime(plantId, inverterRealId) {
  const url = `${API_BASE}/plants/${plantId}/inverters/${inverterRealId}/strings/realtime`;
  const res = await fetch(url, { headers: buildAuthHeaders() });

  if (!res.ok) {
    console.warn(`[strings/realtime] ${res.status} em ${url}`);
    return null;
  }
  return normalizeApiBody(await res.json());
}

async function patchInverterString(plantId, inverterRealId, stringIndex, enabled) {
  const url = `${API_BASE}/plants/${plantId}/inverters/${inverterRealId}/strings/${stringIndex}`;
  const res = await fetch(url, {
    method: "PATCH",
    headers: buildAuthHeaders(),
    body: JSON.stringify({ enabled })
  });

  if (!res.ok) {
    throw new Error(`PATCH string falhou: HTTP ${res.status}`);
  }
  return normalizeApiBody(await res.json());
}

function getInvTsMs(inv) {
  const iso =
    inv.last_reading_at ??
    inv.last_reading_ts ??
    inv.last_ts ??
    inv.timestamp ??
    inv.event_ts ??
    null;

  const ms = iso ? new Date(iso).getTime() : NaN;
  return Number.isFinite(ms) ? ms : 0;
}

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

function computeInverterChipsByTelemetry(invertersRaw) {
  const inverters = dedupInvertersById(invertersRaw);
  const now = Date.now();

  let noComm = 0;
  let gen = 0;
  let off = 0;

  for (const inv of inverters) {
    const lastMs = parseTsToMs(
      inv.last_ts ??
      inv.timestamp ??
      inv.event_ts ??
      inv.ts ??
      inv.last_reading_at ??
      inv.last_reading_ts
    );
    const age = lastMs ? (now - lastMs) : Number.POSITIVE_INFINITY;

    if (age > INVERTER_NO_COMM_AFTER_MS) {
      noComm++;
      continue;
    }

    const working =
      inv.working === true ||
      inv.status === "working" ||
      inv.is_working === true;

    if (working) gen++;
    else off++;
  }

  const total = inverters.length;
  gen = Math.min(gen, total);
  off = Math.min(off, total);
  noComm = Math.min(noComm, total);

  return { total, gen, off, noComm };
}

function setChipCount(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = String(value);
}

function refreshInverterStatusChips(invertersRaw) {
  const { total, gen, off, noComm } = computeInverterChipsByTelemetry(invertersRaw);

  setChipCount("countGen", gen);
  setChipCount("countNoComm", noComm);
  setChipCount("countOff", off);

  console.log("[INV CHIPS]", { plantId: PLANT_ID, total, gen, off, noComm });
}

function getInverterRealId(inv) {
  return inv?.device_id ?? inv?.inverter_id ?? inv?.deviceId ?? inv?.id ?? null;
}

function getInverterDisplayName(inv, fallbackIndex = 0) {
  return (
    inv?.device_name ??
    inv?.inverter_name ??
    inv?.name ??
    `Inversor ${fallbackIndex + 1}`
  );
}

function getInverterSvgModern() {
  return `
    <svg class="inv-icon" viewBox="0 0 140 140" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <defs>
        <linearGradient id="invS" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="rgba(255,255,255,0.35)"/>
          <stop offset="1" stop-color="rgba(255,255,255,0.10)"/>
        </linearGradient>
        <filter id="invSoft" x="-30%" y="-30%" width="160%" height="160%">
          <feDropShadow dx="0" dy="8" stdDeviation="8" flood-color="rgba(0,0,0,0.55)"/>
        </filter>
      </defs>

      <g filter="url(#invSoft)">
        <rect x="18" y="18" width="104" height="104" rx="18"
              fill="rgba(0,0,0,0)"
              stroke="url(#invS)" stroke-width="3"/>
      </g>

      <path d="M42 88 H78" stroke="rgba(233,255,243,0.62)" stroke-width="4" stroke-linecap="round"/>
      <path d="M42 98 H78" stroke="rgba(233,255,243,0.35)" stroke-width="4" stroke-linecap="round" stroke-dasharray="8 7"/>

      <path d="M74 56
               C80 42, 88 42, 94 56
               C100 70, 108 70, 114 56"
            fill="none" stroke="rgba(233,255,243,0.62)" stroke-width="4"
            stroke-linecap="round" stroke-linejoin="round"/>
    </svg>
  `;
}

function ensureInverterRowsFromRealtime(inverters) {
  const container = document.getElementById("invertersContainer");
  if (!container) return;

  const preservedOpenId = OPEN_INVERTER_REAL_ID;
  const uniq = dedupInvertersById(Array.isArray(inverters) ? inverters : []);

  // ✅ se vier vazio, não limpa o DOM (evita sumir/piscar)
  if (uniq.length === 0 && container.children.length > 0) return;

  uniq.sort((a, b) => {
    const an = String(getInverterDisplayName(a, 0) || "");
    const bn = String(getInverterDisplayName(b, 0) || "");
    if (an && bn) return an.localeCompare(bn, "pt-BR", { numeric: true, sensitivity: "base" });
    return Number(getInverterRealId(a) || 0) - Number(getInverterRealId(b) || 0);
  });

  const nextIds = uniq
    .map(inv => getInverterRealId(inv))
    .filter(id => id != null)
    .map(id => String(id));
  const nextSignature = nextIds.join("|");

  if (LAST_INVERTER_ROWS_SIGNATURE === nextSignature && container.children.length > 0) {
    if (preservedOpenId != null && !nextIds.includes(String(preservedOpenId))) {
      OPEN_INVERTER_REAL_ID = null;
    }
    return;
  }

  LAST_INVERTER_ROWS_SIGNATURE = nextSignature;
  container.innerHTML = "";

  uniq.forEach((inv, idx) => {
    const realId = getInverterRealId(inv);
    if (realId == null) return;

    const title = getInverterDisplayName(inv, idx);

    const row = document.createElement("div");
    row.className = "inverter-toggle inverter-row";
    row.dataset.inverterRealId = String(realId);
    row.innerHTML = `
      <span class="status-dot"></span>
      <span class="inverter-name">${title}<i class="arrow fa-solid fa-chevron-down"></i></span>
      <span>—</span><span>—</span><span>—</span><span>—</span><span>—</span><span>—</span>
    `;

    const panel = document.createElement("div");
    panel.className = "inverter-strings";
    panel.id = `strings-${realId}`;
    panel.innerHTML = `
      <div class="inv-flow" data-inverter-real-id="${realId}">
        <svg class="inv-flow-arrows" viewBox="0 0 1000 260" preserveAspectRatio="none" aria-hidden="true">
          <defs>
            <filter id="arrowGlow" x="-40%" y="-40%" width="180%" height="180%">
              <feGaussianBlur stdDeviation="3.8" result="b"/>
              <feMerge>
                <feMergeNode in="b"/>
                <feMergeNode in="SourceGraphic"/>
              </feMerge>
            </filter>

            <marker id="arrowHead" viewBox="0 0 10 10" refX="9" refY="5"
                    markerWidth="9" markerHeight="9" orient="auto">
              <path d="M0,0 L10,5 L0,10 Z" fill="rgba(57,229,140,0.95)"/>
            </marker>
          </defs>

          <path class="arrow-path arrow-path--ac"
                d="M 500 88
                   C 390 66, 250 66, 128 90
                   C 92 98, 62 112, 46 136
                   C 34 154, 34 176, 50 192"
                marker-end="url(#arrowHead)"/>

          <path class="arrow-path arrow-path--dc"
                d="M 520 108
                   C 630 86, 770 86, 892 110
                   C 928 118, 958 132, 974 156
                   C 986 174, 986 196, 970 212"
                marker-end="url(#arrowHead)"/>
        </svg>

        <div class="inv-center">
          ${getInverterSvgModern()}
          <div class="inv-center-tags">
            <span class="inv-tag">AC</span>
            <span class="inv-tag">DC</span>
          </div>
        </div>

        <div class="inv-side inv-side--ac">
          <div class="inv-side-title">AC</div>
          <div class="inv-side-row" data-row="ac"></div>
        </div>

        <div class="inv-side inv-side--dc">
          <div class="inv-side-title">DC</div>
          <div class="inv-side-row" data-row="dc"></div>
        </div>
      </div>

      <div class="strings-grid" data-inverter-real-id="${realId}"></div>
    `;

    container.appendChild(row);
    container.appendChild(panel);
  });

  if (preservedOpenId != null) {
    const row = container.querySelector(`.inverter-toggle[data-inverter-real-id="${preservedOpenId}"]`);
    const panel = document.getElementById(`strings-${preservedOpenId}`);
    if (row && panel) {
      row.classList.add("open");
      panel.classList.add("open");
      panel.style.opacity = "1";
      panel.style.maxHeight = panel.scrollHeight + "px";
    } else {
      OPEN_INVERTER_REAL_ID = null;
    }
  }
}

function countOnlineInverters(invertersRaw) {
  const inverters = dedupInvertersById(invertersRaw);
  let online = 0;
  inverters.forEach(inv => {
    if (isOnlineByFreshness(inv) && !isZeroSnapshot(inv)) online++;
  });
  return online;
}

// ======================================================
// RENDER — HEADER DA USINA
// ======================================================
function renderHeaderSummary() {
  const elRated = document.getElementById("headerRatedPower");
  const elActive = document.getElementById("headerActivePower");
  const elCapacity = document.getElementById("headerCapacity");
  if (!elRated || !elActive || !elCapacity) return;

  elRated.textContent = `${asNumber(PLANT_STATE.rated_power_kwp).toFixed(1)} kWp`;
  elActive.textContent = `${asNumber(PLANT_STATE.active_power_kw).toFixed(1)} kW`;
  elCapacity.textContent = `${asNumber(PLANT_STATE.capacity_percent).toFixed(1)} %`;
}

// ======================================================
// RENDER — WEATHER
// ======================================================
function renderWeather(data) {
  const elIrr = document.getElementById("weatherIrradiance");
  const elAir = document.getElementById("weatherAirTemp");
  const elModule = document.getElementById("weatherModuleTemp");

  const hasWeather = !!(data && typeof data === "object");
  const staleIncoming = !hasWeather || isWeatherStale(data);

  // ✅ se vier bom, atualiza cache
  if (!staleIncoming) {
    WEATHER_CACHE = { data, ok_ms: Date.now() };
  }

  // ✅ se vier ruim, tenta usar cache (até 30 min)
  const canUseCache =
    WEATHER_CACHE.data &&
    (Date.now() - WEATHER_CACHE.ok_ms) <= WEATHER_STALE_AFTER_MS;

  const src = (!staleIncoming ? data : (canUseCache ? WEATHER_CACHE.data : null));

  if (!src) {
    if (elIrr) elIrr.textContent = "—";
    if (elAir) elAir.textContent = "—";
    if (elModule) elModule.textContent = "—";
    return;
  }

  const irr = toNumOrNull(src.irradiance_poa_wm2) ?? toNumOrNull(src.irradiance_ghi_wm2);
  const air = toNumOrNull(src.air_temperature_c);
  const module = toNumOrNull(src.module_temperature_c);

  if (elIrr) elIrr.textContent = irr != null ? `${irr.toFixed(0)} W/m²` : "—";
  if (elAir) elAir.textContent = air != null ? `${air.toFixed(1)} °C` : "—";
  if (elModule) elModule.textContent = module != null ? `${module.toFixed(1)} °C` : "—";
}


// ======================================================
// RENDER — ALARMES ATIVOS
// ======================================================
function renderAlarms(alarms) {
  const container = document.getElementById("plantActiveAlarms");
  if (!container) return;

  const sublineEl = document.getElementById("plantSubline");
  container.innerHTML = "";

  if (!alarms || !alarms.length) {
    container.textContent = "Nenhum alarme ativo";
    if (sublineEl) {
      sublineEl.textContent = "Nenhum alarme ativo";
      sublineEl.classList.remove("plant-subline--alarm");
    }
    return;
  }

  if (sublineEl) {
    sublineEl.textContent = `${alarms.length} alarme(s) ativo(s)`;
    sublineEl.classList.add("plant-subline--alarm");
  }

  alarms.forEach(a => {
    const row = document.createElement("div");
    row.className = `alarm-row ${a.severity || ""}`.trim();

    row.innerHTML = `
      <span>${a.device_type || "—"} • ${a.device_name || "—"}</span>
      <span>${a.event_name || (a.event_code != null ? `Evento ${a.event_code}` : "—")}</span>
      <span>${a.started_at ? new Date(a.started_at).toLocaleString() : "—"}</span>
    `;

    container.appendChild(row);
  });
}

// ======================================================
// ✅ RENDER — RELÉ (NOVO SHAPE DO ENDPOINT /relay/realtime)
// item: { is_online, relay_on, last_update, analog:{active_power_kw} }
// ======================================================
function ensureRelayUiScaffold() {
  const relayRow = document.getElementById("relayRow");
  if (!relayRow) return null;

  const nameEl = relayRow.querySelector(".device-name");
  const dotEl = document.getElementById("relayDot") || relayRow.querySelector(".status-dot");

  // Remove “extras antigos” visualmente (não remove do DOM, só não usa)
  const oldOnline = document.getElementById("relayOnlineText");
  const oldAvail = document.getElementById("relayAvailabilityText");
  const oldLast = document.getElementById("relayLastUpdateText");

  if (oldOnline) oldOnline.textContent = "—";
  if (oldAvail) oldAvail.textContent = "";
  if (oldLast) oldLast.textContent = "";

  // cria badge ONLINE/OFFLINE ao lado do nome
  let badgeOnline = relayRow.querySelector("#relayOnlineBadge");
  if (!badgeOnline) {
    badgeOnline = document.createElement("span");
    badgeOnline.id = "relayOnlineBadge";
    badgeOnline.style.display = "inline-flex";
    badgeOnline.style.alignItems = "center";
    badgeOnline.style.justifyContent = "center";
    badgeOnline.style.padding = "6px 10px";
    badgeOnline.style.borderRadius = "999px";
    badgeOnline.style.fontSize = "11px";
    badgeOnline.style.letterSpacing = "0.06em";
    badgeOnline.style.textTransform = "uppercase";
    badgeOnline.style.border = "1px solid rgba(255,255,255,0.10)";
    badgeOnline.style.background = "rgba(255,255,255,0.04)";
    badgeOnline.style.color = "rgba(233,255,243,0.88)";
    badgeOnline.style.marginLeft = "10px";
    badgeOnline.style.whiteSpace = "nowrap";

    if (nameEl) nameEl.appendChild(badgeOnline);
  }

  // cria badge ON/OFF do relé
  let badgeState = relayRow.querySelector("#relayStateBadge");
  if (!badgeState) {
    badgeState = document.createElement("span");
    badgeState.id = "relayStateBadge";
    badgeState.style.display = "inline-flex";
    badgeState.style.alignItems = "center";
    badgeState.style.justifyContent = "center";
    badgeState.style.padding = "6px 10px";
    badgeState.style.borderRadius = "999px";
    badgeState.style.fontSize = "11px";
    badgeState.style.letterSpacing = "0.06em";
    badgeState.style.textTransform = "uppercase";
    badgeState.style.border = "1px solid rgba(255,255,255,0.10)";
    badgeState.style.background = "rgba(255,255,255,0.04)";
    badgeState.style.color = "rgba(233,255,243,0.88)";
    badgeState.style.marginLeft = "10px";
    badgeState.style.whiteSpace = "nowrap";

    if (nameEl) nameEl.appendChild(badgeState);
  }

  // cria o kW na direita (no lugar “—” que você quer)
  let powerEl = relayRow.querySelector("#relayPowerText");
  if (!powerEl) {
    powerEl = document.createElement("span");
    powerEl.id = "relayPowerText";
    powerEl.style.justifySelf = "end";
    powerEl.style.textAlign = "right";
    powerEl.style.whiteSpace = "nowrap";
    powerEl.style.fontWeight = "700";
    powerEl.style.color = "rgba(233,255,243,0.92)";
    powerEl.style.opacity = "0.95";
    powerEl.style.textShadow = "0 0 12px rgba(57,229,140,0.10)";

    // garante grid com 3 colunas (dot | nome | direita)
    relayRow.style.gridTemplateColumns = "14px 1fr auto";
    relayRow.appendChild(powerEl);
  }

  // cria o timestamp discretinho abaixo do nome (opcional)
  let tsEl = relayRow.querySelector("#relayTsText");
  if (!tsEl) {
    tsEl = document.createElement("div");
    tsEl.id = "relayTsText";
    tsEl.style.marginTop = "4px";
    tsEl.style.fontSize = "12px";
    tsEl.style.opacity = "0.75";
    tsEl.style.color = "rgba(154,219,184,0.85)";

    // coloca dentro do device-name (abaixo do texto)
    if (nameEl) nameEl.appendChild(tsEl);
  }

  return { relayRow, nameEl, dotEl, badgeOnline, badgeState, powerEl, tsEl };
}

function renderRelayCard(relayItem) {
  const ui = ensureRelayUiScaffold();
  if (!ui) return;

  const { relayRow, badgeOnline, badgeState, powerEl, tsEl } = ui;

  // sem dados ainda
  if (!relayItem) {
    relayRow.classList.remove("online", "offline");
    badgeOnline.textContent = "—";
    badgeState.textContent = "—";
    powerEl.textContent = "— kW";
    tsEl.textContent = "Última atualização: —";
    return;
  }

  const isOnline = relayItem.is_online === true;
  const relayOn = relayItem.relay_on; // true/false/null
  const lastUpdate = relayItem.last_update ?? null;

  const kw = relayItem?.analog?.active_power_kw;
  const kwText = (kw === null || kw === undefined || Number.isNaN(Number(kw)))
    ? "— kW"
    : `${numFixedOrDash(kw, 1)} kW`;

  // classes do row (para a bolinha)
  relayRow.classList.remove("online", "offline");
  relayRow.classList.add(isOnline ? "online" : "offline");

  // badge online/offline
  badgeOnline.textContent = isOnline ? "ONLINE" : "OFFLINE";
  badgeOnline.style.borderColor = isOnline ? "rgba(57,229,140,0.26)" : "rgba(255,92,92,0.25)";
  badgeOnline.style.background = isOnline ? "rgba(57,229,140,0.08)" : "rgba(255,92,92,0.08)";
  badgeOnline.style.color = isOnline ? "rgba(233,255,243,0.92)" : "rgba(255,255,255,0.92)";

  // badge ON/OFF
  let stateText = "—";
  if (relayOn === true) stateText = "ON";
  else if (relayOn === false) stateText = "OFF";

  badgeState.textContent = stateText;

  if (stateText === "ON") {
    badgeState.style.borderColor = "rgba(57,229,140,0.30)";
    badgeState.style.background = "rgba(57,229,140,0.10)";
    badgeState.style.color = "rgba(233,255,243,0.95)";
    badgeState.style.boxShadow = "0 0 18px rgba(57,229,140,0.12)";
  } else if (stateText === "OFF") {
    badgeState.style.borderColor = "rgba(255,92,92,0.28)";
    badgeState.style.background = "rgba(255,92,92,0.08)";
    badgeState.style.color = "rgba(255,255,255,0.95)";
    badgeState.style.boxShadow = "0 0 16px rgba(255,92,92,0.10)";
  } else {
    badgeState.style.borderColor = "rgba(255,255,255,0.10)";
    badgeState.style.background = "rgba(255,255,255,0.04)";
    badgeState.style.color = "rgba(233,255,243,0.88)";
    badgeState.style.boxShadow = "none";
  }

  // kW à direita
  powerEl.textContent = kwText;

  // timestamp
  tsEl.textContent = `Última atualização: ${fmtDatePtBR(lastUpdate)}`;
}

// ======================================================
// ✅ RENDER — INVERTERS (KPIs por inversor) ✅
// ======================================================
function fillInverterRowSpans(rowEl, values) {
  const spans = rowEl.querySelectorAll(":scope > span");
  if (!spans || spans.length < 8) return false;

  setInverterMetricCell(spans[2], values.power);
  setInverterMetricCell(spans[3], values.eff);
  setInverterMetricCell(spans[4], values.temp);
  setInverterMetricCell(spans[5], values.freq);
  setInverterMetricCell(spans[6], values.pr);
  spans[7].textContent = values.last;
  return true;
}

function setInverterMetricCell(cellEl, metricText) {
  if (!cellEl) return;

  if (!metricText || metricText === "—") {
    cellEl.textContent = "—";
    return;
  }

  const parts = String(metricText).trim().split(/\s+/);
  const numberPart = parts.shift();
  const unitPart = parts.join(" ");

  if (!numberPart) {
    cellEl.textContent = metricText;
    return;
  }

  const unitHtml = unitPart
    ? `<span class="metric-unit"> ${unitPart}</span>`
    : "";

  cellEl.innerHTML = `<span class="metric-number">${numberPart}</span>${unitHtml}`;
}

function setRowOnlineUi(rowEl, online) {
  rowEl.classList.remove("online", "offline");
  rowEl.classList.add(online ? "online" : "offline");

  const dot = rowEl.querySelector(".status-dot, [data-role='status-dot']");
  if (dot) {
    dot.classList.remove("online", "offline");
    dot.classList.add(online ? "online" : "offline");
  }
}

function isOnlineByFreshness(inv) {
  const lastMs = getInvTsMs(inv);
  if (!lastMs) return false;
  const ageMs = Date.now() - lastMs;
  return ageMs <= INVERTER_ONLINE_AFTER_MS;
}

function isZeroSnapshot(inv) {
  const powerKw = asNumber(inv.active_power_kw ?? inv.power_kw ?? inv.power ?? inv.active_power, 0);
  const freqHz = asNumber(inv.frequency_hz ?? inv.freq_hz ?? inv.frequency, 0);
  const tempC = asNumber(inv.temperature_internal_c ?? inv.temperature_c ?? inv.temp_c ?? inv.temperature_current ?? inv.temperature, 0);

  // pacote "morto": 0 kW + 0 Hz + 0°C
  return powerKw === 0 && freqHz === 0 && tempC === 0;
}

function renderInverterRowKpis(rowEl, inv) {
  const powerKw = inv.active_power_kw ?? inv.power_kw ?? inv.power ?? inv.active_power;
  const effPct  = inv.efficiency_pct ?? inv.efficiency ?? inv.eff_pct;
  const tempC   = inv.temperature_internal_c ?? inv.temperature_c ?? inv.temp_c ?? inv.temperature_current ?? inv.temperature;
  const freqHz  = inv.frequency_hz ?? inv.freq_hz ?? inv.frequency;

  const prRaw = inv.performance_ratio ?? inv.pr ?? inv.pr_ratio ?? inv.performance;
  const lastTs =
    inv.last_reading_at ??
    inv.last_reading_ts ??
    inv.last_ts ??
    inv.timestamp ??
    inv.event_ts ??
    null;

  const prPct = normalizePercentMaybe(prRaw);

  const powerText = powerKw != null ? `${numFixedOrDash(powerKw, 0)} kW` : "—";
  const effText   = effPct  != null ? `${numFixedOrDash(effPct, 1)} %` : "—";
  const tempText  = tempC   != null ? `${numFixedOrDash(tempC, 1)} °C` : "—";
  const freqText  = freqHz  != null ? `${numFixedOrDash(freqHz, 2)} Hz` : "—";
  const prText    = prPct   != null ? `${numFixedOrDash(prPct, 2)} %` : "—";
  const lastText  = fmtDatePtBR(lastTs);

  fillInverterRowSpans(rowEl, {
    power: powerText,
    eff: effText,
    temp: tempText,
    freq: freqText,
    pr: prText,
    last: lastText
  });

  const freshOnline = isOnlineByFreshness(inv);
  const online = freshOnline && !isZeroSnapshot(inv);
  setRowOnlineUi(rowEl, online);
}

function renderInvertersRows(inverters) {
  const map = new Map();

  dedupInvertersById(Array.isArray(inverters) ? inverters : []).forEach(inv => {
    const id = getInverterRealId(inv);
    if (id != null) map.set(String(id), inv);
  });

  const rows = document.querySelectorAll(".inverter-toggle[data-inverter-real-id]");
  if (!rows || !rows.length) return;

  rows.forEach(row => {
    const id = row.dataset.inverterRealId;
    const inv = map.get(String(id));

    if (!inv) {
      fillInverterRowSpans(row, {
        power: "—",
        eff: "—",
        temp: "—",
        freq: "—",
        pr: "—",
        last: "—"
      });
      setRowOnlineUi(row, false);
      return;
    }

    renderInverterRowKpis(row, inv);
  });
}

// ======================================================
// ✅ MERGE: config(/strings) + realtime(/strings/realtime)
// ======================================================
function mergeStringsPayload(configPayload, realtimePayload, inverterRealId) {
  const maxStrings = 30;

  const cfgList = configPayload?.strings ?? [];
  const rtList = realtimePayload?.items ?? realtimePayload?.strings ?? [];

  const cfgMap = new Map(cfgList.map(s => [Number(s.string_index), s]));
  const rtMap = new Map(rtList.map(s => [Number(s.string_index), s]));

  const strings = [];
  for (let i = 1; i <= maxStrings; i++) {
    const cfg = cfgMap.get(i);
    const rt = rtMap.get(i);

    const enabled = cfg ? !!cfg.enabled : true;
    const has_data = (rt?.has_data ?? cfg?.has_data ?? false) === true;

    strings.push({
      string_index: i,
      enabled,
      has_data,
      current_a: rt?.current_a ?? null,
      last_ts: rt?.last_ts ?? null
    });
  }

  return {
    inverter_id: Number(inverterRealId),
    max_strings: maxStrings,
    strings
  };
}

// ======================================================
// RENDER — STRINGS (COM PERSISTÊNCIA LOCAL + VALOR REAL)
// ======================================================
function renderStringsGrid(gridEl, payload) {
  if (!gridEl) return;

  const strings = Array.isArray(payload?.strings) ? payload.strings : [];
  const inverterRealId = payload?.inverter_id;

  gridEl.innerHTML = "";

  if (!strings.length || inverterRealId == null) {
    gridEl.innerHTML = `<div style="color:#9adbb8; opacity:.7; padding:6px 2px;">Sem dados de strings</div>`;
    return;
  }

  const isEffectiveEnabled = (str) => {
    const disabledByPref = isDisabledPref(inverterRealId, str.string_index);
    return disabledByPref ? false : !!str.enabled;
  };

  const rerender = () => {
    renderStringsGrid(gridEl, {
      ...payload,
      strings
    });
  };

  const visibleStrings = strings.filter(isEffectiveEnabled);
  const hiddenStrings = strings.filter(s => !isEffectiveEnabled(s));

  visibleStrings.forEach(str => {
    const el = document.createElement("div");
    el.className = "string-card";
    el.dataset.string = str.string_index;

    if (!str.has_data) el.classList.add("nodata");
    else el.classList.add("active");

    const ampText = str.has_data ? fmtAmp(str.current_a) : "—";

    el.innerHTML = `
      S${str.string_index}
      <strong>${ampText}</strong>
    `;

    el.addEventListener("click", async (e) => {
      e.stopPropagation();

      el.classList.add("removing");

      setTimeout(async () => {
        setDisabledPref(inverterRealId, str.string_index, true);
        rerender();

        try {
          await patchInverterString(PLANT_ID, inverterRealId, str.string_index, false);
          str.enabled = false;
        } catch (error) {
          console.warn("PATCH falhou ao desativar string (rollback local):", error?.message || error);
          setDisabledPref(inverterRealId, str.string_index, false);
          rerender();
        }
      }, 180);
    });

    gridEl.appendChild(el);
  });

  if (hiddenStrings.length > 0) {
    const addBtn = document.createElement("button");
    addBtn.type = "button";
    addBtn.className = "string-card string-card-add";

    const next = hiddenStrings
      .slice()
      .sort((a, b) => Number(a.string_index) - Number(b.string_index))[0];

    addBtn.title = `Reativar ${next ? `S${next.string_index}` : "string"}`;
    addBtn.innerHTML = `
      <span class="plus">+</span>
      <strong>${next ? `S${next.string_index}` : `${hiddenStrings.length} off`}</strong>
    `;

    addBtn.addEventListener("click", async (e) => {
      e.stopPropagation();

      if (!next) return;

      setDisabledPref(inverterRealId, next.string_index, false);
      next.enabled = true;
      rerender();

      try {
        await patchInverterString(PLANT_ID, inverterRealId, next.string_index, true);
      } catch (error) {
        console.warn("PATCH falhou ao reativar string (rollback local):", error?.message || error);
        setDisabledPref(inverterRealId, next.string_index, true);
        next.enabled = false;
        rerender();
      }
    });

    gridEl.appendChild(addBtn);
  }
}

// ======================================================
// ✅ EXTRAS DO INVERSOR (chips agrupados abaixo das strings)
// ======================================================
function ensureInverterExtrasContainer(inverterRealId) {
  const panel = document.getElementById(`strings-${inverterRealId}`);
  if (!panel) return null;
  return panel;
}

function makeChip(label, value) {
  const el = document.createElement("div");
  el.className = "inv-chip";
  el.innerHTML = `
    <span class="inv-chip__label">${label}</span>
    <strong class="inv-chip__value">${value ?? "—"}</strong>
  `;
  return el;
}

function renderInverterExtras(inverterRealId, inv) {
  const wrap = ensureInverterExtrasContainer(inverterRealId);
  if (!wrap) return;

  const rowAc = wrap.querySelector(`.inv-side-row[data-row="ac"]`);
  const rowDc = wrap.querySelector(`.inv-side-row[data-row="dc"]`);
  if (!rowAc || !rowDc) return;

  rowAc.innerHTML = "";
  rowDc.innerHTML = "";

  const get = (k) => (inv && typeof inv === "object") ? inv[k] : null;

  // helpers de format (NÃO escondem zero)
  const f = (v, digits, unit) => {
    const n = Number(typeof v === "string" ? v.replace(",", ".") : v);
    if (!Number.isFinite(n)) return "—";
    return `${n.toFixed(digits)} ${unit}`;
  };

  const f0 = (v, unit) => {
    const n = Number(typeof v === "string" ? v.replace(",", ".") : v);
    if (!Number.isFinite(n)) return "—";
    return `${n.toFixed(0)} ${unit}`;
  };

  // ===== AC: Potências / FP + Tensões / Correntes =====
  rowAc.appendChild(makeChip("S aparente", f(get("apparent_power_kva"), 2, "kVA")));
  rowAc.appendChild(makeChip("FP", (() => {
    const v = get("power_factor");
    const n = Number(typeof v === "string" ? v.replace(",", ".") : v);
    if (!Number.isFinite(n)) return "—";
    return n.toFixed(3);
  })()));
  rowAc.appendChild(makeChip("Q reativa", f(get("power_reactive_kvar"), 2, "kvar")));
  rowAc.appendChild(makeChip("Energia dia", f(get("daily_active_energy_kwh"), 1, "kWh")));
  rowAc.appendChild(makeChip("Energia total", f(get("cumulative_active_energy_kwh"), 1, "kWh")));

  // ===== AC: Tensões / Correntes (usar nomes reais do backend + aliases) =====
  const vab = get("line_voltage_ab_v") ?? get("line_voltage_ab");
  const vbc = get("line_voltage_bc_v") ?? get("line_voltage_bc");
  const vca = get("line_voltage_ca_v") ?? get("line_voltage_ca");

  rowAc.appendChild(makeChip("V AB", f0(vab, "V")));
  rowAc.appendChild(makeChip("V BC", f0(vbc, "V")));
  rowAc.appendChild(makeChip("V CA", f0(vca, "V")));

  const ia = get("current_phase_a_a") ?? get("current_phase_a");
  const ib = get("current_phase_b_a") ?? get("current_phase_b");
  const ic = get("current_phase_c_a") ?? get("current_phase_c");

  rowAc.appendChild(makeChip("Ia", (() => {
    const n = Number(typeof ia === "string" ? ia.replace(",", ".") : ia);
    return Number.isFinite(n) ? `${n.toFixed(2)} A` : "—";
  })()));
  rowAc.appendChild(makeChip("Ib", (() => {
    const n = Number(typeof ib === "string" ? ib.replace(",", ".") : ib);
    return Number.isFinite(n) ? `${n.toFixed(2)} A` : "—";
  })()));
  rowAc.appendChild(makeChip("Ic", (() => {
    const n = Number(typeof ic === "string" ? ic.replace(",", ".") : ic);
    return Number.isFinite(n) ? `${n.toFixed(2)} A` : "—";
  })()));

  // ===== DC: Energia / DC / Isolação =====
  rowDc.appendChild(makeChip("P DC", f(get("power_dc_kw"), 2, "kW")));
  rowDc.appendChild(makeChip("V string", f0(get("string_voltage_v"), "V")));
  rowDc.appendChild(makeChip("R isol.", (() => {
    const v = get("resistance_insulation_mohm");
    const n = Number(typeof v === "string" ? v.replace(",", ".") : v);
    return Number.isFinite(n) ? `${n.toFixed(2)} MΩ` : "—";
  })()));
}

// ======================================================
// RENDER — FAIXA OPERACIONAL (se existir no HTML)
// ======================================================
function renderSummaryStrip() {
  const elActive = document.getElementById("summaryActivePower");
  const elRated = document.getElementById("summaryRatedPower");
  const elInv = document.getElementById("summaryInverters");
  const elPR = document.getElementById("summaryPR");

  if (!elActive || !elRated || !elInv || !elPR) return;

  elActive.textContent = `${asNumber(PLANT_STATE.active_power_kw).toFixed(1)} kW`;
  elRated.textContent = `${asNumber(PLANT_STATE.rated_power_kwp).toFixed(1)} kWp`;
  elInv.textContent = `${PLANT_STATE.inverter_online} / ${PLANT_STATE.inverter_total} Online`;
  elPR.textContent = `${asNumber(PLANT_STATE.pr_percent).toFixed(1)} %`;
}

// ======================================================
// CHART INSTANCES
// ======================================================
let dailyChartInstance = null;
let monthlyChartInstance = null;
let LAST_INVERTER_ROWS_SIGNATURE = "";

function dayKeySPNow() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
}

async function refreshDailyChartIfNeeded(force = false) {
  const now = Date.now();

  const todayKey = dayKeySPNow();
  if (DAILY_DAY_KEY !== todayKey) {
    // ✅ virou o dia: reseta e força reload
    DAILY_DAY_KEY = todayKey;
    DAILY = null;
    force = true;
    if (dailyChartInstance) {
      dailyChartInstance.destroy();
      dailyChartInstance = null;
    }
  }

  if (!force && (now - LAST_DAILY_FETCH_MS) < DAILY_REFRESH_EVERY_MS) return;
  LAST_DAILY_FETCH_MS = now;

  const daily = await fetchDailyEnergy(PLANT_ID);
  if (daily?.labels?.length) {
    DAILY = normalizeDailyPayload(daily);

    // ✅ se já existe chart, só atualiza dataset (mais leve)
    if (dailyChartInstance) {
      dailyChartInstance.data.labels = DAILY.labels;
      dailyChartInstance.data.datasets[0].data = DAILY.activePower;
      dailyChartInstance.data.datasets[1].data = DAILY.irradiance;
      dailyChartInstance.update("none");
    } else {
      renderDailyChart();
    }
  }
}

// ======================================================
// GRÁFICO DIÁRIO
// ======================================================
function renderDailyChart() {
  const canvas = document.getElementById("plantMainChart");
  if (!canvas || !DAILY?.labels?.length) return;

  const ctx = canvas.getContext("2d");

  if (dailyChartInstance) {
    dailyChartInstance.destroy();
    dailyChartInstance = null;
  }

  const greenGradient = ctx.createLinearGradient(0, 0, 0, 320);
  greenGradient.addColorStop(0, "rgba(57,229,140,0.55)");
  greenGradient.addColorStop(0.6, "rgba(57,229,140,0.35)");
  greenGradient.addColorStop(1, "rgba(57,229,140,0.05)");

  const yellowGradient = ctx.createLinearGradient(0, 0, 0, 320);
  yellowGradient.addColorStop(0, "rgba(255,216,77,0.45)");
  yellowGradient.addColorStop(1, "rgba(255,216,77,0.05)");

  dailyChartInstance = new Chart(ctx, {
    type: "line",
    data: {
      labels: DAILY.labels,
      datasets: [
        {
          data: DAILY.activePower,
          borderColor: "#39e58c",
          backgroundColor: greenGradient,
          fill: true,
          tension: 0.4,
          pointRadius: 0,
          borderWidth: 2,
          yAxisID: "yPower",
          spanGaps: false
        },
        {
          data: DAILY.irradiance,
          borderColor: "#ffd84d",
          backgroundColor: yellowGradient,
          fill: true,
          tension: 0.3,
          pointRadius: 0,
          borderWidth: 2,
          yAxisID: "yIrr",
          spanGaps: false
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: { legend: { display: false } },
      scales: {
        x: {
          ticks: { color: "#9adbb8", maxTicksLimit: 12 },
          grid: { color: "rgba(255,255,255,0.04)" }
        },
        yPower: {
          position: "left",
          min: 0,
          max: 2000,
          ticks: { color: "#39e58c", callback: v => `${v} kW` },
          grid: { color: "rgba(255,255,255,0.05)" }
        },
        yIrr: {
          position: "right",
          min: 0,
          max: 1200,
          ticks: { color: "#ffd84d", callback: v => `${v} W/m²` },
          grid: { drawOnChartArea: false }
        }
      }
    }
  });
}

// ======================================================
// ✅ NORMALIZA PAYLOAD MENSAL (unidade + outlier + labels)
// ======================================================
function normalizeMonthlyPayload(payload) {
  if (!payload) return payload;

  const labels = Array.isArray(payload.labels) ? payload.labels.slice() : [];

  const dailyNew = Array.isArray(payload.daily_kwh) ? payload.daily_kwh.slice() : null;
  const mtdNew = Array.isArray(payload.mtd_kwh) ? payload.mtd_kwh.slice() : null;
  const energyLegacy = Array.isArray(payload.energy_kwh) ? payload.energy_kwh.slice() : null;

  let daily = (dailyNew ?? energyLegacy ?? []).map(v => Number(v) || 0);

  const n = Math.min(labels.length || daily.length, daily.length || labels.length);
  const cutLabels = labels.slice(0, n);
  daily = daily.slice(0, n);

  const allLookDayOnly = cutLabels.length > 0 && cutLabels.every(looksLikeDayOnlyLabel);
  const duplicated = hasDuplicateLabels(cutLabels);

  const finalLabels =
    allLookDayOnly && duplicated ? buildLastNDaysLabels(daily.length) : cutLabels;

  let mtd = [];
  if (mtdNew && mtdNew.length >= daily.length) {
    mtd = mtdNew.slice(0, daily.length).map(v => Number(v) || 0);
  } else {
    let acc = 0;
    mtd = daily.map(v => (acc += (Number(v) || 0)));
  }

  const converted = maybeConvertWhToKwh(daily, mtd);
  daily = converted.daily;
  mtd = converted.mtd;

  const capped = capMonthlyOutliers(daily);
  daily = capped.daily;

  let acc = 0;
  mtd = daily.map(v => (acc += (Number(v) || 0)));

  return {
    ...payload,
    labels: finalLabels,
    daily_kwh: daily,
    mtd_kwh: mtd,
    energy_kwh: daily
  };
}

// ======================================================
// GRÁFICO MENSAL — SÓ BARRAS (SEM LINHA)
// ======================================================
function renderMonthlyChart() {
  const canvas = document.getElementById("plantMonthlyChart");
  if (!canvas) return;

  const labels = Array.isArray(MONTHLY?.labels) ? MONTHLY.labels : [];
  const daily = Array.isArray(MONTHLY?.daily_kwh)
    ? MONTHLY.daily_kwh.map(v => Number(v) || 0)
    : (Array.isArray(MONTHLY?.energy_kwh) ? MONTHLY.energy_kwh.map(v => Number(v) || 0) : []);

  if (!labels.length || !daily.length) return;

  const ctx = canvas.getContext("2d");

  if (monthlyChartInstance) {
    monthlyChartInstance.destroy();
    monthlyChartInstance = null;
  }

  const maxDaily = Math.max(...daily, 0);
  const suggestedMaxDaily = maxDaily > 0 ? Math.ceil(maxDaily * 1.25) : undefined;

  monthlyChartInstance = new Chart(ctx, {
    type: "bar",
    data: {
      labels,
      datasets: [
        {
          data: daily,
          backgroundColor: "rgba(200,200,200,0.75)",
          borderRadius: 8,
          barThickness: 18,
          categoryPercentage: 0.9,
          barPercentage: 0.9
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: (items) => items?.[0]?.label ? `Dia ${items[0].label}` : "",
            label: (item) => `Geração do dia: ${formatKwhPtBR(item?.raw)}`
          }
        }
      },
      scales: {
        x: {
          ticks: { color: "#9adbb8", maxTicksLimit: 8 },
          grid: { display: false }
        },
        y: {
          beginAtZero: true,
          suggestedMax: suggestedMaxDaily,
          ticks: { color: "#9adbb8", callback: (v) => formatNumberPtBR(v) },
          grid: { color: "rgba(255,255,255,0.04)" }
        }
      }
    }
  });
}

// ======================================================
// TOGGLE — abre/fecha o painel
// ======================================================
function setupInverterToggles() {
  const container = document.querySelector(".inverters-section");
  if (!container) return;

  container.addEventListener("click", async (e) => {
    if (e.target.closest(".string-card")) return;

    const row = e.target.closest(".inverter-toggle");
    if (!row) return;

    const inverterRealId = row.dataset.inverterRealId;
    const panel = document.getElementById(`strings-${inverterRealId}`);
    if (!panel) return;

    const willOpen = !row.classList.contains("open");

    document.querySelectorAll(".inverter-toggle.open").forEach(r => r.classList.remove("open"));
    document.querySelectorAll(".inverter-strings.open").forEach(p => {
      p.classList.remove("open");
      p.style.maxHeight = "0px";
      p.style.opacity = "0";
    });

    if (!willOpen) {
      OPEN_INVERTER_REAL_ID = null;
      return;
    }

    OPEN_INVERTER_REAL_ID = inverterRealId;
    row.classList.add("open");
    panel.classList.add("open");
    panel.style.opacity = "1";
    panel.style.maxHeight = panel.scrollHeight + "px";

    refreshStringsForRealInverter(inverterRealId).finally(() => {
      // ✅ renderiza extras (chips amarelos) abaixo das strings
      const inv = INVERTER_EXTRAS_BY_ID.get(String(inverterRealId));
      renderInverterExtras(inverterRealId, inv);

      const samePanel = document.getElementById(`strings-${inverterRealId}`);
      if (samePanel && samePanel.classList.contains("open")) {
        samePanel.style.maxHeight = samePanel.scrollHeight + "px";
      }
    });
  });
}

async function refreshStringsForRealInverter(inverterRealId) {
  const grid = document.querySelector(`.strings-grid[data-inverter-real-id="${inverterRealId}"]`);
  if (!grid) return;

  const reqSeq = ++STRINGS_REFRESH_SEQ;

  const [cfg, rt] = await Promise.all([
    fetchInverterStrings(PLANT_ID, inverterRealId),
    fetchInverterStringsRealtime(PLANT_ID, inverterRealId)
  ]);

  if (reqSeq !== STRINGS_REFRESH_SEQ) return;

  const merged = mergeStringsPayload(cfg, rt, inverterRealId);
  renderStringsGrid(grid, merged);

  const panel = document.getElementById(`strings-${inverterRealId}`);
  if (panel && panel.classList.contains("open")) {
    panel.style.maxHeight = panel.scrollHeight + "px";
  }
}

async function refreshOpenStringsPanels() {
  const trackedId = OPEN_INVERTER_REAL_ID;
  if (trackedId != null) {
    await refreshStringsForRealInverter(trackedId);
    return;
  }

  const openRow = document.querySelector(".inverter-toggle.open[data-inverter-real-id]");
  if (!openRow) return;
  OPEN_INVERTER_REAL_ID = openRow.dataset.inverterRealId;
  await refreshStringsForRealInverter(openRow.dataset.inverterRealId);
}

function renderPlantName(realtime) {
  if (!realtime || typeof realtime !== "object") return;

  const name =
    realtime?.power_plant_name ??
    realtime?.powerPlantName ??
    realtime?.name ??
    "—";

  PLANT_STATE = { ...PLANT_STATE, name };

  const el = document.getElementById("plantName") || document.querySelector(".plant-name");
  if (el) el.textContent = name;
}

// ======================================================
// ✅ REFRESH (realtime + alarms + inverters rows + strings abertas + relay)
// ======================================================
async function refreshRealtimeEverything() {
  if (REFRESH_RUNNING) return;
  REFRESH_RUNNING = true;

  let realtime = null;
  let alarms = [];
  let inverters = [];
  let relayItem = null;

  try {
    try { realtime = await fetchPlantRealtime(PLANT_ID); } catch (e) { console.warn("[realtime] fail", e); }
    try { alarms = await fetchActiveAlarms(PLANT_ID); } catch (e) { console.warn("[alarms] fail", e); }
    try { inverters = await fetchInvertersRealtime(PLANT_ID); } catch (e) { console.warn("[inverters] fail", e); }
    try { relayItem = await safeFetchRelayIfSupported(PLANT_ID); } catch (e) { console.warn("[relay] fail", e); }

    renderPlantName(realtime);

    if (realtime) {
      const rated = asNumber(realtime.rated_power_kw, PLANT_STATE.rated_power_kwp);
      const active = asNumber(realtime.active_power_kw, PLANT_STATE.active_power_kw);
      const prPct = normalizePercentMaybe(realtime.performance_ratio);

      PLANT_STATE = {
        ...PLANT_STATE,
        rated_power_kwp: rated,
        active_power_kw: active,
        capacity_percent: rated > 0 ? (active / rated) * 100 : PLANT_STATE.capacity_percent,
        pr_percent: prPct != null ? prPct : PLANT_STATE.pr_percent
      };
    }

    ACTIVE_ALARMS = Array.isArray(alarms) ? alarms : [];
    renderAlarms(ACTIVE_ALARMS);

    INVERTERS_REALTIME = Array.isArray(inverters) ? inverters : [];
    INVERTER_EXTRAS_BY_ID = new Map();
    dedupInvertersById(INVERTERS_REALTIME).forEach(inv => {
      const id = getInverterRealId(inv);
      if (id != null) INVERTER_EXTRAS_BY_ID.set(String(id), inv);
    });

    const dedup = dedupInvertersById(INVERTERS_REALTIME);
    PLANT_CATALOG.inverters = dedup;
    PLANT_STATE = {
      ...PLANT_STATE,
      inverter_total: dedup.length,
      inverter_online: countOnlineInverters(dedup)
    };

    ensureInverterRowsFromRealtime(INVERTERS_REALTIME);
    renderInvertersRows(INVERTERS_REALTIME);
    refreshInverterStatusChips(INVERTERS_REALTIME);

    RELAY_REALTIME = relayItem;
    PLANT_CATALOG.hasRelay = !!relayItem;
    setRelaySectionVisible(RELAY_SUPPORTED !== false);
    if (RELAY_SUPPORTED !== false) renderRelayCard(relayItem);

    renderHeaderSummary();
    renderWeather(realtime?.weather ?? null);
    renderSummaryStrip();

    try { await refreshOpenStringsPanels(); } catch (e) { console.warn("[strings] fail", e); }

    if (OPEN_INVERTER_REAL_ID != null) {
      const inv = INVERTER_EXTRAS_BY_ID.get(String(OPEN_INVERTER_REAL_ID));
      renderInverterExtras(OPEN_INVERTER_REAL_ID, inv);
    }

    try { await refreshDailyChartIfNeeded(false); } catch(e) { console.warn("[daily] fail", e); }
  } finally {
    REFRESH_RUNNING = false;
  }
}


// ======================================================
// INIT
// ======================================================
document.addEventListener("DOMContentLoaded", async () => {
  document.body.classList.add("plant-enter");
  setTimeout(() => document.body.classList.remove("plant-enter"), 500);
  if (!PLANT_ID) {
    console.warn("[plant] plant_id ausente na URL; mantendo tela sem dados de fallback.");
    renderHeaderSummary();
    renderSummaryStrip();
    return;
  }
  setupInverterToggles();
  setMultimeterSectionVisible(false);

  try {
    await refreshRealtimeEverything();

    const grids = document.querySelectorAll(".strings-grid[data-inverter-real-id]");
    for (const grid of grids) {
      const realId = grid.dataset.inverterRealId;
      await refreshStringsForRealInverter(realId);

      const panel = document.getElementById(`strings-${realId}`);
      if (panel?.classList.contains("open")) {
        panel.style.maxHeight = panel.scrollHeight + "px";
      }
    }

    await refreshDailyChartIfNeeded(true);

    const monthlyRaw = await fetchMonthlyEnergy(PLANT_ID);
    if (monthlyRaw) {
      MONTHLY = normalizeMonthlyPayload(monthlyRaw);
      renderMonthlyChart();
    }

    setInterval(refreshRealtimeEverything, PLANT_REFRESH_INTERVAL_MS);

    document.addEventListener("visibilitychange", async () => {
      if (!document.hidden) {
        await refreshRealtimeEverything();
      }
    });

    window.addEventListener("focus", async () => {
      await refreshRealtimeEverything();
    });
  } catch (e) {
    console.error(e);
    renderHeaderSummary();
    renderSummaryStrip();
  }
});
