// ============================================================
// CONFIG
// ============================================================

const API_BASE = "https://jgeg9i0js1.execute-api.us-east-1.amazonaws.com";

// ============================================================
// ELEMENTOS
// ============================================================

const form = document.getElementById("loginForm");
const errorBox = document.getElementById("loginError");
const btn = form.querySelector("button");

// ============================================================
// AUTO REDIRECT (SE JÁ ESTIVER LOGADO)
// 🔥 COMPORTAMENTO PROFISSIONAL
//
// 👉 Se existir "user" no localStorage:
//     - o login NÃO aparece
//     - redireciona direto para o resumo
//
// 👉 É por isso que, ao abrir index.html,
//     às vezes você "pula" o login
// ============================================================

const existingUser = localStorage.getItem("user");

if (existingUser) {
  window.location.replace("resumo.html");
}

// ============================================================
// HELPERS
// ============================================================

function showError(msg) {
  errorBox.innerText = msg;
  errorBox.style.display = "block";
}

function hideError() {
  errorBox.style.display = "none";
}

function setLoading(isLoading) {
  btn.disabled = isLoading;
  btn.innerText = isLoading ? "Entrando..." : "Entrar";
}

// ============================================================
// LOGIN (API)
// ============================================================

async function login(username, password) {
  const res = await fetch(`${API_BASE}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password })
  });

  const data = await res.json();

  if (!res.ok || !data.ok) {
    throw new Error(data.error || "Erro ao autenticar");
  }

  return data.user;
}

// ============================================================
// SUBMIT DO FORM
// ============================================================

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  hideError();

  const username = document.getElementById("username").value.trim();
  const password = document.getElementById("password").value;

  if (!username || !password) {
    showError("Informe usuário e senha");
    return;
  }

  try {
    setLoading(true);

    const user = await login(username, password);

    // 🔐 NORMALIZAÇÃO DO USUÁRIO
    const normalizedUser = {
      id: user.id,
      username: user.username,
      customer_id: user.customer_id,
      is_superuser: user.is_superuser === true || user.is_superuser === 1
    };

    // 🔥 AQUI É ONDE O LOGIN "FICA SALVO"
    localStorage.setItem("user", JSON.stringify(normalizedUser));

    // 🔁 REDIRECIONA PARA O RESUMO
    window.location.replace("resumo.html");

  } catch (err) {
    console.error("LOGIN ERROR:", err);
    showError("Usuário ou senha inválidos");
  } finally {
    setLoading(false);
  }
});

// ============================================================
// ENTER FUNCIONA
// ============================================================

document.querySelectorAll("input").forEach(input => {
  input.addEventListener("keydown", e => {
    if (e.key === "Enter") {
      form.dispatchEvent(new Event("submit"));
    }
  });
});