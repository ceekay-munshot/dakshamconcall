/**
 * ui.js — small, dependency-free UI helpers shared across the app.
 * Kept intentionally tiny; app.js holds the real logic.
 */

/* ---- DOM sugar ---- */
export const qs = (sel, root = document) => root.querySelector(sel);
export const qsa = (sel, root = document) => [...root.querySelectorAll(sel)];

/** Escape user/API text before putting it into innerHTML. */
export function escapeHtml(value) {
  if (value == null) return "";
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Debounce a function by `ms` (used for the search input). */
export function debounce(fn, ms = 300) {
  let t;
  const wrapped = (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
  wrapped.cancel = () => clearTimeout(t);
  return wrapped;
}

/** Refresh Lucide icons if the CDN loaded; silently no-op otherwise. */
export function refreshIcons() {
  try {
    if (window.lucide && typeof window.lucide.createIcons === "function") {
      window.lucide.createIcons();
    }
  } catch {
    /* icons are decorative — never let this break the app */
  }
}

/* ---- Company avatar helpers ---- */
const AVATAR_GRADIENTS = [
  "linear-gradient(135deg,#7c3aed,#6366f1)",
  "linear-gradient(135deg,#ec4899,#f59e0b)",
  "linear-gradient(135deg,#3b82f6,#06b6d4)",
  "linear-gradient(135deg,#14b8a6,#10b981)",
  "linear-gradient(135deg,#6366f1,#14b8a6)",
  "linear-gradient(135deg,#f43f5e,#f59e0b)",
  "linear-gradient(135deg,#8b5cf6,#ec4899)",
  "linear-gradient(135deg,#0ea5e9,#6366f1)",
];

/** Deterministic gradient for a company, so its colour is stable across views. */
export function gradientFor(key = "") {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return AVATAR_GRADIENTS[h % AVATAR_GRADIENTS.length];
}

/** 1–2 letter initials from a company name. */
export function initials(name = "") {
  const words = name.replace(/[^A-Za-z0-9 ]/g, "").trim().split(/\s+/);
  if (!words[0]) return "?";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

/* ---- Dates ---- */
export function fmtDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d)) return "—";
  return d.toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

export function relTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d)) return "—";
  const secs = Math.round((Date.now() - d.getTime()) / 1000);
  const table = [
    [60, "s"],
    [3600, "m", 60],
    [86400, "h", 3600],
    [604800, "d", 86400],
  ];
  if (secs < 60) return "just now";
  for (const [limit, unit, div] of table) {
    if (secs < limit) return `${Math.floor(secs / div)}${unit} ago`;
  }
  return fmtDate(iso);
}

/* ---- Toasts ---- */
export function toast(type = "info", title = "", msg = "", ttl = 4200) {
  const wrap = qs("#toastWrap");
  if (!wrap) return;
  const icons = { ok: "check", err: "alert-triangle", info: "info" };
  const node = document.createElement("div");
  node.className = `toast ${type}`;
  node.innerHTML = `
    <div class="toast-ico"><i data-lucide="${icons[type] || "info"}" class="i16"></i></div>
    <div class="toast-body">
      <div class="toast-title">${escapeHtml(title)}</div>
      ${msg ? `<div class="toast-msg">${escapeHtml(msg)}</div>` : ""}
    </div>`;
  wrap.appendChild(node);
  refreshIcons();
  const kill = () => {
    node.classList.add("out");
    setTimeout(() => node.remove(), 320);
  };
  const timer = setTimeout(kill, ttl);
  node.addEventListener("click", () => {
    clearTimeout(timer);
    kill();
  });
}
