// =============================================================================
// CONFIG
// =============================================================================
const API_BASE = "https://jgeg9i0js1.execute-api.us-east-1.amazonaws.com";

// =============================================================================
// API FETCH COM CONTEXTO DO USUÁRIO
// =============================================================================
function apiFetch(path, options = {}) {
  const user = JSON.parse(localStorage.getItem("user") || "{}");

  const headers = {
    ...(options.headers || {})
  };

  if (user.customer_id) {
    headers["X-Customer-Id"] = user.customer_id;
  }

  if (user.is_superuser === true) {
    headers["X-Is-Superuser"] = "true";
  }

  return fetch(`${API_BASE}${path}`, {
    ...options,
    headers
  });
}

// =============================================================================
// UTILIDADES
// =============================================================================
function valueOrDash(v) {
  return v === null || v === undefined ? "—" : v;
}

// =============================================================================
// PLANT_ID VIA URL (?plant_id=13)
// =============================================================================
const params = new URLSearchParams(window.location.search);
const plantId = params.get("plant_id");

if (!plantId) {
  alert("plant_id não informado na URL");
  throw new Error("plant_id ausente");
}

// =============================================================================
// FETCHES
// =============================================================================
async function fetchPlantRealtime() {
  const res = await apiFetch(`/plants/${plantId}/realtime`);
  if (!res.ok) throw new Error("Erro ao buscar realtime da usina");
  return res.json();
}

async function fetchActiveAlarms() {
  const res = await apiFetch(`/plants/${plantId}/alarms/active`);
  if (!res.ok) throw new Error("Erro ao buscar alarmes ativos");
  return res.json();
}

/**
 * 🔜 FUTURO
 * GET /plants/{id}/history/day
 * (mock temporário para demo)
 */
async function fetchDailyHistory() {
  return {
    labels: [
      "06:00","07:00","08:00","09:00","10:00",
      "11:00","12:00","13:00","14:00","15:00","16:00","17:00"
    ],
    activePower: [0, 80, 220, 480, 900, 1400, 1800, 2100, 1900, 1300, 600, 120],
    irradiance:  [0, 60, 180, 350, 520, 680, 820, 950, 780, 420, 180, 40]
  };
}

// =============================================================================
// RENDER — HEADER / KPIs
// =============================================================================
function renderPlantHeader(data) {
  document.querySelector(".plant-name").innerText =
    valueOrDash(data.power_plant_name);

  document.querySelector(".plant-location").innerText = "Resumo Usina";

  document.getElementById("psfRatedPower").innerText =
    data.rated_power_kw
      ? `${Number(data.rated_power_kw).toFixed(1)} kWp`
      : "—";

  document.getElementById("psfActivePower").innerText =
    data.active_power_kw
      ? `${Number(data.active_power_kw).toFixed(1)} kW`
      : "—";

  const pct =
    data.rated_power_kw > 0
      ? (data.active_power_kw / data.rated_power_kw) * 100
      : null;

  document.getElementById("psfCapacityPct").innerText =
    pct !== null ? pct.toFixed(1) + "%" : "—";
}

// =============================================================================
// RENDER — ALARMES ATIVOS
// =============================================================================
function renderActiveAlarms(alarms) {
  const container = document.getElementById("plantActiveAlarms");
  if (!container) return;

  container.innerHTML = "";

  if (!alarms || alarms.length === 0) {
    container.innerHTML =
      `<div class="empty">Nenhum alarme ativo</div>`;
    return;
  }

  alarms.forEach(a => {
    const div = document.createElement("div");
    div.className = "alarm-row critical";

    div.innerHTML = `
      <span>${a.device_type} • ${a.device_name}</span>
      <span>Evento ${a.event_code}</span>
      <span>${new Date(a.started_at).toLocaleString("pt-BR")}</span>
    `;

    container.appendChild(div);
  });
}

// =============================================================================
// GRÁFICO PRINCIPAL — ACTIVE POWER x IRRADIÂNCIA
// =============================================================================
let mainChart = null;

function renderMainChart(labels, activePower, irradiance) {
  const canvas = document.getElementById("plantMainChart");
  if (!canvas) {
    console.error("Canvas plantMainChart não encontrado");
    return;
  }

  if (mainChart) {
    mainChart.destroy();
  }

  mainChart = new Chart(canvas.getContext("2d"), {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "Active Power (kW)",
          data: activePower,
          borderColor: "#39e58c",
          backgroundColor: "rgba(57,229,140,0.35)",
          fill: true,
          tension: 0.35,
          yAxisID: "yPower"
        },
        {
          label: "Irradiância POA (W/m²)",
          data: irradiance,
          borderColor: "#ffd84d",
          backgroundColor: "rgba(255,216,77,0.35)",
          fill: true,
          tension: 0.35,
          yAxisID: "yIrr"
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: {
        mode: "index",
        intersect: false
      },
      plugins: {
        legend: { display: false }
      },
      scales: {
        x: {
          ticks: { color: "#9adbb8" },
          grid: { color: "rgba(255,255,255,0.05)" }
        },
        yPower: {
          position: "left",
          ticks: { color: "#39e58c" },
          grid: { color: "rgba(255,255,255,0.05)" }
        },
        yIrr: {
          position: "right",
          ticks: { color: "#ffd84d" },
          grid: { drawOnChartArea: false }
        }
      },
      animation: {
        duration: 600,
        easing: "easeOutQuart"
      }
    }
  });
}

// =============================================================================
// INIT
// =============================================================================
async function initPlantView() {
  try {
    const [plant, alarms, history] = await Promise.all([
      fetchPlantRealtime(),
      fetchActiveAlarms(),
      fetchDailyHistory()
    ]);

    renderPlantHeader(plant);
    renderActiveAlarms(alarms);
    renderMainChart(
      history.labels,
      history.activePower,
      history.irradiance
    );

  } catch (err) {
    console.error("Erro ao carregar tela da usina:", err);
  }
}

document.addEventListener("DOMContentLoaded", initPlantView);
