/* =====================================================================
   GigGuard — Driver app logic
   Watches motion sensors, detects crashes, runs the cancel countdown,
   and pushes an SOS incident to the shared Store (seen live by dispatch).
   ===================================================================== */
(function () {
  const $ = (id) => document.getElementById(id);

  /* ---------- rider profile (persisted) ---------- */
  const PKEY = 'gigguard.driver';
  const profile = Object.assign(
    {
      name: 'Rahul Verma',
      vehicle: 'DL 1A 2345',
      phone: '+91 98100 11223',
      contactName: 'Anita Verma',
      contact: '+91 99999 00000',
      age: '29',
      blood: 'O+',
      allergies: 'None reported',
      conditions: 'No major medical history',
    },
    JSON.parse(localStorage.getItem(PKEY) || '{}')
  );
  const pFields = {
    name: $('pName'),
    vehicle: $('pVehicle'),
    phone: $('pPhone'),
    contactName: $('pContactName'),
    contact: $('pContact'),
    age: $('pAge'),
    blood: $('pBlood'),
    allergies: $('pAllergies'),
    conditions: $('pConditions'),
  };
  Object.keys(pFields).forEach((k) => {
    if (!pFields[k]) return;
    pFields[k].value = profile[k] || '';
    pFields[k].addEventListener('input', () => {
      profile[k] = pFields[k].value;
      localStorage.setItem(PKEY, JSON.stringify(profile));
    });
  });

  /* ---------- live state ---------- */
  const state = {
    armed: false,
    gForce: 1.0,
    speed: 0,
    loc: { ...CONFIG.CITY_CENTER },
    heading: 0.6,                  // radians, for sim movement
    lastAccel: { x: 0, y: 0, z: 9.81 },
    prevSpeed: 0,
    lastTrigger: 0,
    activeId: null,               // current SOS incident id
    driving: false,
    threshold: CONFIG.CRASH_THRESHOLD_G,  // adjustable detection sensitivity
    frozenBlackBox: null,         // telemetry buffer captured at impact
    startedAt: null,
    gpsLocked: false,
    batteryPct: null,
    batteryCharging: null,
  };

  /* ---------- black box recorder + live history ---------- */
  const recorder = new BlackBoxRecorder(30, 10);   // last 30s @ 10Hz
  const gHistory = new Array(120).fill(1);          // last 12s for the live graph

  /* ---------- UI refs ---------- */
  const hero = $('hero'), heroIcon = $('heroIcon'), heroTitle = $('heroTitle'), heroSub = $('heroSub');
  const gforceEl = $('gforce'), gforceBar = $('gforceBar'), speedEl = $('speed'), speedBar = $('speedBar');
  const armBtn = $('armBtn'), driveBtn = $('driveBtn'), crashBtn = $('crashBtn'), manualBtn = $('manualBtn'), conn = $('conn');

  function renderGauges() {
    gforceEl.textContent = state.gForce.toFixed(1);
    const gp = Math.min(100, (state.gForce / 5) * 100);
    gforceBar.style.width = gp + '%';
    gforceBar.style.background = state.gForce >= CONFIG.CRASH_THRESHOLD_G ? 'var(--critical)'
      : state.gForce >= 1.8 ? 'var(--serious)' : 'var(--good)';
    speedEl.textContent = Math.round(state.speed);
    speedBar.style.width = Math.min(100, (state.speed / 80) * 100) + '%';
    speedBar.style.background = 'var(--accent)';
  }

  /* ---------- sentinel monitor panels + live rider map ---------- */
  let monitorMap = null, monitorMarker = null, monitorPath = null;
  const riderTrace = [];

  function fmtDuration(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    const h = String(Math.floor(total / 3600)).padStart(2, '0');
    const m = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
    const s = String(total % 60).padStart(2, '0');
    return `${h}:${m}:${s}`;
  }

  function initMonitorMap() {
    if (monitorMap || typeof L === 'undefined' || !$('driverMap')) return;
    monitorMap = L.map('driverMap', { zoomControl: false, attributionControl: false }).setView([state.loc.lat, state.loc.lng], 14);
    L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', { maxZoom: 19 }).addTo(monitorMap);
    monitorMarker = L.marker([state.loc.lat, state.loc.lng], { icon: emojiIcon('bike', '#2563eb') }).addTo(monitorMap);
    monitorPath = L.polyline([[state.loc.lat, state.loc.lng]], { color: '#1a73ff', weight: 3, opacity: 0.75 }).addTo(monitorMap);
    setTimeout(() => monitorMap.invalidateSize(), 150);
  }

  function updateMonitorMap() {
    if (!monitorMap) return;
    const latlng = [state.loc.lat, state.loc.lng];
    riderTrace.push(latlng);
    if (riderTrace.length > 80) riderTrace.shift();
    monitorMarker.setLatLng(latlng);
    monitorPath.setLatLngs(riderTrace);
    if (state.driving || state.gpsLocked) monitorMap.panTo(latlng, { animate: true, duration: 0.25 });
  }

  function renderSentinel() {
    const activeFor = state.startedAt ? fmtDuration(Date.now() - state.startedAt) : '00:00:00';
    $('shiftDuration').textContent = activeFor;
    $('shiftStarted').textContent = state.startedAt ? `Started ${fmtTime(state.startedAt)}` : 'Start monitoring to begin';
    $('gpsState').textContent = state.gpsLocked ? 'Locked' : (state.armed ? 'Seeking' : 'Standby');
    $('gpsCoords').textContent = `${state.loc.lat.toFixed(4)}, ${state.loc.lng.toFixed(4)}`;
    $('batteryPct').textContent = state.batteryPct == null ? '--' : `${Math.round(state.batteryPct * 100)}%`;
    $('batteryHint').textContent = state.batteryPct == null
      ? 'Battery API unavailable'
      : state.batteryCharging ? 'Charging' : (state.batteryPct < 0.25 ? 'Low battery caution' : 'Enough for the current ride');
    const pulse = Math.round(72 + Math.max(0, state.gForce - 1) * 11 + (state.speed > 35 ? 4 : 0));
    $('pulseState').textContent = `${pulse} BPM`;
    $('pulseHint').textContent = pulse > 95 ? 'Elevated after impact/motion' : 'Relaxed baseline estimate';
  }

  function startBatteryMonitor() {
    if (!navigator.getBattery) return;
    navigator.getBattery().then((bat) => {
      const sync = () => {
        state.batteryPct = bat.level;
        state.batteryCharging = bat.charging;
        renderSentinel();
      };
      sync();
      bat.addEventListener('levelchange', sync);
      bat.addEventListener('chargingchange', sync);
    }).catch(() => {});
  }

  /* ---------- live black box instruments ---------- */
  const liveGraph = $('liveGraph'), cArrow = $('cArrow'), recBadge = $('recBadge');

  function renderInstruments() {
    // rolling G-force sparkline (320x90 viewBox, stretched)
    const n = gHistory.length, W = 320, H = 90, gMax = 5;
    const pts = gHistory.map((g, i) => `${((i / (n - 1)) * W).toFixed(1)},${(H - Math.min(1, g / gMax) * H).toFixed(1)}`).join(' ');
    const thrY = (H - Math.min(1, state.threshold / gMax) * H).toFixed(1);
    const peak = Math.max.apply(null, gHistory);
    const col = peak > state.threshold ? '#dc2626' : peak > state.threshold * 0.7 ? '#ea580c' : '#0d9488';
    liveGraph.innerHTML =
      `<polyline points="0,${H} ${pts} ${W},${H}" fill="${col}22" stroke="none"/>` +
      `<line x1="0" y1="${thrY}" x2="${W}" y2="${thrY}" stroke="#dc262666" stroke-width="1" stroke-dasharray="5,5"/>` +
      `<polyline points="${pts}" fill="none" stroke="${col}" stroke-width="2" vector-effect="non-scaling-stroke"/>`;

    // raw axes
    $('axX').textContent = (state.lastAccel.x / 9.81).toFixed(2);
    $('axY').textContent = (state.lastAccel.y / 9.81).toFixed(2);
    $('axZ').textContent = (state.lastAccel.z / 9.81).toFixed(2);

    // impact vector compass
    const ang = Math.atan2(state.lastAccel.y, state.lastAccel.x);
    const mag = Math.min(1, Math.hypot(state.lastAccel.x, state.lastAccel.y) / 9.81 / 2);
    const len = 6 + mag * 16;
    cArrow.setAttribute('x2', (28 + Math.cos(ang) * len).toFixed(1));
    cArrow.setAttribute('y2', (28 + Math.sin(ang) * len).toFixed(1));
    cArrow.setAttribute('stroke', state.armed && mag > 0.05 ? `rgba(255,${Math.round(255 * (1 - mag))},45,${0.5 + mag * 0.5})` : '#555');
  }

  function setRec(on) {
    recBadge.innerHTML = on
      ? '<span class="dot" style="background:var(--critical)"></span> REC · 30s'
      : '<span class="dot" style="background:var(--dim)"></span> Idle';
  }

  /* ---------- sensitivity selector ---------- */
  const SENS = [{ g: 1.5, l: 'High' }, { g: 2.0, l: 'High' }, { g: 2.5, l: 'Default' }, { g: 3.0, l: 'Low' }, { g: 3.5, l: 'Low' }];
  function buildSensitivity() {
    $('sensitRow').innerHTML = SENS.map((s) =>
      `<div class="sensit-btn ${s.g === state.threshold ? 'on' : ''}" data-g="${s.g}"><b>${s.g}G</b><span>${s.l}</span></div>`).join('');
    $('sensitRow').querySelectorAll('.sensit-btn').forEach((b) =>
      b.addEventListener('click', () => { state.threshold = parseFloat(b.dataset.g); buildSensitivity(); }));
  }

  function setArmed(on) {
    state.armed = on;
    driveBtn.disabled = !on; crashBtn.disabled = !on;
    armBtn.innerHTML = on ? icon('pause',{size:18}) + ' Stop monitoring' : icon('play',{size:18,fill:true}) + ' Start monitoring';
    armBtn.classList.toggle('btn-primary', !on);
    if (on) {
      if (!state.startedAt) state.startedAt = Date.now();
      hero.className = 'status-hero armed';
      heroIcon.innerHTML = icon('shield', { size: 30 }); heroTitle.textContent = 'Protection active';
      heroSub.textContent = 'Monitoring impact & deceleration in real time';
      conn.innerHTML = '<span class="dot" style="background:var(--good)"></span> Monitoring';
    } else {
      hero.className = 'status-hero idle';
      heroIcon.innerHTML = icon('shield', { size: 30 }); heroTitle.textContent = 'Protection off';
      heroSub.textContent = 'Start monitoring to begin crash detection';
      conn.innerHTML = '<span class="dot" style="background:var(--dim)"></span> Standby';
      state.driving = false; driveBtn.innerHTML = icon('bike',{size:17}) + ' Simulate driving';
      state.startedAt = null;
    }
    setRec(on);
    renderSentinel();
  }

  /* ---------- sensors: DeviceMotion (real phones) ---------- */
  function startMotion() {
    const handler = (e) => {
      const a = e.accelerationIncludingGravity || e.acceleration;
      if (!a || a.x == null) return;
      state.lastAccel = { x: a.x, y: a.y, z: a.z };
      const g = Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z) / 9.81;
      // smooth a touch so the gauge isn't jittery, but keep peaks
      state.gForce = Math.max(g, state.gForce * 0.6 + g * 0.4);
    };
    if (typeof DeviceMotionEvent !== 'undefined' &&
        typeof DeviceMotionEvent.requestPermission === 'function') {
      // iOS 13+ needs an explicit grant from a user gesture
      DeviceMotionEvent.requestPermission().then((res) => {
        if (res === 'granted') window.addEventListener('devicemotion', handler);
        else $('sensorHint').textContent = 'Motion access denied — use the Simulate buttons.';
      }).catch(() => {});
    } else if (typeof DeviceMotionEvent !== 'undefined') {
      window.addEventListener('devicemotion', handler);
    } else {
      $('sensorHint').textContent = 'No motion sensor here — use the Simulate buttons.';
    }
  }

  /* ---------- GPS (real) ---------- */
  function startGeo() {
    if (!navigator.geolocation) return;
    navigator.geolocation.watchPosition((pos) => {
      state.loc = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      state.gpsLocked = true;
      if (pos.coords.speed != null && pos.coords.speed >= 0 && !state.driving) {
        state.speed = pos.coords.speed * 3.6; // m/s → km/h
      }
      renderSentinel();
      updateMonitorMap();
    }, () => {
      state.gpsLocked = false;
      renderSentinel();
    }, { enableHighAccuracy: true, maximumAge: 1000 });
  }

  /* ---------- detection loop (10 Hz) ---------- */
  setInterval(() => {
    if (!state.armed) return;

    // natural decay of the smoothed g reading toward rest (~1G)
    state.gForce += (1.0 - state.gForce) * 0.12;

    // simulated driving drifts the marker forward and holds a cruising speed
    if (state.driving) {
      const d = 0.00012;
      state.loc = { lat: state.loc.lat + Math.cos(state.heading) * d, lng: state.loc.lng + Math.sin(state.heading) * d };
      state.speed += (48 - state.speed) * 0.08 + (Math.random() - 0.5) * 2;
      state.speed = Math.max(0, state.speed);
    } else if (state.speed > 0 && navigator.geolocation == null) {
      state.speed *= 0.96;
    }

    renderGauges();

    // ---- black box: record this 10Hz frame into the rolling buffer ----
    recorder.push({
      t: Date.now(), g: +state.gForce.toFixed(3), v: +state.speed.toFixed(1),
      ax: state.lastAccel.x, ay: state.lastAccel.y, az: state.lastAccel.z,
    });
    gHistory.push(state.gForce); gHistory.shift();
    renderInstruments();
    renderSentinel();
    updateMonitorMap();

    // ---- crash logic (mirrors CrashDetector.ts) ----
    const speedDrop = state.prevSpeed - state.speed;
    const now = Date.now();
    const confirmedCrash = state.gForce > state.threshold && speedDrop > CONFIG.SPEED_DROP_THRESHOLD_KMH;
    const shakeCrash = state.gForce > Math.max(CONFIG.SHAKE_THRESHOLD_G, state.threshold + 0.3); // demo fallback
    if ((confirmedCrash || shakeCrash) && now - state.lastTrigger > CONFIG.DEBOUNCE_MS && !state.activeId) {
      state.lastTrigger = now;
      triggerCrash(state.prevSpeed);
    }
    state.prevSpeed = state.speed;
  }, 100);

  /* ---------- buttons ---------- */
  armBtn.addEventListener('click', () => {
    const next = !state.armed;
    setArmed(next);
    if (next) { initMonitorMap(); startMotion(); startGeo(); }
  });

  driveBtn.addEventListener('click', () => {
    state.driving = !state.driving;
    driveBtn.innerHTML = state.driving ? icon('pause',{size:17}) + ' Stop driving' : icon('bike',{size:17}) + ' Simulate driving';
    state.heading = Math.random() * Math.PI * 2;
  });

  crashBtn.addEventListener('click', () => {
    // inject a violent deceleration: high G + speed collapse
    state.prevSpeed = state.speed > 10 ? state.speed : 52;
    state.speed = 0; state.driving = false;
    driveBtn.innerHTML = icon('bike',{size:17}) + ' Simulate driving';
    state.lastAccel = { x: 38, y: 12, z: 9.81 }; // front-ish impact
    state.gForce = 4.6;
    renderGauges();
    triggerCrash(state.prevSpeed);
    state.lastTrigger = Date.now();
  });

  manualBtn.addEventListener('click', () => {
    if (state.activeId) return;
    initMonitorMap();
    if (!state.startedAt) state.startedAt = Date.now();
    const impact = {
      gForce: Math.max(2.8, state.gForce),
      speedBefore: Math.round(state.speed),
      speedAfter: Math.round(state.speed),
      direction: 'Manual SOS',
    };
    const ai = classify(impact);
    ai.severity = ai.severity === 'MINOR' ? 'SERIOUS' : ai.severity;
    ai.dispatch = 'Emergency ambulance (manual SOS)';
    ai.priority_score = Math.max(ai.priority_score, 6.5);
    ai.likely_injuries = ['Rider requested emergency help'].concat(ai.likely_injuries).slice(0, 4);
    let bb = recorder.snapshot();
    if (bb.length < 20) bb = synthBlackBox(Math.max(28, state.speed || 34), impact.gForce);
    state.frozenBlackBox = bb;
    fireSOS(impact, ai, bb, 'MANUAL_SOS');
  });

  /* ===================================================================
     Crash flow: countdown overlay → send SOS
     =================================================================== */
  let countdownTimer = null;

  function triggerCrash(prevSpeed) {
    const ax = state.lastAccel.x, ay = state.lastAccel.y;
    const impact = {
      gForce: state.gForce,
      speedBefore: Math.round(prevSpeed),
      speedAfter: Math.round(state.speed),
      direction: impactDirection(ax, ay),
    };
    // Use synchronous classify for immediate overlay, AI classification runs async after SOS
    const ai = classify(impact);

    // FREEZE the black box at the impact moment — the 30s leading up to the crash.
    let bb = recorder.snapshot();
    if (bb.length < 60) bb = synthBlackBox(impact.speedBefore, state.gForce);
    bb.push({ t: Date.now(), g: +state.gForce.toFixed(3), v: impact.speedAfter, ax, ay, az: state.lastAccel.z });
    state.frozenBlackBox = bb;

    // overlay
    const ov = $('overlay'), ovNum = $('ovNum'), ovRing = $('ovRing'), ovSev = $('ovSev');
    ovSev.className = 'pill sev-' + ai.severity + ' pulse-warn';
    ovSev.textContent = 'POSSIBLE CRASH · ' + ai.severity;
    ov.classList.remove('hidden');
    if (navigator.vibrate) navigator.vibrate([400, 120, 400]);

    let remaining = CONFIG.CANCEL_COUNTDOWN_SEC;
    const total = CONFIG.CANCEL_COUNTDOWN_SEC, CIRC = 502;
    ovNum.textContent = remaining;
    ovRing.style.strokeDashoffset = '0';

    clearInterval(countdownTimer);
    countdownTimer = setInterval(() => {
      remaining -= 1;
      ovNum.textContent = Math.max(0, remaining);
      ovRing.style.strokeDashoffset = String(CIRC * (1 - remaining / total));
      if (remaining <= 0) { clearInterval(countdownTimer); fireSOS(impact, ai, bb); }
    }, 1000);

    const cancel = () => { clearInterval(countdownTimer); ov.classList.add('hidden'); state.gForce = 1.0; renderGauges(); };
    $('ovCancel').onclick = cancel;
    $('ovSend').onclick = () => { clearInterval(countdownTimer); fireSOS(impact, ai, bb); };
  }

  async function fireSOS(impact, ai, bb, source) {
    source = source || 'AUTO_CRASH';
    $('overlay').classList.add('hidden');

    // Show loading state for AI classification
    const aiSourceIcon = $('aiSourceIcon');
    const aiSourceText = $('aiSourceText');
    const aiLoadingShimmer = $('aiLoadingShimmer');

    const incident = {
      id: uid(),
      source,
      status: 'NEW',
      createdAt: Date.now(),
      driver: {
        name: profile.name,
        vehicle: profile.vehicle,
        phone: profile.phone,
        contactName: profile.contactName,
        contact: profile.contact,
        age: profile.age,
        blood: profile.blood,
        allergies: profile.allergies,
        conditions: profile.conditions,
      },
      location: { ...state.loc },
      impact,
      severity: ai.severity,
      ai: { ...ai, _source: 'rule-based' },
      blackbox: bb || state.frozenBlackBox || [],
      support: buildSupportPacket(profile, state.loc),
      ambulance: null,
      log: [{
        t: Date.now(),
        msg: source === 'MANUAL_SOS'
          ? 'Manual SOS sent by rider — emergency support packet created'
          : 'Crash detected — SOS auto-sent by GigGuard',
      }],
    };
    state.activeId = incident.id;
    Store.upsert(incident);
    showSOSView(incident);

    // Run AI classification asynchronously (non-blocking)
    if (AI.isEnabled()) {
      aiSourceIcon.innerHTML = icon('cpu',{size:16});
      aiSourceText.textContent = (AI.displayName() || 'AI') + ' analyzing crash data...';
      aiLoadingShimmer.style.display = 'block';

      try {
        const aiResult = await classifyWithAI(impact, incident.blackbox);
        const inc = Store.get(state.activeId);
        if (inc) {
          inc.ai = aiResult;
          inc.severity = aiResult.severity;
          inc.log.push({ t: Date.now(), msg: `${AI.displayName()} assessment: ${aiResult.severity} — ${aiResult.likely_injuries.slice(0, 2).join(', ')}` });
          Store.upsert(inc);

          // Update AI source indicator
          aiSourceIcon.innerHTML = icon(aiResult._source !== 'rule-based' ? 'cpu' : 'activity',{size:16});
          aiSourceText.innerHTML = aiResult._source !== 'rule-based'
            ? `<span style="color:var(--accent);font-weight:600;">${AI.displayName() || 'AI'}</span> — assessment complete`
            : 'Rule-based assessment (AI unavailable)';
          aiLoadingShimmer.style.display = 'none';

          renderSOS(inc);
        }

        // Generate first-aid instructions
        const updatedInc = Store.get(state.activeId);
        if (updatedInc) {
          const firstAid = await generateFirstAidInstructions(updatedInc);
          if (firstAid) {
            $('firstAidContent').innerHTML = firstAid.replace(/\n/g, '<br/>');
            $('firstAidCard').classList.remove('hidden');
            updatedInc.log.push({ t: Date.now(), msg: 'First-aid instructions generated by AI' });
            Store.upsert(updatedInc);
            renderSOS(updatedInc);
          }
        }
      } catch (e) {
        console.warn('AI processing failed:', e);
        aiSourceIcon.innerHTML = icon('activity',{size:16});
        aiSourceText.textContent = 'Rule-based assessment (AI error)';
        aiLoadingShimmer.style.display = 'none';
      }
    } else {
      aiSourceIcon.innerHTML = icon('activity',{size:16});
      aiSourceText.textContent = 'Rule-based assessment';
      aiLoadingShimmer.style.display = 'none';
    }
  }

  /* ===================================================================
     Active SOS view + live ambulance tracking
     =================================================================== */
  let sosMap = null, driverMarker = null, ambMarker = null, routeLine = null;

  function showSOSView(inc) {
    $('view-monitor').classList.add('hidden');
    $('view-sos').classList.remove('hidden');
    conn.innerHTML = '<span class="dot" style="background:var(--critical)"></span> SOS sent';
    const support = supportForIncident(inc);
    const number = (support.emergencyNumbers && (support.emergencyNumbers.unified || support.emergencyNumbers.ambulance)) || CONFIG.EMERGENCY_NUMBER;
    $('callBtn').setAttribute('href', 'tel:' + number);
    $('callBtn').innerHTML = icon('phone',{size:17}) + ` Call ${esc(number)}`;

    if (!sosMap) {
      sosMap = L.map('sosMap', { zoomControl: false, attributionControl: false }).setView([inc.location.lat, inc.location.lng], 14);
      L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', { maxZoom: 19 }).addTo(sosMap);
      driverMarker = L.marker([inc.location.lat, inc.location.lng], { icon: emojiIcon('bike', '#dc2626') }).addTo(sosMap);
      setTimeout(() => sosMap.invalidateSize(), 150);
    }

    // black box forensic chart (frozen at impact)
    $('sosBlackBox').innerHTML = renderBlackBoxSVG(inc.blackbox || []);
    const st = bbStats(inc.blackbox || []);
    $('bbPeak').textContent = st.peakG ? `peak ${st.peakG.toFixed(1)}G · ${Math.round(st.duration)}s` : '';

    if (typeof IncidentChat !== 'undefined') {
      if ($('driverChatCard').classList.contains('hidden')) {
        $('driverChatCard').classList.remove('hidden');
        IncidentChat.create('driverChat', 'driver');
      }
    }

    renderSOS(inc);
  }

  function renderSupport(inc) {
    const support = supportForIncident(inc);
    $('contactGrid').innerHTML = support.contacts.map((c) => {
      const ok = c.status === 'notified';
      const missing = c.status === 'missing';
      const status = missing ? 'missing' : ok ? `notified ${fmtAgo(c.notifiedAt)}` : 'queued';
      return `<div class="contact-card">
        <span class="dot" style="background:${ok ? 'var(--good)' : missing ? 'var(--dim)' : 'var(--serious)'}"></span>
        <div style="flex:1;min-width:0;">
          <div style="font-weight:800;font-size:13px;">${esc(c.name)}</div>
          <div class="status">${esc(c.label)} · ${esc(status)}</div>
        </div>
        ${c.phone ? `<a class="action" href="tel:${esc(c.phone)}">${esc(c.phone)}</a>` : ''}
      </div>`;
    }).join('');

    const services = (support.services && support.services.all || []).slice(0, 5);
    $('nearbyList').innerHTML = services.map((p) => `
      <div class="support-row">
        <span class="ico-host" style="color:var(--accent)">${icon(categoryIcon(p.category), {size:18})}</span>
        <div class="main">
          <div class="name">${esc(p.name)}</div>
          <div class="meta">${esc(categoryLabel(p.category))} · ${distanceLabel(p.distanceKm)} · ${esc(p.address || 'Nearby')}</div>
        </div>
        <a class="action" target="_blank" href="https://maps.google.com/?q=${p.lat},${p.lng}">Map</a>
      </div>`).join('');

    $('lawNote').innerHTML = `<span>${icon('shield',{size:15})}</span><span>${esc(support.bystander.law)}</span>`;
    $('bystanderSteps').innerHTML = support.bystander.steps.slice(0, 6).map((step, idx) =>
      `<li><b>${idx + 1}</b><span>${esc(step)}</span></li>`).join('');
  }

  function renderSOS(inc) {
    $('sosStatusBadge').textContent = STATUS_LABEL[inc.status] || inc.status;
    $('sosStatusBadge').className = 'pill ' + (inc.status === 'RESOLVED' ? '' : 'sev-' + inc.severity);
    renderSupport(inc);

    if (typeof IncidentChat !== 'undefined') {
      IncidentChat.setIncident(inc);
    }

    // timeline
    const tl = $('timeline');
    tl.innerHTML = inc.log.slice().reverse().map((e) =>
      `<li><span class="t">${fmtTime(e.t)}</span><span>${e.msg}</span></li>`).join('');

    // ambulance + ETA
    const amb = inc.ambulance;
    if (amb) {
      $('etaWrap').classList.remove('hidden');
      $('ambName').textContent = amb.id + ' · ' + amb.hospital;
      const dist = Geo.distanceKm(amb, inc.location);
      $('ambDist').textContent = dist.toFixed(1);
      $('etaVal').textContent = inc.status === 'ARRIVED' ? '0' : Math.max(1, Math.round(Geo.etaMin(dist)));
      if (sosMap) {
        if (!ambMarker) ambMarker = L.marker([amb.lat, amb.lng], { icon: emojiIcon('ambulance', '#0d9488') }).addTo(sosMap);
        else ambMarker.setLatLng([amb.lat, amb.lng]);
        const pts = [[amb.lat, amb.lng], [inc.location.lat, inc.location.lng]];
        if (!routeLine) routeLine = L.polyline(pts, { color: '#00d0b0', weight: 3, dashArray: '6,8' }).addTo(sosMap);
        else routeLine.setLatLngs(pts);
      }
    }
    if (inc.status === 'ARRIVED') $('sosSub').textContent = 'Ambulance has arrived on scene';
    if (inc.status === 'RESOLVED') $('sosSub').textContent = 'Incident resolved. Stay safe.';
  }

  function emojiIcon(name, color) {
    return L.divIcon({
      className: '', iconSize: [34, 34], iconAnchor: [17, 17],
      html: `<div style="width:34px;height:34px;display:grid;place-items:center;color:${color};
             background:#fff;border:2px solid ${color};border-radius:50%;box-shadow:0 3px 8px rgba(80,95,120,.35);">${icon(name, { size: 18 })}</div>`,
    });
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  // reflect dispatch-side updates in real time
  Store.subscribe(() => {
    if (!state.activeId) return;
    const inc = Store.get(state.activeId);
    if (inc) renderSOS(inc);
  });

  $('safeBtn').addEventListener('click', () => {
    if (state.activeId) {
      const inc = Store.get(state.activeId);
      if (inc) {
        inc.status = 'RESOLVED';
        inc.log.push({ t: Date.now(), msg: 'Rider marked themselves safe' });
        Store.upsert(inc);
      }
    }
    state.activeId = null;
    $('view-sos').classList.add('hidden');
    $('view-monitor').classList.remove('hidden');
    setArmed(state.armed);
  });

  /* ---------- init ---------- */
  buildSensitivity();
  setArmed(false);
  renderGauges();
  renderInstruments();
  renderSentinel();
  initMonitorMap();
  startBatteryMonitor();

  // Update AI badge in topbar based on AI status
  (function updateAiBadge() {
    const dot = $('aiDot'), label = $('aiLabel'), badge = $('aiBadge');
    if (AI.isEnabled()) {
      dot.style.background = 'var(--accent, #7C3AED)';
      label.textContent = AI.displayName() || 'AI';
      badge.classList.add('ai-badge-connected');
    } else {
      dot.style.background = 'var(--dim)';
      label.textContent = 'Rule-based';
      badge.classList.remove('ai-badge-connected');
    }
  })();
})();
