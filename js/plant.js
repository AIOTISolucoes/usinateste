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
const STRING_STALE_AFTER_MS = 15 * 60 * 1000;

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

function formatKwPtBR(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  return `${formatNumberPtBR(n)} kW`;
}

function formatWm2PtBR(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  return `${formatNumberPtBR(n)} W/m²`;
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

  const expectedRaw =
    Array.isArray(payload.expectedPower) ? payload.expectedPower.slice() :
    Array.isArray(payload.expected_power_kw) ? payload.expected_power_kw.slice() :
    Array.isArray(payload.expected_power) ? payload.expected_power.slice() :
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

  const dateKeyInFortaleza = (d) => {
    if (!(d instanceof Date) || Number.isNaN(d.getTime())) return null;
    return d.toLocaleDateString("en-CA", { timeZone: "America/Fortaleza" });
  };

  const todayKeyFortaleza = new Date().toLocaleDateString("en-CA", { timeZone: "America/Fortaleza" });

  const points = [];
  for (let i = 0; i < labelsRaw.length; i++) {
    const minute = toMin(labelsRaw[i]);
    if (minute == null) continue;

    if (hasPointTimestamps) {
      const ts = pointTsRaw[i];
      const d = ts ? new Date(ts) : null;
      const key = dateKeyInFortaleza(d);
      if (!key || key !== todayKeyFortaleza) continue;
    }

    points.push({
      minute,
      power: powerRaw[i] != null ? asNumber(powerRaw[i], 0) : 0,
      irr: irrRaw[i] != null ? asNumber(irrRaw[i], 0) : 0,
      expected: expectedRaw[i] != null ? asNumber(expectedRaw[i], 0) : 0
    });
  }

  if (!points.length) {
    return {
      ...payload,
      labels: [],
      activePower: [],
      irradiance: [],
      expectedPower: []
    };
  }

  const mins = points.map(p => p.minute).sort((a, b) => a - b);

  // detecta o passo (1,5,10,15...) olhando o menor diff positivo
  let step = 5; // fallback
  if (mins.length >= 3) {
    const diffs = [];
    for (let i = 1; i < mins.length; i++) {
      const d = mins[i] - mins[i - 1];
      if (d > 0 && d <= 60) diffs.push(d);
    }
    if (diffs.length) step = Math.max(1, Math.min(...diffs));
  }

  const mapP = new Map();
  const mapI = new Map();
  const mapE = new Map();
  points.forEach(p => {
    mapP.set(p.minute, p.power);
    mapI.set(p.minute, p.irr);
    mapE.set(p.minute, p.expected);
  });

  // começa SEMPRE em 00:00 e termina no último minuto que chegou dado hoje
  const lastMin = Math.max(...mins);

  const labels = [];
  const activePower = [];
  const irradiance = [];
  const expectedPower = [];

  for (let m = 0; m <= lastMin; m += step) {
    const hh = String(Math.floor(m / 60)).padStart(2, "0");
    const mm = String(m % 60).padStart(2, "0");
    labels.push(`${hh}:${mm}`);

    // sem buraco visual: minutos faltantes viram 0
    activePower.push(mapP.has(m) ? mapP.get(m) : 0);
    irradiance.push(mapI.has(m) ? mapI.get(m) : 0);
    expectedPower.push(mapE.has(m) ? mapE.get(m) : 0);
  }

  return {
    ...payload,
    labels,
    activePower,
    irradiance,
    expectedPower
  };
}


// ======================================================
// SÉRIES REAIS (API)
// ======================================================
let DAILY = null;
let MONTHLY = null;
let ACTIVE_ALARMS = [];
let PLANT_ALARMS_MENU_OPEN = false;
let INVERTERS_REALTIME = [];
let RELAY_REALTIME = null; // ✅ NEW
let MULTIMETER_REALTIME = null;
let OPEN_INVERTER_REAL_ID = null;
let STRINGS_REFRESH_SEQ = 0;
let IS_REFRESHING_PLANT = false;
let INVERTER_EXTRAS_BY_ID = new Map(); // inverter_id (string) -> objeto inv completo

let PLANT_CATALOG = {
  inverters: [],
  hasRelay: false
};

let RELAY_SUPPORTED = null; // null = desconhecido / true / false
let MULTIMETER_SUPPORTED = null; // null = desconhecido / true / false

const API_BASE = "https://jgeg9i0js1.execute-api.us-east-1.amazonaws.com";
const PLANT_REFRESH_INTERVAL_MS = 10000;
const PLANT_ID = new URLSearchParams(window.location.search).get("plant_id");

function normalizeApiBody(data) {
  if (data && data.body) {
    return typeof data.body === "string" ? JSON.parse(data.body) : data.body;
  }
  return data;
}

function normalizeAlarmState(value) {
  const s = String(value ?? "").trim().toUpperCase();
  if (!s) return "UNKNOWN";
  if (["ACTIVE", "ACTIVO", "ATIVO", "OPEN", "ABERTO"].includes(s)) return "ACTIVE";
  if (["CLEARED", "CLEAR", "RESOLVED", "RESOLVIDO", "INACTIVE", "FECHADO", "CLOSED"].includes(s)) return "CLEARED";
  return s;
}

function normalizeAlarmSeverity(value) {
  const s = String(value ?? "").trim().toLowerCase();
  if (!s) return "info";
  if (["critical", "critico", "crítico", "high", "alta"].includes(s)) return "critical";
  if (["warning", "warn", "media", "média", "medium"].includes(s)) return "warning";
  if (["minor", "low", "baixa", "info", "informational"].includes(s)) return "info";
  return s;
}

function dedupePlantAlarms(alarms) {
  const map = new Map();
  (Array.isArray(alarms) ? alarms : []).forEach((alarm) => {
    const key = String(
      alarm?.event_row_id ??
      alarm?.alarm_id ??
      alarm?.id ??
      `${alarm?.event_code ?? "evt"}:${alarm?.timestamp ?? alarm?.started_at ?? ""}`
    );
    if (!map.has(key)) map.set(key, alarm);
  });
  return Array.from(map.values());
}

function hasActivePlantAlarms() {
  return Array.isArray(ACTIVE_ALARMS) && ACTIVE_ALARMS.length > 0;
}

const DEVICE_COMMAND_STATE = new Map();
let DEVICE_COMMAND_MENU_OPEN_KEY = null;

function getDeviceKey(deviceType, deviceId) {
  return `${String(deviceType || "")}:${String(deviceId ?? "")}`;
}

function getDevicePersistentState(deviceType, deviceId, fallback = "off") {
  return DEVICE_COMMAND_STATE.get(getDeviceKey(deviceType, deviceId)) || fallback;
}

function setDevicePersistentState(deviceType, deviceId, state) {
  if (state !== "on" && state !== "off") return;
  DEVICE_COMMAND_STATE.set(getDeviceKey(deviceType, deviceId), state);
}

function isTruthyFlag(value) {
  if (value === true) return true;
  if (value === false || value == null) return false;
  const s = String(value).trim().toLowerCase();
  return ["1", "true", "on", "online", "yes", "y", "sim"].includes(s);
}

function isFalsyFlag(value) {
  if (value === false) return true;
  if (value === true || value == null) return false;
  const s = String(value).trim().toLowerCase();
  return ["0", "false", "off", "offline", "no", "n", "nao", "não"].includes(s);
}

function normalizeCommunicationFault(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(String(value).replace(",", ".").trim());
  return Number.isFinite(n) ? n : null;
}

function commFaultMeansOnline(value) {
  const n = normalizeCommunicationFault(value);
  if (n === null) return null;
  if (n === 192) return true;
  if (n === 28) return false;
  return null;
}

function relayOnlineFromPayload(relayItem) {
  const eventRaw = relayItem?.event?.raw ?? {};

  const commCandidates = [
    relayItem?.communication_fault,
    relayItem?.event?.communication_fault,
    eventRaw?.communication_fault
  ];

  for (const c of commCandidates) {
    const commDecision = commFaultMeansOnline(c);
    if (commDecision !== null) return commDecision;
  }

  const statusCandidates = [
    relayItem?.is_online,
    relayItem?.online,
    relayItem?.isOnline,
    relayItem?.event?.is_online,
    eventRaw?.is_online,
    eventRaw?.online,
    eventRaw?.status_online
  ];

  for (const candidate of statusCandidates) {
    if (isTruthyFlag(candidate)) return true;
    if (isFalsyFlag(candidate)) return false;
  }

  return false;
}

function relayStateFromPayload(relayItem) {
  if (!relayItem) return "off";

  if (relayItem?.relay_on === true) return "on";
  if (relayItem?.relay_on === false) return "off";

  const eventRaw = relayItem?.event?.raw ?? {};
  const commCandidates = [
    relayItem?.communication_fault,
    relayItem?.event?.communication_fault,
    eventRaw?.communication_fault,
    relayItem?.analog?.communication_fault
  ];

  for (const c of commCandidates) {
    const decision = commFaultMeansOnline(c);
    if (decision === true) return "on";
    if (decision === false) return "off";
  }

  if (relayItem?.is_online === true || relayItem?.online === true) return "on";
  if (relayItem?.is_online === false || relayItem?.online === false) return "off";

  return "off";
}

function multimeterOnlineFromPayload(item) {
  const analog = item?.analog ?? {};
  const data = item?.data ?? {};

  const commCandidates = [
    item?.communication_fault,
    analog?.communication_fault,
    data?.communication_fault
  ];

  for (const c of commCandidates) {
    const commDecision = commFaultMeansOnline(c);
    if (commDecision !== null) return commDecision;
  }

  const statusCandidates = [
    item?.is_online,
    item?.online,
    item?.isOnline,
    item?.status_online,
    analog?.is_online,
    data?.is_online
  ];

  for (const candidate of statusCandidates) {
    if (isTruthyFlag(candidate)) return true;
    if (isFalsyFlag(candidate)) return false;
  }

  return false;
}

function renderDeviceCommandControl(deviceType, deviceId, currentState = "off") {
  const safeType = String(deviceType || "");
  const safeId = String(deviceId ?? "");
  const state = getDevicePersistentState(safeType, safeId, currentState);
  const stateClass = state === "on" ? "is-on" : "is-off";
  const key = getDeviceKey(safeType, safeId);
  return `
    <div class="device-command-control ${stateClass}" data-device-key="${key}" data-device-type="${safeType}" data-device-id="${safeId}">
      <button type="button" class="device-command-trigger" data-device-key="${key}" data-device-type="${safeType}" data-device-id="${safeId}" aria-label="Comandos do dispositivo"></button>
      <div class="device-command-popover" data-device-key="${key}">
        <button type="button" class="device-command-option device-command-option--on" data-device-type="${safeType}" data-device-id="${safeId}" data-device-key="${key}" data-action="on"><span class="dot"></span><span>ON</span></button>
        <button type="button" class="device-command-option device-command-option--off" data-device-type="${safeType}" data-device-id="${safeId}" data-device-key="${key}" data-action="off"><span class="dot"></span><span>OFF</span></button>
        <button type="button" class="device-command-option device-command-option--reset" data-device-type="${safeType}" data-device-id="${safeId}" data-device-key="${key}" data-action="reset"><span class="dot"></span><span>RESET</span></button>
      </div>
    </div>
  `;
}

function applyDeviceVisualState(deviceType, deviceId, state) {
  const key = getDeviceKey(deviceType, deviceId);
  document.querySelectorAll(`.device-command-control[data-device-key="${key}"]`).forEach((el) => {
    el.classList.remove("is-on", "is-off", "is-reset-flash");
    el.classList.add(state === "on" ? "is-on" : "is-off");
  });
}

function closeAllDeviceCommandMenus() {
  DEVICE_COMMAND_MENU_OPEN_KEY = null;
  document.querySelectorAll(".device-command-control.is-open").forEach((el) => {
    el.classList.remove("is-open");
  });
}

function ensureDeviceCommandModals() {
  if (document.getElementById("deviceCommandAuthModal")) return;
  const wrap = document.createElement("div");
  wrap.innerHTML = `
    <div id="deviceCommandAuthModal" class="device-command-modal hidden">
      <div class="device-command-modal-card">
        <h3>Autenticação</h3>
        <p id="deviceCommandAuthLabel">Confirme usuário e senha</p>
        <input id="deviceCommandUser" type="text" placeholder="Usuário" />
        <input id="deviceCommandPass" type="password" placeholder="Senha" />
        <div class="device-command-modal-actions">
          <button id="deviceCommandCancelBtn" type="button">Cancelar</button>
          <button id="deviceCommandConfirmBtn" type="button">Confirmar</button>
        </div>
      </div>
    </div>
    <div id="deviceCommandRunModal" class="device-command-modal hidden">
      <div class="device-command-modal-card">
        <h3 id="deviceCommandRunTitle">Executando comando</h3>
        <p id="deviceCommandRunSub">Processando...</p>
        <div class="device-command-progress-wrap"><div id="deviceCommandProgressBar"></div></div>
        <div id="deviceCommandProgressPct">0%</div>
        <p id="deviceCommandRunResult"></p>
      </div>
    </div>
  `;
  document.body.appendChild(wrap);
}

function openCommandAuthFlow({ deviceType, deviceId, action }) {
  ensureDeviceCommandModals();
  const auth = document.getElementById("deviceCommandAuthModal");
  const run = document.getElementById("deviceCommandRunModal");
  const authLabel = document.getElementById("deviceCommandAuthLabel");
  const cancelBtn = document.getElementById("deviceCommandCancelBtn");
  const confirmBtn = document.getElementById("deviceCommandConfirmBtn");
  const runTitle = document.getElementById("deviceCommandRunTitle");
  const runSub = document.getElementById("deviceCommandRunSub");
  const runResult = document.getElementById("deviceCommandRunResult");
  const bar = document.getElementById("deviceCommandProgressBar");
  const pct = document.getElementById("deviceCommandProgressPct");
  if (!auth || !run || !confirmBtn || !cancelBtn || !bar || !pct || !runSub || !runTitle || !runResult) return;

  authLabel.textContent = `${deviceType} ${deviceId} • ação ${action.toUpperCase()}`;
  auth.classList.remove("hidden");

  const closeAuth = () => auth.classList.add("hidden");
  cancelBtn.onclick = closeAuth;

  confirmBtn.onclick = () => {
    closeAuth();
    run.classList.remove("hidden");
    runTitle.textContent = `${deviceType} ${deviceId}`;
    runSub.textContent = action === "reset" ? "Resetando equipamento..." : `Executando ${action.toUpperCase()}...`;
    runResult.textContent = "";
    bar.style.width = "0%";
    pct.textContent = "0%";

    const previousState = getDevicePersistentState(deviceType, deviceId, "off");
    const totalMs = 120000;
    const startedAt = Date.now();
    const tick = setInterval(() => {
      const elapsed = Date.now() - startedAt;
      const progress = Math.min(100, Math.round((elapsed / totalMs) * 100));
      bar.style.width = `${progress}%`;
      pct.textContent = `${progress}%`;
      if (progress >= 100) {
        clearInterval(tick);
        const success = true;
        if (!success) {
          runResult.textContent = "Falha ao executar comando.";
          setTimeout(() => run.classList.add("hidden"), 1800);
          return;
        }

        if (action === "on" || action === "off") {
          setDevicePersistentState(deviceType, deviceId, action);
          applyDeviceVisualState(deviceType, deviceId, action);
          runResult.textContent = `Comando ${action.toUpperCase()} executado com sucesso.`;
        } else {
          runResult.textContent = "Reset realizado com sucesso.";
          document.querySelectorAll(`.device-command-control[data-device-key="${getDeviceKey(deviceType, deviceId)}"]`).forEach((el) => {
            el.classList.add("is-reset-flash");
          });
          setTimeout(() => {
            document.querySelectorAll(`.device-command-control[data-device-key="${getDeviceKey(deviceType, deviceId)}"]`).forEach((el) => {
              el.classList.remove("is-reset-flash");
            });
            applyDeviceVisualState(deviceType, deviceId, previousState);
          }, 1500);
        }
        setTimeout(() => run.classList.add("hidden"), 2200);
      }
    }, 1000);
  };
}

function wireDeviceCommandButtons(rootEl) {
  if (!rootEl) return;
  rootEl.querySelectorAll(".device-command-trigger").forEach((btn) => {
    if (btn.dataset.wiredCmdTrigger === "true") return;
    btn.dataset.wiredCmdTrigger = "true";
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const key = btn.dataset.deviceKey || "";
      if (!key) return;
      const control = document.querySelector(`.device-command-control[data-device-key="${key}"]`);
      if (!control) return;
      const shouldOpen = DEVICE_COMMAND_MENU_OPEN_KEY !== key;
      closeAllDeviceCommandMenus();
      if (shouldOpen) {
        control.classList.add("is-open");
        DEVICE_COMMAND_MENU_OPEN_KEY = key;
      }
    });
  });

  rootEl.querySelectorAll(".device-command-option").forEach((btn) => {
    if (btn.dataset.wiredCmdOption === "true") return;
    btn.dataset.wiredCmdOption = "true";
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const deviceType = btn.dataset.deviceType || "";
      const deviceId = btn.dataset.deviceId || "";
      const action = btn.dataset.action || "";
      closeAllDeviceCommandMenus();
      console.log("[device-command]", { deviceType, deviceId, action });
      openCommandAuthFlow({ deviceType, deviceId, action });
    });
  });
}

function renderAlarmMenuButton() {
  const btn = document.getElementById("plantAlarmMenuButton");
  const count = document.getElementById("plantAlarmMenuCount");
  const panel = document.getElementById("plantAlarmMenuPanel");
  const empty = document.getElementById("plantAlarmMenuEmptyState");
  const icon = btn?.querySelector(".plant-alarm-menu-icon");

  if (!btn) return;

  const hasAlarms = hasActivePlantAlarms();

  btn.classList.toggle("is-clean", !hasAlarms);
  btn.classList.toggle("is-alert", hasAlarms);
  btn.setAttribute("aria-expanded", PLANT_ALARMS_MENU_OPEN ? "true" : "false");

  if (count) {
    count.textContent = String(ACTIVE_ALARMS.length || 0);
    count.style.display = hasAlarms ? "inline-flex" : "none";
  }

  if (icon) {
    icon.innerHTML = hasAlarms
      ? `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 7v6" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/><circle cx="12" cy="17" r="1.4" fill="currentColor"/><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>`
      : `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 12.5l4 4 8-9" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>`;
  }

  if (panel) {
    panel.classList.toggle("open", PLANT_ALARMS_MENU_OPEN);
  }

  if (empty) {
    empty.style.display = hasAlarms ? "none" : "";
  }
}

function setPlantAlarmMenuOpen(open) {
  PLANT_ALARMS_MENU_OPEN = !!open;
  renderAlarmMenuButton();
}

function setupPlantAlarmMenu() {
  const btn = document.getElementById("plantAlarmMenuButton");
  const panel = document.getElementById("plantAlarmMenuPanel");
  const closeBtn = document.getElementById("plantAlarmMenuClose");

  if (!btn || !panel) return;
  if (btn.dataset.wiredAlarmMenu === "true") return;
  btn.dataset.wiredAlarmMenu = "true";

  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    setPlantAlarmMenuOpen(!PLANT_ALARMS_MENU_OPEN);
  });

  panel.addEventListener("click", (e) => {
    e.stopPropagation();
  });

  closeBtn?.addEventListener("click", (e) => {
    e.stopPropagation();
    setPlantAlarmMenuOpen(false);
  });

  document.addEventListener("click", () => {
    if (PLANT_ALARMS_MENU_OPEN) setPlantAlarmMenuOpen(false);
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && PLANT_ALARMS_MENU_OPEN) {
      setPlantAlarmMenuOpen(false);
    }
  });
}

function sortPlantAlarmsDesc(alarms) {
  return (Array.isArray(alarms) ? alarms : []).slice().sort((a, b) => {
    const ta = Date.parse(a?.started_at ?? a?.timestamp ?? "") || 0;
    const tb = Date.parse(b?.started_at ?? b?.timestamp ?? "") || 0;
    return tb - ta;
  });
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
  const data = normalizeApiBody(await res.json());
  const items = Array.isArray(data) ? data : (Array.isArray(data?.items) ? data.items : []);
  const normalized = items.map((alarm) => ({
    ...alarm,
    state: normalizeAlarmState(alarm?.state ?? alarm?.alarm_state ?? alarm?.status),
    severity: normalizeAlarmSeverity(alarm?.severity ?? alarm?.alarm_severity ?? alarm?.level)
  }));
  return sortPlantAlarmsDesc(
    dedupePlantAlarms(
      normalized.filter((alarm) => alarm.state === "ACTIVE" && alarm.acknowledged !== true)
    )
  );
}

async function acknowledgePlantAlarm(alarm) {
  const alarmId = alarm?.alarm_id ?? alarm?.id ?? alarm?.event_row_id;
  if (!alarmId) throw new Error("alarm_id ausente para ACK");

  const user = (() => {
    try {
      return JSON.parse(localStorage.getItem("user")) || {};
    } catch {
      return {};
    }
  })();

  const response = await fetch(`${API_BASE}/alarms/${alarmId}/ack`, {
    method: "POST",
    headers: buildAuthHeaders(),
    body: JSON.stringify({
      event_row_id: alarm?.event_row_id ?? null,
      power_plant_id: alarm?.power_plant_id ?? alarm?.plant_id ?? PLANT_ID ?? null,
      acknowledged_by: user?.name ?? user?.email ?? user?.username ?? "frontend",
      acknowledgment_note: "Reconhecido via operação SCADA"
    })
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(`Falha ao reconhecer alarme (${response.status}): ${errorText}`);
  }

  return true;
}

async function fetchTrackersRealtime(plantId) {
  const res = await fetch(`${API_BASE}/plants/${plantId}/trackers/realtime`, {
    headers: buildAuthHeaders()
  });

  if (res.status === 404) {
    console.warn("[trackers/realtime] 404");
    return { items: [], plant_center: null, plant_bounds: null };
  }

  if (!res.ok) {
    console.warn(`[trackers/realtime] HTTP ${res.status}`);
    return [];
  }

  const raw = await res.json();
  const data = normalizeApiBody(raw);
  if (Array.isArray(data)) return { items: data, plant_center: null, plant_bounds: null };
  const items =
    Array.isArray(data?.items) ? data.items :
    Array.isArray(data?.trackers) ? data.trackers :
    Array.isArray(data?.item) ? data.item : [];
  return {
    items,
    plant_center: data?.plant_center ?? null,
    plant_bounds: data?.plant_bounds ?? null
  };
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

async function safeFetchMultimeterIfSupported(plantId) {
  if (MULTIMETER_SUPPORTED === false) return null;

  const url = `${API_BASE}/plants/${plantId}/multimeter/realtime`;
  const res = await fetch(url, { headers: buildAuthHeaders() });

  if (res.status === 404) {
    MULTIMETER_SUPPORTED = false;
    return null;
  }

  if (!res.ok) {
    console.warn(`[multimeter/realtime] HTTP ${res.status} em ${url}`);
    return null;
  }

  MULTIMETER_SUPPORTED = true;
  const payload = normalizeApiBody(await res.json());
  return payload?.item ?? payload ?? null;
}

function setRelaySectionVisible(visible) {
  const relaySection = document.getElementById("relaySection");
  if (relaySection) relaySection.style.display = visible ? "" : "none";
}

function setMultimeterSectionVisible(visible) {
  const section = document.getElementById("multimeterSection");
  if (section) section.style.display = visible ? "" : "none";
}

function setTrackersSectionVisible(visible) {
  const section = document.getElementById("trackersSection");
  const btn = document.getElementById("trackersMenuToggle");
  if (!section) return;
  section.classList.toggle("trackers-hidden", !visible);
  if (btn) {
    btn.classList.toggle("on", visible);
    btn.setAttribute("aria-expanded", visible ? "true" : "false");
  }
}

function setTrackersCollapsed(collapsed) {
  const section = document.getElementById("trackersSection");
  const tabToggleEl = document.getElementById("trackersTabToggle");
  if (!section) return;

  section.classList.toggle("is-collapsed", !!collapsed);

  if (tabToggleEl) {
    tabToggleEl.setAttribute("aria-expanded", collapsed ? "false" : "true");
  }
}

// ✅ realtime por inversor
async function fetchInvertersRealtime(plantId) {
  const candidates = [
    `${API_BASE}/plants/${plantId}/inverters/realtime`,
    `${API_BASE}/plants/${plantId}/inverters`
  ];

  for (const url of candidates) {
    const res = await fetch(url, { headers: buildAuthHeaders() });
    if (res.ok) {
      const data = normalizeApiBody(await res.json());
      return Array.isArray(data) ? data : (data?.items || []);
    }

    if (res.status === 404) continue;
    console.warn(`[inverters realtime] HTTP ${res.status} em ${url}`);
  }

  console.warn("[inverters realtime] nenhum endpoint disponível -> mantendo estático");
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

  const sortByName = (a, b) => {
    const an = String(getInverterDisplayName(a, 0) || "");
    const bn = String(getInverterDisplayName(b, 0) || "");
    if (an && bn) return an.localeCompare(bn, "pt-BR", { numeric: true, sensitivity: "base" });
    return Number(getInverterRealId(a) || 0) - Number(getInverterRealId(b) || 0);
  };

  uniq.sort(sortByName);

  const nextIds = uniq
    .map(inv => getInverterRealId(inv))
    .filter(id => id != null)
    .map(id => String(id));

  // Signature includes cabin assignment so regrouping triggers re-render
  const nextSignature = uniq
    .map(inv => `${getInverterRealId(inv)}:${inv.cabin_id ?? ""}`)
    .join("|");

  if (LAST_INVERTER_ROWS_SIGNATURE === nextSignature && container.children.length > 0) {
    if (preservedOpenId != null && !nextIds.includes(String(preservedOpenId))) {
      OPEN_INVERTER_REAL_ID = null;
    }
    return;
  }

  LAST_INVERTER_ROWS_SIGNATURE = nextSignature;
  container.innerHTML = "";

  // Helper: create and append a single inverter row+panel into a parent element
  const appendInverterRowAndPanel = (parent, inv, idx) => {
    const realId = getInverterRealId(inv);
    if (realId == null) return;

    const title = getInverterDisplayName(inv, idx);

    const row = document.createElement("div");
    row.className = "inverter-toggle inverter-row";
    row.dataset.inverterRealId = String(realId);
    row.innerHTML = `
      <span class="status-dot"></span>
      <span class="inverter-name">${title}<i class="arrow fa-solid fa-chevron-down"></i></span>
      <span>—</span>
      <span>—</span>
      <span>—</span>
      <span>—</span>
      <span>—</span>
      <span>—</span>
      <span class="device-command-cell">
        ${renderDeviceCommandControl("inverter", realId, isOnlineByFreshness(inv) && !isZeroSnapshot(inv) ? "on" : "off")}
      </span>
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

    parent.appendChild(row);
    parent.appendChild(panel);
    wireDeviceCommandButtons(row);
    const inferredState = isOnlineByFreshness(inv) && !isZeroSnapshot(inv) ? "on" : "off";
    applyDeviceVisualState("inverter", String(realId), getDevicePersistentState("inverter", String(realId), inferredState));
  };

  const hasCabins = uniq.some(inv => inv.cabin_id != null);

  if (!hasCabins) {
    // Flat rendering — comportamento original
    uniq.forEach((inv, idx) => appendInverterRowAndPanel(container, inv, idx));
  } else {
    // Agrupar por cabin_id
    const groupMap = new Map();
    const noCabin = [];

    uniq.forEach(inv => {
      const cabinId = inv.cabin_id;
      if (cabinId == null) {
        noCabin.push(inv);
      } else {
        if (!groupMap.has(cabinId)) {
          groupMap.set(cabinId, {
            name: inv.section_name ?? inv.cabin_name ?? inv.cabin_code ?? `Cabine ${cabinId}`,
            displayOrder: inv.cabin_display_order ?? 999,
            inverters: []
          });
        }
        groupMap.get(cabinId).inverters.push(inv);
      }
    });

    const sortedGroups = Array.from(groupMap.values())
      .sort((a, b) => a.displayOrder - b.displayOrder);

    if (noCabin.length > 0) {
      sortedGroups.push({ name: "Sem cabine", displayOrder: 9999, inverters: noCabin });
    }

    let globalIdx = 0;
    sortedGroups.forEach(group => {
      const groupEl = document.createElement("div");
      groupEl.className = "cabin-group";
      groupEl.dataset.cabinCollapsed = "false";

      const header = document.createElement("div");
      header.className = "cabin-group-header";
      header.innerHTML = `
        <svg class="cabin-group-header__icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <rect x="2" y="7" width="20" height="13" rx="1"/>
          <path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2"/>
          <line x1="12" y1="12" x2="12" y2="16"/>
          <line x1="10" y1="14" x2="14" y2="14"/>
        </svg>
        <span class="cabin-group-header__name">${group.name}</span>
        <span class="cabin-group-header__count">${group.inverters.length} inversor${group.inverters.length !== 1 ? "es" : ""}</span>
        <svg class="cabin-group-header__chevron" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="6 9 12 15 18 9"/>
        </svg>
      `;

      const body = document.createElement("div");
      body.className = "cabin-group-body";

      header.addEventListener("click", () => {
        const collapsed = groupEl.dataset.cabinCollapsed === "true";
        groupEl.dataset.cabinCollapsed = collapsed ? "false" : "true";
        body.classList.toggle("is-collapsed", !collapsed);
      });

      groupEl.appendChild(header);
      groupEl.appendChild(body);

      group.inverters.forEach(inv => {
        appendInverterRowAndPanel(body, inv, globalIdx++);
      });

      container.appendChild(groupEl);
    });
  }

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
  const hasWeather = !!(data && typeof data === "object");
  const d = hasWeather ? data : {};

  const elIrr = document.getElementById("weatherIrradiance");
  const elAir = document.getElementById("weatherAirTemp");
  const elModule = document.getElementById("weatherModuleTemp");

  if (elIrr) {
    const value = d.irradiance_poa_wm2 ?? d.POA_irradiance ?? null;
    elIrr.textContent = value != null ? `${Number(value).toFixed(0)} W/m²` : "—";
  }
  if (elAir) {
    const value = d.air_temperature_c ?? d.temp_ambiente ?? null;
    elAir.textContent = value != null ? `${Number(value).toFixed(1)} °C` : "—";
  }
  if (elModule) {
    const value = d.module_temperature_c ?? d.temp_modulo ?? null;
    elModule.textContent = value != null ? `${Number(value).toFixed(1)} °C` : "—";
  }

  // Painel expandido
  const wxWind = document.getElementById("wxWindSpeed");
  if (wxWind) {
    const v = d.wind_speed_ms ?? d.vel_vento ?? null;
    wxWind.textContent = v != null ? `${Number(v).toFixed(1)} m/s` : "—";
  }

  const wxDir = document.getElementById("wxWindDir");
  if (wxDir) {
    const v = d.wind_direction_deg ?? d.wind_direction ?? null;
    wxDir.textContent = v != null ? `${Number(v).toFixed(0)}°` : "—";
  }

  const wxGhi = document.getElementById("wxGhi");
  if (wxGhi) {
    const v = d.irradiance_ghi_wm2 ?? d.GHI_irradiance ?? null;
    wxGhi.textContent = v != null ? `${Number(v).toFixed(0)} W/m²` : "—";
  }

  const wxRain = document.getElementById("wxRain");
  if (wxRain) {
    const hour = d.rainfall_hour_mm ?? d.acumulador_pluv_hour ?? null;
    const month = d.rainfall_month_mm ?? d.acumulador_pluv_month ?? null;
    const hStr = hour != null ? `${Number(hour).toFixed(1)}` : "—";
    const mStr = month != null ? `${Number(month).toFixed(1)}` : "—";
    wxRain.textContent = `${hStr} / ${mStr} mm`;
  }

  const wxBatt = document.getElementById("wxBattery");
  if (wxBatt) {
    const v = d.battery_voltage_v ?? d.volt_battery ?? null;
    wxBatt.textContent = v != null ? `${Number(v).toFixed(2)} V` : "—";
  }

  const wxSensor = document.getElementById("wxRainSensor");
  if (wxSensor) {
    const v = d.rain_sensor ?? d.sensor_chuva ?? null;
    wxSensor.textContent = v != null ? (Number(v) === 1 ? "Chuva" : "Seco") : "—";
  }
}

function setupWeatherExpand() {
  const btn = document.getElementById("weatherExpandBtn");
  const panel = document.getElementById("weatherExpandPanel");
  if (!btn || !panel) return;
  btn.addEventListener("click", () => {
    const open = panel.classList.toggle("is-open");
    btn.classList.toggle("is-open", open);
  });
}

// ======================================================
// RENDER — ALARMES ATIVOS
// ======================================================
function renderAlarms(alarms) {
  const container = document.getElementById("plantActiveAlarms");
  if (!container) return;

  const sublineEl = document.getElementById("plantSubline");
  container.innerHTML = "";
  const filtered = sortPlantAlarmsDesc(
    dedupePlantAlarms(
      (Array.isArray(alarms) ? alarms : []).filter(
        (alarm) => normalizeAlarmState(alarm?.state ?? alarm?.alarm_state ?? alarm?.status) === "ACTIVE" && alarm?.acknowledged !== true
      )
    )
  );

  if (!filtered.length) {
    container.innerHTML = "";
    if (sublineEl) {
      sublineEl.textContent = "Nenhum alarme ativo";
      sublineEl.classList.remove("plant-subline--alarm");
    }
    renderAlarmMenuButton();
    return;
  }

  if (sublineEl) {
    sublineEl.textContent = `${filtered.length} alarme(s) ativo(s)`;
    sublineEl.classList.add("plant-subline--alarm");
  }

  filtered.forEach(a => {
    const row = document.createElement("div");
    row.className = `alarm-row ${normalizeAlarmSeverity(a.severity) || ""}`.trim();
    const deviceType =
      a.device_type ??
      a.device_type_name ??
      a.event_source ??
      "—";
    const when =
      a.started_at ??
      a.timestamp ??
      null;

    row.innerHTML = `
      <span class="alarm-device">${deviceType} • ${a.device_name || "—"}</span>
      <span class="alarm-desc">${a.event_name || (a.event_code != null ? `Evento ${a.event_code}` : "—")}</span>
      <span class="alarm-time">${when ? new Date(when).toLocaleString("pt-BR") : "—"}</span>
    `;
    row.title = "Duplo clique para reconhecer alarme";
    row.addEventListener("dblclick", async () => {
      row.style.opacity = "0.6";
      try {
        await acknowledgePlantAlarm(a);
        ACTIVE_ALARMS = ACTIVE_ALARMS.filter((alarm) => String(alarm?.event_row_id ?? alarm?.alarm_id ?? alarm?.id) !== String(a?.event_row_id ?? a?.alarm_id ?? a?.id));
        renderAlarms(ACTIVE_ALARMS);
        renderAlarmMenuButton();
        if (!ACTIVE_ALARMS.length) {
          setPlantAlarmMenuOpen(false);
        }
      } catch (err) {
        row.style.opacity = "";
        console.error("[alarms][ack] erro", err);
        alert("Não foi possível reconhecer o alarme. Tente novamente.");
      }
    });

    container.appendChild(row);
  });
  renderAlarmMenuButton();
}

// ======================================================
// ✅ RENDER — RELÉ (NOVO SHAPE DO ENDPOINT /relay/realtime)
// item: { is_online, relay_on, last_update, analog:{active_power_kw} }
// ======================================================
function ensureRelayUiScaffold() {
  const relayRow = document.getElementById("relayRow");
  if (!relayRow) return null;

  const nameEl = relayRow.querySelector(".relay-left");
  const dotEl = document.getElementById("relayDot") || relayRow.querySelector(".status-dot");
  const commandBarWrap = document.getElementById("relayCommandBarWrap");
  const legacyRight = relayRow.querySelector(".relay-right");
  const detailsPanel = document.getElementById("relayDetailsPanel");

  // Remove “extras antigos” visualmente (não remove do DOM, só não usa)
  const oldOnline = document.getElementById("relayOnlineText");
  const oldAvail = document.getElementById("relayAvailabilityText");
  const oldLast = document.getElementById("relayLastUpdateText");

  if (oldOnline) oldOnline.textContent = "—";
  if (oldAvail) oldAvail.textContent = "";
  if (oldLast) oldLast.textContent = "";
  if (legacyRight) legacyRight.style.display = "none";

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

  const legacyStateEl = relayRow.querySelector("#relayStateBadge");
  if (legacyStateEl) legacyStateEl.remove();

  if (commandBarWrap && commandBarWrap.parentElement !== relayRow) {
    relayRow.appendChild(commandBarWrap);
  }

  relayRow.classList.add("relay-row--table");
  relayRow.style.gridTemplateColumns = "14px minmax(250px,1.45fr) minmax(150px,0.95fr) minmax(150px,0.95fr) minmax(150px,0.95fr) minmax(190px,1fr) 64px";

  let expandIcon = relayRow.querySelector("#relayExpandIcon");
  if (!expandIcon) {
    expandIcon = document.createElement("i");
    expandIcon.id = "relayExpandIcon";
    expandIcon.className = "fa-solid fa-chevron-down relay-expand-icon";
    if (nameEl) nameEl.appendChild(expandIcon);
  }

  const ensureMetricCell = (id, gridColumn) => {
    let el = relayRow.querySelector(`#${id}`);
    if (!el) {
      el = document.createElement("div");
      el.id = id;
      el.className = "device-metric-cell";
      relayRow.appendChild(el);
    }
    el.style.gridColumn = String(gridColumn);
    return el;
  };

  const activePowerEl = ensureMetricCell("relayActivePowerValue", 3);
  const apparentPowerEl = ensureMetricCell("relayApparentPowerValue", 4);
  const reactivePowerEl = ensureMetricCell("relayReactivePowerValue", 5);
  const tsEl = ensureMetricCell("relayTsText", 6);
  tsEl.classList.add("relay-timestamp-cell");
  activePowerEl.dataset.label = "ACTIVE POWER";
  apparentPowerEl.dataset.label = "APPARENT POWER";
  reactivePowerEl.dataset.label = "REACTIVE POWER";
  tsEl.dataset.label = "ÚLTIMA LEITURA";

  if (commandBarWrap) {
    commandBarWrap.style.gridColumn = "7";
    commandBarWrap.style.justifySelf = "center";
    commandBarWrap.dataset.label = "COMANDOS";
  }

  if (detailsPanel) {
    detailsPanel.style.maxHeight = detailsPanel.classList.contains("open") ? "1200px" : "0px";
  }

  if (!relayRow.dataset.toggleBound) {
    relayRow.dataset.toggleBound = "true";
    relayRow.addEventListener("click", (event) => {
      if (
        event.target.closest("#relayCommandBarWrap") ||
        event.target.closest(".device-command-control") ||
        event.target.closest(".device-command-popover")
      ) return;

      const nextOpen = !detailsPanel?.classList.contains("open");
      relayRow.classList.toggle("open", nextOpen);
      detailsPanel?.classList.toggle("open", nextOpen);
      if (detailsPanel) {
        detailsPanel.style.maxHeight = nextOpen ? "1200px" : "0px";
      }
    });
  }

  return {
    relayRow,
    nameEl,
    dotEl,
    badgeOnline,
    activePowerEl,
    apparentPowerEl,
    reactivePowerEl,
    tsEl,
    detailsPanel
  };
}

function ensureDeviceMiniHeaders() {
  const relayHeader = document.querySelector("#relaySection .device-mini-header");
  const multimeterHeader = document.querySelector("#multimeterSection .device-mini-header");

  const applyHeader = (headerEl) => {
    if (!headerEl) return;
    let spans = headerEl.querySelectorAll("span");

    if (spans.length < 7) {
      headerEl.innerHTML = `
        <span></span>
        <span></span>
        <span>ACTIVE POWER</span>
        <span>APPARENT POWER</span>
        <span>REACTIVE POWER</span>
        <span>ÚLTIMA LEITURA</span>
        <span>COMANDOS</span>
      `;
      spans = headerEl.querySelectorAll("span");
    } else {
      spans[0].textContent = "";
      spans[1].textContent = "";
      spans[2].textContent = "ACTIVE POWER";
      spans[3].textContent = "APPARENT POWER";
      spans[4].textContent = "REACTIVE POWER";
      spans[5].textContent = "ÚLTIMA LEITURA";
      spans[6].textContent = "COMANDOS";
    }
  };

  applyHeader(relayHeader);
  applyHeader(multimeterHeader);
}

function pickDeviceMetricValue(primary, secondary, keys) {
  for (const key of keys) {
    const secondaryValue = secondary?.[key];
    if (secondaryValue !== null && secondaryValue !== undefined && secondaryValue !== "") return secondaryValue;
    const primaryValue = primary?.[key];
    if (primaryValue !== null && primaryValue !== undefined && primaryValue !== "") return primaryValue;
  }
  return null;
}

function formatMetricValue(value, unit, digits = 1) {
  const n = Number(typeof value === "string" ? value.replace(",", ".") : value);
  if (!Number.isFinite(n)) return "—";
  return `${n.toFixed(digits)} ${unit}`;
}

function renderRelayDetailsPanel(relayItem) {
  const panel = document.getElementById("relayDetailsPanel");
  if (!panel) return;

  if (!relayItem) {
    panel.innerHTML = `<div class="relay-details-empty">Sem dados detalhados do relé.</div>`;
    return;
  }

  const analog = relayItem?.analog ?? {};
  const metric = (keys, unit, digits = 1) => formatMetricValue(pickDeviceMetricValue(relayItem, analog, keys), unit, digits);
  const raw = (keys) => {
    const value = pickDeviceMetricValue(relayItem, analog, keys);
    return value === null || value === undefined || value === "" ? "—" : String(value);
  };

  const electricalItems = [
    ["V AB", metric(["voltage_ab_v", "voltage_ab", "line_voltage_ab_v", "line_voltage_ab", "vab"], "V", 1)],
    ["V BC", metric(["voltage_bc_v", "voltage_bc", "line_voltage_bc_v", "line_voltage_bc", "vbc"], "V", 1)],
    ["V CA", metric(["voltage_ca_v", "voltage_ca", "line_voltage_ca_v", "line_voltage_ca", "vca"], "V", 1)],
    ["Ia", metric(["current_a_a", "current_a", "ia"], "A", 1)],
    ["Ib", metric(["current_b_a", "current_b", "ib"], "A", 1)],
    ["Ic", metric(["current_c_a", "current_c", "ic"], "A", 1)],
    ["Status Relay", raw(["status_relay"])]
  ];

  const flagItems = [
    ["46", raw(["flag_46"])], ["50", raw(["flag_50"])], ["51-1", raw(["flag_51_1"])],
    ["50N", raw(["flag_50N"])], ["51GS", raw(["flag_51GS"])], ["51N", raw(["flag_51N"])],
    ["27", raw(["flag_27"])], ["59", raw(["flag_59"])], ["47", raw(["flag_47"])],
    ["81 O", raw(["flag_81_O"])], ["81 U", raw(["flag_81_U"])], ["51-2", raw(["flag_51_2"])]
  ];

  panel.innerHTML = `
    <div class="relay-details-card">
      <div class="relay-details-title">Leituras elétricas</div>
      <div class="relay-details-grid">
        ${electricalItems.map(([label, value]) => `
          <div class="relay-detail-chip">
            <span>${label}</span>
            <strong>${value}</strong>
          </div>
        `).join("")}
      </div>
    </div>
    <div class="relay-details-card">
      <div class="relay-details-title">Proteções</div>
      <div class="relay-flag-grid">
        ${flagItems.map(([label, value]) => `
          <div class="relay-flag-pill ${String(value) === "1" ? "is-on" : "is-off"}">
            <span>${label}</span>
            <strong>${value}</strong>
          </div>
        `).join("")}
      </div>
    </div>
  `;
}

function ensureMultimeterUiScaffold() {
  const row = document.getElementById("multimeterRow");
  if (!row) return null;

  const onlineBadge = document.getElementById("multimeterOnlineBadge");
  const commandBarWrap = document.getElementById("multimeterCommandBarWrap");
  const legacyRight = document.getElementById("multimeterRight");
  const leftBlock =
    row?.querySelector(".relay-left") ||
    row?.querySelector(".multimeter-left") ||
    row?.children?.[1] ||
    null;

  if (legacyRight) legacyRight.style.display = "none";

  if (leftBlock && onlineBadge && onlineBadge.parentElement !== leftBlock) {
    leftBlock.appendChild(onlineBadge);
  }
  if (commandBarWrap && commandBarWrap.parentElement !== row) {
    row.appendChild(commandBarWrap);
  }

  row.classList.add("relay-row--table");
  row.style.gridTemplateColumns = "14px minmax(250px,1.45fr) minmax(150px,0.95fr) minmax(150px,0.95fr) minmax(150px,0.95fr) minmax(190px,1fr) 64px";

  const ensureMetricCell = (id, gridColumn) => {
    let el = row.querySelector(`#${id}`);
    if (!el) {
      el = document.createElement("div");
      el.id = id;
      el.className = "device-metric-cell";
      row.appendChild(el);
    }
    el.style.gridColumn = String(gridColumn);
    return el;
  };

  const activePowerEl = ensureMetricCell("multimeterActivePowerValue", 3);
  const apparentPowerEl = ensureMetricCell("multimeterApparentPowerValue", 4);
  const reactivePowerEl = ensureMetricCell("multimeterReactivePowerValue", 5);
  const tsEl = ensureMetricCell("multimeterLastReadingValue", 6);
  tsEl.classList.add("relay-timestamp-cell");
  activePowerEl.dataset.label = "ACTIVE POWER";
  apparentPowerEl.dataset.label = "APPARENT POWER";
  reactivePowerEl.dataset.label = "REACTIVE POWER";
  tsEl.dataset.label = "ÚLTIMA LEITURA";

  if (commandBarWrap) {
    commandBarWrap.style.gridColumn = "7";
    commandBarWrap.style.justifySelf = "center";
    commandBarWrap.dataset.label = "COMANDOS";
  }

  return {
    row,
    onlineBadge,
    activePowerEl,
    apparentPowerEl,
    reactivePowerEl,
    tsEl
  };
}

function renderRelayCommandBar(deviceId, currentState = "off") {
  const wrap = document.getElementById("relayCommandBarWrap");
  if (!wrap) return;
  const safeId = String(deviceId ?? "relay");
  const normalizedState = currentState === "on" ? "on" : "off";
  setDevicePersistentState("relay", safeId, normalizedState);
  wrap.innerHTML = renderDeviceCommandControl("relay", safeId, normalizedState);
  wrap.style.display = "flex";
  wrap.style.alignItems = "center";
  wrap.style.justifyContent = "center";
  wireDeviceCommandButtons(wrap);
  applyDeviceVisualState("relay", safeId, normalizedState);
}

function renderMultimeterCommandBar(deviceId) {
  const wrap = document.getElementById("multimeterCommandBarWrap");
  if (!wrap) return;
  const safeId = String(deviceId ?? "multimeter");
  wrap.innerHTML = renderDeviceCommandControl("multimeter", safeId, getDevicePersistentState("multimeter", safeId, "off"));
  wrap.style.display = "flex";
  wrap.style.alignItems = "center";
  wrap.style.justifyContent = "center";
  wireDeviceCommandButtons(wrap);
  applyDeviceVisualState("multimeter", safeId, getDevicePersistentState("multimeter", safeId, "off"));
}

function renderRelayCard(relayItem) {
  const ui = ensureRelayUiScaffold();
  if (!ui) return;

  const { relayRow, badgeOnline, activePowerEl, apparentPowerEl, reactivePowerEl, tsEl, detailsPanel } = ui;
  ensureDeviceMiniHeaders();

  // sem dados ainda
  if (!relayItem) {
    relayRow.classList.remove("online", "offline", "open");
    relayRow.classList.add("offline");
    badgeOnline.textContent = "OFFLINE";
    activePowerEl.textContent = "—";
    apparentPowerEl.textContent = "—";
    reactivePowerEl.textContent = "—";
    tsEl.textContent = "—";
    if (detailsPanel) {
      detailsPanel.classList.remove("open");
      detailsPanel.style.maxHeight = "0px";
    }
    renderRelayDetailsPanel(null);
    renderRelayCommandBar("relay", "off");
    return;
  }

  const analog = relayItem?.analog ?? {};
  const isOnline = relayOnlineFromPayload(relayItem);
  const relayState = relayStateFromPayload(relayItem);
  const activePower = pickDeviceMetricValue(relayItem, analog, ["active_power_kw", "power_kw", "active_power"]);
  const apparentPower = pickDeviceMetricValue(relayItem, analog, ["apparent_power_kva", "power_apparent_kva", "apparent_power", "apparent_power_va"]);
  const reactivePower = pickDeviceMetricValue(relayItem, analog, ["reactive_power_kvar", "power_reactive_kvar", "reactive_power", "reactive_power_var"]);
  const lastUpdate =
    relayItem?.last_update ??
    relayItem?.timestamp ??
    relayItem?.analog?.timestamp ??
    relayItem?.event?.timestamp ??
    null;
  const deviceId = relayItem?.device_id ?? relayItem?.relay_id ?? "relay";

  // classes do row (para a bolinha)
  relayRow.classList.remove("online", "offline");
  relayRow.classList.add(isOnline ? "online" : "offline");

  // badge online/offline
  badgeOnline.textContent = isOnline ? "ONLINE" : "OFFLINE";
  badgeOnline.style.borderColor = isOnline ? "rgba(57,229,140,0.26)" : "rgba(255,92,92,0.25)";
  badgeOnline.style.background = isOnline ? "rgba(57,229,140,0.08)" : "rgba(255,92,92,0.08)";
  badgeOnline.style.color = isOnline ? "rgba(233,255,243,0.92)" : "rgba(255,255,255,0.92)";
  badgeOnline.style.marginLeft = "8px";
  badgeOnline.style.whiteSpace = "nowrap";

  activePowerEl.textContent = formatMetricValue(activePower, "kW", 1);
  apparentPowerEl.textContent = formatMetricValue(apparentPower, "kVA", 1);
  reactivePowerEl.textContent = formatMetricValue(reactivePower, "kvar", 1);
  tsEl.textContent = fmtDatePtBR(lastUpdate);

  renderRelayDetailsPanel(relayItem);
  if (detailsPanel?.classList.contains("open")) {
    detailsPanel.style.maxHeight = "1200px";
  }
  renderRelayCommandBar(deviceId, relayState);
}

function renderMultimeterCard(item) {
  const ui = ensureMultimeterUiScaffold();
  if (!ui) return;

  const { row, onlineBadge, activePowerEl, apparentPowerEl, reactivePowerEl, tsEl } = ui;
  const dot = document.getElementById("multimeterDot");
  ensureDeviceMiniHeaders();

  if (!item) {
    row.classList.remove("online", "offline");
    row.classList.add("offline");
    if (onlineBadge) onlineBadge.textContent = "OFFLINE";
    activePowerEl.textContent = "—";
    apparentPowerEl.textContent = "—";
    reactivePowerEl.textContent = "—";
    tsEl.textContent = "—";
    if (dot) dot.style.opacity = "0.65";
    renderMultimeterCommandBar("multimeter");
    return;
  }

  const analog = item?.analog ?? item?.data ?? {};
  const isOnline = multimeterOnlineFromPayload(item);
  const activePower = pickDeviceMetricValue(item, analog, ["active_power_kw", "p_kw", "power_kw", "active_power"]);
  const apparentPower = pickDeviceMetricValue(item, analog, ["apparent_power_kva", "power_apparent_kva", "apparent_power", "apparent_power_va"]);
  const reactivePower = pickDeviceMetricValue(item, analog, ["reactive_power_kvar", "power_reactive_kvar", "reactive_power", "reactive_power_var"]);
  const lastUpdate = item.last_update ?? item.timestamp ?? null;

  renderMultimeterCommandBar(item?.device_id ?? item?.multimeter_id ?? "multimeter");

  row.classList.remove("online", "offline");
  row.classList.add(isOnline ? "online" : "offline");

  if (onlineBadge) {
    onlineBadge.textContent = isOnline ? "ONLINE" : "OFFLINE";
    onlineBadge.classList.remove("relay-state--on", "relay-state--off", "relay-state--unknown");
    onlineBadge.classList.add(isOnline ? "relay-state--on" : "relay-state--off");
    onlineBadge.style.marginLeft = "8px";
  }

  activePowerEl.textContent = formatMetricValue(activePower, "kW", 1);
  apparentPowerEl.textContent = formatMetricValue(apparentPower, "kVA", 1);
  reactivePowerEl.textContent = formatMetricValue(reactivePower, "kvar", 1);
  tsEl.textContent = fmtDatePtBR(lastUpdate);
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
    const disabledByPref = isDisabledPref(inverterRealId, i);
    const effective_enabled = disabledByPref ? false : !!enabled;
    const has_data = (rt?.has_data ?? cfg?.has_data ?? false) === true;
    const exists_in_config = !!cfg;
    const exists_in_realtime = !!rt;
    const exists_in_api = exists_in_config || exists_in_realtime;

    const monitorable = exists_in_api && effective_enabled;

    strings.push({
      string_index: i,
      exists_in_config,
      exists_in_realtime,
      exists_in_api,
      enabled,
      effective_enabled,
      has_data,
      current_a: rt?.current_a ?? null,
      last_ts: rt?.last_ts ?? null,
      monitorable,
      alarm_active: rt?.alarm_active ?? cfg?.alarm_active ?? null,
      alarm_state: rt?.alarm_state ?? cfg?.alarm_state ?? null,
      alarm_reason: rt?.alarm_reason ?? cfg?.alarm_reason ?? null,
      alarm_code: rt?.alarm_code ?? cfg?.alarm_code ?? null
    });
  }

  return {
    inverter_id: Number(inverterRealId),
    max_strings: maxStrings,
    strings
  };
}

function isStringMonitorable(str) {
  if (!str) return false;
  if (str.effective_enabled === false) return false;
  if (str.exists_in_api !== true) return false;
  return str.monitorable === true;
}

function getInverterOnlineStateById(inverterRealId) {
  const inv = INVERTER_EXTRAS_BY_ID.get(String(inverterRealId));
  if (!inv) return false;
  return isOnlineByFreshness(inv) && !isZeroSnapshot(inv);
}

function isStringInAlarm(str, inverterOnline) {
  if (!isStringMonitorable(str)) return false;
  if (!inverterOnline) return false;

  // futura integração backend: quando alarm_active vier pronto, ele manda na regra local.
  if (str.alarm_active === true) return true;
  if (str.alarm_active === false) return false;

  const noData = str.has_data !== true;
  const nullCurrent = str.current_a === null || str.current_a === undefined || str.current_a === "";

  let stale = false;
  if (str.last_ts) {
    const ts = new Date(str.last_ts);
    if (!Number.isNaN(ts.getTime())) {
      stale = (Date.now() - ts.getTime()) > STRING_STALE_AFTER_MS;
    }
  }

  return noData || nullCurrent || stale;
}

function setInverterStringAlarmBadge(inverterRealId, show) {
  const row = document.querySelector(`.inverter-toggle[data-inverter-real-id="${inverterRealId}"]`);
  if (!row) return;
  row.classList.toggle("has-string-alarm", !!show);

  let badge = row.querySelector(".string-alarm-badge");
  if (show) {
    if (!badge) {
      badge = document.createElement("span");
      badge.className = "string-alarm-badge";
      badge.innerHTML = `<i class="fa-solid fa-triangle-exclamation"></i>`;
      row.appendChild(badge);
    }
  } else if (badge) {
    badge.remove();
  }
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
    if (inverterRealId != null) setInverterStringAlarmBadge(inverterRealId, false);
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

  const inverterOnline = getInverterOnlineStateById(inverterRealId);
  let hasAlarmOnAnyMonitorable = false;

  visibleStrings.forEach(str => {
    const el = document.createElement("div");
    el.className = "string-card";
    el.dataset.string = str.string_index;
    const inAlarm = isStringInAlarm(str, inverterOnline);
    if (inAlarm) {
      el.classList.add("string-alarm");
      hasAlarmOnAnyMonitorable = true;
    } else if (!str.has_data) {
      el.classList.add("nodata");
    } else {
      el.classList.add("active");
    }

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

  setInverterStringAlarmBadge(inverterRealId, hasAlarmOnAnyMonitorable);
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
let DAILY_CHART_ZOOM_WIRED = false;

function resetDailyChartZoom() {
  if (!dailyChartInstance || typeof dailyChartInstance.resetZoom !== "function") return;
  try {
    dailyChartInstance.resetZoom();
  } catch (err) {
    console.warn("[dailyChart] erro ao resetar zoom:", err);
  }
}

function wireDailyChartZoomControlsOnce() {
  if (DAILY_CHART_ZOOM_WIRED) return;
  DAILY_CHART_ZOOM_WIRED = true;

  document.getElementById("dailyZoomInBtn")?.addEventListener("click", () => {
    if (!dailyChartInstance || typeof dailyChartInstance.zoom !== "function") return;
    dailyChartInstance.zoom({ x: 1.2 });
  });

  document.getElementById("dailyZoomOutBtn")?.addEventListener("click", () => {
    if (!dailyChartInstance || typeof dailyChartInstance.zoom !== "function") return;
    dailyChartInstance.zoom({ x: 0.8 });
  });

  document.getElementById("dailyZoomResetBtn")?.addEventListener("click", resetDailyChartZoom);
}

// ======================================================
// GRÁFICO DIÁRIO
// ======================================================
function renderDailyChart() {
  const canvas = document.getElementById("plantMainChart");
  if (!canvas || !DAILY?.labels?.length) return;
  const ratedPower = asNumber(PLANT_STATE.rated_power_kwp, 0);
  const powerAxisMax = ratedPower > 0 ? Math.ceil(ratedPower) : 1250;

  const ctx = canvas.getContext("2d");

  if (dailyChartInstance) {
    dailyChartInstance.destroy();
    dailyChartInstance = null;
  }

  const greenGradient = ctx.createLinearGradient(0, 0, 0, 320);
  greenGradient.addColorStop(0, "rgba(57,229,140,0.36)");
  greenGradient.addColorStop(0.6, "rgba(57,229,140,0.20)");
  greenGradient.addColorStop(1, "rgba(57,229,140,0.03)");

  const yellowGradient = ctx.createLinearGradient(0, 0, 0, 320);
  yellowGradient.addColorStop(0, "rgba(255,216,77,0.24)");
  yellowGradient.addColorStop(1, "rgba(255,216,77,0.02)");

  dailyChartInstance = new Chart(ctx, {
    type: "line",
    data: {
      labels: DAILY.labels,
      datasets: [
        {
          label: "Esperado",
          data: Array.isArray(DAILY.expectedPower) ? DAILY.expectedPower : [],
          borderColor: "rgba(205, 213, 225, 0.70)",
          fill: false,
          tension: 0.28,
          pointRadius: 0,
          borderWidth: 1.5,
          borderDash: [6, 6],
          yAxisID: "yPower",
          spanGaps: true,
          order: 0
        },
        {
          label: "Potência Ativa",
          data: DAILY.activePower,
          borderColor: "#39e58c",
          backgroundColor: greenGradient,
          fill: true,
          tension: 0.4,
          pointRadius: 0,
          borderWidth: 2,
          yAxisID: "yPower",
          spanGaps: true,
          order: 1
        },
        {
          label: "Irradiância POA",
          data: DAILY.irradiance,
          borderColor: "#ffd84d",
          backgroundColor: yellowGradient,
          fill: true,
          tension: 0.3,
          pointRadius: 0,
          borderWidth: 2,
          yAxisID: "yIrr",
          spanGaps: true,
          order: 2
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
          backgroundColor: "rgba(6,18,14,0.96)",
          borderColor: "rgba(57,229,140,0.18)",
          borderWidth: 1,
          titleColor: "#dbe7ef",
          bodyColor: "#dbe7ef",
          padding: 10,
          displayColors: true,
          usePointStyle: true,
          callbacks: {
            label: (item) => {
              const label = item?.dataset?.label || "";
              const value = Number(item?.raw ?? 0);

              if (label === "Esperado") {
                return `Esperado: ${formatKwPtBR(value)}`;
              }
              if (label === "Potência Ativa") {
                return `Potência Ativa: ${formatKwPtBR(value)}`;
              }
              if (label === "Irradiância POA") {
                return `Irradiância POA: ${formatWm2PtBR(value)}`;
              }

              return `${label}: ${formatNumberPtBR(value)}`;
            }
          }
        },
        zoom: {
          pan: {
            enabled: true,
            mode: "x"
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
            mode: "x"
          },
          limits: {
            x: { minRange: 6 }
          }
        }
      },
      scales: {
        x: {
          ticks: { color: "#9adbb8", maxTicksLimit: 12 },
          grid: { color: "rgba(255,255,255,0.04)" }
        },
        yPower: {
          position: "left",
          min: 0,
          suggestedMax: powerAxisMax,
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
  const irrDailyNew = Array.isArray(payload.irradiation_daily_kwh_m2)
    ? payload.irradiation_daily_kwh_m2.slice()
    : null;
  const expectedDailyNew = Array.isArray(payload.expected_daily_kwh)
    ? payload.expected_daily_kwh.slice()
    : (Array.isArray(payload.expectedDailyKwh) ? payload.expectedDailyKwh.slice() : null);
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
  const irradiationDaily = (irrDailyNew ?? []).slice(0, daily.length).map(v => Number(v) || 0);
  while (irradiationDaily.length < daily.length) irradiationDaily.push(0);

  let expectedDaily = (expectedDailyNew ?? []).slice(0, daily.length).map(v => Number(v) || 0);
  while (expectedDaily.length < daily.length) expectedDaily.push(0);

  const expectedMtdFromPayload =
    Array.isArray(payload.expected_mtd_kwh) ? payload.expected_mtd_kwh.slice() :
    Array.isArray(payload.expectedMtdKwh) ? payload.expectedMtdKwh.slice() :
    null;

  let expectedMtd = [];
  if (expectedMtdFromPayload && expectedMtdFromPayload.length >= expectedDaily.length) {
    expectedMtd = expectedMtdFromPayload.slice(0, expectedDaily.length).map(v => Number(v) || 0);
  } else {
    let accExpected = 0;
    expectedMtd = expectedDaily.map(v => (accExpected += (Number(v) || 0)));
  }

  return {
    ...payload,
    labels: finalLabels,
    daily_kwh: daily,
    mtd_kwh: mtd,
    expected_daily_kwh: expectedDaily,
    expected_mtd_kwh: expectedMtd,
    irradiation_daily_kwh_m2: irradiationDaily,
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
  const expectedDaily = Array.isArray(MONTHLY?.expected_daily_kwh)
    ? MONTHLY.expected_daily_kwh.map(v => Number(v) || 0)
    : [];

  if (!labels.length || !daily.length) return;

  const expectedPadded = expectedDaily.slice(0, daily.length);
  while (expectedPadded.length < daily.length) expectedPadded.push(0);

  const totalReal = daily.reduce((a, b) => a + (Number(b) || 0), 0);
  const totalExpected = expectedPadded.reduce((a, b) => a + (Number(b) || 0), 0);
  const deviation = totalExpected > 0 ? ((totalReal - totalExpected) / totalExpected) * 100 : 0;
  const daysWithGeneration = daily.filter(v => Number(v) > 0).length;

  const kpiRealEl = document.getElementById("monthlyKpiReal");
  const kpiExpEl = document.getElementById("monthlyKpiExp");
  const kpiDevEl = document.getElementById("monthlyKpiDev");
  const progressEl = document.getElementById("monthlyProgressFill");
  const bottomLeftEl = document.getElementById("monthlyBottomLeft");
  const bottomRightEl = document.getElementById("monthlyBottomRight");

  if (kpiRealEl) kpiRealEl.textContent = formatKwhPtBR(totalReal);
  if (kpiExpEl) kpiExpEl.textContent = formatKwhPtBR(totalExpected);
  if (kpiDevEl) {
    kpiDevEl.textContent = `${deviation >= 0 ? "+" : ""}${deviation.toFixed(1)}%`;
    kpiDevEl.style.color = deviation >= 0 ? "#7FD055" : "#ff6b6b";
  }
  if (progressEl) progressEl.style.width = `${((daysWithGeneration / daily.length) * 100).toFixed(1)}%`;
  if (bottomLeftEl) bottomLeftEl.textContent = `${daysWithGeneration} dias com geração de ${daily.length}`;
  if (bottomRightEl) bottomRightEl.textContent = "Mês atual";

  const ctx = canvas.getContext("2d");

  if (monthlyChartInstance) {
    monthlyChartInstance.destroy();
    monthlyChartInstance = null;
  }

  const maxDaily = Math.max(...daily, 0);
  const suggestedMaxDaily = maxDaily > 0 ? Math.ceil(maxDaily * 1.25) : undefined;
  const realColors = daily.map((v, idx) => {
    const exp = Number(expectedPadded[idx] ?? 0);
    if (v === 0) return "rgba(255,255,255,.06)";
    return v >= exp ? "rgba(127,208,85,.92)" : "rgba(127,208,85,.50)";
  });
  const realBorders = daily.map((v, idx) => {
    const exp = Number(expectedPadded[idx] ?? 0);
    if (v === 0) return "rgba(255,255,255,.06)";
    return v >= exp ? "#7FD055" : "rgba(127,208,85,.70)";
  });

  monthlyChartInstance = new Chart(ctx, {
    type: "bar",
    data: {
      labels,
      datasets: [
        {
          label: "Esperado",
          data: expectedPadded,
          backgroundColor: "rgba(190,200,210,.28)",
          borderColor: "rgba(190,200,210,.38)",
          borderWidth: 1,
          borderRadius: { topLeft: 5, topRight: 5 },
          borderSkipped: "bottom",
          barThickness: 14,
          maxBarThickness: 20,
          categoryPercentage: 0.78,
          barPercentage: 0.92,
          order: 0,
          hoverBackgroundColor: "rgba(190,200,210,.46)"
        },
        {
          label: "Real",
          data: daily,
          backgroundColor: realColors,
          borderColor: realBorders,
          borderWidth: 1,
          borderRadius: { topLeft: 4, topRight: 4 },
          borderSkipped: "bottom",
          barThickness: 9,
          maxBarThickness: 16,
          categoryPercentage: 0.78,
          barPercentage: 0.70,
          order: 1
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
          backgroundColor: "rgba(6,18,14,0.96)",
          borderColor: "rgba(57,229,140,0.18)",
          borderWidth: 1,
          titleColor: "#dbe7ef",
          bodyColor: "#dbe7ef",
          padding: 10,
          displayColors: false,
          callbacks: {
            title: (items) => items?.[0]?.label ? `Dia ${items[0].label}` : "",
            label: (item) => {
              const idx = item?.dataIndex ?? 0;
              const real = Number(daily[idx] ?? 0);
              const expected = Number(expectedPadded[idx] ?? 0);
              if (item?.dataset?.label === "Esperado") return `Esperado: ${formatKwhPtBR(expected)}`;
              if (item?.dataset?.label === "Real") return `Real: ${formatKwhPtBR(real)}`;
              return "";
            },
            afterBody: (items) => {
              const idx = items?.[0]?.dataIndex ?? 0;
              const real = Number(daily[idx] ?? 0);
              const expected = Number(expectedPadded[idx] ?? 0);
              const deviation = expected > 0 ? ((real - expected) / expected) * 100 : 0;
              const sign = deviation > 0 ? "+" : "";
              return `Desvio: ${sign}${deviation.toFixed(1)}%`;
            }
          }
        }
      },
      scales: {
        x: {
          offset: true,
          ticks: {
            color: "#9adbb8",
            maxTicksLimit: 6,
            autoSkip: true,
            maxRotation: 0,
            minRotation: 0,
            padding: 8
          },
          grid: { display: false }
        },
        y: {
          beginAtZero: true,
          suggestedMax: suggestedMaxDaily,
          grace: "12%",
          ticks: {
            color: "#9adbb8",
            maxTicksLimit: 6,
            padding: 8,
            callback: (v) => formatNumberPtBR(v)
          },
          grid: {
            color: "rgba(255,255,255,0.04)",
            drawBorder: false
          }
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
  if (IS_REFRESHING_PLANT) return;
  IS_REFRESHING_PLANT = true;

  let realtime = null;
  try {
    try {
      realtime = await fetchPlantRealtime(PLANT_ID);
      renderPlantName(realtime);
      if (realtime) {
        const rated = asNumber(
          realtime.rated_power_kw ?? realtime.rated_power_ac_kw ?? realtime.rated_power_kwp,
          PLANT_STATE.rated_power_kwp
        );
        const active = asNumber(
          realtime.active_power_kw ?? realtime.active_power_inverter_kw ?? realtime.active_power_meter_kw,
          PLANT_STATE.active_power_kw
        );
        const prPct = normalizePercentMaybe(
          realtime.performance_ratio ?? realtime.pr_daily_pct ?? realtime.pr_percent
        );
        PLANT_STATE = {
          ...PLANT_STATE,
          rated_power_kwp: rated,
          active_power_kw: active,
          capacity_percent: rated > 0 ? (active / rated) * 100 : PLANT_STATE.capacity_percent,
          pr_percent: prPct != null ? prPct : PLANT_STATE.pr_percent
        };
      }
    } catch (e) {
      console.error("[refreshRealtimeEverything][realtime] erro", e);
    }

    const [alarmsRes, invertersRes, relayRes, multimeterRes, trackersRes] = await Promise.allSettled([
      fetchActiveAlarms(PLANT_ID),
      fetchInvertersRealtime(PLANT_ID),
      safeFetchRelayIfSupported(PLANT_ID),
      safeFetchMultimeterIfSupported(PLANT_ID),
      fetchTrackersRealtime(PLANT_ID)
    ]);

    if (alarmsRes.status === "fulfilled") {
      ACTIVE_ALARMS = Array.isArray(alarmsRes.value) ? alarmsRes.value : [];
      renderAlarms(ACTIVE_ALARMS);
      renderAlarmMenuButton();
    } else {
      ACTIVE_ALARMS = [];
      renderAlarms(ACTIVE_ALARMS);
      renderAlarmMenuButton();
      console.error("[refreshRealtimeEverything][alarms] erro", alarmsRes.reason);
    }

    if (invertersRes.status === "fulfilled") {
      INVERTERS_REALTIME = invertersRes.value;
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
    } else {
      console.error("[refreshRealtimeEverything][inverters] erro", invertersRes.reason);
    }

    if (relayRes.status === "fulfilled") {
      const relayItem = relayRes.value;
      RELAY_REALTIME = relayItem;
      PLANT_CATALOG.hasRelay = !!relayItem;
      setRelaySectionVisible(RELAY_SUPPORTED !== false);
      if (RELAY_SUPPORTED !== false) renderRelayCard(relayItem);
    } else {
      console.error("[refreshRealtimeEverything][relay] erro", relayRes.reason);
    }

    if (multimeterRes.status === "fulfilled") {
      const multimeterItem = multimeterRes.value;
      MULTIMETER_REALTIME = multimeterItem;
      setMultimeterSectionVisible(MULTIMETER_SUPPORTED !== false);
      if (MULTIMETER_SUPPORTED !== false) renderMultimeterCard(multimeterItem);
    } else {
      console.error("[refreshRealtimeEverything][multimeter] erro", multimeterRes.reason);
    }

    if (trackersRes.status === "fulfilled") {
      const trackersPayload = trackersRes.value;
      TRACKERS_DATA = Array.isArray(trackersPayload?.items) ? trackersPayload.items : [];
      TRACKERS_PLANT_CENTER = trackersPayload?.plant_center ?? null;
      TRACKERS_PLANT_BOUNDS = trackersPayload?.plant_bounds ?? null;
      const hasTrackers = Array.isArray(TRACKERS_DATA) && TRACKERS_DATA.some(
        (t) => Number.isFinite(Number(t.latitude)) && Number.isFinite(Number(t.longitude))
      );
      if (hasTrackers) {
        TRACKERS_LAST_HAS_DATA = true;
      }

      if (!TRACKERS_USER_OPENED) {
        setTrackersSectionVisible(hasTrackers);
      } else {
        setTrackersSectionVisible(TRACKERS_LAST_HAS_DATA);
      }

      if (TRACKERS_LAST_HAS_DATA) {
        const trackersSection = document.getElementById("trackersSection");
        const trackersVisible =
          trackersSection &&
          !trackersSection.classList.contains("trackers-hidden") &&
          !trackersSection.classList.contains("is-collapsed");
        if (trackersVisible && hasTrackers) renderTrackersPanel();
      }
    } else {
      TRACKERS_DATA = [];
      TRACKERS_PLANT_CENTER = null;
      TRACKERS_PLANT_BOUNDS = null;
      renderTrackersPanel();
      console.error("[refreshRealtimeEverything][trackers] erro", trackersRes.reason);
    }

    renderHeaderSummary();
    renderWeather(realtime?.weather ?? null);
    renderSummaryStrip();

    try {
      await refreshOpenStringsPanels();
      if (OPEN_INVERTER_REAL_ID != null) {
        const inv = INVERTER_EXTRAS_BY_ID.get(String(OPEN_INVERTER_REAL_ID));
        renderInverterExtras(OPEN_INVERTER_REAL_ID, inv);
      }
    } catch (e) {
      console.error("[refreshRealtimeEverything][strings] erro", e);
    }
  } finally {
    IS_REFRESHING_PLANT = false;
  }
}

// ======================================================
// TRACKERS (MOCK LOCAL) — MÓDULO INDEPENDENTE
// ======================================================
let TRACKER_VIEW_MODE = "state";
let TRACKERS_DATA = [];
let TRACKERS_FILTER_TEXT = "";
let TRACKERS_TRANSFORM = { scale: 1, x: 0, y: 0 };
let TRACKERS_PLANT_CENTER = null;
let TRACKERS_PLANT_BOUNDS = null;
let TRACKERS_HAS_FITTED_ONCE = false;
let TRACKERS_USER_OPENED = false;
let TRACKERS_LAST_HAS_DATA = false;
let TRACKERS_MAP = null;
let TRACKERS_MARKERS_LAYER = null;

function createMockTrackers(count = 220) {
  const items = [];
  const cols = 22;
  const spacingX = 65;
  const spacingY = 78;
  const states = [
    "off",
    "manual_daytime",
    "auto_daytime",
    "manual_tracking",
    "auto_tracking",
    "manual_nighttime",
    "auto_nighttime",
    "manual_sleep",
    "auto_sleep"
  ];

  for (let i = 0; i < count; i++) {
    const row = Math.floor(i / cols);
    const col = i % cols;
    const offline = i % 17 === 0;
    const stateCode = offline ? "no_comm" : states[i % states.length];
    const angle = offline ? null : -60 + ((i * 7) % 131);
    const error = offline ? null : Number(((i * 1.7) % 11).toFixed(1));

    items.push({
      id: `TRK-${String(i + 1).padStart(4, "0")}`,
      name: `Tracker ${String(i + 1).padStart(3, "0")}`,
      kind: i % 2 === 0 ? "tcu" : "rsu",
      x: 50 + col * spacingX + (row % 2 ? 12 : 0),
      y: 45 + row * spacingY,
      state_code: stateCode,
      angle_deg: angle,
      error_value: error,
      is_online: !offline
    });
  }
  return items;
}

function getTrackersLegendItems(mode) {
  if (mode === "state") {
    return [
      ["tracker desligado", "#707b86"],
      ["manual + daytime", "#f6bd60"],
      ["automático + daytime", "#f2e85e"],
      ["manual + tracking", "#4f9dff"],
      ["automático + tracking", "#2ad37f"],
      ["manual + nighttime", "#7f8cff"],
      ["automático + nighttime", "#6375ff"],
      ["manual sleep", "#b47dff"],
      ["automático sleep", "#9255ff"],
      ["sem comunicação", "#4a5057"]
    ];
  }

  if (mode === "angle") {
    return [
      ["-60 a -50", "#7b1fa2"],
      ["-50 a -40", "#5c2dd6"],
      ["-40 a -30", "#3949ab"],
      ["-30 a -20", "#1e88e5"],
      ["-20 a -10", "#00acc1"],
      ["-10 a 0", "#26a69a"],
      ["0 a 10", "#43a047"],
      ["10 a 20", "#7cb342"],
      ["20 a 30", "#c0ca33"],
      ["30 a 40", "#fdd835"],
      ["40 a 50", "#ffb300"],
      ["50 a 60", "#fb8c00"],
      ["60 a 70", "#ef6c00"],
      ["sem comunicação", "#4a5057"]
    ];
  }

  return [
    ["erro <= 5", "#2ad37f"],
    ["erro > 5", "#ff8a65"],
    ["offline", "#4a5057"]
  ];
}

function getTrackerColorByMode(item, mode) {
  if (!item?.is_online) return "#4a5057";

  if (mode === "state") {
    const map = {
      off: "#707b86",
      manual_daytime: "#f6bd60",
      auto_daytime: "#f2e85e",
      manual_tracking: "#4f9dff",
      auto_tracking: "#2ad37f",
      manual_nighttime: "#7f8cff",
      auto_nighttime: "#6375ff",
      manual_sleep: "#b47dff",
      auto_sleep: "#9255ff",
      no_comm: "#4a5057"
    };
    return map[item.state_code] || "#8a949d";
  }

  if (mode === "angle") {
    const a = Number(item.angle_deg);
    if (!Number.isFinite(a)) return "#4a5057";
    const ranges = [
      [-60, -50, "#7b1fa2"], [-50, -40, "#5c2dd6"], [-40, -30, "#3949ab"],
      [-30, -20, "#1e88e5"], [-20, -10, "#00acc1"], [-10, 0, "#26a69a"],
      [0, 10, "#43a047"], [10, 20, "#7cb342"], [20, 30, "#c0ca33"],
      [30, 40, "#fdd835"], [40, 50, "#ffb300"], [50, 60, "#fb8c00"], [60, 70, "#ef6c00"]
    ];
    const found = ranges.find(([lo, hi]) => a >= lo && a < hi);
    return found ? found[2] : "#ef6c00";
  }

  const err = Number(item.error_value);
  if (!Number.isFinite(err)) return "#4a5057";
  return err <= 5 ? "#2ad37f" : "#ff8a65";
}

function renderTrackersLegend() {
  const legendEl = document.getElementById("trackersLegend");
  if (!legendEl) return;
  const items = getTrackersLegendItems(TRACKER_VIEW_MODE);
  legendEl.innerHTML = items
    .map(([label, color]) => `
      <div class="trackers-legend-item">
        <span class="trackers-legend-dot" style="background:${color}"></span>
        <span>${label}</span>
      </div>
    `)
    .join("");
}

function applyTrackersTransform() {
  if (!TRACKERS_MAP) return;
  TRACKERS_MAP.invalidateSize();
}

function renderTrackersNodes() {
  if (!TRACKERS_MAP || !TRACKERS_MARKERS_LAYER) return;
  TRACKERS_MARKERS_LAYER.clearLayers();

  const filterText = TRACKERS_FILTER_TEXT.trim().toLowerCase();
  const filtered = TRACKERS_DATA.filter((t) => {
    if (!filterText) return true;
    const hay = `${t.name || ""} ${t.id || ""} ${t.tracker_id || ""} ${t.kind || ""} ${t.tracker_type || ""}`.toLowerCase();
    return hay.includes(filterText);
  });

  const valid = filtered.filter(t =>
    Number.isFinite(Number(t.latitude)) && Number.isFinite(Number(t.longitude))
  );

  const fallback = document.getElementById("trackersMapFallback");
  if (!valid.length) {
    if (fallback) fallback.hidden = false;
    return;
  }
  if (fallback) fallback.hidden = true;

  const bounds = [];
  const markerIcon = (color) => L.divIcon({
    className: "",
    html: `<div class="tracker-map-marker" style="background:${color}"></div>`,
    iconSize: [14, 14],
    iconAnchor: [7, 7]
  });

  valid.forEach((tracker) => {
    const lat = Number(tracker.latitude);
    const lng = Number(tracker.longitude);
    bounds.push([lat, lng]);

    const color = getTrackerColorByMode(tracker, TRACKER_VIEW_MODE);
    const m = L.marker([lat, lng], { icon: markerIcon(color) });
    const displayName = tracker.name || tracker.tracker_code || tracker.tracker_id || "Tracker";
    const displayType = String(tracker.tracker_type || tracker.kind || "—").toUpperCase();
    m.bindPopup(`
      <strong>${displayName}</strong><br>
      Tipo: ${displayType}<br>
      Estado: ${tracker.state_code ?? "—"}<br>
      Ângulo: ${tracker.angle_deg ?? "—"}<br>
      Erro: ${tracker.error_value ?? "—"}<br>
      Status: ${tracker.is_online ? "online" : "offline"}<br>
      Atualização: ${fmtDatePtBR(tracker.last_update)}
    `);
    m.addTo(TRACKERS_MARKERS_LAYER);
  });

  if (!TRACKERS_HAS_FITTED_ONCE) {
    if (TRACKERS_PLANT_BOUNDS &&
        Number.isFinite(Number(TRACKERS_PLANT_BOUNDS.min_lat)) &&
        Number.isFinite(Number(TRACKERS_PLANT_BOUNDS.max_lat)) &&
        Number.isFinite(Number(TRACKERS_PLANT_BOUNDS.min_lng)) &&
        Number.isFinite(Number(TRACKERS_PLANT_BOUNDS.max_lng))) {
      TRACKERS_MAP.fitBounds([
        [Number(TRACKERS_PLANT_BOUNDS.min_lat), Number(TRACKERS_PLANT_BOUNDS.min_lng)],
        [Number(TRACKERS_PLANT_BOUNDS.max_lat), Number(TRACKERS_PLANT_BOUNDS.max_lng)]
      ], { padding: [20, 20] });
    } else if (TRACKERS_PLANT_CENTER &&
        Number.isFinite(Number(TRACKERS_PLANT_CENTER.latitude)) &&
        Number.isFinite(Number(TRACKERS_PLANT_CENTER.longitude))) {
      TRACKERS_MAP.setView([Number(TRACKERS_PLANT_CENTER.latitude), Number(TRACKERS_PLANT_CENTER.longitude)], 18);
    } else if (bounds.length) {
      TRACKERS_MAP.fitBounds(bounds, { padding: [20, 20] });
    }
    TRACKERS_HAS_FITTED_ONCE = true;
  }
}

function renderTrackersPanel() {
  renderTrackersLegend();
  renderTrackersNodes();
}

function setTrackerMode(mode) {
  TRACKER_VIEW_MODE = mode;
  document.getElementById("trackerModeState")?.classList.toggle("is-active", mode === "state");
  document.getElementById("trackerModeAngle")?.classList.toggle("is-active", mode === "angle");
  document.getElementById("trackerModeError")?.classList.toggle("is-active", mode === "error");
  renderTrackersPanel();
}

function filterTrackers(searchText) {
  TRACKERS_FILTER_TEXT = searchText || "";
  renderTrackersNodes();
}

function initTrackersPanel() {
  const sectionEl = document.getElementById("trackersSection");
  const stageWrapEl = document.getElementById("trackersStageWrap");
  const mapEl = document.getElementById("trackersMap");
  if (!sectionEl || !stageWrapEl || !mapEl || typeof L === "undefined") return;
  const tabToggleEl = document.getElementById("trackersTabToggle");
  const menuToggleEl = document.getElementById("trackersMenuToggle");

  if (tabToggleEl) {
    tabToggleEl.addEventListener("click", () => {
      const collapsed = !sectionEl.classList.contains("is-collapsed");
      setTrackersCollapsed(collapsed);
      const expanded = !collapsed;
      if (expanded) applyTrackersTransform();
    });
  }

  if (menuToggleEl) {
    menuToggleEl.addEventListener("click", () => {
      const section = document.getElementById("trackersSection");
      if (!section) return;

      const isHidden = section.classList.contains("trackers-hidden");
      const willShow = isHidden;

      TRACKERS_USER_OPENED = true;

      if (willShow) {
        setTrackersSectionVisible(true);
        setTrackersCollapsed(false);
        TRACKERS_LAST_HAS_DATA = true;
        requestAnimationFrame(() => {
          applyTrackersTransform();
          if (Array.isArray(TRACKERS_DATA) && TRACKERS_DATA.length) {
            renderTrackersPanel();
          }
        });
      } else {
        setTrackersSectionVisible(false);
      }
    });
  }

  TRACKERS_DATA = [];
  TRACKERS_TRANSFORM = { scale: 1, x: 0, y: 0 };
  TRACKERS_HAS_FITTED_ONCE = false;
  TRACKERS_MAP = L.map(mapEl, {
    zoomControl: false,
    attributionControl: false
  }).setView([-14.235, -51.9253], 4);

  L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
    subdomains: "abcd",
    maxZoom: 20
  }).addTo(TRACKERS_MAP);
  TRACKERS_MARKERS_LAYER = L.layerGroup().addTo(TRACKERS_MAP);

  document.getElementById("trackerModeState")?.addEventListener("click", () => setTrackerMode("state"));
  document.getElementById("trackerModeAngle")?.addEventListener("click", () => setTrackerMode("angle"));
  document.getElementById("trackerModeError")?.addEventListener("click", () => setTrackerMode("error"));
  document.getElementById("trackersSearchInput")?.addEventListener("input", (e) => filterTrackers(e.target.value));

  document.getElementById("trackersZoomIn")?.addEventListener("click", () => {
    if (TRACKERS_MAP) TRACKERS_MAP.zoomIn();
  });
  document.getElementById("trackersZoomOut")?.addEventListener("click", () => {
    if (TRACKERS_MAP) TRACKERS_MAP.zoomOut();
  });
  document.getElementById("trackersZoomReset")?.addEventListener("click", () => {
    if (!TRACKERS_MAP) return;
    if (TRACKERS_PLANT_BOUNDS &&
      Number.isFinite(Number(TRACKERS_PLANT_BOUNDS.min_lat)) &&
      Number.isFinite(Number(TRACKERS_PLANT_BOUNDS.max_lat)) &&
      Number.isFinite(Number(TRACKERS_PLANT_BOUNDS.min_lng)) &&
      Number.isFinite(Number(TRACKERS_PLANT_BOUNDS.max_lng))) {
      TRACKERS_MAP.fitBounds([
        [Number(TRACKERS_PLANT_BOUNDS.min_lat), Number(TRACKERS_PLANT_BOUNDS.min_lng)],
        [Number(TRACKERS_PLANT_BOUNDS.max_lat), Number(TRACKERS_PLANT_BOUNDS.max_lng)]
      ], { padding: [20, 20] });
    } else if (TRACKERS_PLANT_CENTER &&
      Number.isFinite(Number(TRACKERS_PLANT_CENTER.latitude)) &&
      Number.isFinite(Number(TRACKERS_PLANT_CENTER.longitude))) {
      TRACKERS_MAP.setView([Number(TRACKERS_PLANT_CENTER.latitude), Number(TRACKERS_PLANT_CENTER.longitude)], 18);
    } else {
      TRACKERS_MAP.setView([-14.235, -51.9253], 4);
    }
  });

  renderTrackersPanel();
  setTrackersSectionVisible(false);
  setTrackersCollapsed(true);
}

function setupDeviceNav() {
  const btns = document.querySelectorAll(".device-nav-btn[data-target]");
  if (!btns.length) return;

  function scrollToTarget(target) {
    if (!target) return;

    if (target === "#sec-trackers") {
      const section = document.getElementById("trackersSection");
      const tab = document.getElementById("trackersTabToggle");
      if (!section) return;

      TRACKERS_USER_OPENED = true;
      setTrackersSectionVisible(true);
      setTrackersCollapsed(false);
      TRACKERS_LAST_HAS_DATA = true;
      tab?.setAttribute("aria-expanded", "true");

      const anchor = document.querySelector(target);
      if (anchor) {
        anchor.scrollIntoView({ behavior: "smooth", block: "start" });
      }

      requestAnimationFrame(() => {
        applyTrackersTransform();
        if (Array.isArray(TRACKERS_DATA) && TRACKERS_DATA.length) {
          renderTrackersPanel();
        }
      });

      return;
    }

    const el = document.querySelector(target);
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  btns.forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      scrollToTarget(btn.getAttribute("data-target"));
    });
  });

  if (location.hash) {
    const hash = location.hash;
    setTimeout(() => scrollToTarget(hash), 0);
  }
}

// ======================================================
// INIT
// ======================================================
document.addEventListener("DOMContentLoaded", async () => {
  document.body.classList.add("plant-enter");
  setTimeout(() => document.body.classList.remove("plant-enter"), 500);
  setupInverterToggles();
  setupWeatherExpand();
  wireDailyChartZoomControlsOnce();
  initTrackersPanel();
  setupDeviceNav();
  setupPlantAlarmMenu();
  renderAlarmMenuButton();
  renderRelayCommandBar("relay");
  renderMultimeterCommandBar("multimeter");
  wireDeviceCommandButtons(document);
  document.addEventListener("click", () => closeAllDeviceCommandMenus());
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeAllDeviceCommandMenus();
  });

  if (!PLANT_ID) {
    console.warn("[plant] plant_id ausente na URL; mantendo tela sem dados de fallback.");
    renderHeaderSummary();
    renderSummaryStrip();
    return;
  }

  try {
    const refreshPromise = refreshRealtimeEverything();

    const [dailyRaw, monthlyRaw] = await Promise.all([
      fetchDailyEnergy(PLANT_ID),
      fetchMonthlyEnergy(PLANT_ID)
    ]);

    if (dailyRaw) {
      DAILY = normalizeDailyPayload(dailyRaw);
      renderDailyChart();
    }

    if (monthlyRaw) {
      MONTHLY = normalizeMonthlyPayload(monthlyRaw);
      renderMonthlyChart();
    }

    await refreshPromise;

    setInterval(() => {
      void refreshRealtimeEverything();
    }, PLANT_REFRESH_INTERVAL_MS);

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
