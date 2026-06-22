# GigGuard — Crash Detection → Ambulance Dispatch

A safety net for gig & delivery riders that fuses three prototypes:

- **BlackBox SOS** — passive crash detection from phone motion sensors + AI injury triage
- **Stitch GigGuard Emergency Response System** — sentinel rider monitor, active SOS tracking,
  responder mesh, and high-density dispatcher response patterns
- **GovGig** — gig-worker registry with a Leaflet/OpenStreetMap dispatch map

The result is one self-contained web app with two roles: a **Driver app** that
auto-detects accidents and a **Dispatch Center** that sends the nearest ambulance.

```
 Driver phone                          Dispatch center
 ┌────────────────────┐                ┌────────────────────────┐
 │ accelerometer + GPS │                │ live incident queue     │
 │   ↓ impact > 2.5G   │                │ map + AI triage         │
 │   ↓ speed drop      │  ── SOS ──▶    │ "Dispatch ambulance"    │
 │ 15s "I'm OK" cancel │   (realtime)   │ animated ETA tracking   │
 │   ↓ auto-send       │  ◀ status ──   │                         │
 └────────────────────┘                └────────────────────────┘
```

## Run it

It's plain HTML/CSS/JS — no build, no backend. Either:

```bash
# option A: just open the file
open index.html

# option B: serve it (recommended, so geolocation/sensors behave)
cd gigworker
python3 -m http.server 8000
# then visit http://localhost:8000
```

> The map tiles and Leaflet come from a CDN, so you need internet access
> (same as the original GovGig prototype).

## Demo flow

1. Open **Driver App** and **Dispatch Center** in two tabs (or two windows) side by side.
2. In the driver tab: **Start monitoring** → **Simulate driving** → **Simulate crash**
   (on a real phone, grant motion access and a hard shake also fires it).
3. A 15-second **"I'm OK"** countdown appears — let it run out (or hit *Send SOS now*).
4. The incident pops up **instantly** in the Dispatch Center with an AI medical assessment.
5. Click **Dispatch nearest ambulance** or **Activate responder mesh** — watch contacts,
   emergency control, nearby services, and the 🚑 response lifecycle update in real time.
6. **Resolve** the incident, or mark the driver **safe** from the phone.

The two views stay in sync via `BroadcastChannel` + `localStorage` — no server needed.

## 🚑 Ambulance fleet & dispatch simulation

The Dispatch Center runs a **12-unit ambulance fleet** stationed across 8 Delhi hospitals
(`HOSPITALS` + `AMBULANCES` in `common.js`), each unit typed **ALS** (trauma) or **BLS** (basic).
Units have a real lifecycle:

```
AVAILABLE → DISPATCHED → ENROUTE → ON_SCENE → RETURNING → AVAILABLE
```

- **Dispatch picks the nearest *available* unit**, preferring ALS for CRITICAL/SERIOUS calls.
  Busy units can't be re-dispatched; the live **fleet roster** (left panel) shows every unit's
  status, type, and current assignment, colour-coded on the map.
- After an incident resolves, its ambulance **drives back to base** and frees up.
- **▶ Simulate** (top bar) runs the whole operation hands-free: it spawns incidents at random
  points across the metro, auto-dispatches the nearest unit, and cycles them through the full
  lifecycle — so you can watch the dispatch board work as a living system. **+ demo** drops a
  single incident for manual dispatch.

## How the pieces map back

| GigGuard | Borrowed from |
|---|---|
| `common.js` crash thresholds (2.5G, 40 km/h drop, 15s cancel) | BlackBox SOS `constants/config.ts`, `CrashDetector.ts` |
| `classify()` AI injury report (severity / injuries / dispatch / priority) | BlackBox SOS `api/classify.js`, `AIClassifier.ts` — same JSON shape |
| Driver sensor loop + cancel countdown | BlackBox SOS `SensorEngine.ts`, `CrashMonitorScreen.tsx` |
| **Black box recorder** (30s rolling buffer, frozen at impact) | BlackBox SOS `SensorEngine.ts` ring buffer + `AccidentReport.last30Seconds` |
| **Live instruments** (G-force history graph, impact compass, X/Y/Z axes, sensitivity) | BlackBox SOS `CrashMonitorScreen.tsx` |
| **Emergency contact mesh, nearby services, bystander guide** | BlackBox SOS `NearbyServices.ts`, `BystanderGuideScreen.tsx`, `emergencyNumbers.ts` |
| **Sentinel rider panels, active SOS cards, responder queue/detail UX** | Stitch GigGuard Emergency Response System HTML prototypes |
| Dispatch detail panel | BlackBox SOS `AmbulanceDashboard.tsx` |
| Leaflet map + dispatch board | GovGig `frontend/`, cdh-main dispatch UI |
| **12-unit fleet + dispatch simulation** | new — extends the GovGig dispatch board into a live operation |

## 🛰️ Emergency response integration

Every SOS now carries a single support packet shared by both tabs:

- rider medical profile: ID, age, blood type, allergies, and known conditions;
- emergency numbers by country, defaulting to India (`112`, `108`, `100`, `101`);
- emergency contacts with queued/notified status;
- nearby hospitals, police, fire, ambulance, pharmacy, towing, and puncture services;
- bystander guidance adapted from BlackBox SOS, including Good Samaritan protection notes.

The driver screen shows a Stitch-style sentinel dashboard with shift duration, GPS lock,
battery status, pulse estimate, a live Leaflet rider map, and a manual SOS trigger. The dispatch
detail view shows responder recommendations, automated SOS transcript, rider health data,
contact mesh status, nearby services, and a persistent AI incident chat panel.

## 📦 The black box

True to the name, GigGuard runs a **flight-recorder buffer**: while monitoring, it logs the
last 30 seconds of `{ g-force, speed, x/y/z accel }` at 10 Hz (`BlackBoxRecorder` in
`common.js`). At the moment of impact the buffer is **frozen** and attached to the incident, so:

- the **driver** sees a live rolling G-force graph, raw accelerometer axes, an impact-vector
  compass, and an adjustable detection-sensitivity selector (1.5G–3.5G) while riding;
- **dispatch** gets a **forensic replay chart** of the 30 s leading up to the crash — the speed
  profile collapsing and the G-force spiking through the threshold — for instant triage.

(If a crash is simulated the instant after arming, a believable lead-up is synthesized via
`synthBlackBox()` so there's always a trace to replay.)

## Files

```
index.html      role picker / landing
driver.html     driver app  (driver.js)
admin.html      dispatch center (admin.js)
common.js       shared engine: Store (cross-tab sync), classifier, geo helpers
styles.css      shared dark theme
```

## Swapping in a real LLM

`classify()` in `common.js` is rule-based but returns the **exact** JSON shape the
BlackBox SOS Groq prompt produces (`severity`, `likely_injuries`, `dispatch`,
`hospital_dept`, `estimated_casualties`, `priority_score`). To use a real model, replace
its body with a `fetch` to your `/api/classify` endpoint — nothing else changes.

## Not production-ready (yet)

- Cross-tab sync is demo-grade; real multi-device needs a backend (WebSocket/Firebase) —
  BlackBox SOS already scaffolds `backend/` + `api/` for this.
- Ambulance routing is a straight-line interpolation, not real road routing.
- No auth, no persistence beyond the browser.
