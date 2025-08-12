const logEl = document.getElementById('log');
function log(...a){ const t=a.map(x=> typeof x==='object'? JSON.stringify(x): String(x)).join(' '); logEl.textContent += t+'\n'; logEl.scrollTop=logEl.scrollHeight; console.log(...a); }

// Map
const map = L.map('map',{preferCanvas:true}).setView([27,-82], 5);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{attribution:'© OpenStreetMap'}).addTo(map);

// State
const state = { data:null, idx:0 };
const timeSlider = document.getElementById('time');
const tlabel = document.getElementById('tlabel');

// Layers
const coneL = L.layerGroup().addTo(map);
const trackL = L.layerGroup().addTo(map);
const w34L = L.layerGroup().addTo(map);
const w50L = L.layerGroup().addTo(map);
const w64L = L.layerGroup().addTo(map);

document.getElementById('togglePanel').onclick = ()=>{
  const p = document.getElementById('panel');
  const hidden = p.style.display==='none';
  p.style.display = hidden ? 'block':'none';
};

function pnpoly(pt, ring){
  const x = pt[1], y = pt[0]; let inside=false;
  for(let i=0,j=ring.length-1;i<ring.length;j=i++){
    const xi=ring[i][0], yi=ring[i][1], xj=ring[j][0], yj=ring[j][1];
    const inter=((yi>y)!=(yj>y)) && (x<(xj-xi)*(y-yi)/(yj-yi+1e-12)+xi); if(inter) inside=!inside;
  } return inside;
}

async function loadDemo(){
  const j = await fetch('demo_offline.json').then(r=>r.json());
  state.data = j;
  timeSlider.max = j.timeline.length-1;
  timeSlider.value = 0;
  updateTime();
  drawAll();
  buildImpacts();
  log('Demo loaded; times:', j.timeline.length);
}

function updateTime(){
  const t = state.data.timeline[state.idx];
  tlabel.textContent = new Date(t).toUTCString().replace(':00 GMT','Z');
}

function drawAll(){
  [coneL,trackL,w34L,w50L,w64L].forEach(g=>g.clearLayers());
  const t = state.data.timeline[state.idx];

  // Cone
  state.data.layers.cone.features.forEach(f=>{
    const ll = f.geometry.coordinates[0].map(c=>[c[1],c[0]]);
    L.polygon(ll,{color:'#6ea8ff',fillColor:'#6ea8ff',fillOpacity:.25,weight:1}).addTo(coneL);
  });
  // Track
  state.data.layers.track.features.forEach(f=>{
    const ll = f.geometry.coordinates.map(c=>[c[1],c[0]]);
    L.polyline(ll,{color:'#fff',weight:2}).addTo(trackL);
  });
  // Winds
  const drawW = (code, layer, color)=>{
    state.data.layers.wind.features.filter(f=>f.properties.validtime===t && f.properties.windcode===code)
      .forEach(f=>{
        const ll = f.geometry.coordinates[0].map(c=>[c[1],c[0]]);
        L.polygon(ll,{color,fillColor:color,fillOpacity:.18,weight:1}).addTo(layer);
      });
  };
  drawW(34, w34L, '#ffd24d');
  drawW(50, w50L, '#ff9f43');
  drawW(64, w64L, '#ff4d4d');

  // Fit to cone once at first draw
  if(!drawAll._fit){ const b = coneL.getBounds(); if(b.isValid()) map.fitBounds(b.pad(0.25)); drawAll._fit=true; }
}

timeSlider.oninput = ()=>{ state.idx = +timeSlider.value; updateTime(); drawAll(); };

document.getElementById('reload').onclick = ()=>{ drawAll._fit=false; loadDemo(); };

// Ticks
function firstInTime(lon, lat, code){
  for(const t of state.data.timeline){
    const feats = state.data.layers.wind.features.filter(f=> f.properties.validtime===t && f.properties.windcode===code);
    for(const f of feats){
      if(pnpoly([lat,lon], f.geometry.coordinates[0])) return Date.parse(t);
    }
  } return null;
}
function durationIn(lon, lat, code){
  let first=null,last=null;
  for(const t of state.data.timeline){
    const feats = state.data.layers.wind.features.filter(f=> f.properties.validtime===t && f.properties.windcode===code);
    let inside=false;
    for(const f of feats){ if(pnpoly([lat,lon], f.geometry.coordinates[0])) {inside=true; break;} }
    if(inside){ if(first==null) first=Date.parse(t); last=Date.parse(t); }
  } if(first==null||last==null) return null;
  return Math.max(0, Math.round((last-first)/36e5));
}
function cat(hours){ if(hours==null) return {t:'Low',c:'calm'}; if(hours<24) return {t:'Act now',c:'danger'}; if(hours<48) return {t:'Prepare',c:'warn'}; if(hours<72) return {t:'Monitor',c:'watch'}; return {t:'Low',c:'calm'}; }

async function buildImpacts(){
  const cities = [
    {"label":"Orlando","lat":28.5383,"lon":-81.3792},
    {"label":"Miami","lat":25.7617,"lon":-80.1918},
    {"label":"Tampa","lat":27.9506,"lon":-82.4572},
    {"label":"Jacksonville","lat":30.3322,"lon":-81.6557},
    {"label":"St. Petersburg","lat":27.7676,"lon":-82.6403},
  ];
  const box = document.getElementById('impacts'); box.innerHTML='';
  const parts = [];
  for(const c of cities){
    const eta = firstInTime(c.lon,c.lat,34);
    const dur = durationIn(c.lon,c.lat,34);
    const h = eta==null? null : Math.round((eta - Date.now())/36e5);
    const k = cat(h);
    parts.push(`<div class="row"><strong>${c.label}</strong> — <span class="badge ${k.c}">${k.t}</span> <span class="small">${eta? new Date(eta).toLocaleString(): '—'} · Dur ${dur??'—'}h</span></div>`);
  }
  box.innerHTML = parts.join('');
}

loadDemo();

// Layer toggles
document.getElementById('coneChk').onchange = e => e.target.checked ? coneL.addTo(map) : map.removeLayer(coneL);
document.getElementById('trackChk').onchange = e => e.target.checked ? trackL.addTo(map) : map.removeLayer(trackL);
document.getElementById('wind34Chk').onchange = e => e.target.checked ? w34L.addTo(map) : map.removeLayer(w34L);
document.getElementById('wind50Chk').onchange = e => e.target.checked ? w50L.addTo(map) : map.removeLayer(w50L);
document.getElementById('wind64Chk').onchange = e => e.target.checked ? w64L.addTo(map) : map.removeLayer(w64L);
