/* =====================================================================
   GigGuard — shared engine
   Combines BlackBox SOS crash detection + GovGig-style emergency dispatch.
   Used by both the Driver app (driver.html) and the Dispatch Center (admin.html).
   No build step, no backend — the two apps sync in real time across
   browser tabs via BroadcastChannel + localStorage.
   ===================================================================== */

/* ---- Tunables (mirrored from BlackBox SOS constants/config.ts) ---- */
const CONFIG = {
  CRASH_THRESHOLD_G: 2.5,        // net g-force to flag a candidate impact
  SPEED_DROP_THRESHOLD_KMH: 40,  // sudden deceleration that confirms a crash
  SHAKE_THRESHOLD_G: 2.8,        // demo fallback: a hard shake triggers SOS
  DEBOUNCE_MS: 8000,             // ignore repeat triggers within 8s
  CANCEL_COUNTDOWN_SEC: 15,      // false-alarm cancel window before auto-send
  AMBULANCE_SPEED_KMH: 42,       // assumed response speed for ETA / animation
  SEVERITY_COLORS: { CRITICAL: '#dc2626', SERIOUS: '#ea580c', MINOR: '#b45309' },
  EMERGENCY_NUMBER: '112',       // India unified emergency line
  DEFAULT_COUNTRY: 'IN',
  CITY_CENTER: { lat: 28.6139, lng: 77.2090 }, // New Delhi
};

/* ---- Hospital bases (ambulance stations across Delhi) ---- */
const HOSPITALS = [
  { id: 'AIIMS',    name: 'AIIMS Trauma Centre',   lat: 28.5677, lng: 77.2090 },
  { id: 'SAFDAR',   name: 'Safdarjung Hospital',   lat: 28.5687, lng: 77.2065 },
  { id: 'RML',      name: 'RML Hospital',          lat: 28.6258, lng: 77.2010 },
  { id: 'GBPANT',   name: 'GB Pant Hospital',      lat: 28.6396, lng: 77.2410 },
  { id: 'MAXSAKET', name: 'Max Hospital, Saket',   lat: 28.5275, lng: 77.2140 },
  { id: 'LNJP',     name: 'LNJP Hospital',         lat: 28.6395, lng: 77.2335 },
  { id: 'FORTIS',   name: 'Fortis Shalimar Bagh',  lat: 28.7173, lng: 77.1565 },
  { id: 'APOLLO',   name: 'Apollo Sarita Vihar',   lat: 28.5310, lng: 77.2905 },
];
function hospitalById(id) { return HOSPITALS.find((h) => h.id === id); }

/* ---- Ambulance fleet — ALS (trauma) and BLS (basic) units per base ---- */
const AMBULANCES = [
  { id: 'AMB-01', base: 'AIIMS',    type: 'ALS' },
  { id: 'AMB-02', base: 'AIIMS',    type: 'BLS' },
  { id: 'AMB-03', base: 'SAFDAR',   type: 'ALS' },
  { id: 'AMB-04', base: 'SAFDAR',   type: 'BLS' },
  { id: 'AMB-05', base: 'RML',      type: 'ALS' },
  { id: 'AMB-06', base: 'RML',      type: 'BLS' },
  { id: 'AMB-07', base: 'GBPANT',   type: 'ALS' },
  { id: 'AMB-08', base: 'MAXSAKET', type: 'ALS' },
  { id: 'AMB-09', base: 'MAXSAKET', type: 'BLS' },
  { id: 'AMB-10', base: 'LNJP',     type: 'ALS' },
  { id: 'AMB-11', base: 'FORTIS',   type: 'BLS' },
  { id: 'AMB-12', base: 'APOLLO',   type: 'ALS' },
];

/* ---- Emergency numbers (from BlackBox SOS constants/emergencyNumbers.ts) ---- */
const EMERGENCY_NUMBERS = {
  IN: { ambulance: '108', police: '100', fire: '101', unified: '112', name: 'India' },
  US: { ambulance: '911', police: '911', fire: '911', unified: '911', name: 'United States' },
  GB: { ambulance: '999', police: '999', fire: '999', unified: '999', name: 'United Kingdom' },
  AU: { ambulance: '000', police: '000', fire: '000', unified: '000', name: 'Australia' },
  DE: { ambulance: '112', police: '110', fire: '112', unified: '112', name: 'Germany' },
  FR: { ambulance: '15',  police: '17',  fire: '18',  unified: '112', name: 'France' },
  JP: { ambulance: '119', police: '110', fire: '119', unified: '119', name: 'Japan' },
  CN: { ambulance: '120', police: '110', fire: '119', name: 'China' },
  BR: { ambulance: '192', police: '190', fire: '193', unified: '190', name: 'Brazil' },
  ZA: { ambulance: '10177', police: '10111', fire: '10177', unified: '112', name: 'South Africa' },
  NG: { ambulance: '767', police: '199', fire: '767', unified: '112', name: 'Nigeria' },
  PK: { ambulance: '1122', police: '15', fire: '16', unified: '1122', name: 'Pakistan' },
  BD: { ambulance: '999', police: '999', fire: '999', unified: '999', name: 'Bangladesh' },
  SG: { ambulance: '995', police: '999', fire: '995', unified: '995', name: 'Singapore' },
  MY: { ambulance: '999', police: '999', fire: '994', unified: '999', name: 'Malaysia' },
  AE: { ambulance: '998', police: '999', fire: '997', unified: '999', name: 'UAE' },
  SA: { ambulance: '911', police: '911', fire: '911', unified: '911', name: 'Saudi Arabia' },
  KE: { ambulance: '999', police: '999', fire: '999', unified: '112', name: 'Kenya' },
  DEFAULT: { ambulance: '112', police: '112', fire: '112', unified: '112', name: 'International' },
};

function getEmergencyNumbers(countryCode) {
  const key = String(countryCode || CONFIG.DEFAULT_COUNTRY).toUpperCase();
  return EMERGENCY_NUMBERS[key] || EMERGENCY_NUMBERS.DEFAULT;
}

/* ===================================================================
   Store — single source of truth for incidents, shared across tabs.
   =================================================================== */
const Store = (function () {
  const KEY = 'gigguard.incidents.v1';
  const ch = ('BroadcastChannel' in window) ? new BroadcastChannel('gigguard') : null;
  const subs = new Set();

  const read = () => { try { return JSON.parse(localStorage.getItem(KEY) || '[]'); } catch { return []; } };
  const write = (list) => localStorage.setItem(KEY, JSON.stringify(list));
  const notify = (reason) => subs.forEach((fn) => { try { fn(read(), reason); } catch (e) { console.error(e); } });

  if (ch) ch.onmessage = (e) => notify((e.data && e.data.reason) || 'remote');
  window.addEventListener('storage', (e) => { if (e.key === KEY) notify('storage'); });

  return {
    getAll: read,
    get(id) { return read().find((i) => i.id === id); },
    upsert(inc) {
      const list = read();
      const idx = list.findIndex((i) => i.id === inc.id);
      if (idx >= 0) list[idx] = inc; else list.unshift(inc);
      write(list);
      if (ch) ch.postMessage({ reason: 'upsert', id: inc.id });
      notify('upsert');
      return inc;
    },
    remove(id) {
      write(read().filter((i) => i.id !== id));
      if (ch) ch.postMessage({ reason: 'remove', id });
      notify('remove');
    },
    clear() {
      write([]);
      if (ch) ch.postMessage({ reason: 'clear' });
      notify('clear');
    },
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
  };
})();

/* ===================================================================
   Crash classification — rule-based, but shaped exactly like the
   BlackBox SOS LLM output so a real model (like Groq) can drop in.
   =================================================================== */
function classifySeveritySync(gForce) {
  if (gForce >= 4.0) return 'CRITICAL';
  if (gForce >= 2.5) return 'SERIOUS';
  return 'MINOR';
}

function impactDirection(ax, ay) {
  const angle = Math.atan2(ay, ax) * (180 / Math.PI);
  if (angle > -45 && angle <= 45) return 'Right-side';
  if (angle > 45 && angle <= 135) return 'Rear';
  if (angle > 135 || angle <= -135) return 'Left-side';
  return 'Front';
}

function classify(impact) {
  const { gForce, speedBefore, speedAfter, direction } = impact;
  const drop = Math.max(0, (speedBefore || 0) - (speedAfter || 0));

  let severity = classifySeveritySync(gForce);
  if (drop >= 60 && gForce >= 3) severity = 'CRITICAL';

  const INJURIES = {
    CRITICAL: ['Suspected head/neck trauma', 'Internal bleeding risk', 'Possible fractures', 'Loss of consciousness risk'],
    SERIOUS:  ['Whiplash', 'Limb fracture', 'Lacerations', 'Chest contusion'],
    MINOR:    ['Bruising', 'Minor lacerations', 'Soft-tissue strain'],
  };
  const DISPATCH = { CRITICAL: 'Trauma ambulance (ALS)', SERIOUS: 'Basic ambulance (BLS)', MINOR: 'First responder' };
  const DEPT = {
    CRITICAL: ['Emergency / Trauma', 'Neurosurgery', 'Orthopaedics'],
    SERIOUS:  ['Emergency', 'Orthopaedics'],
    MINOR:    ['Emergency / OPD'],
  };

  // priority blends impact force and deceleration into a 0–10 score
  const priority = Math.min(10, (gForce / 8) * 6 + (drop / 100) * 4);

  // a side/front impact at speed tends to involve more occupants
  let casualties = 1;
  if (severity === 'CRITICAL') casualties = drop >= 50 ? 2 : 1;

  return {
    severity,
    likely_injuries: INJURIES[severity].concat(
      direction && direction !== 'Front' ? [`${direction} impact trauma`] : []
    ).slice(0, 4),
    dispatch: DISPATCH[severity],
    hospital_dept: DEPT[severity],
    estimated_casualties: casualties,
    priority_score: Math.round(priority * 10) / 10,
  };
}

/* ===================================================================
   Geo helpers
   =================================================================== */
const Geo = {
  distanceKm(a, b) {
    const R = 6371, toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
    const s = Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
  },
  lerp(a, b, t) { return { lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t }; },
  etaMin(distanceKm, speedKmh = CONFIG.AMBULANCE_SPEED_KMH) { return (distanceKm / speedKmh) * 60; },
  nearest(point, list) {
    return list.map((x) => ({ ...x, _d: Geo.distanceKm(point, x) }))
      .sort((p, q) => p._d - q._d)[0];
  },
};

/* ===================================================================
   Emergency support mesh — nearby services, contacts, medical profile,
   and bystander instructions. This adapts BlackBox SOS NearbyServices
   and BystanderGuide into the zero-backend GigGuard demo.
   =================================================================== */
const SERVICE_META = {
  hospital:          { label: 'Hospital',           icon: 'hospital',  color: '#dc2626' },
  police:            { label: 'Police Station',     icon: 'shield',    color: '#2563eb' },
  ambulance_station: { label: 'Ambulance Station',  icon: 'ambulance', color: '#dc2626' },
  towing:            { label: 'Towing Service',     icon: 'navigation',color: '#ea580c' },
  puncture_shop:     { label: 'Puncture Shop',      icon: 'box',       color: '#ea580c' },
  fire_station:      { label: 'Fire Station',       icon: 'alert-triangle', color: '#dc2626' },
  pharmacy:          { label: 'Pharmacy',           icon: 'plus',      color: '#0d9488' },
};

const STATIC_SERVICE_POINTS = [
  ...HOSPITALS.map((h) => ({
    id: `svc-${h.id}`, name: h.name, category: 'hospital', lat: h.lat, lng: h.lng,
    phone: '108', address: 'Emergency trauma intake',
  })),
  { id: 'svc-police-cp', name: 'Connaught Place Police Station', category: 'police', lat: 28.6329, lng: 77.2195, phone: '100', address: 'Connaught Place' },
  { id: 'svc-police-saket', name: 'Saket Police Station', category: 'police', lat: 28.5247, lng: 77.2110, phone: '100', address: 'Saket District Centre' },
  { id: 'svc-fire-cp', name: 'Connaught Place Fire Station', category: 'fire_station', lat: 28.6294, lng: 77.2177, phone: '101', address: 'Barakhamba Road' },
  { id: 'svc-fire-saket', name: 'Saket Fire Station', category: 'fire_station', lat: 28.5296, lng: 77.2229, phone: '101', address: 'Press Enclave Road' },
  { id: 'svc-tow-aiims', name: 'AIIMS Roadside Recovery', category: 'towing', lat: 28.5658, lng: 77.1993, phone: '+91 98710 44110', address: 'Ring Road corridor' },
  { id: 'svc-tyre-south', name: 'South Delhi Tyre & Puncture', category: 'puncture_shop', lat: 28.5489, lng: 77.2142, phone: '+91 98111 77882', address: 'Green Park extension' },
  { id: 'svc-pharma-aiims', name: '24x7 Trauma Pharmacy', category: 'pharmacy', lat: 28.5684, lng: 77.2109, phone: '+91 98101 24567', address: 'Near AIIMS Trauma Centre' },
  { id: 'svc-pharma-central', name: 'Central Emergency Pharmacy', category: 'pharmacy', lat: 28.6354, lng: 77.2244, phone: '+91 97170 33001', address: 'Minto Road' },
  { id: 'svc-amb-hub', name: 'Delhi CATS Ambulance Hub', category: 'ambulance_station', lat: 28.6126, lng: 77.2295, phone: '102', address: 'Central ambulance command' },
];

function categoryLabel(c) { return (SERVICE_META[c] && SERVICE_META[c].label) || c; }
function categoryIcon(c) { return (SERVICE_META[c] && SERVICE_META[c].icon) || 'map-pin'; }

function distanceLabel(km) {
  if (km == null || Number.isNaN(km)) return '—';
  return km < 1 ? `${Math.round(km * 1000)} m` : `${km.toFixed(1)} km`;
}

function getNearbyServiceMesh(point, limitPerCategory = 3) {
  const loc = point || CONFIG.CITY_CENTER;
  const enriched = STATIC_SERVICE_POINTS
    .map((p) => ({ ...p, distanceKm: Geo.distanceKm(loc, p) }))
    .sort((a, b) => a.distanceKm - b.distanceKm);
  const byCategory = {};
  enriched.forEach((p) => {
    if (!byCategory[p.category]) byCategory[p.category] = [];
    if (byCategory[p.category].length < limitPerCategory) byCategory[p.category].push(p);
  });
  return { all: enriched.slice(0, 12), byCategory };
}

const BYSTANDER_STEPS = [
  "Do not move the rider unless they are in immediate danger.",
  'Check breathing and pulse; keep the airway clear.',
  'Apply firm pressure to any visible bleeding.',
  'Turn off the vehicle and keep bystanders at least 10 metres back.',
  'Keep the rider conscious and talking if possible.',
  'Stay on the line with emergency services until responders arrive.',
];

const DO_NOT_STEPS = [
  'Do not remove the helmet if neck or spine injury is suspected.',
  'Do not give food or water to an unconscious or confused rider.',
  'Do not leave the scene until responders or police take over.',
];

function riderMedicalProfile(driver) {
  const d = driver || {};
  const riderId = d.riderId || `GG-${Math.abs(hashCode(`${d.name || 'rider'}-${d.vehicle || ''}`)).toString().slice(0, 5)}`;
  return {
    riderId,
    age: d.age || '29',
    bloodType: d.bloodType || d.blood || 'O+',
    allergies: d.allergies || 'None reported',
    conditions: d.conditions || 'No major medical history reported',
  };
}

function buildSupportPacket(driver, location, countryCode) {
  const nums = getEmergencyNumbers(countryCode || CONFIG.DEFAULT_COUNTRY);
  const contactPhone = driver && driver.contact ? driver.contact : '';
  return {
    country: nums.name,
    emergencyNumbers: nums,
    medical: riderMedicalProfile(driver),
    contacts: [
      { label: 'Emergency contact', name: (driver && driver.contactName) || 'Primary contact', phone: contactPhone, status: contactPhone ? 'queued' : 'missing', notifiedAt: null },
      { label: 'Ambulance control', name: `${nums.name} ambulance`, phone: nums.ambulance, status: 'queued', notifiedAt: null },
      { label: 'Police control', name: `${nums.name} police`, phone: nums.police, status: 'queued', notifiedAt: null },
    ],
    services: getNearbyServiceMesh(location),
    bystander: {
      law: 'Good Samaritan protection applies in India: help the injured without fear while emergency services respond.',
      steps: BYSTANDER_STEPS.slice(),
      doNot: DO_NOT_STEPS.slice(),
    },
    meshActive: false,
  };
}

function supportForIncident(incident) {
  if (incident && incident.support) return incident.support;
  return buildSupportPacket((incident && incident.driver) || {}, (incident && incident.location) || CONFIG.CITY_CENTER);
}

function activateSupportMesh(incident) {
  if (!incident) return incident;
  const support = supportForIncident(incident);
  const now = Date.now();
  support.contacts = support.contacts.map((c) => c.status === 'missing'
    ? c
    : { ...c, status: 'notified', notifiedAt: c.notifiedAt || now });
  support.meshActive = true;
  support.activatedAt = support.activatedAt || now;
  incident.support = support;
  return incident;
}

function hashCode(s) {
  let h = 0;
  for (let i = 0; i < String(s).length; i++) h = ((h << 5) - h) + String(s).charCodeAt(i) | 0;
  return h;
}

/* ===================================================================
   Misc helpers
   =================================================================== */
const uid = (p = 'crash') => `${p}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

function fmtTime(ts) { return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }); }

function fmtAgo(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}

const STATUS_LABEL = {
  NEW: 'Awaiting dispatch',
  DISPATCHED: 'Ambulance assigned',
  ENROUTE: 'Ambulance en route',
  ARRIVED: 'On scene',
  RESOLVED: 'Resolved',
  CANCELLED: 'Cancelled (false alarm)',
};

/* ===================================================================
   BLACK BOX — a flight-recorder-style rolling buffer of telemetry.
   Continuously records the last N seconds of motion + speed at 10 Hz;
   the buffer is frozen at the moment of impact and attached to the
   incident so dispatch can replay the seconds leading up to the crash.
   (Mirrors BlackBox SOS SensorEngine ring buffer + AccidentReport.last30Seconds)
   =================================================================== */
class BlackBoxRecorder {
  constructor(seconds = 30, hz = 10) {
    this.max = seconds * hz;     // 300 slots = 30s @ 10Hz
    this.buf = [];
  }
  push(s) {                       // s = { t, g, v, ax, ay, az }
    if (this.buf.length >= this.max) this.buf.shift();
    this.buf.push(s);
  }
  snapshot() { return this.buf.slice(); }
  clear() { this.buf = []; }
  get length() { return this.buf.length; }
}

function bbStats(s) {
  if (!s || !s.length) return { peakG: 0, peakIdx: 0, vMax: 0, vStart: 0, duration: 0, impactIdx: 0 };
  let peakG = 0, peakIdx = 0, vMax = 0;
  s.forEach((x, i) => { if (x.g > peakG) { peakG = x.g; peakIdx = i; } if (x.v > vMax) vMax = x.v; });
  return {
    peakG, peakIdx, vMax,
    vStart: s[0].v,
    duration: (s[s.length - 1].t - s[0].t) / 1000,
    impactIdx: peakIdx,
  };
}

/* Build a forensic SVG line chart: G-force + speed over the recording,
   with the crash threshold and the impact moment annotated. */
function renderBlackBoxSVG(samples) {
  const W = 320, H = 120, pad = 8;
  if (!samples || samples.length < 2) {
    return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;"><text x="${W / 2}" y="${H / 2}" fill="#8a93a3" font-size="12" text-anchor="middle">No recording</text></svg>`;
  }
  const n = samples.length;
  const st = bbStats(samples);
  const gMax = Math.max(5, st.peakG * 1.1);
  const vMax = Math.max(10, st.vMax * 1.1);
  const X = (i) => pad + (i / (n - 1)) * (W - 2 * pad);
  const Yg = (g) => H - pad - (g / gMax) * (H - 2 * pad);
  const Yv = (v) => H - pad - (v / vMax) * (H - 2 * pad);
  const gPts = samples.map((s, i) => `${X(i).toFixed(1)},${Yg(s.g).toFixed(1)}`).join(' ');
  const vPts = samples.map((s, i) => `${X(i).toFixed(1)},${Yv(s.v).toFixed(1)}`).join(' ');
  const thrY = Yg(CONFIG.CRASH_THRESHOLD_G).toFixed(1);
  const impX = X(st.impactIdx).toFixed(1);
  const gArea = `${X(0).toFixed(1)},${H - pad} ${gPts} ${X(n - 1).toFixed(1)},${H - pad}`;
  return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;display:block;">
    <defs><linearGradient id="bbgrad" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#dc2626" stop-opacity="0.28"/>
      <stop offset="1" stop-color="#dc2626" stop-opacity="0"/></linearGradient></defs>
    <line x1="${pad}" y1="${thrY}" x2="${W - pad}" y2="${thrY}" stroke="#dc2626" stroke-opacity="0.45" stroke-width="1" stroke-dasharray="4,4"/>
    <polygon points="${gArea}" fill="url(#bbgrad)"/>
    <polyline points="${vPts}" fill="none" stroke="#2563eb" stroke-width="1.5" opacity="0.9"/>
    <polyline points="${gPts}" fill="none" stroke="#dc2626" stroke-width="2"/>
    <line x1="${impX}" y1="${pad}" x2="${impX}" y2="${H - pad}" stroke="#191c1e" stroke-width="1" stroke-dasharray="2,3" opacity="0.5"/>
    <circle cx="${impX}" cy="${Yg(st.peakG).toFixed(1)}" r="3.5" fill="#191c1e" stroke="#dc2626" stroke-width="2"/>
  </svg>`;
}

/* Synthesize a believable 30s lead-up when the live buffer is too short
   (e.g. a demo "Simulate crash" the instant after arming) so the recorder
   always has a meaningful trace to replay. */
function synthBlackBox(speedBefore, gForce) {
  const n = 300, now = Date.now(), out = [];
  const cruise = Math.max(28, speedBefore || 46);
  for (let i = 0; i < n; i++) {
    const phase = i / n;
    const v = cruise * (0.55 + 0.45 * Math.min(1, phase * 1.25)) + Math.sin(i / 6) * 2.2;
    const g = 1 + Math.abs(Math.sin(i / 9)) * 0.14 + (Math.random() - 0.5) * 0.07;
    out.push({ t: now - (n - i) * 100, g: +g.toFixed(3), v: +Math.max(0, v).toFixed(1), ax: 0, ay: 0, az: 9.81 });
  }
  // the impact: G spikes, speed collapses over ~0.3s
  const impactG = Math.max(gForce, 3.5);
  out[n - 3] = { t: now - 200, g: +(impactG * 0.55).toFixed(3), v: cruise, ax: 0, ay: 0, az: 9.81 };
  out[n - 2] = { t: now - 100, g: +impactG.toFixed(3), v: +(cruise * 0.35).toFixed(1), ax: 0, ay: 0, az: 9.81 };
  out[n - 1] = { t: now, g: +(impactG * 0.8).toFixed(3), v: 0, ax: 0, ay: 0, az: 9.81 };
  return out;
}

/* ===================================================================
   GroqAPI — fast OpenAI-compatible inference (Llama 3.3, etc.) via Groq.
   Uses a built-in key from secrets.js (git-ignored) so triage works out
   of the box; a user can still override the key/model in localStorage.
   =================================================================== */
const GroqAPI = (function () {
  const STORAGE_KEY = 'gigguard.groq';
  const API_URL = 'https://api.groq.com/openai/v1/chat/completions';
  const DEFAULT_MODEL = 'llama-3.3-70b-versatile';
  const BUILTIN = (typeof window !== 'undefined' && window.GROQ_BUILTIN_KEY) || '';

  function loadSettings() { try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'); } catch { return {}; } }
  function saveSettings(s) { localStorage.setItem(STORAGE_KEY, JSON.stringify(s)); }
  function getKey() { return loadSettings().apiKey || BUILTIN; }   // built-in key stays out of the UI
  function setKey(k) { const s = loadSettings(); s.apiKey = k; saveSettings(s); }
  function getModel() { return loadSettings().model || DEFAULT_MODEL; }
  function setModel(m) { const s = loadSettings(); s.model = m; saveSettings(s); }
  function isEnabled() { return loadSettings().enabled !== false && (!!getKey() || proxyAvailable()); }
  function setEnabled(v) { const s = loadSettings(); s.enabled = v; saveSettings(s); }
  function hasBuiltin() { return !!BUILTIN; }

  // Serverless proxy that holds the real key server-side. Used whenever no
  // direct key is present (i.e. on the public deployment), so the key never
  // reaches the browser. Configurable via window.GIGGUARD_PROXY_URL so a
  // statically-hosted copy can point at an absolute proxy URL.
  function proxyURL() {
    if (typeof window !== 'undefined' && window.GIGGUARD_PROXY_URL) return window.GIGGUARD_PROXY_URL;
    // GitHub Pages is static and can't host the serverless proxy, so route those
    // origins to the Vercel deployment (which holds the key). CORS allows it.
    if (typeof location !== 'undefined' && /\.github\.io$/.test(location.hostname)) {
      return 'https://gigworker-blond.vercel.app/api/groq';
    }
    return '/api/groq';
  }
  function proxyAvailable() { return typeof location !== 'undefined' && /^https?:$/.test(location.protocol); }

  async function call(systemPrompt, userContent, opts) {
    opts = opts || {};

    const messages = [];
    if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
    if (Array.isArray(userContent)) messages.push(...userContent);
    else messages.push({ role: 'user', content: userContent });

    const body = {
      model: getModel(),
      max_tokens: opts.maxTokens || 1024,
      temperature: opts.temperature != null ? opts.temperature : 0.3,
      messages,
    };
    if (opts.json) body.response_format = { type: 'json_object' };

    // Transport selection:
    //  • a user-supplied key (or local built-in from secrets.js) → call Groq directly
    //  • otherwise → POST to the serverless proxy, which injects the key server-side
    //    so it never reaches the browser.
    const directKey = getKey();
    let url, headers;
    if (directKey) {
      url = API_URL;
      headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${directKey}` };
    } else if (proxyAvailable()) {
      url = proxyURL();
      headers = { 'Content-Type': 'application/json' };
    } else {
      throw new Error('No AI key configured and no proxy available');
    }

    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.text().catch(() => '');
      throw new Error(`AI API ${res.status}: ${err}`);
    }
    const data = await res.json();
    return (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
  }

  async function chat(messages, systemPrompt) { return call(systemPrompt, messages, { maxTokens: 1024 }); }

  async function testConnection() {
    try {
      const r = await call('You are a helpful assistant.', 'Reply with exactly: CONNECTION_OK', { maxTokens: 16, temperature: 0 });
      return r.includes('CONNECTION_OK');
    } catch (e) { return false; }
  }

  return { getKey, setKey, getModel, setModel, isEnabled, setEnabled, call, chat, testConnection, loadSettings, hasBuiltin };
})();

/* ===================================================================
   AI — provider facade. Uses the built-in Groq default so triage always
   works. All higher-level helpers call AI.* instead of a provider.
   =================================================================== */
const AI = (function () {
  function provider() {
    if (GroqAPI.isEnabled()) return GroqAPI;
    return null;
  }
  function name() { const p = provider(); return p === GroqAPI ? 'groq' : null; }
  function displayName() { const n = name(); return n === 'groq' ? 'Groq AI' : null; }
  return {
    provider, name, displayName,
    isEnabled() { return !!provider(); },
    call(s, u, o) { const p = provider(); if (!p) throw new Error('No AI provider'); return p.call(s, u, o); },
    chat(m, s) { const p = provider(); if (!p) throw new Error('No AI provider'); return p.chat(m, s); },
    testConnection() { const p = provider(); return p ? p.testConnection() : Promise.resolve(false); },
  };
})();

/* ===================================================================
   classifyWithAI — async wrapper around the crash classifier.
   If AI is available, sends crash telemetry to the API; otherwise
   falls back silently to the rule-based classify().
   =================================================================== */
const AI_TRIAGE_PROMPT = `You are an AI medical triage system for GigGuard, a crash detection platform for gig/delivery riders.

Analyze the crash telemetry data and return ONLY a valid JSON object (no markdown, no explanation) with this exact schema:
{
  "severity": "CRITICAL" | "SERIOUS" | "MINOR",
  "likely_injuries": ["string", ...],   // 3-4 most likely injuries
  "dispatch": "string",                  // recommended dispatch type
  "hospital_dept": ["string", ...],      // recommended hospital departments
  "estimated_casualties": number,        // typically 1 for single-rider
  "priority_score": number               // 0-10, higher = more urgent
}

Classification guidelines:
- CRITICAL (priority 7-10): >4G impact, >60 km/h speed drop, head-on collision, suspected head/spinal injury
- SERIOUS (priority 4-7): 2.5-4G impact, 30-60 km/h speed drop, limb fractures, internal injury risk
- MINOR (priority 1-4): <2.5G impact, <30 km/h speed drop, bruising, lacerations

Consider the direction of impact, speed profile, and g-force magnitude in your assessment.`;

async function classifyWithAI(impact, blackbox) {
  // Always compute rule-based as fallback
  const fallback = classify(impact);

  if (!AI.isEnabled()) return { ...fallback, _source: 'rule-based' };

  try {
    const bbSummary = blackbox && blackbox.length > 10
      ? `Black box: ${blackbox.length} samples, peak G: ${bbStats(blackbox).peakG.toFixed(1)}, duration: ${Math.round(bbStats(blackbox).duration)}s`
      : 'No black box data available';

    const userMsg = `Crash telemetry:
- Impact force: ${impact.gForce.toFixed(1)}G
- Speed before: ${impact.speedBefore} km/h
- Speed after: ${impact.speedAfter} km/h
- Speed drop: ${Math.max(0, impact.speedBefore - impact.speedAfter)} km/h
- Impact direction: ${impact.direction || 'Unknown'}
- ${bbSummary}`;

    const raw = await AI.call(AI_TRIAGE_PROMPT, userMsg, { maxTokens: 512, json: true });
    // Extract JSON from response (AI may wrap in markdown code fences)
    const jsonStr = raw.replace(/```json?\s*/g, '').replace(/```/g, '').trim();
    const result = JSON.parse(jsonStr);

    // Validate required fields, merge with fallback if incomplete
    return {
      severity: result.severity || fallback.severity,
      likely_injuries: result.likely_injuries || fallback.likely_injuries,
      dispatch: result.dispatch || fallback.dispatch,
      hospital_dept: result.hospital_dept || fallback.hospital_dept,
      estimated_casualties: result.estimated_casualties || fallback.estimated_casualties,
      priority_score: result.priority_score != null ? result.priority_score : fallback.priority_score,
      _source: AI.name(),
    };
  } catch (e) {
    console.warn('AI classification failed, using rule-based fallback:', e.message);
    return { ...fallback, _source: 'rule-based' };
  }
}

/* ===================================================================
   generateIncidentNarrative — AI writes a plain-English summary
   of the crash for dispatch operators.
   =================================================================== */
async function generateIncidentNarrative(incident) {
  if (!AI.isEnabled()) return null;

  const prompt = `You are writing a brief incident summary for emergency dispatch operators. Be concise (2-3 sentences), factual, and use clear emergency-services language.`;

  const userMsg = `Summarize this crash incident:
- Rider: ${incident.driver.name}, vehicle ${incident.driver.vehicle}
- Time: ${new Date(incident.createdAt).toLocaleString()}
- Impact: ${incident.impact.gForce.toFixed(1)}G ${incident.impact.direction} collision
- Speed: ${incident.impact.speedBefore} → ${incident.impact.speedAfter} km/h
- Severity: ${incident.severity}
- AI Assessment: ${incident.ai.likely_injuries.join(', ')}
- Location: ${incident.location.lat.toFixed(4)}, ${incident.location.lng.toFixed(4)}`;

  try {
    return await AI.call(prompt, userMsg, { maxTokens: 256 });
  } catch (e) {
    console.warn('Narrative generation failed:', e.message);
    return null;
  }
}

/* ===================================================================
   generateFirstAidInstructions — AI provides context-specific
   first-aid guidance that dispatch can relay to bystanders.
   =================================================================== */
async function generateFirstAidInstructions(incident) {
  if (!AI.isEnabled()) return null;

  const prompt = `You are a first-aid instruction generator for emergency dispatch. Provide 4-5 brief, numbered first-aid steps that a bystander could follow while waiting for the ambulance. Be clear, simple, and safety-focused. Always include: do not move the patient unless in danger, keep them conscious and talking if possible, and wait for professional help.`;

  const userMsg = `Crash details for first-aid guidance:
- Impact: ${incident.impact.gForce.toFixed(1)}G, ${incident.impact.direction} collision
- Speed drop: ${incident.impact.speedBefore} → ${incident.impact.speedAfter} km/h
- Severity: ${incident.severity}
- Likely injuries: ${incident.ai.likely_injuries.join(', ')}
- Vehicle type: Two-wheeler (motorcycle/scooter)`;

  try {
    return await AI.call(prompt, userMsg, { maxTokens: 384 });
  } catch (e) {
    console.warn('First-aid generation failed:', e.message);
    return null;
  }
}
