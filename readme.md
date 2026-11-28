# RapidAid — Real-Time Emergency Ambulance Dispatch

RapidAid is a real-time emergency ambulance dispatch web application built for the **Itahari–Dharan–Biratnagar** corridor. It connects callers reporting medical emergencies with a dispatcher who verifies incidents, flags duplicates or false alarms, and routes ambulances toward callers and nearby hospitals.

---

## Features

- **Caller Emergency Reporting & Live Tracking**:
  - Interactive Leaflet map with browser geolocation, draggable incident pin, and quick-jump landmarks around Itahari.
  - Injury preset chips, injury confirmation requirement, callback phone validation, optional photo attachment, and a 15-second per-phone cooldown.
  - Shareable `?track=INC-...` tracking link and a 4-step live status tracker (**Submitted → Verified → En Route → Arrived**).
- **Dispatcher Control Room**:
  - Filterable and searchable incident queue (`All`, `Pending`, `Critical`, `En Route`, `Completed`) with keyboard navigation (`ArrowUp`, `ArrowDown`, `Escape`).
  - Duplicate detection (same phone number or pins within 150 m of an active incident) and false-alarm recall.
  - Live fleet map showing 7 ambulances (`amb-01` through `amb-07`), route progression, and nearest-hospital routing.
  - Optional synthesized alert chimes (`Sfx`) and photo lightbox inspection.
- **Real Hospital & Road Routing Data**:
  - Queries OpenStreetMap's Overpass API for hospitals within 25 km of Itahari (`26.6646, 87.2718`) with a 24-hour local cache (`hospitals_cache.json`).
  - Uses OSRM for road geometry with a straight-line Haversine fallback when offline.
- **Bilingual Interface**:
  - Switch between English (`EN`) and Nepali (`नेपाली`) directly in the UI.

---

## Tech Stack

- **Backend**: Python, FastAPI, Uvicorn, Pydantic, SQLite
- **Frontend**: Vanilla HTML5, CSS3, JavaScript, Leaflet, Google Fonts (`Merriweather`, `Source Sans 3`, `IBM Plex Mono`)
- **External Data / Routing**: OpenStreetMap Overpass API, OSRM

---

## Project Structure

```text
.
├── backend/
│   ├── main.py          # FastAPI app, REST endpoints, auth & 1.5s asyncio simulation loop
│   ├── dispatch.py      # DispatchManager state machine, routing, duplicate checks & SQLite state
│   ├── auth.py          # PBKDF2 password hashing, UserStore & HMAC-SHA256 bearer tokens
│   ├── hospitals.py     # Overpass API hospital fetcher + 24h cache
│   └── models.py        # Pydantic schemas & status/severity enums
└── frontend/
    ├── index.html       # Single-page UI (Auth, Caller, Dispatcher screens + Lightbox)
    ├── app.js           # Map logic, polling, session scoping, i18n & UI state
    └── styles.css       # Light/dark themes, layout & responsive styling
```

---

## Local Setup & Running

1. **Create and activate a virtual environment**:
   ```bash
   python -m venv .venv
   # Windows
   .venv\Scripts\activate
   # macOS / Linux
   source .venv/bin/activate
   ```

2. **Install dependencies**:
   ```bash
   pip install -r requirements.txt
   ```

3. **Start the server**:
   ```bash
   uvicorn backend.main:app --host 0.0.0.0 --port 8000 --reload
   ```

4. **Open in browser**:
   Visit `http://localhost:8000`.

---

## Environment Variables

Configure these in a `.env` file or your hosting platform's environment settings before deploying:

- Dispatcher login credentials (default demo credentials in `auth.py`: `admin` / `admin123` — change these for any shared or live deployment).
- Any token signing secret or port variable expected by your deployment environment (`$PORT` / `$SERVER_PORT`).

---

## API Overview

- **Auth**: `POST /api/auth/login`, `POST /api/auth/register`
- **Caller & Public**:
  - `GET /api/state` — Public ambulance positions
  - `POST /api/requests` — Submit a new emergency request
  - `GET /api/requests/{id}` — Track a specific incident by ID
  - `GET /api/hospitals` — Cached nearby hospitals
- **Dispatcher (Bearer Token Required)**:
  - `GET /api/dispatcher/state` — Active incidents and fleet state
  - `GET /api/dispatcher/requests/{id}/evidence` — Fetch attached incident photo
  - `POST /api/triage` — Mark incident `VERIFIED` or `FALSE_ALARM`
  - `POST /api/assign` — Dispatch an ambulance to an incident
  - `POST /api/reset` — Reset simulation state

  