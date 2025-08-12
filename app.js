// v5: Leaflet fallback (no WebGL). Always works on Android + GitHub Pages.
// Uses local demo_offline.json for everything.

const logEl = document.getElementById('log');
function log(...a){ const t=a.map(x=> typeof x==='object'? JSON.stringify(x): String(x)).join(' '); logEl.textContent += t+'\n'; logEl.scrollTop=logEl.scrollHeight; console.log(...a); }

const map = L.map('map',{ zoomControl:true, preferCanvas:true }).setView([27,-82], 5);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{ attribution:'© OpenStreetMap' }).addTo(map);

const state = {
  data: null,
  idx: 0
};

async function loadDemo(){
  const j = await fetch('demo_offline.json').then(r=>r.json());
  state.data = j;
  log('Loaded demo with times:', j.timeline.length);
  drawLayers();
  buildImpacts();
}

const layers = {
  cone: L.layerGroup().addTo(map),
  track: L.layerGroup().addTo(map),
  wind34: L.layerGroup().addTo(map),
  wind50: L.layerGroup().addTo(map),
  wind64: L.layerGroup().addTo(map)
};

function drawLayers(){
  const d = state.data;
  const t = d.timeline[state.idx];
  clearLayers();
  // cone
  for(const f of d.layers.cone.features){
    const latlngs = f.geometry.coordinates[0].map(c=>[c[1],c[0]]);
    L.polygon(latlngs,{color:'#6ea8ff',fillColor:'#6ea8ff',fillOpacity:.25,weight:1}).addTo(layers.cone);
  }
  // track
  for(const f of d.layers.track.features){
    const latlngs = f.geometry.coordinates.map(c=>[c[1],c[0]]);
    L.polyline(latlngs,{color:'#fff',weight:2}).addTo(layers.track);
  }
  // winds
  const addWind=(code,group,color)=>{
    const feats = d.layers.wind.features.filter(f=> f.properties.validtime===t && f.properties.windcode===code);
    for(const f of feats){
      const latlngs = f.geometry.coordinates[0].map(c=>[c[1],c[0]]);
      L.polygon(latlngs,{color,fillColor:color,fillOpacity:.18,weight:1}).addTo(group);
    }
  };
  addWind(34,layers.wind34,'#ffd24d');
  addWind(50,layers.wind50,'#ff9f43');
  addWind(64,layers.wind64,'#ff4d4d');
  map.fitBounds(layers.cone.getBounds().pad(0.2));
}

function clearLayers(){
  Object.values(layers).forEach(g=> g.clearLayers());
}

// Florida impacts from local cities list + wind radii across times
async function buildImpacts(){
  const cities = await fetch('cities_fl.json').then(r=>r.json());
  const d = state.data;
  const div = document.getElementById('impacts'); div.innerHTML='';
  const rows = [];
  for(const c of cities){
    const eta = firstInTime(c.lon, c.lat, 34);
    const dur = durationIn(c.lon, c.lat, 34);
    const cat = arrivalCategory(eta==null ? null : Math.round((eta - Date.now())/36e5));
    rows.push(`<div class="row"><strong>${c.label}</strong> — <span class="badge ${cat.cls}">${cat.text}</span> <span class="small">${eta? new Date(eta).toLocaleString(): '—'} · Dur ${dur ?? '—'}h</span></div>`);
  }
  div.innerHTML = rows.join('');
}

function firstInTime(lon, lat, code){
  const p = [lat,lon];
  for(const t of state.data.timeline){
    const feats = state.data.layers.wind.features.filter(f=> f.properties.validtime===t && f.properties.windcode===code);
    for(const f of feats){
      if(pointInPoly(p, f.geometry.coordinates[0])){
        return Date.parse(t);
      }
    }
  }
  return null;
}
function durationIn(lon, lat, code){
  const p = [lat,lon];
  let first=null, last=null;
  for(const t of state.data.timeline){
    const feats = state.data.layers.wind.features.filter(f=> f.properties.validtime===t && f.properties.windcode===code);
    let inside=false;
    for(const f of feats){
      if(pointInPoly(p, f.geometry.coordinates[0])) { inside=true; break; }
    }
    if(inside){ if(first===null) first=Date.parse(t); last=Date.parse(t); }
  }
  if(first==null || last==null) return null;
  return Math.max(0, Math.round((last-first)/36e5));
}
// simple pnpoly
function pointInPoly(p, ring){
  const x = p[1], y = p[0];
  let inside=false;
  for(let i=0,j=ring.length-1;i<ring.length;j=i++){
    const xi=ring[i][0], yi=ring[i][1];
    const xj=ring[j][0], yj=ring[j][1];
    const inter = ((yi>y)!=(yj>y)) && (x < (xj-xi)*(y-yi)/(yj-yi+1e-12)+xi);
    if(inter) inside=!inside;
  }
  return inside;
}

function arrivalCategory(hours){
  if(hours==null) return {text:'Low', cls:'calm'};
  if(hours<24) return {text:'Act now', cls:'danger'};
  if(hours<48) return {text:'Prepare', cls:'warn'};
  if(hours<72) return {text:'Monitor', cls:'watch'};
  return {text:'Low', cls:'calm'};
}

// Layer toggles
document.getElementById('coneChk').onchange = e => e.target.checked ? layers.cone.addTo(map) : map.removeLayer(layers.cone);
document.getElementById('trackChk').onchange = e => e.target.checked ? layers.track.addTo(map) : map.removeLayer(layers.track);
document.getElementById('wind34Chk').onchange = e => e.target.checked ? layers.wind34.addTo(map) : map.removeLayer(layers.wind34);
document.getElementById('wind50Chk').onchange = e => e.target.checked ? layers.wind50.addTo(map) : map.removeLayer(layers.wind50);
document.getElementById('wind64Chk').onchange = e => e.target.checked ? layers.wind64.addTo(map) : map.removeLayer(layers.wind64);

document.getElementById('centerFlorida').onclick = ()=> map.fitBounds([[24.3,-87.7],[31.2,-80.0]]);

loadDemo();
