// v6 beta: Leaflet + canvas fallback, demo + Live Data loader (manual + NHC list if available).
const logEl = document.getElementById('log');
function log(...a){ const t=a.map(x=> typeof x==='object'? JSON.stringify(x): String(x)).join(' '); logEl.textContent += t+'\n'; logEl.scrollTop=logEl.scrollHeight; console.log(...a); }

const mapHost = document.getElementById('map');
const state = { useLeaflet:false, map:null, layers:{}, view:null, canvas:null, ctx:null, data:null, idx:0, fitted:false };

// Init buttons
document.getElementById('togglePanel').onclick = ()=>{
  const p = document.getElementById('panel'); const hidden = p.style.display==='none';
  p.style.display = hidden ? 'block':'none'; setTimeout(resize, 150);
};
document.getElementById('reloadDemo').onclick = ()=>{ loadDemo(); };
document.getElementById('showFlorida').onclick = ()=>{ fitFlorida(); draw(); };

document.getElementById('loadNHC').onclick = loadNHCList;
document.getElementById('loadSelected').onclick = ()=> loadFromSelect();
document.getElementById('loadManual').onclick = ()=> loadManual();

const timeSlider = document.getElementById('time');
const tlabel = document.getElementById('tlabel');
timeSlider.oninput = ()=>{ state.idx = +timeSlider.value; updateT(); draw(); buildImpacts(); };

// Start
if(window.L){ startLeaflet(); } else { startCanvas(); }
loadDemo();

// ---------- Core rendering ----------
function startLeaflet(){
  state.useLeaflet = true;
  state.map = L.map('map',{preferCanvas:true, zoomControl:true});
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{attribution:'© OpenStreetMap'}).addTo(state.map);
  state.layers.cone = L.layerGroup().addTo(state.map);
  state.layers.track = L.layerGroup().addTo(state.map);
  state.layers.w34 = L.layerGroup().addTo(state.map);
  state.layers.w50 = L.layerGroup().addTo(state.map);
  state.layers.w64 = L.layerGroup().addTo(state.map);
  fitFlorida();
  wireToggles();
  log('Leaflet path');
}
function wireToggles(){
  document.getElementById('coneChk').onchange = e => toggle('cone', e.target.checked);
  document.getElementById('trackChk').onchange = e => toggle('track', e.target.checked);
  document.getElementById('wind34Chk').onchange = e => toggle('w34', e.target.checked);
  document.getElementById('wind50Chk').onchange = e => toggle('w50', e.target.checked);
  document.getElementById('wind64Chk').onchange = e => toggle('w64', e.target.checked);
}
function toggle(key,on){ if(!state.useLeaflet) return draw(); const g=state.layers[key]; if(!g) return; if(on) g.addTo(state.map); else state.map.removeLayer(g); }

function startCanvas(){
  document.getElementById('fallbackNote').style.display='inline-block';
  const c = document.createElement('canvas'); c.width=mapHost.clientWidth; c.height=mapHost.clientHeight; mapHost.appendChild(c);
  state.canvas=c; state.ctx=c.getContext('2d'); fitFlorida(); log('Canvas path');
  window.addEventListener('resize', resize);
}

function resize(){ if(state.canvas){ const w=mapHost.clientWidth, h=mapHost.clientHeight; state.canvas.width=w; state.canvas.height=h; draw(); } if(state.map) state.map.invalidateSize(); }
function fitFlorida(){ if(state.useLeaflet) state.map.fitBounds([[24.3,-87.7],[31.2,-79.8]]); else state.view={cx:-83.5,cy:27.5,scale:5.2}; }

function updateT(){ const t = state.data.timeline[state.idx]; tlabel.textContent = new Date(t).toUTCString().replace(':00 GMT','Z'); }

function draw(){
  if(!state || !state.data) return;
  if(state.useLeaflet) drawLeaflet(); else drawCanvas();
}

function clearLeaflet(){ Object.values(state.layers).forEach(g=> g&&g.clearLayers()); }
function drawLeaflet(){
  clearLeaflet();
  const t = state.data.timeline[state.idx];
  if(document.getElementById('coneChk').checked){
    state.data.layers.cone.features.forEach(f=> L.polygon(f.geometry.coordinates[0].map(c=>[c[1],c[0]]),{color:'#8bb9ff',fillColor:'#6ea8ff',fillOpacity:.25,weight:1}).addTo(state.layers.cone));
  }
  if(document.getElementById('trackChk').checked){
    state.data.layers.track.features.forEach(f=> L.polyline(f.geometry.coordinates.map(c=>[c[1],c[0]]),{color:'#fff',weight:2}).addTo(state.layers.track));
  }
  const drawW=(code,group,color)=>{
    state.data.layers.wind.features.filter(f=> f.properties.validtime===t && f.properties.windcode===code)
      .forEach(f=> L.polygon(f.geometry.coordinates[0].map(c=>[c[1],c[0]]),{color,fillColor:color,fillOpacity:.18,weight:1}).addTo(group));
  };
  if(document.getElementById('wind34Chk').checked) drawW(34,state.layers.w34,'#ffd24d');
  if(document.getElementById('wind50Chk').checked) drawW(50,state.layers.w50,'#ff9f43');
  if(document.getElementById('wind64Chk').checked) drawW(64,state.layers.w64,'#ff4d4d');

  if(!state.fitted){ fitFlorida(); state.fitted=true; }
}

function project(lon,lat){ const w=state.canvas.width, h=state.canvas.height; const s=state.view.scale, cx=state.view.cx, cy=state.view.cy; return [(lon-cx)*s+w/2,(cy-lat)*s+h/2]; }
function drawPoly(ctx, coords, opts){ ctx.beginPath(); coords.forEach((c,i)=>{ const p=project(c[0],c[1]); if(i===0) ctx.moveTo(p[0],p[1]); else ctx.lineTo(p[0],p[1]); }); ctx.closePath(); if(opts.fill){ ctx.fillStyle=opts.fill; ctx.globalAlpha=opts.alpha||1; ctx.fill(); ctx.globalAlpha=1; } if(opts.stroke){ ctx.strokeStyle=opts.stroke; ctx.lineWidth=opts.width||1; ctx.stroke(); } }
function drawCanvas(){
  const ctx=state.ctx; const w=state.canvas.width, h=state.canvas.height;
  const grad=ctx.createRadialGradient(w*0.4,h*0.5,0,w*0.4,h*0.5,Math.max(w,h)); grad.addColorStop(0,'#0b162c'); grad.addColorStop(1,'#091222'); ctx.fillStyle=grad; ctx.fillRect(0,0,w,h);
  const t = state.data.timeline[state.idx];
  if(document.getElementById('coneChk').checked){ state.data.layers.cone.features.forEach(f=> drawPoly(ctx,f.geometry.coordinates[0],{fill:'#6ea8ff',alpha:.25,stroke:'#8bb9ff',width:1})); }
  if(document.getElementById('trackChk').checked){ ctx.strokeStyle='#fff'; ctx.lineWidth=2; ctx.beginPath(); state.data.layers.track.features.forEach(f=>{ f.geometry.coordinates.forEach((c,i)=>{ const p=project(c[0],c[1]); if(i===0) ctx.moveTo(p[0],p[1]); else ctx.lineTo(p[0],p[1]); }); }); ctx.stroke(); }
  function drawW(code,col){ state.data.layers.wind.features.filter(f=> f.properties.validtime===t && f.properties.windcode===code).forEach(f=> drawPoly(ctx, f.geometry.coordinates[0], {fill:col,alpha:.18,stroke:col,width:1})); }
  if(document.getElementById('wind34Chk').checked) drawW(34,'#ffd24d');
  if(document.getElementById('wind50Chk').checked) drawW(50,'#ff9f43');
  if(document.getElementById('wind64Chk').checked) drawW(64,'#ff4d4d');
}

// ---------- Data loading ----------
async function loadDemo(){
  try{
    const j = await fetch('demo_offline.json', {cache:'no-store'}).then(r=>r.json());
    state.data = j; state.idx=0; state.fitted=false; timeSlider.max=j.timeline.length-1; timeSlider.value=0; updateT(); draw(); buildImpacts(); log('Demo loaded');
  }catch(e){ log('Demo load failed', e); }
}

// Manual URLs
async function loadManual(){
  const coneUrl = document.getElementById('coneUrl').value.trim();
  const trackUrl = document.getElementById('trackUrl').value.trim();
  const windUrl = document.getElementById('windUrl').value.trim();
  if(!coneUrl && !trackUrl && !windUrl){ log('No manual URLs entered'); return; }
  try{
    const [cone, track, wind] = await Promise.all([
      coneUrl? fetch(coneUrl).then(r=>r.json()) : {type:'FeatureCollection',features:[]},
      trackUrl? fetch(trackUrl).then(r=>r.json()) : {type:'FeatureCollection',features:[]},
      windUrl? fetch(windUrl).then(r=>r.json()) : {type:'FeatureCollection',features:[]},
    ]);
    const timeline = inferTimeline(wind);
    state.data = { timeline, layers: { cone, track, wind } };
    state.idx = 0; timeSlider.max=timeline.length-1; timeSlider.value=0; state.fitted=false; updateT(); draw(); buildImpacts();
    log('Manual live data loaded');
  }catch(e){ log('Manual load failed', e); }
}

// Auto from NHC list
async function loadNHCList(){
  try{
    const url = 'https://www.nhc.noaa.gov/CurrentStorms.json';
    const list = await fetch(url, {cache:'no-store'}).then(r=>r.json());
    // Very light parsing: we just show storm names + IDs if present; manual URLs still recommended for specifics.
    const sel = document.getElementById('stormSelect'); sel.innerHTML = '<option value="">— choose —</option>';
    const storms = (list?.activeStorms) || (list?.storms) || [];
    storms.forEach((s,i)=>{
      const id = s?.id || s?.stormId || `storm${i}`;
      const name = s?.name || s?.stormName || s?.storm?.name || 'Storm';
      const basin = s?.basin || s?.stormBasin || '';
      const adv = s?.advisory || s?.publicAdvisory || '';
      const opt = document.createElement('option'); opt.value = JSON.stringify(s); opt.textContent = `${name} ${id} ${basin} ${adv}`;
      sel.appendChild(opt);
    });
    log('Loaded NHC list, items:', storms.length);
  }catch(e){ log('NHC list failed (CORS or schema). Paste manual URLs as fallback.', e); }
}

async function loadFromSelect(){
  const sel = document.getElementById('stormSelect');
  if(!sel.value){ log('No storm selected.'); return; }
  try{
    const obj = JSON.parse(sel.value);
    // We can’t rely on exact schema; provide fields for manual override instead.
    log('Selected storm:', obj?.name || obj?.stormName || obj?.id);
    // If the object contains direct GeoJSON URLs (some feeds do), try to fetch them; else ask user to paste URLs.
    const coneUrl = obj?.cone?.geojson || obj?.cone?.url || '';
    const trackUrl = obj?.track?.geojson || obj?.track?.url || '';
    const windUrl = obj?.wind?.geojson || obj?.wind?.url || '';
    if(coneUrl || trackUrl || windUrl){
      document.getElementById('coneUrl').value = coneUrl;
      document.getElementById('trackUrl').value = trackUrl;
      document.getElementById('windUrl').value = windUrl;
      await loadManual();
    }else{
      log('Storm entry lacks direct GeoJSON links. Paste known URLs and click "Load manual URLs".');
    }
  }catch(e){ log('Failed to parse selected storm entry', e); }
}

// Infer timeline from wind features (by validtime), or fall back to 1-step
function inferTimeline(windFC){
  const tset = new Set();
  (windFC?.features || []).forEach(f=>{ const t=f?.properties?.validtime; if(t) tset.add(t); });
  const arr = Array.from(tset).sort();
  return arr.length ? arr : [new Date().toISOString()];
}

// ---------- Impacts (Florida) ----------
function pnpoly(pt, ring){ const x=pt[1],y=pt[0]; let inside=false; for(let i=0,j=ring.length-1;i<ring.length;j=i++){ const xi=ring[i][0],yi=ring[i][1],xj=ring[j][0],yj=ring[j][1]; const inter=((yi>y)!=(yj>y)) && (x<(xj-xi)*(y-yi)/(yj-yi+1e-12)+xi); if(inter) inside=!inside; } return inside; }
function firstInTime(lon, lat, code){ for(const t of state.data.timeline){ const feats=state.data.layers.wind.features.filter(f=> f.properties.validtime===t && f.properties.windcode===code); for(const f of feats){ if(pnpoly([lat,lon], f.geometry.coordinates[0])) return Date.parse(t); } } return null; }
function durationIn(lon, lat, code){ let first=null,last=null; for(const t of state.data.timeline){ const feats=state.data.layers.wind.features.filter(f=> f.properties.validtime===t && f.properties.windcode===code); let inP=false; for(const f of feats){ if(pnpoly([lat,lon], f.geometry.coordinates[0])) {inP=true; break;} } if(inP){ if(first==null) first=Date.parse(t); last=Date.parse(t); } } if(first==null||last==null) return null; return Math.max(0, Math.round((last-first)/36e5)); }
function cat(hours){ if(hours==null) return {t:'Low',c:'calm'}; if(hours<24) return {t:'Act now',c:'danger'}; if(hours<48) return {t:'Prepare',c:'warn'}; if(hours<72) return {t:'Monitor',c:'watch'}; return {t:'Low',c:'calm'}; }
function buildImpacts(){
  if(!state.data) return;
  const cities=[
    {label:'Orlando',lat:28.5383,lon:-81.3792},
    {label:'Miami',lat:25.7617,lon:-80.1918},
    {label:'Tampa',lat:27.9506,lon:-82.4572},
    {label:'Jacksonville',lat:30.3322,lon:-81.6557},
    {label:'St. Petersburg',lat:27.7676,lon:-82.6403},
    {label:'West Palm Beach',lat:26.7153,lon:-80.0534},
  ];
  const box=document.getElementById('impacts'); box.innerHTML='';
  const parts=[];
  for(const c of cities){
    const eta=firstInTime(c.lon,c.lat,34);
    const dur=durationIn(c.lon,c.lat,34);
    const h=eta==null? null : Math.round((eta - Date.now())/36e5);
    const k=cat(h);
    parts.push(`<div class="row"><strong>${c.label}</strong> — <span class="badge ${k.c}">${k.t}</span> <span class="small">${eta? new Date(eta).toLocaleString(): '—'} · Dur ${dur??'—'}h</span></div>`);
  }
  box.innerHTML = parts.join('');
}
