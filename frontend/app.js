// RapidAid frontend. Served by the backend (http://localhost:8000); opened from a file or another dev server it talks to :8000.
const API_BASE_URL =
  window.RAPIDAID_API_URL ||
  (location.protocol === "file:" || (location.port && location.port !== "8000") ? "http://127.0.0.1:8000" : location.origin);

const ITAHARI_CENTER = [26.6646, 87.2718];

const state = {
  role: "auth",
  authMode: "signin",
  online: false,
  selectedLat: ITAHARI_CENTER[0],
  selectedLng: ITAHARI_CENTER[1],
  selectedLocationLabel: "Selected location",
  activeRequestId: null,
  pollTimer: null,
  // customer maps
  customerMap: null,
  customerPin: null,
  customerHospLayer: null,
  customerLiveMap: null,
  live: { reqId: null, patient: null, amb: null, route: null, fitKey: null },
  // dispatcher
  dispatcherMap: null,
  dView: "map",
  queueFilter: "ALL",
  queueSearch: "",
  selectedIncidentId: null,
  photoShownFor: null,
  evidenceCache: {},
  lastSys: null,
  showHospitals: true,
  dLayers: { ambulances: {}, incidents: {}, routes: {}, returns: {}, hospitals: null },
  // real hospital data (OpenStreetMap via backend)
  hospitals: [],
  hospitalsTried: false,
  hospitalsLoading: false,
  hospitalsLoadedAt: 0,
};

// ---------- Helpers ----------
const $ = (id) => document.getElementById(id);

// ---------- Sound effects (synthesised with WebAudio: no audio files needed) ----------
const Sfx = (() => {
  let ctx = null;
  let muted = localStorage.getItem("rapidaid_muted") === "1";
  const ensure = () => {
    if (muted) return null;
    try {
      ctx = ctx || new (window.AudioContext || window.webkitAudioContext)();
      if (ctx.state === "suspended") ctx.resume();
    } catch (_) { return null; }
    return ctx;
  };
  // one enveloped oscillator note
  function tone(freq, start, dur, { type = "sine", vol = 0.18, to = null } = {}) {
    const c = ensure();
    if (!c) return;
    const t0 = c.currentTime + start;
    const osc = c.createOscillator();
    const gain = c.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (to) osc.frequency.exponentialRampToValueAtTime(to, t0 + dur);
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(vol, t0 + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(gain).connect(c.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.05);
  }
  return {
    get muted() { return muted; },
    setMuted(v) { muted = v; localStorage.setItem("rapidaid_muted", v ? "1" : "0"); },
    unlock: ensure,
    // UI click
    click() { tone(1100, 0, 0.045, { type: "square", vol: 0.05 }); tone(720, 0.03, 0.05, { type: "square", vol: 0.035 }); },
    // heart-monitor beep (ECG)
    ecg() { tone(1000, 0, 0.16, { vol: 0.12 }); },
    // double "lub-dub" heartbeat
    heartbeat() { tone(70, 0, 0.14, { vol: 0.35 }); tone(55, 0.2, 0.16, { vol: 0.28 }); },
    // ambulance two-tone siren (~2.4s)
    siren() { for (let i = 0; i < 3; i++) { tone(960, i * 0.8, 0.4, { type: "sawtooth", vol: 0.07 }); tone(720, i * 0.8 + 0.4, 0.4, { type: "sawtooth", vol: 0.07 }); } },
    // dispatcher: new emergency incoming
    alert() { for (let i = 0; i < 3; i++) tone(880, i * 0.22, 0.14, { type: "square", vol: 0.09 }); },
    // patient picked up
    pickup() { tone(660, 0, 0.14, { vol: 0.16 }); tone(880, 0.15, 0.22, { vol: 0.16 }); Sfx_ecgLater(); },
    // arrived at hospital
    arrive() { [523, 659, 784, 1047].forEach((f, i) => tone(f, i * 0.12, 0.35, { vol: 0.14 })); },
    // submit / success confirmation
    success() { tone(587, 0, 0.12, { vol: 0.14 }); tone(880, 0.12, 0.25, { vol: 0.14 }); },
    // errors
    error() { tone(220, 0, 0.22, { type: "sawtooth", vol: 0.1 }); tone(165, 0.2, 0.28, { type: "sawtooth", vol: 0.1 }); },
  };
})();
function Sfx_ecgLater() { setTimeout(() => Sfx.ecg(), 450); setTimeout(() => Sfx.ecg(), 1100); }

// Plays a sound when a request moves to a new stage (assigned, picked up, arrived).
// `first` renders (page load / reload) are silent so old tickets don't replay sounds.
const sfxSeen = { dispatcher: {}, customer: {} };
function sfxTrack(who, req) {
  const seen = sfxSeen[who];
  const key = `${req.status}:${req.transport_phase || ""}`;
  const prev = seen[req.id];
  seen[req.id] = key;
  if (prev === undefined) {
    if (seen.__primed && who === "dispatcher" && req.status === "PENDING") Sfx.alert();
    return;
  }
  if (prev === key) return;
  if (req.status === "EN_ROUTE" && req.transport_phase === "TO_PATIENT") Sfx.siren();
  else if (req.status === "EN_ROUTE" && req.transport_phase === "TO_HOSPITAL") Sfx.pickup();
  else if (req.status === "ARRIVED") Sfx.arrive();
  else if (req.status === "VERIFIED") Sfx.heartbeat();
}

// ---------- Route helpers ----------
// The ambulance has already driven part of amb.route. Keep only what is still ahead of it,
// so the trace disappears behind the vehicle as it passes.
// Position is found by projecting the ambulance onto the route (never moving backwards),
// so it does not depend on ETA maths staying perfectly in sync.
const routeProgress = {};
function remainingRoute(amb) {
  const r = amb.route;
  if (!r || r.length < 2) return null;
  const here = [amb.current_lat, amb.current_lng];
  const key = `${amb.id}:${amb.phase}:${r.length}:${r[0][0]}`;
  const start = routeProgress[key] || 0;
  const kx = Math.cos((here[0] * Math.PI) / 180);
  let best = start;
  let bestD = Infinity;
  for (let i = start; i < r.length - 1; i++) {
    const ax = r[i][1] * kx, ay = r[i][0], bx = r[i + 1][1] * kx, by = r[i + 1][0];
    const px = here[1] * kx, py = here[0];
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy || 1e-12;
    const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
    const d = (px - (ax + t * dx)) ** 2 + (py - (ay + t * dy)) ** 2;
    if (d < bestD) { bestD = d; best = i; }
  }
  routeProgress[key] = best;
  return [here, ...r.slice(best + 1)];
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function clip(text, n) {
  const t = String(text ?? "");
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
}

function haversineKm(lat1, lng1, lat2, lng2) {
  const rad = Math.PI / 180;
  const a =
    Math.sin(((lat2 - lat1) * rad) / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(((lng2 - lng1) * rad) / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(a));
}

function formatSeconds(sec) {
  if (sec === null || sec === undefined) return "Pending";
  if (sec <= 0) return "Arrived on scene";
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function formatTime(ts) {
  return new Date(ts * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

// Keep DOM intact when HTML hasn't changed or a select menu is open
function setHtml(el, html) {
  const active = document.activeElement;
  if (active && active.tagName === "SELECT" && el.contains(active)) return false;
  if (el.dataset.html === html) return false;
  const saved = {};
  el.querySelectorAll("select").forEach((s) => { if (s.id) saved[s.id] = s.value; });
  const scrollParent = el.id === "detail-body" ? el.parentElement : null;
  const parentScrollTop = scrollParent ? scrollParent.scrollTop : 0;
  const scrollTop = el.scrollTop;
  el.innerHTML = html;
  el.dataset.html = html;
  el.querySelectorAll("select").forEach((s) => {
    if (saved[s.id] && [...s.options].some((o) => o.value === saved[s.id])) s.value = saved[s.id];
  });
  el.scrollTop = scrollTop;
  if (scrollParent) scrollParent.scrollTop = parentScrollTop;
  return true;
}

// ---------- Session & API ----------
function getSession() {
  try { return JSON.parse(sessionStorage.getItem("rapidaid_session") || "null"); } catch (_) { return null; }
}
function saveSession(res) {
  sessionStorage.setItem("rapidaid_session", JSON.stringify({ token: res.access_token, role: res.role, name: res.name, email: res.email, picture: res.picture || "" }));
}
function clearSession() {
  sessionStorage.removeItem("rapidaid_session");
  state.activeRequestId = null;
  resetLiveMap();
  const form = $("emergency-form");
  if (form) form.reset();
}
function activeRequestKey() {
  const s = getSession();
  return s && s.email ? `active_request_id:${s.email.toLowerCase()}` : "active_request_id:guest";
}

async function apiFetch(path, options = {}) {
  const session = getSession();
  const isAuthCall = path.startsWith("/api/auth/");
  const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
  if (session && !isAuthCall) headers.Authorization = `Bearer ${session.token}`;
  let res;
  try {
    res = await fetch(`${API_BASE_URL}${path}`, { ...options, headers });
  } catch (_) {
    throw new Error("Can't reach the server. Is the backend running on port 8000?");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && session && !isAuthCall) {
      clearSession();
      setRole("auth");
      showAuthError("Your session expired. Please sign in again.");
    }
    const detail = Array.isArray(data.detail) ? "Please check the highlighted fields." : data.detail;
    throw new Error(detail || `Request failed (${res.status})`);
  }
  return data;
}

function updateConnectionPill(online) {
  state.online = online;
  const pill = $("connection-pill");
  pill.textContent = online ? "Server Live" : "Backend Offline";
  pill.className = `conn-pill ${online ? "conn-online" : "conn-offline"}`;
  $("offline-banner").classList.toggle("hidden", online || state.role !== "auth");
}

// ---------- Map icons (ambulance / hospital / user logos) ----------
const ICON_SRC = { amb: "assets/ambulance.svg", user: "assets/user.svg", hosp: "assets/hospital.svg" };
const iconCache = {};
function mkIcon(kind, cls = "") {
  const key = `${kind}|${cls}`;
  if (!iconCache[key]) {
    const size = kind === "hosp" ? 32 : 42;
    iconCache[key] = L.divIcon({
      className: kind === "amb" ? "smooth" : "", // outer element carries Leaflet's transform; this makes ambulances glide
      html: `<div class="mk mk-${kind} ${cls}"><img src="${ICON_SRC[kind]}" alt="" draggable="false" /></div>`,
      iconSize: [size, size],
      iconAnchor: [size / 2, size / 2],
    });
  }
  return iconCache[key];
}
// Reuse marker instances by key to avoid flickering on each poll
function setMarkerIcon(marker, kind, cls) {
  const key = `${kind}|${cls}`;
  if (marker._ikey !== key) { marker.setIcon(mkIcon(kind, cls)); marker._ikey = key; }
}
function setMarkerPos(marker, lat, lng) {
  const p = marker.getLatLng();
  if (p.lat !== lat || p.lng !== lng) marker.setLatLng([lat, lng]);
}
const mapTileLayers = [];
function tileUrlForTheme(dark) {
  return dark
    ? "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
    : "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png";
}
function addTiles(map) {
  const dark = document.documentElement.dataset.theme === "dark";
  const layer = L.tileLayer(tileUrlForTheme(dark), { attribution: "&copy; OpenStreetMap contributors", maxZoom: 19 }).addTo(map);
  mapTileLayers.push(layer);
  return layer;
}

// ---------- Hospital data (OpenStreetMap via backend) ----------
function nearestHospitals(lat, lng, n = 3) {
  return state.hospitals
    .map((h) => ({ ...h, distance: haversineKm(lat, lng, h.lat, h.lng) }))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, n);
}

async function loadHospitals() {
  if (state.hospitalsLoading || state.hospitals.length) return;
  state.hospitalsLoading = true;
  try {
    const res = await apiFetch("/api/hospitals");
    state.hospitals = res.hospitals || [];
  } catch (_) {
    /* retried on next poll */
  } finally {
    state.hospitalsLoading = false;
    state.hospitalsTried = true;
    state.hospitalsLoadedAt = Date.now();
  }
  if (state.hospitals.length) {
    drawHospitalMarkers(state.customerHospLayer);
    drawHospitalMarkers(state.dLayers.hospitals);
    if (state.lastSys) renderDetail(state.lastSys);
  }
}

function drawHospitalMarkers(layer) {
  if (!layer) return;
  layer.clearLayers();
  state.hospitals.forEach((h) => {
    L.marker([h.lat, h.lng], { icon: mkIcon("hosp") })
      .bindPopup(
        `<strong>${escapeHtml(h.name)}</strong>${h.phone ? `<br>${escapeHtml(h.phone)}` : ""}`
      )
      .addTo(layer);
  });
}

// ---------- Role routing ----------
function setRole(role) {
  const session = getSession();
  if (role === "dispatcher" && !(session && session.role === "dispatcher")) role = "auth";
  state.role = role;
  $("screen-auth").classList.toggle("hidden", role !== "auth");
  $("screen-customer").classList.toggle("hidden", role !== "customer");
  $("screen-dispatcher").classList.toggle("hidden", role !== "dispatcher");
  $("offline-banner").classList.toggle("hidden", state.online || role !== "auth");
  updateTopbar();

  if (role === "customer") {
    initCustomerMap();
    if (session && session.name && !$("patient-name").value) $("patient-name").value = session.name;
    state.activeRequestId = localStorage.getItem(activeRequestKey()) || null;
    if (state.activeRequestId) {
      showCustomerTracker();
    } else {
      $("customer-tracker-card").classList.add("hidden");
      $("customer-form-card").classList.remove("hidden");
      resetLiveMap();
    }
  } else if (role === "dispatcher") {
    initDispatcherMap();
    setDispatcherView(state.dView);
  }
  if (role !== "auth") loadHospitals();
  pollSystemState();
}

function routeAfterLogin() {
  const s = getSession();
  setRole(s && s.role === "dispatcher" ? "dispatcher" : "customer");
}

function updateTopbar() {
  const session = getSession();
  const chip = $("user-chip");
  const btn = $("switch-role-btn");
  if (state.role === "auth") {
    chip.classList.add("hidden");
    btn.classList.add("hidden");
    return;
  }
  const isDispatcher = !!session && session.role === "dispatcher";
  const img = document.createElement("img");
  img.className = "avatar";
  img.alt = "";
  img.referrerPolicy = "no-referrer";
  img.src = isDispatcher ? "assets/hospital.svg" : (session && session.picture) || "assets/user.svg";
  img.onerror = () => { img.onerror = null; img.src = "assets/user.svg"; };
  const label = document.createElement("span");
  label.textContent = isDispatcher ? "Dispatcher" : session ? session.name || session.email : "Guest";
  chip.replaceChildren(img, label);
  chip.classList.remove("hidden");
  chip.classList.toggle("chip-dispatcher", isDispatcher);
  btn.classList.remove("hidden");
  btn.textContent = session ? "Sign out" : "Sign in";
}

// ---------- Customer map & form ----------
const LEAFLET_MAP_OPTS = {
  zoomAnimation: true,
  fadeAnimation: true,
  markerZoomAnimation: true,
  inertia: true,
  inertiaDeceleration: 2400,
  wheelPxPerZoomLevel: 90,
  zoomSnap: 0.5,
};

function initCustomerMap() {
  if (state.customerMap) {
    setTimeout(() => state.customerMap.invalidateSize(), 120);
    return;
  }
  state.customerMap = L.map("customer-map", LEAFLET_MAP_OPTS).setView(ITAHARI_CENTER, 14);
  addTiles(state.customerMap);
  state.customerHospLayer = L.layerGroup().addTo(state.customerMap);
  drawHospitalMarkers(state.customerHospLayer);

  state.customerPin = L.marker(ITAHARI_CENTER, { draggable: true, icon: mkIcon("user", "sev-CRITICAL pulse"), zIndexOffset: 1000 }).addTo(state.customerMap);
  state.customerPin.on("dragend", () => {
    const pos = state.customerPin.getLatLng();
    setCustomerCoords(pos.lat, pos.lng, "Custom pinned location");
  });
  state.customerMap.on("click", (e) => setCustomerCoords(e.latlng.lat, e.latlng.lng, "Manually selected location"));
  requestBrowserLocation(false);
}

function setCustomerCoords(lat, lng, label) {
  state.selectedLat = Number(lat.toFixed(5));
  state.selectedLng = Number(lng.toFixed(5));
  state.selectedLocationLabel = label;
  $("coord-readout").textContent = `${state.selectedLat}, ${state.selectedLng} (${label})`;
  if (state.customerPin) state.customerPin.setLatLng([state.selectedLat, state.selectedLng]);
  if (state.customerMap) state.customerMap.panTo([state.selectedLat, state.selectedLng], { animate: true, duration: 0.45 });
}

function requestBrowserLocation(showErrors = true) {
  if (!navigator.geolocation) {
    if (showErrors) alert("This browser does not support location. Tap the map to choose manually.");
    return;
  }
  navigator.geolocation.getCurrentPosition(
    (p) => setCustomerCoords(p.coords.latitude, p.coords.longitude, "GPS location"),
    () => { if (showErrors) alert("Location permission was denied or unavailable. Please tap the map to pin the location."); },
    { enableHighAccuracy: true, timeout: 12000, maximumAge: 15000 }
  );
}

function showCustomerError(message) {
  Sfx.error();
  const box = $("customer-error-box");
  box.textContent = message;
  box.classList.remove("hidden");
}

function setupCustomerHandlers() {
  $("btn-use-location").addEventListener("click", () => requestBrowserLocation(true));
  const presets = $("injury-presets");
  if (presets) {
    presets.addEventListener("click", (e) => {
      const btn = e.target.closest(".preset-chip");
      if (!btn) return;
      const text = btn.dataset.preset;
      const ta = $("injury-description");
      const cur = ta.value.trim();
      if (!cur.toLowerCase().includes(text.toLowerCase())) {
        ta.value = cur ? `${cur}, ${text}` : text;
      }
      ta.focus();
    });
  }
  const landmarks = $("landmark-jumps");
  if (landmarks) {
    landmarks.addEventListener("click", (e) => {
      const btn = e.target.closest(".preset-chip");
      if (!btn) return;
      setCustomerCoords(Number(btn.dataset.lat), Number(btn.dataset.lng), btn.dataset.label);
    });
  }
  const copyBtn = $("btn-copy-track");
  if (copyBtn) {
    copyBtn.addEventListener("click", async () => {
      if (!state.activeRequestId) return;
      const url = `${location.origin}${location.pathname}?track=${encodeURIComponent(state.activeRequestId)}`;
      const prev = copyBtn.textContent;
      try {
        await navigator.clipboard.writeText(url);
        copyBtn.textContent = state.lang === "ne" ? "लिङ्क कपी भयो!" : "Copied!";
        setTimeout(() => { copyBtn.textContent = prev; }, 1800);
      } catch (_) {
        prompt("Copy tracking link:", url);
      }
    });
  }
  $("emergency-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    $("customer-error-box").classList.add("hidden");
    const name = $("patient-name").value.trim();
    const phone = $("patient-phone").value.trim();
    const description = $("injury-description").value.trim();
    if (name.length < 2) return showCustomerError("Please enter the patient or caller name.");
    if (!/^[0-9+\-\s]{7,18}$/.test(phone) || phone.replace(/\D/g, "").length < 7) return showCustomerError("Please enter a valid callback phone number.");
    if (description.length < 5) return showCustomerError("Please describe the injury or medical emergency.");
    await submitEmergencyPayload();
  });
  $("btn-new-request").addEventListener("click", () => {
    resetCustomerTicket();
    $("emergency-form").reset();
    const s = getSession();
    if (s && s.name) $("patient-name").value = s.name;
    initCustomerMap();
  });
}

async function submitEmergencyPayload() {
  const submitBtn = $("btn-submit-emergency");
  const idle = submitBtn.textContent;
  submitBtn.disabled = true;
  submitBtn.textContent = "Sending Emergency Alert...";

  let evidenceData = null;
  const file = $("evidence-photo").files[0];
  if (file) {
    if (!file.type.startsWith("image/")) { showCustomerError("Please select an image file."); submitBtn.disabled = false; submitBtn.textContent = idle; return; }
    if (file.size > 5 * 1024 * 1024) { showCustomerError("Photo must be 5 MB or smaller."); submitBtn.disabled = false; submitBtn.textContent = idle; return; }
    evidenceData = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }
  const payload = {
    patient_name: $("patient-name").value.trim(),
    phone: $("patient-phone").value.trim(),
    severity: "STANDARD",
    injury_confirmed: true,
    injury_details: [$("injury-description").value.trim()],
    evidence_data: evidenceData,
    lat: state.selectedLat,
    lng: state.selectedLng,
    location_label: state.selectedLocationLabel,
    bypass_cooldown: $("demo-bypass-cooldown")?.checked || false,
  };
  try {
    const created = await apiFetch("/api/requests", { method: "POST", body: JSON.stringify(payload) });
    state.activeRequestId = created.id;
    localStorage.setItem(activeRequestKey(), created.id);
    Sfx.success();
    showCustomerTracker();
    renderCustomerTracker(created, []);
  } catch (err) {
    showCustomerError(err.message);
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = idle;
  }
}

function resetCustomerTicket() {
  state.activeRequestId = null;
  localStorage.removeItem(activeRequestKey());
  $("customer-tracker-card").classList.add("hidden");
  $("customer-form-card").classList.remove("hidden");
  resetLiveMap();
}

function showCustomerTracker() {
  $("customer-form-card").classList.add("hidden");
  $("customer-tracker-card").classList.remove("hidden");
  if (!state.customerLiveMap) {
    state.customerLiveMap = L.map("customer-live-map", LEAFLET_MAP_OPTS).setView(ITAHARI_CENTER, 14);
    addTiles(state.customerLiveMap);
  }
  setTimeout(() => state.customerLiveMap.invalidateSize(), 120);
}

function resetLiveMap() {
  const map = state.customerLiveMap;
  const live = state.live;
  if (map) [live.patient, live.amb, live.route].forEach((l) => l && map.removeLayer(l));
  state.live = { reqId: null, patient: null, amb: null, route: null, fitKey: null };
}

function renderCustomerTracker(req, ambulances) {
  if (!req) return;
  $("track-req-id").textContent = req.id.toUpperCase();
  const badge = $("track-status-badge");
  badge.textContent = req.status.replace("_", " ");
  badge.className = `status-pill status-${req.status}`;

  const toHospital = req.status === "EN_ROUTE" && req.transport_phase === "TO_HOSPITAL";
  $("track-eta-display").textContent =
    req.status === "EN_ROUTE"
      ? (toHospital
          ? `To ${req.destination_hospital || "hospital"}: ${formatSeconds(req.eta_seconds)}`
          : formatSeconds(req.eta_seconds))
    : req.status === "ARRIVED"
      ? (req.destination_hospital ? `Arrived at ${req.destination_hospital}` : "Arrived at hospital")
    : req.status === "FALSE_ALARM" ? "Dismissed by dispatch"
    : "Awaiting unit assignment";
  $("track-unit-display").textContent = req.assigned_callsign || "Matching nearest unit...";
  $("track-patient").textContent = req.patient_name;
  $("track-phone").textContent = req.phone;
  $("track-severity").textContent = req.status === "PENDING" ? "Awaiting dispatcher assessment" : req.severity;
  $("track-injuries").textContent = req.injury_details.join(", ");
  $("track-location").textContent = `${req.location_label} (${req.lat}, ${req.lng})`;

  const order = ["PENDING", "VERIFIED", "EN_ROUTE", "ARRIVED"];
  const idx = order.indexOf(req.status === "ASSIGNED" ? "EN_ROUTE" : req.status);
  document.querySelectorAll("#customer-tracker-card .step-item").forEach((el) => {
    el.classList.toggle("active", idx !== -1 && idx >= order.indexOf(el.dataset.step));
  });
  sfxTrack("customer", req);
  sfxSeen.customer.__primed = true;
  updateLiveMap(req, ambulances);
}

// Update patient/ambulance markers and route in place between polls
function updateLiveMap(req, ambulances) {
  const map = state.customerLiveMap;
  if (!map) return;
  if (state.live.reqId !== req.id) { resetLiveMap(); state.live.reqId = req.id; }
  const live = state.live;

  // Once the patient is on board (heading to hospital) or dropped off, the pickup pin is gone.
  const pickedUp = req.transport_phase === "TO_HOSPITAL" || req.transport_phase === "AT_HOSPITAL" || req.status === "ARRIVED";
  if (pickedUp) {
    if (live.patient) { map.removeLayer(live.patient); live.patient = null; }
  } else if (!live.patient) live.patient = L.marker([req.lat, req.lng], { icon: mkIcon("user", "sev-CRITICAL pulse") }).addTo(map);
  else setMarkerPos(live.patient, req.lat, req.lng);

  const amb = ambulances.find((a) => a.id === req.assigned_ambulance_id);
  const tracking = amb && (req.status === "EN_ROUTE" || (req.status === "ARRIVED" && amb.assigned_request_id === req.id));
  if (tracking) {
    const onThisJob = amb.assigned_request_id === req.id;
    const targetLat = onThisJob && amb.destination_lat != null ? amb.destination_lat : req.lat;
    const targetLng = onThisJob && amb.destination_lng != null ? amb.destination_lng : req.lng;
    const ambLat = onThisJob ? amb.current_lat : targetLat;
    const ambLng = onThisJob ? amb.current_lng : targetLng;
    const path = (onThisJob && remainingRoute(amb)) || [[ambLat, ambLng], [targetLat, targetLng]];
    const cls = req.status === "ARRIVED" ? "arrived" : "en-route";
    if (!live.amb) {
      live.amb = L.marker([ambLat, ambLng], { icon: mkIcon("amb", cls), zIndexOffset: 900 }).addTo(map);
    } else {
      setMarkerPos(live.amb, ambLat, ambLng);
      setMarkerIcon(live.amb, "amb", cls);
    }
    if (req.status === "EN_ROUTE") {
      const color = amb.phase === "TO_HOSPITAL" ? "#10b981" : "#ef4444";
      if (!live.route) live.route = L.polyline(path, { color, weight: 5, opacity: 0.85, dashArray: amb.route ? null : "6, 6" }).addTo(map);
      else { live.route.setLatLngs(path); live.route.setStyle({ color, dashArray: amb.route ? null : "6, 6" }); }
    } else if (live.route) {
      map.removeLayer(live.route);
      live.route = null;
    }
    const fitKey = `${req.id}:${amb.id}:${req.transport_phase || ""}`;
    if (live.fitKey !== fitKey) {
      live.fitKey = fitKey;
      map.fitBounds(L.latLngBounds([[ambLat, ambLng], [targetLat, targetLng]]), { padding: [40, 40] });
    }
  } else {
    [live.amb, live.route].forEach((l) => l && map.removeLayer(l));
    live.amb = live.route = null;
    const fitKey = `${req.id}:pin`;
    if (req.status !== "ARRIVED" && live.fitKey !== fitKey && live.fitKey !== `${req.id}:${req.assigned_ambulance_id}`) {
      live.fitKey = fitKey;
      map.setView([req.lat, req.lng], 15);
    }
  }
}

// ---------- Sign in / Create account ----------
function showAuthError(message) {
  Sfx.error();
  const box = $("auth-error");
  box.textContent = message;
  box.classList.remove("hidden");
}

function setAuthMode(mode) {
  state.authMode = mode;
  const reg = mode === "register";
  $("tab-signin").classList.toggle("active", !reg);
  $("tab-register").classList.toggle("active", reg);
  $("reg-name-group").classList.toggle("hidden", !reg);
  $("btn-auth-submit").textContent = reg ? "Create account" : "Sign in";
  $("auth-password").autocomplete = reg ? "new-password" : "current-password";
  $("auth-error").classList.add("hidden");
}

function setupAuthHandlers() {
  $("tab-signin").addEventListener("click", () => setAuthMode("signin"));
  $("tab-register").addEventListener("click", () => setAuthMode("register"));
  $("btn-toggle-pw").addEventListener("click", () => {
    const input = $("auth-password");
    const show = input.type === "password";
    input.type = show ? "text" : "password";
    $("btn-toggle-pw").textContent = show ? "Hide" : "Show";
  });

  $("auth-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    $("auth-error").classList.add("hidden");
    const email = $("auth-email").value.trim();
    const password = $("auth-password").value;
    const name = $("auth-name").value.trim();
    const register = state.authMode === "register";
    if (!email || !password) return showAuthError("Please enter your email and password.");
    if (register && name.length < 2) return showAuthError("Please enter your full name.");
    if (register && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return showAuthError("Please enter a valid email address.");
    if (register && password.length < 6) return showAuthError("Password must be at least 6 characters.");

    const btn = $("btn-auth-submit");
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Please wait...";
    try {
      const result = await apiFetch(register ? "/api/auth/register" : "/api/auth/login", {
        method: "POST",
        body: JSON.stringify(register ? { name, email, password } : { email, password }),
      });
      saveSession(result);
      $("auth-form").reset();
      routeAfterLogin();
    } catch (err) {
      showAuthError(err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = label;
    }
  });

  $("btn-guest").addEventListener("click", () => { clearSession(); setRole("customer"); });
}

// ---------- Dispatcher: view switching ----------
function setDispatcherView(view) {
  state.dView = view;
  $("view-map").classList.toggle("hidden", view !== "map");
  $("view-detail").classList.toggle("hidden", view !== "detail");
  $("btn-view-map").classList.toggle("active", view === "map");
  $("btn-view-detail").classList.toggle("active", view === "detail");
  if (view === "map" && state.dispatcherMap) setTimeout(() => state.dispatcherMap.invalidateSize(), 60);
}

function selectIncident(id) {
  state.selectedIncidentId = id;
  state.photoShownFor = null;
  if (state.lastSys) {
    renderQueue(state.lastSys);
    renderDetail(state.lastSys);
    updateDynamic(state.lastSys);
    updateDispatcherMap(state.lastSys);
  }
  setDispatcherView("detail");
}

function showOnMap(id) {
  const req = state.lastSys && state.lastSys.requests.find((r) => r.id === id);
  setDispatcherView("map");
  if (req && state.dispatcherMap) setTimeout(() => state.dispatcherMap.setView([req.lat, req.lng], 15), 80);
}

async function handleTriage(requestId, action, severity = null) {
  try {
    await apiFetch("/api/triage", { method: "POST", body: JSON.stringify({ request_id: requestId, action, severity }) });
    pollSystemState();
  } catch (err) { alert(err.message); }
}

async function handleAssign(requestId, ambulanceId = null) {
  try {
    await apiFetch("/api/assign", { method: "POST", body: JSON.stringify({ request_id: requestId, ambulance_id: ambulanceId || null }) });
    pollSystemState();
  } catch (err) { alert(err.message); }
}

function setupDispatcherHandlers() {
  $("btn-view-map").addEventListener("click", () => setDispatcherView("map"));
  $("btn-view-detail").addEventListener("click", () => setDispatcherView("detail"));
  const filters = $("queue-filters");
  if (filters) {
    filters.addEventListener("click", (e) => {
      const pill = e.target.closest(".filter-pill");
      if (!pill) return;
      state.queueFilter = pill.dataset.filter;
      filters.querySelectorAll(".filter-pill").forEach((b) => b.classList.toggle("active", b === pill));
      if (state.lastSys) renderQueue(state.lastSys);
    });
  }
  const qSearch = $("queue-search");
  if (qSearch) {
    qSearch.addEventListener("input", (e) => {
      state.queueSearch = e.target.value.trim().toLowerCase();
      if (state.lastSys) renderQueue(state.lastSys);
    });
  }
  $("toggle-hospitals").addEventListener("change", (e) => {
    state.showHospitals = e.target.checked;
    const layer = state.dLayers.hospitals;
    if (layer && state.dispatcherMap) state.showHospitals ? state.dispatcherMap.addLayer(layer) : state.dispatcherMap.removeLayer(layer);
  });
  $("btn-reset-demo").addEventListener("click", async () => {
    try {
      state.selectedIncidentId = null;
      state.photoShownFor = null;
      state.evidenceCache = {};
      renderDispatcherView(await apiFetch("/api/reset", { method: "POST" }));
    } catch (err) { alert("Reset failed: " + err.message); }
  });
  $("lightbox").addEventListener("click", () => $("lightbox").classList.add("hidden"));
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (!$("lightbox").classList.contains("hidden")) {
        $("lightbox").classList.add("hidden");
      } else if (state.role === "dispatcher" && state.dView === "detail") {
        setDispatcherView("map");
      }
      return;
    }
    if (state.role !== "dispatcher") return;
    const tag = document.activeElement && document.activeElement.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      const cards = [...document.querySelectorAll("#incident-queue-list .inc-card")];
      if (!cards.length) return;
      e.preventDefault();
      const idx = cards.findIndex((c) => c.classList.contains("is-selected"));
      const next = e.key === "ArrowDown" ? (idx + 1) % cards.length : (idx - 1 + cards.length) % cards.length;
      cards[next].click();
      cards[next].scrollIntoView({ block: "nearest" });
    }
  });
}

function initDispatcherMap() {
  if (state.dispatcherMap) {
    setTimeout(() => state.dispatcherMap.invalidateSize(), 120);
    return;
  }
  state.dispatcherMap = L.map("dispatcher-map", LEAFLET_MAP_OPTS).setView(ITAHARI_CENTER, 13);
  addTiles(state.dispatcherMap);
  state.dLayers.hospitals = L.layerGroup();
  if (state.showHospitals) state.dLayers.hospitals.addTo(state.dispatcherMap);
  drawHospitalMarkers(state.dLayers.hospitals);
}

// ---------- Dispatcher: rendering ----------
const isResolved = (r) => r.status === "ARRIVED" || r.status === "FALSE_ALARM";

const RESOLVED_VISIBLE_SECONDS = 60;
function renderDispatcherView(sys) {
  // arrived / dismissed incidents leave the queue 1 minute after they finish
  sys.requests = sys.requests.filter((r) => !(isResolved(r) && r.completed_at && sys.server_time - r.completed_at >= RESOLVED_VISIBLE_SECONDS));
  state.lastSys = sys;
  const available = sys.ambulances.filter((a) => a.status === "AVAILABLE");
  const active = sys.requests.filter((r) => !isResolved(r));
  $("stat-available").textContent = available.length;
  $("stat-enroute").textContent = sys.ambulances.filter((a) => a.status === "EN_ROUTE").length;
  $("stat-active").textContent = active.length;
  $("queue-count-badge").textContent = active.length;

  sys.requests.forEach((r) => sfxTrack("dispatcher", r));
  sfxSeen.dispatcher.__primed = true;
  renderQueue(sys);
  renderDetail(sys);
  renderFleet(sys);
  updateDispatcherMap(sys);
  updateDynamic(sys);
}

function renderQueue(sys) {
  const listEl = $("incident-queue-list");
  const q = state.queueSearch;
  const filtered = sys.requests.filter((r) => {
    if (state.queueFilter === "PENDING" && r.status !== "PENDING") return false;
    if (state.queueFilter === "CRITICAL" && !(r.severity === "CRITICAL" && !isResolved(r))) return false;
    if (state.queueFilter === "EN_ROUTE" && r.status !== "EN_ROUTE") return false;
    if (state.queueFilter === "COMPLETED" && !isResolved(r)) return false;
    if (q) {
      const hay = `${r.patient_name || ""} ${r.phone || ""} ${r.id || ""}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
  if (!filtered.length) {
    const emptyMsg = sys.requests.length
      ? "No incidents match this filter."
      : "No active emergency requests. Waiting for incoming alerts...";
    setHtml(listEl, `<div class="empty-state">${emptyMsg}</div>`);
    return;
  }
  setHtml(listEl, filtered.map((req) => {
    const ambLine = req.assigned_callsign
      ? `<div class="inc-sub"><img src="assets/ambulance.svg" class="mini-ico" alt="" /> ${escapeHtml(req.assigned_callsign)} &middot; <span data-eta="${req.id}"></span></div>`
      : !isResolved(req) && req.nearest_unit_callsign
      ? `<div class="inc-sub text-green">Nearest: ${escapeHtml(req.nearest_unit_callsign)} (${req.nearest_distance_km} km)</div>`
      : "";
    return `
      <div class="inc-card sev-border-${req.severity} ${isResolved(req) ? "is-resolved" : ""} ${req.id === state.selectedIncidentId ? "is-selected" : ""}"
           role="button" tabindex="0" onclick="selectIncident('${req.id}')" onkeydown="if(event.key==='Enter')selectIncident('${req.id}')">
        <div class="inc-top">
          <div>
            <span class="sev-tag sev-tag-${req.severity}">${req.severity}</span>
            <span class="status-pill status-${req.status}">${req.status.replace("_", " ")}</span>
          </div>
          ${req.is_duplicate ? `<span class="dup-tag">POSSIBLE DUPLICATE</span>` : ""}
        </div>
        <div class="inc-patient"><img src="assets/user.svg" class="mini-ico" alt="" /> ${escapeHtml(req.patient_name)} &bull; ${escapeHtml(req.phone)}</div>
        <div class="inc-sub">${escapeHtml(clip(req.injury_details.join(", "), 90))}</div>
        ${ambLine}
        <div class="inc-open">Open details &rarr;</div>
      </div>`;
  }).join(""));
}

function renderDetail(sys) {
  const tab = $("btn-view-detail");
  const req = sys.requests.find((r) => r.id === state.selectedIncidentId);
  tab.disabled = !req;
  if (!req) {
    state.selectedIncidentId = null;
    tab.textContent = "Incident details";
    if (state.dView === "detail") setDispatcherView("map");
    return;
  }
  tab.textContent = `Incident ${req.id.slice(-4).toUpperCase()}`;

  const available = sys.ambulances.filter((a) => a.status === "AVAILABLE");
  const amb = sys.ambulances.find((a) => a.id === req.assigned_ambulance_id);
  const resolved = isResolved(req);
  const canDispatch = req.status === "PENDING" || req.status === "VERIFIED";
  const hospitals = nearestHospitals(req.lat, req.lng, 3);

  const unitCard = req.assigned_callsign
    ? `<div class="big-line">${escapeHtml(req.assigned_callsign)}</div>
       <div class="muted">${escapeHtml(req.transport_phase === "TO_HOSPITAL" ? `Transporting to ${req.destination_hospital || "hospital"}` : req.transport_phase === "AT_HOSPITAL" ? `Dropped off at ${req.destination_hospital || "hospital"}` : amb ? amb.station_name : "")}</div>
       <div class="eta-row"><span class="eta-big" data-eta="${req.id}"></span>${amb && amb.route_km ? `<span class="muted">${amb.route_km} km ${amb.route ? "by road" : "straight line"}</span>` : ""}</div>
       <div class="progress"><div class="progress-fill" data-progress="${req.id}"></div></div>`
    : req.nearest_unit_callsign && !resolved
    ? `<div class="big-line">${escapeHtml(req.nearest_unit_callsign)}</div><div class="muted">Nearest free unit &middot; ${req.nearest_distance_km} km straight-line</div>`
    : `<div class="muted">${resolved ? "No unit assigned." : "No free units right now."}</div>`;

  const hospitalCard = hospitals.length
    ? hospitals.map((h) => `<div class="hospital-row compact"><img src="assets/hospital.svg" class="hospital-ico" alt="" /><div class="hospital-info"><strong>${escapeHtml(h.name)}</strong><span>${h.distance.toFixed(1)} km${h.phone ? ` &middot; ${escapeHtml(h.phone)}` : ""}</span></div></div>`).join("")
    : `<div class="muted">${state.hospitalsTried ? "Hospital data unavailable." : "Loading real hospital data..."}</div>`;

  const actions = resolved ? "" : `
    <div class="detail-actions">
      ${req.status === "PENDING" ? `
        <div class="assign-row">
          <select id="sev-select" aria-label="Severity"><option value="CRITICAL">Critical</option><option value="URGENT">Urgent</option><option value="STANDARD" selected>Standard</option></select>
          <button class="btn btn-primary" onclick="handleTriage('${req.id}','VERIFY',document.getElementById('sev-select').value)">Verify &amp; set severity</button>
        </div>` : ""}
      ${canDispatch ? `
        <button class="btn btn-danger btn-lg" ${available.length ? "" : "disabled"} onclick="handleAssign('${req.id}', null)">Assign nearest unit${req.nearest_distance_km != null ? ` (${req.nearest_distance_km} km)` : ""}</button>
        <div class="assign-row">
          <select id="unit-select" aria-label="Choose unit">${available.map((u) => `<option value="${escapeHtml(u.id)}">${escapeHtml(u.callsign)}</option>`).join("") || `<option value="">No units free</option>`}</select>
          <button class="btn btn-secondary" ${available.length ? "" : "disabled"} onclick="handleAssign('${req.id}', document.getElementById('unit-select').value)">Assign selected</button>
        </div>` : ""}
      <button class="btn btn-ghost" onclick="handleTriage('${req.id}','FALSE_ALARM')">Dismiss / false alarm</button>
    </div>`;

  setHtml($("detail-body"), `
    <div class="detail-head">
      <div>
        <span class="eyebrow">INCIDENT &middot; ${escapeHtml(formatTime(req.created_at))}</span>
        <h2>${escapeHtml(req.id.toUpperCase())}</h2>
        <div class="detail-badges">
          <span class="sev-tag sev-tag-${req.severity}">${req.severity}</span>
          <span class="status-pill status-${req.status}">${req.status.replace("_", " ")}</span>
          ${req.is_duplicate ? `<span class="dup-tag">POSSIBLE DUPLICATE</span>` : ""}
        </div>
      </div>
      <button class="btn btn-secondary" onclick="showOnMap('${req.id}')">Show on map</button>
    </div>

    ${req.is_duplicate ? `<div class="error-banner"><strong>Duplicate alert:</strong> ${escapeHtml(req.duplicate_reason)}</div>` : ""}

    <div class="detail-grid">
      <div class="detail-card">
        <h4><img src="assets/user.svg" class="mini-ico" alt="" /> Patient / caller</h4>
        <div class="big-line">${escapeHtml(req.patient_name)}</div>
        <a class="phone-link" href="tel:${escapeHtml(req.phone)}">${escapeHtml(req.phone)}</a>
      </div>
      <div class="detail-card">
        <h4>Location</h4>
        <div class="big-line">${escapeHtml(req.location_label)}</div>
        <div class="muted">${req.lat}, ${req.lng}</div>
      </div>
      <div class="detail-card wide">
        <h4>Caller report</h4>
        <p class="report">${escapeHtml(req.injury_details.join("\n"))}</p>
      </div>
      <div class="detail-card">
        <h4><img src="assets/ambulance.svg" class="mini-ico" alt="" /> Response unit</h4>
        ${unitCard}
      </div>
      <div class="detail-card">
        <h4><img src="assets/hospital.svg" class="mini-ico" alt="" /> Nearest hospitals <span class="muted">(OpenStreetMap)</span></h4>
        ${hospitalCard}
      </div>
    </div>
    ${actions}`);

  if (state.photoShownFor !== req.id) fillPhoto(req);
}

function fillPhoto(req) {
  const slot = $("detail-photo");
  state.photoShownFor = req.id;
  if (!req.has_evidence) { slot.innerHTML = ""; return; }
  const show = (src) => {
    if (state.selectedIncidentId !== req.id) return;
    slot.innerHTML = `<div class="detail-card wide"><h4>Photo evidence</h4><img class="evidence-img" alt="Uploaded evidence photo" style="cursor:zoom-in" /></div>`;
    const img = slot.querySelector("img");
    img.src = src;
    img.onclick = () => {
      $("lightbox-img").src = src;
      $("lightbox").classList.remove("hidden");
    };
  };
  if (state.evidenceCache[req.id]) return show(state.evidenceCache[req.id]);
  slot.innerHTML = `<div class="detail-card wide"><h4>Photo evidence</h4><div class="muted">Loading photo...</div></div>`;
  apiFetch(`/api/dispatcher/requests/${encodeURIComponent(req.id)}/evidence`)
    .then((res) => { state.evidenceCache[req.id] = res.evidence_data; show(res.evidence_data); })
    .catch(() => { slot.innerHTML = `<div class="detail-card wide"><div class="muted">Couldn't load the photo.</div></div>`; });
}

function focusAmbulance(ambId) {
  const amb = state.lastSys && state.lastSys.ambulances.find((a) => a.id === ambId);
  if (!amb || !state.dispatcherMap) return;
  if (state.dView !== "map") setDispatcherView("map");
  state.dispatcherMap.flyTo([amb.current_lat, amb.current_lng], 15, { duration: 0.65 });
  const marker = state.dLayers.ambulances[ambId];
  if (marker) marker.openTooltip();
}

function renderFleet(sys) {
  const strip = $("fleet-strip");
  if (strip && !strip.dataset.wheelBound) {
    strip.dataset.wheelBound = "1";
    strip.addEventListener("wheel", (e) => {
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
        e.preventDefault();
        strip.scrollBy({ left: e.deltaY * 1.8, behavior: "smooth" });
      }
    }, { passive: false });
  }
  setHtml(strip, sys.ambulances.map((amb) => `
    <div class="unit-mini-card" role="button" tabindex="0" title="Focus ${escapeHtml(amb.callsign)} on map"
         onclick="focusAmbulance('${amb.id}')" onkeydown="if(event.key==='Enter')focusAmbulance('${amb.id}')">
      <div class="unit-top"><img src="assets/ambulance.svg" class="mini-ico" alt="" /><strong>${escapeHtml(amb.callsign)}</strong></div>
      <span class="status-pill status-${amb.status === "AVAILABLE" ? "ARRIVED" : amb.status}">${amb.status === "AVAILABLE" && amb.phase === "RETURNING" ? "RETURNING" : amb.status}</span>
      <div class="inc-sub">${escapeHtml(amb.station_name)}</div>
      ${amb.status === "EN_ROUTE" ? `<div class="text-amber">ETA: <span data-amb-eta="${escapeHtml(amb.id)}"></span></div>` : ""}
      ${amb.status === "AVAILABLE" && amb.phase === "RETURNING" ? `<div class="inc-sub">Back at base in <span data-amb-eta="${escapeHtml(amb.id)}"></span></div>` : ""}
    </div>`).join(""));
}

// Patch fast-changing ETA and progress values in place without rebuilding surrounding DOM
function updateDynamic(sys) {
  const reqById = Object.fromEntries(sys.requests.map((r) => [r.id, r]));
  const ambById = Object.fromEntries(sys.ambulances.map((a) => [a.id, a]));
  document.querySelectorAll("[data-eta]").forEach((el) => {
    const r = reqById[el.dataset.eta];
    const txt = r
      ? (r.status === "ARRIVED"
          ? (r.destination_hospital ? `At ${r.destination_hospital}` : "Arrived")
          : r.transport_phase === "TO_HOSPITAL"
          ? `To ${r.destination_hospital || "hospital"} (${formatSeconds(r.eta_seconds)})`
          : formatSeconds(r.eta_seconds))
      : "";
    if (el.textContent !== txt) el.textContent = txt;
  });
  document.querySelectorAll("[data-progress]").forEach((el) => {
    const r = reqById[el.dataset.progress];
    const a = r && ambById[r.assigned_ambulance_id];
    let pct = r && r.status === "ARRIVED" ? 100 : a && a.eta_total ? Math.round(100 * (1 - (r.eta_seconds ?? a.eta_total) / a.eta_total)) : 0;
    pct = Math.max(0, Math.min(100, pct));
    el.style.width = pct + "%";
  });
  document.querySelectorAll("[data-amb-eta]").forEach((el) => {
    const a = ambById[el.dataset.ambEta];
    const txt = a ? formatSeconds(a.eta_seconds) : "";
    if (el.textContent !== txt) el.textContent = txt;
  });
}

function updateDispatcherMap(sys) {
  const map = state.dispatcherMap;
  if (!map) return;
  const L1 = state.dLayers;
  const ambById = Object.fromEntries(sys.ambulances.map((a) => [a.id, a]));

  // ambulances: created once, then glide to new positions
  sys.ambulances.forEach((amb) => {
    const cls = amb.status === "EN_ROUTE" ? "en-route" : amb.status === "ARRIVED" ? "arrived" : "available";
    let m = L1.ambulances[amb.id];
    if (!m) {
      m = L1.ambulances[amb.id] = L.marker([amb.current_lat, amb.current_lng], { icon: mkIcon("amb", cls), zIndexOffset: 900 })
        .addTo(map)
        .bindTooltip(escapeHtml(amb.callsign));
      m._ikey = `amb|${cls}`;
    } else {
      setMarkerPos(m, amb.current_lat, amb.current_lng);
      setMarkerIcon(m, "amb", cls);
    }
  });

  // returning units: dashed grey trace back to base (shrinks as they drive)
  sys.ambulances.forEach((amb) => {
    const returning = amb.status === "AVAILABLE" && amb.phase === "RETURNING";
    let line = L1.returns[amb.id];
    if (!returning) {
      if (line) { map.removeLayer(line); delete L1.returns[amb.id]; }
      return;
    }
    const path = remainingRoute(amb) || [[amb.current_lat, amb.current_lng], [amb.base_lat, amb.base_lng]];
    if (!line) L1.returns[amb.id] = L.polyline(path, { color: "#94a3b8", weight: 4, opacity: 0.8, dashArray: "4, 8" }).addTo(map);
    else line.setLatLngs(path);
  });

  // incidents + routes: add/remove by id, update in place
  const liveIds = new Set();
  sys.requests.forEach((req) => {
    if (req.status === "FALSE_ALARM") return;
    liveIds.add(req.id);
    // patient asset disappears once they are picked up (en route to hospital) or dropped off
    const pickedUp = req.status === "ARRIVED" || req.transport_phase === "TO_HOSPITAL" || req.transport_phase === "AT_HOSPITAL";
    const cls = `sev-${req.severity}${req.id === state.selectedIncidentId ? " selected" : ""}`;
    let m = L1.incidents[req.id];
    if (pickedUp) {
      if (m) { map.removeLayer(m); delete L1.incidents[req.id]; }
    } else if (!m) {
      m = L1.incidents[req.id] = L.marker([req.lat, req.lng], { icon: mkIcon("user", cls) })
        .addTo(map)
        .bindTooltip(escapeHtml(req.patient_name))
        .on("click", () => selectIncident(req.id));
      m._ikey = `user|${cls}`;
    } else {
      setMarkerIcon(m, "user", cls);
    }

    const amb = ambById[req.assigned_ambulance_id];
    const drive = amb && req.status === "EN_ROUTE";
    let line = L1.routes[req.id];
    if (!drive) {
      if (line) { map.removeLayer(line); delete L1.routes[req.id]; }
      return;
    }
    const road = amb.route && amb.route.length > 1;
    const destLat = amb.destination_lat != null ? amb.destination_lat : req.lat;
    const destLng = amb.destination_lng != null ? amb.destination_lng : req.lng;
    // only the part of the route still ahead of the ambulance is drawn
    const path = (road && remainingRoute(amb)) || [[amb.current_lat, amb.current_lng], [destLat, destLng]];
    const color = amb.phase === "TO_HOSPITAL" ? "#10b981" : "#ef4444";
    if (!line) {
      line = L1.routes[req.id] = L.polyline(path, { color, weight: 5, opacity: 0.85, dashArray: road ? null : "8, 6" }).addTo(map);
    } else {
      line.setLatLngs(path);
      line.setStyle({ color, dashArray: road ? null : "8, 6" });
    }
  });
  Object.keys(L1.incidents).forEach((id) => {
    if (!liveIds.has(id)) { map.removeLayer(L1.incidents[id]); delete L1.incidents[id]; }
  });
  Object.keys(L1.routes).forEach((id) => {
    if (!liveIds.has(id)) { map.removeLayer(L1.routes[id]); delete L1.routes[id]; }
  });
}

// ---------- Polling ----------
function renderSystemState(sys) {
  if (state.role === "dispatcher") {
    renderDispatcherView(sys);
  } else if (state.role === "customer") {
    const badge = $("fleet-badge");
    if (badge) {
      const free = sys.ambulances.filter((a) => a.status === "AVAILABLE").length;
      badge.textContent = `${free}/${sys.ambulances.length} demo units free`;
    }
  }
}

let polling = false;
async function pollSystemState() {
  if (polling || state.role === "auth") return;
  polling = true;
  try {
    const sys = await apiFetch(state.role === "dispatcher" ? "/api/dispatcher/state" : "/api/state");
    updateConnectionPill(true);
    renderSystemState(sys);
    if (state.role === "customer" && state.activeRequestId) {
      try {
        const mine = await apiFetch(`/api/requests/${encodeURIComponent(state.activeRequestId)}`);
        renderCustomerTracker(mine, sys.ambulances);
      } catch (err) {
        if (/not found/i.test(err.message)) resetCustomerTicket(); // demo was reset by a dispatcher
      }
    }
  } catch (_) {
    updateConnectionPill(false);
  } finally {
    polling = false;
  }
}

const I18N = {
  en: {
    heroTitle: "Emergency ambulance dispatch.",
    guestCalloutTitle: "Need an ambulance right now?",
    guestCalloutSub: "Skip sign-in and open the emergency pin form immediately.",
    guestBtn: "Request Ambulance Without Account",
    offlineTitle: "Service unavailable.",
    offlineDesc: "Unable to reach the dispatch server right now.",
    offlineTel: "Call 102",
    authTitle: "Account Sign In",
    tabSignin: "Sign in",
    tabRegister: "Create account",
    stepReceived: "Received",
    stepVerified: "Verified",
    stepEnRoute: "En Route",
    stepArrived: "Arrived",
    copyTrackBtn: "Copy Tracking Link",
    newRequestBtn: "Submit Another Request",
    formEyebrow: "EMERGENCY REQUEST",
    formTitle: "Request an Ambulance",
    lblPatientName: "Patient or Caller Name *",
    lblPatientPhone: "Callback Phone Number *",
    lblInjury: "Injury or Medical Condition *",
    presetAccident: "Road Accident",
    presetCardiac: "Chest Pain",
    presetUnconscious: "Unconscious",
    presetMaternity: "Maternity",
    presetBleeding: "Heavy Bleeding",
    lblPhoto: "Scene Photo (Optional)",
    lblLocation: "Incident Location *",
    btnUseGps: "Use current GPS location",
    btnSubmitEmergency: "DISPATCH EMERGENCY AMBULANCE",
  },
  ne: {
    heroTitle: "आकस्मिक एम्बुलेन्स डिस्प्याच।",
    guestCalloutTitle: "तुरुन्तै एम्बुलेन्स चाहियो?",
    guestCalloutSub: "साइन-इन नगरी सिधै आकस्मिक फारम खोल्नुहोस्।",
    guestBtn: "खाता बिना एम्बुलेन्स अनुरोध गर्नुहोस्",
    offlineTitle: "सेवा उपलब्ध छैन।",
    offlineDesc: "अहिले डिस्प्याच सर्भरसँग जडान हुन सकेन।",
    offlineTel: "१०२ मा फोन गर्नुहोस्",
    authTitle: "खाता साइन इन",
    tabSignin: "साइन इन",
    tabRegister: "नयाँ खाता",
    stepReceived: "प्राप्त भयो",
    stepVerified: "प्रमाणित",
    stepEnRoute: "बाटोमा",
    stepArrived: "पुग्यो",
    copyTrackBtn: "ट्र्याकिङ लिङ्क कपी गर्नुहोस्",
    newRequestBtn: "अर्को अनुरोध पठाउनुहोस्",
    formEyebrow: "आकस्मिक अनुरोध",
    formTitle: "एम्बुलेन्स बोलाउनुहोस्",
    lblPatientName: "बिरामी वा फोन गर्नेको नाम *",
    lblPatientPhone: "सम्पर्क फोन नम्बर *",
    lblInjury: "चोटपटक वा स्वास्थ्य अवस्था *",
    presetAccident: "सडक दुर्घटना",
    presetCardiac: "छाती दुख्ने",
    presetUnconscious: "बेहोस अवस्था",
    presetMaternity: "प्रसूति / सुत्केरी",
    presetBleeding: "अत्यधिक रक्तस्राव",
    lblPhoto: "घटनास्थलको फोटो (ऐच्छिक)",
    lblLocation: "घटनाको स्थान *",
    btnUseGps: "हालको GPS स्थान प्रयोग गर्नुहोस्",
    btnSubmitEmergency: "आकस्मिक एम्बुलेन्स पठाउनुहोस्",
  },
};

function applyLanguage(lang) {
  const dict = I18N[lang] || I18N.en;
  state.lang = I18N[lang] ? lang : "en";
  localStorage.setItem("rapidaid_lang", state.lang);
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    const val = dict[el.dataset.i18n];
    if (val) el.textContent = val;
  });
  const btn = $("lang-btn");
  if (btn) btn.textContent = state.lang === "ne" ? "EN" : "नेपाली";
}

function applyTheme(theme) {
  const dark = theme === "dark";
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  localStorage.setItem("rapidaid_theme", dark ? "dark" : "light");
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", dark ? "#0b1120" : "#f4f6f8");
  const url = tileUrlForTheme(dark);
  mapTileLayers.forEach((layer) => layer.setUrl(url));
  const btn = $("theme-btn");
  if (btn) {
    btn.textContent = dark ? "Light" : "Dark";
    btn.setAttribute("aria-pressed", String(dark));
  }
}

// ---------- Boot ----------
window.addEventListener("DOMContentLoaded", () => {
  const goHome = () => (getSession() ? routeAfterLogin() : setRole("auth"));
  $("nav-home-btn").addEventListener("click", goHome);
  $("switch-role-btn").addEventListener("click", () => { clearSession(); setRole("auth"); });

  applyTheme(localStorage.getItem("rapidaid_theme") || "light");
  $("theme-btn").addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    applyTheme(next);
  });

  applyLanguage(localStorage.getItem("rapidaid_lang") || "en");
  $("lang-btn").addEventListener("click", () => applyLanguage(state.lang === "ne" ? "en" : "ne"));

  setupAuthHandlers();
  setupCustomerHandlers();

  // sound: unlock audio on first interaction, click feedback on any button-like control, mute toggle
  window.addEventListener("pointerdown", () => Sfx.unlock(), { once: true });
  document.addEventListener("click", (e) => {
    if (e.target.closest("button, .tab, .view-tab, .inc-card, .toggle-chip, .btn, .brand")) Sfx.click();
  }, true);
  const soundBtn = $("sound-btn");
  const paintSound = () => { soundBtn.textContent = Sfx.muted ? "Sound off" : "Sound on"; soundBtn.setAttribute("aria-pressed", String(!Sfx.muted)); };
  paintSound();
  soundBtn.addEventListener("click", () => { Sfx.setMuted(!Sfx.muted); paintSound(); if (!Sfx.muted) Sfx.ecg(); });
  setupDispatcherHandlers();

  localStorage.removeItem("active_request_id");
  const trackParam = new URLSearchParams(location.search).get("track");
  if (trackParam) {
    clearSession();
    localStorage.setItem(activeRequestKey(), trackParam);
    setRole("customer");
  } else if (getSession()) {
    routeAfterLogin();
  } else {
    setRole("auth");
  }

  const ping = () => apiFetch("/api/health").then(() => updateConnectionPill(true)).catch(() => updateConnectionPill(false));
  ping();
  state.pollTimer = setInterval(() => {
    if (state.role === "auth") {
      ping();
    } else {
      pollSystemState();
      if (!state.hospitals.length && Date.now() - state.hospitalsLoadedAt > 30000) loadHospitals();
    }
  }, 1500);
});