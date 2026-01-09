(() => {
   let lastFrameT = performance.now();
   let pinchStartDist = null;
   let pinchStartRange = null;


   const APP_VERSION = "2.3.5.3";
   const BUILD_DATE = "2026-01-04";

   console.log(
      `%c Radar App v${APP_VERSION} %c Build: ${BUILD_DATE} `,
      "background: #007bff; color: white; font-weight: bold; border-radius: 3px 0 0 3px;",
      "background: #343a40; color: #adb5bd; border-radius: 0 3px 3px 0;"
   );

   // 2.3.6  Selecteer target door touch, klik of pijl omhoog / omlaag
   // 2.3.5  Name toegevoegd aan scherm, pinch to zoom, default vector en label, 
   // 2.3.4  Label en debug info afhankelijk gemaakt van target DANGER 

   const el = (id) => document.getElementById(id);

   const canvas = el("radar");
   const ctx = canvas.getContext("2d", {
      alpha: false
   });

   const statusEl = el("status");
   const ownText = el("ownText");
   const countText = el("countText");
   const fpsText = el("fpsText");
   const targetList = el("targetList");

   const rangeInput = el("range");
   const rangeVal = el("rangeVal");
   const vectorsInput = el("vectors");
   const labelsInput = el("labels");
   const recenterBtn = el("recenter");
   const pauseBtn = el("pause");

   // Danger controls
   const dangerEnableEl = el("dangerEnable");
   const cpaEl = el("cpa");
   const tcpaEl = el("tcpa");
   const cpaValEl = el("cpaVal");
   const tcpaValEl = el("tcpaVal");

   // Debug
   const debugEl = el("debug") || null;

   const state = {
      paused: false,
      rangeNm: 2.0,
      showVectors: true,
      showLabels: true,

      dangerEnabled: true,
      cpaThreshNm: 0.5,
      tcpaThreshMin: 15,

      debug: false,

      selectedId: null,

      own: {
         lat: null,
         lon: null,
         sogKn: 0,
         cogDeg: 0,
         name: "Own"
      },
      targets: new Map(),
      lastRender: [],
      showLights: true
   };

   const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
   const rad = (d) => (d * Math.PI) / 180;
   const deg = (r) => (r * 180) / Math.PI;

   canvas.addEventListener("touchstart", (e) => {
      if (e.touches.length === 2) {
         e.preventDefault();
         pinchStartDist = touchDistance(e.touches[0], e.touches[1]);
         pinchStartRange = state.rangeNm;
      }
   }, {
      passive: false
   });

   canvas.addEventListener("touchmove", (e) => {
      if (e.touches.length === 2 && pinchStartDist) {
         e.preventDefault();
         const d = touchDistance(e.touches[0], e.touches[1]);
         const scale = d / pinchStartDist;

         // zoom in = vingers uit elkaar → kleinere range
         const newRange = clamp(
            pinchStartRange / scale,
            0.25,
            24
         );

         setRange(newRange);
      }
   }, {
      passive: false
   });

   canvas.addEventListener("touchend", (e) => {
      if (e.touches.length < 2) {
         pinchStartDist = null;
         pinchStartRange = null;
      }
   });


   function resize() {
      const dpr = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      canvas.width = Math.max(1, Math.floor(rect.width * dpr));
      canvas.height = Math.max(1, Math.floor(rect.height * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
   }

   function relMeters(lat0, lon0, lat, lon) {
      const mPerDegLat = 110540;
      const mPerDegLon = 111320 * Math.cos(rad(lat0));
      const dy = (lat - lat0) * mPerDegLat;
      const dx = (lon - lon0) * mPerDegLon;
      return {
         dx,
         dy
      };
   }

   function rangeNmFromMeters(m) {
      return m / 1852;
   }

   function metersFromNm(nm) {
      return nm * 1852;
   }

   function bearingDeg(dx, dy) {
      // brad is Bearing in Radials
      // bdeg is bearing in Degrees
      const brad = Math.atan2(dx, dy);
      let bdeg = deg(brad);
      if (bdeg < 0) bdeg += 360;
      return bdeg;
   }

   function polarToScreen(rangeNm, bearing, maxRangeNm, cx, cy, radiusPx) {
      // te doen: controleer if bearing in Degrees of Radials is.
      const r = (rangeNm / maxRangeNm) * radiusPx;
      const a = rad(bearing - 90);
      return {
         x: cx + r * Math.cos(a),
         y: cy + r * Math.sin(a)
      };
   }

   function formatKn(kn) {
      return (kn ?? 0).toFixed(1);
   }

   function formatNm(nm) {
      return (nm ?? 0).toFixed(2);
   }

   function formatMin(min) {
      return (min ?? 0).toFixed(1);
   }

   function velFromCogSog(cogDeg, sogKn) {
      const v = (sogKn || 0) / 1.943844; // m/s
      const a = rad(cogDeg || 0);
      return {
         ve: v * Math.sin(a),
         vn: v * Math.cos(a)
      };
   }

   function scoreCPA(cpaNm, threshNm) {
      if (!isFinite(cpaNm)) return 0;
      return clamp(1 - (cpaNm / threshNm), 0, 1);
   }

   function scoreTCPA(tcpaMin, threshMin) {
      if (!isFinite(tcpaMin) || tcpaMin < 0) return 0;
      return clamp(1 - (tcpaMin / threshMin), 0, 1);
   }
   /* function scoreCpaAspect(cpaDx, cpaDy) {
   if (!isFinite(cpaDx) || !isFinite(cpaDy)) return 0;

   // bearing van CPA-punt (0° = voor)
   const brg = (bearingDeg(cpaDx, cpaDy) + 360) % 360;

   // hoek t.o.v. boeg (0 = recht vooruit)
   const rel = Math.min(
      Math.abs(brg),
      Math.abs(brg - 360)
   );

   // voor / dwars (0–90°) → hoog, achter → laag
   return clamp(1 - (rel / 120), 0, 1);
   } */


   function scoreApproach(it, state) {
      // 1. Validatie van data (inclusief eigen schip gegevens uit 'state')
      if (!it.t || !isFinite(it.t.sogKn) || !isFinite(it.t.cogDeg) ||
         !isFinite(state.ownSogKn) || !isFinite(state.ownCogDeg) ||
         !isFinite(it.brg)) return 0;

      const toRad = Math.PI / 180;

      // 2. Ontbind de vectoren van beide schepen naar X en Y (Noord/Oost componenten)
      const targetVx = it.t.sogKn * Math.sin(it.t.cogDeg * toRad);
      const targetVy = it.t.sogKn * Math.cos(it.t.cogDeg * toRad);

      const ownVx = state.ownSogKn * Math.sin(state.ownCogDeg * toRad);
      const ownVy = state.ownSogKn * Math.cos(state.ownCogDeg * toRad);

      // 3. Bereken de relatieve snelheidsvector (hoe beweegt het target t.o.v. jou)
      const relVx = targetVx - ownVx;
      const relVy = targetVy - ownVy;

      // 4. Bereken de Range Rate (Vre)
      // Dit is de projectie van de relatieve snelheid op de peilinglijn (bearing)
      // Een positieve Vre betekent dat de afstand toeneemt (verwijderen)
      // Een negatieve Vre betekent dat de afstand afneemt (naderen)
      const brgRad = it.brg * toRad;
      const rangeRate = (relVx * Math.sin(brgRad)) + (relVy * Math.cos(brgRad));

      // 5. Normalisatie tussen 0 en 1
      // We bepalen de maximale relatieve snelheid om te schalen (bijv. 40 knopen)
      const maxRelSpeed = Math.max(20, Math.hypot(relVx, relVy));

      // Schaal rangeRate van [-maxRelSpeed, +maxRelSpeed] naar [1, 0]
      // Hoe negatiever de rangeRate (sneller naderen), hoe dichter bij 1.
      let score = 0.5 - (rangeRate / (maxRelSpeed * 2));

      return Math.max(0, Math.min(1, score));
   }

   function staleAlpha(ageSec, startSec, fullSec) {
      if (!isFinite(ageSec) || ageSec <= startSec) return 1;
      if (ageSec >= fullSec) return 0.25;
      const t = (ageSec - startSec) / (fullSec - startSec);
      return 1 - 0.75 * t; // 1 -> 0.25
   }
   /**
    * Berekent de beste tekstpositie t.o.v. het middelpunt van het canvas.
    * @param {number} x - De X-positie van het object (target/tickmark).
    * @param {number} y - De Y-positie van het object.
    * @param {number} cx - Centrum X van het canvas (ownship).
    * @param {number} cy - Centrum Y van het canvas (ownship).
    * @param {number} offset - Afstand tussen het punt en de tekst (standaard 5px).
    */

   function getLabelAlignment(x, y, cx, cy, offset = 5) {
      const align = {
         textAlign: "center",
         textBaseline: "middle",
         drawX: x,
         drawY: y
      };

      // Horizontale uitlijning: duw weg van het centrum
      if (x > cx + 1) { // Rechts van het midden
         align.textAlign = "left";
         align.drawX = x + offset;
      } else if (x < cx - 1) { // Links van het midden
         align.textAlign = "right";
         align.drawX = x - offset;
      } else {
         align.textAlign = "center";
      }

      // Verticale uitlijning: duw weg van het centrum
      if (y > cy + 1) { // Onder het midden
         align.textBaseline = "top";
         align.drawY = y + offset;
      } else if (y < cy - 1) { // Boven het midden
         align.textBaseline = "bottom";
         align.drawY = y - offset;
      } else {
         align.textBaseline = "middle";
      }

      return align;
   }

   function criticalityScore_oud(it, state) {
      if (!it.cpaNm || !it.tcpaMin) return 0;

      const sCpa = scoreCPA(it.cpaNm, state.cpaThreshNm);
      const sTcpa = scoreTCPA(it.tcpaMin, state.tcpaThreshMin);
      //const sAsp   = scoreCpaAspect(it.cpaDx, it.cpaDy);
      const sAsp = scoreApproach(it, state);

      // gewichten 
      const wCpa = 0.25;
      const wTcpa = 0.25;
      const wAsp = 0.50;

      return clamp(
         wCpa * sCpa +
         wTcpa * sTcpa +
         wAsp * sAsp,
         0, 1
      );
   }

   // Gebaseerd op de Collision Risk Index (CRI)
   // Waarom deze aanpak?
   // Niet-lineair: Risico is niet lineair; een target op 0.2 NM is vele malen gevaarlijker dan op 0.4 NM. De exponentiële functie (\(e^{-x}\)) bootst dit menselijke gevoel van urgentie na.
   // Samenhang: Een kleine CPA is niet gevaarlijk als de TCPA nog 30 minuten is. Een kleine TCPA is niet gevaarlijk als de CPA 5 mijl is. Deze functie vereist dat beide factoren ongunstig zijn voordat de score naar 1 (Rood) gaat.
   // Toekomstbestendig: Voor autonoom varen in 2026 wordt vaak deze "Collision Risk Index" gebruikt om prioriteit te geven aan objecten in drukke verkeersgebieden.
   function criticalityScore_oud2(it, state) {
      //  const dSafe = 1.0;  // Minimale veilige CPA in zeemijl
      //  const tSafe = 12.0; // Minimale veilige TCPA in minuten

      const dSafe = state.cpaThreshNm; // Minimale veilige CPA in zeemijl
      const tSafe = state.tcpaThreshMin; // Minimale veilige TCPA in minuten

      // Alleen naderende targets zijn kritiek (zie vorige discussie over Range Rate)
      // Als it.tcpaMin (absolute waarde) groot is, is het risico laag.

      // Ruimte component (0-1)
      const riskCPA = Math.exp(-Math.log(2) * Math.pow(it.cpaNm / dSafe, 2));

      // Tijd component (0-1)
      const riskTCPA = Math.exp(-Math.log(2) * Math.pow(it.tcpaMin / tSafe, 2));

      // Gecombineerde Criticality (Wortel van gewogen kwadraten)
      // We wegen CPA vaak zwaarder (bijv. 60/40) omdat afstand fataal is.
      const K = Math.sqrt(0.6 * Math.pow(riskCPA, 2) + 0.4 * Math.pow(riskTCPA, 2));

      return Math.max(0, Math.min(1, K));
   }

   // Houdt rekening met stilliggers. En met naderend versus weglopend.
   function criticalityScore(it, state) {
      const dSafe = state.cpaThreshNm; // Minimale veilige CPA in zeemijl
      const tSafe = state.tcpaThreshMin; // Minimale veilige TCPA in minuten

      // 1. Ruimtelijk en Tijdsrisico (zoals eerder)
      const riskCPA = Math.exp(-Math.log(2) * Math.pow(it.cpaNm / dSafe, 2));
      const riskTCPA = Math.exp(-Math.log(2) * Math.pow(it.tcpaMin / tSafe, 2));

      // Basis kritikaliteit
      let K = Math.sqrt(0.6 * Math.pow(riskCPA, 2) + 0.4 * Math.pow(riskTCPA, 2));

      // 2. De "Expert" Correctie: Relative Approach Factor
      // Bereken de Range Rate (Vre): negatief is naderen, positief is verwijderen
      const toRad = Math.PI / 180;
      const relVx = (it.sogKn * Math.sin(it.cogDeg * toRad)) - (state.ownSogKn * Math.sin(state.ownCogDeg * toRad));
      const relVy = (it.sogKn * Math.cos(it.cogDeg * toRad)) - (state.ownSogKn * Math.cos(state.ownCogDeg * toRad));
      const rangeRate = (relVx * Math.sin(it.brg * toRad)) + (relVy * Math.cos(it.brg * toRad));

      if (rangeRate > 0.5) {
         // TARGET VERWIJDERT ZICH: Afstand wordt groter
         // We verlagen de score drastisch, ongeacht CPA of positie
         K *= 0.1;
      } else if (rangeRate < -0.5) {
         // TARGET NADERT: Afstand wordt kleiner
         const relBrg = ((it.brg - state.ownCogDeg + 180 + 360) % 360) - 180;

         if (Math.abs(relBrg) > 90) {
            // Hij komt van achteren dichterbij (Inhaler)
            // Geef hem een significante score, maar iets minder dan vooruit
            K *= 0.8;
         } else {
            // Hij komt van voren/opzij dichterbij
            K *= 1.2;
         }
      } else {
         // Range blijft min of meer gelijk
         K *= 0.5;
      }

      return Math.max(0, Math.min(1, K));
   }

   function colorFromCriticality(d, alpha = 0.95) {
      if (d > 0.66) return `rgba(255,93,93,${alpha})`; // rood
      if (d > 0.33) return `rgba(255,215,94,${alpha})`; // geel
      return `rgba(88,255,143,${alpha})`; // groen
   }

   function drawNavLights(ctx, p, cogDeg, opts = {}) {
      const r = opts.r ?? 2.2; // radius bolletje
      const offsetBow = opts.bow ?? 7; // afstand vóór target (boeg)
      const offsetStern = opts.stern ?? 8; // afstand achter target (achterschip)
      const spread = opts.spread ?? 4.5; // links/rechts afstand bij boeg
      const alpha = opts.alpha ?? 0.85;

      // richting op scherm (zelfde als je vector-code)
      const a = rad((cogDeg || 0) - 90);
      const fx = Math.cos(a),
         fy = Math.sin(a); // forward unit
      const rx = Math.cos(a + Math.PI / 2),
         ry = Math.sin(a + Math.PI / 2); // right unit

      // Boegpunt (voor) en achterschip (achter)
      const bowX = p.x + fx * offsetBow;
      const bowY = p.y + fy * offsetBow;

      const sternX = p.x - fx * offsetStern;
      const sternY = p.y - fy * offsetStern;

      // Posities: port (links aan boeg), starboard (rechts aan boeg), stern light (achter)
      const port = {
         x: bowX - rx * spread,
         y: bowY - ry * spread
      }; // rood
      const starboard = {
         x: bowX + rx * spread,
         y: bowY + ry * spread
      }; // groen
      const stern = {
         x: sternX,
         y: sternY
      }; // wit

      ctx.save();
      ctx.globalAlpha *= alpha;

      // klein randje voor contrast
      ctx.strokeStyle = "rgba(0,0,0,.35)";
      ctx.lineWidth = 1;

      // port red
      ctx.fillStyle = "rgba(255,93,93,1)";
      ctx.beginPath();
      ctx.arc(port.x, port.y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();

      // starboard green
      ctx.fillStyle = "rgba(88,255,143,1)";
      ctx.beginPath();
      ctx.arc(starboard.x, starboard.y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();

      // stern white
      ctx.fillStyle = "rgba(255,255,255,1)";
      ctx.beginPath();
      ctx.arc(stern.x, stern.y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();

      ctx.restore();
   }

   function computeCpaTcpa(own, tgt) {
      // Guard: need positions
      if (!(typeof own.lat === "number" && typeof own.lon === "number")) return null;
      if (!(typeof tgt.lat === "number" && typeof tgt.lon === "number")) return null;

      // Relatieve positie r (meters): target t.o.v. ownship
      const r = relMeters(own.lat, own.lon, tgt.lat, tgt.lon);

      // Absolute snelheidsvectoren (m/s) uit COG/SOG
      const vo = velFromCogSog(own.cogDeg, own.sogKn);
      const vt = velFromCogSog(tgt.cogDeg, tgt.sogKn);

      // Relatieve snelheid v_rel = v_target − v_own
      const vrx = vt.ve - vo.ve;
      const vry = vt.vn - vo.vn;

      // Dot product r·v en |v|²
      const rdotv = r.dx * vrx + r.dy * vry;
      const v2 = vrx * vrx + vry * vry;

      // Geen (relatieve) beweging → CPA = huidige afstand
      if (v2 < 1e-6) {
         const dist = Math.hypot(r.dx, r.dy);
         return {
            cpaNm: rangeNmFromMeters(dist),
            tcpaMin: Infinity,
            tcpaSec: Infinity,
            cpaDx: r.dx, // meters east
            cpaDy: r.dy // meters north
         };
      }

      // Tijd tot CPA (seconden), niet in het verleden
      let t = -rdotv / v2;
      if (t < 0) t = 0;

      // Relatieve positie bij CPA
      const cpx = r.dx + vrx * t;
      const cpy = r.dy + vry * t;

      // CPA-afstand
      const cpaM = Math.hypot(cpx, cpy);

      return {
         cpaNm: rangeNmFromMeters(cpaM),
         tcpaMin: t / 60,
         tcpaSec: t,
         cpaDx: cpx, // meters east at CPA
         cpaDy: cpy // meters north at CPA
      };
   }

   function computeCpaTcpa_v1(own, tgt) {
      if (!(typeof own.lat === "number" && typeof own.lon === "number")) return null;
      if (!(typeof tgt.lat === "number" && typeof tgt.lon === "number")) return null;

      const r = relMeters(own.lat, own.lon, tgt.lat, tgt.lon);
      const vo = velFromCogSog(own.cogDeg, own.sogKn);
      const vt = velFromCogSog(tgt.cogDeg, tgt.sogKn);

      const vrx = vt.ve - vo.ve;
      const vry = vt.vn - vo.vn;

      const rdotv = r.dx * vrx + r.dy * vry;
      const v2 = vrx * vrx + vry * vry;

      if (v2 < 1e-6) {
         const dist = Math.hypot(r.dx, r.dy);
         return {
            cpaNm: rangeNmFromMeters(dist),
            tcpaMin: Infinity
         };
      }

      let t = -rdotv / v2; // seconds
      if (t < 0) t = 0;

      const cpx = r.dx + vrx * t;
      const cpy = r.dy + vry * t;
      const cpaM = Math.hypot(cpx, cpy);

      return {
         cpaNm: rangeNmFromMeters(cpaM),
         tcpaMin: t / 60
      };
   }

   function touchDistance(t1, t2) {
      const dx = t1.clientX - t2.clientX;
      const dy = t1.clientY - t2.clientY;
      return Math.hypot(dx, dy);
   }

   function wsUrl(subscribe = "all") {
      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      return `${proto}//${location.host}/signalk/v1/stream?subscribe=${encodeURIComponent(subscribe)}`;
   }

   async function fetchPluginConfig() {
      const r = await fetch("/plugins/ais-radar-standalone/config", {
         credentials: "include"
      }).catch(() => null);
      if (!r || !r.ok) return null;
      return await r.json();
   }

   function withTimeout(promise, ms) {
      return Promise.race([
         promise,
         new Promise((resolve) => setTimeout(() => resolve(null), ms))
      ]);
   }

   async function getJson(path) {
      const r = await fetch(path, {
         credentials: "include"
      });
      if (!r || !r.ok) return null;
      return await r.json().catch(() => null);
   }

   async function primeOwnshipFromRest() {
      const pos = await getJson("/signalk/v1/api/vessels/self/navigation/position");
      if (pos && typeof pos.latitude === "number" && typeof pos.longitude === "number") {
         state.own.lat = pos.latitude;
         state.own.lon = pos.longitude;
      }
      const cog = await getJson("/signalk/v1/api/vessels/self/navigation/courseOverGroundTrue");
      if (typeof cog === "number") state.own.cogDeg = (deg(cog) + 360) % 360;

      const sog = await getJson("/signalk/v1/api/vessels/self/navigation/speedOverGround");
      if (typeof sog === "number") state.own.sogKn = sog * 1.943844;

      const name = await getJson("/signalk/v1/api/vessels/self/name");
      if (typeof name === "string") state.own.name = name;
   }

   let ws = null;
   let backoff = 500;

   async function connect() {
      const cfg = await fetchPluginConfig();
      const subscribe = (cfg && cfg.subscribe) ? cfg.subscribe : "all";

      if (cfg) {
         if (typeof cfg.defaultRangeNm === "number") state.rangeNm = cfg.defaultRangeNm;
         state.showVectors = !!cfg.showVectorsDefault;
         state.showLabels = !!cfg.showLabelsDefault;
      }

      rangeInput.value = String(state.rangeNm);
      rangeVal.textContent = state.rangeNm.toFixed(2);
      vectorsInput.checked = state.showVectors;
      labelsInput.checked = state.showLabels;

      dangerEnableEl.checked = state.dangerEnabled;
      cpaEl.value = String(state.cpaThreshNm);
      tcpaEl.value = String(state.tcpaThreshMin);
      cpaValEl.textContent = state.cpaThreshNm.toFixed(2);
      tcpaValEl.textContent = state.tcpaThreshMin.toFixed(0);

      if (debugEl) debugEl.checked = state.debug;

      await primeOwnshipFromRest();

      statusEl.textContent = `Connecting (${subscribe})…`;
      statusEl.style.color = "";

      ws = new WebSocket(wsUrl(subscribe));

      ws.onopen = () => {
         backoff = 500;
         statusEl.textContent = `Connected (${subscribe})`;
         statusEl.style.color = "var(--good)";
      };

      ws.onclose = () => {
         statusEl.textContent = "Disconnected — retrying…";
         statusEl.style.color = "var(--warn)";
         scheduleReconnect();
      };

      ws.onmessage = (ev) => {
         if (state.paused) return;
         try {
            ingestDelta(JSON.parse(ev.data));
         } catch (_) {}
      };
   }

   function scheduleReconnect() {
      if (ws) {
         try {
            ws.close();
         } catch (_) {}
      }
      ws = null;
      const wait = backoff;
      backoff = clamp(backoff * 1.6, 500, 8000);
      setTimeout(connect, wait);
   }

   function ingestDelta(delta) {
      if (!delta || !delta.updates || !delta.context) return;

      const ctxStr = String(delta.context);
      const parts = ctxStr.split(".");
      if (parts[0] !== "vessels") return;

      const id = parts.slice(1).join(".");
      const isSelf = id === "self";

      let treatAsSelf = isSelf;
      for (const upd of delta.updates) {
         if (upd && upd.source && upd.source.label === "manual-ownship") {
            treatAsSelf = true;
            break;
         }
      }

      const rec = treatAsSelf ?
         state.own :
         (state.targets.get(id) || {
            lat: null,
            lon: null,
            sogKn: 0,
            cogDeg: 0,
            name: "",
            lastSeen: 0
         });

      for (const upd of delta.updates) {
         const vals = upd.values || [];
         for (const v of vals) {
            const p = v.path;
            const val = v.value;

            if (p === "navigation.position" && val && typeof val.latitude === "number" && typeof val.longitude === "number") {
               rec.lat = val.latitude;
               rec.lon = val.longitude;
            } else if (p === "navigation.courseOverGroundTrue" && typeof val === "number") {
               rec.cogDeg = (deg(val) + 360) % 360;
            } else if (p === "navigation.speedOverGround" && typeof val === "number") {
               rec.sogKn = val * 1.943844;
            } else if (p === "name" && typeof val === "string") {
               rec.name = val;
               // console.debug("Check 1 - name found " , rec)
            } else if (p === "mmsi" && typeof val === "string") {
               rec.mmsi = val;
            }
            // Check 2: Pad is leeg en value is een object met een name (Heel gebruikelijk in SK)
            else if (p === "" && val && typeof val.name === "string") {
               rec.name = val.name;
               // console.debug("Check 2 - Name found in root object:", val.name);
            }

            // Check 3: Soms zit het in "config.name" of "notifications" gerelateerde paden
            else if (p.endsWith(".name") && typeof val === "string") {
               rec.name = val;
               // console.debug("Check 3: ", p, val)
            }
         }
      }
      //console.debug(rec)
      rec.lastSeen = Date.now();
      if (treatAsSelf) state.own = rec;
      else state.targets.set(id, rec);
   }

   let lastFpsT = performance.now();
   let frames = 0;
   let lastListT = 0;

   function drawConeOfDanger(cx, cy, radius, own) {
      if (!state.dangerEnabled) return;

      const tcpaS = state.tcpaThreshMin * 60;
      const sogMs = (own.sogKn || 0) / 1.943844;
      const forwardM = sogMs * tcpaS;
      const widthM = metersFromNm(state.cpaThreshNm);

      // Als we stilliggen of de drempels zijn nul, tekenen we niets
      if (forwardM < 5 || widthM <= 0) return;

      const pxPerMeter = radius / metersFromNm(state.rangeNm);
      const forwardPx = forwardM * pxPerMeter;

      // Bereken de openingshoek van de taartpunt op basis van de CPA drempel
      // We gebruiken de tangens (overstaande zijde / aanliggende zijde)
      const halfAngle = Math.atan2(widthM, forwardM);

      // De koers van het eigen schip (omgezet naar radialen voor Canvas)
      const shipAngleRad = rad((own.cogDeg || 0) - 90);

      ctx.fillStyle = "rgba(255,93,93,.12)";
      ctx.strokeStyle = "rgba(255,93,93,.22)";
      ctx.lineWidth = 1;

      ctx.beginPath();
      // 1. Begin in het midden (positie van eigen schip)
      ctx.moveTo(cx, cy);

      // 2. Teken de boog (de "taart-korst")
      // arc(x, y, straal, startHoek, eindHoek)
      ctx.arc(
         cx,
         cy,
         forwardPx,
         shipAngleRad - halfAngle,
         shipAngleRad + halfAngle
      );

      // 3. Sluit de boog terug naar het midden
      ctx.lineTo(cx, cy);

      ctx.fill();
      ctx.stroke();
   }

   function draw() {

      const t_update_frame = performance.now();
      const delta = t_update_frame - lastFrameT;

      // Throttle: 1000ms = 1 fps, 500ms = 2 fps
      if (delta < 500) {
         requestAnimationFrame(draw);
         return;
      }

      lastFrameT = t_update_frame; // Update de tijdstempel


      const w = canvas.clientWidth;
      const h = canvas.clientHeight;

      ctx.fillStyle = "#0a0f14";
      ctx.fillRect(0, 0, w, h);

      const cx = w * 0.5,
         cy = h * 0.5;
      const radius = Math.min(w, h) * 0.46;

      ctx.strokeStyle = "rgba(255,255,255,.12)";
      ctx.lineWidth = 1;

      // teken de cirkels
      for (let i = 1; i <= 4; i++) {
         ctx.beginPath();
         ctx.arc(cx, cy, (radius * i) / 4, 0, Math.PI * 2);
         ctx.stroke();

         label_range_nm = String(state.rangeNm * i / 4)
         ctx.fillStyle = "rgba(255,255,255,.6)";
         ctx.font = "12px ui-monospace, monospace";

         const labelPos = getLabelAlignment(cx, cy + (radius * i) / 4, cx, cy, 8);
         ctx.textAlign = labelPos.textAlign;
         ctx.textBaseline = labelPos.textBaseline;
         ctx.fillText(label_range_nm + " NM", labelPos.drawX, labelPos.drawY);

         const labelPos2 = getLabelAlignment(cx, cy - (radius * i) / 4, cx, cy, 8);
         ctx.textAlign = labelPos2.textAlign;
         ctx.textBaseline = labelPos2.textBaseline;
         ctx.fillText(label_range_nm + " NM", labelPos2.drawX, labelPos2.drawY);
      }

      // teken de assen
      ctx.beginPath();
      ctx.moveTo(cx - radius, cy);
      ctx.lineTo(cx + radius, cy);
      // ctx.moveTo(cx, cy - radius);
      // ctx.lineTo(cx, cy + radius);
      ctx.stroke();

      // teken de labels op de gradenboog
      for (let a = 0; a < 360; a += 30) {
         if (a != 0 && a != 180) {
            const p1 = polarToScreen(state.rangeNm, a, state.rangeNm, cx, cy, radius);
            const p0 = polarToScreen(state.rangeNm * 0.94, a, state.rangeNm, cx, cy, radius);
            ctx.beginPath();
            ctx.moveTo(p0.x, p0.y);
            ctx.lineTo(p1.x, p1.y);
            ctx.stroke();
            ctx.fillStyle = "rgba(255,255,255,.6)";
            ctx.font = "12px ui-monospace, monospace";
            const labelPos3 = getLabelAlignment(p1.x, p1.y, cx, cy, 8);
            ctx.textAlign = labelPos3.textAlign;
            ctx.textBaseline = labelPos3.textBaseline;
            ctx.fillText(String(a) + "°", labelPos3.drawX, labelPos3.drawY);
         }
      }

      const own = state.own;
      const haveOwn = typeof own.lat === "number" && typeof own.lon === "number";

      // teken eigen gevaren driehoek
      if (haveOwn) drawConeOfDanger(cx, cy, radius, own);

      ctx.fillStyle = "rgba(86,183,255,.95)";
      ctx.beginPath();
      ctx.arc(cx, cy, 6, 0, Math.PI * 2);
      ctx.fill();
      if (state.showVectors) {
         const vecNm = (own.sogKn || 0) * (6 / 60); // 6 min lookahead
         const lenPx = (vecNm / state.rangeNm) * radius;
         const a = rad((own.cogDeg || 0) - 90);
         const p2 = {
            x: cx + lenPx * Math.cos(a),
            y: cy + lenPx * Math.sin(a)
         };
         ctx.strokeStyle = "rgba(86,183,255,.7)";
         ctx.beginPath();
         ctx.moveTo(cx, cy);
         ctx.lineTo(p2.x, p2.y);
         ctx.stroke();
      }

      // ======================================================
      // reken alle targets door (en zet de info in render[])
      // ======================================================
      const now = Date.now();
      const render = [];
      if (haveOwn) {
         for (const [id, t] of state.targets.entries()) {
            if (!(typeof t.lat === "number" && typeof t.lon === "number")) continue;
            if (now - (t.lastSeen || 0) > 6 * 60 * 1000) continue;

            const {
               dx,
               dy
            } = relMeters(own.lat, own.lon, t.lat, t.lon);
            const rngNm = rangeNmFromMeters(Math.hypot(dx, dy));
            if (rngNm > state.rangeNm) continue;

            const brg = bearingDeg(dx, dy);
            const cpa = computeCpaTcpa(own, t);
            const cpaNm = cpa ? cpa.cpaNm : null;
            const tcpaMin = cpa ? cpa.tcpaMin : null;

            const isDanger = !!(state.dangerEnabled && cpa && (cpaNm <= state.cpaThreshNm) && (tcpaMin <= state.tcpaThreshMin));
            const label = (t.name && typeof t.name === "string") ? t.name : id;

            const d = criticalityScore({
                  cpaNm,
                  tcpaMin,
                  cpaDx: cpa ? cpa.cpaDx : null,
                  cpaDy: cpa ? cpa.cpaDy : null
               },
               state
            );
            render.push({
               id,
               t,
               rngNm,
               brg,
               cpaNm,
               tcpaMin,
               d,
               isDanger,
               label,
               cpaDx: cpa ? cpa.cpaDx : null,
               cpaDy: cpa ? cpa.cpaDy : null
            });
         }
      }

      // sorteer op CPA
      // render.sort((a, b) => (a.cpaNm ?? 1e9) - (b.cpaNm ?? 1e9));

      // sorteer op criticality score d
      render.sort((a, b) =>
         (b.d ?? 0) - (a.d ?? 0) ||
         (a.cpaNm ?? 1e9) - (b.cpaNm ?? 1e9)
      );

      state.lastRender = render;

      const pulse = 0.5 + 0.5 * Math.sin((performance.now() / 1000) * Math.PI * 2 * 1.2);
      const dangerFill = `rgba(255,93,93,${0.35 + 0.55 * pulse})`;
      //===========================================================
      // teken targets op het scherm
      //===========================================================
      for (const it of render) {
         const aStale = staleAlpha(it.ageSec, state.staleFadeStartSec, state.staleFadeFullSec);
         const isStale = isFinite(it.ageSec) && it.ageSec > state.staleFadeStartSec;

         /*          const p = polarToScreen(it.rngNm, it.brg, state.rangeNm, cx, cy, radius);
                     const selected = state.selectedId === it.id;

                     let fill;

                     // bepaal kleur van de targets
                     if (it.isDanger) fill = dangerFill;
                     else {
                        const d = 1 - clamp(it.rngNm / state.rangeNm, 0, 1);
                        fill = d > 0.66 ? "rgba(255,93,93,.95)" : d > 0.33 ? "rgba(255,215,94,.95)" : "rgba(88,255,143,.9)";
                     }
                     ctx.fillStyle = fill;

                     ctx.beginPath();
                     ctx.arc(p.x, p.y, selected ? 6 : 4, 0, Math.PI * 2);
                     ctx.fill(); */

         const p = polarToScreen(it.rngNm, it.brg, state.rangeNm, cx, cy, radius);

         ctx.save();
         ctx.globalAlpha = aStale;
         if (isStale) ctx.setLineDash([4, 4]);
         const selected = state.selectedId === it.id;

         let fill;
         if (it.isDanger) {
            fill = dangerFill;
         } else {
            const d = criticalityScore(it, state);
            fill = colorFromCriticality(d);
            if (!isFinite(it.d)) console.log("BAD d", it.id, it.d, it.cpaNm, it.tcpaMin);

            // fill = d > 0.66 ? "rgba(255,93,93,.95)" : d > 0.33 ? "rgba(255,215,94,.95)" : "rgba(88,255,143,.9)";
         }
         ctx.fillStyle = fill;

         ctx.beginPath();
         ctx.arc(p.x, p.y, selected ? 6 : 4, 0, Math.PI * 2);
         ctx.fill();


         // rondje om geselecteerde target
         // CPA punt + COA cirkel
         if (selected) {
            ctx.strokeStyle = "rgba(255,255,255,.45)";
            ctx.beginPath();
            ctx.arc(p.x, p.y, 10, 0, Math.PI * 2);
            // state.showLights = true
            if (state.showLights && it.t && isFinite(it.t.cogDeg) && (it.t.sogKn || 0) > 0.3) {
               // alleen als hij beweegt (anders is oriëntatie meaningless)
               drawNavLights(ctx, p, it.t.cogDeg, {
                  alpha: 0.8
               });
            }
            ctx.stroke();

            // CPA point + CPA circle (dangerous targets)
            // if (it.isDanger && it.cpaNm != null && typeof it.cpaDx === "number" && typeof it.cpaDy === "number") {
            // if (it.cpaNm != null && typeof it.cpaDx === "number" && typeof it.cpaDy === "number") {
            //    const cpaRngNm = rangeNmFromMeters(Math.hypot(it.cpaDx, it.cpaDy));
            //    const cpaBrg = bearingDeg(it.cpaDx, it.cpaDy);
            //    const cpaP = polarToScreen(cpaRngNm, cpaBrg, state.rangeNm, cx, cy, radius);
            //    const cpaRadPx = (it.cpaNm / state.rangeNm) * radius;

            //    ctx.save();
            //    ctx.strokeStyle = `rgba(255,93,93,${0.20 + 0.25 * pulse})`;
            //    ctx.lineWidth = 1;
            //    ctx.setLineDash([6, 6]);
            //    ctx.beginPath();
            //    ctx.arc(cpaP.x, cpaP.y, cpaRadPx, 0, Math.PI * 2);
            //    ctx.stroke();
            //    ctx.setLineDash([]);

            //    ctx.fillStyle = `rgba(255,93,93,${0.35 + 0.55 * pulse})`;
            //    ctx.beginPath();
            //    ctx.arc(cpaP.x, cpaP.y, 3, 0, Math.PI * 2);
            //    ctx.fill();
            //    ctx.restore();
            // }

            // Oplossing voor het probleem dat een target met een kleine CPA een kleine cirkel krijgt.
            // Daardoor is het CPUpunt moeilijk te zien.
            // Nu is er een minimale cirkel en de lijndikte varieert met de CPA

            if (it.cpaNm != null && typeof it.cpaDx === "number" && typeof it.cpaDy === "number") {
               const cpaRngNm = rangeNmFromMeters(Math.hypot(it.cpaDx, it.cpaDy));
               const cpaBrg = bearingDeg(it.cpaDx, it.cpaDy);
               const cpaP = polarToScreen(cpaRngNm, cpaBrg, state.rangeNm, cx, cy, radius);

               // OPLOSSING: Stel een minimale straal in (bijv. 10px) zodat de cirkel altijd zichtbaar is
               const minRadiusPx = 10;
               const actualCpaRadPx = (it.cpaNm / state.rangeNm) * radius;
               const cpaRadPx = Math.max(actualCpaRadPx, minRadiusPx);

               ctx.save();

               // OPTIONEEL: Maak de lijn dikker naarmate de CPA kleiner/gevaarlijker is
               const dangerFactor = Math.max(0, 1 - (it.cpaNm / 0.5)); // Voorbeeld: extra dik onder 0.5 NM
               ctx.lineWidth = 1 + (dangerFactor * 2);

               ctx.strokeStyle = `rgba(255,93,93,${0.30 + 0.40 * pulse})`; // Iets hogere opacity voor betere zichtbaarheid
               ctx.setLineDash([6, 6]);
               ctx.beginPath();
               // ctx.arc(cpaP.x, cpaP.y, cpaRadPx, 0, Math.PI * 2);
               ctx.arc(cx, cy, cpaRadPx, 0, Math.PI * 2);
               ctx.stroke();
               ctx.setLineDash([]);

               // Middelpunt (de stip) iets groter maken bij gevaar
               ctx.fillStyle = `rgba(255,93,93,${0.50 + 0.50 * pulse})`;
               ctx.beginPath();
               ctx.arc(cpaP.x, cpaP.y, 4, 0, Math.PI * 2);
               ctx.fill();

               // Teken een kruis (X) op het CPA punt als de afstand gevaarlijk klein is
               const crossSize = 6; // Grootte van de armen van het kruis
               ctx.beginPath();
               // Lijn van linksboven naar rechtsonder
               ctx.moveTo(cpaP.x - crossSize, cpaP.y - crossSize);
               ctx.lineTo(cpaP.x + crossSize, cpaP.y + crossSize);
               // Lijn van rechtsboven naar linksonder
               ctx.moveTo(cpaP.x + crossSize, cpaP.y - crossSize);
               ctx.lineTo(cpaP.x - crossSize, cpaP.y + crossSize);

               ctx.lineWidth = 2; // Kruis iets dikker voor nadruk
               ctx.stroke();


               ctx.restore();
            }


         }
         // toon vector van target
         if (state.showVectors || it.isDanger) {
            const vecNm = (it.t.sogKn || 0) * (6 / 60); // 6 min lookahead
            const lenPx = (vecNm / state.rangeNm) * radius;
            const a = rad((it.t.cogDeg || 0) - 90);
            const p2 = {
               x: p.x + lenPx * Math.cos(a),
               y: p.y + lenPx * Math.sin(a)
            };
            ctx.strokeStyle = it.isDanger ?
               `rgba(255,93,93,${0.18 + 0.25 * pulse})` :
               "rgba(255,255,255,.25)";
            ctx.lineWidth = it.isDanger ?
               2.5 :
               1.5; // ← HIER

            ctx.beginPath();
            ctx.moveTo(p.x, p.y);
            ctx.lineTo(p2.x, p2.y);
            ctx.stroke();
         }
         // toon naam, CPA en TCPA van target
         if (state.showLabels || it.isDanger) {
            const name = (it.t.name && it.t.name.trim()) ? it.t.name : prettyId(it.id);
            const extra = (it.cpaNm != null && isFinite(it.tcpaMin)) ? ` ${formatNm(it.cpaNm)}NM in ${formatMin(it.tcpaMin)}min` : "";
            ctx.fillStyle = it.isDanger ? "rgba(255,220,220,.90)" : "rgba(255,255,255,.78)";
            ctx.font = "12px system-ui, sans-serif";
            const labelPos4 = getLabelAlignment(p.x, p.y, cx, cy, 8);
            ctx.textAlign = labelPos4.textAlign;
            ctx.textBaseline = labelPos4.textBaseline;
            ctx.fillText(name + extra, labelPos4.drawX, labelPos4.drawY);
         }
         // toon COG en SOG van target
         if (state.debug || it.isDanger) {
            const debug_info = `${Math.round(it.t.cogDeg||0)}° @ ${formatKn(it.t.sogKn)}kn`
            ctx.fillStyle = "rgba(255,255,255,.70)";
            ctx.font = "11px ui-monospace, monospace";
            ctx.fillText(debug_info, p.x + 8, p.y + 8);
         }
      }

      ownText.textContent = haveOwn ?
         `${own.lat.toFixed(5)}, ${own.lon.toFixed(5)}  COG ${Math.round(own.cogDeg || 0)}°  SOG ${formatKn(own.sogKn)} kn` :
         "Waiting for ownship position…";
      countText.textContent = String(render.length);

      frames++;
      const t = performance.now();
      if (t - lastFpsT > 1000) {
         fpsText.textContent = ((frames * 1000) / (t - lastFpsT)).toFixed(0);
         lastFpsT = t;
         frames = 0;
      }

      // Bouw de lijst met targets
      const listUpdatesPerSecond = 2
      const listMillisecondsBetween = 1000 * 1 / listUpdatesPerSecond
      if (t - lastListT > listMillisecondsBetween) {
         lastListT = t;
         targetList.innerHTML = "";
         for (const it of render.slice(0, 40)) {
            const row = document.createElement("div");
            row.className = "row" + (state.selectedId === it.id ? " selected" : "");

            row.onclick = () => state.selectedId = (state.selectedId === it.id ? null : it.id);

            const name_text = (it.t.name && it.t.name.trim()) ? it.t.name : prettyId(it.id);
            const name_color = colorFromCriticality(it.d, 0.95);

            const cpaTxt = (it.cpaNm != null) ? `CPA ${formatNm(it.cpaNm)}nm` : "CPA —";
            const tcpaTxt = (it.tcpaMin != null && isFinite(it.tcpaMin)) ? `TCPA ${formatMin(it.tcpaMin)}m` : "TCPA —";
            const dangerBadge = it.isDanger ? `<span class="badge danger">DANGER</span>` : ``;
            const dangerPercentage = isFinite(it.d) ?
               `${Math.round(it.d * 100)}%` :
               "—";
            // console.debug(dangerPercentage);


            row.innerHTML = `
                  <div class="top">
                     <div class="name" style="color:${name_color}">${escapeHtml(name_text)} ${dangerBadge}</div>
                     <div class="mono">${it.rngNm.toFixed(2)} nm</div>
                  </div>
                  <div class="meta mono">BRG ${Math.round(it.brg)}°  COG ${Math.round(it.t.cogDeg || 0)}°  SOG ${formatKn(it.t.sogKn)} kn  •  ${cpaTxt}  •  ${tcpaTxt}  •  upd ${formatAgeMs(Date.now() - (it.t.lastSeen || 0))}  •  ${dangerPercentage}</div>
               `;
            targetList.appendChild(row);
         }
      }

      requestAnimationFrame(draw);
   }


   function prettyId(id) {
      // const s = prettyId(id);
      // Common Signal K vessel identifiers:
      // - urn:mrn:imo:mmsi:244123456 (or imi/ais variants)
      // - mmsi:244123456
      const m = id.match(/mmsi[:/](\d{9})/i) || id.match(/\b(\d{9})$/);

      if (m) {
         return `MMSI ${m[1]}`;
      }

      return id; //(geef de originele input terug)

   }

   function formatAgeMs(ms) {
      if (!isFinite(ms) || ms < 0) return "—";
      const s = Math.floor(ms / 1000);
      if (s < 60) return `${s}s`;
      const m = Math.floor(s / 60);
      const rs = s % 60;
      if (m < 60) return `${m}m ${rs}s`;
      const h = Math.floor(m / 60);
      const rm = m % 60;
      return `${h}h ${rm}m`;
   }

   function updateSelectionUI(scroll = true) {
      const rows = targetList.querySelectorAll(".row");
      rows.forEach((r) => {
         const id = r.getAttribute("data-id");
         if (id && id === state.selectedId) r.classList.add("selected");
         else r.classList.remove("selected");
      });

      if (scroll) {
         const sel = targetList.querySelector(".row.selected");
         if (sel) sel.scrollIntoView({
            block: "nearest"
         });
      }
   }

   function escapeHtml(s) {
      return String(s).replace(/[&<>"']/g, (c) => ({
         "&": "&amp;",
         "<": "&lt;",
         ">": "&gt;",
         '"': "&quot;",
         "'": "&#039;"
      } [c]));
   }

   function setRange(v) {
      state.rangeNm = clamp(v, 0.25, 24);
      rangeInput.value = String(state.rangeNm);
      rangeVal.textContent = state.rangeNm.toFixed(2);
   }

   function setCpa(v) {
      state.cpaThreshNm = clamp(v, 0.05, 5);
      cpaEl.value = String(state.cpaThreshNm);
      cpaValEl.textContent = state.cpaThreshNm.toFixed(2);
   }

   function setTcpa(v) {
      state.tcpaThreshMin = clamp(v, 1, 120);
      tcpaEl.value = String(state.tcpaThreshMin);
      tcpaValEl.textContent = state.tcpaThreshMin.toFixed(0);

      if (debugEl) debugEl.checked = state.debug;
   }

   rangeInput.addEventListener("input", () => setRange(parseFloat(rangeInput.value)));
   vectorsInput.addEventListener("change", () => state.showVectors = !!vectorsInput.checked);
   labelsInput.addEventListener("change", () => state.showLabels = !!labelsInput.checked);

   dangerEnableEl.addEventListener("change", () => state.dangerEnabled = !!dangerEnableEl.checked);
   cpaEl.addEventListener("input", () => setCpa(parseFloat(cpaEl.value)));
   tcpaEl.addEventListener("input", () => setTcpa(parseFloat(tcpaEl.value)));
   if (debugEl) debugEl.addEventListener("change", () => state.debug = !!debugEl.checked);

   recenterBtn.addEventListener("click", () => state.selectedId = null);

   function selectNearestAt(clientX, clientY) {
      const rect = canvas.getBoundingClientRect();
      const x = clientX - rect.left;
      const y = clientY - rect.top;

      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      const cx = w * 0.5,
         cy = h * 0.5;
      const radius = Math.min(w, h) * 0.46;

      const list = state.lastRender || [];
      if (!list.length) return;

      let best = null;
      let bestD2 = Infinity;

      for (const it of list) {
         const p = polarToScreen(it.rngNm, it.brg, state.rangeNm, cx, cy, radius);
         const dx = p.x - x;
         const dy = p.y - y;
         const d2 = dx * dx + dy * dy;
         if (d2 < bestD2) {
            bestD2 = d2;
            best = it;
         }
      }

      const thresholdPx = 18;
      if (best && bestD2 <= thresholdPx * thresholdPx) {
         state.selectedId = best.id;
         const sel = targetList.querySelector(".row.selected");
         if (sel) sel.scrollIntoView({
            block: "nearest"
         });
      }
   }

   canvas.addEventListener("pointerdown", (e) => {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      selectNearestAt(e.clientX, e.clientY);
   });

   pauseBtn.addEventListener("click", () => {
      state.paused = !state.paused;
      pauseBtn.textContent = state.paused ? "Resume" : "Pause";
      statusEl.textContent = state.paused ? "Paused" : statusEl.textContent;
      statusEl.style.color = state.paused ? "var(--warn)" : statusEl.style.color;
   });

   window.addEventListener("keydown", (e) => {
      if (e.key === "+" || e.key === "=") setRange(state.rangeNm - 0.25);
      if (e.key === "-" || e.key === "_") setRange(state.rangeNm + 0.25);
      if (e.key.toLowerCase() === "v") {
         state.showVectors = !state.showVectors;
         vectorsInput.checked = state.showVectors;
      }
      if (e.key.toLowerCase() === "l") {
         state.showLabels = !state.showLabels;
         labelsInput.checked = state.showLabels;
      }
      if (e.key.toLowerCase() === "d") {
         state.dangerEnabled = !state.dangerEnabled;
         dangerEnableEl.checked = state.dangerEnabled;
      }
      if (e.key.toLowerCase() === "g") {
         state.debug = !state.debug;
         debugEl.checked = state.debug;
      }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
         e.preventDefault();
         const list = state.lastRender || [];
         if (!list.length) return;

         let idx = list.findIndex((x) => x.id === state.selectedId);
         if (idx < 0) idx = 0;
         idx += (e.key === "ArrowDown") ? 1 : -1;
         if (idx < 0) idx = 0;
         if (idx >= list.length) idx = list.length - 1;

         state.selectedId = list[idx].id;

         // Scroll selected into view (target list)
         const sel = targetList.querySelector(".row.selected");
         if (sel) sel.scrollIntoView({
            block: "nearest"
         });
         return;
      }

      if (e.key === " ") {
         e.preventDefault();
         pauseBtn.click();
      }
   });

   window.addEventListener("resize", resize);
   resize();
   setRange(state.rangeNm);
   setCpa(state.cpaThreshNm);
   setTcpa(state.tcpaThreshMin);

   connect();
   requestAnimationFrame(draw);
})();