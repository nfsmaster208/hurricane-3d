// 3D Hurricane Explorer — client-side prototype
// Sources used:
// - NHC CurrentStorms.json (lists active storms + links) https://www.nhc.noaa.gov/CurrentStorms.json
// - NOAA nowCOAST MapServer (arrival time, radii, watches/warnings): https://mapservices.weather.noaa.gov/tropical/rest/services/tropical/NHC_tropical_weather/MapServer
// - Experimental cone with inland warnings (2025): https://www.nhc.noaa.gov/experimental/cone/
// This app tries live sources and falls back to demo_storm.json

const state = {
  view: 'map',  // 'globe' | 'map'
  storms: [],
  _offline: true,
  activeStormId: null,
  timeline: [], // times available
  activeIndex: 0,
  layers: {
    cone: true, track: true, wind34: true, wind50: false, wind64: false,
    arrivalML: true, arrivalER: false, warnings: true, urgency: true, countyPolys: true, surge: true
  },
  weights: {warnings:1.0, surge:1.5, arrival:1.0, duration:1.0, intensity:1.0, coastal:1.0},
  prevImpacts: new Map(),
  myPlaces: JSON.parse(localStorage.getItem('myPlaces')||'[]'),
  preloadSuggested: JSON.parse(localStorage.getItem('preloadSuggested')||'false'),
  preloadItems: [
    {name:'Home', category:'Home', query:'Lake Eola Park, Orlando, FL'},
    {name:'Family (St. Pete)', category:'Family', query:'St. Petersburg, FL'},
    {name:'Friends (Downtown Mount Dora)', category:'Friend', query:'Downtown, Mount Dora, FL'},
    {name:'Significant Other (Magic Kingdom)', category:'Significant other', query:'Magic Kingdom, Florida'}
  ],
  preloadAsked: JSON.parse(localStorage.getItem('preloadAsked')||'false'),
  center: JSON.parse(localStorage.getItem('center')||'null'),
  centerRadiusMi: parseInt(localStorage.getItem('centerRadiusMi')||'50')
  map: null,
  globe: null,
  globeRenderer: null,
  globeScene: null,
  globeCamera: null,
  mediaRecorder: null,
  chunks: []
};

const NOAA_NOWCOAST = "https://mapservices.weather.noaa.gov/tropical/rest/services/tropical/NHC_tropical_weather/MapServer";
const NOAA_NOWCOAST_SUMMARY = "https://mapservices.weather.noaa.gov/tropical/rest/services/tropical/NHC_tropical_weather_summary/MapServer";

// Florida cities / regions of interest
let FL_CITIES = [];
let FL_COUNTIES = [];
fetch('counties_fl.json').then(r=>r.json()).then(d=>FL_COUNTIES = d);
fetch('cities_fl.json').then(r=>r.json()).then(d=>FL_CITIES = d);

const stageGlobe = document.getElementById('globeContainer');
// Minimal raster style (works from file:// origins without WebGL vector style CORS)
const RASTER_STYLE = {
  "version":8,
  "sources":{
    "osm":{
      "type":"raster",
      "tiles":["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
      "tileSize":256,
      "attribution":"© OpenStreetMap"
    }
  },
  "layers":[{"id":"osm","type":"raster","source":"osm"}]
};

// Simple geocoder (Nominatim). Note: public demo service; be gentle.
async function geocode(q){
  const url = "https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=" + encodeURIComponent(q) + "&email=example@example.com";
  const r = await fetch(url);
  const j = await r.json();
  const f = j && j[0];
  if(!f) return null;
  return {lon: parseFloat(f.lon), lat: parseFloat(f.lat), display: f.display_name};
}

const stageMap = document.getElementById('mapContainer');
const debugOut = document.getElementById('debugOut');
function log(){ const t=[...arguments].map(x=> typeof x==='object'? JSON.stringify(x): String(x)).join(' '); if(debugOut){ debugOut.textContent += t+'\n'; debugOut.scrollTop = debugOut.scrollHeight; } console.log(...arguments); }

function hasWebGL(){
  try{
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl') || c.getContext('experimental-webgl'));
  }catch(e){ return false; }
}

function ensureStageSize(){
  const stage = document.getElementById('stage');
  const h = Math.max(320, Math.round(window.innerHeight * 0.58));
  stage.style.height = h + 'px';
}
window.addEventListener('resize', ensureStageSize);
ensureStageSize();

const stormSelect = document.getElementById('stormSelect');
const timeSlider = document.getElementById('timeSlider');
const timeLabel = document.getElementById('timeLabel');
const viewToggle = document.getElementById('viewToggle');
const citySelect = document.getElementById('citySelect');
if(viewToggle){ viewToggle.checked = (state.view==='map'); }
const closestReadout = document.getElementById('closestReadout');

// Initial UI wiring
document.getElementById('reload').onclick = () => loadStorms();
const offlineChk = document.getElementById('offlineChk');
offlineChk?.addEventListener('change', ()=>{ state._offline = offlineChk.checked; log('offline mode:', state._offline); renderActiveFrame(); buildCountyRisk(); updateFloridaImpacts(); });
const diagBtn = document.getElementById('diagBtn');
diagBtn?.addEventListener('click', runDiagnostics);
const copyLogs = document.getElementById('copyLogs');
copyLogs?.addEventListener('click', ()=>{ navigator.clipboard.writeText(debugOut?.textContent||'').then(()=>toast('Logs copied')); });

document.getElementById('shareBtn').onclick = shareState;
document.getElementById('recordBtn').onclick = toggleRecording;


// Weight sliders -> update state and recompute

// Address search UI
const addrInput = document.getElementById('addrInput');
const addrGo = document.getElementById('addrGo');
const addrResults = document.getElementById('addrResults');
function fillPopular(){ addrResults.innerHTML = ['Orlando, FL','Tampa, FL','Miami, FL','Jacksonville, FL','St. Petersburg, FL','Sarasota, FL','Fort Myers, FL','Naples, FL','Tallahassee, FL','Pensacola, FL','Daytona Beach, FL','West Palm Beach, FL','Fort Lauderdale, FL','Key West, FL','Mount Dora, FL','Magic Kingdom, Florida'].map((n,i)=>`<div class="item" data-i="p${i}">${n}</div>`).join(''); addrResults.style.display='block'; Array.from(addrResults.querySelectorAll('.item')).forEach(el=> el.onclick = async ()=>{ const name = el.textContent; const res = await geocode(name); if(res[0]) setCenter(res[0].lat, res[0].lon, res[0].name); addrResults.style.display='none'; }); }
addrInput&& addrInput.addEventListener('focus', ()=>{ if(!addrInput.value) fillPopular(); });
addrGo&& (addrGo.onclick = async ()=>{
  const q = (addrInput.value||'').trim(); if(!q) return;
  const res = await geocode(q);
  if(!res.length){ addrResults.style.display='none'; alert('No matches'); return; }
  addrResults.innerHTML = res.map((r,i)=>`<div class="item" data-i="${i}">${r.name}</div>`).join('');
  addrResults.style.display='block';
  Array.from(addrResults.querySelectorAll('.item')).forEach(el=> el.onclick = ()=>{
    const i = +el.dataset.i; const g = res[i];
    setCenter(g.lat, g.lon, g.name);
    addrResults.style.display='none';
  });
});
document.body.addEventListener('click', (e)=>{
  if(!addrResults.contains(e.target) && e.target!==addrGo && e.target!==addrInput){ addrResults.style.display='none'; }
});

const setCenterFromMapBtn = document.getElementById('setCenterFromMap');
const useHomeCenterBtn = document.getElementById('useHomeCenter');
const saveCenterBtn = document.getElementById('saveCenter');
const centerLabel = document.getElementById('centerLabel');
const centerRadius = document.getElementById('centerRadius');
const radiusVal = document.getElementById('radiusVal');
centerRadius&& (centerRadius.value = state.centerRadiusMi);
radiusVal&& (radiusVal.textContent = `${state.centerRadiusMi} mi`);
centerRadius&& centerRadius.addEventListener('input', ()=>{
  state.centerRadiusMi = parseInt(centerRadius.value);
  localStorage.setItem('centerRadiusMi', String(state.centerRadiusMi));
  radiusVal.textContent = `${state.centerRadiusMi} mi`;
  drawCenterArtifacts();
  updateCommandCenter();
});

useHomeCenterBtn&& (useHomeCenterBtn.onclick = ()=>{ const h = (state.myPlaces||[]).find(p=> (p.category||'').toLowerCase()==='home'); if(h) setCenter(h.lat, h.lon, h.name); else toast('No Home saved yet'); });
setCenterFromMapBtn&& (setCenterFromMapBtn.onclick = ()=>{
  if(!state.map) return;
  const c = state.map.getCenter();
  setCenter(c.lat, c.lng, 'Map center');
});
saveCenterBtn&& (saveCenterBtn.onclick = ()=>{
  if(state.center){ localStorage.setItem('center', JSON.stringify(state.center)); toast('Center saved'); }
});

function setCenter(lat, lon, label){
  state.center = {lat, lon, label};
  if(centerLabel) centerLabel.textContent = `(${lat.toFixed(3)}, ${lon.toFixed(3)})`;
  drawCenterArtifacts();
  updateCommandCenter();
  if(state.map){ state.map.flyTo({center:[lon,lat], zoom:6, speed:0.8}); }
}

// Draw center pin + radius ring
function drawCenterArtifacts(){
  if(!state.map || !state.center) return;
  const map = state.map;
  const pinSrc = 'center-pin'; const ringSrc = 'center-ring';
  const pin = {type:'FeatureCollection', features:[{type:'Feature', properties:{}, geometry:{type:'Point', coordinates:[state.center.lon, state.center.lat]}}]};
  const miles = state.centerRadiusMi||50; const meters = miles*1609.34;
  const circle = turf.circle([state.center.lon, state.center.lat], meters, {steps:128, units:'meters'});
  if(map.getSource(pinSrc)) map.getSource(pinSrc).setData(pin);
  else { map.addSource(pinSrc,{type:'geojson', data:pin}); map.addLayer({id:'center-pin', type:'circle', source:pinSrc, paint:{'circle-radius':6,'circle-color':'#7fb4ff','circle-stroke-color':'#0a1a2b','circle-stroke-width':2}}); }
  if(map.getSource(ringSrc)) map.getSource(ringSrc).setData(circle);
  else { map.addSource(ringSrc,{type:'geojson', data:circle}); map.addLayer({id:'center-ring', type:'line', source:ringSrc, paint:{'line-color':'#7fb4ff','line-width':2,'line-dasharray':[2,2]}}); }
}

// Command Center summary
async function updateCommandCenter(){
  const el = document.getElementById('centerSummary');
  if(!el || !state.center) { if(el) el.textContent='Set a center to see ETA, duration, and risk in your area.'; return; }
  // sample points in a spoke pattern within radius
  const miles = state.centerRadiusMi||50;
  const steps = 12; const rings = 2;
  const samples = [];
  for(let r=1; r<=rings; r++){
    const radMi = miles * (r/rings);
    for(let i=0;i<steps;i++){
      const ang = (i/steps)*2*Math.PI;
      const dest = turf.destination([state.center.lon, state.center.lat], radMi, ang*180/Math.PI, {units:'miles'});
      samples.push(dest.geometry.coordinates);
    }
  }
  let minHours = Number.POSITIVE_INFINITY;
  let maxDur = 0;
  let maxScore = 0;
  let anyWarn = null;
  for(const [lon,lat] of samples){
    const [arr, dur, warn, risk] = await Promise.all([
      arrivalTimeForPoint(lon, lat, true),
      durationInsideWind(lon, lat, 34),
      warningForPoint(lon, lat),
      riskScoreForPoint(lon, lat, false)
    ]);
    if(arr.hoursUntil!=null) minHours = Math.min(minHours, arr.hoursUntil);
    if(dur.hours!=null) maxDur = Math.max(maxDur, dur.hours);
    maxScore = Math.max(maxScore, risk.score);
    if(warn && (warn.type||'').includes('WARNING')) anyWarn = warn;
  }
  if(minHours===Number.POSITIVE_INFINITY) minHours = null;
  const bucket = riskBucket(maxScore);
  const etaTxt = (minHours!=null) ? (minHours<0 ? `Ongoing` : `${minHours}h`) : '—';
  const durTxt = maxDur ? `${maxDur}h` : '—';
  const warnTag = anyWarn ? `<span class="tag ${anyWarn.cls}">${anyWarn.label}</span>` : '';
  el.innerHTML = `<div><span class="badge ${bucket.cls}">${bucket.text}</span> within ${miles} mi ${warnTag}</div>
                  <div class="small">Earliest TS winds in ~ <strong>${etaTxt}</strong> · Potential TS wind duration up to <strong>${durTxt}</strong></div>`;
}



// First-run quick setup
const firstRunModal = document.getElementById('firstRunModal');
function showFirstRun(){ if(firstRunModal) firstRunModal.style.display='flex'; }
function hideFirstRun(){ if(firstRunModal) firstRunModal.style.display='none'; }
if(!state.preloadAsked && (!state.myPlaces || state.myPlaces.length===0)){
  setTimeout(()=> showFirstRun(), 800);
}
const setupSkip = document.getElementById('setupSkip');
const setupSave = document.getElementById('setupSave');
const setupUseMyLoc = document.getElementById('setupUseMyLoc');
setupSkip&& (setupSkip.onclick = ()=>{ state.preloadAsked=true; localStorage.setItem('preloadAsked','true'); hideFirstRun(); });
setupUseMyLoc&& (setupUseMyLoc.onclick = ()=>{
  if(navigator.geolocation){
    navigator.geolocation.getCurrentPosition(pos=>{
      document.getElementById('setupHomeLat').value = pos.coords.latitude.toFixed(4);
      document.getElementById('setupHomeLon').value = pos.coords.longitude.toFixed(4);
    }, ()=> alert('Could not get location'));
  } else alert('Geolocation unsupported');
});
setupSave&& (setupSave.onclick = ()=>{
  const hlat = parseFloat(document.getElementById('setupHomeLat').value);
  const hlon = parseFloat(document.getElementById('setupHomeLon').value);
  const wlat = parseFloat(document.getElementById('setupWorkLat').value);
  const wlon = parseFloat(document.getElementById('setupWorkLon').value);
  if(Number.isFinite(hlat) && Number.isFinite(hlon)){
    state.myPlaces.push({name:'Home', category:'Home', lat:hlat, lon:hlon});
  }
  if(Number.isFinite(wlat) && Number.isFinite(wlon)){
    state.myPlaces.push({name:'Work', category:'Work', lat:wlat, lon:wlon});
  }
  localStorage.setItem('myPlaces', JSON.stringify(state.myPlaces));
  state.preloadAsked=true; localStorage.setItem('preloadAsked','true');
  hideFirstRun(); renderPlaces(); renderGroups(); updateFloridaImpacts(); buildCountyRisk();
});

['wWarnings','wSurge','wArrival','wDuration','wIntensity','wCoastal'].forEach(id=>{
  const el = document.getElementById(id);
  if(!el) return;
  el.addEventListener('input', ()=>{
    state.weights = {
      warnings: parseFloat(document.getElementById('wWarnings').value),
      surge: parseFloat(document.getElementById('wSurge').value),
      arrival: parseFloat(document.getElementById('wArrival').value),
      duration: parseFloat(document.getElementById('wDuration').value),
      intensity: parseFloat(document.getElementById('wIntensity').value),
      coastal: parseFloat(document.getElementById('wCoastal').value),
    };
    // Rebuild county risk + impacts
    buildCountyRisk();
    renderCountyExtrusions();
    updateFloridaImpacts();
  });
});


// Preload suggestions flow (first run after we know user wants this)
const preloadModal = document.getElementById('preloadModal');
const preloadList = document.getElementById('preloadList');
const preloadSkip = document.getElementById('preloadSkip');
const preloadResolve = document.getElementById('preloadResolve');
const preloadSave = document.getElementById('preloadSave');

function showPreload(){ if(preloadModal) preloadModal.style.display='flex'; }
function hidePreload(){ if(preloadModal) preloadModal.style.display='none'; }

function initPreloadList(){
  if(!preloadList) return;
  preloadList.innerHTML = state.preloadItems.map((p,i)=>`<label style="display:flex;gap:8px;align-items:center;padding:6px 0"><input type="checkbox" data-i="${i}" checked> <div><strong>${p.name}</strong> <span class="cat ${p.category==='Home'?'home':p.category==='Work'?'work':p.category==='Family'?'family':p.category==='Friend'?'friend':p.category==='Significant other'?'so':'other'}">${p.category}</span><div class="small">${p.query}</div></div></label>`).join('');
}

preloadSkip && (preloadSkip.onclick = ()=>{ state.preloadSuggested=true; localStorage.setItem('preloadSuggested','true'); hidePreload(); });
preloadResolve && (preloadResolve.onclick = async ()=>{
  const checks = Array.from(preloadList.querySelectorAll('input[type=checkbox]')).filter(c=>c.checked);
  // Resolve via geocode
  for(const c of checks){
    const idx = +c.dataset.i; const item = state.preloadItems[idx];
    const results = await geocode(item.query);
    if(results && results.length){
      const g = results[0]; item.lat = g.lat; item.lon = g.lon; item.resolved = g.name;
    }else{
      item.error = 'No match';
    }
  }
  // Preview
  preloadList.innerHTML = state.preloadItems.map((p,i)=>{
    const ok = p.lat && p.lon;
    const line2 = ok ? `<div class="small">Resolved: ${p.resolved} (${p.lat.toFixed(4)}, ${p.lon.toFixed(4)})</div>` : `<div class="small" style="color:#ffb3b3">Not found</div>`;
    return `<label style="display:flex;gap:8px;align-items:center;padding:6px 0"><input type="checkbox" data-i="${i}" ${ok?'checked':''}> <div><strong>${p.name}</strong> <span class="cat ${p.category==='Home'?'home':p.category==='Work'?'work':p.category==='Family'?'family':p.category==='Friend'?'friend':p.category==='Significant other'?'so':'other'}">${p.category}</span><div class="small">${p.query}</div>${line2}</div></label>`;
  }).join('');
});
preloadSave && (preloadSave.onclick = ()=>{
  const checks = Array.from(preloadList.querySelectorAll('input[type=checkbox]')).filter(c=>c.checked);
  const toAdd = [];
  for(const c of checks){
    const idx = +c.dataset.i; const it = state.preloadItems[idx];
    if(it.lat && it.lon){
      toAdd.push({name:it.name, category:it.category, lat:it.lat, lon:it.lon});
    }
  }
  if(toAdd.length){
    state.myPlaces.push(...toAdd);
    localStorage.setItem('myPlaces', JSON.stringify(state.myPlaces));
    renderPlaces(); renderGroups(); updateFloridaImpacts(); buildCountyRisk();
    // If Home exists, set as center
    const home = state.myPlaces.find(p=> (p.category||'').toLowerCase()==='home');
    if(home) setCenter(home.lat, home.lon, home.name);
  }
  state.preloadSuggested=true; localStorage.setItem('preloadSuggested','true');
  hidePreload();
});

// Trigger preload once, after storms loaded & map ready, if user hasn't been asked
function maybeAskPreload(){
  if(!state.preloadSuggested){ initPreloadList(); setTimeout(showPreload, 600); }
}

// My Places
const addPlaceBtn = document.getElementById('addPlaceBtn');
const myPlacesList = document.getElementById('myPlacesList');
const placeCategory = document.getElementById('placeCategory');
const useMyLocBtn = document.getElementById('useMyLocBtn');
function savePlaces(){ localStorage.setItem('myPlaces', JSON.stringify(state.myPlaces)); }
function renderPlaces(){
  if(!myPlacesList) return;
  myPlacesList.innerHTML = '';
  const arr = state.myPlaces;
  arr.forEach((p, idx)=>{
    const row = document.createElement('div'); row.className = 'row';
    const cat = (p.category||'Other').toLowerCase();
    const cls = cat==='home'?'home':cat==='work'?'work':cat==='family'?'family':cat==='friend'?'friend':cat==='significant other'?'so':'other';
    row.innerHTML = `<div><strong>${p.name}</strong> <span class="cat ${cls}">${p.category||'Other'}</span> <span class="small">(${p.lat.toFixed(3)}, ${p.lon.toFixed(3)})</span></div>
                     <div><button class="rm" data-i="${idx}">Remove</button></div>`;
    myPlacesList.appendChild(row);
  });
  myPlacesList.querySelectorAll('.rm').forEach(btn=>{
    btn.onclick = ()=>{ const i = +btn.dataset.i; state.myPlaces.splice(i,1); savePlaces(); renderPlaces(); renderGroups(); updateFloridaImpacts(); buildCountyRisk(); };
  });
}
if(useMyLocBtn){ useMyLocBtn.onclick = ()=>{
    if(navigator.geolocation){ navigator.geolocation.getCurrentPosition(pos=>{
      document.getElementById('placeLat').value = pos.coords.latitude.toFixed(4);
      document.getElementById('placeLon').value = pos.coords.longitude.toFixed(4);
    }, ()=> alert('Could not get location')); }
  };}
if(addPlaceBtn){
  addPlaceBtn.onclick = ()=>{
    const name = (document.getElementById('placeName').value||'My Place').trim();
    const category = (placeCategory && placeCategory.value) || 'Other';
    const lat = parseFloat(document.getElementById('placeLat').value);
    const lon = parseFloat(document.getElementById('placeLon').value);
    if(Number.isFinite(lat) && Number.isFinite(lon)){
      state.myPlaces.push({name, category, lat, lon});
      savePlaces(); renderPlaces(); renderGroups();
      updateFloridaImpacts(); buildCountyRisk(); renderGroups();
    }else{
      alert('Please enter valid lat/lon.');
    }
  };
  renderPlaces(); renderGroups();
}

viewToggle.addEventListener('change', () => {
  state.view = viewToggle.checked ? 'map' : 'globe';
  stageGlobe.classList.toggle('hidden', state.view==='map');
  stageMap.classList.toggle('hidden', state.view!=='map');
  if(state.view==='map' && !state.map) initMap(); if(state.view==='map' && state.map){ setTimeout(()=>state.map.resize(), 50);}
  if(state.view==='globe' && !state.globe) initGlobe();
  renderActiveFrame();
  buildCountyRisk();
  renderCountyExtrusions();
  renderSurgeOverlay();
});

// Layer toggles
['coneChk','trackChk','wind34Chk','wind50Chk','wind64Chk','arrivalMLChk','arrivalERChk','warningsChk','urgencyChk'].forEach(id=>{
  document.getElementById(id).addEventListener('change', ev=>{
    const m = {coneChk:'cone',trackChk:'track',wind34Chk:'wind34',wind50Chk:'wind50',wind64Chk:'wind64',arrivalMLChk:'arrivalML',arrivalERChk:'arrivalER',warningsChk:'warnings'};
    state.layers[m[id]] = ev.target.checked;
    renderActiveFrame();
    if(m[id]==='urgency') buildCountyRisk();
    if(m[id]==='countyPolys') { state.layers.countyPolys = ev.target.checked; renderCountyExtrusions(); }
    if(m[id]==='surge') { state.layers.surge = ev.target.checked; renderSurgeOverlay(); }
  buildCountyRisk();
  });
});

document.getElementById('loadJsonBtn').onclick = async () => {
  const val = document.getElementById('jsonBox').value.trim();
  if(!val) return;
  try{
    const maybeUrl = val.startsWith('http');
    let data;
    if(maybeUrl){
      const resp = await fetch(val);
      data = await resp.json();
    }else{
      data = JSON.parse(val);
    }
    // Minimal adapter: look for fields we care about
    if(data && (data.activeStorms || data.storms)){
      await ingestCurrentStormsJson(data);
    }else if(data.features && data.features[0] && data.features[0].geometry){
      // treat as cone GeoJSON for active storm
      const demo = await (await fetch('demo_storm.json')).json();
      demo.cone = data;
      ingestDemo(demo);
    }else{
      alert('Unsupported JSON pasted. Try NHC CurrentStorms.json or a cone GeoJSON.');
    }
  }catch(e){ alert('Failed to load JSON: '+e.message); }
};

timeSlider.addEventListener('input', ()=>{
  state.activeIndex = +timeSlider.value;
  renderActiveFrame();
  buildCountyRisk();
  renderCountyExtrusions();
  renderSurgeOverlay();
});

stormSelect.addEventListener('change', async ()=>{
  const id = stormSelect.value;
  await loadStormById(id);
});

citySelect.addEventListener('change', ()=> updateClosestApproach());

// --- Load storms ---
async function loadStorms(){
  if(state._offline){ const demo = await (await fetch('demo_offline.json')).json(); return ingestDemo(demo, true); }
  try{
    const resp = await fetch('https://www.nhc.noaa.gov/CurrentStorms.json', {cache:'no-store'});
    const data = await resp.json();
    await ingestCurrentStormsJson(data);
  }catch(e){
    console.warn('Failed to load live CurrentStorms.json, using demo', e);
    const demo = await (await fetch('demo_storm.json')).json();
    ingestDemo(demo, true);
  }
}

async function ingestCurrentStormsJson(data){
  // JSON reference: https://www.nhc.noaa.gov/productexamples/NHC_Tropical_Cyclone_Status_JSON_File_Reference.pdf
  // We defensively search for storms with basin Atlantic or EP, etc.
  const storms = [];
  const list = data?.activeStorms || data?.storms || [];
  list.forEach(s=>{
    if(!s) return;
    const id = s?.storm?.id || s?.stormId || s?.id || s?.advisoryNumber;
    const name = s?.storm?.name || s?.name || s?.stormName || 'Storm';
    const basin = s?.storm?.basin || s?.basin || '';
    const year = s?.storm?.year || s?.year || '';
    const key = s?.storm?.key || s?.key || (basin && year ? `${basin}${year}` : id);
    const cone = s?.links?.cone?.geojson || s?.links?.cone || null;
    storms.push({id: s?.storm?.stormNumber ? `${basin}${String(s.storm.stormNumber).padStart(2,'0')}${year}` : key, name, basin, year, coneUrl: cone});
  });
  if(!storms.length) throw new Error('No storms found in JSON');
  state.storms = storms;
  // populate dropdown
  stormSelect.innerHTML = storms.map(s=>`<option value="${s.id}">${s.name} (${s.id})</option>`).join('');
  // default to first
  await loadStormById(storms[0].id);
}

async function ingestDemo(demo, isFallback=false){
  log('ingestDemo', {isFallback});
  // Demo contains a minimal shape so interface still works offline
  state.storms = [{id: demo.id, name: demo.name, basin:"AL", year: demo.year}];
  stormSelect.innerHTML = `<option value="${demo.id}">${demo.name} (${demo.id})</option>`;
  state.activeStormId = demo.id;
  state.timeline = demo.timeline;
  state.activeIndex = 0;
  timeSlider.max = String(state.timeline.length-1);
  timeSlider.value = "0";
  updateTimeLabel();
  if(!state.map) initMap();
  if(!state.globe) initGlobe();
  // store demo data into state
  window._offlineLayers = demo.layers || null;
  window._demoData = demo;
  renderActiveFrame();
  buildCountyRisk();
  renderCountyExtrusions();
  renderSurgeOverlay();
  await updateFloridaImpacts();
  await updateClosestApproach();
  if(isFallback) toast('Live feed unavailable, showing demo.');
}

// Load storm-specific layers from nowCOAST, try to infer layer IDs dynamically
async function loadStormById(stormId){
  state.activeStormId = stormId;
  if(!state.map) initMap();
  if(!state.globe) initGlobe();
  // Discover layers
  const meta = await (await fetch(`${NOAA_NOWCOAST}?f=pjson`)).json();
  // find layer IDs by name
  const findLayer = (names)=>{
    const lower = (s)=>s.toLowerCase();
    let id = null;
    for(const lyr of meta.layers){
      const nm = lower(lyr.name);
      if(names.some(n=>nm.includes(lower(n)))) { id = lyr.id; break; }
    }
    return id;
  };
  const layerIds = {
    cone: findLayer(['forecast cone','cone']),
    track: findLayer(['forecast track','line']),
    points: findLayer(['forecast points','positions']),
    wind: findLayer(['forecast wind radii']),
    arrivalML: findLayer(['arrival time','most likely']),
    arrivalER: findLayer(['arrival time','earliest']),
    warnings: findLayer(['watches','warnings'])
  };
  state._layerIds = layerIds;

  // Build timeline from track points (query unique times)
  let timeline = [];
  try{
    const url = `${NOAA_NOWCOAST}/${layerIds.points}/query?where=stormid%3D'${stormId}'&outFields=*,validtime&f=geojson&orderByFields=validtime`;
    const gj = await (await fetch(url)).json();
    const times = Array.from(new Set(gj.features.map(f=>f.properties.validtime))).sort();
    timeline = times;
    window._points = gj;
  }catch(e){
    console.warn('Points query failed, falling back to demo', e);
    const demo = await (await fetch('demo_storm.json')).json();
    ingestDemo(demo, true);
    return;
  }
  state.timeline = timeline;
  state.activeIndex = 0;
  timeSlider.max = String(timeline.length-1);
  timeSlider.value = "0";
  updateTimeLabel();

  // Preload cone + wind radii layers for speed
  preloadLayersForTime(state.activeTime());
  renderActiveFrame();
  buildCountyRisk();
  renderCountyExtrusions();
  renderSurgeOverlay();
  await updateFloridaImpacts();
  await updateClosestApproach();
}

state.activeTime = ()=> state.timeline[state.activeIndex];

function updateTimeLabel(){
  const t = state.activeTime();
  timeLabel.textContent = t ? new Date(t).toUTCString().replace(':00 GMT','Z') : '—';
}

// Preload/Cache per-time GeoJSON
const cache = new Map();

async function fetchLayerGeoJSON(layerId, where){
  // Offline path
  if(state._offline && window._offlineLayers){
    // parse where
    let t=null, windcode=null;
    try{
      const m = /validtime=timestamp '([^']+)'/i.exec(where||''); if(m) t = m[1];
      const w = /windcode=(\d+)/i.exec(where||''); if(w) windcode = +w[1];
    }catch{}
    // Map to offline
    if(layerId==='OFFLINE_CONE' || (where&&where.includes('forecast cone'))){ return window._offlineLayers.cone; }
    // wind radii
    if(windcode){
      const all = window._offlineLayers.wind;
      const feats = all.features.filter(f=> (!t || f.properties.validtime===t) && f.properties.windcode===windcode);
      return {type:'FeatureCollection', features: feats};
    }
    // track
    if(String(layerId).includes('track')) return window._offlineLayers.track;
    // points
    if(String(layerId).includes('points')) return window._offlineLayers.points;
    // arrival/warnings (empty in demo)
    return {type:'FeatureCollection', features: []};
  }
  // Online path
  const key = `${layerId}|${where}`;
  if(cache.has(key)) return cache.get(key);
  const url = `${NOAA_NOWCOAST}/${layerId}/query?where=${encodeURIComponent(where)}&outFields=*&f=geojson`;
  try{
    const gj = await (await fetch(url)).json();
    cache.set(key, gj);
    return gj;
  }catch(e){
    log('fetchLayerGeoJSON ERR', url, String(e));
    // final fallback: offline if available
    if(window._offlineLayers) return fetchLayerGeoJSON('OFFLINE_CONE', where);
    throw e;
  }
}


async function preloadLayersForTime(timeIso){
  const id = state._layerIds;
  const whereBase = `stormid='${state.activeStormId}' AND validtime=timestamp '${timeIso}'`;
  const promises = [];
  if(id.cone!=null) promises.push(fetchLayerGeoJSON(id.cone, whereBase));
  if(id.wind!=null) promises.push(fetchLayerGeoJSON(id.wind, whereBase));
  if(id.track!=null) promises.push(fetchLayerGeoJSON(id.track, `stormid='${state.activeStormId}'`));
  await Promise.all(promises);
}

// --- Globe ---
function initGlobe(){
  if(!hasWebGL()){ const msg=document.createElement('div'); msg.style.color='#e9f2ff'; msg.style.padding='12px'; msg.textContent='WebGL not available on this device/browser. Use Map view.'; stageGlobe.appendChild(msg); return; }
  const width = stageGlobe.clientWidth, height = stageGlobe.clientHeight;
  const renderer = new THREE.WebGLRenderer({antialias:true, preserveDrawingBuffer:true});
  renderer.setSize(width, height);
  stageGlobe.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, width/height, 0.1, 2000);
  camera.position.set(0,0,450);
  const globe = new ThreeGlobe()
    .globeImageUrl('https://unpkg.com/three-globe/example/img/earth-blue-marble.jpg')
    .bumpImageUrl('https://unpkg.com/three-globe/example/img/earth-topology.png');
  scene.add(globe);
  const amb = new THREE.AmbientLight(0xffffff, 1.0);
  scene.add(amb);

  // Simple animation loop
  function animate(){
    requestAnimationFrame(animate);
    globe.rotation.y += 0.0008;
    renderer.render(scene, camera);
  }
  animate();

  // Resize
  new ResizeObserver(()=>{
    const w = stageGlobe.clientWidth, h = stageGlobe.clientHeight;
    renderer.setSize(w,h);
    camera.aspect = w/h; camera.updateProjectionMatrix();
  }).observe(stageGlobe);

  state.globe = globe;
  state.globeRenderer = renderer;
  state.globeScene = scene;
  state.globeCamera = camera;
}


// --- Geocoding (Nominatim -> Photon fallback) ---
async function geocode(query){
  const headers = {'Accept':'application/json'};
  try{
    const u = `https://nominatim.openstreetmap.org/search?format=json&limit=5&q=${encodeURIComponent(query)}`;
    const r = await fetch(u, {headers});
    if(r.ok){ const j = await r.json(); if(j && j.length) return j.map(g=>({name:g.display_name, lat:+g.lat, lon:+g.lon})); }
  }catch{}
  try{
    const u = `https://photon.komoot.io/api/?q=${encodeURIComponent(query)}&limit=5`;
    const r = await fetch(u, {headers});
    if(r.ok){ const j = await r.json(); if(j && j.features) return j.features.map(f=>({name:f.properties.name+', '+(f.properties.city||f.properties.state||''), lat:f.geometry.coordinates[1], lon:f.geometry.coordinates[0]})); }
  }catch{}
  return [];
}

// --- Map (tilted 3D) ---
function initMap(){
  if(typeof maplibregl==='undefined'){ log('MapLibre not loaded'); const msg=document.createElement('div'); msg.style.color='#d3e4ff'; msg.style.padding='12px'; msg.textContent='Map engine failed to load. Check connection or try again.'; stageMap.appendChild(msg); return; }
  const map = new maplibregl.Map({
    container: 'mapContainer',
    style: RASTER_STYLE,
    center: [-80, 25],
    zoom: 3,
    pitch: 60,
    bearing: -10
  });
  map.addControl(new maplibregl.NavigationControl());
  state.map = map;
}

// Render the current frame to both views
async function renderActiveFrame(){
  updateTimeLabel();
  const layerIds = state._layerIds || {};
  const timeIso = state.activeTime();
  if(!timeIso) return;

  // Map view
  if(state.view==='map' && state.map){
    const map = state.map;
    await map.once('idle');
    // Helper to add/update a GeoJSON layer
    const upsert = (id, data, type, paint, layout)=>{
      if(map.getSource(id)) map.getSource(id).setData(data);
      else {
        map.addSource(id, {type:'geojson', data});
        map.addLayer(Object.assign({id, type, source:id}, layout||{}, {paint: paint||{}}));
      }
    };
    // Cone
    if(state.layers.cone && layerIds.cone!=null){
      const where = `stormid='${state.activeStormId}' AND validtime=timestamp '${timeIso}'`;
      const cone = await fetchLayerGeoJSON(layerIds.cone, where);
      upsert('cone-fill', cone, 'fill', {'fill-opacity':0.25,'fill-outline-color':'#6ea8ff','fill-color':'#6ea8ff'});
    } else if(map.getSource('cone-fill')) { map.removeLayer('cone-fill'); map.removeSource('cone-fill'); }

    // Track
    if(state.layers.track && layerIds.track!=null){
      const track = await fetchLayerGeoJSON(layerIds.track, `stormid='${state.activeStormId}'`);
      upsert('track-line', track, 'line', {'line-width':2,'line-color':'#fff'});
    } else if(map.getSource('track-line')) { map.removeLayer('track-line'); map.removeSource('track-line'); }

    // Wind radii (34/50/64)
    async function drawWind(code, idSuffix, color){
      const where = `stormid='${state.activeStormId}' AND validtime=timestamp '${timeIso}' AND windcode=${code}`;
      const gj = await fetchLayerGeoJSON(layerIds.wind, where);
      upsert(`wind-${idSuffix}`, gj, 'fill', {'fill-opacity':0.18,'fill-outline-color':color,'fill-color':color});
    }
    if(state.layers.wind34 && layerIds.wind!=null) await drawWind(34, '34', '#ffd24d'); else remove('wind-34');
    if(state.layers.wind50 && layerIds.wind!=null) await drawWind(50, '50', '#ff9f43'); else remove('wind-50');
    if(state.layers.wind64 && layerIds.wind!=null) await drawWind(64, '64', '#ff4d4d'); else remove('wind-64');

    // Arrival Time — show as contour polygons
    async function drawArrival(id, idSuffix, color){
      const where = `stormid='${state.activeStormId}'`;
      const gj = await fetchLayerGeoJSON(id, where);
      upsert(`arr-${idSuffix}`, gj, 'line', {'line-width':1.5,'line-color':color,'line-dasharray':[2,2]});
    }
    if(state.layers.arrivalML && layerIds.arrivalML!=null) await drawArrival(layerIds.arrivalML,'ml','#7bd389'); else remove('arr-ml');
    if(state.layers.arrivalER && layerIds.arrivalER!=null) await drawArrival(layerIds.arrivalER,'er','#64b5f6'); else remove('arr-er');

    // Watches/Warnings
    if(state.layers.warnings && layerIds.warnings!=null){
      const gj = await fetchLayerGeoJSON(layerIds.warnings, `stormid='${state.activeStormId}'`);
      upsert('warn-fill', gj, 'fill', {'fill-opacity':0.22,'fill-color':['match',['get','prodtype'],
        'HURRICANE WARNING','#ff4d4d','HURRICANE WATCH','#ff9f43','TROPICAL STORM WARNING','#ffd24d','TROPICAL STORM WATCH','#a5d6a7','#cfd8dc']});
    } else remove('warn-fill');

    function remove(id){ if(map.getSource(id)){ map.removeLayer(id); map.removeSource(id);} }
  }

  // Globe view
  if(state.view==='globe' && state.globe){
    const globe = state.globe;
    const layerIds = state._layerIds || {};
    try{
      if(window._points){
        const pts = window._points.features.map(f=>({lat:f.geometry.coordinates[1],lng:f.geometry.coordinates[0]}));
        globe.pointsData(pts).pointAltitude(0.01).pointColor(()=>'#eaf2ff').pointRadius(0.6);
      }
    }catch{}
    // Stacked cone (time slices) for a volumetric feel
    try{
      if(layerIds.cone!=null){
        const slices = [];
        const times = state.timeline.slice(0, Math.min(10, state.timeline.length)); // cap for perf
        for(let i=0;i<times.length;i++){
          const where = `stormid='${state.activeStormId}' AND validtime=timestamp '${times[i]}'`;
          const cone = await fetchLayerGeoJSON(layerIds.cone, where);
          for(const f of cone.features||[]){
            slices.push({polygon: f.geometry.coordinates, tIndex:i});
          }
        }
        globe.polygonsData(slices)
          .polygonCapColor(d=> `rgba(110,168,255,${0.12 + 0.04*d.tIndex})`)
          .polygonSideColor(()=> 'rgba(110,168,255,0.6)')
          .polygonAltitude(d=> 0.004 * (d.tIndex+1));
      } else {
        globe.polygonsData([]);
      }
    }catch{}
  }
}



// Confidence score for a location based on data availability
function confidenceFor(arr, dur, warn){
  let score = 0;
  if(arr && arr.when) score += 1;
  if(dur && dur.hours!=null) score += 1;
  if(warn && warn.type) score += 1;
  // 0..3 -> Low/Med/High
  if(score>=3) return {label:'High', cls:'high'};
  if(score===2) return {label:'Medium', cls:'med'};
  return {label:'Low', cls:'low'};
}

// Wind presence helper: does point fall inside a windcode polygon at any time?
async function windPresence(lon, lat, windCode){
  try{
    const id = state._layerIds.wind;
    if(id==null) return false;
    const p = turf.point([lon, lat]);
    for(const t of state.timeline){
      const where = `stormid='${state.activeStormId}' AND validtime=timestamp '${t}' AND windcode=${windCode}`;
      const gj = await fetchLayerGeoJSON(id, where);
      for(const f of gj.features||[]){
        try{
          if(!f.geometry) continue;
          const geom = f.geometry.type==='Polygon' ? f.geometry : (f.geometry.type==='MultiPolygon' ? {type:'Polygon', coordinates:f.geometry.coordinates[0]} : null);
          if(!geom) continue;
          if(turf.booleanPointInPolygon(p, geom)) return true;
        }catch{}
      }
    }
    return false;
  }catch(e){ return false; }
}

// Risk score combining surge/wind/arrival/duration/coastal
async function riskScoreForPoint(lon, lat, coastal=false){
  const [arr, dur, warn, has64, has50] = await Promise.all([
    arrivalTimeForPoint(lon, lat, true),
    durationInsideWind(lon, lat, 34),
    warningForPoint(lon, lat),
    windPresence(lon, lat, 64),
    windPresence(lon, lat, 50)
  ]);
  let score = 0;
  const W = state.weights||{warnings:1, surge:1.5, arrival:1, duration:1, intensity:1, coastal:1};
  // warnings (surge or hurricane carry heavier weight)
  const wt = (warn?.type||'').toUpperCase();
  if(wt.includes('STORM SURGE WARNING')) score += 4 * W.warnings * W.surge;
  else if(wt.includes('STORM SURGE WATCH')) score += 2 * W.warnings * W.surge;
  else if(wt.includes('HURRICANE WARNING')) score += 3 * W.warnings;
  else if(wt.includes('HURRICANE WATCH')) score += 2 * W.warnings;
  else if(wt.includes('TROPICAL STORM WARNING')) score += 2 * W.warnings;
  else if(wt.includes('TROPICAL STORM WATCH')) score += 1 * W.warnings;

  // arrival window
  const hu = arr.hoursUntil;
  if(hu!=null){
    if(hu < 24) score += 3 * W.arrival;
    else if(hu < 48) score += 2 * W.arrival;
    else if(hu < 72) score += 1 * W.arrival;
  }
  // duration of TS winds
  if(dur.hours!=null){
    if(dur.hours >= 24) score += 2 * W.duration;
    else if(dur.hours >= 12) score += 1 * W.duration;
  }
  // intensity presence
  if(has64) score += 2 * W.intensity;
  else if(has50) score += 1 * W.intensity;

  // exposure
  if(coastal) score += 1 * W.coastal;

  // cap 10
  if(score > 10) score = 10;
  return {score, arr, dur, warn, has64, has50};
}

function riskBucket(score){
  if(score>=7) return {cls:'danger', text:'Evacuate if ordered'};
  if(score>=4) return {cls:'warn', text:'Consider leaving (vulnerable/coastal)'};
  if(score>=2) return {cls:'watch', text:'Shelter & prepare'};
  return {cls:'calm', text:'Monitor'};
}

// Build county risk and render on map/globe
async function buildCountyRisk(){
  if(!FL_COUNTIES.length) return;
  const pts = [];
  for(const c of FL_COUNTIES){
    const r = await riskScoreForPoint(c.lon, c.lat, !!c.coastal);
    pts.push({id:c.id, name:c.name, lat:c.lat, lng:c.lon, score:r.score});
  }

  // Map circles
  if(state.map){
    const map = state.map;
    const fc = {type:'FeatureCollection', features: pts.map(p=>({
      type:'Feature', properties:{name:p.name, score:p.score},
      geometry:{type:'Point', coordinates:[p.lng, p.lat]}
    }))};
    const srcId = 'risk-points';
    if(map.getSource(srcId)) map.getSource(srcId).setData(fc);
    else{
      map.addSource(srcId, {type:'geojson', data: fc});
      map.addLayer({id:'risk-circles', type:'circle', source:srcId,
        paint:{
          'circle-radius': ['interpolate',['linear'],['get','score'],0,4,10,22],
          'circle-color': ['step',['get','score'], '#79d28f', 2,'#ffd24d', 4,'#ffb84d', 7,'#ff4d4d'],
          'circle-opacity': 0.75,
          'circle-stroke-color': '#102038','circle-stroke-width': 1
        }
      });
    }
  }

  // Globe hex columns
  if(state.globe){
    const g = state.globe;
    if(state.layers.urgency){
      g.hexBinPointsData(pts)
       .hexBinPointLat('lat').hexBinPointLng('lng')
       .hexBinResolution(3).hexBinPointsMerge(false)
       .hexBinRadius(0.5)
       .hexTopColor(d=> ['#79d28f','#ffd24d','#ffb84d','#ff4d4d'][Math.min(3, Math.floor((d.sumWeight||0)/3))] )
       .hexSideColor(()=> 'rgba(255,255,255,0.2)')
       .hexAltitude(d=> (d.points[0]?.score||0) * 0.01);
    }else{
      g.hexBinPointsData([]);
    }
  }
}

// Florida impacts
async function updateFloridaImpacts(){
  const container = document.getElementById('floridaImpacts');
  container.innerHTML = '';
  const impacts = [];
  for(const c of FL_CITIES){
    const [arr, dur, warn] = await Promise.all([
      arrivalTimeForPoint(c.lon, c.lat, true),
      durationInsideWind(c.lon, c.lat, 34),
      warningForPoint(c.lon, c.lat)
    ]);
    impacts.push({city:c, arr, dur, warn});
  }
  // Build rows
  const frag = document.createElement('div');
  for(const r of impacts){
    const key = r.city.label;
    const prev = state.prevImpacts.get(key);
    const hoursUntil = r.arr.hoursUntil;
    const cat = arrivalCategory(hoursUntil);
    const eta = r.arr.when ? new Date(r.arr.when).toLocaleString() : '—';
    const durTxt = r.dur.hours!=null ? `${r.dur.hours}h` : '—';
    const warnTag = r.warn ? `<span class="tag ${r.warn.cls}">${r.warn.label}</span>` : '';
    const conf = confidenceFor(r.arr, r.dur, r.warn);
    const confTag = `<span class="ribbon ${conf.cls}">${conf.label} data</span>`;

    // deltas
    let changes='';
    if(prev){
      const dScore = (r.dur.hours||0) - (prev.durH||0);
      const dEta = (r.arr.hoursUntil||0) - (prev.hoursUntil||0);
      const warnChanged = (r.warn?.type||'') !== (prev.warn||'');
      if(Math.abs(dEta)>=6) changes += `<span class="small">${dEta<0?'ETA earlier':'ETA later'} ${Math.abs(dEta)}h</span> `;
      if(Math.abs(dScore)>=6) changes += `<span class="small">${dScore>0?'Longer winds':'Shorter winds'}</span> `;
      if(warnChanged) changes += `<span class="small">Advisory changed</span> `;
    }
    state.prevImpacts.set(key, {hoursUntil, durH:(r.dur.hours||0), warn:(r.warn?.type||'')});

    const row = document.createElement('div');
    row.className = 'row';
    row.innerHTML = `<div><strong>${r.city.label}</strong> <span class="small">(${r.city.county})</span>${warnTag}</div>
                     <div><span class="badge ${cat.cls}">${cat.text}</span>
                     <span class="meta">ETA ${eta} · Dur ~ ${durTxt}</span> <span class="small">${changes}</span></div>`;
    frag.appendChild(row);
  }
  container.appendChild(frag);
  // Also include My Places after cities
  if(state.myPlaces && state.myPlaces.length){
    const header = document.createElement('div'); header.className='row'; header.innerHTML='<div><strong>My Places</strong></div><div></div>';
    container.appendChild(header);
    for(const p of state.myPlaces){
      const [arr, dur, warn] = await Promise.all([
        arrivalTimeForPoint(p.lon, p.lat, true),
        durationInsideWind(p.lon, p.lat, 34),
        warningForPoint(p.lon, p.lat)
      ]);
      const hoursUntil = arr.hoursUntil; const cat = arrivalCategory(hoursUntil);
      const eta = arr.when ? new Date(arr.when).toLocaleString() : '—';
      const durTxt = dur.hours!=null ? `${dur.hours}h` : '—';
      const warnTag = warn ? `<span class="tag ${((warn.type||'').includes('HURRICANE')||(warn.type||'').includes('SURGE'))?'hw':'tsw'}">${warn.type}</span>` : ''; const conf = confidenceFor(arr, dur, warn); const confTag = `<span class="ribbon ${conf.cls}">${conf.label} data</span>`;
      const row = document.createElement('div'); row.className='row';
      const catTag = `<span class="cat ${((p.category||"Other").toLowerCase()==="home")?"home":((p.category||"Other").toLowerCase()==="work")?"work":((p.category||"Other").toLowerCase()==="family")?"family":((p.category||"Other").toLowerCase()==="friend")?"friend":((p.category||"Other").toLowerCase()==="significant other")?"so":"other"}">${p.category||"Other"}</span>`;
      row.innerHTML = `<div><strong>${p.name}</strong> ${catTag} <span class="small">(${p.lat.toFixed(2)}, ${p.lon.toFixed(2)})</span> ${warnTag} ${confTag}</div>
                       <div><span class="badge ${cat.cls}">${cat.text}</span> <span class="meta">ETA ${eta} · Dur ~ ${durTxt}</span></div>`;
      container.appendChild(row);
    }
  }
}

function arrivalCategory(hours){
(hours){
  if(hours==null) return {text:'Low', cls:'calm'};
  if(hours < 24) return {text:'Act now', cls:'danger'};
  if(hours < 48) return {text:'Prepare', cls:'warn'};
  if(hours < 72) return {text:'Monitor', cls:'watch'};
  return {text:'Low', cls:'calm'};
}

// Query arrival time polygons for a point (uses "most likely" layer if available)

// Compute approximate duration inside 34kt wind for a point by testing polygons over timeline
async function durationInsideWind(lon, lat, windCode=34){
  try{
    const id = state._layerIds.wind;
    if(id==null || !state.timeline?.length) return {start:null, end:null, hours:null};
    const p = turf.point([lon, lat]);
    const hits = [];
    for(let i=0;i<state.timeline.length;i++){
      const t = state.timeline[i];
      const where = `stormid='${state.activeStormId}' AND validtime=timestamp '${t}' AND windcode=${windCode}`;
      const gj = await fetchLayerGeoJSON(id, where);
      let inside = false;
      for(const f of gj.features||[]){
        try{
          if(!f.geometry) continue;
          const geom = f.geometry.type==='Polygon' ? f.geometry : (f.geometry.type==='MultiPolygon' ? {type:'Polygon', coordinates:f.geometry.coordinates[0]} : null);
          if(!geom) continue;
          if(turf.booleanPointInPolygon(p, geom)) { inside = true; break; }
        }catch{}
      }
      hits.push(inside);
    }
    const first = hits.indexOf(true);
    const last = hits.lastIndexOf(true);
    if(first===-1 || last===-1) return {start:null, end:null, hours:null};
    const start = new Date(state.timeline[first]).getTime();
    const end = new Date(state.timeline[last]).getTime();
    const hours = Math.max(0, Math.round((end - start)/(1000*60*60)));
    return {start, end, hours};
  }catch(e){
    console.warn('durationInsideWind failed', e);
    return {start:null, end:null, hours:null};
  }
}

// Fetch current watch/warning intersecting a point
async function warningForPoint(lon, lat){
  try{
    const id = state._layerIds.warnings;
    if(id==null) return null;
    const url = `${NOAA_NOWCOAST}/${id}/query?geometry=${lon}%2C${lat}&geometryType=esriGeometryPoint&inSR=4326&spatialRel=esriSpatialRelIntersects&outFields=*,prodtype&returnGeometry=false&f=json`;
    const js = await (await fetch(url)).json();
    const f = js?.features?.[0];
    if(!f) return null;
    const pt = (f.attributes?.prodtype || f.attributes?.product || '').toUpperCase();
    if(pt.includes('HURRICANE WARNING')) return {type:'HURRICANE WARNING', cls:'hw', label:'🛑 HWarn'}; if(pt.includes('STORM SURGE WARNING')) return {type:'STORM SURGE WARNING', cls:'hw', label:'🛑 SurgeWarn'};
    if(pt.includes('HURRICANE WATCH')) return {type:'HURRICANE WATCH', cls:'hwatch', label:'🟠 HWatch'}; if(pt.includes('STORM SURGE WATCH')) return {type:'STORM SURGE WATCH', cls:'hwatch', label:'🟠 SurgeWatch'};
    if(pt.includes('TROPICAL STORM WARNING')) return {type:'TROPICAL STORM WARNING', cls:'tsw', label:'⚠️ TSWarn'};
    if(pt.includes('TROPICAL STORM WATCH')) return {type:'TROPICAL STORM WATCH', cls:'tswatch', label:'🟢 TSWatch'};
    return {type:pt||'Advisory', cls:'', label:pt||'Advisory'};
  }catch(e){
    console.warn('warningForPoint failed', e);
    return null;
  }
}

async function arrivalTimeForPoint(lon, lat, mostLikely=true){
  try{
    const id = mostLikely ? state._layerIds.arrivalML : state._layerIds.arrivalER;
    if(id==null) return {when:null, hoursUntil:null};
    const url = `${NOAA_NOWCOAST}/${id}/query?geometry=${lon}%2C${lat}&geometryType=esriGeometryPoint&inSR=4326&spatialRel=esriSpatialRelIntersects&outFields=*,stormid&returnGeometry=false&f=json`;
    const js = await (await fetch(url)).json();
    const feat = js?.features?.[0];
    if(!feat) return {when:null, hoursUntil:null};
    const t = feat.attributes?.validtime || feat.attributes?.datetime || feat.attributes?.time || null;
    if(!t) return {when:null, hoursUntil:null};
    const when = new Date(t).getTime();
    const hours = (when - Date.now()) / (1000*60*60);
    return {when, hoursUntil: Math.round(hours)};
  }catch(e){
    console.warn('arrivalTimeForPoint failed', e);
    return {when:null, hoursUntil:null};
  }
}

// Closest approach to selected city
async function updateClosestApproach(){
  if(!window._points) return;
  const city = FL_CITIES.find(c=>c.id===citySelect.value) || FL_CITIES[0];
  if(!city) return;
  const pts = window._points.features;
  let best = {km: 1e9, time:null};
  const p = turf.point([city.lon, city.lat]);
  for(const f of pts){
    const q = turf.point(f.geometry.coordinates);
    const d = turf.distance(p, q, {units:'kilometers'});
    if(d < best.km) best = {km:d, time: f.properties.validtime || null};
  }
  const when = best.time ? new Date(best.time).toLocaleString() : '—';
  closestReadout.innerHTML = `<div><strong>${city.label}</strong><br/>Closest approach: ${best.km.toFixed(0)} km (${(best.km*0.621).toFixed(0)} mi) at <span class="small">${when}</span></div>`;
}

// --- Recording (captures current canvas) ---
function toggleRecording(){
  if(state.mediaRecorder && state.mediaRecorder.state==='recording'){
    state.mediaRecorder.stop();
    return;
  }
  const target = state.view==='globe' ? state.globeRenderer?.domElement : document.querySelector('#mapContainer canvas');
  if(!target){ toast('Nothing to record yet.'); return; }
  const stream = target.captureStream(30);
  const rec = new MediaRecorder(stream, {mimeType:'video/webm;codecs=vp9'});
  const chunks=[];
  rec.ondataavailable = e => chunks.push(e.data);
  rec.onstop = () => {
    const blob = new Blob(chunks,{type:'video/webm'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = 'hurricane-explorer.webm'; a.click();
  };
  rec.start();
  state.mediaRecorder = rec;
  toast('Recording… click again to stop.');
}

// Share state
function shareState(){
  const obj = {
    activeStormId: state.activeStormId,
    view: state.view,
    layers: state.layers,
    t: state.activeIndex
  };
  const encoded = btoa(unescape(encodeURIComponent(JSON.stringify(obj))));
  const url = location.origin + location.pathname + '#s=' + encoded;
  navigator.clipboard.writeText(url).then(()=> toast('Link copied to clipboard')).catch(()=> alert(url));
}

// On load: if hash present, restore
(function restoreFromHash(){
  if(location.hash.startsWith('#s=')){
    try{
      const j = JSON.parse(decodeURIComponent(escape(atob(location.hash.slice(3)))));
      Object.assign(state.layers, j.layers||{});
      state.view = j.view || 'globe';
      viewToggle.checked = (state.view==='map');
      state.activeIndex = j.t || 0;
      // Active storm will be set after loading storms
    }catch{}
  }
})();

// Populate city dropdown
fetch('cities_fl.json').then(r=>r.json()).then(list=>{
  citySelect.innerHTML = list.map(c=>`<option value="${c.id}">${c.label}</option>`).join('');
});


// My Groups roll-up
function renderGroups(){
  const el = document.getElementById('groupsPanel'); if(!el) return;
  const groups = {Home:[], Work:[], Family:[], Friend:[], 'Significant other':[], Other:[]};
  (state.myPlaces||[]).forEach(p=> groups[p.category||'Other']?.push(p));
  const entries = Object.entries(groups).filter(([k,v])=> v.length>0);
  if(entries.length===0){ el.textContent='Add places to see group status.'; return; }
  el.innerHTML='';
  entries.forEach(async ([name, list])=>{
    let maxScore = 0, minHours = Infinity, maxDur = 0, anyWarn=null;
    for(const p of list){
      const [arr, dur, warn, risk] = await Promise.all([
        arrivalTimeForPoint(p.lon, p.lat, true),
        durationInsideWind(p.lon, p.lat, 34),
        warningForPoint(p.lon, p.lat),
        riskScoreForPoint(p.lon, p.lat, false)
      ]);
      if(arr.hoursUntil!=null) minHours = Math.min(minHours, arr.hoursUntil);
      if(dur.hours!=null) maxDur = Math.max(maxDur, dur.hours);
      maxScore = Math.max(maxScore, risk.score);
      if(warn && (warn.type||'').includes('WARNING')) anyWarn = warn;
    }
    if(minHours===Infinity) minHours = null;
    const bucket = riskBucket(maxScore);
    const eta = (minHours!=null) ? (minHours<0 ? 'Ongoing' : `${minHours}h`) : '—';
    const dur = maxDur ? `${maxDur}h` : '—';
    const warnTag = anyWarn ? `<span class="tag ${anyWarn.cls}">${anyWarn.label}</span>` : '';
    const row = document.createElement('div'); row.className='groupRow';
    row.innerHTML = `<div><strong>${name}</strong> (${list.length}) ${warnTag}</div><div><span class="badge ${bucket.cls}">${bucket.text}</span> <span class="small">ETA ${eta} · Dur ${dur}</span></div>`;
    el.appendChild(row);
  });
}

// Tiny toast
function toast(msg){
  const el = document.createElement('div');
  el.textContent = msg;
  el.style.position='fixed'; el.style.bottom='14px'; el.style.left='50%'; el.style.transform='translateX(-50%)';
  el.style.background='#111b33'; el.style.color='#e9f2ff'; el.style.border='1px solid #2b3f66';
  el.style.padding='8px 12px'; el.style.borderRadius='8px'; el.style.zIndex=9999;
  document.body.appendChild(el);
  setTimeout(()=>el.remove(), 2400);
}

// --- County polygons (FL) ---
// We try a lightweight public dataset; if it fails, we skip polygons.
const FL_COUNTIES_URLS = [
  // Simplified county polygons (public domain/community sources). If one fails, we'll try the next.
  'https://raw.githubusercontent.com/codeforamerica/click_that_hood/master/public/data/florida-counties.geojson',
  'https://raw.githubusercontent.com/OpenDataDE/State-zip-code-GeoJSON/master/fl-florida-counties.json'
];
let FL_COUNTY_POLYS = null;

async function loadCountyPolys(){
  for(const url of FL_COUNTIES_URLS){
    try{
      const resp = await fetch(url, {cache:'reload'});
      if(!resp.ok) continue;
      const gj = await resp.json();
      // Normalize: ensure each feature has a "name" we can match
      for(const f of gj.features){
        const n = (f.properties?.name || f.properties?.NAME || f.properties?.CountyName || '').toLowerCase();
        f.properties._norm = n.replace(' county','').replace(/[^a-z ]/g,'');
      }
      FL_COUNTY_POLYS = gj;
      return;
    }catch(e){ /* try next */ }
  }
  console.warn('County polygon dataset not available; extrusions disabled.');
}

// Rebuild polygon GeoJSON with 'score' property and add as fill-extrusion
async function renderCountyExtrusions(){
  if(!state.map || !FL_COUNTY_POLYS || !state.layers.countyPolys) return;
  const map = state.map;
  // Sampling cache to avoid recomputation
  const cache = new Map();
  async function scoreForPolygon(poly, fallbackName){
    // Build a small grid over the bbox and sample inside polygon
    const bbox = turf.bbox(poly);
    const spacing = 0.15; // deg grid spacing (denser)
    const grid = turf.pointGrid(bbox, spacing, {units:'degrees'});
    const pts = grid.features.filter(pt => turf.booleanPointInPolygon(pt, poly)).slice(0, 24);
    if(pts.length===0){
      // fallback to centroid
      const c = turf.centroid(poly).geometry.coordinates;
      pts.push({geometry:{coordinates:c}});
    }
    let maxScore = 0;
    for(const pt of pts){
      const [lon,lat] = pt.geometry.coordinates;
      const key = lon.toFixed(3)+','+lat.toFixed(3);
      if(!cache.has(key)){
        const r = await riskScoreForPoint(lon, lat, false);
        cache.set(key, r.score);
      }
      maxScore = Math.max(maxScore, cache.get(key));
      if(maxScore>=10) break;
    }
    return maxScore;
  }
  // Clone feature collection with scores
  const fc = JSON.parse(JSON.stringify(FL_COUNTY_POLYS));
  for(const f of fc.features){
    const poly = f.geometry;
    try{
      const s = await scoreForPolygon(poly, f.properties._norm);
      f.properties.score = s;
    }catch{ f.properties.score = 0; }
  }
  const srcId = 'county-polys';
  if(map.getSource(srcId)) map.getSource(srcId).setData(fc);
  else {
    map.addSource(srcId, {type:'geojson', data: fc});
    map.addLayer({
      id:'county-extrusions', type:'fill-extrusion', source:srcId,
      paint:{
        'fill-extrusion-color': ['step',['get','score'], '#79d28f', 2,'#ffd24d', 4,'#ffb84d', 7,'#ff4d4d'],
        'fill-extrusion-height': ['*', ['get','score'], 5000],
        'fill-extrusion-opacity': 0.8
      }
    });
    map.addLayer({
      id:'county-borders', type:'line', source:srcId,
      paint:{'line-color':'#0b1325','line-width':0.5}
    });
  }
}

// Surge overlay: filter warnings layer for surge products and style
async function renderSurgeOverlay(){
  if(!state.map || !state._layerIds?.warnings) return;
  const map = state.map;
  if(!state.layers.surge){
    if(map.getLayer('surge-fill')) { map.removeLayer('surge-fill'); }
    if(map.getSource('surge-src')) { map.removeSource('surge-src'); }
    return;
  }
  const all = await fetchLayerGeoJSON(state._layerIds.warnings, `stormid='${state.activeStormId}'`);
  const surge = {type:'FeatureCollection', features: (all.features||[]).filter(f => {
    const pt = ((f.properties?.prodtype||'') + ' ' + (f.properties?.product||'')).toUpperCase();
    return pt.includes('STORM SURGE');
  })};
  if(map.getSource('surge-src')) map.getSource('surge-src').setData(surge);
  else{
    map.addSource('surge-src', {type:'geojson', data: surge});
    map.addLayer({id:'surge-fill', type:'fill', source:'surge-src',
      paint:{
        'fill-color': ['match',['upcase',['get','prodtype']],'STORM SURGE WARNING','#ff4d4d','#ff9f43'],
        'fill-opacity': 0.35,
        'fill-outline-color': '#7f1d1d'
      }
    });
  }
}

// --- County PDF briefing ---
const countyPdfSelect = document.getElementById('countyPdfSelect');
const countyPdfBtn = document.getElementById('countyPdfBtn');
if(countyPdfSelect){
  // populate when centroids arrive
  fetch('counties_fl.json').then(r=>r.json()).then(list=>{
    countyPdfSelect.innerHTML = list.map(c=>`<option value="${c.id}">${c.name}</option>`).join('');
  });
}
if(countyPdfBtn){
  countyPdfBtn.onclick = async ()=>{
    const id = countyPdfSelect.value;
    const county = FL_COUNTIES.find(c=>c.id===id) || FL_COUNTIES[0];
    if(!county) return;
    const risk = await riskScoreForPoint(county.lon, county.lat, !!county.coastal);
    const bucket = riskBucket(risk.score);
    const eta = risk.arr.when ? new Date(risk.arr.when).toLocaleString() : '—';
    const dur = (risk.dur.hours!=null) ? `${risk.dur.hours} hours` : '—';
    const warn = risk.warn?.type || '—';
    const conf = confidenceFor(risk.arr, risk.dur, risk.warn);
    const actions = actionsForBucket(bucket.text, !!risk.has64);
    // Build PDF
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({unit:'pt', format:'letter'});
    const margin = 54;
    let y = margin;

    doc.setFont('helvetica','bold'); doc.setFontSize(18);
    doc.text(`County Briefing: ${county.name}, FL`, margin, y); y+=22;
    doc.setFont('helvetica','normal'); doc.setFontSize(12);
    doc.text(`Storm: ${state.activeStormId || 'Active storm'}   |   Urgency: ${bucket.text}   |   Score: ${risk.score}/10   |   Confidence: ${conf.label}`, margin, y); y+=18;
    doc.text(`Most-likely arrival of TS winds: ${eta}`, margin, y); y+=18;
    doc.text(`Estimated duration ≥34 kt: ${dur}`, margin, y); y+=18;
    doc.text(`Current watches/warnings: ${warn}`, margin, y); y+=22;

    doc.setFont('helvetica','bold'); doc.setFontSize(14);
    doc.text('Recommended Actions', margin, y); y+=16;
    doc.setFont('helvetica','normal'); doc.setFontSize(12);
    actions.forEach(a=>{ doc.text(`• ${a}`, margin, y); y+=16; });

    y+=10; doc.setFontSize(10);
    doc.text('Notes: This briefing is synthesized from NHC/NOAA nowCOAST layers (arrival time, wind radii, warnings).', margin, y); y+=14;
    doc.text('Always follow local officials and NHC advisories. This is an educational tool, not an official forecast.', margin, y);

    doc.save(`${county.name.replace(/\\s+/g,'_')}_briefing.pdf`);
  };
}

function actionsForBucket(bucketText, has64){
  const base = {
    'Evacuate if ordered': [
      'Follow official evacuation orders immediately.',
      'Move away from surge-prone zones and manufactured housing.',
      'Complete home hardening; secure loose items; prepare to be off roads for 24–36 hours.',
      'Bring go-bags, meds, documents, chargers.'
    ],
    'Consider leaving (vulnerable/coastal)': [
      'If in surge/low-lying areas, consider relocating inland ahead of the first TS winds.',
      'Top off fuel; charge devices and backup power.',
      'Stage shutters; secure outdoor items; have 3 days of water/food/meds.'
    ],
    'Shelter & prepare': [
      'Shelter in a hardened interior room away from windows.',
      'Expect power outages; check flashlights, batteries, and water.',
      'Stay off roads during strongest winds and local warnings.'
    ],
    'Monitor': [
      'Monitor NHC advisories and local NWS updates twice daily.',
      'Check kits and refill basics as needed.'
    ]
  };
  const list = base[bucketText] || base['Monitor'];
  if(has64 && !list.includes('Treat interior rooms as safe rooms during peak conditions.')){
    list.push('Treat interior rooms as safe rooms during peak conditions.');
  }
  return list;
}



async function runDiagnostics(){
  log('--- Diagnostics ---');
  log('UserAgent', navigator.userAgent);
  log('WebGL', hasWebGL());
  // try simple fetches
  try{ const r=await fetch('https://tile.openstreetmap.org/1/1/1.png', {mode:'cors'}); log('OSM tiles', r.status); }catch(e){ log('OSM tiles ERR', String(e)); }
  try{ const r=await fetch('https://www.nhc.noaa.gov/CurrentStorms.json', {mode:'cors'}); log('NHC feed', r.status); }catch(e){ log('NHC feed ERR', String(e)); }
  try{ const r=await fetch(NOAA_NOWCOAST+'?f=pjson', {mode:'cors'}); log('nowCOAST meta', r.status); }catch(e){ log('nowCOAST ERR', String(e)); }
  try{ const r=await fetch('https://nominatim.openstreetmap.org/search?q=Orlando&format=jsonv2', {mode:'cors'}); log('Search (Nominatim)', r.status); }catch(e){ log('Search ERR', String(e)); }
  log('Offline mode', !!state._offline);
  log('Active storm', state.activeStormId);
  log('Timeline len', (state.timeline||[]).length);
}

// Start
loadStorms().then(async()=>{ await loadCountyPolys(); if(state.center){ setTimeout(()=> setCenter(state.center.lat, state.center.lon, state.center.label||'Saved'), 300); } maybeAskPreload(); });
