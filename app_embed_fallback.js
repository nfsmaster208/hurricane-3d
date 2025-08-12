// v6.1 embed hotfix — uses demo_offline.json, but falls back to inline #demo if fetch fails
const logEl = document.getElementById('log');
function log(...a){ const t=a.map(x=> typeof x==='object'? JSON.stringify(x): String(x)).join(' '); logEl.textContent += t+'\n'; logEl.scrollTop=logEl.scrollHeight; console.log(...a); }

const mapHost = document.getElementById('map');
const state = { useLeaflet:false, map:null, layers:{}, view:null, canvas:null, ctx:null, data:null, idx:0, fitted:false, source:'demo' };

const ROOT = 'https://mapservices.weather.noaa.gov/tropical/rest/services/tropical/NHC_tropical_weather_summary/MapServer';
const LAYER_TRACK = 6, LAYER_CONE = 7, LAYER_WIND = 15;

document.getElementById('togglePanel').onclick = ()=>{ const p = document.getElementById('panel'); const hidden = p.style.display==='none'; p.style.display = hidden ? 'block':'none'; setTimeout(resize, 150); };
document.getElementById('reloadDemo').onclick = ()=> loadDemo();
document.getElementById('showFlorida').onclick = ()=>{ fitFlorida(); draw(); };
document.getElementById('loadNHC').onclick = loadNHCList;
document.getElementById('loadSelected').onclick = ()=> loadFromSelect();
document.getElementById('loadManual').onclick = ()=> loadManual();
document.getElementById('loadMirror').onclick = ()=> loadMirror();

const timeSlider = document.getElementById('time'); const tlabel = document.getElementById('tlabel');
timeSlider.oninput = ()=>{ state.idx=+timeSlider.value; updateT(); draw(); };

if(window.L){ startLeaflet(); } else { startCanvas(); }
loadDemo();

function startLeaflet(){ state.useLeaflet=true; state.map=L.map('map',{preferCanvas:true,zoomControl:true}); L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{attribution:'© OpenStreetMap'}).addTo(state.map);
  state.layers.cone=L.layerGroup().addTo(state.map); state.layers.track=L.layerGroup().addTo(state.map); state.layers.w34=L.layerGroup().addTo(state.map); state.layers.w50=L.layerGroup().addTo(state.map); state.layers.w64=L.layerGroup().addTo(state.map); fitFlorida();
  document.getElementById('coneChk').onchange=e=>toggle('cone',e.target.checked); document.getElementById('trackChk').onchange=e=>toggle('track',e.target.checked); document.getElementById('wind34Chk').onchange=e=>toggle('w34',e.target.checked); document.getElementById('wind50Chk').onchange=e=>toggle('w50',e.target.checked); document.getElementById('wind64Chk').onchange=e=>toggle('w64',e.target.checked); }
function toggle(k,on){ if(!state.useLeaflet) return draw(); const g=state.layers[k]; if(!g) return; if(on) g.addTo(state.map); else state.map.removeLayer(g); }
function startCanvas(){ document.getElementById('fallbackNote').style.display='inline-block'; const c=document.createElement('canvas'); c.width=mapHost.clientWidth; c.height=mapHost.clientHeight; mapHost.appendChild(c); state.canvas=c; state.ctx=c.getContext('2d'); fitFlorida(); window.addEventListener('resize', resize); }
function resize(){ if(state.canvas){ const w=mapHost.clientWidth,h=mapHost.clientHeight; state.canvas.width=w; state.canvas.height=h; draw(); } if(state.map) state.map.invalidateSize(); }
function fitFlorida(){ if(state.useLeaflet) state.map.fitBounds([[24.3,-87.7],[31.2,-79.8]]); else state.view={cx:-83.5,cy:27.5,scale:5.2}; }
function updateT(){ const t = state.data.timeline[state.idx]; tlabel.textContent = new Date(t).toUTCString().replace(':00 GMT','Z'); }
function draw(){ if(!state || !state.data) return; state.useLeaflet ? drawLeaflet() : drawCanvas(); }
function clearLeaflet(){ Object.values(state.layers).forEach(g=> g&&g.clearLayers()); }
function drawLeaflet(){ clearLeaflet(); const t=state.data.timeline[state.idx];
  if(document.getElementById('coneChk').checked){ state.data.layers.cone.features.forEach(f=> L.polygon(f.geometry.coordinates[0].map(c=>[c[1],c[0]]),{color:'#8bb9ff',fillColor:'#6ea8ff',fillOpacity:.25,weight:1}).addTo(state.layers.cone)); }
  if(document.getElementById('trackChk').checked){ state.data.layers.track.features.forEach(f=> L.polyline(f.geometry.coordinates.map(c=>[c[1],c[0]]),{color:'#fff',weight:2}).addTo(state.layers.track)); }
  const drawW=(code,group,color)=>{ state.data.layers.wind.features.filter(f=> f.properties.validtime===t && f.properties.windcode===code).forEach(f=> L.polygon(f.geometry.coordinates[0].map(c=>[c[1],c[0]]),{color,fillColor:color,fillOpacity:.18,weight:1}).addTo(group)); };
  if(document.getElementById('wind34Chk').checked) drawW(34,state.layers.w34,'#ffd24d'); if(document.getElementById('wind50Chk').checked) drawW(50,state.layers.w50,'#ff9f43'); if(document.getElementById('wind64Chk').checked) drawW(64,state.layers.w64,'#ff4d4d');
}
function project(lon,lat){ const w=state.canvas.width,h=state.canvas.height; const s=state.view.scale,cx=state.view.cx,cy=state.view.cy; return [(lon-cx)*s+w/2,(cy-lat)*s+h/2]; }
function drawPoly(ctx,coords,opt){ ctx.beginPath(); coords.forEach((c,i)=>{ const p=project(c[0],c[1]); if(i===0) ctx.moveTo(p[0],p[1]); else ctx.lineTo(p[0],p[1]); }); ctx.closePath(); if(opt.fill){ ctx.fillStyle=opt.fill; ctx.globalAlpha=opt.alpha||1; ctx.fill(); ctx.globalAlpha=1; } if(opt.stroke){ ctx.strokeStyle=opt.stroke; ctx.lineWidth=opt.width||1; ctx.stroke(); } }
function drawCanvas(){ const ctx=state.ctx; const w=state.canvas.width,h=state.canvas.height; const g=ctx.createRadialGradient(w*0.4,h*0.5,0,w*0.4,h*0.5,Math.max(w,h)); g.addColorStop(0,'#0b162c'); g.addColorStop(1,'#091222'); ctx.fillStyle=g; ctx.fillRect(0,0,w,h);
  const t=state.data.timeline[state.idx]; if(document.getElementById('coneChk').checked){ state.data.layers.cone.features.forEach(f=> drawPoly(ctx,f.geometry.coordinates[0],{fill:'#6ea8ff',alpha:.25,stroke:'#8bb9ff',width:1})); }
  if(document.getElementById('trackChk').checked){ ctx.strokeStyle='#fff'; ctx.lineWidth=2; ctx.beginPath(); state.data.layers.track.features.forEach(f=>{ f.geometry.coordinates.forEach((c,i)=>{ const p=project(c[0],c[1]); if(i===0) ctx.moveTo(p[0],p[1]); else ctx.lineTo(p[0],p[1]); }); }); ctx.stroke(); }
  function drawW(code,col){ state.data.layers.wind.features.filter(f=> f.properties.validtime===t && f.properties.windcode===code).forEach(f=> drawPoly(ctx,f.geometry.coordinates[0],{fill:col,alpha:.18,stroke:col,width:1})); }
  if(document.getElementById('wind34Chk').checked) drawW(34,'#ffd24d'); if(document.getElementById('wind50Chk').checked) drawW(50,'#ff9f43'); if(document.getElementById('wind64Chk').checked) drawW(64,'#ff4d4d');
}

// Data loading with fallback to inline script
async function loadDemo(){
  try{
    const j = await fetch('demo_offline.json', {cache:'no-store'}).then(r=> r.ok ? r.json() : Promise.reject(r.status));
    setData(j); state.source='demo'; log('Demo loaded (file)');
  }catch(e){
    try{
      const inline = document.getElementById('demo'); if(inline){ const j = JSON.parse(inline.textContent); setData(j); state.source='demo'; log('Demo loaded (inline)'); return; }
    }catch(err){ log('Inline demo parse failed', err); }
    log('Demo load failed', e);
  }
}
function setData(j){ state.data=j; state.idx=0; state.fitted=false; const n=(j.timeline||[]).length; timeSlider.max=Math.max(0,n-1); timeSlider.value=0; updateT(); draw(); }

// Live modes
async function loadMirror(){ try{ const [cone,track,wind] = await Promise.all([ fetch('live/cone.geojson').then(r=>r.json()), fetch('live/track.geojson').then(r=>r.json()), fetch('live/wind.geojson').then(r=>r.json()) ]); const timeline=inferTimeline(wind); setData({timeline,layers:{cone,track,wind}});}catch(e){ log('Mirror failed', e);} }
async function loadManual(){ const coneUrl=document.getElementById('coneUrl').value.trim(); const trackUrl=document.getElementById('trackUrl').value.trim(); const windUrl=document.getElementById('windUrl').value.trim(); if(!coneUrl&&!trackUrl&&!windUrl){ log('No manual URLs'); return; }
  try{ const [cone,track,wind]=await Promise.all([ coneUrl?fetch(coneUrl).then(r=>r.json()):{type:'FeatureCollection',features:[]}, trackUrl?fetch(trackUrl).then(r=>r.json()):{type:'FeatureCollection',features:[]}, windUrl?fetch(windUrl).then(r=>r.json()):{type:'FeatureCollection',features:[]}, ]);
    const timeline=inferTimeline(wind); setData({timeline,layers:{cone,track,wind}}); }catch(e){ log('Manual load failed', e); } }
async function loadNHCList(){ const sel=document.getElementById('stormSelect'); sel.innerHTML='<option value=\"\">— none —</option>'; try{ const q=`${ROOT}/${LAYER_TRACK}/query?where=1%3D1&outFields=stormid,stormname,basin&returnDistinctValues=true&returnGeometry=false&f=pjson`; const j=await fetch(q,{cache:'no-store'}).then(r=>r.json()); const feats=(j&&j.features)?j.features:[]; const rows=feats.map(f=>f.attributes||{}).filter(a=>a.stormid||a.stormname); const seen=new Set(); const items=[]; rows.forEach(a=>{ const k=`${a.stormid||''}|${a.stormname||''}`; if(seen.has(k)) return; seen.add(k); items.push({id:a.stormid||'',name:a.stormname||'',basin:a.basin||''}); }); items.sort((a,b)=>(a.basin+a.name).localeCompare(b.basin+b.name)); items.forEach(o=>{ const opt=document.createElement('option'); opt.value=JSON.stringify(o); opt.textContent=`${o.name||'(unnamed)'} ${o.id? '· '+o.id:''} ${o.basin? '· '+o.basin:''}`.trim(); sel.appendChild(opt); }); log('NHC list loaded', items.length); }catch(e){ log('NHC list failed', e); } }
async function loadFromSelect(){ const sel=document.getElementById('stormSelect'); if(!sel.value){ log('No storm selected'); return; } let obj; try{ obj=JSON.parse(sel.value);}catch{ log('Bad selection'); return;} const id=(obj.id||'').trim(); const name=(obj.name||'').trim(); const coneUrl=`${ROOT}/${LAYER_CONE }/query?where=stormname%3D%27${encodeURIComponent(name)}%27&outFields=stormname,basin,advisnum,advdate,fcstprd,stormnum,stormid&returnGeometry=true&f=geojson`; const trackUrl=`${ROOT}/${LAYER_TRACK}/query?where=stormname%3D%27${encodeURIComponent(name)}%27&outFields=stormname,basin,advisnum,advdate,fcstprd,stormnum,stormid&returnGeometry=true&f=geojson`; const windUrl=`${ROOT}/${LAYER_WIND }/query?where=stormid%20LIKE%20%27${encodeURIComponent(id)}%25%27&outFields=stormid,basin,stormnum,advnum,validtime,radii,ne,se,sw,nw&returnGeometry=true&f=geojson`; document.getElementById('coneUrl').value=coneUrl; document.getElementById('trackUrl').value=trackUrl; document.getElementById('windUrl').value=windUrl; await loadManual(); }

function inferTimeline(windFC){ const set=new Set(); (windFC?.features||[]).forEach(f=>{ let t=f?.properties?.validtime; if(t==null) return; if(typeof t==='number'){ if(t<1e11) t*=1000; set.add(new Date(t).toISOString()); } else if(typeof t==='string'){ const d=new Date(t); if(!isNaN(d)) set.add(d.toISOString()); } }); const arr=Array.from(set).sort(); return arr.length?arr:[new Date().toISOString()]; }
