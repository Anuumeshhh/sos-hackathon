// switch this URL to your deployed HTTPS backend URL when hosting across two devices
// Served by the backend (http://localhost:8000)? use same origin. Opened from a file or another dev server? talk to :8000.
const API_BASE_URL =
  window.RAPIDAID_API_URL ||
  (location.protocol === "file:" || (location.port && location.port !== "8000")
    ? "http://127.0.0.1:8000"
    : location.origin);

const ITAHARI_CENTER = [26.6646, 87.2718];

const state = {
  role: "auth",
  authMode: "signin",
  googleInit: false,
  selectedLat: ITAHARI_CENTER[0],
  selectedLng: ITAHARI_CENTER[1],
  selectedLocationLabel: "Selected location",
  activeRequestId: localStorage.getItem("active_request_id") || null,
  pollTimer: null,
  customerMap: null,
  customerPin: null,
  customerLiveMap: null,
  customerLiveLayers: [],
  dispatcherMap: null,
  dispatcherLayers: {
    ambulances: {},
    incidents: {},
    routes: {},
  },
};

// ---------- Helpers ----------
function $(id) {
  return document.getElementById(id);
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;",
  }[char]));
}

// ---------- Session ----------
function getSession() {
  try {
    return JSON.parse(sessionStorage.getItem("rapidaid_session") || "null");
  } catch (_) {
    return null;
  }
}
function saveSession(res) {
  sessionStorage.setItem(
    "rapidaid_session",
    JSON.stringify({ token: res.access_token, role: res.role, name: res.name, email: res.email })
  );
}
function clearSession() {
  sessionStorage.removeItem("rapidaid_session");
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
  const pill = $("connection-pill");
  if (online) {
    pill.textContent = "Server Live";
    pill.className = "conn-pill conn-online";
  } else {
    pill.textContent = "Backend Offline";
    pill.className = "conn-pill conn-offline";
  }
}

function formatSeconds(sec) {
  if (sec === null || sec === undefined) return "Pending";
  if (sec <= 0) return "Arrived on Scene";
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

// ---------- Role Routing ----------
function setRole(role) {
  const session = getSession();
  // The dispatcher dashboard is only reachable with a dispatcher session.
  if (role === "dispatcher" && !(session && session.role === "dispatcher")) role = "auth";
  state.role = role;
  $("screen-auth").classList.toggle("hidden", role !== "auth");
  $("screen-customer").classList.toggle("hidden", role !== "customer");
  $("screen-dispatcher").classList.toggle("hidden", role !== "dispatcher");
  updateTopbar();

  if (role === "customer") {
    initCustomerMap();
    if (session && session.name && !$("patient-name").value) $("patient-name").value = session.name;
    if (state.activeRequestId) showCustomerTracker();
  } else if (role === "dispatcher") {
    $("active-station-name").textContent = "Itahari Central Dispatch";
    initDispatcherMap();
  }
  pollSystemState();
}

function routeAfterLogin() {
  const session = getSession();
  setRole(session && session.role === "dispatcher" ? "dispatcher" : "customer");
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
  chip.classList.remove("hidden");
  chip.textContent = session ? (session.role === "dispatcher" ? "Dispatcher" : session.name || session.email) : "Guest";
  chip.classList.toggle("chip-dispatcher", !!session && session.role === "dispatcher");
  btn.classList.remove("hidden");
  btn.textContent = session ? "Sign out" : "Sign in";
}

// ---------- Customer Map & Form ----------
function initCustomerMap() {
  if (state.customerMap) {
    setTimeout(() => state.customerMap.invalidateSize(), 120);
    return;
  }

  state.customerMap = L.map("customer-map").setView(ITAHARI_CENTER, 14);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: "&copy; OpenStreetMap contributors",
  }).addTo(state.customerMap);

  const sosIcon = L.divIcon({
    className: "",
    html: `<div class="marker-sos">SOS</div>`,
    iconSize: [28, 28],
    iconAnchor: [14, 14],
  });

  state.customerPin = L.marker(ITAHARI_CENTER, {
    draggable: true,
    icon: sosIcon,
  }).addTo(state.customerMap);

  state.customerPin.on("dragend", () => {
    const pos = state.customerPin.getLatLng();
    setCustomerCoords(pos.lat, pos.lng, "Custom Pinned Location");
  });

  state.customerMap.on("click", (e) => {
    setCustomerCoords(e.latlng.lat, e.latlng.lng, "Manually selected location");
  });
  requestBrowserLocation(false);
}

function setCustomerCoords(lat, lng, label) {
  state.selectedLat = Number(lat.toFixed(5));
  state.selectedLng = Number(lng.toFixed(5));
  state.selectedLocationLabel = label;

  $("coord-readout").textContent = `${state.selectedLat}, ${state.selectedLng} (${label})`;
  if (state.customerPin) {
    state.customerPin.setLatLng([state.selectedLat, state.selectedLng]);
  }
  if (state.customerMap) {
    state.customerMap.panTo([state.selectedLat, state.selectedLng]);
  }
}

function requestBrowserLocation(showErrors = true) {
  if (!navigator.geolocation) {
    if (showErrors) alert("This browser does not support location. Tap the map to choose manually.");
    return;
  }
  navigator.geolocation.getCurrentPosition(
    (position) => setCustomerCoords(position.coords.latitude, position.coords.longitude, "GPS location"),
    () => {
      if (showErrors) alert("Location permission was denied or unavailable. Please tap the map to pin the location.");
    },
    { enableHighAccuracy: true, timeout: 12000, maximumAge: 15000 }
  );
}

function setupCustomerHandlers() {
  $("btn-use-location").addEventListener("click", () => requestBrowserLocation(true));
  $("emergency-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const errBox = $("customer-error-box");
    errBox.classList.add("hidden");
    const name = $("patient-name").value.trim();
    const phone = $("patient-phone").value.trim();
    const description = $("injury-description").value.trim();
    if (name.length < 2) return showCustomerError("Please enter the patient or caller name.");
    if (!/^[0-9+\-\s]{7,18}$/.test(phone)) return showCustomerError("Please enter a valid callback phone number.");
    if (description.length < 5) return showCustomerError("Please describe the injury or medical emergency.");
    if (!Number.isFinite(state.selectedLat) || !Number.isFinite(state.selectedLng)) return showCustomerError("Please select the emergency location on the map.");
    await submitEmergencyPayload();
  });
  $("btn-new-request").addEventListener("click", () => {
    state.activeRequestId = null;
    localStorage.removeItem("active_request_id");
    $("customer-tracker-card").classList.add("hidden");
    $("customer-form-card").classList.remove("hidden");
    $("emergency-form").reset();
    initCustomerMap();
  });
}

function showCustomerError(message) {
  const box = $("customer-error-box");
  box.textContent = message;
  box.classList.remove("hidden");
}

async function submitEmergencyPayload() {
  const errBox = $("customer-error-box");
  const submitBtn = $("btn-submit-emergency");
  submitBtn.disabled = true;
  submitBtn.textContent = "Sending Emergency Alert...";

  let evidenceData = null;
  const file = $("evidence-photo").files[0];
  if (file) {
    if (!file.type.startsWith("image/")) {
      showCustomerError("Please select an image file.");
      submitBtn.disabled = false;
      submitBtn.textContent = "DISPATCH EMERGENCY AMBULANCE";
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      showCustomerError("Photo must be 5 MB or smaller.");
      submitBtn.disabled = false;
      submitBtn.textContent = "DISPATCH EMERGENCY AMBULANCE";
      return;
    }
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
    const created = await apiFetch("/api/requests", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    state.activeRequestId = created.id;
    localStorage.setItem("active_request_id", created.id);
    showCustomerTracker();
    renderCustomerTracker(created, []);
  } catch (err) {
    errBox.textContent = err.message;
    errBox.classList.remove("hidden");
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = "DISPATCH EMERGENCY AMBULANCE";
  }
}

function showCustomerTracker() {
  $("customer-form-card").classList.add("hidden");
  $("customer-tracker-card").classList.remove("hidden");

  if (!state.customerLiveMap) {
    state.customerLiveMap = L.map("customer-live-map").setView(ITAHARI_CENTER, 14);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: "&copy; OpenStreetMap",
    }).addTo(state.customerLiveMap);
  }
  setTimeout(() => state.customerLiveMap.invalidateSize(), 120);
}

function renderCustomerTracker(req, ambulances) {
  if (!req) return;

  $("track-req-id").textContent = req.id.toUpperCase();
  const badge = $("track-status-badge");
  badge.textContent = req.status.replace("_", " ");
  badge.className = `status-pill status-${req.status}`;

  $("track-eta-display").textContent =
    req.status === "EN_ROUTE"
      ? formatSeconds(req.eta_seconds)
      : req.status === "ARRIVED"
      ? "Arrived on Scene"
      : req.status === "FALSE_ALARM"
      ? "Dismissed by Dispatch"
      : "Awaiting Unit Assignment";

  $("track-unit-display").textContent = req.assigned_callsign || "Matching Nearest Unit...";
  $("track-patient").textContent = req.patient_name;
  $("track-phone").textContent = req.phone;
  $("track-severity").textContent = req.status === "PENDING" ? "Awaiting dispatcher assessment" : req.severity;
  $("track-injuries").textContent = req.injury_details.join(", ");
  $("track-location").textContent = `${req.location_label} (${req.lat}, ${req.lng})`;

  // highlight progress steps
  const order = ["PENDING", "VERIFIED", "EN_ROUTE", "ARRIVED"];
  const currentIdx = order.indexOf(req.status === "ASSIGNED" ? "EN_ROUTE" : req.status);
  document.querySelectorAll("#customer-tracker-card .step-item").forEach((el) => {
    const idx = order.indexOf(el.dataset.step);
    el.classList.toggle("active", currentIdx >= idx && currentIdx !== -1);
  });

  // update customer live mini-map
  if (state.customerLiveMap) {
    state.customerLiveLayers.forEach((layer) => state.customerLiveMap.removeLayer(layer));
    state.customerLiveLayers = [];

    const patientMarker = L.marker([req.lat, req.lng], {
      icon: L.divIcon({
        className: "",
        html: `<div class="marker-sos">SOS</div>`,
        iconSize: [28, 28],
        iconAnchor: [14, 14],
      }),
    }).addTo(state.customerLiveMap);
    state.customerLiveLayers.push(patientMarker);

    const assignedAmb = ambulances.find((a) => a.id === req.assigned_ambulance_id);
    if (assignedAmb) {
      const ambMarker = L.marker([assignedAmb.current_lat, assignedAmb.current_lng], {
        icon: L.divIcon({
          className: "",
          html: `<div class="marker-amb en-route">AMB</div>`,
          iconSize: [30, 30],
          iconAnchor: [15, 15],
        }),
      }).addTo(state.customerLiveMap);

      const line = L.polyline(
        [
          [assignedAmb.current_lat, assignedAmb.current_lng],
          [req.lat, req.lng],
        ],
        { color: "#3b82f6", weight: 4, dashArray: "6, 6" }
      ).addTo(state.customerLiveMap);

      state.customerLiveLayers.push(ambMarker, line);
      state.customerLiveMap.fitBounds(line.getBounds(), { padding: [30, 30] });
    } else {
      state.customerLiveMap.setView([req.lat, req.lng], 15);
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

async function initializeGoogleLogin() {
  if (state.googleLoading) return;
  state.googleLoading = true;
  try {
    await setupGoogle();
  } finally {
    state.googleLoading = false;
  }
}

async function setupGoogle() {
  const fallback = $("btn-google-fallback");
  fallback.onclick = () =>
    showAuthError("Google sign-in isn't set up yet. Add GOOGLE_CLIENT_ID to the .env file and restart the server. You can use email & password for now.");

  let config;
  try {
    config = await apiFetch("/api/auth/config");
  } catch (_) {
    return; // backend offline: retried automatically once it is reachable
  }
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
          const result = await apiFetch("/api/auth/google", {
            method: "POST",
            body: JSON.stringify({ credential: response.credential }),
          });
          saveSession(result);
          routeAfterLogin();
        } catch (err) {
          showAuthError(err.message);
        }
      },
    });
    window.google.accounts.id.renderButton($("google-signin-button"), { theme: "filled_black", size: "large", text: "continue_with", shape: "pill", width: 320 });
    fallback.classList.add("hidden"); // real Google button replaces the placeholder
  };
  document.head.appendChild(script);
}

function setupAuthHandlers() {
  $("tab-signin").addEventListener("click", () => setAuthMode("signin"));
  $("tab-register").addEventListener("click", () => setAuthMode("register"));

  $("auth-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    $("auth-error").classList.add("hidden");
    const email = $("auth-email").value.trim();
    const password = $("auth-password").value;
    const name = $("auth-name").value.trim();
    if (!email || !password) return showAuthError("Please enter your email and password.");
    const register = state.authMode === "register";
    if (register && name.length < 2) return showAuthError("Please enter your full name.");

    const btn = $("btn-auth-submit");
    btn.disabled = true;
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
    }
  });

  $("btn-guest").addEventListener("click", () => {
    clearSession();
    setRole("customer");
  });

  initializeGoogleLogin();
}

function setupDispatcherHandlers() {
  $("btn-reset-demo").addEventListener("click", async () => {
    try {
      const fresh = await apiFetch("/api/reset", { method: "POST" });
      renderSystemState({ ...fresh, requests: fresh.requests });
    } catch (err) {
      alert("Reset failed: " + err.message);
    }
  });
  $("lightbox").addEventListener("click", () => $("lightbox").classList.add("hidden"));
}

async function viewEvidence(requestId) {
  try {
    const res = await apiFetch(`/api/dispatcher/requests/${encodeURIComponent(requestId)}/evidence`);
    $("lightbox-img").src = res.evidence_data;
    $("lightbox").classList.remove("hidden");
  } catch (err) {
    alert(err.message);
  }
}

function initDispatcherMap() {
  if (state.dispatcherMap) {
    setTimeout(() => state.dispatcherMap.invalidateSize(), 120);
    return;
  }

  state.dispatcherMap = L.map("dispatcher-map").setView(ITAHARI_CENTER, 13);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: "&copy; OpenStreetMap contributors",
  }).addTo(state.dispatcherMap);
}

async function handleTriage(requestId, action, severity = null) {
  try {
    await apiFetch("/api/triage", {
      method: "POST",
      body: JSON.stringify({ request_id: requestId, action, severity }),
    });
    pollSystemState();
  } catch (err) {
    alert(err.message);
  }
}

async function handleAssign(requestId, ambulanceId = null) {
  try {
    await apiFetch("/api/assign", {
      method: "POST",
      body: JSON.stringify({ request_id: requestId, ambulance_id: ambulanceId }),
    });
    pollSystemState();
  } catch (err) {
    alert(err.message);
  }
}

// The queue is re-rendered on every poll. Without this guard it closed the unit/severity
// dropdowns while the dispatcher was choosing and reset their values.
function setQueueHtml(listEl, html) {
  const active = document.activeElement;
  if (active && active.tagName === "SELECT" && listEl.contains(active)) return;
  if (listEl.dataset.html === html) return;
  const saved = {};
  listEl.querySelectorAll("select").forEach((el) => { if (el.id) saved[el.id] = el.value; });
  const scrollTop = listEl.scrollTop;
  listEl.innerHTML = html;
  listEl.dataset.html = html;
  listEl.querySelectorAll("select").forEach((el) => {
    if (saved[el.id] && [...el.options].some((o) => o.value === saved[el.id])) el.value = saved[el.id];
  });
  listEl.scrollTop = scrollTop;
}

function renderDispatcherView(sys) {
  const availableUnits = sys.ambulances.filter((a) => a.status === "AVAILABLE");
  const enRouteUnits = sys.ambulances.filter((a) => a.status === "EN_ROUTE");
  const activeIncidents = sys.requests.filter(
    (r) => r.status !== "ARRIVED" && r.status !== "FALSE_ALARM"
  );

  $("stat-available").textContent = availableUnits.length;
  if ($("public-available-count")) $("public-available-count").textContent = availableUnits.length;
  if ($("public-fleet-list")) {
    $("public-fleet-list").innerHTML = sys.ambulances.map((unit) => `<span class="fleet-chip"><strong>${escapeHtml(unit.callsign)}</strong> · ${escapeHtml(unit.status)}</span>`).join("");
  }
  $("stat-enroute").textContent = enRouteUnits.length;
  $("stat-active").textContent = activeIncidents.length;
  $("queue-count-badge").textContent = activeIncidents.length;

  // render incident cards
  const listEl = $("incident-queue-list");
  if (sys.requests.length === 0) {
    listEl.dataset.html = "";
    listEl.innerHTML = `<div class="empty-state">No active emergency requests. Waiting for incoming alerts...</div>`;
  } else {
    const html = sys.requests
      .map((req) => {
        const isResolved = req.status === "ARRIVED" || req.status === "FALSE_ALARM";
        const canDispatch = req.status === "PENDING" || req.status === "VERIFIED";

        const unitOptions = availableUnits
          .map((u) => `<option value="${escapeHtml(u.id)}">${escapeHtml(u.callsign)}</option>`)
          .join("");

        return `
          <div class="inc-card sev-border-${req.severity} ${isResolved ? "is-resolved" : ""}">
            <div class="inc-top">
              <div>
                <span class="sev-tag sev-tag-${req.severity}">${req.severity}</span>
                <span class="status-pill status-${req.status}">${req.status.replace("_", " ")}</span>
              </div>
              ${req.is_duplicate ? `<span class="dup-tag" title="${escapeHtml(req.duplicate_reason)}">POSSIBLE DUPLICATE</span>` : ""}
            </div>

            <div>
              <div class="inc-patient">${escapeHtml(req.patient_name)} &bull; ${escapeHtml(req.phone)}</div>
              <div class="inc-sub">${escapeHtml(req.location_label)} (${req.lat}, ${req.lng})</div>
              <div class="inc-sub"><strong>Caller report:</strong> ${escapeHtml(req.injury_details.join(", "))}</div>
              ${req.has_evidence ? `<div class="inc-sub"><button class="btn btn-secondary btn-sm" onclick="viewEvidence('${req.id}')">View photo evidence</button></div>` : ""}
              ${
                req.is_duplicate
                  ? `<div class="inc-sub text-red"><strong>Alert:</strong> ${escapeHtml(req.duplicate_reason)}</div>`
                  : ""
              }
              ${
                canDispatch && req.nearest_unit_callsign
                  ? `<div class="inc-sub text-green">Nearest: ${escapeHtml(req.nearest_unit_callsign)} (${req.nearest_distance_km} km)</div>`
                  : ""
              }
              ${
                req.assigned_callsign
                  ? `<div class="inc-sub"><strong>Unit:</strong> ${escapeHtml(req.assigned_callsign)} (${formatSeconds(req.eta_seconds)})</div>`
                  : ""
              }
            </div>

            ${
              !isResolved
                ? `<div class="inc-actions">
                    <div class="assign-row">
                      ${req.status === "PENDING" ? `<select id="severity-${req.id}" aria-label="Dispatcher-assessed severity"><option value="CRITICAL">Critical</option><option value="URGENT">Urgent</option><option value="STANDARD" selected>Standard</option></select><button class="btn btn-primary btn-sm" onclick="handleTriage('${req.id}', 'VERIFY', document.getElementById('severity-${req.id}').value)">Verify &amp; Set Severity</button>` : ""}
                      <button class="btn btn-ghost btn-sm" onclick="handleTriage('${req.id}', 'FALSE_ALARM')">Dismiss / False Alarm</button>
                    </div>
                    ${
                      canDispatch
                        ? `<button class="btn btn-danger btn-sm full-width" ${availableUnits.length === 0 ? "disabled" : ""} onclick="handleAssign('${req.id}', null)">
                            Assign Nearest Unit ${req.nearest_distance_km !== null ? `(${req.nearest_distance_km} km)` : ""}
                          </button>
                          <div class="assign-row">
                            <select id="select-unit-${req.id}">
                              ${unitOptions || `<option value="">No units free</option>`}
                            </select>
                            <button class="btn btn-secondary btn-sm" ${availableUnits.length === 0 ? "disabled" : ""} onclick="handleAssign('${req.id}', document.getElementById('select-unit-${req.id}').value)">
                              Assign Selected
                            </button>
                          </div>`
                        : ""
                    }
                  </div>`
                : ""
            }
          </div>
        `;
      })
      .join("");
    setQueueHtml(listEl, html);
  }

  // render bottom fleet strip
  $("fleet-strip").innerHTML = sys.ambulances
    .map(
      (amb) => `
      <div class="unit-mini-card">
        <strong>${amb.callsign}</strong>
        <span class="status-pill status-${amb.status === "AVAILABLE" ? "ARRIVED" : amb.status}">${amb.status}</span>
        <div class="inc-sub">${amb.station_name}</div>
        ${amb.status === "EN_ROUTE" ? `<div class="text-amber">ETA: ${formatSeconds(amb.eta_seconds)}</div>` : ""}
      </div>
    `
    )
    .join("");

  updateDispatcherMap(sys);
}

function updateDispatcherMap(sys) {
  if (!state.dispatcherMap) return;

  const layers = state.dispatcherLayers;

  // 1. Update or create ambulance markers
  sys.ambulances.forEach((amb) => {
    const statusClass = amb.status === "EN_ROUTE" ? "en-route" : amb.status === "ARRIVED" ? "arrived" : "";
    const shortCode = amb.id.toUpperCase().replace("AMB-", "A");
    const icon = L.divIcon({
      className: "",
      html: `<div class="marker-amb ${statusClass}">${shortCode}</div>`,
      iconSize: [30, 30],
      iconAnchor: [15, 15],
    });

    if (layers.ambulances[amb.id]) {
      layers.ambulances[amb.id].setLatLng([amb.current_lat, amb.current_lng]);
      layers.ambulances[amb.id].setIcon(icon);
    } else {
      layers.ambulances[amb.id] = L.marker([amb.current_lat, amb.current_lng], { icon })
        .addTo(state.dispatcherMap)
        .bindPopup(`<strong>${amb.callsign}</strong><br>${amb.station_name}`);
    }
  });

  // 2. Clear old incident markers & route lines, then redraw active ones
  Object.values(layers.incidents).forEach((m) => state.dispatcherMap.removeLayer(m));
  Object.values(layers.routes).forEach((l) => state.dispatcherMap.removeLayer(l));
  layers.incidents = {};
  layers.routes = {};

  sys.requests.forEach((req) => {
    if (req.status === "FALSE_ALARM") return;

    const sosIcon = L.divIcon({
      className: "",
      html: `<div class="marker-sos">SOS</div>`,
      iconSize: [28, 28],
      iconAnchor: [14, 14],
    });

    layers.incidents[req.id] = L.marker([req.lat, req.lng], { icon: sosIcon })
      .addTo(state.dispatcherMap)
      .bindPopup(`<strong>${escapeHtml(req.patient_name)}</strong> (${escapeHtml(req.severity)})<br>${escapeHtml(req.location_label)}`);

    if (req.assigned_ambulance_id && req.status === "EN_ROUTE") {
      const amb = sys.ambulances.find((a) => a.id === req.assigned_ambulance_id);
      if (amb) {
        layers.routes[req.id] = L.polyline(
          [
            [amb.current_lat, amb.current_lng],
            [req.lat, req.lng],
          ],
          { color: "#ef4444", weight: 4, dashArray: "8, 6" }
        ).addTo(state.dispatcherMap);
      }
    }
  });
}

// ---------- Polling Loop ----------
function resetCustomerTicket() {
  state.activeRequestId = null;
  localStorage.removeItem("active_request_id");
  $("customer-tracker-card").classList.add("hidden");
  $("customer-form-card").classList.remove("hidden");
}

function renderSystemState(sys) {
  if (state.role === "dispatcher") renderDispatcherView(sys);
  else if (state.role === "customer") {
    if ($("public-available-count")) {
      $("public-available-count").textContent = sys.ambulances.filter((a) => a.status === "AVAILABLE").length;
      $("public-fleet-list").innerHTML = sys.ambulances
        .map((u) => `<span class="fleet-chip"><strong>${escapeHtml(u.callsign)}</strong> &middot; ${escapeHtml(u.status)}</span>`)
        .join("");
    }
  }
}

let polling = false;
async function pollSystemState() {
  if (polling || state.role === "auth") {
    if (state.role === "auth" && !state.googleInit) initializeGoogleLogin();
    return;
  }
  polling = true;
  try {
    const endpoint = state.role === "dispatcher" ? "/api/dispatcher/state" : "/api/state";
    const sys = await apiFetch(endpoint);
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
  } catch (err) {
    updateConnectionPill(false);
  } finally {
    polling = false;
  }
}

// ---------- Boot ----------
window.addEventListener("DOMContentLoaded", () => {
  const goHome = () => {
    if (getSession()) routeAfterLogin();
    else setRole("auth");
  };
  $("nav-home-btn").addEventListener("click", goHome);
  $("switch-role-btn").addEventListener("click", () => {
    clearSession();
    setRole("auth");
  });

  setupAuthHandlers();
  setupCustomerHandlers();
  setupDispatcherHandlers();

  // Returning visitors skip the start menu.
  const session = getSession();
  if (session) routeAfterLogin();
  else setRole("auth");

  // Connection pill works even on the start screen.
  apiFetch("/api/health").then(() => updateConnectionPill(true)).catch(() => updateConnectionPill(false));
  state.pollTimer = setInterval(() => {
    if (state.role === "auth") {
      apiFetch("/api/health").then(() => updateConnectionPill(true)).catch(() => updateConnectionPill(false));
      if (!state.googleInit) initializeGoogleLogin();
    } else pollSystemState();
  }, 1500);
});
