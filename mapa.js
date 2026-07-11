/* ── MAPA DE EMISSÕES (mapa.js) ───────────────────────── */
const MAPA_PROXY='https://cdv-proxy-production.up.railway.app';
let _mapaInstance=null,_passagensCache=[];
const CITY_COORDS={
  'São Paulo':[-23.5505,-46.6333],'GRU':[-23.5505,-46.6333],'VCP':[-22.9099,-47.0626],'CGH':[-23.6265,-46.6556],
  'Rio de Janeiro':[-22.9068,-43.1729],'GIG':[-22.9068,-43.1729],'SDU':[-22.9068,-43.1729],
  'Brasília':[-15.7801,-47.9292],'BSB':[-15.7801,-47.9292],
  'Belo Horizonte':[-19.9167,-43.9345],'CNF':[-19.9167,-43.9345],
  'Salvador':[-12.9714,-38.5014],'SSA':[-12.9714,-38.5014],
  'Fortaleza':[-3.7172,-38.5432],'FOR':[-3.7172,-38.5432],
  'Recife':[-8.0578,-34.8829],'REC':[-8.0578,-34.8829],
  'Porto Alegre':[-30.0277,-51.2287],'POA':[-30.0277,-51.2287],
  'Curitiba':[-25.4284,-49.2733],'CWB':[-25.4284,-49.2733],
  'Manaus':[-3.1019,-60.025],'MAO':[-3.1019,-60.025],
  'Belém':[-1.4558,-48.5044],'BEL':[-1.4558,-48.5044],
  'Natal':[-5.7945,-35.211],'NAT':[-5.7945,-35.211],
  'Maceió':[-9.6658,-35.735],'MCZ':[-9.6658,-35.735],
  'João Pessoa':[-7.1195,-34.845],'JPA':[-7.1195,-34.845],
  'Teresina':[-5.0892,-42.8019],'THE':[-5.0892,-42.8019],
  'São Luís':[-2.5297,-44.3028],'SLZ':[-2.5297,-44.3028],
  'Campo Grande':[-20.4697,-54.6201],'CGR':[-20.4697,-54.6201],
  'Cuiabá':[-15.5961,-56.0967],'CGB':[-15.5961,-56.0967],
  'Goiânia':[-16.6869,-49.2648],'GYN':[-16.6869,-49.2648],
  'Florianópolis':[-27.5954,-48.548],'FLN':[-27.5954,-48.548],
  'Uberlândia':[-18.9186,-48.2772],'UDI':[-18.9186,-48.2772],
  'Campinas':[-22.9099,-47.0626],
  'Vitória':[-20.3155,-40.3128],'VIX':[-20.3155,-40.3128],
  'Aracaju':[-10.9472,-37.0731],'AJU':[-10.9472,-37.0731],
  'Macapá':[0.0356,-51.0705],'MCP':[0.0356,-51.0705],
  'Porto Velho':[-8.7612,-63.9004],'PVH':[-8.7612,-63.9004],
  'Rio Branco':[-9.9754,-67.8249],'RBR':[-9.9754,-67.8249],
  'Boa Vista':[2.8235,-60.6758],'BVB':[2.8235,-60.6758],
  'Palmas':[-10.2491,-48.3243],'PMW':[-10.2491,-48.3243],
  'Foz do Iguaçu':[-25.5951,-54.5857],'IGU':[-25.5951,-54.5857],
  'Santarém':[-2.4448,-54.7084],'STM':[-2.4448,-54.7084],
  'Petrolina':[-9.3622,-40.5082],'PNZ':[-9.3622,-40.5082],
  'Buenos Aires':[-34.6037,-58.3816],'EZE':[-34.6037,-58.3816],
  'Santiago':[-33.4489,-70.6693],'SCL':[-33.4489,-70.6693],
  'Lima':[-12.0464,-77.0428],'LIM':[-12.0464,-77.0428],
  'Bogotá':[4.711,-74.0721],'BOG':[4.711,-74.0721],
  'Montevidéu':[-34.9011,-56.1645],'MVD':[-34.9011,-56.1645],
  'Assunção':[-25.2867,-57.647],'ASU':[-25.2867,-57.647],
  'Quito':[-0.2295,-78.5243],'UIO':[-0.2295,-78.5243],
  'Medellín':[6.2442,-75.5812],'MDE':[6.2442,-75.5812],
  'Cartagena':[10.3997,-75.5144],'CTG':[10.3997,-75.5144],
  'Cusco':[-13.5319,-71.9675],'CUZ':[-13.5319,-71.9675],
  'Cancún':[21.1619,-86.8515],'CUN':[21.1619,-86.8515],
  'Miami':[25.7617,-80.1918],'MIA':[25.7617,-80.1918],
  'Nova York':[40.7128,-74.006],'JFK':[40.7128,-74.006],'EWR':[40.7128,-74.006],
  'Los Angeles':[34.0522,-118.2437],'LAX':[34.0522,-118.2437],
  'Orlando':[28.5383,-81.3792],'MCO':[28.5383,-81.3792],
  'Chicago':[41.8781,-87.6298],'ORD':[41.8781,-87.6298],
  'Toronto':[43.6532,-79.3832],'YYZ':[43.6532,-79.3832],
  'Vancouver':[49.2827,-123.1207],'YVR':[49.2827,-123.1207],
  'México':[19.4326,-99.1332],'MEX':[19.4326,-99.1332],
  'Cidade do Panamá':[8.9936,-79.5197],'PTY':[8.9936,-79.5197],
  'Lisboa':[38.7223,-9.1393],'LIS':[38.7223,-9.1393],
  'Porto':[41.1579,-8.6291],'OPO':[41.1579,-8.6291],
  'Madrid':[40.4168,-3.7038],'MAD':[40.4168,-3.7038],
  'Barcelona':[41.3851,2.1734],'BCN':[41.3851,2.1734],
  'Paris':[48.8566,2.3522],'CDG':[48.8566,2.3522],'ORY':[48.8566,2.3522],
  'Londres':[51.5074,-0.1278],'LHR':[51.5074,-0.1278],'LGW':[51.5074,-0.1278],
  'Amsterdam':[52.3676,4.9041],'AMS':[52.3676,4.9041],
  'Frankfurt':[50.1109,8.6821],'FRA':[50.1109,8.6821],
  'Roma':[41.9028,12.4964],'FCO':[41.9028,12.4964],
  'Milão':[45.4654,9.1859],'MXP':[45.4654,9.1859],
  'Zurique':[47.3769,8.5417],'ZRH':[47.3769,8.5417],
  'Genebra':[46.2044,6.1432],'GVA':[46.2044,6.1432],
  'Viena':[48.2082,16.3738],'VIE':[48.2082,16.3738],
  'Berlim':[52.52,13.405],'BER':[52.52,13.405],
  'Munique':[48.1351,11.582],'MUC':[48.1351,11.582],
  'Copenhague':[55.6761,12.5683],'CPH':[55.6761,12.5683],
  'Estocolmo':[59.3293,18.0686],'ARN':[59.3293,18.0686],
  'Oslo':[59.9139,10.7522],'OSL':[59.9139,10.7522],
  'Helsinki':[60.1699,24.9384],'HEL':[60.1699,24.9384],
  'Atenas':[37.9838,23.7275],'ATH':[37.9838,23.7275],
  'Istanbul':[41.0082,28.9784],'IST':[41.0082,28.9784],
  'Dubai':[25.2048,55.2708],'DXB':[25.2048,55.2708],
  'Abu Dhabi':[24.4539,54.3773],'AUH':[24.4539,54.3773],
  'Doha':[25.2854,51.531],'DOH':[25.2854,51.531],
  'Tel Aviv':[32.0853,34.7818],'TLV':[32.0853,34.7818],
  'Cairo':[30.0444,31.2357],'CAI':[30.0444,31.2357],
  'Johannesburgo':[-26.2041,28.0473],'JNB':[-26.2041,28.0473],
  'Lagos':[6.5244,3.3792],'LOS':[6.5244,3.3792],
  'Nairóbi':[-1.2921,36.8219],'NBO':[-1.2921,36.8219],
  'Luanda':[-8.8368,13.2343],'LAD':[-8.8368,13.2343],
  'Tóquio':[35.6762,139.6503],'NRT':[35.6762,139.6503],'HND':[35.6762,139.6503],
  'Osaka':[34.6937,135.5023],'KIX':[34.6937,135.5023],
  'Seul':[37.5665,126.978],'ICN':[37.5665,126.978],
  'Pequim':[39.9042,116.4074],'PEK':[39.9042,116.4074],
  'Xangai':[31.2304,121.4737],'PVG':[31.2304,121.4737],
  'Hong Kong':[22.3193,114.1694],'HKG':[22.3193,114.1694],
  'Cingapura':[1.3521,103.8198],'SIN':[1.3521,103.8198],
  'Bangkok':[13.7563,100.5018],'BKK':[13.7563,100.5018],
  'Bali':[-8.3405,115.092],'DPS':[-8.3405,115.092],
  'Sydney':[-33.8688,151.2093],'SYD':[-33.8688,151.2093],
  'Melbourne':[-37.8136,144.9631],'MEL':[-37.8136,144.9631],
  'Auckland':[-36.8485,174.7633],'AKL':[-36.8485,174.7633],
  'Mumbai':[19.076,72.8777],'BOM':[19.076,72.8777],
  'Delhi':[28.7041,77.1025],'DEL':[28.7041,77.1025],
};
const _CI=Object.fromEntries(Object.entries(CITY_COORDS).map(([k,v])=>[k.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase(),v]));
function resolverCoords(n){
  if(!n)return null;
  if(CITY_COORDS[n])return CITY_COORDS[n];
  const r=n.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
  if(_CI[r])return _CI[r];
  for(const[k,v]of Object.entries(_CI)){if(r.startsWith(k)||k.startsWith(r))return v;}
  return null;
}
function mapaCorProg(p){
  if(!p)return'#6366f1';const s=p.toLowerCase();
  if(s.includes('latam'))return'#dc2626';if(s.includes('smiles'))return'#f97316';
  if(s.includes('azul'))return'#0ea5e9';if(s.includes('livelo'))return'#df0979';
  if(s.includes('esfera'))return'#e8371b';if(s.includes('iberia'))return'#c0392b';
  if(s.includes('tap'))return'#005f9e';if(s.includes('flying'))return'#003087';
  if(s.includes('aadvantage'))return'#0068b2';if(s.includes('qatar'))return'#8b0000';
  return'#6366f1';
}
async function initMapa(){
  if(!window.L){
    await new Promise((res,rej)=>{
      const lk=document.createElement('link');lk.rel='stylesheet';
      lk.href='https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css';
      document.head.appendChild(lk);
      const sc=document.createElement('script');
      sc.src='https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js';
      sc.onload=res;sc.onerror=rej;document.head.appendChild(sc);
    });
  }
  const el=document.getElementById('mapa-container');
  if(!el)return;
  if(_mapaInstance){_mapaInstance.remove();_mapaInstance=null;}
  document.getElementById('mapa-loading').style.display='flex';
  await new Promise(r=>setTimeout(r,100));
  _mapaInstance=L.map(el,{center:[15,10],zoom:2,minZoom:2,maxZoom:10,attributionControl:false});
  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',{maxZoom:19}).addTo(_mapaInstance);
  setTimeout(()=>{if(_mapaInstance)_mapaInstance.invalidateSize();},300);
  document.getElementById('mapa-loading').style.display='none';
  if(!_passagensCache.length)await mapaCarregar();else{mapaFiltros();mapaRender();}
}
async function mapaCarregar(){
  const ld=document.getElementById('mapa-loading');
  try{
    const ctrl=new AbortController();setTimeout(()=>ctrl.abort(),15000);
    const r=await fetch(MAPA_PROXY+'/passagens/listar?t='+Date.now(),{signal:ctrl.signal});
    if(!r.ok)throw new Error(r.status);
    _passagensCache=(await r.json()).items||[];
    mapaFiltros();mapaRender();
  }catch(e){if(ld){ld.style.display='flex';ld.textContent='Erro ao carregar passagens.';}}
}
function mapaFiltros(){
  const s=document.getElementById('mapa-filtro-prog');if(!s)return;
  const progs=[...new Set(_passagensCache.map(p=>p.programa).filter(Boolean))].sort();
  const cur=s.value;
  s.innerHTML='<option value="">Todos os programas</option>'+progs.map(p=>`<option value="${p}"${p===cur?' selected':''}>${p}</option>`).join('');
}
function mapaRender(){
  if(!_mapaInstance)return;
  const fp=(document.getElementById('mapa-filtro-prog')?.value||'').toLowerCase();
  const fc=(document.getElementById('mapa-filtro-cabine')?.value||'').toLowerCase();
  const fo=(document.getElementById('mapa-filtro-origem')?.value||'').toLowerCase().trim();
  const fd=(document.getElementById('mapa-filtro-destino')?.value||'').toLowerCase().trim();
  let ps=_passagensCache;
  if(fp)ps=ps.filter(p=>(p.programa||'').toLowerCase()===fp);
  if(fc)ps=ps.filter(p=>(p.cabine||'').toLowerCase().includes(fc));
  if(fo)ps=ps.filter(p=>(p.origem||'').toLowerCase().includes(fo));
  if(fd)ps=ps.filter(p=>(p.destino||'').toLowerCase().includes(fd));
  _mapaInstance.eachLayer(l=>{if(l._me)_mapaInstance.removeLayer(l);});
  const g={};
  for(const p of ps){if(p.destino){if(!g[p.destino])g[p.destino]=[];g[p.destino].push(p);}}
  let nd=0;
  for(const[dest,items]of Object.entries(g)){
    const c=resolverCoords(dest);if(!c)continue;nd++;
    const qtd=items.length,pts=Math.min(...items.map(p=>p.pontos||0).filter(v=>v>0));
    const cor=mapaCorProg([...new Set(items.map(p=>p.programa).filter(Boolean))][0]);
    const mk=L.circleMarker(c,{radius:Math.min(36,Math.max(10,10+Math.sqrt(qtd)*4)),fillColor:cor,color:'#fff',weight:1.5,opacity:.9,fillOpacity:.75});
    mk._me=true;
    mk.bindTooltip('<b>'+dest+'</b><br>'+qtd+' emissão'+(qtd>1?'ões':'')+(pts>0?'<br>'+pts.toLocaleString('pt-BR')+' pts mín.':''),
      {sticky:true,className:'mapa-leaflet-tooltip'});
    mk.on('click',function(){
      const titulo=document.getElementById('mapa-tooltip-titulo');
      const lista=document.getElementById('mapa-tooltip-lista');
      const painel=document.getElementById('mapa-tooltip-panel');
      if(!titulo||!lista||!painel)return;
      titulo.textContent='✈️ '+dest+' — '+qtd+' emissão'+(qtd>1?'ões':'')+' registrada'+(qtd>1?'s':'');
      lista.innerHTML=items.map(function(p){
        const ok=p.fonte!=='alerta_rejeitado';
        const badge=ok?'<span style="background:#22c55e22;color:#22c55e;border-radius:4px;padding:1px 6px;font-size:11px;font-weight:700">✓ enviado</span>'
          :'<span style="background:#f5a62322;color:#f5a623;border-radius:4px;padding:1px 6px;font-size:11px;font-weight:700">⚠ rejeitado</span>';
        const pts=p.pontos?p.pontos.toLocaleString('pt-BR')+' pts':'—';
        return '<div style="background:var(--surface3,#1e2130);border-radius:8px;padding:10px 12px;display:flex;flex-direction:column;gap:3px">'
          +'<div style="display:flex;justify-content:space-between;align-items:center"><span style="font-weight:700;font-size:13px">'+(p.cia||p.programa||'—')+'</span>'+badge+'</div>'
          +'<div style="font-size:12px;color:var(--muted)">'+(p.origem||'')+(p.origem&&p.destino?' → ':'')+( p.destino||'')+'</div>'
          +'<div style="font-size:12px">'+(p.programa||'')+' · '+pts+' · '+(p.cabine||'—')+'</div>'
          +(p.datas_ida?'<div style="font-size:11px;color:var(--muted2)">Ida: '+p.datas_ida.slice(0,80)+'</div>':'')
          +'</div>';
      }).join('');
      painel.style.display='block';
      painel.scrollIntoView({behavior:'smooth',block:'nearest'});
    });
    mk.addTo(_mapaInstance);
  }
  const cnt=document.getElementById('mapa-contador');
  if(cnt)cnt.textContent=nd+' destino'+(nd!==1?'s':'')+' · '+ps.length+' emissão'+(ps.length!==1?'ões':'');
}
document.addEventListener('change',function(e){
  if(e.target&&['mapa-filtro-prog','mapa-filtro-cabine'].includes(e.target.id))mapaRender();
});
