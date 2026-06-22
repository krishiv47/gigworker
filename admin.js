/* =====================================================================
   GigGuard — Dispatch Center logic
   Live incident feed + Leaflet map + AI triage + a simulated ambulance
   fleet. Owns the fleet simulation (units move between AVAILABLE →
   DISPATCHED → ENROUTE → ON_SCENE → RETURNING) and pushes ambulance
   position/ETA back to the Store so the driver's phone sees it live.
   ===================================================================== */
(function () {
  const $ = (id) => document.getElementById(id);
  let selectedId = null;
  let soundOn = true;
  let simOn = false;
  const seenIds = new Set();          // for new-incident flash/alert
  let chatLoadedId = null;

  /* ---------- map ---------- */
  const map = L.map('map', { zoomControl: true, attributionControl: false }).setView(
    [CONFIG.CITY_CENTER.lat, CONFIG.CITY_CENTER.lng], 11);
  L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', { maxZoom: 19, keepBuffer: 6 }).addTo(map);
  // recompute size several times — the grid can finish laying out after Leaflet's first measure
  map.whenReady(() => map.invalidateSize());
  [100, 350, 800, 1500].forEach((ms) => setTimeout(() => map.invalidateSize(), ms));
  window.addEventListener('load', () => map.invalidateSize());
  window.addEventListener('resize', () => map.invalidateSize());

  function emojiIcon(name, color, size = 34) {
    return L.divIcon({
      className: '', iconSize: [size, size], iconAnchor: [size / 2, size / 2],
      html: `<div style="width:${size}px;height:${size}px;display:grid;place-items:center;color:${color};
             background:#fff;border:2px solid ${color};border-radius:50%;box-shadow:0 3px 8px rgba(80,95,120,.35);">${icon(name, { size: Math.round(size * 0.55) })}</div>`,
    });
  }

  // hospital base markers
  HOSPITALS.forEach((h) => {
    L.marker([h.lat, h.lng], { icon: emojiIcon('hospital', '#5b6472', 26) })
      .addTo(map).bindTooltip(h.name, { direction: 'top' });
  });

  const incidentMarkers = {};   // id -> marker
  const fleetMarkers = {};      // unit id -> marker
  const routeLines = {};        // incident id -> polyline
  const unitTimers = {};        // unit id -> animation interval

  /* ===================================================================
     Fleet — runtime simulation of the ambulance units.
     =================================================================== */
  const UNIT_COLOR = { AVAILABLE: '#0d9488', DISPATCHED: '#ea580c', ENROUTE: '#ea580c', ON_SCENE: '#dc2626', RETURNING: '#2563eb' };

  const Fleet = {
    units: AMBULANCES.map((a) => {
      const b = hospitalById(a.base);
      return { id: a.id, type: a.type, hospital: b.name, baseId: b.id, baseLat: b.lat, baseLng: b.lng,
               lat: b.lat, lng: b.lng, status: 'AVAILABLE', incidentId: null };
    }),
    byId(id) { return this.units.find((u) => u.id === id); },
    countAvailable() { return this.units.filter((u) => u.status === 'AVAILABLE').length; },
    nearestAvailable(point, preferType) {
      const avail = this.units.filter((u) => u.status === 'AVAILABLE');
      if (!avail.length) return null;
      const pref = preferType ? avail.filter((u) => u.type === preferType) : [];
      const pool = pref.length ? pref : avail;
      return pool.map((u) => ({ u, d: Geo.distanceKm(point, u) })).sort((a, b) => a.d - b.d)[0].u;
    },
  };

  // spread same-base units slightly so their markers don't stack on the hospital
  function baseSlot(u) {
    const sameBase = AMBULANCES.filter((a) => a.base === u.baseId).map((a) => a.id);
    const idx = sameBase.indexOf(u.id);
    const ang = (idx / Math.max(1, sameBase.length)) * Math.PI * 2;
    return { lat: u.baseLat + Math.cos(ang) * 0.0016, lng: u.baseLng + Math.sin(ang) * 0.0016 };
  }

  function renderFleet() {
    Fleet.units.forEach((u) => {
      if (u.status === 'AVAILABLE') { const s = baseSlot(u); u.lat = s.lat; u.lng = s.lng; }
      const color = UNIT_COLOR[u.status];
      if (!fleetMarkers[u.id]) {
        fleetMarkers[u.id] = L.marker([u.lat, u.lng], { icon: emojiIcon('ambulance', color, 24) })
          .addTo(map).on('click', () => { if (u.incidentId) select(u.incidentId); });
      } else {
        fleetMarkers[u.id].setLatLng([u.lat, u.lng]);
        fleetMarkers[u.id].setIcon(emojiIcon('ambulance', color, 24));
      }
      fleetMarkers[u.id].bindTooltip(`${u.id} · ${u.type} · ${u.status.replace('_', ' ')}`, { direction: 'top' });

      // route line while heading to an incident
      const inc = u.incidentId ? Store.get(u.incidentId) : null;
      const showRoute = inc && (u.status === 'DISPATCHED' || u.status === 'ENROUTE');
      if (showRoute) {
        const pts = [[u.lat, u.lng], [inc.location.lat, inc.location.lng]];
        if (!routeLines[u.incidentId]) routeLines[u.incidentId] = L.polyline(pts, { color: '#ea580c', weight: 2.5, dashArray: '6,8' }).addTo(map);
        else routeLines[u.incidentId].setLatLngs(pts);
      }
    });
    // drop stale route lines
    Object.keys(routeLines).forEach((iid) => {
      const inc = Store.get(iid);
      if (!inc || !inc.ambulance) return;
      const u = Fleet.byId(inc.ambulance.id);
      if (!u || (u.status !== 'DISPATCHED' && u.status !== 'ENROUTE')) {
        map.removeLayer(routeLines[iid]); delete routeLines[iid];
      }
    });
    renderFleetPanel();
  }

  function renderFleetPanel() {
    const rank = { ON_SCENE: 0, ENROUTE: 1, DISPATCHED: 1, RETURNING: 2, AVAILABLE: 3 };
    const units = Fleet.units.slice().sort((a, b) => (rank[a.status] - rank[b.status]) || a.id.localeCompare(b.id));
    $('fleetSummary').textContent = `${Fleet.countAvailable()} available · ${Fleet.units.length} units`;
    $('fleet').innerHTML = units.map((u) => {
      const inc = u.incidentId ? Store.get(u.incidentId) : null;
      const sub = u.status === 'AVAILABLE' ? u.hospital
        : inc ? `${u.status.replace('_', ' ').toLowerCase()} · ${inc.driver.name}`
        : u.status.replace('_', ' ').toLowerCase();
      return `<div class="unit" data-inc="${u.incidentId || ''}">
        <span class="dot" style="background:${UNIT_COLOR[u.status]}"></span>
        <span class="uid">${u.id}</span><span class="utype">${u.type}</span>
        <span class="ustat">${esc(sub)}</span></div>`;
    }).join('');
    $('fleet').querySelectorAll('.unit[data-inc]').forEach((el) => {
      const iid = el.getAttribute('data-inc');
      if (iid) el.addEventListener('click', () => select(iid));
    });
  }

  /* ---------- unit movement (compressed-time interpolation) ---------- */
  function moveUnit(unit, dest, onArrive, syncIncidentId) {
    if (unitTimers[unit.id]) clearInterval(unitTimers[unit.id]);
    const origin = { lat: unit.lat, lng: unit.lng };
    const totalKm = Geo.distanceKm(origin, dest);
    const durationMs = Math.max(4500, (totalKm / CONFIG.AMBULANCE_SPEED_KMH) * 3600 * 1000 / 30);
    const start = Date.now();
    unitTimers[unit.id] = setInterval(() => {
      const t = Math.min(1, (Date.now() - start) / durationMs);
      const p = Geo.lerp(origin, dest, t);
      unit.lat = p.lat; unit.lng = p.lng;
      if (syncIncidentId) {
        const inc = Store.get(syncIncidentId);
        if (inc && inc.ambulance) { inc.ambulance.lat = p.lat; inc.ambulance.lng = p.lng; Store.upsert(inc); }
      }
      renderFleet();
      if (t >= 1) {
        clearInterval(unitTimers[unit.id]); delete unitTimers[unit.id];
        unit.lat = dest.lat; unit.lng = dest.lng;
        if (onArrive) onArrive();
      }
    }, 600);
  }

  /* ---------- dispatch / return lifecycle ---------- */
  function dispatchToIncident(i) {
    const preferType = (i.severity === 'CRITICAL' || i.severity === 'SERIOUS') ? 'ALS' : null;
    const unit = Fleet.nearestAvailable(i.location, preferType);
    if (!unit) return false;

    unit.status = 'DISPATCHED'; unit.incidentId = i.id;
    i.ambulance = { id: unit.id, hospital: unit.hospital, type: unit.type, lat: unit.lat, lng: unit.lng };
    i.status = 'DISPATCHED';
    i.log.push({ t: Date.now(), msg: `${unit.id} (${unit.type}) dispatched from ${unit.hospital}` });
    activateSupportMesh(i);
    i.log.push({ t: Date.now(), msg: 'Responder mesh activated — contacts and emergency control notified' });
    Store.upsert(i);

    setTimeout(() => {
      if (unit.status !== 'DISPATCHED') return;
      unit.status = 'ENROUTE';
      const x = Store.get(i.id);
      if (x && x.status === 'DISPATCHED') { x.status = 'ENROUTE'; x.log.push({ t: Date.now(), msg: 'Ambulance en route' }); Store.upsert(x); }
    }, 1200);

    moveUnit(unit, i.location, () => {
      unit.status = 'ON_SCENE';
      const x = Store.get(i.id);
      if (x && x.status !== 'RESOLVED' && x.status !== 'CANCELLED') {
        x.status = 'ARRIVED';
        if (x.ambulance) { x.ambulance.lat = i.location.lat; x.ambulance.lng = i.location.lng; }
        x.log.push({ t: Date.now(), msg: `${unit.id} arrived on scene` });
        Store.upsert(x);
      }
      // in simulation, auto-resolve a few seconds after arrival and send the unit home
      if (simOn) setTimeout(() => {
        const y = Store.get(i.id);
        if (y && y.status === 'ARRIVED') {
          y.status = 'RESOLVED'; y.log.push({ t: Date.now(), msg: 'Patient stabilised — incident resolved' });
          Store.upsert(y); returnUnit(unit);
        }
      }, 6000);
    }, i.id);

    renderFleet();
    return true;
  }

  function returnUnit(unit) {
    unit.status = 'RETURNING'; unit.incidentId = null;
    moveUnit(unit, { lat: unit.baseLat, lng: unit.baseLng }, () => { unit.status = 'AVAILABLE'; renderFleet(); });
  }

  /* ---------- alert sound ---------- */
  function beep() {
    if (!soundOn) return;
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      [880, 1320].forEach((f, i) => {
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.frequency.value = f; o.type = 'sine'; o.connect(g); g.connect(ctx.destination);
        g.gain.setValueAtTime(0.0001, ctx.currentTime + i * 0.18);
        g.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + i * 0.18 + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + i * 0.18 + 0.16);
        o.start(ctx.currentTime + i * 0.18); o.stop(ctx.currentTime + i * 0.18 + 0.18);
      });
    } catch (e) {}
  }
  $('soundBtn').addEventListener('click', () => { soundOn = !soundOn; $('soundBtn').innerHTML = icon(soundOn ? 'bell' : 'bell-off', { size: 18 }); });

  /* ===================================================================
     Render incidents
     =================================================================== */
  function render() {
    const all = Store.getAll();
    const active = all.filter((i) => i.status !== 'RESOLVED' && i.status !== 'CANCELLED');

    $('stActive').textContent = active.length;
    $('stCritical').textContent = active.filter((i) => i.severity === 'CRITICAL').length;
    $('stEnroute').textContent = all.filter((i) => i.status === 'ENROUTE' || i.status === 'DISPATCHED').length;
    $('stResolved').textContent = all.filter((i) => i.status === 'RESOLVED').length;
    $('stRiders').textContent = (1248 + active.length).toLocaleString();
    const responding = all.filter((i) => i.status === 'DISPATCHED' || i.status === 'ENROUTE' || i.status === 'ARRIVED');
    const avgEta = responding.length
      ? Math.max(1, Math.round(responding.reduce((sum, i) => {
        if (!i.ambulance) return sum + 5;
        return sum + Geo.etaMin(Geo.distanceKm(i.ambulance, i.location));
      }, 0) / responding.length))
      : 4;
    $('stAvgResponse').textContent = `${avgEta}m ${responding.length ? 'live' : '12s'}`;
    $('stMesh').textContent = `${all.filter((i) => supportForIncident(i).meshActive).length} active`;

    const ordered = all.slice().sort((a, b) => {
      const ar = a.status === 'RESOLVED' || a.status === 'CANCELLED';
      const br = b.status === 'RESOLVED' || b.status === 'CANCELLED';
      if (ar !== br) return ar ? 1 : -1;
      const pr = (b.ai && b.ai.priority_score || 0) - (a.ai && a.ai.priority_score || 0);
      return pr !== 0 ? pr : b.createdAt - a.createdAt;
    });

    const list = $('list');
    if (!ordered.length) {
      list.innerHTML = '<div class="empty">No incidents yet.<br/>Hit “Simulate”, click “+ demo”, or trigger a crash in the Driver app.</div>';
    } else {
      list.innerHTML = ordered.map((i) => {
        const isNew = !seenIds.has(i.id) && i.status === 'NEW';
        return `<div class="incident bl-${i.severity} ${i.id === selectedId ? 'sel' : ''} ${isNew ? 'new-flash' : ''}" data-id="${i.id}">
          <div class="top">
            <span class="who">${esc(i.driver.name)}</span>
            <span class="pill sev-${i.severity}">${i.severity}</span>
          </div>
          <div class="meta">
            <span>${icon('bike',{size:13})} ${esc(i.driver.vehicle)}</span>
            <span>${icon('zap',{size:13})} ${i.impact.gForce.toFixed(1)}G</span>
            <span>${icon('clock',{size:13})} ${fmtAgo(i.createdAt)}</span>
          </div>
          <div class="meta"><span class="dot" style="background:${statusColor(i)}"></span> ${STATUS_LABEL[i.status]}${i.ambulance ? ' · ' + i.ambulance.id : ''}</div>
        </div>`;
      }).join('');
    }

    all.forEach((i) => {
      if (!seenIds.has(i.id)) {
        seenIds.add(i.id);
        if (i.status === 'NEW') beep();   // alert only — keep the map steady for the operator
      }
    });

    all.forEach((i) => upsertIncidentMarker(i));
    Object.keys(incidentMarkers).forEach((id) => {
      if (!all.find((i) => i.id === id)) { map.removeLayer(incidentMarkers[id]); delete incidentMarkers[id]; }
    });

    renderFleet();
    if (selectedId) renderDetail(Store.get(selectedId));
  }

  function statusColor(i) {
    if (i.status === 'RESOLVED') return 'var(--good)';
    if (i.status === 'ARRIVED') return 'var(--accent-2)';
    if (i.status === 'ENROUTE' || i.status === 'DISPATCHED') return 'var(--serious)';
    return CONFIG.SEVERITY_COLORS[i.severity];
  }

  function upsertIncidentMarker(i) {
    const color = CONFIG.SEVERITY_COLORS[i.severity];
    const emoji = i.status === 'RESOLVED' ? 'check' : 'bike';
    if (!incidentMarkers[i.id]) {
      incidentMarkers[i.id] = L.marker([i.location.lat, i.location.lng], { icon: emojiIcon(emoji, color) })
        .addTo(map).on('click', () => select(i.id));
    } else {
      incidentMarkers[i.id].setIcon(emojiIcon(emoji, color));
    }
  }

  /* ---------- detail panel ---------- */
  function renderMedicalIntel(i) {
    const support = supportForIncident(i);
    const m = support.medical || {};
    return `<div class="card" style="margin-top:12px;background:var(--bg-2);">
      <div class="card-title">Rider health data</div>
      <div class="intel-grid">
        <div class="intel-box"><div class="lbl">Rider ID</div><div class="val">${esc(m.riderId || '—')}</div></div>
        <div class="intel-box"><div class="lbl">Age</div><div class="val">${esc(m.age || '—')}</div></div>
        <div class="intel-box"><div class="lbl">Blood type</div><div class="val" style="color:var(--critical)">${esc(m.bloodType || '—')}</div></div>
        <div class="intel-box"><div class="lbl">Allergies</div><div class="val">${esc(m.allergies || '—')}</div></div>
      </div>
      <div class="drow" style="border:none;margin-top:8px;"><span class="k">Conditions</span><span class="v">${esc(m.conditions || '—')}</span></div>
    </div>`;
  }

  function renderResponderIntel(i) {
    const preferType = (i.severity === 'CRITICAL' || i.severity === 'SERIOUS') ? 'ALS' : null;
    const units = Fleet.units
      .map((u) => ({ u, d: Geo.distanceKm(i.location, u) }))
      .sort((a, b) => (a.u.status === 'AVAILABLE' ? 0 : 1) - (b.u.status === 'AVAILABLE' ? 0 : 1) || a.d - b.d)
      .slice(0, 4);
    return `<div class="card" style="margin-top:12px;">
      <div class="card-title">Nearest responders ${preferType ? '· ' + preferType + ' preferred' : ''}</div>
      ${units.map(({ u, d }) => `<div class="support-row">
        <span class="dot" style="background:${UNIT_COLOR[u.status]}"></span>
        <div class="main">
          <div class="name">${esc(u.id)} · ${esc(u.type)} · ${esc(u.hospital)}</div>
          <div class="meta">${distanceLabel(d)} away · ${esc(u.status.replace('_', ' '))}</div>
        </div>
        <span class="pill">${u.status === 'AVAILABLE' ? 'READY' : 'BUSY'}</span>
      </div>`).join('')}
    </div>`;
  }

  function renderContactMesh(i) {
    const support = supportForIncident(i);
    return `<div class="card" style="margin-top:12px;">
      <div class="card-title">Responder mesh</div>
      ${support.contacts.map((c) => {
        const ok = c.status === 'notified';
        const missing = c.status === 'missing';
        const status = missing ? 'missing' : ok ? `notified ${fmtAgo(c.notifiedAt)}` : 'queued';
        return `<div class="support-row">
          <span class="dot" style="background:${ok ? 'var(--good)' : missing ? 'var(--dim)' : 'var(--serious)'}"></span>
          <div class="main">
            <div class="name">${esc(c.name)}</div>
            <div class="meta">${esc(c.label)} · ${esc(status)}${c.phone ? ' · ' + esc(c.phone) : ''}</div>
          </div>
        </div>`;
      }).join('')}
    </div>`;
  }

  function renderNearbyServices(i) {
    const support = supportForIncident(i);
    const services = (support.services && support.services.all || []).slice(0, 6);
    return `<div class="card" style="margin-top:12px;">
      <div class="card-title">Nearby services</div>
      ${services.map((p) => `<div class="support-row">
        <span style="font-size:19px;">${categoryIcon(p.category)}</span>
        <div class="main">
          <div class="name">${esc(p.name)}</div>
          <div class="meta">${esc(categoryLabel(p.category))} · ${distanceLabel(p.distanceKm)} · ${esc(p.address || 'Nearby')}</div>
        </div>
        <a class="pill" target="_blank" href="https://maps.google.com/?q=${p.lat},${p.lng}">MAP</a>
      </div>`).join('')}
    </div>`;
  }

  function renderBystanderGuide(i) {
    const support = supportForIncident(i);
    return `<div class="card" style="margin-top:12px;background:#1a1500;border-color:#5a531c;">
      <div class="card-title" style="color:var(--minor)">Bystander instructions</div>
      <div style="font-size:12px;line-height:1.5;color:#f2d94e;margin-bottom:8px;">${esc(support.bystander.law)}</div>
      <ul class="ai-list">${support.bystander.steps.slice(0, 5).map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
    </div>`;
  }

  function renderTranscript(i) {
    const support = supportForIncident(i);
    const lines = [
      { t: '00:01', msg: `${i.source === 'MANUAL_SOS' ? 'Manual SOS' : 'Crash detector'} triggered for ${i.driver.name}.` },
      { t: '00:04', msg: `Location locked at ${i.location.lat.toFixed(4)}, ${i.location.lng.toFixed(4)}.` },
      { t: '00:08', msg: `AI triage packet generated: ${i.severity}, priority ${(i.ai.priority_score || 0).toFixed(1)}/10.` },
      { t: '00:12', msg: support.meshActive ? 'Responder mesh active; emergency contacts notified.' : 'Responder mesh queued; dispatch authorization pending.' },
    ];
    return `<div class="card" style="margin-top:12px;">
      <div class="card-title">Automated SOS transcript</div>
      <ul class="transcript">${lines.map((x) => `<li><span class="t">${x.t}</span><span>${esc(x.msg)}</span></li>`).join('')}</ul>
    </div>`;
  }

  function renderDetail(i) {
    if (!i) return;
    const c = CONFIG.SEVERITY_COLORS[i.severity];
    const ai = i.ai;
    const steps = ['NEW', 'DISPATCHED', 'ENROUTE', 'ARRIVED', 'RESOLVED'];
    const curIdx = steps.indexOf(i.status);

    const dist = i.ambulance ? Geo.distanceKm(i.ambulance, i.location) : null;
    const eta = (i.ambulance && i.status !== 'ARRIVED' && i.status !== 'RESOLVED')
      ? Math.max(1, Math.round(Geo.etaMin(dist))) : null;

    $('detail').innerHTML = `
      <div class="banner" style="color:${c};border-color:${c};background:${c}1a;">
        <span>${icon('alert-triangle',{size:18})}</span> ${i.severity} INCIDENT
        <span class="spacer" style="flex:1"></span>
        <span class="mono" style="font-size:12px;color:var(--muted)">${fmtTime(i.createdAt)}</span>
      </div>

      <div class="seg">
        ${steps.map((s, idx) => `<div class="step ${idx === curIdx ? 'on' : ''} ${idx < curIdx ? 'done' : ''}">${s}</div>`).join('')}
      </div>

      <div class="drow"><span class="k">Rider</span><span class="v">${esc(i.driver.name)}</span></div>
      <div class="drow"><span class="k">Vehicle</span><span class="v">${esc(i.driver.vehicle)}</span></div>
      <div class="drow"><span class="k">Phone</span><span class="v"><a href="tel:${esc(i.driver.phone)}">${esc(i.driver.phone)}</a></span></div>
      <div class="drow"><span class="k">Location</span><span class="v mono">${i.location.lat.toFixed(4)}, ${i.location.lng.toFixed(4)}
        <a href="https://maps.google.com/?q=${i.location.lat},${i.location.lng}" target="_blank">${icon('external-link',{size:13})}</a></span></div>
      <div class="drow"><span class="k">Impact</span><span class="v">${i.impact.gForce.toFixed(1)}G · ${i.impact.direction}</span></div>
      <div class="drow"><span class="k">Speed</span><span class="v">${i.impact.speedBefore} → ${i.impact.speedAfter} km/h</span></div>
      <div class="drow"><span class="k">Signal source</span><span class="v">${i.source === 'MANUAL_SOS' ? 'Manual rider SOS' : 'Passive crash detection'}</span></div>

      ${renderMedicalIntel(i)}
      ${renderTranscript(i)}

      <div class="card" style="margin-top:16px;background:var(--bg-2);">
        <div class="card-title" style="display:flex;align-items:center;gap:6px;">${icon('cpu',{size:14})} AI medical assessment</div>
        <div class="drow"><span class="k">Dispatch</span><span class="v">${esc(ai.dispatch)}</span></div>
        <div class="drow"><span class="k">Hospital dept</span><span class="v">${ai.hospital_dept.map(esc).join(', ')}</span></div>
        <div class="drow"><span class="k">Est. casualties</span><span class="v">${ai.estimated_casualties}</span></div>
        <div style="padding-top:8px;"><span class="k muted" style="font-size:13px;">Likely injuries</span>
          <ul class="ai-list">${ai.likely_injuries.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>
        <div class="priority"><span class="muted">Priority score</span>
          <span class="score" style="color:${c}">${ai.priority_score.toFixed(1)}<span style="font-size:14px;color:var(--muted)">/10</span></span></div>
      </div>

      ${i.blackbox && i.blackbox.length ? `
        <div class="card" style="margin-top:12px;background:var(--bg-2);">
          <div class="card-title" style="display:flex;align-items:center;gap:6px;">${icon('box',{size:14})} Black box · 30s before impact</div>
          ${renderBlackBoxSVG(i.blackbox)}
          <div class="bb-legend">
            <span><i style="background:#FF4d4d"></i>G-force</span>
            <span><i style="background:#1a73ff"></i>Speed</span>
            <span><i style="background:#fff"></i>Impact</span>
            <span class="dim" style="margin-left:auto;">peak ${bbStats(i.blackbox).peakG.toFixed(1)}G · ${Math.round(bbStats(i.blackbox).duration)}s</span>
          </div>
        </div>` : ''}

      ${renderResponderIntel(i)}
      ${renderContactMesh(i)}
      ${renderNearbyServices(i)}
      ${renderBystanderGuide(i)}

      ${i.ambulance ? `
        <div class="card" style="margin-top:12px;">
          <div class="card-title" style="display:flex;align-items:center;gap:6px;">${icon('ambulance',{size:14})} Ambulance</div>
          <div class="drow"><span class="k">Unit</span><span class="v">${i.ambulance.id} · ${i.ambulance.type || ''} · ${esc(i.ambulance.hospital)}</span></div>
          <div class="drow"><span class="k">Distance</span><span class="v">${dist.toFixed(1)} km</span></div>
          <div class="drow" style="border:none;"><span class="k">ETA</span><span class="v" style="color:var(--accent-2)">${i.status === 'ARRIVED' ? 'On scene' : i.status === 'RESOLVED' ? '—' : eta + ' min'}</span></div>
        </div>` : ''}

      <div style="margin-top:16px; display:flex; flex-direction:column; gap:10px;">
        ${dispatchActions(i)}
      </div>
    `;

    $('detail').querySelectorAll('[data-act]').forEach((b) =>
      b.addEventListener('click', () => doAction(i.id, b.getAttribute('data-act'))));

    if (typeof IncidentChat !== 'undefined' && chatLoadedId !== i.id) {
      IncidentChat.setIncident(i);
      chatLoadedId = i.id;
    }
  }

  function dispatchActions(i) {
    if (i.status === 'NEW') {
      const preferType = (i.severity === 'CRITICAL' || i.severity === 'SERIOUS') ? 'ALS' : null;
      const u = Fleet.nearestAvailable(i.location, preferType);
      const label = u ? `(${u.id} ${u.type}, ${Geo.distanceKm(i.location, u).toFixed(1)} km)` : '(no unit free)';
      return `<button class="btn btn-primary btn-block btn-lg" data-act="dispatch" ${u ? '' : 'disabled'}>${icon('ambulance',{size:14})} Dispatch nearest ambulance
        <span style="font-weight:400;opacity:.85">${label}</span></button>
        <button class="btn btn-block" data-act="notify">${icon('radio',{size:17})} Activate responder mesh</button>
        <button class="btn btn-ghost btn-block" data-act="cancel">Mark as false alarm</button>`;
    }
    if (i.status === 'DISPATCHED' || i.status === 'ENROUTE' || i.status === 'ARRIVED') {
      return `<button class="btn btn-block" data-act="notify">${icon('radio',{size:17})} Refresh responder mesh</button>
        <button class="btn btn-good btn-block" data-act="resolve">${icon('check',{size:17})} Resolve incident</button>`;
    }
    return `<div class="muted" style="text-align:center;font-size:13px;">Incident ${i.status.toLowerCase()}.</div>`;
  }

  /* ---------- actions ---------- */
  function doAction(id, act) {
    const i = Store.get(id);
    if (!i) return;
    if (act === 'dispatch') {
      dispatchToIncident(i);
    } else if (act === 'notify') {
      activateSupportMesh(i);
      i.log.push({ t: Date.now(), msg: 'Responder mesh activated by dispatch operator' });
      Store.upsert(i);
    } else if (act === 'resolve' || act === 'cancel') {
      i.status = act === 'resolve' ? 'RESOLVED' : 'CANCELLED';
      i.log.push({ t: Date.now(), msg: act === 'resolve' ? 'Incident resolved by dispatch' : 'Marked as false alarm by dispatch' });
      Store.upsert(i);
      const unit = i.ambulance ? Fleet.byId(i.ambulance.id) : null;
      if (unit && unit.status !== 'AVAILABLE') returnUnit(unit);
    }
  }

  /* ---------- selection ---------- */
  function select(id) {
    selectedId = id;
    const i = Store.get(id);
    const sz = map.getSize();
    if (i && sz.x > 0 && sz.y > 0) map.panTo([i.location.lat, i.location.lng], { animate: true });   // gentle recenter; skip if map has no size
    render();
  }
  $('list').addEventListener('click', (e) => {
    const el = e.target.closest('.incident'); if (el) select(el.getAttribute('data-id'));
  });

  /* ===================================================================
     Incident generators
     =================================================================== */
  const NAMES = ['Aarav Singh', 'Meena Kumari', 'Imran Khan', 'Rohit Sharma', 'Priya Nair',
    'Sanjay Gupta', 'Fatima Sheikh', 'Vikram Reddy', 'Neha Joshi', 'Karan Mehta'];

  function makeIncident(opts) {
    const o = opts || {};
    const impact = {
      gForce: o.g != null ? o.g : +(1.8 + Math.random() * 3.6).toFixed(1),
      speedBefore: o.sb != null ? o.sb : 25 + Math.floor(Math.random() * 45),
      speedAfter: 0,
      direction: o.dir || ['Front', 'Rear', 'Left-side', 'Right-side'][Math.floor(Math.random() * 4)],
    };
    const ai = classify(impact);
    const driver = {
      name: o.name || NAMES[Math.floor(Math.random() * NAMES.length)],
      vehicle: o.vehicle || ('DL ' + (1 + Math.floor(Math.random() * 9)) + 'A ' + (1000 + Math.floor(Math.random() * 8999))),
      phone: '+91 98' + Math.floor(100 + Math.random() * 899) + ' ' + Math.floor(10000 + Math.random() * 89999),
      contactName: ['Asha', 'Vijay', 'Neelam', 'Kabir'][Math.floor(Math.random() * 4)] + ' (primary)',
      contact: '+91 99000 00000',
      age: String(23 + Math.floor(Math.random() * 22)),
      blood: ['O+', 'B+', 'A+', 'AB+'][Math.floor(Math.random() * 4)],
      allergies: Math.random() < 0.25 ? 'Penicillin allergy' : 'None reported',
      conditions: Math.random() < 0.2 ? 'Asthma history' : 'No major medical history reported',
    };
    const location = { lat: o.lat != null ? o.lat : 28.55 + Math.random() * 0.17, lng: o.lng != null ? o.lng : 77.16 + Math.random() * 0.17 };
    return Store.upsert({
      id: uid(), status: 'NEW', createdAt: Date.now(),
      source: 'DEMO_INCIDENT',
      driver,
      location,
      impact, severity: ai.severity, ai, blackbox: synthBlackBox(impact.speedBefore, impact.gForce), ambulance: null,
      support: buildSupportPacket(driver, location),
      log: [{ t: Date.now(), msg: 'Crash detected — SOS auto-sent by GigGuard' }],
    });
  }

  $('seedBtn').addEventListener('click', () => makeIncident());

  /* ---------- simulation ---------- */
  let simTimer = null;
  function setSim(on) {
    simOn = on;
    $('simBtn').classList.toggle('btn-primary', on);
    $('simBtn').innerHTML = on ? icon('pause',{size:16}) + ' Stop simulation' : icon('play',{size:16,fill:true}) + ' Simulate';
    if (on) {
      makeIncident();
      simTimer = setInterval(() => {
        const all = Store.getAll();
        const active = all.filter((i) => i.status !== 'RESOLVED' && i.status !== 'CANCELLED').length;
        if (active < 6 && Math.random() < 0.8) makeIncident();
        // auto-dispatch any waiting incidents while units are free
        all.filter((i) => i.status === 'NEW').forEach((i) => {
          if (Fleet.countAvailable() > 0) dispatchToIncident(Store.get(i.id));
        });
        // prune old resolved/cancelled so storage stays light
        const done = Store.getAll().filter((i) => i.status === 'RESOLVED' || i.status === 'CANCELLED');
        done.slice(12).forEach((d) => Store.remove(d.id));
      }, 5000);
    } else if (simTimer) { clearInterval(simTimer); simTimer = null; }
  }
  $('simBtn').addEventListener('click', () => setSim(!simOn));

  /* ---------- utils ---------- */
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  /* ---------- live ---------- */
  if (typeof IncidentChat !== 'undefined') {
    IncidentChat.create('incidentChat');
    IncidentChat.clear();
    const ct = $('chatTitle');
    if (ct) ct.innerHTML = icon('message', { size: 14 }) + ' ' + (AI.displayName() || 'AI') + ' incident chat';
  }
  (function updateAiBadge() {
    const dot = $('aiDot'), label = $('aiLabel'), badge = $('aiBadge');
    if (!dot || !label || !badge) return;
    if (AI.isEnabled()) {
      dot.style.background = 'var(--accent)';
      label.textContent = AI.displayName() || 'AI';
      badge.classList.add('ai-badge-connected');
    } else {
      dot.style.background = 'var(--dim)';
      label.textContent = 'Rule-based';
      badge.classList.remove('ai-badge-connected');
    }
  })();
  Store.subscribe(render);
  render();
  renderFleet();
  setInterval(render, 5000);                 // refresh "x ago" labels
  // resume any ambulances mid-dispatch from a previous session
  Store.getAll().forEach((i) => {
    if (i.ambulance && (i.status === 'DISPATCHED' || i.status === 'ENROUTE')) {
      const u = Fleet.byId(i.ambulance.id);
      if (u) { u.status = i.status; u.incidentId = i.id; u.lat = i.ambulance.lat; u.lng = i.ambulance.lng; dispatchResume(u, i); }
    }
  });
  function dispatchResume(unit, i) {
    moveUnit(unit, i.location, () => {
      unit.status = 'ON_SCENE';
      const x = Store.get(i.id);
      if (x && x.status !== 'RESOLVED' && x.status !== 'CANCELLED') { x.status = 'ARRIVED'; x.log.push({ t: Date.now(), msg: `${unit.id} arrived on scene` }); Store.upsert(x); }
    }, i.id);
  }
})();
