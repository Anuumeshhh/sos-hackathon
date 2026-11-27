// RapidAid frontend. Served by the backend (http://localhost:8000); opened from a file or another dev server it talks to :8000.
const API_BASE_URL =
  window.RAPIDAID_API_URL ||
  (location.protocol === "file:" || (location.port && location.port !== "8000") ? "http://127.0.0.1:8000" : location.origin);

const ITAHARI_CENTER = [26.6646, 87.2718];

const state = {
  role: "auth",
  authMode: "signin",
  online: false,
  googleInit: false,
  googleLoading: false,
  selectedLat: ITAHARI_CENTER[0],
  selectedLng: ITAHARI_CENTER[1],
  selectedLocationLabel: "Selected location",
  activeRequestId: localStorage.getItem("active_request_id") || null,
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
  selectedIncidentId: null,
  photoShownFor: null,
  evidenceCache: {},
  lastSys: null,
  showHospitals: true,
  dLayers: { ambulances: {}, incidents: {}, routes: {}, hospitals: null },
  // real hospital data (OpenStreetMap via backend)
  hospitals: [],
  hospitalsTried: false,
  hospitalsLoading: false,
  hospitalsLoadedAt: 0,
};

// ---------- Helpers ----------
const $ = (id) => document.getElementById(id);

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

// Re-render a container only when its HTML really changed, and never while a dropdown inside it is open.
// This is what stops the flicker / closing dropdowns during live tracking.
function setHtml(el, html) {
  const active = document.activeElement;
  if (active && active.tagName === "SELECT" && el.contains(active)) return false;
  if (el.dataset.html === html) return false;
  const saved = {};
  el.querySelectorAll("select").forEach((s) => { if (s.id) saved[s.id] = s.value; });
  const scrollTop = el.scrollTop;
  el.innerHTML = html;
  el.dataset.html = html;
  el.querySelectorAll("select").forEach((s) => {
    if (saved[s.id] && [...s.options].some((o) => o.value === saved[s.id])) s.value = saved[s.id];
  });
  el.scrollTop = scrollTop;
  return true;
}

// ---------- Session & API ----------
function getSession() {
  try { return JSON.parse(sessionStorage.getItem("rapidaid_session") || "null"); } catch (_) { return null; }
}
function saveSession(res) {
  sessionStorage.setItem("rapidaid_session", JSON.stringify({ token: res.access_token, role: res.role, name: res.name, email: res.email, picture: res.picture || "" }));
}
function clearSession() { sessionStorage.removeItem("rapidaid_session"); }

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
// Only touch a marker when something changed; recreating icons every poll was a major source of flicker.
function setMarkerIcon(marker, kind, cls) {
  const key = `${kind}|${cls}`;
  if (marker._ikey !== key) { marker.setIcon(mkIcon(kind, cls)); marker._ikey = key; }
}
function setMarkerPos(marker, lat, lng) {
  const p = marker.getLatLng();
  if (p.lat !== lat || p.lng !== lng) marker.setLatLng([lat, lng]);
}
function addTiles(map) {
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { attribution: "&copy; OpenStreetMap contributors", maxZoom: 19 }).addTo(map);
}

// ---------- Real hospital data ----------
function directionsUrl(lat, lng) {
  return `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`;
}

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
    /* retried later */
  } finally {
    state.hospitalsLoading = false;
    state.hospitalsTried = true;
    state.hospitalsLoadedAt = Date.now();
  }
  if (state.hospitals.length) {
    drawHospitalMarkers(state.customerHospLayer);
    drawHospitalMarkers(state.dLayers.hospitals);
    renderNearbyHospitals();
    if (state.lastSys) renderDetail(state.lastSys);
  } else {
    renderNearbyHospitals();
  }
}

function drawHospitalMarkers(layer) {
  if (!layer) return;
  layer.clearLayers();
  state.hospitals.forEach((h) => {
    L.marker([h.lat, h.lng], { icon: mkIcon("hosp") })
      .bindPopup(
        `<strong>${escapeHtml(h.name)}</strong>${h.phone ? `<br>${escapeHtml(h.phone)}` : ""}<br><a href="${directionsUrl(h.lat, h.lng)}" target="_blank" rel="noopener">Directions</a>`
      )
      .addTo(layer);
  });
}

function renderNearbyHospitals() {
  const box = $("nearby-hospitals");
  if (!box) return;
  if (!state.hospitals.length) {
    setHtml(box, state.hospitalsTried
      ? `<div class="empty-state">Hospital data is unavailable right now (the server needs internet once to download it). In Nepal, dial 102 for an ambulance.</div>`
      : `<div class="empty-state">Loading real hospital data...</div>`);
    return;
  }
  const list = nearestHospitals(state.selectedLat, state.selectedLng, 4);
  setHtml(box, list.map((h) => `
    <div class="hospital-row">
      <img src="assets/hospital.svg" class="hospital-ico" alt="" />
      <div class="hospital-info">
        <strong>${escapeHtml(h.name)}</strong>
        <span>${h.distance.toFixed(1)} km away${h.phone ? ` &middot; ${escapeHtml(h.phone)}` : ""}${h.emergency ? " &middot; Emergency dept" : ""}</span>
      </div>
      <a class="btn btn-secondary btn-sm" href="${directionsUrl(h.lat, h.lng)}" target="_blank" rel="noopener">Directions</a>
    </div>`).join(""));
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
    if (state.activeRequestId) showCustomerTracker();
    renderNearbyHospitals();
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
function initCustomerMap() {
  if (state.customerMap) {
    setTimeout(() => state.customerMap.invalidateSize(), 120);
    return;
  }
  state.customerMap = L.map("customer-map").setView(ITAHARI_CENTER, 14);
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
  if (state.customerMap) state.customerMap.panTo([state.selectedLat, state.selectedLng]);
  renderNearbyHospitals();
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
  const box = $("customer-error-box");
  box.textContent = message;
  box.classList.remove("hidden");
}

function setupCustomerHandlers() {
  $("btn-use-location").addEventListener("click", () => requestBrowserLocation(true));
  $("emergency-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    $("customer-error-box").classList.add("hidden");
    const name = $("patient-name").value.trim();
    const phone = $("patient-phone").value.trim();
    const description = $("injury-description").value.trim();
    if (name.length < 2) return showCustomerError("Please enter the patient or caller name.");
    if (!/^[0-9+\-\s]{7,18}$/.test(phone)) return showCustomerError("Please enter a valid callback phone number.");
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
  const idle = "DISPATCH EMERGENCY AMBULANCE";
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
    localStorage.setItem("active_request_id", created.id);
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
  localStorage.removeItem("active_request_id");
  $("customer-tracker-card").classList.add("hidden");
  $("customer-form-card").classList.remove("hidden");
  resetLiveMap();
}

function showCustomerTracker() {
  $("customer-form-card").classList.add("hidden");
  $("customer-tracker-card").classList.remove("hidden");
  if (!state.customerLiveMap) {
    state.customerLiveMap = L.map("customer-live-map").setView(ITAHARI_CENTER, 14);
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

  $("track-eta-display").textContent =
    req.status === "EN_ROUTE" ? formatSeconds(req.eta_seconds)
    : req.status === "ARRIVED" ? "Arrived on scene"
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
  updateLiveMap(req, ambulances);
}

// Markers are created once and then moved: no clearing/redrawing and no re-fitting the map on every poll.
function updateLiveMap(req, ambulances) {
  const map = state.customerLiveMap;
  if (!map) return;
  if (state.live.reqId !== req.id) { resetLiveMap(); state.live.reqId = req.id; }
  const live = state.live;

  if (!live.patient) live.patient = L.marker([req.lat, req.lng], { icon: mkIcon("user", "sev-CRITICAL pulse") }).addTo(map);
  else setMarkerPos(live.patient, req.lat, req.lng);

  const amb = ambulances.find((a) => a.id === req.assigned_ambulance_id);
  const tracking = amb && (req.status === "EN_ROUTE" || req.status === "ARRIVED");
  if (tracking) {
    const path = amb.route && amb.route.length > 1 ? amb.route : [[amb.current_lat, amb.current_lng], [req.lat, req.lng]];
    const cls = req.status === "ARRIVED" ? "arrived" : "en-route";
    if (!live.amb) {
      live.amb = L.marker([amb.current_lat, amb.current_lng], { icon: mkIcon("amb", cls), zIndexOffset: 900 }).addTo(map);
    } else {
      setMarkerPos(live.amb, amb.current_lat, amb.current_lng);
      setMarkerIcon(live.amb, "amb", cls);
    }
    if (req.status === "EN_ROUTE") {
      if (!live.route) live.route = L.polyline(path, { color: "#3b82f6", weight: 5, opacity: 0.85, dashArray: amb.route ? null : "6, 6" }).addTo(map);
      else if (!amb.route || live.route._rk !== amb.route.length) live.route.setLatLngs(path);
      live.route._rk = amb.route ? amb.route.length : 0;
    } else if (live.route) {
      map.removeLayer(live.route);
      live.route = null;
    }
    const fitKey = `${req.id}:${amb.id}`;
    if (live.fitKey !== fitKey) {
      live.fitKey = fitKey;
      map.fitBounds(L.latLngBounds([[amb.current_lat, amb.current_lng], [req.lat, req.lng]]), { padding: [40, 40] });
    }
  } else {
    [live.amb, live.route].forEach((l) => l && map.removeLayer(l));
    live.amb = live.route = null;
    const fitKey = `${req.id}:pin`;
    if (live.fitKey !== fitKey && live.fitKey !== `${req.id}:${req.assigned_ambulance_id}`) {
      live.fitKey = fitKey;
      map.setView([req.lat, req.lng], 15);
    }
  }
}

// ---------- Sign in / Google / Create account ----------
function showAuthError(message) {
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

function googleNotReadyMessage() {
  if (location.protocol === "file:") return "Open the app at http://localhost:8000 (not by double-clicking the file). Google sign-in only works from there.";
  if (!state.online) return "The backend server is offline. Start it (cd backend, then uvicorn main:app --port 8000), reload, and try again.";
  return "Google sign-in isn't set up yet. Add GOOGLE_CLIENT_ID to the .env file and restart the server. You can use email & password for now.";
}

async function initializeGoogleLogin() {
  if (state.googleLoading) return;
  state.googleLoading = true;
  try { await setupGoogle(); } finally { state.googleLoading = false; }
}

async function setupGoogle() {
  const fallback = $("btn-google-fallback");
  fallback.onclick = () => showAuthError(googleNotReadyMessage());

  let config;
  try { config = await apiFetch("/api/auth/config"); } catch (_) { return; } // backend offline: retried automatically
  state.googleInit = true;
  if (!config.google_enabled || !config.google_client_id) return;

  fallback.onclick = () => showAuthError("Loading Google sign-in... if this stays, check your internet connection and reload.");
  const script = document.createElement("script");
  script.src = "https://accounts.google.com/gsi/client";
  script.async = true;
  script.onerror = () => showAuthError("Couldn't load Google sign-in. Check your internet connection.");
  script.onload = () => {
    if (!window.google?.accounts?.id) return;
    window.google.accounts.id.initialize({
      client_id: config.google_client_id,
      callback: async (response) => {
        try {
          const result = await apiFetch("/api/auth/google", { method: "POST", body: JSON.stringify({ credential: response.credential }) });
          saveSession(result);
          routeAfterLogin();
        } catch (err) {
          showAuthError(err.message);
        }
      },
    });
    window.google.accounts.id.renderButton($("google-signin-button"), { theme: "filled_black", size: "large", text: "continue_with", shape: "pill", width: 320 });
    fallback.classList.add("hidden");
  };
  document.head.appendChild(script);
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
  initializeGoogleLogin();
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
  $("toggle-hospitals").addEventListener("change", (e) => {
    state.showHospitals = e.target.checked;
    const layer = state.dLayers.hospitals;
    if (layer && state.dispatcherMap) state.showHospitals ? state.dispatcherMap.addLayer(layer) : state.dispatcherMap.removeLayer(layer);
  });
  $("btn-reset-demo").addEventListener("click", async () => {
    try {
      state.selectedIncidentId = null;
      renderDispatcherView(await apiFetch("/api/reset", { method: "POST" }));
    } catch (err) { alert("Reset failed: " + err.message); }
  });
}

function initDispatcherMap() {
  if (state.dispatcherMap) {
    setTimeout(() => state.dispatcherMap.invalidateSize(), 120);
    return;
  }
  state.dispatcherMap = L.map("dispatcher-map").setView(ITAHARI_CENTER, 13);
  addTiles(state.dispatcherMap);
  state.dLayers.hospitals = L.layerGroup();
  if (state.showHospitals) state.dLayers.hospitals.addTo(state.dispatcherMap);
  drawHospitalMarkers(state.dLayers.hospitals);
}

// ---------- Dispatcher: rendering ----------
const isResolved = (r) => r.status === "ARRIVED" || r.status === "FALSE_ALARM";

function renderDispatcherView(sys) {
  state.lastSys = sys;
  const available = sys.ambulances.filter((a) => a.status === "AVAILABLE");
  const active = sys.requests.filter((r) => !isResolved(r));
  $("stat-available").textContent = available.length;
  $("stat-enroute").textContent = sys.ambulances.filter((a) => a.status === "EN_ROUTE").length;
  $("stat-active").textContent = active.length;
  $("queue-count-badge").textContent = active.length;

  renderQueue(sys);
  renderDetail(sys);
  renderFleet(sys);
  updateDispatcherMap(sys);
  updateDynamic(sys);
}

function renderQueue(sys) {
  const listEl = $("incident-queue-list");
  if (!sys.requests.length) {
    setHtml(listEl, `<div class="empty-state">No active emergency requests. Waiting for incoming alerts...</div>`);
    return;
  }
  setHtml(listEl, sys.requests.map((req) => {
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
       <div class="muted">${escapeHtml(amb ? amb.station_name : "")}</div>
       <div class="eta-row"><span class="eta-big" data-eta="${req.id}"></span>${amb && amb.route_km ? `<span class="muted">${amb.route_km} km ${amb.route ? "by road" : "straight line"}</span>` : ""}</div>
       <div class="progress"><div class="progress-fill" data-progress="${req.id}"></div></div>`
    : req.nearest_unit_callsign && !resolved
    ? `<div class="big-line">${escapeHtml(req.nearest_unit_callsign)}</div><div class="muted">Nearest free unit &middot; ${req.nearest_distance_km} km straight-line</div>`
    : `<div class="muted">${resolved ? "No unit assigned." : "No free units right now."}</div>`;

  const hospitalCard = hospitals.length
    ? hospitals.map((h) => `<div class="hospital-row compact"><img src="assets/hospital.svg" class="hospital-ico" alt="" /><div class="hospital-info"><strong>${escapeHtml(h.name)}</strong><span>${h.distance.toFixed(1)} km${h.phone ? ` &middot; ${escapeHtml(h.phone)}` : ""}</span></div><a class="btn btn-ghost btn-sm" href="${directionsUrl(h.lat, h.lng)}" target="_blank" rel="noopener">Route</a></div>`).join("")
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
        <a href="https://www.google.com/maps?q=${req.lat},${req.lng}" target="_blank" rel="noopener">Open in Google Maps</a>
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
    slot.innerHTML = `<div class="detail-card wide"><h4>Photo evidence</h4><img class="evidence-img" alt="Uploaded evidence photo" /></div>`;
    slot.querySelector("img").src = src;
  };
  if (state.evidenceCache[req.id]) return show(state.evidenceCache[req.id]);
  slot.innerHTML = `<div class="detail-card wide"><h4>Photo evidence</h4><div class="muted">Loading photo...</div></div>`;
  apiFetch(`/api/dispatcher/requests/${encodeURIComponent(req.id)}/evidence`)
    .then((res) => { state.evidenceCache[req.id] = res.evidence_data; show(res.evidence_data); })
    .catch(() => { slot.innerHTML = `<div class="detail-card wide"><div class="muted">Couldn't load the photo.</div></div>`; });
}

function renderFleet(sys) {
  setHtml($("fleet-strip"), sys.ambulances.map((amb) => `
    <div class="unit-mini-card">
      <div class="unit-top"><img src="assets/ambulance.svg" class="mini-ico" alt="" /><strong>${escapeHtml(amb.callsign)}</strong></div>
      <span class="status-pill status-${amb.status === "AVAILABLE" ? "ARRIVED" : amb.status}">${amb.status}</span>
      <div class="inc-sub">${escapeHtml(amb.station_name)}</div>
      ${amb.status === "EN_ROUTE" ? `<div class="text-amber">ETA: <span data-amb-eta="${escapeHtml(amb.id)}"></span></div>` : ""}
    </div>`).join(""));
}

// Fast-changing numbers are patched in place, so the surrounding HTML never has to be rebuilt each tick.
function updateDynamic(sys) {
  const reqById = Object.fromEntries(sys.requests.map((r) => [r.id, r]));
  const ambById = Object.fromEntries(sys.ambulances.map((a) => [a.id, a]));
  document.querySelectorAll("[data-eta]").forEach((el) => {
    const r = reqById[el.dataset.eta];
    const txt = r ? (r.status === "ARRIVED" ? "Arrived" : formatSeconds(r.eta_seconds)) : "";
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
        .bindTooltip(`${amb.callsign}`);
      m._ikey = `amb|${cls}`;
    } else {
      setMarkerPos(m, amb.current_lat, amb.current_lng);
      setMarkerIcon(m, "amb", cls);
    }
  });

  // incidents + routes: add/remove by id, update in place
  const liveIds = new Set();
  sys.requests.forEach((req) => {
    if (req.status === "FALSE_ALARM") return;
    liveIds.add(req.id);
    const cls = `sev-${req.severity}${req.status === "ARRIVED" ? " done" : ""}${req.id === state.selectedIncidentId ? " selected" : ""}`;
    let m = L1.incidents[req.id];
    if (!m) {
      m = L1.incidents[req.id] = L.marker([req.lat, req.lng], { icon: mkIcon("user", cls) })
        .addTo(map)
        .bindTooltip(`${req.patient_name}`)
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
    const path = road ? amb.route : [[amb.current_lat, amb.current_lng], [req.lat, req.lng]];
    const key = road ? `r${amb.route.length}:${amb.route[0][0]}` : "s";
    if (!line) {
      line = L1.routes[req.id] = L.polyline(path, { color: "#ef4444", weight: 5, opacity: 0.85, dashArray: road ? null : "8, 6" }).addTo(map);
      line._rk = key;
    } else if (!road || line._rk !== key) {
      line.setLatLngs(path);
      line._rk = key;
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
    const free = sys.ambulances.filter((a) => a.status === "AVAILABLE").length;
    $("fleet-badge").textContent = `${free}/${sys.ambulances.length} demo units free`;
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

// ---------- Boot ----------
window.addEventListener("DOMContentLoaded", () => {
  const goHome = () => (getSession() ? routeAfterLogin() : setRole("auth"));
  $("nav-home-btn").addEventListener("click", goHome);
  $("switch-role-btn").addEventListener("click", () => { clearSession(); setRole("auth"); });

  setupAuthHandlers();
  setupCustomerHandlers();
  setupDispatcherHandlers();

  if (getSession()) routeAfterLogin();
  else setRole("auth");

  const ping = () => apiFetch("/api/health").then(() => updateConnectionPill(true)).catch(() => updateConnectionPill(false));
  ping();
  state.pollTimer = setInterval(() => {
    if (state.role === "auth") {
      ping();
      if (!state.googleInit) initializeGoogleLogin();
    } else {
      pollSystemState();
      if (!state.hospitals.length && Date.now() - state.hospitalsLoadedAt > 30000) loadHospitals();
    }
  }, 1500);
});
