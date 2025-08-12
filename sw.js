const CACHE='hurr3d-v1';
const ASSETS=['./','./index.html','./style.css','./app.js','./cities_fl.json','./counties_fl.json','./demo_storm.json'];
self.addEventListener('install',e=>{ e.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS))); });
self.addEventListener('fetch',e=>{
  const u = new URL(e.request.url);
  if(ASSETS.includes(u.pathname) || u.origin===location.origin){
    e.respondWith(caches.match(e.request).then(r=> r||fetch(e.request)));
  }
});