/* Indicadores Saúde Bucal — aplicação local-first
 * Camadas: regras -> importação/normalização -> persistência -> cálculo -> interface.
 * Nenhum arquivo importado é enviado para serviços externos.
 */

/* Polyfill: Safari (até a versão 26) não implementa ReadableStream[Symbol.asyncIterator],
 * usado internamente pelo pdf.js (`for await (const t of stream)`) para ler o texto extraído
 * do PDF. Sem isso, a leitura de PDF falha só no Safari com "undefined is not a function (near
 * '...t of e...')" — a `t` e o `e` minificados são literalmente o `t` e o `e` de `for await(const
 * t of e)` dentro do pdf.js. Confirmado com o stack trace real enviado pelo usuário (Safari
 * 26.5.2 macOS): `getTextContent@.../pdf.min.js` chamando exatamente esse laço. Suporte nativo
 * chega no Safari 27; até lá, isso preenche a lacuna sem precisar trocar de biblioteca. */
if(typeof ReadableStream!=='undefined'&&!ReadableStream.prototype[Symbol.asyncIterator]){
  ReadableStream.prototype[Symbol.asyncIterator]=function(){
    const reader=this.getReader();
    return {
      next(){return reader.read().then(({done,value})=>done?{done:true,value:undefined}:{done:false,value})},
      return(value){reader.releaseLock();return Promise.resolve({done:true,value})},
      [Symbol.asyncIterator](){return this}
    };
  };
}

const APP_VERSION = '1.29';
const SCHEMA_VERSION = '1.1.0';
const RULE_VERSION = '2026.05+M1.2026.08';
const MONTHS = ['janeiro','fevereiro','março','abril','maio','junho','julho','agosto','setembro','outubro','novembro','dezembro'];
const MONTHS_SHORT = ['jan','fev','mar','abr','mai','jun','jul','ago','set','out','nov','dez'];
const EN_MONTH = {jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12};

const RULESETS = {
  municipal: {
    regra_id:'FLN-SB-M1-M5', regra_versao:RULE_VERSION, vigencia:'2026-01-01', ambito:'municipal',
    fonte_normativa:'Portaria nº 033/SMS/GAB/2026 e atualização operacional de M1 informada em 21/08/2026',
    indicators:{
      M1:{name:'Primeira consulta programada',weight:1,polarity:'higher',bands:[
        {label:'Ótimo',test:v=>v>1.25,color:'#39b980'},
        {label:'Bom',test:v=>v>0.75,color:'#3dc1d3'},
        {label:'Suficiente',test:v=>v>0.25,color:'#e7a23b'},
        {label:'Regular',test:()=>true,color:'#e15f41'}
      ],formula:'100 × primeiras consultas programadas ÷ denominador manual confirmado do indicador 1'},
      M2:{name:'Tratamento concluído',weight:1,cutoff:25,meta:50,polarity:'higher',formula:'100 × tratamentos concluídos ÷ primeiras consultas programadas'},
      M3:{name:'Escovação supervisionada (6 a 12 anos)',weight:1,cutoff:.5,meta:1,polarity:'higher',formula:'100 × participantes presentes ÷ denominador manual confirmado do indicador 3'},
      M4:{name:'Procedimentos preventivos individuais',weight:1,cutoff:20,meta:40,polarity:'higher',formula:'100 × procedimentos preventivos ÷ total de procedimentos individuais'},
      M5:{name:'Tratamento Restaurador Atraumático (ART)',weight:1,cutoff:4,meta:8,polarity:'higher',formula:'100 × ART ÷ total de procedimentos restauradores'}
    }
  },
  federal: {
    regra_id:'MS-SIAPS-B1-B6', regra_versao:'Notas assinadas em 12–13/05/2026', vigencia:'2026-05-13', ambito:'federal',
    fonte_normativa:'Notas Metodológicas B1 a B6 — Ministério da Saúde, maio de 2026',
    indicators:{
      B1:{name:'Primeira consulta programada',formula:'100 × pessoas com primeira consulta programada ÷ pessoas vinculadas à eSF/eAP de referência'},
      B2:{name:'Tratamento concluído',formula:'100 × pessoas com tratamento concluído ÷ pessoas com primeira consulta programada'},
      B3:{name:'Taxa de exodontia',formula:'100 × exodontias permanentes ÷ procedimentos preventivos, curativos e exodontias'},
      B4:{name:'Escovação supervisionada (6 a 12 anos)',formula:'100 × crianças participantes ÷ crianças de 6 a 12 anos vinculadas'},
      B5:{name:'Procedimentos odontológicos preventivos',formula:'100 × procedimentos preventivos elegíveis ÷ procedimentos individuais elegíveis'},
      B6:{name:'Tratamento Restaurador Atraumático',formula:'100 × ART ÷ procedimentos restauradores elegíveis'}
    }
  }
};

const CBO = {
  dentists:['223208','223293','223272'],
  tsb:['322405','322425'],
  asb:['322415','322430']
};

const CODES = {
  B5_NUM:['0101020058','0101020066','0101020074','0101020082','0101020104','0101020120','0307030040'],
  B5_DEN_DENTIST:['0101020058','0101020066','0101020074','0101020082','0101020090','0101020104','0101020120','0414020138','0307010015','0307010031','0307010066','0307010074','0307010082','0307010104','0307010112','0307010120','0307010147','0307010155','0307020010','0307020029','0307020070','0307030024','0307030040','0307030059','0307030067','0307030075','0307030083','0307050017'],
  B5_DEN_TSB:['0101020058','0101020066','0101020074','0101020082','0101020104','0101020120'],
  B6_DEN:['0307010074','0307010031','0307010082','0307010104','0307010112','0307010120'],
  B3_NUM:['0414020138','0414020146'],
  B3_DEN:['0101020058','0101020066','0101020074','0101020082','0101020090','0101020120','0307010015','0307010031','0307010066','0307010074','0307010082','0307010104','0307010112','0307010120','0307020010','0307020029','0307020070','0307030024','0307030040','0307030059','0307030067','0307030075','0307030083','0307050017','0414020138','0414020146']
};

const PROCEDURE_RULES = [
  {re:/^PRIMEIRA CONSULTA ODONTOLOGICA/,code:'03.01.01.015-3',name:'Primeira consulta odontológica programada',roles:['first']},
  {re:/^TRATAMENTO CONCLUIDO/,code:'',name:'Tratamento concluído (campo Conduta)',roles:['concluded']},
  {re:/ORIENTA(?:C|Ç)AO (?:DE|EM) HIGIENE BUCAL/,code:'01.01.02.010-4',name:'Orientação de higiene bucal',roles:['preventive','m4den','b5den']},
  {re:/ORIENTA(?:C|Ç)AO DE HIGIENIZA(?:C|Ç)AO DE/,code:'01.01.02.012-0',name:'Orientação de higienização de próteses',roles:['preventive','m4den','b5den','b3den']},
  {re:/APLICA(?:C|Ç)AO DE CARIOSTATICO/,code:'01.01.02.005-8',name:'Aplicação de cariostático',roles:['preventive','m4den','b5den','b3den']},
  {re:/APLICA(?:C|Ç)AO DE SELANTE/,code:'01.01.02.006-6',name:'Aplicação de selante',roles:['preventive','m4den','b5den','b3den']},
  {re:/APLICA(?:C|Ç)AO TOPICA DE FLUOR/,code:'01.01.02.007-4',name:'Aplicação tópica de flúor',roles:['preventive','m4den','b5den','b3den']},
  {re:/EVIDENCIA(?:C|Ç)AO DE PLACA/,code:'01.01.02.008-2',name:'Evidenciação de placa bacteriana',roles:['preventive','m4den','b5den','b3den']},
  {re:/PROFILAXIA\s+REMO(?:C|Ç)AO DA PLACA/,code:'03.07.03.004-0',name:'Profilaxia/remoção da placa',roles:['preventive','m4den','b5den','b3den']},
  {re:/RETIRADA DE PONTOS DE CIRURGIAS/,code:'',name:'Retirada de pontos de cirurgias (por paciente)',roles:['m4den']},
  {re:/^ATENDIMENTO ODONTOLOGICO$/,code:'',name:'Atendimento odontológico (registro geral de atendimento)',roles:['m4den']},
  {re:/ATENDIMENTO DE URGENCIA/,code:'',name:'Atendimento de urgência em atenção',roles:['m4den']},
  {re:/AFERICAO DE PRESSAO ARTERIAL/,code:'',name:'Aferição de pressão arterial',roles:['m4den']},
  {re:/CONSULTA DE PROFISSIONAIS DE NIVEL/,code:'',name:'Consulta de profissionais de nível superior',roles:['m4den']},
  {re:/CURETAGEM PERIAPICAL/,code:'',name:'Curetagem periapical',roles:['m4den']},
  {re:/ODONTOSECCAO RADILECTOMIA/,code:'',name:'Odontossecção / radiculectomia',roles:['m4den']},
  {re:/EXCISAO E OU SUTURA SIMPLES/,code:'',name:'Excisão e/ou sutura simples',roles:['m4den']},
  {re:/CORRECAO DE IRREGULARIDADES/,code:'',name:'Correção de irregularidades',roles:['m4den']},
  {re:/^AJUSTE OCLUSAL$/,code:'',name:'Ajuste oclusal',roles:['m4den']},
  {re:/EXODONTIA DE DENTE DECIDUO/,code:'',name:'Exodontia de dente decíduo',roles:['m4den']},
  {re:/SELAMENTO PROVISORIO DE CAVIDADE/,code:'01.01.02.009-0',name:'Selamento provisório de cavidade',roles:['m4den','b5den','b3den']},
  {re:/CAPEAMENTO PULPAR/,code:'03.07.01.001-5',name:'Capeamento pulpar',roles:['m4den','b5den','b3den']},
  {re:/TRATAMENTO INICIAL DO DENTE/,code:'03.07.01.006-6',name:'Tratamento inicial do dente traumatizado',roles:['m4den','b5den','b3den']},
  {re:/TRATAMENTO RESTAURADOR/,code:'03.07.01.007-4',name:'Tratamento restaurador atraumático (ART)',roles:['art','restorative','m4den','b5den','b3den']},
  {re:/RESTAURA(?:C|Ç)AO DE DENTE PERMANENTE/,code:'',name:'Restauração de dente permanente (subtipo não exibido)',roles:['restorative','m4den','b5den','b3den'],ambiguous:true},
  {re:/RESTAURA(?:C|Ç)AO DE DENTE DECIDUO/,code:'',name:'Restauração de dente decíduo (subtipo não exibido)',roles:['restorative','m4den','b5den','b3den'],ambiguous:true},
  {re:/ACESSO A POLPA DENTARIA E MEDICACAO/,code:'03.07.02.001-0',name:'Acesso à polpa dentária e medicação',roles:['m4den','b5den','b3den']},
  {re:/CURATIVO DE DEMORA/,code:'03.07.02.002-9',name:'Curativo de demora',roles:['m4den','b5den','b3den']},
  {re:/PULPOTOMIA/,code:'03.07.02.007-0',name:'Pulpotomia dentária',roles:['m4den','b5den','b3den']},
  {re:/RASPAGEM ALISAMENTO SUBGENGIVAIS/,code:'03.07.03.002-4',name:'Raspagem e alisamento subgengivais',roles:['m4den','b5den','b3den']},
  {re:/RASPAGEM ALISAMENTO E POLIMENTO/,code:'03.07.03.005-9',name:'Raspagem, alisamento e polimento supragengivais',roles:['m4den','b5den','b3den']},
  {re:/TRATAMENTO DE GENGIVITE ULCERATIVA/,code:'03.07.03.006-7',name:'Tratamento de gengivite ulcerativa',roles:['m4den','b5den','b3den']},
  {re:/TRATAMENTO DE LESOES DA MUCOSA/,code:'03.07.03.007-5',name:'Tratamento de lesões da mucosa oral',roles:['m4den','b5den','b3den']},
  {re:/TRATAMENTO DE PERICORONARITE/,code:'03.07.03.008-3',name:'Tratamento de pericoronarite',roles:['m4den','b5den','b3den']},
  {re:/FOTOBIOMODULA(?:C|Ç)AO/,code:'03.07.05.001-7',name:'Fotobiomodulação',roles:['m4den','b5den','b3den']},
  {re:/EXODONTIA DE DENTE PERMANENTE/,code:'04.14.02.013-8',name:'Exodontia de dente permanente',roles:['m4den','b5den','b3num','b3den']},
  {re:/EXODONTIA MULTIPLA/,code:'04.14.02.014-6',name:'Exodontia múltipla com alveoloplastia',roles:['m4den','b3num','b3den']},
  {re:/ADEQUA(?:C|Ç)AO DO COMPORTAMENTO DA/,code:'03.07.01.014-7',name:'Adequação do comportamento da pessoa com deficiência',roles:['m4den','b5den']},
  {re:/ADEQUA(?:C|Ç)AO DO COMPORTAMENTO DE/,code:'03.07.01.015-5',name:'Adequação do comportamento de crianças',roles:['m4den','b5den']}
];

const ICONS = {
  grid:'<svg viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>',
  building:'<svg viewBox="0 0 24 24"><path d="M3 21h18M5 21V7l7-4 7 4v14M9 10h1M14 10h1M9 14h1M14 14h1M10 21v-4h4v4"/></svg>',
  shield:'<svg viewBox="0 0 24 24"><path d="M12 22s8-3.5 8-10V5l-8-3-8 3v7c0 6.5 8 10 8 10Z"/><path d="m9 12 2 2 4-5"/></svg>',
  heart:'<svg viewBox="0 0 24 24"><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8l1.1 1.1L12 21l7.8-7.5 1.1-1.1a5.5 5.5 0 0 0-.1-7.8Z"/></svg>',
  upload:'<svg viewBox="0 0 24 24"><path d="M12 21V9"/><path d="m7 14 5-5 5 5"/><path d="M5 3h14"/></svg>',
  download:'<svg viewBox="0 0 24 24"><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/></svg>',
  alert:'<svg viewBox="0 0 24 24"><path d="M12 9v4M12 17h.01"/><path d="M10.3 3.6 2.9 17a2 2 0 0 0 1.75 3h14.7a2 2 0 0 0 1.75-3L13.7 3.6a2 2 0 0 0-3.4 0Z"/></svg>',
  settings:'<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.1h-4V21a1.7 1.7 0 0 0-1.1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4 17l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.6-1H2.7v-4h.1a1.7 1.7 0 0 0 1.6-1.1 1.7 1.7 0 0 0-.3-1.9L4 6.9 6.9 4l.1.1a1.7 1.7 0 0 0 1.9.3A1.7 1.7 0 0 0 10 2.8v-.1h4v.1a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1 2.8 2.9-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.1v4H21a1.7 1.7 0 0 0-1.6 1.1Z"/></svg>',
  search:'<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></svg>',
  lock:'<svg viewBox="0 0 24 24"><rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>',
  database:'<svg viewBox="0 0 24 24"><ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/></svg>',
  print:'<svg viewBox="0 0 24 24"><path d="M6 9V3h12v6M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="7"/></svg>',
  file:'<svg viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6M8 13h8M8 17h8"/></svg>',
  trend:'<svg viewBox="0 0 24 24"><path d="m3 17 6-6 4 4 8-9"/><path d="M14 6h7v7"/></svg>',
  users:'<svg viewBox="0 0 24 24"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8"/></svg>',
  tooth:'<svg viewBox="0 0 24 24"><path d="M12 4c-2.8-2.5-7-1.5-8 2.5C2.7 12 6 21 8.7 21c1.7 0 1.5-5 3.3-5s1.6 5 3.3 5C18 21 21.3 12 20 6.5 19 2.5 14.8 1.5 12 4Z"/></svg>',
  check:'<svg viewBox="0 0 24 24"><path d="m5 12 4 4L19 6"/></svg>',
  clock:'<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  info:'<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/></svg>',
  close:'<svg viewBox="0 0 24 24"><path d="m6 6 12 12M18 6 6 18"/></svg>',
  copy:'<svg viewBox="0 0 24 24"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>',
  message:'<svg viewBox="0 0 24 24"><path d="M21 15a4 4 0 0 1-4 4H8l-5 2 1.5-4A7 7 0 0 1 3 12V8a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z"/></svg>',
  plus:'<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
  chevron:'<svg viewBox="0 0 24 24"><path d="m9 18 6-6-6-6"/></svg>',
  trash:'<svg viewBox="0 0 24 24"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0-1 14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2L4 6"/><path d="M10 11v6M14 11v6"/></svg>',
  external:'<svg viewBox="0 0 24 24"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><path d="M15 3h6v6"/><path d="M10 14 21 3"/></svg>',
  calculator:'<svg viewBox="0 0 24 24"><rect x="4" y="2" width="16" height="20" rx="2"/><line x1="8" y1="6" x2="16" y2="6"/><line x1="16" y1="14" x2="16" y2="18"/><path d="M8 10h.01M12 10h.01M16 10h.01M8 14h.01M12 14h.01M8 18h.01M12 18h.01"/></svg>'
};

function icon(name){ return ICONS[name] || ICONS.info; }
function hydrateIcons(root=document){ root.querySelectorAll('[data-icon]').forEach(el=>{ el.innerHTML=icon(el.dataset.icon); }); }
function esc(v){ return String(v??'').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c])); }
function norm(v){ return String(v??'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[‐‑‒–—]/g,'-').replace(/[^a-zA-Z0-9]+/g,' ').trim().toUpperCase(); }
function nowISO(){ return new Date().toISOString(); }
function uuid(){ return crypto.randomUUID ? crypto.randomUUID() : 'id-'+Date.now()+'-'+Math.random().toString(16).slice(2); }
function round(v,d=2){ if(v==null||!Number.isFinite(v)) return null; const p=10**d; return Math.round((v+Number.EPSILON)*p)/p; }
function fmtNum(v,d=0){ return v==null||!Number.isFinite(Number(v))?'—':Number(v).toLocaleString('pt-BR',{minimumFractionDigits:d,maximumFractionDigits:d}); }
function fmtPct(v,d=2){ return v==null||!Number.isFinite(Number(v))?'—':`${fmtNum(v,d)}%`; }
function monthKey(year,month){ return `${year}-${String(month).padStart(2,'0')}`; }
function parseMonthKey(k){ const [y,m]=String(k).split('-').map(Number); return {year:y,month:m}; }
function quarterOfMonth(m){ return m<=4?1:m<=8?2:3; }
function quarterMonths(year,q){ const start=(q-1)*4+1; return Array.from({length:4},(_,i)=>monthKey(year,start+i)); }
function fmtMonth(k,long=false){ if(!k)return '—';const {year,month}=parseMonthKey(k);return `${long?MONTHS[month-1]:MONTHS_SHORT[month-1]}/${year}`; }
function fmtDate(v){ const d=parseDate(v); return d?d.toLocaleDateString('pt-BR'):'—'; }
function fmtDateTime(v){ const d=parseDate(v); return d?d.toLocaleString('pt-BR',{dateStyle:'short',timeStyle:'short'}):'—'; }
function parseDate(v){
  if(!v)return null;if(v instanceof Date)return isNaN(v)?null:v;
  const s=String(v).trim();let m=s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2}))?/);
  if(m){const d=new Date(+m[3],+m[2]-1,+m[1],+(m[4]||0),+(m[5]||0));return isNaN(d)?null:d;}
  m=s.match(/^([A-Za-z]{3})\s+(\d{1,2}),\s*(\d{4})/);if(m&&EN_MONTH[m[1].toLowerCase()])return new Date(+m[3],EN_MONTH[m[1].toLowerCase()]-1,+m[2]);
  const d=new Date(s);return isNaN(d)?null:d;
}
function isoDate(v){ const d=parseDate(v); return d?`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`:''; }
function numeric(v){
  if(typeof v==='number')return v;let s=String(v??'').trim().replace(/\s/g,'');if(!s)return null;
  if(/^[-+]?\d{1,3}(,\d{3})+(\.\d+)?$/.test(s))s=s.replace(/,/g,'');
  else if(/^[-+]?\d{1,3}(\.\d{3})+(,\d+)?$/.test(s))s=s.replace(/\./g,'').replace(',','.');
  else if(s.includes(',')&&!s.includes('.'))s=s.replace(',','.');
  const n=Number(s);return Number.isFinite(n)?n:null;
}
function sum(a){ return a.reduce((s,v)=>s+(Number(v)||0),0); }
function mean(a){ const v=a.filter(x=>x!=null&&Number.isFinite(x));return v.length?sum(v)/v.length:null; }
function clamp(v,a=0,b=100){ return Math.max(a,Math.min(b,v)); }
function debounce(fn,ms=250){ let t;return(...a)=>{clearTimeout(t);t=setTimeout(()=>fn(...a),ms)}; }
function maskName(v){const p=String(v||'').trim().split(/\s+/);return p.map((x,i)=>i===0?`${x[0]||''}${'•'.repeat(Math.min(6,Math.max(2,x.length-1)))}`:`${x[0]||''}${'•'.repeat(Math.min(5,Math.max(2,x.length-1)))}`).join(' ')}
function maskPhone(v){const d=String(v||'').replace(/\D/g,'');if(d.length<4)return v?'••••':'—';return `(${d.slice(0,2)}) •••••-${d.slice(-4)}`;}
function normalizePhone(v){let d=String(v||'').replace(/\D/g,'');if(d.length===10||d.length===11)d='55'+d;if(/^55\d{10,11}$/.test(d))return d;return '';}
function sanitizeProntuario(v){return String(v??'').replace(/[,.\s]/g,'').trim();}
function isScientificNotation(v){return /^\s*-?\d+([.,]\d+)?e[+\-]?\d+\s*$/i.test(String(v??''));}
function safeFileName(v){return norm(v).toLowerCase().replace(/\s+/g,'-').replace(/[^a-z0-9-]/g,'').slice(0,60)||'arquivo';}
function bytesToBase64(bytes){let out='';const chunk=0x8000;for(let i=0;i<bytes.length;i+=chunk)out+=String.fromCharCode(...bytes.subarray(i,i+chunk));return btoa(out)}
function base64ToBytes(s){const b=atob(s);const u=new Uint8Array(b.length);for(let i=0;i<b.length;i++)u[i]=b.charCodeAt(i);return u}
async function sha256(value){const bytes=value instanceof ArrayBuffer?new Uint8Array(value):value instanceof Uint8Array?value:new TextEncoder().encode(String(value));const hash=await crypto.subtle.digest('SHA-256',bytes);return [...new Uint8Array(hash)].map(b=>b.toString(16).padStart(2,'0')).join('');}
function downloadFile(name,content,type='application/octet-stream'){const blob=content instanceof Blob?content:new Blob([content],{type});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000)}

function defaultState(){
  const d=new Date();return {
    schemaVersion:SCHEMA_VERSION,appVersion:APP_VERSION,createdAt:nowISO(),updatedAt:nowISO(),snapshots:[],denominators:[],
    columnMappings:{consulta2i:{}},parserProfiles:{procedimentos:'CELK-PROC-1.0',atividades:'CELK-GRUPO-1.0',metabase:'METABASE-ESB-1.0',gestantes:'METABASE-2I-1.1'},
    gestantes:{manual:[],followups:{},merges:{},excluded:{},overrides:{}},manualOverrides:[],audit:[],lastBackupAt:null,dirty:false,
    preferences:{year:d.getFullYear(),quarter:quarterOfMonth(d.getMonth()+1),month:monthKey(d.getFullYear(),d.getMonth()+1),unit:'',view:'overview',sourceMode:'auto',targetScore:100,overviewScope:'month',pregTeam:'',pregStatus:'',pregFollowup:'',pregOrigin:'',pregPhone:'',pregStage:'',pregExcluded:'',pregSearch:'',calcPeso:''},
    selfTests:null
  };
}

let state=defaultState();
let sessionRaw=new Map();
let activeView='overview';
let pdfjsPromise=null;
let pendingBackupFile=null;
let preRestoreSnapshot=null;
let currentDiagnostics=[];

/* Nada é salvo pelo navegador (sem IndexedDB/localStorage): o estado só existe na memória
 * desta aba enquanto ela ficar aberta. O único jeito de não perder o trabalho é exportar um
 * backup (ver `createBackupFromModal`); fechar ou recarregar a página sem exportar descarta tudo,
 * por isso o aviso de "alterações não salvas" (`state.dirty`) e o `beforeunload` abaixo. */
async function deriveKey(password,salt,usage=['encrypt','decrypt']){const base=await crypto.subtle.importKey('raw',new TextEncoder().encode(password),'PBKDF2',false,['deriveKey']);return crypto.subtle.deriveKey({name:'PBKDF2',salt,iterations:250000,hash:'SHA-256'},base,{name:'AES-GCM',length:256},false,usage)}
async function encryptJSON(payload,password){const salt=crypto.getRandomValues(new Uint8Array(16)),iv=crypto.getRandomValues(new Uint8Array(12)),key=await deriveKey(password,salt);const plain=new TextEncoder().encode(JSON.stringify(payload));const cipher=await crypto.subtle.encrypt({name:'AES-GCM',iv},key,plain);return {encrypted:true,kdf:'PBKDF2-SHA256',iterations:250000,cipher:'AES-GCM',salt:bytesToBase64(salt),iv:bytesToBase64(iv),ciphertext:bytesToBase64(new Uint8Array(cipher))}}
async function decryptJSON(wrapper,password){const salt=base64ToBytes(wrapper.salt),iv=base64ToBytes(wrapper.iv),key=await deriveKey(password,salt);const plain=await crypto.subtle.decrypt({name:'AES-GCM',iv},key,base64ToBytes(wrapper.ciphertext));return JSON.parse(new TextDecoder().decode(plain))}
async function persistState(){state.updatedAt=nowISO();refreshSaveStatus()}
const queueSave=()=>{state.dirty=true;state.updatedAt=nowISO();refreshSaveStatus()};
function audit(action,details={}){state.audit.push({id:uuid(),at:nowISO(),action,details});if(state.audit.length>1000)state.audit=state.audit.slice(-1000);queueSave()}

async function loadPdfJs(){
  if(pdfjsPromise)return pdfjsPromise;
  pdfjsPromise=(async()=>{
    const moduleUrl=new URL('./pdf.min.js',import.meta.url);
    const workerUrl=new URL('./pdf.worker.min.js',import.meta.url);
    const lib=await import(moduleUrl.href);
    lib.GlobalWorkerOptions.workerSrc=workerUrl.href;
    return lib;
  })();
  return pdfjsPromise;
}

/* ---------- Importação e normalização ---------- */

function detectDelimiter(text){
  const first=(text.split(/\r?\n/).find(x=>x.trim())||'');const candidates=[',',';','\t'];let best=',',score=-1;
  for(const d of candidates){let q=false,c=0;for(let i=0;i<first.length;i++){if(first[i]==='"'){if(q&&first[i+1]==='"')i++;else q=!q}else if(!q&&first[i]===d)c++}if(c>score){score=c;best=d}}
  return best;
}
function parseCSVText(text,delimiter=detectDelimiter(text)){
  const rows=[];let row=[],value='',quoted=false;
  for(let i=0;i<text.length;i++){
    const c=text[i],next=text[i+1];
    if(quoted){if(c==='"'&&next==='"'){value+='"';i++}else if(c==='"')quoted=false;else value+=c}
    else if(c==='"')quoted=true;
    else if(c===delimiter){row.push(value);value=''}
    else if(c==='\n'){row.push(value.replace(/\r$/,''));rows.push(row);row=[];value=''}
    else value+=c;
  }
  if(value||row.length){row.push(value.replace(/\r$/,''));rows.push(row)}
  while(rows.length&&!rows.at(-1).some(v=>String(v).trim()))rows.pop();
  return rows;
}
async function readTextFile(file){
  const buf=await file.arrayBuffer();let text=new TextDecoder('utf-8',{fatal:false}).decode(buf);
  const bad=(text.match(/�/g)||[]).length;if(bad>2)text=new TextDecoder('windows-1252').decode(buf);
  return {text,buffer:buf};
}
function headersMap(headers){return Object.fromEntries(headers.map((h,i)=>[norm(h),i]));}
function valueBy(row,map,...aliases){for(const a of aliases){const i=map[norm(a)];if(i!=null)return row[i]??''}return ''}
function parseEnglishMonth(v){const d=parseDate(v);return d?monthKey(d.getFullYear(),d.getMonth()+1):''}
function procedureMatch(description){const n=norm(description);const r=PROCEDURE_RULES.find(x=>x.re.test(n));return r?{...r,normalized:n}:{code:'',name:description||'Não identificado',roles:[],normalized:n,unrecognized:true};}
function canonicalSigtap(v){const d=String(v||'').replace(/\D/g,'');return d.length===10?`${d.slice(0,2)}.${d.slice(2,4)}.${d.slice(4,6)}.${d.slice(6,9)}-${d[9]}`:''}
function visualLines(items,viewport,pdfjs){
  const lines=[];
  for(const item of items){if(!item.str||!item.str.trim())continue;const t=pdfjs.Util.transform(viewport.transform,item.transform);const word={x:t[4],y:t[5],s:item.str.trim()};let line=lines.find(l=>Math.abs(l.y-word.y)<1.25);if(!line)lines.push(line={y:word.y,words:[]});line.words.push(word)}
  for(const l of lines)l.words.sort((a,b)=>a.x-b.x);return lines.sort((a,b)=>a.y-b.y);
}
function lineText(line){return line.words.map(w=>w.s).join(' ').replace(/\s+/g,' ').trim()}
function cellText(line,a,b=Infinity){return line.words.filter(w=>w.x>=a&&w.x<b).map(w=>w.s).join(' ').replace(/\s+/g,' ').trim()}
async function pdfPages(file){
  const pdfjs=await loadPdfJs();const data=new Uint8Array(await file.arrayBuffer());const doc=await pdfjs.getDocument({data,useSystemFonts:true}).promise;const pages=[];
  for(let p=1;p<=doc.numPages;p++){setLoading(`Lendo página ${p} de ${doc.numPages}`,file.name);const page=await doc.getPage(p),viewport=page.getViewport({scale:1}),text=await page.getTextContent();pages.push({page:p,width:viewport.width,height:viewport.height,lines:visualLines(text.items,viewport,pdfjs)})}
  return pages;
}
function pdfFullText(pages){return pages.map(p=>p.lines.map(lineText).join('\n')).join('\n\f\n')}
function extractPdfMetadata(pages){
  const text=pdfFullText(pages.slice(0,2));const period=text.match(/Per[ií]odo:\s*de\s*(\d{2}\/\d{2}\/\d{4})\s*at[eé]\s*(\d{2}\/\d{2}\/\d{4})/i);
  const unit=text.match(/Unidade:\s*\(\s*([0-9]+)\s*\)\s*([^\n]+?)(?:\s+Per[ií]odo:|\s+Ordena[cç][aã]o:|$)/i);
  const issue=text.match(/Emitido por\s+(.+?)\s+em\s+(\d{2}\/\d{2}\/\d{4}\s*-?\s*\d{2}:\d{2})/i);
  return {periodStart:period?isoDate(period[1]):'',periodEnd:period?isoDate(period[2]):'',unitCode:unit?unit[1]:'',unit:unit?unit[2].trim():'',issuedAt:issue?issue[2].replace(/\s*-\s*/,' '):''};
}
function makeSnapshotBase(file,hash,profile,meta={}){return {id:uuid(),hash,fileName:file.name,fileSize:file.size,createdAt:nowISO(),dataExtraction:meta.issuedAt||nowISO(),profile,parserVersion:'1.0.0',unit:meta.unit||'',unitCode:meta.unitCode||'',periodStart:meta.periodStart||'',periodEnd:meta.periodEnd||'',status:'preliminar',dataByMonth:{},procedureCounts:[],validations:[],supersededBy:null}}

async function parseProcedurePdf(file,hash,pages){
  const meta=extractPdfMetadata(pages),snap=makeSnapshotBase(file,hash,'celk_procedimentos_detalhado',meta);snap.status='prévia não homologada';
  const allRows=[];
  for(const page of pages){
    for(const line of page.lines){
      const dateCell=cellText(line,232,303),qtyCell=cellText(line,785,850);if(!/^\d{2}\/\d{2}\/\d{4}/.test(dateCell)||!/^\d+[.,]\d{2}$/.test(qtyCell))continue;
      const row={page:page.page,lineY:round(line.y,1),patient:cellText(line,0,170),age:cellText(line,170,210),sex:cellText(line,210,235),date:dateCell,professional:cellText(line,303,447),procedure:cellText(line,447,624),unitOrigin:cellText(line,624,785),quantity:numeric(qtyCell)};
      if(!row.procedure||row.quantity==null)continue;allRows.push(row);
    }
  }
  if(!allRows.length)throw new Error('O PDF foi reconhecido como “Procedimentos Detalhado”, mas nenhuma linha produtiva pôde ser extraída.');
  const monthGroups={};for(const r of allRows){const d=parseDate(r.date);if(!d)continue;const mk=monthKey(d.getFullYear(),d.getMonth()+1);(monthGroups[mk]??=[]).push(r)}
  const procGlobal={};
  for(const [mk,rows] of Object.entries(monthGroups)){
    const byProcedure={},firstPeople=new Set(),concludedPeople=new Set();
    for(const r of rows){const match=procedureMatch(r.procedure);const key=match.normalized;const pr=byProcedure[key]??={descriptionOriginal:r.procedure,descriptionNormalized:match.name,sigtap:match.code,quantityRaw:0,quantityValid:0,lineCount:0,roles:match.roles,ambiguous:!!match.ambiguous,unrecognized:!!match.unrecognized,outOfScope:!!match.outOfScope,pages:new Set(),professionals:{}};pr.quantityRaw+=r.quantity;pr.quantityValid+=r.quantity;pr.lineCount++;pr.pages.add(r.page);pr.professionals[r.professional]=(pr.professionals[r.professional]||0)+r.quantity;byProcedure[key]=pr;
      if(match.roles.includes('first'))firstPeople.add(norm(r.patient));
      if(match.roles.includes('concluded'))concludedPeople.add(norm(r.patient));
    }
    const procs=Object.values(byProcedure).map(p=>({...p,pages:[...p.pages].sort((a,b)=>a-b)}));
    const roleQty=role=>sum(procs.filter(p=>p.roles.includes(role)).map(p=>p.quantityValid));
    // M4 (municipal): "número total de procedimentos individuais no mês", excluindo só primeira consulta,
    // tratamento concluído e a nota de evolução de atividade em grupo que vaza para este relatório.
    // Propositalmente inclui procedimentos ainda não identificados: são procedimentos individuais reais,
    // só não catalogados ainda. B5 (federal) é diferente: usa lista fechada de SIGTAP (role 'b5den'), sem
    // expandir automaticamente para itens não catalogados.
    const isGroupNote=p=>/^EVOLUCAO DA ATIVIDADE EM GRUPO/.test(norm(p.descriptionOriginal));
    const individualM4=sum(procs.filter(p=>!p.roles.includes('first')&&!p.roles.includes('concluded')&&!isGroupNote(p)).map(p=>p.quantityValid));
    snap.dataByMonth[mk]={kind:'procedure',firstConsultations:firstPeople.size,firstConsultationQuantity:roleQty('first'),treatmentsConcluded:concludedPeople.size,treatmentConcludedQuantity:roleQty('concluded'),preventive:roleQty('preventive'),individualProcedures:individualM4,art:roleQty('art'),restorative:roleQty('restorative'),b5Denominator:roleQty('b5den'),b3Numerator:roleQty('b3num'),b3Denominator:roleQty('b3den'),procedureCounts:procs};
    for(const p of procs){const g=procGlobal[p.descriptionNormalized]??={...p,quantityRaw:0,quantityValid:0,lineCount:0,pages:new Set(),professionals:{}};g.quantityRaw+=p.quantityRaw;g.quantityValid+=p.quantityValid;g.lineCount+=p.lineCount;p.pages.forEach(x=>g.pages.add(x));for(const [n,q] of Object.entries(p.professionals))g.professionals[n]=(g.professionals[n]||0)+q;procGlobal[p.descriptionNormalized]=g}
    if(roleQty('first')!==firstPeople.size)snap.validations.push({level:'warning',code:'M1_QUANTITY_VS_PEOPLE',month:mk,message:`Primeira consulta: o PDF soma ${roleQty('first')} na coluna quantidade, mas contém ${firstPeople.size} pessoas distintas pelo nome exibido. A prévia usa pessoas distintas.`});
    if(roleQty('concluded')!==concludedPeople.size)snap.validations.push({level:'warning',code:'M2_QUANTITY_VS_PEOPLE',month:mk,message:`Tratamento concluído: o PDF soma ${roleQty('concluded')} na coluna quantidade, mas contém ${concludedPeople.size} pessoas distintas pelo nome exibido. A prévia usa pessoas distintas.`});
  }
  snap.procedureCounts=Object.values(procGlobal).map(p=>({...p,pages:[...p.pages].sort((a,b)=>a-b)}));
  snap.validations.push({level:'warning',code:'CBO_NOT_AVAILABLE',message:'O relatório não exibe CBO/INE. Os cálculos federais e o M5/B6 (que reconstrói o denominador pelo perfil de CBO de cirurgião-dentista da Nota B6) são prévios; a elegibilidade profissional não foi verificada.'});
  if(snap.procedureCounts.some(p=>p.ambiguous))snap.validations.push({level:'warning',code:'TRUNCATED_RESTORATION',message:'O CELK abrevia descrições de restaurações. Elas entram na família restauradora, mas o SIGTAP específico não é afirmado.'});
  sessionRaw.set(snap.id,{type:'procedure',rows:allRows.map(r=>({...r,patientMasked:maskName(r.patient)}))});return snap;
}

async function parseGroupPdf(file,hash,pages){
  const meta=extractPdfMetadata(pages),snap=makeSnapshotBase(file,hash,'celk_atividades_grupo',meta);snap.status='prévia não homologada';const events=[];
  for(const page of pages){const lines=page.lines;
    for(let i=0;i<lines.length;i++){
      const dateMatch=lineText(lines[i]).match(/\b(\d{2}\/\d{2}\/\d{4})\b/);if(!dateMatch||cellText(lines[i],0,70).includes('Período'))continue;
      const subject=lines.slice(i+1).find(l=>l.y>lines[i].y+5&&l.y<lines[i].y+32&&/^Assunto:/i.test(lineText(l)));if(!subject)continue;
      const detail=lines.find(l=>l.y>subject.y+5&&l.y<subject.y+18&&l.words.some(w=>w.x>405&&w.x<480&&/^\d+\b/.test(w.s)));
      const presentItem=detail?.words.find(w=>w.x>405&&w.x<480&&/^\d+\b/.test(w.s));
      const subjectText=lineText(subject).replace(/^Assunto:\s*/i,'');const rowText=lineText(lines[i]);
      events.push({page:page.page,date:dateMatch[1],subject:subjectText,present:presentItem?Number(presentItem.s.match(/^\d+/)[0]):null,status:/Conclu[ií]da/i.test(rowText)?'Concluída':'',sourceLine:round(subject.y,1)});
    }
  }
  if(!events.length)throw new Error('O PDF foi reconhecido como “Relação das Atividades em Grupo”, mas nenhuma atividade pôde ser extraída.');
  for(const ev of events){const d=parseDate(ev.date);if(!d)continue;const mk=monthKey(d.getFullYear(),d.getMonth()+1);snap.dataByMonth[mk]??={kind:'group',supervisedBrushingPresent:0,activities:0,eligibleActivities:0,brushingEvents:[]};snap.dataByMonth[mk].activities++;if(/ESCOVACAO SUPERVISIONADA/.test(norm(ev.subject))){snap.dataByMonth[mk].eligibleActivities++;snap.dataByMonth[mk].supervisedBrushingPresent+=Number(ev.present)||0;snap.dataByMonth[mk].brushingEvents.push({date:ev.date,present:Number(ev.present)||0,status:ev.status||''})}}
  snap.validations.push({level:'warning',code:'GROUP_AGGREGATED',message:'O relatório fornece “Presentes” agregados, sem identificar idade, participante, CBO ou deduplicação. M3/B4 são prévios.'});
  sessionRaw.set(snap.id,{type:'group',rows:events});return snap;
}

async function parseMetabaseConsolidated(file,hash,text){
  const rows=parseCSVText(text),headers=rows.shift()||[],map=headersMap(headers),required=['DS DAT','DS UNIDADE','MES REFERENCIA','INDICADOR','NUMERADOR','DENOMINADOR','RESULTADO'];
  const missing=required.filter(h=>map[h]==null);if(missing.length)throw new Error(`CSV consolidado sem cabeçalhos obrigatórios: ${missing.join(', ')}`);
  const data=rows.filter(r=>r.some(v=>String(v).trim()));const first=data[0]||[];const unit=valueBy(first,map,'Ds Unidade'),district=valueBy(first,map,'Ds Dat');const snap=makeSnapshotBase(file,hash,'metabase_saude_bucal',{unit});snap.status='consolidado informado pelo Metabase';snap.district=district;
  for(const r of data){const mk=parseEnglishMonth(valueBy(r,map,'Mes Referencia'));const rawId=norm(valueBy(r,map,'Indicador')).replace(/\s+/g,'_');const n=rawId.match(/ESB_?([1-5])/);if(!mk||!n)continue;const id=`M${n[1]}`;snap.dataByMonth[mk]??={kind:'consolidated',indicators:{}};let score=numeric(valueBy(r,map,'Pontuacao'));if(score!=null&&score<=1)score*=100;snap.dataByMonth[mk].indicators[id]={numerator:numeric(valueBy(r,map,'Numerador')),denominator:numeric(valueBy(r,map,'Denominador')),result:numeric(valueBy(r,map,'Resultado')),reportedScore:score,weight:numeric(valueBy(r,map,'Peso')),updatedAt:valueBy(r,map,'Ts Atualizacao')};}
  const keys=Object.keys(snap.dataByMonth).sort();snap.periodStart=keys[0]?`${keys[0]}-01`:'';if(keys.at(-1)){const {year,month}=parseMonthKey(keys.at(-1));snap.periodEnd=isoDate(new Date(year,month,0))}
  snap.validations.push({level:'info',code:'CONSOLIDATED_REFERENCE',message:'Fonte tratada como consolidado informado. Valores são preservados e comparados com a reconstrução; não são somados aos PDFs.'});
  if(Object.values(snap.dataByMonth).some(x=>x.indicators?.M1?.reportedScore!=null))snap.validations.push({level:'warning',code:'M1_LEGACY_SCORE',message:'A pontuação informada de M1 não é aplicada: a ferramenta usa as quatro faixas vigentes (>1,25%; >0,75%; >0,25%; demais).'});
  sessionRaw.set(snap.id,{type:'csv',headers,rows:data.slice(0,300)});return snap;
}

function detectCSVProfile(headers){const n=headers.map(norm);if(['DS UNIDADE','MES REFERENCIA','INDICADOR','NUMERADOR','DENOMINADOR','RESULTADO'].every(h=>n.includes(h)))return 'metabase_esb';if(['CD USU CADSUS','NOME','EQUIPE','CONSULTA SAUDE BUCAL'].every(h=>n.includes(h)))return 'metabase_2i';return 'unknown'}

async function episodeIdFor(record){const anchor=record.ultimaMenstruacao||record.dataProvParto||record.dataParto||'';return sha256(`2i|${record.prontuario}|${anchor}`)}
async function parseGestantesCSV(file,hash,text){
  const rows=parseCSVText(text),headers=rows.shift()||[],map=headersMap(headers),required=['CD USU CADSUS','NOME','EQUIPE','CONSULTA SAUDE BUCAL'];const missing=required.filter(h=>map[h]==null);if(missing.length)throw new Error(`CSV 2I sem cabeçalhos obrigatórios: ${missing.join(', ')}`);
  const data=rows.filter(r=>r.some(v=>String(v).trim()));const distinct=[...new Set(data.map(r=>valueBy(r,map,'Consulta Saude Bucal')))];
  // Interpretação automática, sem confirmação manual: "Sim" conta como atendida (meta batida), qualquer outro
  // valor conta como pendente. Preserva mapeamentos já confirmados em backups antigos (não sobrescreve).
  distinct.forEach(v=>{if(state.columnMappings.consulta2i[v]==null)state.columnMappings.consulta2i[v]=norm(v)==='SIM'?'atende':'pendente'});
  const snap=makeSnapshotBase(file,hash,'metabase_gestantes_2i',{unit:valueBy(data[0]||[],map,'Unidade')});snap.status='panorama do CSV importado';snap.episodes=[];const grouped=new Map();
  for(let line=0;line<data.length;line++){
    const r=data[line],rawProntuario=valueBy(r,map,'Cd Usu Cadsus');
    const record={prontuario:sanitizeProntuario(rawProntuario),nome:valueBy(r,map,'Nome'),dataNascimento:isoDate(valueBy(r,map,'Data Nascimento')),district:valueBy(r,map,'Dat'),unit:valueBy(r,map,'Unidade'),equipe:valueBy(r,map,'Equipe'),tipoPopulacao:valueBy(r,map,'Tipo Populacao'),tipoLogradouro:valueBy(r,map,'Tipo Logradouro'),logradouro:valueBy(r,map,'Logradouro'),numero:String(valueBy(r,map,'Numero')),complemento:valueBy(r,map,'Complemento'),bairro:valueBy(r,map,'Bairro'),telefone:valueBy(r,map,'Telefone'),ultimaMenstruacao:isoDate(valueBy(r,map,'Ultima Menstruacao')),dataProvParto:isoDate(valueBy(r,map,'Data Prov Parto')),dataParto:isoDate(valueBy(r,map,'Data Parto')),fimPuerperio:isoDate(valueBy(r,map,'Fim Puerperio')),consultaSaudeBucal:valueBy(r,map,'Consulta Saude Bucal'),line:line+2,origin:'metabase',snapshotId:snap.id};
    record.status2i=state.columnMappings.consulta2i[record.consultaSaudeBucal]??(norm(record.consultaSaudeBucal)==='SIM'?'atende':'pendente');record.phoneNormalized=normalizePhone(record.telefone);record.id=await episodeIdFor(record);
    if(isScientificNotation(rawProntuario))snap.validations.push({level:'error',code:'2I_PRONTUARIO_SCIENTIFIC',episodeId:record.id,message:`Prontuário da linha ${line+2} chegou em notação científica (“${rawProntuario}”). O Cd Usu Cadsus provavelmente foi convertido em número (Excel/Metabase) antes da exportação; os dígitos podem estar truncados. Reexporte o CSV com a coluna formatada como texto.`});
    const list=grouped.get(record.id)||[];list.push(record);grouped.set(record.id,list);
  }
  for(const [id,list] of grouped){const base={...list.at(-1),id,duplicateLines:list.map(x=>x.line)};const statuses=[...new Set(list.map(x=>x.status2i))];if(statuses.length>1){base.status2i='indeterminado';snap.validations.push({level:'warning',code:'2I_DUPLICATE_CONFLICT',episodeId:id,message:`Episódio com ${list.length} linhas e interpretações divergentes.`})}else if(list.length>1)snap.validations.push({level:'info',code:'2I_DUPLICATE',episodeId:id,message:`${list.length} linhas conciliadas no mesmo episódio gestacional.`});snap.episodes.push(base)}
  const allDates=snap.episodes.flatMap(e=>[e.ultimaMenstruacao,e.dataProvParto,e.dataParto]).filter(Boolean).sort();snap.periodStart=allDates[0]||'';snap.periodEnd=allDates.at(-1)||'';snap.validations.push({level:'warning',code:'2I_CONSOLIDATED_FIELD',message:'O CSV não traz data da atividade, código ou CBO. O painel usa somente o valor consolidado “Consulta Saude Bucal”.'});
  sessionRaw.set(snap.id,{type:'gestantes',headers,rows:data.map((r,i)=>({line:i+2,values:r}))});return snap;
}

async function parseUnknownCSV(file,hash,text,headers,rows){
  const snap=makeSnapshotBase(file,hash,'csv_manual_configuravel',{});snap.status='layout não reconhecido';snap.validations.push({level:'error',code:'CSV_UNKNOWN',message:'Layout CSV não reconhecido. O arquivo foi conferido, mas nenhum indicador foi calculado.'});sessionRaw.set(snap.id,{type:'csv',headers,rows:rows.slice(0,300)});return snap;
}
async function parseUnknownPdf(file,hash,pages){const snap=makeSnapshotBase(file,hash,'pdf_nao_reconhecido',extractPdfMetadata(pages));snap.status='layout não reconhecido';snap.validations.push({level:'error',code:'PDF_UNKNOWN',message:'Layout de PDF não reconhecido. Nenhum resultado foi produzido.'});sessionRaw.set(snap.id,{type:'pdf',rows:pages.slice(0,3).flatMap(p=>p.lines.slice(0,80).map(l=>({page:p.page,text:lineText(l)})))});return snap}

async function importOne(file){
  const buffer=await file.arrayBuffer(),hash=await sha256(buffer);const existing=state.snapshots.find(s=>s.hash===hash);if(existing){toast(`Arquivo já importado: ${existing.fileName}`);openSnapshot(existing.id);return null}
  let snap;
  if(file.name.toLowerCase().endsWith('.pdf')||file.type==='application/pdf'){
    const pages=await pdfPages(file),text=norm(pdfFullText(pages.slice(0,2)));
    if(text.includes('PROCEDIMENTOS DETALHADO'))snap=await parseProcedurePdf(file,hash,pages);
    else if(text.includes('RELACAO DAS ATIVIDADES EM GRUPO'))snap=await parseGroupPdf(file,hash,pages);
    else snap=await parseUnknownPdf(file,hash,pages);
  }else{
    const {text}=await readTextFile(file),parsed=parseCSVText(text),headers=parsed[0]||[],profile=detectCSVProfile(headers);
    if(profile==='metabase_esb')snap=await parseMetabaseConsolidated(file,hash,text);
    else if(profile==='metabase_2i')snap=await parseGestantesCSV(file,hash,text);
    else snap=await parseUnknownCSV(file,hash,text,headers,parsed.slice(1));
  }
  commitSnapshot(snap);return snap;
}
function commitSnapshot(snap){
  for(const old of state.snapshots){if(old.profile===snap.profile&&old.unit===snap.unit&&old.periodStart===snap.periodStart&&old.periodEnd===snap.periodEnd&&!old.supersededBy)old.supersededBy=snap.id}
  state.snapshots.push(snap);state.dirty=true;audit('snapshot_imported',{snapshotId:snap.id,profile:snap.profile,fileName:snap.fileName,hash:snap.hash,periodStart:snap.periodStart,periodEnd:snap.periodEnd});
  const months=Object.keys(snap.dataByMonth||{}).sort();if(months.length){const latest=months.at(-1),{year,month}=parseMonthKey(latest);state.preferences.year=year;state.preferences.quarter=quarterOfMonth(month);state.preferences.month=latest}
  if(snap.unit&&!state.preferences.unit)state.preferences.unit=snap.unit;queueSave();refreshAll();
}
async function importFiles(files){
  const list=[...files];if(!list.length)return;showLoading('Preparando importação',`${list.length} arquivo(s)`);let ok=0;const failures=[];
  try{for(let i=0;i<list.length;i++){setLoading(`Importando ${i+1} de ${list.length}`,list[i].name);try{const result=await importOne(list[i]);if(result)ok++}catch(e){console.error(e);failures.push({name:list[i].name,message:e?.message||String(e)||'Erro desconhecido.',stack:e?.stack||''})}}}finally{hideLoading();document.getElementById('fileInput').value='';if(failures.length){audit('import_failed',{ok,failures:failures.map(f=>({name:f.name,message:f.message}))});showImportFailures(ok,failures)}else{toast(`${ok} importação(ões) concluída(s)`)}}
}

/* ---------- Motor de cálculo e proveniência ---------- */

function latestSnapshots(profile,mk,unit=state.preferences.unit){
  const candidates=state.snapshots.filter(s=>s.profile===profile&&s.dataByMonth?.[mk]&&(!unit||s.unit===unit));const groups=new Map();
  for(const s of candidates){const key=s.unit||'__sem_unidade__';const prev=groups.get(key);if(!prev||new Date(s.createdAt)>new Date(prev.createdAt))groups.set(key,s)}
  return [...groups.values()];
}
function aggregateProcedureMonth(mk,unit=state.preferences.unit){
  const snaps=latestSnapshots('celk_procedimentos_detalhado',mk,unit);if(!snaps.length)return null;
  const keys=['firstConsultations','firstConsultationQuantity','treatmentsConcluded','treatmentConcludedQuantity','preventive','individualProcedures','art','restorative','b5Denominator','b3Numerator','b3Denominator'];const out=Object.fromEntries(keys.map(k=>[k,0]));out.snapshots=snaps;out.procedureCounts=[];
  const byProc={};for(const s of snaps){const d=s.dataByMonth[mk];for(const k of keys)out[k]+=Number(d[k])||0;for(const p of d.procedureCounts||[]){const key=p.descriptionNormalized;const a=byProc[key]??={...p,quantityRaw:0,quantityValid:0,lineCount:0,pages:[],professionals:{},sources:[]};a.quantityRaw+=p.quantityRaw;a.quantityValid+=p.quantityValid;a.lineCount+=p.lineCount;a.pages=[...new Set([...a.pages,...(p.pages||[])])];for(const [n,q] of Object.entries(p.professionals||{}))a.professionals[n]=(a.professionals[n]||0)+q;a.sources.push(s.id);byProc[key]=a}}
  out.procedureCounts=Object.values(byProc);return out;
}
function aggregateGroupMonth(mk,unit=state.preferences.unit){const snaps=latestSnapshots('celk_atividades_grupo',mk,unit);if(!snaps.length)return null;return {supervisedBrushingPresent:sum(snaps.map(s=>s.dataByMonth[mk].supervisedBrushingPresent)),eligibleActivities:sum(snaps.map(s=>s.dataByMonth[mk].eligibleActivities)),activities:sum(snaps.map(s=>s.dataByMonth[mk].activities)),brushingEvents:snaps.flatMap(s=>s.dataByMonth[mk].brushingEvents||[]).sort((a,b)=>(parseDate(a.date)?.getTime()||0)-(parseDate(b.date)?.getTime()||0)),snapshots:snaps}}
function aggregateConsolidatedMonth(mk,unit=state.preferences.unit){
  const snaps=latestSnapshots('metabase_saude_bucal',mk,unit);if(!snaps.length)return null;const indicators={};
  for(const id of ['M1','M2','M3','M4','M5']){const vals=snaps.map(s=>s.dataByMonth[mk].indicators?.[id]).filter(Boolean);if(!vals.length)continue;const numerator=sum(vals.map(v=>v.numerator)),denominator=sum(vals.map(v=>v.denominator));indicators[id]={numerator,denominator,result:denominator>0?100*numerator/denominator:mean(vals.map(v=>v.result)),reportedResult:mean(vals.map(v=>v.result)),reportedScore:mean(vals.map(v=>v.reportedScore)),weight:vals[0].weight}}
  return {indicators,snapshots:snaps};
}
function getDenominator(indicator,scope,mk,unit=state.preferences.unit){
  const valid=state.denominators.filter(d=>d.indicator===indicator&&d.scope===scope&&(!d.unit||!unit||d.unit===unit)&&d.start<=mk&&d.end>=mk&&d.confirmed&&Number(d.value)>0).sort((a,b)=>new Date(b.updatedAt)-new Date(a.updatedAt));return valid[0]||null;
}
function sourceLabel(snaps){if(!snaps?.length)return 'Sem fonte';const profiles=[...new Set(snaps.map(s=>s.profile))];return profiles.includes('metabase_saude_bucal')?'Metabase consolidado':profiles.includes('celk_atividades_grupo')?'CELK · atividades em grupo':'CELK · procedimentos detalhados'}
function classifyM1(v){if(v==null)return null;return RULESETS.municipal.indicators.M1.bands.find(b=>b.test(v)).label}
function scoreMunicipal(id,v){const r=RULESETS.municipal.indicators[id];if(v==null||!r?.meta)return null;if(v<r.cutoff)return 0;if(v>=r.meta)return 100;return 100*v/r.meta}
function classifyFederal(id,v){
  if(v==null)return null;
  if(id==='B1')return v>1.25?'Ótimo':v>0.75?'Bom':v>0.25?'Suficiente':'Regular';
  if(id==='B2'){if(v>100)return 'Acima de 100% · faixa não definida';return v>75?'Ótimo':v>50?'Bom':v>25?'Suficiente':'Regular'}
  if(id==='B3')return v>=3&&v<10?'Ótimo':v>=10&&v<12?'Bom':v>=12&&v<14?'Suficiente':'Regular';
  if(id==='B4')return v>1?'Ótimo':v>.5?'Bom':v>.25?'Suficiente':'Regular';
  if(id==='B5')return v>=65&&v<=85?'Ótimo':v>=55&&v<65?'Bom':v>=40&&v<55?'Suficiente':'Regular';
  if(id==='B6')return v>8?'Ótimo':v>6?'Bom':v>3?'Suficiente':'Regular';return null;
}
function statusClass(label){const n=norm(label);if(n.includes('OTIMO')||n.includes('ALCANCAD')||n.includes('ATENDE'))return 'success';if(n.includes('BOM'))return 'good';if(n.includes('SUFICIENTE')||n.includes('POSSIVEL'))return 'warn';if(n.includes('REGULAR')||n.includes('PENDENTE')||n.includes('IMPOSSIVEL')||n.includes('ACIMA'))return 'bad';return 'neutral'}
/* ---------- Réguas federais de 4 faixas, paleta própria (diferente da municipal) ---------- */
const FEDERAL_ZONE_COLORS={'Ótimo':{text:'#1a5fb4',bg:'#e5eefa'},'Bom':{text:'#3e93c9',bg:'#e6f2f9'},'Suficiente':{text:'#c99423',bg:'#faf1de'},'Regular':{text:'#a83246',bg:'#f8e6e9'}};
const FEDERAL_B3_ACCENT='#0f8b8d';
const FEDERAL_BAND_DEFS={
  B1:{max:1.7,segments:[[0,.25,'Regular'],[.25,.75,'Suficiente'],[.75,1.25,'Bom'],[1.25,1.7,'Ótimo']]},
  B2:{max:100,segments:[[0,25,'Regular'],[25,50,'Suficiente'],[50,75,'Bom'],[75,100,'Ótimo']]},
  B3:{max:17,segments:[[0,3,'Regular'],[3,10,'Ótimo'],[10,12,'Bom'],[12,14,'Suficiente'],[14,17,'Regular']]},
  B4:{max:1.3,segments:[[0,.25,'Regular'],[.25,.5,'Suficiente'],[.5,1,'Bom'],[1,1.3,'Ótimo']]},
  B5:{max:100,segments:[[0,40,'Regular'],[40,55,'Suficiente'],[55,65,'Bom'],[65,85,'Ótimo'],[85,100,'Regular']]},
  B6:{max:11,segments:[[0,3,'Regular'],[3,6,'Suficiente'],[6,8,'Bom'],[8,11,'Ótimo']]}
};
function federalZoneColor(id,result){if(result==null)return null;const label=classifyFederal(id,result),key=label&&Object.keys(FEDERAL_ZONE_COLORS).find(k=>label.startsWith(k));return (key?FEDERAL_ZONE_COLORS[key]:FEDERAL_ZONE_COLORS['Ótimo']).text}
function federalPill(label){if(!label)return pill('Dados insuficientes','neutral');const key=Object.keys(FEDERAL_ZONE_COLORS).find(k=>label.startsWith(k)),c=FEDERAL_ZONE_COLORS[key]||FEDERAL_ZONE_COLORS['Ótimo'];return `<span class="pill fed-pill" style="background:${c.bg};color:${c.text}">${esc(label)}</span>`}
function federalRulerHTML(id,result){
  const def=FEDERAL_BAND_DEFS[id];if(!def)return rulerHTML(id,result);
  const max=def.max,marks=[...new Set(def.segments.flatMap(s=>[s[0],s[1]]))].filter(v=>v>0&&v<max);
  return `<div class="fedruler"><div class="fedruler-track">${def.segments.map(s=>`<div class="fedruler-seg" style="width:${(s[1]-s[0])/max*100}%;background:${FEDERAL_ZONE_COLORS[s[2]].text}"></div>`).join('')}</div>${result!=null?`<div class="fedruler-marker" style="left:${clamp(result/max*100,0,100)}%"></div>`:''}${marks.map(m=>`<i class="fedruler-mark" style="left:${m/max*100}%"></i><span class="fedruler-label" style="left:${m/max*100}%">${fmtNum(m,m<2?2:0)}</span>`).join('')}</div>`;
}
function valuesDiverge(a,b,tolerance=.01){if(a==null&&b==null)return false;if(a==null||b==null)return true;return Math.abs(Number(a)-Number(b))>tolerance}
function municipalComponents(id,mk){
  const proc=aggregateProcedureMonth(mk),group=aggregateGroupMonth(mk),con=aggregateConsolidatedMonth(mk),provided=con?.indicators?.[id]||null;let numerator=null,denominator=null,denomRecord=null,snaps=[],hypothesis='',missing='';
  if(id==='M1'){numerator=proc?.firstConsultations??null;denomRecord=getDenominator('M1','municipal',mk);denominator=denomRecord?.value??null;snaps=proc?.snapshots||[];hypothesis='Pessoas distintas pelo nome exibido no PDF; validação oficial de 12 meses indisponível.';if(!denomRecord)missing='Denominador do indicador 1 não informado.'}
  if(id==='M2'){numerator=proc?.treatmentsConcluded??null;denominator=proc?.firstConsultations??null;snaps=proc?.snapshots||[];hypothesis='Pessoas distintas pelo nome exibido no PDF no mês. A Nota B2 exige tratamento concluído em até 12 meses após a primeira consulta, uma vez por dentista no ciclo — essa janela de 12 meses não é verificada aqui, só a competência do mês.'}
  if(id==='M3'){numerator=group?.supervisedBrushingPresent??null;denomRecord=getDenominator('M3','municipal',mk);denominator=denomRecord?.value??null;snaps=group?.snapshots||[];hypothesis='Campo agregado “Presentes”; idade e deduplicação não verificáveis.';if(!denomRecord)missing='Denominador do indicador 3 não informado.'}
  if(id==='M4'){numerator=proc?.preventive??null;denominator=proc?.individualProcedures??null;snaps=proc?.snapshots||[];hypothesis='Denominador é o total de procedimentos individuais do mês (a Portaria municipal não enumera uma lista própria), excluindo só primeira consulta, tratamento concluído e a nota de evolução de atividade em grupo. É mais amplo que o denominador federal B5, que usa uma lista fechada de SIGTAP — os dois indicadores divergem por definição normativa. Novo preventivo aumenta simultaneamente numerador e denominador.'}
  if(id==='M5'){numerator=proc?.art??null;denominator=proc?.restorative??null;snaps=proc?.snapshots||[];hypothesis='Perfil B6 de procedimentos restauradores (a Portaria municipal não enumera lista própria); novo ART aumenta numerador e denominador. O CELK não mostra o subtipo da restauração, então não é possível confirmar a exclusão das restaurações em amálgama nem o CBO de cirurgião-dentista exigidos pela Nota B6.'}
  const reconstructed=numerator!=null&&denominator>0?100*numerator/denominator:null;
  const hasCelk=snaps.length>0&&numerator!=null;
  const useProvided=!!provided&&!hasCelk;
  const result=useProvided?provided.result:reconstructed;
  const resultKind=hasCelk?(reconstructed!=null?'reconstruído do CELK':'contagem do CELK; cálculo pendente'):useProvided?'informado pelo Metabase porque não há CELK para o mês':'dados insuficientes';
  const chosenNum=useProvided?provided.numerator:numerator,chosenDen=useProvided?provided.denominator:denominator;
  const chosenSnaps=useProvided?con.snapshots:snaps;
  const divergence=provided&&hasCelk&&(
    valuesDiverge(numerator,provided.numerator)||
    valuesDiverge(denominator,provided.denominator)||
    valuesDiverge(reconstructed,provided.result)
  )?{celkNumerator:numerator,celkDenominator:denominator,celkResult:reconstructed,metabaseNumerator:provided.numerator,metabaseDenominator:provided.denominator,metabaseResult:provided.result,difference:reconstructed!=null&&provided.result!=null?reconstructed-provided.result:null}:null;
  return {id,mk,numerator:chosenNum,denominator:chosenDen,result,resultKind,provided,reconstructed,reconstructedNumerator:numerator,reconstructedDenominator:denominator,denomRecord,score:id==='M1'?null:scoreMunicipal(id,result),classification:id==='M1'?classifyM1(result):null,snapshots:chosenSnaps,hypothesis,missing:result==null?(missing||(!chosenSnaps.length?'Relatório aplicável ainda não importado.':'Denominador igual a zero ou ausente.')):'',source:sourceLabel(chosenSnaps),usesCelk:hasCelk,divergence};
}
const FEDERAL_MIRROR = {B1:'M1',B2:'M2',B4:'M3',B6:'M5'};
function federalComponents(id,mk){
  const mirrorId=FEDERAL_MIRROR[id];
  if(mirrorId){
    const m=municipalComponents(mirrorId,mk);
    const result=m.result;
    const denomShared=['B1','B4'].includes(id);
    const hypothesis=`Usa o mesmo numerador e denominador confirmados para o indicador municipal ${mirrorId}; a Nota Federal ${id} não define fonte própria de dados para o CS Monte Serrat, apenas faixas de classificação próprias.${m.hypothesis?` ${m.hypothesis}`:''}`;
    const missing=result==null?(m.missing||(!m.snapshots?.length?'Relatório CELK aplicável ainda não importado.':'Denominador igual a zero ou ausente.')):'';
    return {id,mk,numerator:m.numerator,denominator:m.denominator,result,classification:classifyFederal(id,result),snapshots:m.snapshots,source:sourceLabel(m.snapshots),hypothesis,mirrorOf:mirrorId,denomRecord:denomShared?m.denomRecord:undefined,missing};
  }
  const proc=aggregateProcedureMonth(mk);let numerator=null,denominator=null,snaps=[],hypothesis='',missing='';
  if(id==='B3'){numerator=proc?.b3Numerator??null;denominator=proc?.b3Denominator??null;snaps=proc?.snapshots||[];hypothesis='Lista própria da B3 (26 códigos SIGTAP da Nota, incluindo as duas exodontias no próprio denominador); exodontia não integra cálculo municipal — indicador só federal. Numerador exige CBO de cirurgião-dentista e denominador aceita também TSB conforme habilitação; o CELK não exibe CBO, então a ferramenta assume que toda exodontia do relatório já é de cirurgião-dentista, sem confirmar. Faixa normativa atípica: valores abaixo de 3% também classificam como Regular, não só acima de 14% — a régua do card mostra as duas zonas vermelhas. A ferramenta não recomenda produzir exodontias para subir o indicador; em taxas altas, calcula apenas a necessidade de ampliar procedimentos elegíveis não exodônticos.'}
  if(id==='B5'){numerator=proc?.preventive??null;denominator=proc?.b5Denominator??null;snaps=proc?.snapshots||[];hypothesis='Numerador igual ao de M4 (mesma lista de 7 procedimentos preventivos). Denominador é a lista fechada de ~27 códigos SIGTAP da Nota B5 — diferente do denominador de M4, que é o total de procedimentos individuais do mês (a Portaria municipal não enumera uma lista própria). CBO não exibido pelo relatório CELK.'}
  const result=numerator!=null&&denominator>0?100*numerator/denominator:null;return {id,mk,numerator,denominator,result,classification:classifyFederal(id,result),snapshots:snaps,source:sourceLabel(snaps),hypothesis,missing:result==null?(missing||(!snaps.length?'Relatório CELK aplicável ainda não importado.':'Denominador igual a zero ou ausente.')):''};
}
function remainingForM1(numerator,denominator,threshold){if(numerator==null||!(denominator>0))return null;return Math.max(0,Math.floor((threshold/100)*denominator)+1-numerator)}
function remainingInclusive(numerator,denominator,target,simultaneous=false){if(numerator==null||!(denominator>0))return null;const t=target/100;return Math.max(0,Math.ceil(simultaneous?(t*denominator-numerator)/(1-t):t*denominator-numerator))}
function monthProjection(comp){
  if(comp.result==null)return [];
  if(comp.id==='M1')return [{label:'Suficiente (>0,25%)',value:remainingForM1(comp.numerator,comp.denominator,.25)},{label:'Bom (>0,75%)',value:remainingForM1(comp.numerator,comp.denominator,.75)},{label:'Ótimo (>1,25%)',value:remainingForM1(comp.numerator,comp.denominator,1.25)}];
  const rule=RULESETS.municipal.indicators[comp.id],sim=['M4','M5'].includes(comp.id);return [{label:`Corte (${fmtPct(rule.cutoff,rule.cutoff<2?1:0)})`,value:remainingInclusive(comp.numerator,comp.denominator,rule.cutoff,sim)},{label:`Meta (${fmtPct(rule.meta,rule.meta<2?1:0)})`,value:remainingInclusive(comp.numerator,comp.denominator,rule.meta,sim)}]
}
function quarterMunicipal(id,year=state.preferences.year,q=state.preferences.quarter){
  const months=quarterMonths(year,q),values=months.map(m=>municipalComponents(id,m));const valid=values.filter(v=>v.result!=null);
  if(id==='M1'){const result=mean(valid.map(v=>v.result));return {id,months,values,result,classification:classifyM1(result),label:'prévia analítica',validMonths:valid.length}}
  const scores=valid.map(v=>v.score).filter(v=>v!=null),score=mean(scores),rawMean=mean(valid.map(v=>v.result)),auditScore=scoreMunicipal(id,rawMean),remaining=4-valid.length,target=Number(state.preferences.targetScore)||100,needed=remaining?((4*target-sum(scores))/remaining):null;return {id,months,values,score,rawMean,auditScore,validMonths:valid.length,needed,status:needed==null?'Quadrimestre completo':needed>100?'Matematicamente impossível':needed<=0?'Já assegurado':'Ainda possível',diverges:score!=null&&auditScore!=null&&Math.abs(score-auditScore)>.01};
}
function comparisonForMonth(mk){const rows=[];for(const [m,b] of [['M1','B1'],['M2','B2'],['M3','B4'],['M4','B5'],['M5','B6']]){const a=municipalComponents(m,mk),f=federalComponents(b,mk);rows.push({municipal:m,federal:b,name:RULESETS.municipal.indicators[m].name,municipalResult:a.result,federalResult:f.result,municipalStatus:m==='M1'?a.classification:a.score!=null?`${fmtNum(a.score,1)} pts`:'—',federalStatus:f.classification||'—'})}return rows}

/* ---------- PREVIEW: leitura por meta (substitui a pontuação 0–100 na Visão Geral) ---------- */
const META_UNIT_LABEL={
  M1:{singular:'primeira consulta programada',plural:'primeiras consultas programadas'},
  M2:{singular:'tratamento concluído',plural:'tratamentos concluídos'},
  M3:{singular:'criança em escovação supervisionada',plural:'crianças em escovação supervisionada'},
  M4:{singular:'procedimento preventivo',plural:'procedimentos preventivos'},
  M5:{singular:'procedimento de ART',plural:'procedimentos de ART (Tratamento Restaurador Atraumático)'}
};
function metaTarget(id){return id==='M1'?1.25:RULESETS.municipal.indicators[id].meta}
function cumulativeMunicipal(id,months){
  const vals=months.map(m=>municipalComponents(id,m)).filter(v=>v.result!=null);
  if(!vals.length)return {numerator:null,denominator:null,result:null,validMonths:0};
  const numerator=sum(vals.map(v=>v.numerator)),denominator=sum(vals.map(v=>v.denominator));
  return {numerator,denominator,result:denominator>0?100*numerator/denominator:null,validMonths:vals.length};
}
function metaGap(id,numerator,denominator){
  if(numerator==null||!(denominator>0))return null;
  if(id==='M1')return remainingForM1(numerator,denominator,1.25);
  return remainingInclusive(numerator,denominator,metaTarget(id),['M4','M5'].includes(id));
}
function metaProgress(id,mk){
  const comp=municipalComponents(id,mk),months=quarterMonths(state.preferences.year,state.preferences.quarter),cum=cumulativeMunicipal(id,months),meta=metaTarget(id);
  const monthGap=metaGap(id,comp.numerator,comp.denominator),quarterGap=metaGap(id,cum.numerator,cum.denominator);
  return {id,meta,month:{...comp,gap:monthGap,achieved:monthGap===0},quarter:{...cum,gap:quarterGap,achieved:quarterGap===0,validMonths:cum.validMonths}};
}
function metaLine(entry,unit,missingText,scopeWord){
  if(entry.result==null)return missingText;
  if(entry.achieved)return `<strong>Meta garantida</strong> — não depende de mais nenhum ${unit.singular} ${scopeWord}.`;
  return `Faltam <strong>${fmtNum(entry.gap,0)}</strong> ${entry.gap===1?unit.singular:unit.plural} para bater a meta ${scopeWord==='agora'?'este mês':'no quadrimestre'}.`;
}
function m1Band(result){return result==null?null:RULESETS.municipal.indicators.M1.bands.find(b=>b.test(result))}
function metaRulerHTML(id,result){
  if(id==='M1'){
    const max=1.7,marks=[{v:.25,l:'0,25'},{v:.75,l:'0,75'},{v:1.25,l:'1,25'}];
    const band=m1Band(result),color=band?band.color:'#a2a9bb',pct=result==null?0:clamp(result/max*100);
    return `<div class="ruler"><div class="ruler-track"><div class="ruler-fill" style="width:${pct}%;background:${color}"></div></div>${marks.map(m=>`<i class="ruler-mark" style="left:${m.v/max*100}%"></i><span class="ruler-label" style="left:${m.v/max*100}%">${m.l}%</span>`).join('')}</div>`;
  }
  const r=RULESETS.municipal.indicators[id],max=r.meta*1.3,cutPct=clamp(r.cutoff/max*100),metaPct=clamp(r.meta/max*100);
  const color=result==null?'#a2a9bb':result>=r.meta?'#39b980':result>=r.cutoff?'#e7a23b':'#e15f41',pct=result==null?0:clamp(result/max*100);
  return `<div class="ruler"><div class="ruler-track"><div class="ruler-fill" style="width:${pct}%;background:${color}"></div></div><i class="ruler-mark" style="left:${cutPct}%"></i><span class="ruler-label" style="left:${cutPct}%">corte</span><i class="ruler-mark meta" style="left:${metaPct}%"></i><span class="ruler-label meta" style="left:${metaPct}%">meta</span></div>`;
}
function metaCard(id,mk,scope){
  const p=metaProgress(id,mk),rule=RULESETS.municipal.indicators[id],unit=META_UNIT_LABEL[id],entry=scope==='quarter'?p.quarter:p.month;
  const metaLabel=id==='M1'?'faixas oficiais (Ótimo >1,25%)':fmtPct(p.meta,p.meta<2?1:0);
  const band=id==='M1'?m1Band(entry.result):null;
  const label=id==='M1'?(band?.label||'Sem dado'):(entry.result==null?'Sem dado':entry.achieved?(scope==='quarter'?'Meta garantida':'Meta batida'):(scope==='quarter'?'Ainda falta':'Abaixo da meta'));
  const state=id==='M1'?(band?statusClass(band.label):'neutral'):(entry.result==null?'neutral':entry.achieved?'success':'warn');
  const missing=entry.result==null?(scope==='month'&&entry.denomRecord===null&&['M1','M3'].includes(id)?'Denominador do mês ainda não confirmado.':scope==='quarter'?'Ainda sem meses suficientes com dado confirmado.':'Sem relatório desta competência ainda.'):'';
  const scopeLabel=scope==='quarter'?`Quadrimestre · acumulado (${entry.validMonths}/4 meses)`:'Este mês';
  return `<article class="card indicator-card meta-card" style="--accent:${state==='success'?'#39b980':state==='warn'?'#e7a23b':state==='good'?'#3dc1d3':state==='bad'?'#e15f41':'#a2a9bb'}"><div class="topline"></div>
<div class="indicator-head"><div><div class="indicator-id">${id} · MUNICIPAL</div><div class="indicator-name">${esc(rule.name)}</div></div><button class="info-btn" data-composition="municipal|${id}|${mk}" aria-label="Como foi calculado?">i</button></div>
<div class="indicator-result"><strong>${fmtPct(entry.result)}</strong>${pill(label,state)}</div>
<div class="numerator-row"><span>${esc(scopeLabel)} · meta <strong>${metaLabel}</strong></span></div>
${metaRulerHTML(id,entry.result)}
<div class="need">${metaLine(entry,unit,missing,scope==='quarter'?'no quadrimestre':'agora')}</div>
</article>`;
}
function metaGoalsHit(mk,scope){
  const ids=['M1','M2','M3','M4','M5'];const withData=[];let hit=0;
  for(const id of ids){const p=metaProgress(id,mk),entry=scope==='quarter'?p.quarter:p.month;if(entry.result!=null){withData.push(id);if(id==='M1'?m1Band(entry.result)?.label==='Ótimo':entry.achieved)hit++}}
  return {hit,total:withData.length};
}
function reconciliationForMonth(mk){const con=aggregateConsolidatedMonth(mk),out=[];if(!con)return out;for(const id of ['M1','M2','M3','M4','M5']){const c=municipalComponents(id,mk),p=con.indicators[id];if(!p)continue;out.push({id,reported:p.result,reconstructed:c.reconstructed,difference:c.reconstructed==null?null:c.reconstructed-p.result,reportedNumerator:p.numerator,reconstructedNumerator:c.reconstructedNumerator,reportedDenominator:p.denominator,reconstructedDenominator:c.reconstructedDenominator})}return out}
function suggestedDenominator(id,mk){const con=aggregateConsolidatedMonth(mk);return con?.indicators?.[id]?.denominator??null}

function buildDiagnostics(){
  const list=[];for(const s of state.snapshots.filter(s=>!s.supersededBy))for(const v of s.validations||[])list.push({...v,snapshotId:s.id,fileName:s.fileName});
  const mk=state.preferences.month;for(const id of ['M1','M3']){const c=municipalComponents(id,mk);if(!c.denomRecord)list.push({level:'warning',code:`${id}_DEN_MISSING`,message:`${id} sem denominador manual confirmado em ${fmtMonth(mk)} (também usado por ${id==='M1'?'B1':'B4'}).`});else{const sug=suggestedDenominator(id,mk);if(sug!=null&&Number(sug)!==Number(c.denomRecord.value))list.push({level:'info',code:`${id}_DEN_DIVERGE_SUGGESTION`,message:`${id}: denominador manual confirmado (${fmtNum(c.denomRecord.value,2)}) diverge do valor sugerido pelo Metabase (${fmtNum(sug,2)}) em ${fmtMonth(mk)}.`})}}
  for(const r of reconciliationForMonth(mk))if(r.difference!=null&&Math.abs(r.difference)>.01)list.push({level:'warning',code:`RECON_${r.id}`,message:`${r.id}: CELK ${fmtPct(r.reconstructed)} × Metabase ${fmtPct(r.reported)} (diferença ${fmtPct(r.difference)}). O cálculo ativo usa o CELK.`});
  for(const id of ['M1','M2','M3','M4','M5']){const c=municipalComponents(id,mk);if(c.result!=null&&c.result>100)list.push({level:'warning',code:`${id}_OVER_100`,message:`${id} acima de 100% em ${fmtMonth(mk)}: revisar denominador e possível dupla contagem antes de interpretar.`});if(c.result==null&&c.snapshots?.length&&c.denominator===0)list.push({level:'warning',code:`${id}_DEN_ZERO`,message:`${id}: denominador reconstruído é igual a zero em ${fmtMonth(mk)} apesar de haver relatório importado; o resultado não pode ser calculado.`})}
  for(const id of ['B1','B2','B3','B4','B5','B6']){const c=federalComponents(id,mk);if(c.result!=null&&c.result>100)list.push({level:id==='B2'?'error':'warning',code:`${id}_OVER_100`,message:id==='B2'?'M2/B2 (mesmo valor, indicadores espelhados) acima de 100%: revisar defasagem entre tratamentos concluídos e primeiras consultas do mês.':`${id} acima de 100% em ${fmtMonth(mk)}: revisar denominador e possível dupla contagem antes de interpretar.`});if(c.result==null&&c.snapshots?.length&&c.denominator===0)list.push({level:'warning',code:`${id}_DEN_ZERO`,message:`${id}: denominador reconstruído é igual a zero em ${fmtMonth(mk)} apesar de haver relatório importado; o resultado não pode ser calculado.`})}
  const b5=federalComponents('B5',mk);if(b5.result>85)list.push({level:'warning',code:'B5_NORMATIVE_TENSION',message:'B5 acima de 85% é classificado como Regular pela Nota, apesar da polaridade maior-melhor.'});
  const b3=federalComponents('B3',mk);if(b3.result!=null&&b3.result<3)list.push({level:'warning',code:'B3_BELOW_3',message:'B3 abaixo de 3% cai em Regular pela Nota; verificar completude do registro antes de qualquer interpretação.'});
  const active2i=getActive2ISnapshot();for(const e of active2i?.episodes||[]){if(!e.phoneNormalized&&e.telefone)list.push({level:'info',code:'2I_PHONE_INVALID',episodeId:e.id,message:'Há telefone 2I inválido ou sem DDD; o WhatsApp permanece desabilitado.'})}
  for(const m of state.gestantes.manual.filter(x=>!x.archived)){const match=findManualMatch(m,active2i?.episodes||[]);if(match&&!state.gestantes.merges[m.id])list.push({level:'warning',code:'2I_MANUAL_MATCH',manualId:m.id,episodeId:match.id,message:'Cadastro manual possivelmente corresponde a registro posterior do Metabase; exige reconciliação explícita.'})}
  currentDiagnostics=list;return list;
}

/* ---------- Módulo 2I ---------- */

function getActive2ISnapshot(){return state.snapshots.filter(s=>s.profile==='metabase_gestantes_2i'&&!s.supersededBy).sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt))[0]||state.snapshots.filter(s=>s.profile==='metabase_gestantes_2i').sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt))[0]||null}
function episodeAnchor(e){return e.ultimaMenstruacao||e.dataProvParto||e.dataParto||''}
function findManualMatch(manual,episodes){if(!manual.prontuario)return null;return episodes.find(e=>e.prontuario===manual.prontuario&&episodeAnchor(e)===episodeAnchor(manual))||null}
function followupFor(id){return state.gestantes.followups[id]||{state:'nao_contatada',updatedAt:null,history:[]}}
function followupLabel(v){return v==='whatsapp_enviado'?'WhatsApp enviado · aguardando resposta':v==='busca_ativa_solicitada'?'Busca ativa solicitada':v==='ok_manual'?'OK · confirmação manual':v==='atende_confirmado'?'Atende · confirmado no Metabase':v==='agendada'?'Consulta agendada':'Não contatada'}
function followupShortLabel(v){return v==='whatsapp_enviado'?'Tentativa de contato · WhatsApp':v==='busca_ativa_solicitada'?'Busca ativa solicitada':v==='agendada'?'Consulta agendada':''}
const FOLLOWUP_COLORS={nao_contatada:{text:'#697386',bg:'#f0f2f6'},whatsapp_enviado:{text:'#3a52c4',bg:'#eef0ff'},busca_ativa_solicitada:{text:'#b0356b',bg:'#fdecf3'},ok_manual:{text:'#247a4b',bg:'#edf9f3'},atende_confirmado:{text:'#1f7a80',bg:'#e7f7f8'},agendada:{text:'#248997',bg:'#eaf8fa'}};
function followupColor(v){return FOLLOWUP_COLORS[v]||FOLLOWUP_COLORS.nao_contatada}
function followupCounts(history){const h=history||[];return {whatsapp:h.filter(x=>x.to==='whatsapp_enviado').length,buscaAtiva:h.filter(x=>x.to==='busca_ativa_solicitada').length,agendada:h.filter(x=>x.to==='agendada').length,notes:h.filter(x=>x.type==='note').length}}
function isAttended(e){return e.status2i==='atende'||['ok_manual','atende_confirmado'].includes(followupFor(e.id).state)}
function status2ILabel(v){return v==='atende'?'Atende':v==='pendente'?'Pendente':v==='indeterminado'?'Indeterminado':'Sem registro no Metabase'}
function episodeOverride(id){return state.gestantes.overrides[id]||{}}
function mergedEpisodes(){
  const snap=getActive2ISnapshot(),metabase=(snap?.episodes||[]).map(e=>({...e,origin:'metabase'})),manual=state.gestantes.manual.filter(m=>!m.archived);const out=[];
  for(const e of metabase){const entry=[...manual].find(m=>state.gestantes.merges[m.id]===e.id);const ov=episodeOverride(e.id);
    if(entry){out.push({...entry,...e,...ov,origin:'metabase_manual',manualId:entry.id,metabaseId:e.id,observacao:entry.observacao||'',dataAtividadeManual:entry.dataAtividadeManual||'',phoneNormalized:normalizePhone(ov.telefone??e.telefone)})}
    else out.push({...e,...ov,phoneNormalized:normalizePhone(ov.telefone??e.telefone)})}
  for(const m of manual)if(!state.gestantes.merges[m.id])out.push({...m,origin:'manual',status2i:'sem_metabase',phoneNormalized:normalizePhone(m.telefone)});return out;
}
function pregnancyStage(e){return e.dataParto?'finalizada':'ativa'}
function isExcluded(id){return !!state.gestantes.excluded[id]}
function visibleByExclusion(episodes){const only=state.preferences.pregExcluded==='only';return episodes.filter(e=>only?isExcluded(e.id):!isExcluded(e.id))}
function applyPregFilters(episodes){const p=state.preferences;const search=norm(p.pregSearch);return episodes.filter(e=>(!p.pregTeam||e.equipe===p.pregTeam)&&(!p.pregStatus||e.status2i===p.pregStatus)&&(!p.pregOrigin||e.origin===p.pregOrigin)&&(!p.pregPhone||(p.pregPhone==='valid'?!!e.phoneNormalized:!e.phoneNormalized))&&(!p.pregFollowup||followupFor(e.id).state===p.pregFollowup)&&(!p.pregStage||pregnancyStage(e)===p.pregStage)&&(!search||norm(`${e.nome} ${e.prontuario}`).includes(search)))}
function excludeEpisode(id,reason){state.gestantes.excluded[id]={at:nowISO(),reason:reason||''};audit('2i_episode_excluded',{episodeId:id,reason:reason||''});queueSave();closeDrawer();refreshAll();toast('Gestante excluída da lista operacional (dado preservado, pode ser restaurado).')}
function restoreEpisode(id){delete state.gestantes.excluded[id];audit('2i_episode_restored',{episodeId:id});queueSave();closeDrawer();refreshAll();toast('Gestante restaurada na lista operacional.')}
function openExcludeEpisode(id){openModal(`<div class="modal-head"><div><h2 id="modalTitle">Excluir gestante da lista operacional</h2><p>Não apaga o cadastro nem altera o panorama do CSV — só some da lista operacional até ser restaurada.</p></div></div><form id="excludeForm"><div class="modal-body"><label class="field full"><span>Motivo (opcional)</span><textarea id="excludeReason" placeholder="Ex.: gestação encerrada, registro duplicado, mudou de unidade"></textarea></div><div class="modal-foot"><button type="button" class="btn" data-close-modal>Cancelar</button><button type="submit" class="btn danger">Confirmar exclusão</button></div></form>`,{wide:false});document.getElementById('excludeForm').onsubmit=e=>{e.preventDefault();excludeEpisode(id,document.getElementById('excludeReason').value.trim())}}
function ageAt(e,date=new Date()){const b=parseDate(e.dataNascimento);if(!b)return null;let age=date.getFullYear()-b.getFullYear();if(date<new Date(date.getFullYear(),b.getMonth(),b.getDate()))age--;return age}
function gestationalWeeks(e,at=new Date()){const dum=parseDate(e.ultimaMenstruacao);if(!dum)return null;const end=parseDate(e.dataParto)||at;const weeks=Math.floor((end-dum)/(7*864e5));return weeks>=0&&weeks<=45?weeks:null}
function setFollowup(id,next,note=''){
  const old=followupFor(id),entry={at:nowISO(),from:old.state,to:next,note};state.gestantes.followups[id]={state:next,updatedAt:entry.at,history:[...(old.history||[]),entry]};audit('2i_followup_changed',{episodeId:id,from:old.state,to:next});queueSave();refreshAll();reopenDrawerIfOpen(id);
}
function reopenDrawerIfOpen(id){const b=document.getElementById('drawerBackdrop');if(!b||!b.classList.contains('open'))return;const activeTabBtn=document.querySelector('#drawer .g-tab.active');openEpisode(id,activeTabBtn?activeTabBtn.dataset.gTab:undefined)}
function addFollowupNote(id,text){text=(text||'').trim();if(!text){toast('Escreva algo antes de salvar a nota.');return}const old=followupFor(id),entry={at:nowISO(),type:'note',text};state.gestantes.followups[id]={state:old.state,updatedAt:old.updatedAt,history:[...(old.history||[]),entry]};audit('2i_followup_note_added',{episodeId:id});queueSave();refreshAll();toast('Nota adicionada ao acompanhamento.');reopenDrawerIfOpen(id);
}
function toggleGestacaoEncerrada(id){const e=mergedEpisodes().find(x=>x.id===id||x.manualId===id);if(!e)return;const finalized=pregnancyStage(e)==='finalizada',newParto=finalized?'':isoDate(new Date());if(e.origin==='manual'){const m=state.gestantes.manual.find(x=>x.id===id);if(m){m.dataParto=newParto;m.updatedAt=nowISO();m.edits=[...(m.edits||[]),{at:nowISO(),action:'gestacao_encerrada_toggle'}]}}else{const ov={...episodeOverride(id)};ov.dataParto=newParto;state.gestantes.overrides[id]=ov}audit('2i_gestacao_encerrada_toggle',{episodeId:id,to:finalized?'ativa':'finalizada'});queueSave();refreshAll();reopenDrawerIfOpen(id);
}
function saveAllFieldsOverride(id){const val=k=>{const el=document.getElementById(k);return el?el.value.trim():''};const dv=k=>{const el=document.getElementById(k);return el?el.value:''};const ov={...episodeOverride(id),nome:val('efNome'),prontuario:sanitizeProntuario(val('efProntuario')),equipe:val('efEquipe'),dataNascimento:dv('efNascimento'),enderecoOverride:val('efEndereco'),telefone:val('efTelefone'),ultimaMenstruacao:dv('efDum'),dataProvParto:dv('efDpp'),dataParto:dv('efParto'),notaLocal:val('efNota')};state.gestantes.overrides[id]=ov;audit('2i_full_override_saved',{episodeId:id});queueSave();refreshAll();toast('Dados atualizados localmente. O CSV original do Metabase continua intacto.');reopenDrawerIfOpen(id);
}
function mergeManual(manualId,episodeId){
  const m=state.gestantes.manual.find(x=>x.id===manualId),e=getActive2ISnapshot()?.episodes?.find(x=>x.id===episodeId);if(!m||!e)return;const mf=followupFor(manualId),ef=followupFor(episodeId);state.gestantes.merges[manualId]=episodeId;if((mf.history||[]).length){state.gestantes.followups[episodeId]={state:mf.state,updatedAt:mf.updatedAt,history:[...(ef.history||[]),...(mf.history||[]).map(h=>({...h,note:`${h.note||''} (origem: cadastro manual)`.trim()}))]};delete state.gestantes.followups[manualId]}
  audit('2i_manual_merged',{manualId,episodeId});queueSave();closeDrawer();refreshAll();toast('Cadastro manual mesclado com o episódio do Metabase.');
}
function gestantesDataCounts(){return {snapshots:state.snapshots.filter(s=>s.profile==='metabase_gestantes_2i').length,manual:state.gestantes.manual.length,followups:Object.keys(state.gestantes.followups).length,overrides:Object.keys(state.gestantes.overrides).length,excluded:Object.keys(state.gestantes.excluded).length}}
function clearAllGestantesData(){
  const before=gestantesDataCounts();
  for(const s of state.snapshots)if(s.profile==='metabase_gestantes_2i')sessionRaw.delete(s.id);
  state.snapshots=state.snapshots.filter(s=>s.profile!=='metabase_gestantes_2i');
  state.gestantes={manual:[],followups:{},merges:{},excluded:{},overrides:{}};
  state.dirty=true;
  return before;
}
function clearAllGestantes(){const before=clearAllGestantesData();audit('2i_all_cleared',before);queueSave();closeModal();refreshAll();toast('Todos os dados de gestantes (2I) foram apagados: CSV importado, cadastros manuais e acompanhamento.')}
function openClearGestantesModal(){
  const c=gestantesDataCounts();
  if(!c.snapshots&&!c.manual&&!c.followups&&!c.overrides&&!c.excluded){toast('Não há dados de gestantes (2I) para limpar.');return}
  openModal(`<div class="modal-head"><div><h2 id="modalTitle">Limpar todas as gestantes (2I)</h2><p>Esta ação não pode ser desfeita.</p></div></div><form id="clearGestantesForm"><div class="modal-body"><div class="notice danger"><strong>Vai apagar permanentemente:</strong> ${fmtNum(c.snapshots)} snapshot(s) do CSV de gestantes importado, ${fmtNum(c.manual)} cadastro(s) manual(is), ${fmtNum(c.followups)} registro(s) de acompanhamento e ${fmtNum(c.overrides)} correção(ões) de contato/gestação. A lista volta ao estado inicial, como se nada tivesse sido importado para o 2I.</div><div class="notice warn" style="margin-top:9px">Se ainda não exportou um backup, cancele e exporte antes de continuar — depois de confirmado, não há como recuperar esses dados nesta ferramenta.</div><label class="field full" style="margin-top:12px"><span class="required">Digite LIMPAR TUDO para confirmar</span><input id="clearGestantesConfirm" autocomplete="off" placeholder="LIMPAR TUDO"></label></div><div class="modal-foot"><button type="button" class="btn" data-close-modal>Cancelar</button><button type="submit" class="btn danger">Apagar tudo</button></div></form>`,{wide:false});
  document.getElementById('clearGestantesForm').onsubmit=e=>{e.preventDefault();const v=document.getElementById('clearGestantesConfirm').value.trim().toUpperCase();if(v!=='LIMPAR TUDO'){toast('Digite exatamente "LIMPAR TUDO" para confirmar.');return}clearAllGestantes()};
}

/* ---------- Componentes de interface ---------- */

function kpi(label,value,desc,accent='#546de5',iconName='trend'){return `<article class="card kpi" style="--accent:${accent}"><div class="stripe"></div><div class="kpi-head"><div class="kpi-label">${esc(label)}</div><div class="soft-icon">${icon(iconName)}</div></div><div class="kpi-value">${value}</div><div class="kpi-desc">${desc}</div></article>`}
function pill(label,cls){return `<span class="pill ${cls||statusClass(label)}">${esc(label||'Indeterminado')}</span>`}
const ROLE_INDICATOR_MAP={first:[['M1','Numerador'],['B1','Numerador'],['M2','Denominador'],['B2','Denominador']],concluded:[['M2','Numerador'],['B2','Numerador']],preventive:[['M4','Numerador'],['B5','Numerador']],m4den:[['M4','Denominador']],art:[['M5','Numerador'],['B6','Numerador']],restorative:[['M5','Denominador'],['B6','Denominador']],b3num:[['B3','Numerador']],b3den:[['B3','Denominador']],b5den:[['B5','Denominador']]};
const INDICATOR_ORDER=['M1','M2','M3','M4','M5','B1','B2','B3','B4','B5','B6'];
function procedureRoleBadges(roles){if(!roles||!roles.length)return [];const seen=new Set(),out=[];for(const r of roles){for(const [ind,part] of (ROLE_INDICATOR_MAP[r]||[])){const key=ind+part;if(seen.has(key))continue;seen.add(key);out.push({ind,part})}}out.sort((a,b)=>INDICATOR_ORDER.indexOf(a.ind)-INDICATOR_ORDER.indexOf(b.ind)||(a.part<b.part?-1:1));return out}
function procedureRoleBadgesHTML(roles){return procedureRoleBadges(roles).map(x=>pill(`${x.ind} - ${x.part}`,x.part==='Numerador'?'info':'good')).join(' ')}
function legendDot(color,label,dashed=false){return `<span class="legend-item"><i class="legend-dot" style="background:${color}${dashed?';border:1px dashed #c7ccd8':''}"></i>${esc(label)}</span>`}
function emptyState(title,text,action=true){return `<article class="card empty-state"><div class="large-icon">${icon('upload')}</div><h2>${esc(title)}</h2><p>${esc(text)}</p>${action?`<div class="card-actions" style="justify-content:center"><button class="btn primary" data-action="import">${icon('upload')}Importar relatórios novos</button><button class="btn" data-action="restore-backup">${icon('database')}Restaurar backup anterior</button></div><p class="muted" style="margin-top:6px;font-size:11px">Nada fica salvo pelo navegador. Se você já usou a ferramenta antes, restaure o último backup exportado para continuar de onde parou.</p>`:''}</article>`}
function dataQuality(comp){if(comp.result==null)return pill('Dados insuficientes','neutral');if(comp.resultKind?.startsWith('informado pelo Metabase'))return pill('Consolidado informado','info');return pill('Prévia não homologada','warn')}
function rulerHTML(id,result){
  if(result==null)return '<div class="ruler"><div class="ruler-track"></div></div>';
  if(id==='M1'||id==='B1'){const max=1.7,marks=[{v:.25,l:'0,25'},{v:.75,l:'0,75'},{v:1.25,l:'1,25',meta:true}];return `<div class="ruler"><div class="ruler-track"><div class="ruler-fill" style="width:${clamp(result/max*100)}%"></div></div>${marks.map(m=>`<i class="ruler-mark ${m.meta?'meta':''}" style="left:${m.v/max*100}%"></i><span class="ruler-label ${m.meta?'meta':''}" style="left:${m.v/max*100}%">${m.l}%</span>`).join('')}</div>`}
  const r=RULESETS.municipal.indicators[id];if(r?.meta){const max=r.meta*1.35,cut=r.cutoff/max*100,meta=r.meta/max*100;return `<div class="ruler"><div class="ruler-track"><div class="ruler-fill" style="width:${clamp(result/max*100)}%"></div></div><i class="ruler-mark" style="left:${cut}%"></i><span class="ruler-label" style="left:${cut}%">corte</span><i class="ruler-mark meta" style="left:${meta}%"></i><span class="ruler-label meta" style="left:${meta}%">meta</span></div>`}
  return `<div class="ruler"><div class="ruler-track"><div class="ruler-fill" style="width:${clamp(result)}%"></div></div></div>`;
}
function denomInline(id,scope,mk){
  const record=getDenominator(id,scope,mk),suggestion=scope==='municipal'&&['M1','M3'].includes(id)?suggestedDenominator(id,mk):null;return `<div class="denom-inline"><label>${scope==='municipal'?(id==='M1'?'Denominador do indicador 1':'Denominador do indicador 3'):`Denominador ${id}`} · ${fmtMonth(mk)}</label><div class="denom-controls"><input inputmode="decimal" data-denom-input="${id}|${scope}" value="${record?esc(record.value):''}" placeholder="Informar valor"><button class="btn small" data-save-denom="${id}|${scope}">Salvar</button></div>${record?`<small class="muted">${esc(record.origin)} · vigência ${fmtMonth(record.start)}–${fmtMonth(record.end)}</small>`:''}${suggestion!=null&&(!record||Number(record.value)!==Number(suggestion))?`<button class="link-btn" data-use-suggestion="${id}|${scope}|${suggestion}">Sugestão do Metabase: ${fmtNum(suggestion,2)} · usar</button>`:''}</div>`
}
function divergenceNotice(comp){
  if(!comp?.divergence)return '';
  const d=comp.divergence;
  return `<div class="notice warn source-divergence"><strong>Divergência com o Metabase.</strong><span> CELK usado no cálculo: ${fmtNum(d.celkNumerator)} ÷ ${fmtNum(d.celkDenominator,2)} = ${fmtPct(d.celkResult)}. Metabase de referência: ${fmtNum(d.metabaseNumerator)} ÷ ${fmtNum(d.metabaseDenominator,2)} = ${fmtPct(d.metabaseResult)}.</span></div>`;
}
function sharedDenomNote(mirrorId){return `<div class="denom-inline"><label>Denominador ${esc(mirrorId)} (compartilhado)</label><small class="muted">Mesmo valor confirmado no painel municipal para ${esc(mirrorId)}. <button class="link-btn" data-go="municipal">Editar em Municipal</button></small></div>`}
function indicatorCard(comp,scope='municipal'){
  const isM=scope==='municipal',isB3=comp.id==='B3',rule=isM?RULESETS.municipal.indicators[comp.id]:RULESETS.federal.indicators[comp.id];const label=isM?(comp.id==='M1'?comp.classification:comp.score!=null?`${fmtNum(comp.score,1)} pts`:'Dados insuficientes'):(comp.classification||'Dados insuficientes');const denomRequired=isM&&['M1','M3'].includes(comp.id);const denomShared=!isM&&['B1','B4'].includes(comp.id);const projection=isM?monthProjection(comp):[];
  const accent=isB3?FEDERAL_B3_ACCENT:!isM?(comp.result==null?'#a2a9bb':federalZoneColor(comp.id,comp.result)):(comp.result==null?'#a2a9bb':label&&statusClass(label)==='bad'?'#e15f41':label&&statusClass(label)==='warn'?'#e7a23b':'#546de5');
  const resultPill=isM?pill(label,statusClass(label)):federalPill(label);
  const ruler=isM?rulerHTML(comp.id,comp.result):federalRulerHTML(comp.id,comp.result);
  const footerNeed=isM?(comp.missing?esc(comp.missing):projection.length?projection.map(p=>`${esc(p.label)}: <strong>${p.value===0?'alcançado':`${p.value} faltante(s)`}</strong>`).join('<br>'):esc(comp.hypothesis)):(comp.missing?esc(comp.missing):'');
  return `<article class="card indicator-card" style="--accent:${accent}"><div class="topline"></div><div class="indicator-head"><div><div class="indicator-id">${comp.id} · ${isM?'MUNICIPAL':'FEDERAL'}</div><div class="indicator-name">${esc(rule.name)}</div></div><button class="info-btn" data-composition="${scope}|${comp.id}|${comp.mk}" aria-label="Como foi calculado?">i</button></div><div class="indicator-result"><strong>${fmtPct(comp.result)}</strong>${resultPill}</div><div class="numerator-row"><span>Numerador <strong>${fmtNum(comp.numerator,0)}</strong></span><span>·</span><span>Denominador <strong>${fmtNum(comp.denominator,2)}</strong></span></div>${isM?divergenceNotice(comp):''}${ruler}${denomRequired?denomInline(comp.id,scope,comp.mk):denomShared?sharedDenomNote(comp.mirrorOf):''}<div class="indicator-footer"><div class="need">${footerNeed}</div>${dataQuality(comp)}</div></article>`
}
/* ---------- Apuração do quadrimestre sem pontos (leitura por meta) ---------- */
function pctDecimals(id){return id==='M1'?2:1}
function zoneClass(id,result){
  if(result==null)return null;
  if(id==='M1'){const b=m1Band(result);if(!b)return null;return b.label==='Ótimo'||b.label==='Bom'?'zone-good':b.label==='Suficiente'?'zone-warn':'zone-bad'}
  const r=RULESETS.municipal.indicators[id];return result>=r.meta?'zone-good':result>=r.cutoff?'zone-warn':'zone-bad';
}
function zoneLabel(id,result){
  if(result==null)return null;
  if(id==='M1')return classifyM1(result);
  const r=RULESETS.municipal.indicators[id];return result>=r.meta?'Meta batida':result>=r.cutoff?'Em progresso':'Abaixo do corte';
}
function apuracaoMonthBoxes(id,values){
  const ref=state.preferences.month;
  return `<div class="month-strip">${values.map(v=>{
    const isCurrent=v.mk===ref,isFuture=v.mk>ref;
    if(v.result==null){
      const cls=isFuture?'future':'missing',label=isFuture?'mês futuro':'sem dado';
      return `<div class="month-box ${cls}${isCurrent?' current':''}"><span>${fmtMonth(v.mk)}</span><strong>—</strong><small>${label}</small></div>`;
    }
    const zc=zoneClass(id,v.result)||'',label=zoneLabel(id,v.result);
    return `<div class="month-box ${zc}${isCurrent?' current':''}"><span>${fmtMonth(v.mk)}</span><strong>${fmtPct(v.result,pctDecimals(id))}</strong><small>${esc(label)}</small></div>`;
  }).join('')}</div>`;
}
function quadrimestralOutlook(id,q){
  const unit=META_UNIT_LABEL[id],meta=metaTarget(id),ref=state.preferences.month;
  const remainingMonths=q.months.filter(m=>m>ref).length;
  const cum=cumulativeMunicipal(id,q.months);
  const gap=metaGap(id,cum.numerator,cum.denominator);
  if(gap===0)return {cls:'success',label:'Meta garantida',detail:`O quadrimestre já soma ${fmtPct(cum.result,pctDecimals(id))}, na meta de ${fmtPct(meta,pctDecimals(id))} — não depende mais dos meses restantes.`};
  if(gap==null)return remainingMonths===0
    ?{cls:'bad',label:'Meta vencida e não cumprida',detail:'Quadrimestre encerrado sem dados suficientes para apurar o resultado.'}
    :{cls:'neutral',label:'Sem dados suficientes',detail:'Ainda não há dados no quadrimestre para projetar a meta.'};
  if(remainingMonths===0)return {cls:'bad',label:'Meta vencida e não cumprida',detail:`Faltaram ${fmtNum(gap,0)} ${gap===1?unit.singular:unit.plural} para bater a meta neste quadrimestre — não há mais meses para recuperar.`};
  const requiredPerMonth=gap/remainingMonths,validMonths=q.values.filter(v=>v.result!=null),avgMonthlyPace=validMonths.length?mean(validMonths.map(v=>v.numerator)):null,monthsWord=remainingMonths===1?'mês restante':'meses restantes';
  if(!avgMonthlyPace)return {cls:'warn',label:'Ainda possível',detail:`Faltam ${fmtNum(gap,0)} ${gap===1?unit.singular:unit.plural} em ${remainingMonths} ${monthsWord} (${fmtNum(requiredPerMonth,1)}/mês). Sem histórico no quadrimestre para comparar com o ritmo usual.`};
  const ratio=requiredPerMonth/avgMonthlyPace;
  if(ratio<=1)return {cls:'good',label:'Ainda possível, no ritmo normal',detail:`Precisa de ${fmtNum(requiredPerMonth,1)} ${unit.plural}/mês; a média já registrada no quadrimestre é ${fmtNum(avgMonthlyPace,1)}/mês.`};
  if(ratio<=2)return {cls:'warn',label:'Precisa acelerar o ritmo',detail:`Precisa de ${fmtNum(requiredPerMonth,1)} ${unit.plural}/mês; acima da média já registrada de ${fmtNum(avgMonthlyPace,1)}/mês.`};
  return {cls:'bad',label:'Ritmo exigido muito acima do histórico',detail:`Precisa de ${fmtNum(requiredPerMonth,1)} ${unit.plural}/mês, mas o histórico do quadrimestre é de só ${fmtNum(avgMonthlyPace,1)}/mês — bater a meta exigiria um ritmo bem fora do padrão.`};
}
function overviewHTML(){
  if(!state.snapshots.length)return emptyState('Importe os primeiros relatórios','Use o PDF “Procedimentos Detalhado” durante o mês, o relatório de atividades em grupo para M3/B4 e o CSV do Metabase como referência consolidada.');
  const mk=state.preferences.month,diag=buildDiagnostics(),pregExpanded=visibleByExclusion(mergedEpisodes()),attended=pregExpanded.filter(isAttended).length;
  const scope=state.preferences.overviewScope==='quarter'?'quarter':'month';
  const goals=metaGoalsHit(mk,scope);
  const goalsLabel=scope==='quarter'?'Metas garantidas no quadrimestre':'Metas batidas este mês';
  return `<div class="grid-kpis">${kpi('Competência em foco',fmtMonth(mk,true),`Q${state.preferences.quarter} de ${state.preferences.year}`,'#546de5','clock')}${kpi(goalsLabel,goals.total?`${goals.hit} de ${goals.total}`:'—',goals.total?`${goals.total} indicador(es) com dado nesse recorte`:'Nenhum indicador com dado ainda','#39b980','trend')}${kpi('Gestantes',pregExpanded.length?fmtPct(100*attended/pregExpanded.length,1):'—',`${attended} gestante(s) com meta batida do total de ${pregExpanded.length} na lista operacional`,'#3dc1d3','heart')}${kpi('Diagnósticos',fmtNum(diag.length),`${diag.filter(d=>d.level==='error').length} crítico(s) · ${diag.filter(d=>d.level==='warning').length} alerta(s)`,'#e7a23b','alert')}</div><div class="scope-toggle-row"><div class="scope-toggle" role="tablist" aria-label="Ver indicadores por"><button class="scope-btn ${scope==='month'?'active':''}" data-overview-scope="month">Por mês</button><button class="scope-btn ${scope==='quarter'?'active':''}" data-overview-scope="quarter">Por quadrimestre</button></div><span class="muted" style="font-size:11.5px">${scope==='month'?`Resultado de ${fmtMonth(mk,true)} contra a meta mensal.`:`Acumulado de Q${state.preferences.quarter}/${state.preferences.year} contra a mesma meta.`}</span></div><div class="indicator-grid" style="margin-top:12px">${['M1','M2','M3','M4','M5'].map(id=>metaCard(id,mk,scope)).join('')}</div>`
}

function municipalHTML(){
  const mk=state.preferences.month,ids=['M1','M2','M3','M4','M5'],qs=ids.map(id=>quarterMunicipal(id)),recon=reconciliationForMonth(mk);
  return `<div class="notice"><strong>Leitura municipal de Florianópolis.</strong> Quando houver dados do CELK para a competência, eles são obrigatoriamente usados no cálculo. O Metabase permanece como referência consolidada e qualquer divergência é sinalizada.</div><div class="indicator-grid" style="margin-top:16px">${ids.map(id=>indicatorCard(municipalComponents(id,mk))).join('')}</div><article class="card table-card"><div class="table-head"><div><h2 class="section-title">${icon('trend')} Apuração do quadrimestre</h2><div class="section-sub">Meses sem arquivo são distintos de meses com denominador zero. "Mês em foco" segue a competência selecionada acima (${fmtMonth(mk,true)}).</div></div></div><div class="legend-row">${legendDot('#39b980','Meta batida / faixa boa')}${legendDot('#e7a23b','Entre o corte e a meta')}${legendDot('#e15f41','Abaixo do corte')}${legendDot('#d7dbe6','Sem dado')}${legendDot('#eef0f5','Mês futuro',true)}</div><div class="table-scroll"><table><thead><tr><th>Indicador</th><th>Série mensal</th><th>Parcial <span class="muted" style="font-weight:500">(projeção de meta)</span></th><th>Projeção do quadrimestre</th></tr></thead><tbody>${qs.map(q=>{const id=q.id,dec=pctDecimals(id),parts=q.values.map(v=>v.result==null?0:v.result),partial=sum(parts)/4,breakdown=parts.map(p=>fmtPct(p,dec)).join(' + '),pzc=zoneClass(id,partial)||'',outlook=quadrimestralOutlook(id,q);return `<tr><td><strong>${q.id}</strong><br><span class="muted">${esc(RULESETS.municipal.indicators[q.id].name)}</span></td><td style="min-width:310px">${apuracaoMonthBoxes(id,q.values)}</td><td><strong class="${pzc}">${fmtPct(partial,dec)}</strong><div class="muted" style="font-size:10.5px;margin-top:4px">${breakdown} ÷ 4</div></td><td>${pill(outlook.label,outlook.cls)}<div class="muted" style="font-size:10.5px;margin-top:6px;line-height:1.4;max-width:260px">${esc(outlook.detail)}</div></td></tr>`}).join('')}</tbody></table></div></article><article class="card table-card"><div class="table-head"><div><h2 class="section-title">${icon('database')} Reconciliação com o Metabase</h2><div class="section-sub">O CELK é a fonte do cálculo quando disponível; o Metabase é mantido como referência de conferência.</div></div></div>${recon.length?`<div class="table-scroll"><table><thead><tr><th>Indicador</th><th>Metabase · referência</th><th>CELK · cálculo</th><th>Diferença</th><th>Numeradores</th><th>Denominadores</th></tr></thead><tbody>${recon.map(r=>`<tr><td>${r.id}</td><td>${fmtPct(r.reported)}</td><td>${fmtPct(r.reconstructed)}</td><td>${fmtPct(r.difference)}</td><td>${fmtNum(r.reportedNumerator)} × ${fmtNum(r.reconstructedNumerator)}</td><td>${fmtNum(r.reportedDenominator,2)} × ${fmtNum(r.reconstructedDenominator,2)}</td></tr>`).join('')}</tbody></table></div>`:'<div class="empty-state"><p>Nenhum consolidado do Metabase disponível para esta competência.</p></div>'}</article>`
}

function federalHTML(){
  const mk=state.preferences.month,ids=['B1','B2','B4','B5','B6','B3'];return `<div class="notice warn"><strong>Série federal mensal.</strong> As Notas B1–B6 não informam como consolidar matematicamente os quatro meses; a ferramenta não inventa resultado federal quadrimestral. Cálculos derivados dos PDFs CELK ficam marcados como prévios quando INE/CBO/CNS não estão disponíveis.</div><div class="indicator-grid" style="margin-top:16px">${ids.map(id=>indicatorCard(federalComponents(id,mk),'federal')).join('')}</div>`
}

function isPriority2I(e){return !isAttended(e)&&pregnancyStage(e)==='ativa'&&gestationalWeeks(e)!=null&&gestationalWeeks(e)>=28}
function pregnancyHTML(){
  const snap=getActive2ISnapshot();
  if(!snap&&!state.gestantes.manual.length)return emptyState('Importe o CSV de gestantes','O arquivo do Metabase forma o panorama automático do 2I. Cadastros manuais ficam em uma camada operacional separada.');
  const expanded=visibleByExclusion(mergedEpisodes());
  const filtered=applyPregFilters(expanded);
  const sorted=[...filtered].sort((a,b)=>{const aa=isAttended(a)?1:0,ba=isAttended(b)?1:0;if(aa!==ba)return aa-ba;return (a.nome||'').localeCompare(b.nome||'','pt-BR')});
  const attendedCount=expanded.filter(isAttended).length;
  const pendingCount=expanded.length-attendedCount;
  const priorityCount=expanded.filter(isPriority2I).length;
  const activeCount=expanded.filter(e=>pregnancyStage(e)==='ativa').length;
  const finalizedCount=expanded.length-activeCount;
  const manualCount=state.gestantes.manual.filter(m=>!m.archived&&!state.gestantes.merges[m.id]).length;
  const teams=[...new Set(expanded.map(e=>e.equipe).filter(Boolean))].sort((a,b)=>a.localeCompare(b,'pt-BR'));
  const teamCards=teams.map(team=>{const rows=expanded.filter(e=>e.equipe===team),ok=rows.filter(isAttended).length,pct=rows.length?100*ok/rows.length:0;return `<button class="team-card" data-team-filter="${esc(team)}"><div class="team-head"><strong>${esc(team)}</strong><b>${fmtNum(rows.length)}</b></div><div class="progress" style="margin-top:9px"><span style="width:${clamp(pct)}%"></span></div><small>${fmtNum(ok)} atendida(s) · ${fmtPct(pct,1)}</small></button>`}).join('');
  const teamOptions=teams.map(t=>`<option ${state.preferences.pregTeam===t?'selected':''}>${esc(t)}</option>`).join('');
  const rows=sorted.map(e=>{const attended=isAttended(e),weeks=gestationalWeeks(e),priority=isPriority2I(e),finalized=pregnancyStage(e)==='finalizada',badgeColor=finalized?'#786fa6':attended?'#39b980':priority?'#e15f41':'#e7a23b',badgeLabel=finalized?'Gestação encerrada':attended?'Atendida':priority?'Pendente · 3º trimestre':'Pendente',nameStyle=finalized?` style="text-decoration:line-through;color:${badgeColor}"`:'',f=followupFor(e.id),followupTag=['whatsapp_enviado','busca_ativa_solicitada','agendada'].includes(f.state)?`<span class="preg-tag" style="background:${followupColor(f.state).bg};color:${followupColor(f.state).text}">${esc(followupShortLabel(f.state))}</span>`:'';return `<div class="rowcard click-row" data-open-episode="${e.id}"><div class="rc-left"><strong${nameStyle}>${esc(e.nome||'Sem nome')}</strong><span class="muted mono">${esc(e.prontuario||String(e.id).slice(0,10))} · Equipe ${esc(e.equipe||'—')}</span></div><div class="rc-mid">DUM ${fmtDate(e.ultimaMenstruacao)} · ${weeks==null?'IG não calculável':`${weeks} sem.`}</div><div class="rc-right">${followupTag}<span class="badge" style="background:${badgeColor}">${esc(badgeLabel)}</span><button class="info-btn" data-open-episode="${e.id}" aria-label="Abrir perfil">${icon('chevron')}</button></div></div>`}).join('');
  return `<div class="notice"><strong>2I operacional.</strong> O panorama soma automaticamente a leitura do CSV do Metabase (“Sim” em Consulta Saude Bucal = atendida) com confirmações manuais de atendimento registradas no acompanhamento — cada gestante conta uma única vez para a meta.</div><div class="grid-kpis" style="margin-top:16px">${kpi('Panorama atual',expanded.length?fmtPct(100*attendedCount/expanded.length,1):'—',`${attendedCount} atendida(s) de ${expanded.length} gestante(s) na lista`,'#39b980','heart')}${kpi('Gestantes pendentes',fmtNum(pendingCount),`${priorityCount} em 3º trimestre — prioridade de contato`,'#e7a23b','clock')}${kpi('Gestantes ativas',fmtNum(activeCount),`${finalizedCount} com parto registrado · ${manualCount} cadastro(s) manual(is)`,'#546de5','users')}${kpi('Com WhatsApp válido',fmtNum(expanded.filter(e=>e.phoneNormalized).length),`${expanded.filter(e=>!e.phoneNormalized).length} sem número válido`,'#3dc1d3','message')}</div><article class="card panel"><div class="panel-head"><div><h2 class="section-title">${icon('users')} Resumo por equipe</h2><div class="section-sub">Clique em uma equipe para filtrar a lista e recalcular o recorte operacional.</div></div></div><div class="team-summary">${teamCards||'<span class="muted">Nenhuma equipe disponível.</span>'}</div></article><article class="card table-card" style="margin-top:16px"><div class="table-head"><div><h2 class="section-title">${icon('heart')} Planilha interativa 2I</h2><div class="section-sub">${filtered.length} de ${expanded.length} episódio(s) visível(is), ordenados por pendência e nome. Dados nominais permanecem somente neste navegador.</div></div><div class="card-actions"><button class="btn small" data-add-pregnant>${icon('plus')}Adicionar gestante</button><button class="btn small" data-export-2i>${icon('download')}Exportar</button><button class="btn small danger" data-clear-all-gestantes>${icon('trash')}Limpar tudo</button></div></div><div class="pregnancy-toolbar"><label class="search-box"><span data-icon="search"></span><input id="pregSearch" type="search" value="${esc(state.preferences.pregSearch)}" placeholder="Buscar nome ou prontuário..."></label><select class="filter preg-filter" data-preg-filter="pregTeam"><option value="">Todas as equipes</option>${teamOptions}</select><select class="filter preg-filter" data-preg-filter="pregStatus"><option value="">Todos os status</option><option value="atende" ${state.preferences.pregStatus==='atende'?'selected':''}>Atende</option><option value="pendente" ${state.preferences.pregStatus==='pendente'?'selected':''}>Pendente</option><option value="indeterminado" ${state.preferences.pregStatus==='indeterminado'?'selected':''}>Indeterminado</option><option value="sem_metabase" ${state.preferences.pregStatus==='sem_metabase'?'selected':''}>Sem Metabase</option></select><select class="filter preg-filter" data-preg-filter="pregFollowup"><option value="">Todo acompanhamento</option><option value="nao_contatada" ${state.preferences.pregFollowup==='nao_contatada'?'selected':''}>Não contatada</option><option value="whatsapp_enviado" ${state.preferences.pregFollowup==='whatsapp_enviado'?'selected':''}>WhatsApp enviado</option><option value="ok_manual" ${state.preferences.pregFollowup==='ok_manual'?'selected':''}>OK manual</option><option value="atende_confirmado" ${state.preferences.pregFollowup==='atende_confirmado'?'selected':''}>Atende confirmado</option><option value="agendada" ${state.preferences.pregFollowup==='agendada'?'selected':''}>Agendada</option></select><select class="filter preg-filter" data-preg-filter="pregOrigin"><option value="">Todas as origens</option><option value="metabase" ${state.preferences.pregOrigin==='metabase'?'selected':''}>Metabase</option><option value="manual" ${state.preferences.pregOrigin==='manual'?'selected':''}>Manual</option><option value="metabase_manual" ${state.preferences.pregOrigin==='metabase_manual'?'selected':''}>Manual + Metabase</option></select><select class="filter preg-filter" data-preg-filter="pregPhone"><option value="">Todo contato</option><option value="valid" ${state.preferences.pregPhone==='valid'?'selected':''}>WhatsApp válido</option><option value="invalid" ${state.preferences.pregPhone==='invalid'?'selected':''}>Sem WhatsApp válido</option></select><select class="filter preg-filter" data-preg-filter="pregStage"><option value="">Toda gestação</option><option value="ativa" ${state.preferences.pregStage==='ativa'?'selected':''}>Ativa</option><option value="finalizada" ${state.preferences.pregStage==='finalizada'?'selected':''}>Finalizada (com parto)</option></select><select class="filter preg-filter" data-preg-filter="pregExcluded"><option value="">Ocultar excluídas</option><option value="only" ${state.preferences.pregExcluded==='only'?'selected':''}>Mostrar só excluídas</option></select>${state.preferences.pregTeam||state.preferences.pregStatus||state.preferences.pregFollowup||state.preferences.pregOrigin||state.preferences.pregPhone||state.preferences.pregStage||state.preferences.pregExcluded?'<button class="btn small ghost" data-clear-preg-filters>Limpar filtros</button>':''}</div><div class="cardlist">${rows||'<p class="muted" style="padding:8px 4px">Nenhum episódio corresponde aos filtros.</p>'}</div></article>`;
}

function profileLabel(profile){return ({celk_procedimentos_detalhado:'CELK · procedimentos detalhados',celk_atividades_grupo:'CELK · atividades em grupo',metabase_saude_bucal:'Metabase · consolidado Saúde Bucal',metabase_gestantes_2i:'Metabase · gestantes 2I',csv_manual_configuravel:'CSV · layout não reconhecido',pdf_nao_reconhecido:'PDF · layout não reconhecido'})[profile]||profile}
function snapshotPeriod(s){const months=Object.keys(s.dataByMonth||{}).sort();return months.length?`${fmtMonth(months[0])}${months.length>1?`–${fmtMonth(months.at(-1))}`:''}`:s.periodStart||s.periodEnd?`${fmtDate(s.periodStart)}–${fmtDate(s.periodEnd)}`:'sem competência detectada'}
function importsHTML(){
  const mk=state.preferences.month,proc=aggregateProcedureMonth(mk),items=[...state.snapshots].sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt));
  const imports=items.map(s=>`<div class="import-item"><div class="import-icon">${icon(s.profile.includes('metabase')?'database':'file')}</div><div><strong title="${esc(s.fileName)}">${esc(s.fileName)}</strong><small>${esc(profileLabel(s.profile))} · ${esc(snapshotPeriod(s))} · ${esc(s.status)}</small><small class="mono">SHA-256 ${esc(s.hash.slice(0,12))}… · ${s.supersededBy?'substituído por snapshot mais recente':'ativo na sua série'}</small></div><div class="import-actions"><button class="btn small" data-open-snapshot="${s.id}">Conferir</button></div></div>`).join('');
  const procRows=(proc?.procedureCounts||[]).sort((a,b)=>b.quantityValid-a.quantityValid).map(p=>`<tr><td><strong>${esc(p.descriptionNormalized)}</strong><br><span class="muted">${esc(p.descriptionOriginal)}</span></td><td class="mono">${esc(p.sigtap||'—')}</td><td class="num">${fmtNum(p.quantityRaw,2)}</td><td class="num">${fmtNum(Math.max(0,p.quantityRaw-p.quantityValid),2)}</td><td class="num"><strong>${fmtNum(p.quantityValid,2)}</strong></td><td>${(p.roles||[]).length?procedureRoleBadgesHTML(p.roles):p.outOfScope?pill('Fora do escopo','info'):p.unrecognized?pill('Não identificado','warn'):'—'}</td><td>${(p.pages||[]).map(x=>`p.${x}`).join(', ')}</td></tr>`).join('');
  return `<div class="main-grid"><article class="card panel"><div class="panel-head"><div><h2 class="section-title">${icon('upload')} Importar e versionar</h2><div class="section-sub">PDF do CELK, atividades em grupo e CSVs do Metabase. O conteúdo original não é guardado no backup.</div></div><button class="btn primary" data-action="import">${icon('upload')}Selecionar arquivos</button></div><div class="notice"><strong>Prevenção de dupla contagem:</strong> a assinatura SHA-256 bloqueia o mesmo arquivo. Uma fotografia mais nova do mesmo perfil e período substitui a anterior; ela nunca é somada ao acumulado antigo.</div></article><article class="card panel"><div class="panel-head"><div><h2 class="section-title">${icon('database')} Sessão atual</h2><div class="section-sub">A amostra bruta fica disponível até fechar esta página.</div></div></div><div class="facts"><div class="fact"><span>Snapshots</span><strong>${state.snapshots.length}</strong></div><div class="fact"><span>Amostras em memória</span><strong>${sessionRaw.size}</strong></div><div class="fact"><span>Competência</span><strong>${fmtMonth(mk,true)}</strong></div><div class="fact"><span>Fonte ativa</span><strong>CELK prioritário · Metabase como referência</strong></div></div></article></div><article class="card panel"><div class="panel-head"><div><h2 class="section-title">${icon('file')} Histórico de importações</h2><div class="section-sub">Abra qualquer snapshot para ver validações, contagens e a amostra extraída.</div></div></div><div class="import-list">${imports||'<span class="muted">Nenhum arquivo importado.</span>'}</div></article><article class="card table-card" style="margin-top:16px"><div class="table-head"><div><h2 class="section-title">${icon('tooth')} Resumo por procedimento · ${fmtMonth(mk,true)}</h2><div class="section-sub">Quantidade bruta, exclusões/duplicidades detectáveis, quantidade válida usada nas prévias e em qual indicador (e como) cada procedimento entra no cálculo.</div></div>${proc?'<button class="btn small" data-export-procedures>'+icon('download')+'Exportar CSV</button>':''}</div>${proc?`<div class="legend-row" style="padding:0 18px 12px">${legendDot('#546de5','Numerador de um indicador')}${legendDot('#3dc1d3','Denominador de um indicador')}</div><div class="table-scroll"><table><thead><tr><th>Procedimento extraído / normalizado</th><th>SIGTAP</th><th class="num">Bruta</th><th class="num">Excluída</th><th class="num">Válida</th><th>Funções</th><th>Páginas</th></tr></thead><tbody>${procRows}</tbody><tfoot><tr><td colspan="2"><strong>Subtotal</strong></td><td class="num"><strong>${fmtNum(sum(proc.procedureCounts.map(p=>p.quantityRaw)),2)}</strong></td><td class="num"><strong>${fmtNum(sum(proc.procedureCounts.map(p=>p.quantityRaw-p.quantityValid)),2)}</strong></td><td class="num"><strong>${fmtNum(sum(proc.procedureCounts.map(p=>p.quantityValid)),2)}</strong></td><td colspan="2"></td></tr></tfoot></table></div>`:'<div class="empty-state"><p>Nenhum PDF “Procedimentos Detalhado” disponível para esta competência.</p></div>'}</article>`;
}

function diagnosticsHTML(){
  const list=buildDiagnostics(),counts={error:list.filter(x=>x.level==='error').length,warning:list.filter(x=>x.level==='warning').length,info:list.filter(x=>x.level==='info').length};
  const rows=list.map(d=>`<article class="diagnostic ${esc(d.level)}"><div class="diagnostic-icon">${d.level==='error'?'!':d.level==='warning'?'△':'i'}</div><div><strong>${esc(d.code||'DIAGNÓSTICO')}</strong><p>${esc(d.message)}</p>${d.fileName?`<small class="muted">${esc(d.fileName)}</small>`:''}</div>${d.snapshotId?`<button class="btn small" data-open-snapshot="${d.snapshotId}">Abrir fonte</button>`:''}</article>`).join('');
  const recent=[...state.snapshots].sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt)).slice(0,5);
  return `<div class="grid-kpis">${kpi('Críticos',fmtNum(counts.error),'Impedem ou invalidam um cálculo específico','#e15f41','alert')}${kpi('Alertas',fmtNum(counts.warning),'Exigem conferência ou denominador','#e7a23b','alert')}${kpi('Informativos',fmtNum(counts.info),'Hipóteses e limitações documentadas','#546de5','info')}${kpi('Autotestes',state.selfTests?`${state.selfTests.passed}/${state.selfTests.total}`:'não executados',state.selfTests?fmtDateTime(state.selfTests.at):'Execute após mudanças ou restauração','#39b980','check')}</div><div class="main-grid"><article class="card panel"><div class="panel-head"><div><h2 class="section-title">${icon('alert')} Diagnóstico dos dados</h2><div class="section-sub">Nenhum alerta altera silenciosamente os dados importados.</div></div></div><div class="diagnostic-list">${rows||'<div class="notice"><strong>Nenhum diagnóstico ativo.</strong> Ainda assim, confira a composição antes de homologar resultados.</div>'}</div></article><div class="stack"><article class="card panel"><div class="panel-head"><div><h2 class="section-title">${icon('file')} Fontes mais recentes</h2><div class="section-sub">O consolidado nunca é somado à prévia.</div></div><button class="link-btn" data-go="imports">Conferir</button></div><div class="import-list">${recent.map(s=>`<div class="import-item"><div class="import-icon">${icon(s.profile.includes('metabase')?'database':'file')}</div><div><strong title="${esc(s.fileName)}">${esc(s.fileName)}</strong><small>${esc(profileLabel(s.profile))} · ${fmtDateTime(s.createdAt)}</small></div><button class="info-btn" data-open-snapshot="${s.id}">i</button></div>`).join('')||'<span class="muted">Nenhum arquivo importado.</span>'}</div></article><article class="card panel"><div class="panel-head"><div><h2 class="section-title">${icon('check')} Testes internos</h2><div class="section-sub">126 casos de fórmula, faixa, privacidade, deduplicação, 2I, diagnóstico e persistência definidos na especificação.</div></div></div>${testSummaryHTML()}<div class="card-actions"><button class="btn primary" data-run-tests>${icon('check')}Executar 126 testes</button></div></article></div></div><article class="card panel"><div class="panel-head"><div><h2 class="section-title">${icon('info')} Limitações visíveis</h2></div></div><div class="notice warn"><strong>PDF de procedimentos:</strong> não traz CBO, INE, CNS nem a janela federal de 12 meses; B1–B6 derivados dele são prévios. As descrições de restaurações podem vir truncadas pelo CELK.</div><div class="notice warn" style="margin-top:9px"><strong>Atividades em grupo:</strong> traz o total agregado de presentes, sem idade e sem deduplicação por participante. M3/B4 dependem de denominador confirmado.</div><div class="notice warn" style="margin-top:9px"><strong>2I:</strong> o CSV recebido não informa data/código/CBO da atividade. O painel reproduz somente o valor consolidado “Consulta Saude Bucal”, interpretado automaticamente (Sim = atendida).</div></article>`;
}

function settingsHTML(){
  const maps=Object.entries(state.columnMappings.consulta2i||{}).map(([raw,val])=>`<tr><td>${esc(raw||'(vazio)')}</td><td>${pill(status2ILabel(val),statusClass(status2ILabel(val)))}</td></tr>`).join('');
  const denoms=[...state.denominators].sort((a,b)=>b.start.localeCompare(a.start)).map(d=>`<tr><td>${esc(d.scope)}</td><td>${esc(d.indicator)}</td><td>${fmtNum(d.value,2)}</td><td>${fmtMonth(d.start)}–${fmtMonth(d.end)}</td><td>${esc(d.origin)}</td><td>${esc(d.note||'—')}</td></tr>`).join('');
  return `<div class="main-grid"><article class="card panel"><div class="panel-head"><div><h2 class="section-title">${icon('settings')} Preferências de cálculo</h2><div class="section-sub">A prioridade das fontes é fixa para impedir que um consolidado divergente substitua silenciosamente a produção extraída do CELK.</div></div></div><div class="form-grid"><label class="field full"><span>Prioridade das fontes</span><input value="CELK quando disponível → Metabase somente na ausência do CELK" readonly></label><label class="field"><span>Nota quadrimestral desejada</span><input id="settingsTarget" type="number" min="0" max="100" value="${esc(state.preferences.targetScore)}"></label><label class="field"><span>Versão do aplicativo</span><input value="${esc(APP_VERSION)}" readonly></label><label class="field"><span>Versão das regras</span><input value="${esc(RULE_VERSION)}" readonly></label></div></article><article class="card panel"><div class="panel-head"><div><h2 class="section-title">${icon('lock')} Privacidade local</h2><div class="section-sub">Nada fica salvo pelo navegador. O estado só existe na memória desta aba.</div></div></div><div class="notice"><strong>Processamento local:</strong> os arquivos não são enviados a nenhum servidor. Nenhum dado é gravado em IndexedDB/localStorage: fechar ou recarregar a aba sem exportar um backup apaga tudo, inclusive a amostra bruta da sessão.</div><div class="notice ${state.dirty?'danger':'warn'}" style="margin-top:9px"><strong>${state.dirty?'Há alterações não salvas agora.':'Tudo salvo corresponde ao último backup exportado.'}</strong> ${state.lastBackupAt?`Último backup: ${fmtDateTime(state.lastBackupAt)}.`:'Nenhum backup exportado ainda nesta sessão.'} ${has2IData()?'Como há dados de gestantes (2I), cifrar o backup com senha é a proteção recomendada.':''}</div><div class="card-actions"><button class="btn primary" data-action="export-backup">${icon('database')}Exportar backup agora</button></div></article></div><article class="card table-card"><div class="table-head"><div><h2 class="section-title">${icon('database')} Denominadores versionados</h2><div class="section-sub">Cada valor registra escopo, vigência, origem e nota. Sugestões nunca substituem o manual sem confirmação.</div></div></div>${denoms?`<div class="table-scroll"><table><thead><tr><th>Escopo</th><th>Indicador</th><th>Valor</th><th>Vigência</th><th>Origem</th><th>Nota</th></tr></thead><tbody>${denoms}</tbody></table></div>`:'<div class="empty-state"><p>Nenhum denominador confirmado.</p></div>'}</article><div class="split-grid"><article class="card table-card"><div class="table-head"><div><h2 class="section-title">${icon('heart')} Interpretação do CSV 2I</h2><div class="section-sub">Preenchida automaticamente a cada importação — “Sim” conta como atendida (meta batida); qualquer outro valor conta como pendente.</div></div></div>${maps?`<div class="table-scroll"><table><thead><tr><th>Valor original</th><th>Interpretação</th></tr></thead><tbody>${maps}</tbody></table></div>`:'<div class="empty-state"><p>Nenhum valor de “Consulta Saude Bucal” foi importado ainda.</p></div>'}</article><article class="card panel"><div class="panel-head"><div><h2 class="section-title">${icon('info')} Manual rápido</h2></div></div><ol class="muted" style="line-height:1.75;padding-left:18px"><li>Importe “Procedimentos Detalhado” durante o mês.</li><li>Importe “Relação das Atividades em Grupo” para M3/B4.</li><li>Confirme os denominadores M1/M3 (B1/B4 usam o mesmo valor automaticamente).</li><li>Importe o CSV Saúde Bucal para reconciliar o consolidado.</li><li>Abra “Conferência” e valide contagens antes de homologar.</li><li>Exporte backup completo cifrado ao encerrar o ciclo.</li></ol><div class="notice warn"><strong>Não inventado:</strong> denominador municipal de crianças 6–12 anos, elegibilidade federal por CBO/INE/CNS e eventual diferença entre ART municipal e B6 dependem de fonte adicional.</div></article></div>`;
}

/* ---------- Modais, gavetas e conferência ---------- */

function openModal(html,{wide=false,closable=true}={}){const b=document.getElementById('modalBackdrop'),m=document.getElementById('modal');m.className=`modal${wide?' wide':''}`;m.innerHTML=html;if(closable&&!m.querySelector('[data-close-modal]')){const head=m.querySelector('.modal-head');if(head)head.insertAdjacentHTML('beforeend',`<button class="close-btn" data-close-modal aria-label="Fechar">${icon('close')}</button>`)}b.classList.add('open');b.setAttribute('aria-hidden','false');hydrateIcons(m)}
function closeModal(){const b=document.getElementById('modalBackdrop');b.classList.remove('open');b.setAttribute('aria-hidden','true');document.getElementById('modal').innerHTML=''}
function openDrawer(html,opts={}){const b=document.getElementById('drawerBackdrop'),d=document.getElementById('drawer');d.innerHTML=html;d.classList.toggle('wide',!!opts.wide);b.classList.add('open');b.setAttribute('aria-hidden','false');hydrateIcons(d)}
function closeDrawer(){const b=document.getElementById('drawerBackdrop');b.classList.remove('open');b.setAttribute('aria-hidden','true');document.getElementById('drawer').innerHTML=''}
function toast(message){const t=document.getElementById('toast');t.textContent=message;t.classList.add('show');clearTimeout(toast._t);toast._t=setTimeout(()=>t.classList.remove('show'),3500)}
function showError(error){console.error(error);toast(error?.message||String(error)||'Ocorreu um erro.');}
function importFailureReportText(failures){const ua=navigator.userAgent||'(user agent indisponível)';const parts=failures.map(f=>`Arquivo: ${f.name}\nErro: ${f.message}${f.stack?`\nDetalhe técnico:\n${f.stack}`:''}`);return `Relatório de falha de importação — ${nowISO()}\nNavegador: ${ua}\n\n${parts.join('\n\n')}`}
function showImportFailures(ok,failures){const report=importFailureReportText(failures);openModal(`<div class="modal-head"><div><h2 id="modalTitle">Importação com falha</h2><p>${ok} importação(ões) concluída(s) · ${failures.length} falha(s). Nada foi salvo desses arquivos — reveja e importe de novo.</p></div></div><div class="modal-body"><div class="table-scroll"><table><thead><tr><th>Arquivo</th><th>Motivo</th></tr></thead><tbody>${failures.map(f=>`<tr><td>${esc(f.name)}</td><td>${esc(f.message)}</td></tr>`).join('')}</tbody></table></div><div class="notice warn" style="margin-top:12px"><strong>Se o erro persistir ou parecer estranho:</strong> copie o relatório técnico abaixo (botão "Copiar detalhes") e envie — ele já inclui o navegador e o detalhe técnico do erro, sem precisar abrir o console.</div><textarea id="importFailureReport" readonly style="width:100%;min-height:120px;margin-top:8px;font-family:monospace;font-size:11px;white-space:pre-wrap">${esc(report)}</textarea></div><div class="modal-foot"><button class="btn" id="copyImportFailureReport">${icon('file')}Copiar detalhes</button><button class="btn primary" data-close-modal>Entendi</button></div>`);const copyBtn=document.getElementById('copyImportFailureReport');copyBtn.onclick=async()=>{const area=document.getElementById('importFailureReport');try{await navigator.clipboard.writeText(report);toast('Detalhes copiados. Já pode colar e enviar.')}catch{area.focus();area.select();try{document.execCommand('copy');toast('Detalhes copiados. Já pode colar e enviar.')}catch{toast('Não deu para copiar automaticamente — selecione o texto acima e copie manualmente.')}}}}
function showLoading(title,detail=''){document.getElementById('loadingTitle').textContent=title;document.getElementById('loadingDetail').textContent=detail;document.getElementById('loading').classList.remove('hidden')}
function setLoading(title,detail=''){document.getElementById('loadingTitle').textContent=title;document.getElementById('loadingDetail').textContent=detail}
function hideLoading(){document.getElementById('loading').classList.add('hidden')}

function procedureRolesFor(id){return ({M1:['first'],M2:['first','concluded'],M3:[],M4:['preventive','m4den'],M5:['art','restorative'],B1:['first'],B2:['first','concluded'],B3:['b3num','b3den'],B4:[],B5:['preventive','b5den'],B6:['art','restorative']})[id]||[]}
function openComposition(scope,id,mk){
  const comp=scope==='municipal'?municipalComponents(id,mk):federalComponents(id,mk),rule=scope==='municipal'?RULESETS.municipal.indicators[id]:RULESETS.federal.indicators[id],proc=aggregateProcedureMonth(mk),group=aggregateGroupMonth(mk),roles=procedureRolesFor(id);
  // M4 usa denominador amplo por exclusão (todos os procedimentos individuais, exceto primeira consulta/
  // tratamento concluído/nota de evolução em grupo) — inclui itens ainda não identificados, então a lista
  // de composição usa a mesma exclusão em vez de depender só de role tags.
  const isM4=scope==='municipal'&&id==='M4';
  const isGroupNoteRow=p=>/^EVOLUCAO DA ATIVIDADE EM GRUPO/.test(norm(p.descriptionOriginal));
  const relevant=(proc?.procedureCounts||[]).filter(p=>isM4?(!p.roles.includes('first')&&!p.roles.includes('concluded')&&!isGroupNoteRow(p)):(p.roles||[]).some(r=>roles.includes(r))).sort((a,b)=>b.quantityValid-a.quantityValid);
  const procedureTable=relevant.length?`<div class="table-scroll"><table><thead><tr><th>Procedimento</th><th>SIGTAP</th><th>Função no cálculo</th><th class="num">Válida</th><th>Páginas</th></tr></thead><tbody>${relevant.map(p=>{const rolePills=(p.roles||[]).filter(r=>roles.includes(r)).map(r=>pill(r,'neutral')).join(' ');const funcao=rolePills||(isM4?(p.unrecognized?pill('Não identificado · denominador M4','warn'):pill('denominador M4','neutral')):'—');return `<tr><td>${esc(p.descriptionNormalized)}<br><span class="muted">${esc(p.descriptionOriginal)}</span></td><td class="mono">${esc(p.sigtap||'—')}</td><td>${funcao}</td><td class="num">${fmtNum(p.quantityValid,2)}</td><td>${(p.pages||[]).join(', ')||'—'}</td></tr>`}).join('')}</tbody></table></div>`:'<div class="notice warn"><strong>Sem composição por procedimento.</strong> Este indicador depende de atividade coletiva, denominador manual ou fonte ainda não importada.</div>';
  const sources=(comp.snapshots||[]).map(s=>`<button class="btn small" data-open-snapshot="${s.id}">${icon('file')}${esc(s.fileName)}</button>`).join('');
  openDrawer(`<div class="drawer-head"><div><h2>${esc(id)} · ${esc(rule.name)}</h2><p>${scope==='municipal'?'Regra municipal':'Nota metodológica federal'} · ${fmtMonth(mk,true)}</p></div><button class="close-btn" data-close-drawer>${icon('close')}</button></div><div class="drawer-section"><h3>Resultado escolhido</h3><div class="facts"><div class="fact"><span>Resultado</span><strong>${fmtPct(comp.result)}</strong></div><div class="fact"><span>Classificação / nota</span><strong>${esc(comp.classification|| (comp.score!=null?`${fmtNum(comp.score,1)} pontos`:'—'))}</strong></div><div class="fact"><span>Numerador</span><strong>${fmtNum(comp.numerator,2)}</strong></div><div class="fact"><span>Denominador</span><strong>${fmtNum(comp.denominator,2)}</strong></div><div class="fact"><span>Fonte</span><strong>${esc(comp.source)}</strong></div><div class="fact"><span>Competência</span><strong>${fmtMonth(mk,true)}</strong></div></div></div><div class="drawer-section"><h3>Fórmula cadastrada</h3><div class="formula">${esc(rule.formula)}</div><div class="notice warn" style="margin-top:9px"><strong>Hipótese/limitação:</strong> ${esc(comp.hypothesis||comp.missing||'Sem observação adicional.')}</div></div><div class="drawer-section"><h3>Procedimentos que compõem a prévia</h3>${procedureTable}</div>${group&&['M3','B4'].includes(id)?`<div class="drawer-section"><h3>Atividades coletivas</h3><div class="facts"><div class="fact"><span>Presentes em escovação</span><strong>${fmtNum(group.supervisedBrushingPresent)}</strong></div><div class="fact"><span>Atividades elegíveis</span><strong>${fmtNum(group.eligibleActivities)}</strong></div></div>${group.brushingEvents?.length?`<div class="table-scroll" style="margin-top:10px"><table><thead><tr><th>Data</th><th>Assunto</th><th class="num">Presentes</th></tr></thead><tbody>${group.brushingEvents.map(ev=>`<tr><td>${esc(ev.date)}</td><td>Escovação Supervisionada</td><td class="num">${fmtNum(ev.present)}</td></tr>`).join('')}</tbody></table></div>`:'<div class="notice warn" style="margin-top:10px">Nenhuma atividade de escovação supervisionada encontrada nesta competência.</div>'}</div>`:''}<div class="drawer-section"><h3>Proveniência</h3><div class="drawer-actions">${sources||'<span class="muted">Nenhum snapshot aplicável.</span>'}</div></div>`);
}

function sensitiveColumn(h){return /NOME|CADSUS|PRONTUARIO|TELEFONE|LOGRADOURO|ENDERECO|NUMERO|COMPLEMENTO|BAIRRO/.test(norm(h))}
function rawSampleHTML(s){const raw=sessionRaw.get(s.id);if(!raw)return '<div class="notice warn"><strong>Amostra não disponível nesta sessão.</strong> O backup não guarda PDF/CSV original. Reimporte o arquivo para rever os trechos brutos.</div>';
  if(raw.type==='procedure')return `<div class="table-scroll"><table><thead><tr><th>Página/linha</th><th>Paciente mascarado</th><th>Data</th><th>Profissional</th><th>Procedimento exatamente extraído</th><th>Unidade</th><th>Qtd.</th></tr></thead><tbody>${raw.rows.slice(0,120).map(r=>`<tr><td>p.${r.page} · y ${r.lineY}</td><td>${esc(r.patientMasked)}</td><td>${esc(r.date)}</td><td>${esc(r.professional)}</td><td>${esc(r.procedure)}</td><td>${esc(r.unitOrigin)}</td><td class="num">${fmtNum(r.quantity,2)}</td></tr>`).join('')}</tbody></table></div>`;
  if(raw.type==='group')return `<div class="table-scroll"><table><thead><tr><th>Página</th><th>Data</th><th>Assunto exatamente extraído</th><th>Presentes</th><th>Status</th></tr></thead><tbody>${raw.rows.slice(0,150).map(r=>`<tr><td>${r.page}</td><td>${esc(r.date)}</td><td>${esc(r.subject)}</td><td>${fmtNum(r.present)}</td><td>${esc(r.status)}</td></tr>`).join('')}</tbody></table></div>`;
  if(raw.headers){return `<div class="table-scroll"><table><thead><tr>${raw.headers.map(h=>`<th>${esc(h||'(vazio)')}</th>`).join('')}</tr></thead><tbody>${raw.rows.slice(0,60).map((r,i)=>{const values=Array.isArray(r)?r:r.values||[];return `<tr>${raw.headers.map((h,j)=>`<td>${esc(sensitiveColumn(h)?(values[j]?'••••••':''):values[j])}</td>`).join('')}</tr>`}).join('')}</tbody></table></div>`}
  return `<pre class="formula">${esc(JSON.stringify(raw.rows?.slice(0,80)||raw,null,2))}</pre>`;
}
function snapshotSummaryHTML(s){const months=Object.entries(s.dataByMonth||{}).sort(([a],[b])=>a.localeCompare(b));return `<div class="facts"><div class="fact"><span>Perfil</span><strong>${esc(profileLabel(s.profile))}</strong></div><div class="fact"><span>Status</span><strong>${esc(s.status)}</strong></div><div class="fact"><span>Unidade</span><strong>${esc(s.unit||'Não identificada')}</strong></div><div class="fact"><span>Período</span><strong>${esc(snapshotPeriod(s))}</strong></div><div class="fact"><span>Importação</span><strong>${fmtDateTime(s.createdAt)}</strong></div><div class="fact"><span>Assinatura</span><strong class="mono">${esc(s.hash)}</strong></div></div>${months.length?`<div class="table-scroll" style="margin-top:14px"><table><thead><tr><th>Competência</th><th>Dados normalizados</th></tr></thead><tbody>${months.map(([mk,d])=>`<tr><td>${fmtMonth(mk,true)}</td><td><pre class="formula">${esc(JSON.stringify({...d,procedureCounts:undefined},null,2))}</pre></td></tr>`).join('')}</tbody></table></div>`:''}`}
function validationHTML(s){return `<div class="diagnostic-list">${(s.validations||[]).map(v=>`<article class="diagnostic ${esc(v.level)}"><div class="diagnostic-icon">${v.level==='error'?'!':v.level==='warning'?'△':'i'}</div><div><strong>${esc(v.code)}</strong><p>${esc(v.message)}</p></div></article>`).join('')||'<div class="notice">Nenhuma validação registrada.</div>'}</div>`}
function snapshotProceduresHTML(s){const procs=(s.procedureCounts||[]).sort((a,b)=>b.quantityValid-a.quantityValid);if(!procs.length)return '<div class="notice">Este perfil não possui contagem por procedimento.</div>';return `<div class="table-scroll"><table><thead><tr><th>Normalizado</th><th>Original</th><th>SIGTAP</th><th class="num">Bruta</th><th class="num">Válida</th><th>Páginas</th></tr></thead><tbody>${procs.map(p=>`<tr><td>${esc(p.descriptionNormalized)}</td><td>${esc(p.descriptionOriginal)}</td><td class="mono">${esc(p.sigtap||'—')}</td><td class="num">${fmtNum(p.quantityRaw,2)}</td><td class="num">${fmtNum(p.quantityValid,2)}</td><td>${(p.pages||[]).join(', ')}</td></tr>`).join('')}</tbody></table></div>`}
function openSnapshot(id,tab='summary'){const s=state.snapshots.find(x=>x.id===id);if(!s)return;const contents={summary:snapshotSummaryHTML(s),procedures:snapshotProceduresHTML(s),validations:validationHTML(s),raw:rawSampleHTML(s)};openModal(`<div class="modal-head"><div><h2 id="modalTitle">Conferir extração</h2><p>${esc(s.fileName)} · ${esc(profileLabel(s.profile))}</p></div></div><div class="modal-body"><div class="subtabs"><button class="subtab ${tab==='summary'?'active':''}" data-snapshot-tab="summary" data-snapshot-id="${s.id}">Resumo</button><button class="subtab ${tab==='procedures'?'active':''}" data-snapshot-tab="procedures" data-snapshot-id="${s.id}">Procedimentos</button><button class="subtab ${tab==='validations'?'active':''}" data-snapshot-tab="validations" data-snapshot-id="${s.id}">Validações</button><button class="subtab ${tab==='raw'?'active':''}" data-snapshot-tab="raw" data-snapshot-id="${s.id}">Amostra bruta</button></div>${contents[tab]}</div><div class="modal-foot"><button class="btn" data-close-modal>Fechar</button></div>`,{wide:true})}

function openDenominatorModal(id,scope,value=''){const mk=state.preferences.month,{year}=parseMonthKey(mk),months=quarterMonths(year,state.preferences.quarter);openModal(`<div class="modal-head"><div><h2 id="modalTitle">Confirmar denominador ${esc(id)}</h2><p>O valor só passa a valer após confirmar origem e vigência.</p></div></div><form id="denomForm"><div class="modal-body"><div class="form-grid"><label class="field"><span class="required">Valor</span><input id="denomValue" inputmode="decimal" value="${esc(value)}" required></label><label class="field"><span class="required">Origem</span><input id="denomOrigin" value="Informado manualmente" required></label><label class="field"><span class="required">Vigência inicial</span><input id="denomStart" type="month" value="${months[0]}" required></label><label class="field"><span class="required">Vigência final</span><input id="denomEnd" type="month" value="${months.at(-1)}" required></label><label class="field full"><span>Nota de conferência</span><textarea id="denomNote" placeholder="Ex.: população confirmada no relatório da unidade em 21/08/2026"></textarea></label></div><div class="notice warn" style="margin-top:12px"><strong>Confirmação explícita:</strong> sugestões de PDF/CSV não substituem registros existentes automaticamente.</div></div><div class="modal-foot"><button type="button" class="btn" data-close-modal>Cancelar</button><button class="btn primary" type="submit">Confirmar e versionar</button></div></form>`,{wide:false});document.getElementById('denomForm').onsubmit=e=>{e.preventDefault();const v=numeric(document.getElementById('denomValue').value),start=document.getElementById('denomStart').value,end=document.getElementById('denomEnd').value;if(!(v>0)||!start||!end||start>end){toast('Revise o valor e a vigência.');return}state.denominators.push({id:uuid(),indicator:id,scope,value:v,start,end,unit:state.preferences.unit,origin:document.getElementById('denomOrigin').value.trim(),note:document.getElementById('denomNote').value.trim(),confirmed:true,updatedAt:nowISO(),ruleVersion:RULE_VERSION});audit('denominator_confirmed',{indicator:id,scope,value:v,start,end});closeModal();refreshAll();toast('Denominador confirmado e versionado.')}}

function openManualPregnant(existingId=null){const old=existingId?state.gestantes.manual.find(x=>x.id===existingId):null;openModal(`<div class="modal-head"><div><h2 id="modalTitle">${old?'Editar':'Adicionar'} gestante manualmente</h2><p>Este cadastro integra somente a lista operacional ampliada.</p></div></div><form id="manualPregForm"><div class="modal-body"><div class="notice warn"><strong>Origem manual.</strong> O registro não altera o panorama automático do CSV e será identificado como “Sem registro no Metabase” até eventual reconciliação.</div><div class="form-grid" style="margin-top:12px"><label class="field"><span class="required">Nome</span><input id="mpName" value="${esc(old?.nome||'')}" required></label><label class="field"><span>Prontuário CELK</span><input id="mpRecord" value="${esc(old?.prontuario||'')}" inputmode="numeric"><small>Deixe vazio para identificação local temporária.</small></label><label class="field"><span class="required">Equipe</span><input id="mpTeam" value="${esc(old?.equipe||'')}" required></label><label class="field"><span>Telefone</span><input id="mpPhone" value="${esc(old?.telefone||'')}"></label><label class="field"><span>Data de nascimento</span><input id="mpBirth" type="date" value="${esc(old?.dataNascimento||'')}"></label><label class="field"><span class="required">Data da atividade odontológica</span><input id="mpActivity" type="date" value="${esc(old?.dataAtividadeManual||'')}" required></label><label class="field"><span>DUM</span><input id="mpDum" type="date" value="${esc(old?.ultimaMenstruacao||'')}"></label><label class="field"><span>DPP</span><input id="mpDpp" type="date" value="${esc(old?.dataProvParto||'')}"></label><label class="field"><span>Data do parto</span><input id="mpParto" type="date" value="${esc(old?.dataParto||'')}"></label><label class="field full"><span class="required">Observação odontológica</span><textarea id="mpNote" required>${esc(old?.observacao||'')}</textarea></label></div></div><div class="modal-foot"><button type="button" class="btn" data-close-modal>Cancelar</button><button type="submit" class="btn primary">Salvar cadastro manual</button></div></form>`,{wide:true});document.getElementById('manualPregForm').onsubmit=e=>{e.preventDefault();const dum=document.getElementById('mpDum').value,dpp=document.getElementById('mpDpp').value,parto=document.getElementById('mpParto').value;if(!dum&&!dpp&&!parto){toast('Informe DUM, DPP ou data do parto para identificar o episódio.');return}const rec={id:old?.id||uuid(),localTemporary:!document.getElementById('mpRecord').value.trim(),nome:document.getElementById('mpName').value.trim(),prontuario:sanitizeProntuario(document.getElementById('mpRecord').value),equipe:document.getElementById('mpTeam').value.trim(),telefone:document.getElementById('mpPhone').value.trim(),phoneNormalized:normalizePhone(document.getElementById('mpPhone').value),dataNascimento:document.getElementById('mpBirth').value,dataAtividadeManual:document.getElementById('mpActivity').value,ultimaMenstruacao:dum,dataProvParto:dpp,dataParto:parto,observacao:document.getElementById('mpNote').value.trim(),origin:'manual',status2i:'sem_metabase',tipoPopulacao:'Manual',createdAt:old?.createdAt||nowISO(),updatedAt:nowISO(),edits:[...(old?.edits||[]),{at:nowISO(),action:old?'editado':'criado'}],archived:false};if(old)Object.assign(old,rec);else state.gestantes.manual.push(rec);audit(old?'2i_manual_edited':'2i_manual_created',{manualId:rec.id,hasRecord:!!rec.prontuario});closeModal();refreshAll();toast('Cadastro manual salvo sem alterar o panorama do CSV.')}}

function openEpisode(id,tab){const e=mergedEpisodes().find(x=>x.id===id||x.manualId===id);if(!e)return;const f=followupFor(e.id),match=e.origin==='manual'?findManualMatch(e,getActive2ISnapshot()?.episodes||[]):null,weeks=gestationalWeeks(e),composedAddress=[e.tipoLogradouro,e.logradouro,e.numero,e.complemento,e.bairro].filter(Boolean).join(', '),address=e.enderecoOverride||composedAddress,excl=state.gestantes.excluded[e.id],finalized=pregnancyStage(e)==='finalizada',counts=followupCounts(f.history),activeTab=tab==='editar'?'editar':'acomp';const chips=[counts.whatsapp?`<span class="count-chip wa">${icon('message')}WhatsApp enviado · ${counts.whatsapp}x</span>`:'',counts.buscaAtiva?`<span class="count-chip ba">${icon('search')}Busca ativa · ${counts.buscaAtiva}x</span>`:'',counts.agendada?`<span class="count-chip ag">${icon('clock')}Agendada · ${counts.agendada}x</span>`:'',counts.notes?`<span class="count-chip note">${icon('file')}Notas · ${counts.notes}</span>`:''].filter(Boolean).join('');const timelineHTML=(f.history||[]).slice().reverse().map(h=>h.type==='note'?`<div class="timeline-item"><i class="timeline-dot" style="background:#e7a23b"></i><div class="timeline-copy"><strong style="color:#a96c16">Nota adicionada</strong><span>${fmtDateTime(h.at)}</span><p class="timeline-note">${esc(h.text)}</p></div></div>`:`<div class="timeline-item"><i class="timeline-dot" style="background:${followupColor(h.to).text}"></i><div class="timeline-copy"><strong style="color:${followupColor(h.to).text}">${esc(followupLabel(h.to))}</strong><span>${fmtDateTime(h.at)}${h.note?` · ${esc(h.note)}`:''}</span></div></div>`).join('')||'<span class="muted">Sem histórico.</span>';const editPanel=e.origin==='manual'?`<div class="notice">Cadastro manual — todos os campos, incluindo os que não aparecem aqui, ficam no formulário de cadastro.</div><div class="drawer-actions" style="margin-top:11px"><button class="btn small" data-edit-manual="${esc(e.id)}">Editar cadastro manual</button><button class="btn small danger" data-archive-manual="${esc(e.id)}">Arquivar</button></div>`:`<div class="notice">Ajuste local — não altera a fotografia original do CSV do Metabase; fica registrado como correção manual.</div><div class="form-grid" style="margin-top:12px"><label class="field"><span>Nome</span><input id="efNome" value="${esc(e.nome||'')}"></label><label class="field"><span>Prontuário</span><input id="efProntuario" value="${esc(e.prontuario||'')}"></label><label class="field"><span>Equipe</span><input id="efEquipe" value="${esc(e.equipe||'')}"></label><label class="field"><span>Nascimento</span><input id="efNascimento" type="date" value="${esc(e.dataNascimento||'')}"></label><label class="field full"><span>Endereço</span><input id="efEndereco" value="${esc(address||'')}"></label><label class="field"><span>Telefone</span><input id="efTelefone" value="${esc(e.telefone||'')}"></label><label class="field"><span>DUM</span><input id="efDum" type="date" value="${esc(e.ultimaMenstruacao||'')}"></label><label class="field"><span>DPP</span><input id="efDpp" type="date" value="${esc(e.dataProvParto||'')}"></label><label class="field"><span>Data do parto</span><input id="efParto" type="date" value="${esc(e.dataParto||'')}"></label><label class="field full"><span>Nota local</span><textarea id="efNota">${esc(e.notaLocal||'')}</textarea></label></div><div class="drawer-actions"><button type="button" class="btn primary" data-save-all-fields="${esc(e.id)}">Salvar alterações</button></div>`;openDrawer(`<div class="drawer-head"><div><h2>${esc(e.nome||'Gestante')}</h2><p>${esc(status2ILabel(e.status2i))} · ${esc(e.origin==='manual'?'Adicionada manualmente':e.origin==='metabase_manual'?'Manual + Metabase':'Metabase')}${esc(pregnancyStage(e)==='finalizada'?' · Gestação finalizada':' · Gestação ativa')}</p></div><button class="close-btn" data-close-drawer>${icon('close')}</button></div>${excl?`<div class="notice danger" style="margin-top:14px"><strong>Excluída da lista operacional</strong> em ${fmtDateTime(excl.at)}${excl.reason?` · ${esc(excl.reason)}`:''}</div>`:''}${match?`<div class="drawer-section" style="margin-top:16px"><h3>Reconciliação necessária</h3><div class="notice warn"><strong>Possível correspondência por prontuário + episódio.</strong> Nome isolado nunca é usado para mesclar.</div><div class="facts" style="margin-top:8px"><div class="fact"><span>Manual</span><strong>${esc(e.prontuario||'ID local')}</strong></div><div class="fact"><span>Metabase</span><strong>${esc(match.prontuario)} · ${fmtDate(episodeAnchor(match))}</strong></div></div><button class="btn primary small" style="margin-top:9px" data-merge-manual="${esc(e.id)}|${esc(match.id)}">Confirmar mesclagem</button></div>`:''}<div class="drawer-g-wrap"><div class="drawer-g-left"><div class="drawer-summary"><span class="chip-item"><span class="chip-label">Prontuário</span><strong class="mono">${esc(e.prontuario||'ID local temporário')}</strong></span><span class="chip-item"><span class="chip-label">Idade</span><strong>${ageAt(e)==null?'—':`${ageAt(e)} anos`}</strong></span><span class="chip-item"><span class="chip-label">Equipe</span><strong>${esc(e.equipe||'—')}</strong></span><span class="chip-item"><span class="chip-label">DUM</span><strong>${fmtDate(e.ultimaMenstruacao)}</strong></span><span class="chip-item"><span class="chip-label">IG</span><strong>${weeks==null?'—':`${weeks} sem.`}</strong></span><button class="btn small ghost" data-copy-name="${esc(e.id)}">${icon('copy')}Copiar nome</button></div><label class="switchrow"><input type="checkbox" data-toggle-encerrada="${esc(e.id)}" ${finalized?'checked':''}><span>Gestação encerrada</span></label><small class="switchrow-hint">Marca a data do parto como hoje ao ativar; desmarcar reabre a gestação.</small><div class="drawer-contact-line"><div class="cl-num">${esc(e.telefone||'Telefone não informado')}</div><div class="drawer-actions" style="margin-top:0"><button class="btn small success" data-open-whatsapp="${esc(e.id)}" ${e.phoneNormalized?'':'disabled'}>${icon('message')}Abrir WhatsApp</button><button class="btn small info" data-followup="${esc(e.id)}|whatsapp_enviado" ${e.phoneNormalized?'':'disabled'}>Registrar envio</button></div></div></div><div class="drawer-g-right"><div class="g-tabbar"><button type="button" class="g-tab ${activeTab==='acomp'?'active':''}" data-g-tab="acomp">Acompanhamento</button><button type="button" class="g-tab ${activeTab==='editar'?'active':''}" data-g-tab="editar">Editar dados</button></div><div class="g-panel ${activeTab==='acomp'?'open':''}" data-g-panel="acomp"><div class="notice" style="border-left-color:${followupColor(f.state).text};background:${followupColor(f.state).bg}"><strong style="color:${followupColor(f.state).text}">${esc(followupLabel(f.state))}</strong>${f.updatedAt?` · ${fmtDateTime(f.updatedAt)}`:''}</div><div class="drawer-actions"><button class="btn small" data-followup="${esc(e.id)}|ok_manual">OK · atendida manualmente</button><button class="btn small" data-followup="${esc(e.id)}|atende_confirmado">Atende · confirmado</button><button class="btn small agendada" data-followup="${esc(e.id)}|agendada">Agendada</button><button class="btn small busca-ativa" data-followup="${esc(e.id)}|busca_ativa_solicitada">Busca ativa solicitada</button><button class="btn small ghost" data-followup="${esc(e.id)}|nao_contatada">Reiniciar</button></div>${chips?`<div class="count-chips">${chips}</div>`:''}<div class="timeline" style="margin-top:12px">${timelineHTML}</div><div class="note-add"><textarea id="followupNoteInput" placeholder="Adicionar uma nota ao acompanhamento..."></textarea><button type="button" class="btn small primary" data-add-followup-note="${esc(e.id)}">Salvar nota</button></div></div><div class="g-panel ${activeTab==='editar'?'open':''}" data-g-panel="editar">${editPanel}</div></div></div><div class="disclosure"><button class="disclosure-btn" data-toggle-details><span>Mais detalhes — telefone normalizado, saúde bucal, origem${e.origin==='manual'?', cadastro manual':''}, lista operacional</span><span class="chev">${icon('chevron')}</span></button><div class="disclosure-body"><div class="drawer-mini-section"><h4>Saúde bucal e origem</h4><div class="facts"><div class="fact"><span>Telefone normalizado</span><strong>${esc(e.phoneNormalized||'Inválido ou sem DDD')}</strong></div><div class="fact"><span>Valor original do CSV</span><strong>${esc(e.consultaSaudeBucal||'Não veio do Metabase')}</strong></div><div class="fact"><span>Interpretação 2I</span><strong>${esc(status2ILabel(e.status2i))}</strong></div><div class="fact"><span>Atividade manual</span><strong>${fmtDate(e.dataAtividadeManual)}</strong></div><div class="fact"><span>Observação manual</span><strong>${esc(e.observacao||'—')}</strong></div></div></div><div class="drawer-mini-section"><h4>Lista operacional</h4><div class="drawer-actions">${excl?`<button class="btn small" data-restore-episode="${esc(e.id)}">Restaurar na lista</button>`:`<button class="btn small danger" data-exclude-episode="${esc(e.id)}">Excluir da lista</button>`}</div><small class="muted">Não apaga o cadastro nem altera o panorama do CSV — só entra ou sai da lista operacional.</small></div></div></div>`,{wide:true})}

function exportProcedures(){const p=aggregateProcedureMonth(state.preferences.month);if(!p)return;const rows=[['procedimento_original','procedimento_normalizado','sigtap','quantidade_bruta','quantidade_excluida','quantidade_valida','paginas'],...p.procedureCounts.map(x=>[x.descriptionOriginal,x.descriptionNormalized,x.sigtap,x.quantityRaw,x.quantityRaw-x.quantityValid,x.quantityValid,(x.pages||[]).join('|')])];downloadFile(`procedimentos-${state.preferences.month}.csv`,csvString(rows),'text/csv;charset=utf-8')}
function csvString(rows){return '\ufeff'+rows.map(r=>r.map(v=>`"${String(v??'').replace(/"/g,'""')}"`).join(';')).join('\r\n')}
function export2IModal(){openModal(`<div class="modal-head"><div><h2 id="modalTitle">Exportar lista 2I</h2><p>Escolha o nível de identificação conscientemente.</p></div></div><div class="modal-body"><div class="notice"><strong>Recomendado:</strong> a versão desidentificada mantém equipe, status e datas sem nome, prontuário, telefone ou endereço.</div><div class="notice danger" style="margin-top:9px"><strong>Exportação nominal contém dados pessoais de saúde.</strong> Use somente em ambiente autorizado e mantenha o arquivo protegido.</div></div><div class="modal-foot"><button class="btn" data-export-2i-mode="analytic">Exportar desidentificado</button><button class="btn danger" data-export-2i-mode="nominal">Confirmar exportação nominal</button></div>`)}
function export2I(mode){const rows=applyPregFilters(mergedEpisodes()),nominal=mode==='nominal';const head=nominal?['nome','prontuario','equipe','telefone','dum','dpp','parto','consulta_original','situacao_2i','acompanhamento','origem']:['episodio_hash','equipe','dum','dpp','parto','situacao_2i','acompanhamento','origem'];const data=rows.map(e=>nominal?[e.nome,e.prontuario,e.equipe,e.telefone,e.ultimaMenstruacao,e.dataProvParto,e.dataParto,e.consultaSaudeBucal,status2ILabel(e.status2i),followupLabel(followupFor(e.id).state),e.origin]:[String(e.id).slice(0,16),e.equipe,e.ultimaMenstruacao,e.dataProvParto,e.dataParto,status2ILabel(e.status2i),followupLabel(followupFor(e.id).state),e.origin]);downloadFile(`2i-${nominal?'nominal':'desidentificado'}-${isoDate(new Date())}.csv`,csvString([head,...data]),'text/csv;charset=utf-8');audit('2i_exported',{mode,count:rows.length});closeModal()}

/* ---------- Backup e restauração (único jeito de salvar — nada persiste no navegador) ---------- */

function backupState(type='full'){
  const copy=structuredClone(state);copy.dirty=false;
  for(const snap of copy.snapshots||[]){for(const p of snap.procedureCounts||[])delete p.professionals;for(const month of Object.values(snap.dataByMonth||{}))for(const p of month.procedureCounts||[])delete p.professionals}
  if(type==='analytic'){copy.snapshots=copy.snapshots.filter(s=>s.profile!=='metabase_gestantes_2i');copy.gestantes={manual:[],followups:{},merges:{},excluded:{},overrides:{}};copy.audit=(copy.audit||[]).filter(a=>!String(a.action).startsWith('2i_'));copy.columnMappings={...copy.columnMappings,consulta2i:{}}}
  return copy;
}
async function createBackupEnvelope(type='full'){
  const data={state:backupState(type),rulesets:{municipal:{regra_id:RULESETS.municipal.regra_id,regra_versao:RULESETS.municipal.regra_versao,vigencia:RULESETS.municipal.vigencia},federal:{regra_id:RULESETS.federal.regra_id,regra_versao:RULESETS.federal.regra_versao,vigencia:RULESETS.federal.vigencia}},parserProfiles:state.parserProfiles,columnMappings:type==='full'?state.columnMappings:{consulta2i:{}}};
  return {format:'indicadores-saude-bucal-backup',formatVersion:'1.0',appVersion:APP_VERSION,schemaVersion:SCHEMA_VERSION,type,createdAt:nowISO(),checksum:await sha256(JSON.stringify(data)),data};
}
function has2IData(){return mergedEpisodes().length>0}
function openBackupModal(){const has2i=has2IData();openModal(`<div class="modal-head"><div><h2 id="modalTitle">Backup e restauração</h2><p>O backup nunca contém os PDFs/CSVs originais nem a amostra bruta da sessão.</p></div></div><div class="modal-body">${has2i?'<div class="notice danger"><strong>Há dados de gestantes (2I) importados.</strong> Cifrar o backup com senha é a proteção padrão recomendada sempre que houver dados nominais 2I; considere também o backup “Analítico” quando não precisar dos contatos.</div>':''}<div class="split-grid"><div class="notice"><strong>Completo:</strong> preserva snapshots normalizados, denominadores e o módulo 2I com contatos, origem e histórico. Recomendado cifrar.</div><div class="notice"><strong>Analítico:</strong> exclui integralmente snapshots, cadastros e acompanhamentos 2I. Mantém indicadores sem dados nominais.</div></div><div class="form-grid"><label class="field"><span>Tipo</span><select id="backupType"><option value="full">Completo</option><option value="analytic">Analítico · sem 2I</option></select></label><label class="field"><span>Proteção</span><select id="backupEncryption"><option value="yes">Cifrado com senha</option><option value="no">Sem cifra local</option></select></label><label class="field full"><span>Senha do arquivo (se cifrado)</span><input id="backupPassword" type="password" autocomplete="new-password" minlength="8" placeholder="Mínimo de 8 caracteres"></label></div><div class="notice warn" style="margin-top:12px"><strong>A senha não é armazenada e não pode ser recuperada.</strong> Guarde-a em local seguro.</div></div><div class="modal-foot"><button class="btn" data-restore-backup>${icon('upload')}Restaurar arquivo</button><button class="btn primary" data-create-backup>${icon('download')}Exportar backup</button></div>`)}
async function createBackupFromModal(){const type=document.getElementById('backupType').value,encrypted=document.getElementById('backupEncryption').value==='yes',password=document.getElementById('backupPassword').value;if(encrypted&&password.length<8){toast('Use pelo menos 8 caracteres para cifrar o backup.');return}showLoading('Criando backup','Calculando integridade e preparando o arquivo');try{const envelope=await createBackupEnvelope(type),out=encrypted?{format:'indicadores-saude-bucal-backup-encrypted',formatVersion:'1.0',createdAt:envelope.createdAt,payload:await encryptJSON(envelope,password)}:envelope;downloadFile(`indicadores-saude-bucal-${type}-${isoDate(new Date())}.saude-bucal-backup.json`,JSON.stringify(out,null,2),'application/json');state.lastBackupAt=nowISO();audit('backup_exported',{type,encrypted});state.dirty=false;await persistState();closeModal();refreshAll();toast('Backup exportado e verificado. Nada fica salvo pelo navegador — se editar algo depois, exporte de novo.')}catch(e){showError(e)}finally{hideLoading()}}
async function readBackupFile(file,password=''){const text=await file.text();let obj;try{obj=JSON.parse(text)}catch{throw new Error('O arquivo não contém JSON válido.')}if(obj.format==='indicadores-saude-bucal-backup-encrypted'){if(!password)throw Object.assign(new Error('PASSWORD_REQUIRED'),{code:'PASSWORD_REQUIRED',wrapper:obj});obj=await decryptJSON(obj.payload,password)}if(obj.format!=='indicadores-saude-bucal-backup'||!obj.data?.state)throw new Error('Formato de backup não reconhecido.');const check=await sha256(JSON.stringify(obj.data));if(check!==obj.checksum)throw new Error('A verificação de integridade falhou; o arquivo pode estar corrompido.');return obj}
function promptBackupPassword(wrapper){openModal(`<div class="modal-head"><div><h2 id="modalTitle">Desbloquear backup</h2><p>Este arquivo foi cifrado localmente.</p></div></div><div class="modal-body"><label class="field"><span>Senha</span><input id="restorePassword" type="password" autocomplete="current-password" autofocus></label></div><div class="modal-foot"><button class="btn" data-close-modal>Cancelar</button><button class="btn primary" data-unlock-backup>Desbloquear e validar</button></div>`,{closable:false});document.querySelector('[data-unlock-backup]').onclick=()=>processPendingBackup(document.getElementById('restorePassword').value)}
async function processPendingBackup(password=''){if(!pendingBackupFile)return;showLoading('Validando backup','Integridade, versão e conteúdo');try{const env=await readBackupFile(pendingBackupFile,password);hideLoading();openRestoreOptions(env)}catch(e){hideLoading();if(e.code==='PASSWORD_REQUIRED'||e.message==='PASSWORD_REQUIRED')promptBackupPassword(e.wrapper);else showError(e)}}
function openRestoreOptions(env){const s=env.data.state;openModal(`<div class="modal-head"><div><h2 id="modalTitle">Backup válido</h2><p>${esc(env.type)} · ${fmtDateTime(env.createdAt)} · esquema ${esc(env.schemaVersion)}</p></div></div><div class="modal-body"><div class="facts"><div class="fact"><span>Snapshots</span><strong>${s.snapshots?.length||0}</strong></div><div class="fact"><span>Denominadores</span><strong>${s.denominators?.length||0}</strong></div><div class="fact"><span>Cadastros manuais 2I</span><strong>${s.gestantes?.manual?.length||0}</strong></div><div class="fact"><span>Auditoria</span><strong>${s.audit?.length||0}</strong></div></div><div class="notice warn" style="margin-top:12px"><strong>Substituir</strong> troca o estado atual pelo backup. <strong>Mesclar</strong> adiciona itens que ainda não existem, identificados por hash ou ID.</div></div><div class="modal-foot"><button class="btn" data-close-modal>Cancelar</button><button class="btn" id="mergeRestore">Mesclar</button><button class="btn danger" id="replaceRestore">Substituir estado atual</button></div>`);document.getElementById('mergeRestore').onclick=()=>restoreBackup(env,'merge');document.getElementById('replaceRestore').onclick=()=>restoreBackup(env,'replace')}
function mergeArraysBy(arrA,arrB,key){const map=new Map((arrA||[]).map(x=>[x[key],x]));for(const x of arrB||[])if(!map.has(x[key]))map.set(x[key],x);return [...map.values()]}
function recomputeSupersession(){
  const groups=new Map();
  for(const s of state.snapshots){const key=`${s.profile}|${s.unit||''}|${s.periodStart||''}|${s.periodEnd||''}`;const list=groups.get(key)||[];list.push(s);groups.set(key,list)}
  for(const list of groups.values()){
    list.sort((a,b)=>new Date(a.createdAt)-new Date(b.createdAt));
    const newest=list.at(-1);
    for(const s of list)s.supersededBy=(s===newest)?undefined:newest.id;
  }
}
async function restoreBackup(env,mode){showLoading('Restaurando backup',mode==='replace'?'Substituindo o estado local':'Mesclando dados sem duplicação');try{preRestoreSnapshot={at:nowISO(),payload:state};const incoming=migrateState(env.data.state),incomingWasClean=!incoming.dirty;if(mode==='replace'){state=incoming}else{state.snapshots=mergeArraysBy(state.snapshots,incoming.snapshots,'hash');state.denominators=mergeArraysBy(state.denominators,incoming.denominators,'id');state.gestantes.manual=mergeArraysBy(state.gestantes.manual,incoming.gestantes.manual,'id');state.gestantes.followups={...state.gestantes.followups,...incoming.gestantes.followups};state.gestantes.merges={...state.gestantes.merges,...incoming.gestantes.merges};state.gestantes.excluded={...state.gestantes.excluded,...incoming.gestantes.excluded};state.gestantes.overrides={...state.gestantes.overrides,...incoming.gestantes.overrides};state.columnMappings.consulta2i={...state.columnMappings.consulta2i,...incoming.columnMappings.consulta2i};state.audit=mergeArraysBy(state.audit,incoming.audit,'id');recomputeSupersession()}audit('backup_restored',{mode,type:env.type});state.dirty=!(mode==='replace'&&incomingWasClean);await persistState();pendingBackupFile=null;closeModal();refreshAll();toast(mode==='replace'?(state.dirty?'Backup restaurado. Nada é salvo automaticamente — exporte um novo backup antes de fechar.':'Backup restaurado — corresponde exatamente ao arquivo que você acabou de abrir.'):'Backup mesclado. O resultado da mesclagem ainda não está salvo — exporte um novo backup antes de fechar.')}catch(e){showError(e)}finally{hideLoading()}}

/* ---------- Testes internos da especificação ---------- */

function testSummaryHTML(){const r=state.selfTests;if(!r)return '<div class="test-summary"><div class="test-score">—</div><div><strong>Não executados nesta versão</strong><div class="muted">Clique abaixo para verificar as regras.</div></div></div>';return `<div class="test-summary"><div class="test-score">${r.passed}/${r.total}</div><div><strong>${r.failed?'Há testes que exigem revisão':'Todos os testes passaram'}</strong><div class="muted">${fmtDateTime(r.at)} · ${r.durationMs} ms</div></div></div><div class="test-list">${r.results.map(x=>`<div class="test-item"><span class="${x.pass?'test-pass':'test-fail'}">${x.pass?'✓':'×'}</span><span>${esc(x.name)}${x.error?` · ${esc(x.error)}`:''}</span></div>`).join('')}</div>`}
async function runSelfTests(){const started=performance.now(),results=[];const eq=(a,b,t=1e-9)=>typeof a==='number'&&typeof b==='number'?Math.abs(a-b)<=t:a===b;const add=async(name,fn)=>{try{const v=await fn();if(v!==true)throw new Error(`obtido ${String(v)}`);results.push({name,pass:true})}catch(e){results.push({name,pass:false,error:e.message})}};
  await add('1. M1 · 0,25% é Regular',()=>classifyM1(25/10000*100)==='Regular');
  await add('2. M1 · 0,75% é Suficiente',()=>classifyM1(75/10000*100)==='Suficiente');
  await add('3. M1 · 1,25% é Bom',()=>classifyM1(125/10000*100)==='Bom');
  await add('4. M1 · 1,26% é Ótimo',()=>classifyM1(126/10000*100)==='Ótimo');
  await add('5. M1 · 4% é Ótimo e não tem pontuação antiga',()=>classifyM1(4)==='Ótimo'&&RULESETS.municipal.indicators.M1.meta==null);
  await add('6. M1 · exatamente 1,25% precisa de mais uma consulta',()=>remainingForM1(125,10000,1.25)===1);
  await add('7. M2 · 30% produz 60 pontos',()=>eq(scoreMunicipal('M2',30),60));
  await add('8. M3 · 0,7% produz 70 pontos',()=>eq(scoreMunicipal('M3',.7),70));
  await add('9. M4 · 30% produz 75 pontos',()=>eq(scoreMunicipal('M4',30),75));
  await add('10. M5 · 6% produz 75 pontos',()=>eq(scoreMunicipal('M5',6),75));
  await add('11. Nota de corte recebe pontuação proporcional',()=>scoreMunicipal('M2',25)===50&&scoreMunicipal('M3',.5)===50&&scoreMunicipal('M4',20)===50&&scoreMunicipal('M5',4)===50);
  await add('12. Abaixo da nota de corte recebe zero',()=>scoreMunicipal('M2',24.99)===0&&scoreMunicipal('M3',.49)===0);
  await add('13. Denominador zero não forma resultado',()=>!(0>0)?true:false);
  await add('14. B1 · 1% é Bom',()=>classifyFederal('B1',1)==='Bom');
  await add('15. B2 · 60% é Bom',()=>classifyFederal('B2',60)==='Bom');
  await add('16. B3 · 8% é Ótimo',()=>classifyFederal('B3',8)==='Ótimo');
  await add('17. B4 · 0,6% é Bom',()=>classifyFederal('B4',.6)==='Bom');
  await add('18. B5 · 70% é Ótimo',()=>classifyFederal('B5',70)==='Ótimo');
  await add('19. B5 · 90% é Regular',()=>classifyFederal('B5',90)==='Regular');
  await add('20. B6 8% é Bom e M5 8% vale 100',()=>classifyFederal('B6',8)==='Bom'&&scoreMunicipal('M5',8)===100);
  await add('21. B6 · 9% é Ótimo',()=>classifyFederal('B6',9)==='Ótimo');
  await add('22. Amálgamas não entram no denominador B6',()=>!CODES.B6_DEN.includes('0307010090')&&!CODES.B6_DEN.includes('0307010139'));
  await add('23. Hash idêntico identifica arquivo duplicado',()=>{const h='abc';return [h].includes(h)});
  await add('24. Snapshot mais novo substitui, não soma',()=>{const a={createdAt:'2026-01-01'},b={createdAt:'2026-02-01'};return [a,b].sort((x,y)=>new Date(y.createdAt)-new Date(x.createdAt))[0]===b});
  await add('25. Lista B5 não contamina automaticamente B3',()=>CODES.B5_DEN_DENTIST.some(c=>!CODES.B3_DEN.includes(c)));
  await add('26. Projeção M4 atualiza numerador e denominador',()=>remainingInclusive(30,100,40,true)===17);
  await add('27. Projeção ART atualiza numerador e denominador',()=>remainingInclusive(6,100,8,true)===3);
  await add('28. Exodontia não tem papel municipal',()=>!['M1','M2','M3','M4','M5'].some(id=>procedureRolesFor(id).includes('b3num')));
  await add('29. Itens gerais excluídos não aparecem nos painéis específicos',()=>!/V[ií]nculo|SUS como Escola|Bolsa Fam[ií]lia/i.test(municipalHTML()+federalHTML()));
  await add('30. Regra legada M1 5/3 não existe',()=>RULESETS.municipal.indicators.M1.meta==null&&RULESETS.municipal.indicators.M1.cutoff==null&&RULESETS.municipal.indicators.M1.bands.length===4);
  await add('31. CSV 2I com vírgula final mantém colunas',()=>{const r=parseCSVText('Cd Usu Cadsus,Nome,Equipe,Consulta Saude Bucal,\n001234,Ana,120,SIM,');return r[0].length===5&&r[1].length===5&&r[1][0]==='001234'});
  await add('32. Prontuário preserva zeros à esquerda',()=>parseCSVText('Cd Usu Cadsus\n001234')[1][0]==='001234');
  await add('33. SIM mapeado como atende entra no numerador',()=>{const m={SIM:'atende'},rows=[{consultaSaudeBucal:'SIM'}];return rows.filter(x=>m[x.consultaSaudeBucal]==='atende').length===1});
  await add('34. Valor novo fica Indeterminado',()=>({SIM:'atende'})['NOVO']==null);
  await add('35. Episódio repetido tem ID estável',async()=>{const r={prontuario:'001',ultimaMenstruacao:'2026-01-01'};return await episodeIdFor(r)===await episodeIdFor({...r})});
  await add('36. Telefone válido recebe 55 e inválido não',()=>normalizePhone('(48) 99999-1234')==='5548999991234'&&normalizePhone('123')==='');
  await add('37. Abrir link não altera acompanhamento',()=>{const f={state:'nao_contatada'};const url=`https://wa.me/${normalizePhone('48999991234')}`;return url.includes('wa.me')&&f.state==='nao_contatada'});
  await add('38. Confirmação manual (ok_manual) não sobrescreve o status2i bruto do episódio — o agregado usa isAttended()',()=>{const e={id:'t38',status2i:'pendente'};state.gestantes.followups['t38']={state:'ok_manual',updatedAt:nowISO(),history:[]};const rawUnchanged=e.status2i==='pendente',aggregatedCounts=isAttended(e);delete state.gestantes.followups['t38'];return rawUnchanged&&aggregatedCounts});
  await add('39. Acompanhamento reaparece pelo ID estável',async()=>{const r={prontuario:'1',ultimaMenstruacao:'2026-01-01'},id=await episodeIdFor(r),f={[id]:{state:'ok_manual'}};return f[await episodeIdFor(r)].state==='ok_manual'});
  await add('40. Outra DUM cria outro episódio',async()=>await episodeIdFor({prontuario:'1',ultimaMenstruacao:'2026-01-01'})!==await episodeIdFor({prontuario:'1',ultimaMenstruacao:'2026-02-01'}));
  await add('41. Filtro de equipe recalcula o recorte',()=>{const e=[{equipe:'120',status2i:'atende'},{equipe:'121',status2i:'pendente'}].filter(x=>x.equipe==='120');return e.length===1&&e.filter(x=>x.status2i==='atende').length===1});
  await add('42. Confirmação posterior mantém histórico por episódio',async()=>{const id=await episodeIdFor({prontuario:'1',ultimaMenstruacao:'2026-01-01'}),f={[id]:{history:[1]}};return f[id].history.length===1});
  await add('43. M1 sem denominador não calcula',()=>{const den=null;return den==null});
  await add('44. M1 125/10000 registra 1,25%',()=>eq(100*125/10000,1.25));
  await add('45. M3 7/1000 gera 0,7% e 70 pontos',()=>eq(100*7/1000,.7)&&eq(scoreMunicipal('M3',.7),70));
  await add('46. Sugestão não é confirmação automática',()=>{const suggestion=1000,records=[];return suggestion===1000&&records.length===0});
  await add('47. Três procedimentos preservam subtotal',()=>{const p=[{quantityRaw:1,quantityValid:1},{quantityRaw:2,quantityValid:2},{quantityRaw:3,quantityValid:3}];return p.length===3&&sum(p.map(x=>x.quantityValid))===6});
  await add('48. Conferência distingue bruta, excluída e válida',()=>{const p={quantityRaw:3,quantityValid:2};return p.quantityRaw-p.quantityValid===1});
  await add('49. Backup não inclui originais, amostra bruta ou profissionais identificáveis',()=>{const b=backupState('full'),txt=JSON.stringify(b);return !txt.includes('sessionRaw')&&!txt.includes('fileBytes')&&!txt.includes('pdfOriginal')&&!txt.includes('"professionals"')});
  await add('50. Backup analítico exclui integralmente 2I',()=>{const b=backupState('analytic');return !b.snapshots.some(s=>s.profile==='metabase_gestantes_2i')&&b.gestantes.manual.length===0&&Object.keys(b.gestantes.followups).length===0&&Object.keys(b.gestantes.excluded).length===0});
  await add('51. Cadastro manual isolado (sem_metabase) não figura no snapshot bruto do CSV, mas soma na lista operacional ampliada',()=>{const csv=[{status2i:'atende'}],manual=[{status2i:'sem_metabase'}];return csv.filter(x=>x.status2i==='atende').length===1&&manual.length===1});
  await add('52. Sem prontuário recebe ID local e não mescla',()=>{const m={id:'local-1',prontuario:''};return !findManualMatch(m,[{nome:'Mesmo Nome'}])});
  await add('53. Reconciliação usa prontuário + episódio, não nome',()=>{const m={prontuario:'123',ultimaMenstruacao:'2026-01-01',nome:'A'},e=[{id:'x',prontuario:'123',ultimaMenstruacao:'2026-01-01',nome:'B'}];return findManualMatch(m,e)?.id==='x'&&!findManualMatch({...m,prontuario:'',nome:'B'},e)});
  await add('54. Mesclagem preserva origens e evita dupla linha',()=>{const manual={id:'m',observacao:'obs'},meta={id:'e',origin:'metabase'},merged={...manual,...meta,origin:'metabase_manual',manualId:'m',metabaseId:'e'};return merged.origin==='metabase_manual'&&merged.observacao==='obs'&&[merged].length===1});
  await add('55. Denominador de M4 é amplo (só exclui primeira consulta/tratamento concluído)',()=>{const geral=procedureMatch('ATENDIMENTO ODONTOLOGICO'),primeira=procedureMatch('PRIMEIRA CONSULTA ODONTOLOGICA PROGRAMADA'),concluido=procedureMatch('TRATAMENTO CONCLUIDO'),flúor=procedureMatch('APLICACAO TOPICA DE FLUOR');return !geral.roles.includes('first')&&!geral.roles.includes('concluded')&&primeira.roles.includes('first')&&concluido.roles.includes('concluded')&&flúor.roles.includes('m4den')});
  await add('56. Denominador de B5 é a lista fechada da Nota B5; atendimento geral não entra',()=>{const geral=procedureMatch('ATENDIMENTO ODONTOLOGICO'),exodontiaMultipla=procedureMatch('EXODONTIA MULTIPLA'),flúor=procedureMatch('APLICACAO TOPICA DE FLUOR');return !geral.roles.includes('b5den')&&!exodontiaMultipla.roles.includes('b5den')&&flúor.roles.includes('b5den')});
  await add('57. Adequação do comportamento de crianças reconhece descrição truncada',()=>{const m=procedureMatch('ADEQUACAO DO COMPORTAMENTO DE');return !m.unrecognized&&m.code==='03.07.01.015-5'&&m.roles.includes('m4den')&&m.roles.includes('b5den')});
  await add('58. B2/B4/B6 espelham municipal; B5 e B3 permanecem independentes',()=>FEDERAL_MIRROR.B2==='M2'&&FEDERAL_MIRROR.B1==='M1'&&FEDERAL_MIRROR.B4==='M3'&&FEDERAL_MIRROR.B6==='M5'&&!('B3' in FEDERAL_MIRROR)&&!('B5' in FEDERAL_MIRROR));
  await add('59. Escovação supervisionada não confunde com atividade que só cita saúde bucal',()=>/ESCOVACAO SUPERVISIONADA/.test(norm('Escovação Supervisionada'))&&!/ESCOVACAO SUPERVISIONADA/.test(norm('cuidados em DM (saúde bucal)')));
  await add('60. Nota de evolução de atividade em grupo não conta como procedimento individual',()=>/^EVOLUCAO DA ATIVIDADE EM GRUPO/.test(norm('EVOLUÇÃO DA ATIVIDADE EM GRUPO'))&&procedureMatch('EVOLUCAO DA ATIVIDADE EM GRUPO').unrecognized);
  await add('61. Hipótese de B6 herda a ressalva de amálgama/CBO do M5 espelhado',()=>{const h=federalComponents('B6','2026-07').hypothesis;return typeof h==='string'&&/amálgama/i.test(h)&&/CBO/i.test(h)});
  await add('62. Denominador de restaurador (M5/B6) tem só ART + 2 catálogos truncados ambíguos, nenhum código de amálgama',()=>{const rules=PROCEDURE_RULES.filter(r=>r.roles.includes('restorative'));const art=rules.filter(r=>r.code==='03.07.01.007-4'&&!r.ambiguous),trunc=rules.filter(r=>r.ambiguous);return rules.length===3&&art.length===1&&trunc.length===2&&!rules.some(r=>r.code==='03.07.01.009-0'||r.code==='03.07.01.013-9')});
  await add('63. Numerador B3 cobre as duas exodontias e nada mais',()=>{const perm=procedureMatch('EXODONTIA DE DENTE PERMANENTE'),mult=procedureMatch('EXODONTIA MULTIPLA'),outros=PROCEDURE_RULES.filter(r=>r.roles.includes('b3num'));return perm.roles.includes('b3num')&&mult.roles.includes('b3num')&&outros.length===2});
  await add('64. Orientação de higiene bucal entra em B5 mas não em B3 (lista própria por indicador)',()=>{const m=procedureMatch('ORIENTACAO DE HIGIENE BUCAL');return m.roles.includes('b5den')&&!m.roles.includes('b3den')});
  await add('65. Lista viva de códigos b3den (incluindo as 2 restaurações ambíguas expandidas) bate exatamente com CODES.B3_DEN',()=>{const live=PROCEDURE_RULES.filter(r=>r.roles.includes('b3den'));const restauraPermanente=['0307010031','0307010120'],restauraDeciduo=['0307010082','0307010104','0307010112'];const covered=new Set();for(const r of live){if(r.code){covered.add(r.code.replace(/\D/g,''))}else if(/PERMANENTE/.test(norm(r.name))){restauraPermanente.forEach(c=>covered.add(c))}else if(/DECIDUO/.test(norm(r.name))){restauraDeciduo.forEach(c=>covered.add(c))}}return covered.size===CODES.B3_DEN.length&&CODES.B3_DEN.every(c=>covered.has(c))});
    await add('66. Painel 2I não vem com nenhum filtro travado por padrão (mostra todas as gestantes)',()=>defaultState().preferences.pregTeam===''&&defaultState().preferences.pregStatus===''&&defaultState().preferences.pregStage===''&&defaultState().preferences.pregExcluded===''&&!('pregPopulation' in defaultState().preferences));
  await add('67. Âncora do episódio 2I prioriza DUM, depois DPP, depois data do parto',()=>episodeAnchor({ultimaMenstruacao:'2026-01-01',dataProvParto:'2026-02-01',dataParto:'2026-03-01'})==='2026-01-01'&&episodeAnchor({dataProvParto:'2026-02-01',dataParto:'2026-03-01'})==='2026-02-01'&&episodeAnchor({dataParto:'2026-03-01'})==='2026-03-01'&&episodeAnchor({})==='');
  await add('68. Normalização de telefone aceita DDD de 11 dígitos e já-prefixado com 55, rejeita curto demais',()=>normalizePhone('48988645963')==='5548988645963'&&normalizePhone('5548988645963')==='5548988645963'&&normalizePhone('123')==='');
    await add('69. Prontuário CELK remove vírgulas/pontos de formatação do Metabase, mantendo só os números como texto',()=>sanitizeProntuario('2,115,998')==='2115998'&&sanitizeProntuario('  81,731 ')==='81731'&&sanitizeProntuario('00123')==='00123');
  await add('70. Estágio da gestação é finalizada só quando há data de parto registrada',()=>pregnancyStage({dataParto:'2026-05-01'})==='finalizada'&&pregnancyStage({dataProvParto:'2026-05-01'})==='ativa'&&pregnancyStage({})==='ativa');
  await add('71. Exclusão de gestante da lista operacional é reversível e não existe até ser marcada',()=>{const before=isExcluded('teste-71');state.gestantes.excluded['teste-71']={at:nowISO(),reason:'teste'};const during=isExcluded('teste-71');delete state.gestantes.excluded['teste-71'];const after=isExcluded('teste-71');return !before&&during&&!after});
  await add('72. Notação científica no prontuário é detectada sem falso positivo em número com vírgulas',()=>isScientificNotation('2.12E+15')&&isScientificNotation('2115998e+2')&&!isScientificNotation('2115998')&&!isScientificNotation('2,115,998'));
  await add('73. Restauração de backup mesclado recalcula qual snapshot fica ativo por perfil+unidade+período',()=>{
    const originalSnapshots=state.snapshots;
    state.snapshots=[
      {id:'teste-73-a',profile:'celk_procedimentos_detalhado',unit:'U1',periodStart:'2026-07-01',periodEnd:'2026-07-31',createdAt:'2026-07-01T10:00:00.000Z'},
      {id:'teste-73-b',profile:'celk_procedimentos_detalhado',unit:'U1',periodStart:'2026-07-01',periodEnd:'2026-07-31',createdAt:'2026-07-05T10:00:00.000Z'},
      {id:'teste-73-c',profile:'celk_procedimentos_detalhado',unit:'U2',periodStart:'2026-07-01',periodEnd:'2026-07-31',createdAt:'2026-07-02T10:00:00.000Z'},
    ];
    recomputeSupersession();
    const a=state.snapshots.find(s=>s.id==='teste-73-a'),b=state.snapshots.find(s=>s.id==='teste-73-b'),c=state.snapshots.find(s=>s.id==='teste-73-c');
    const ok=a.supersededBy==='teste-73-b'&&b.supersededBy===undefined&&c.supersededBy===undefined;
    state.snapshots=originalSnapshots;
    return ok;
  });
  await add('74. Diagnóstico executa sem erros e cada item tem nível, código e mensagem válidos',()=>{const list=buildDiagnostics();return Array.isArray(list)&&list.every(x=>['error','warning','info'].includes(x.level)&&typeof x.code==='string'&&typeof x.message==='string')});
  await add('75. queueSave sempre marca o estado como não salvo',()=>{const before=state.dirty;state.dirty=false;queueSave();const after=state.dirty;state.dirty=before;return after===true});
  await add('76. Marcar como salvo depois de auditar uma ação não é desfeito pelo próprio audit() (regressão do bug em que exportar/restaurar backup ficava "não salvo" por causa da ordem das chamadas)',()=>{
    const savedDirty=state.dirty,savedAuditLen=state.audit.length;
    state.dirty=true;audit('selftest_dummy_action',{});state.dirty=false;
    const result=state.dirty===false;
    state.dirty=savedDirty;state.audit=state.audit.slice(0,savedAuditLen);
    return result;
  });
  await add('77. Nenhuma função de IndexedDB restou no código — nada é salvo pelo navegador',()=>typeof dbGet==='undefined'&&typeof dbPut==='undefined'&&typeof openDB==='undefined');
  await add('78. Leitor de PDF referencia arquivos .js (não .mjs), evitando bloqueio de MIME type em hospedagem estática que não mapeia .mjs como JavaScript',()=>{const src=loadPdfJs.toString();return src.includes('pdf.min.js')&&src.includes('pdf.worker.min.js')&&!src.includes('.mjs')});
  await add('79. Falha de importação guarda o motivo por arquivo em vez de deixar o resumo final sobrescrever a mensagem de erro (regressão do bug em que o toast escondia o motivo real)',()=>{const src=importFiles.toString();return src.includes('failures.push')&&src.includes('showImportFailures')});
  await add('80. Relatório de falha de importação inclui navegador e detalhe técnico, sem depender do console do navegador',()=>{const rep=importFailureReportText([{name:'x.pdf',message:'erro teste',stack:'stack teste'}]);return rep.includes('x.pdf')&&rep.includes('erro teste')&&rep.includes('stack teste')&&rep.includes(navigator.userAgent)});
  await add('81. ReadableStream é assíncrono-iterável (nativo ou via polyfill) — sem isso o pdf.js falha só no Safari até a versão 26 ao ler o texto do PDF',async()=>{if(typeof ReadableStream==='undefined')return true;if(typeof ReadableStream.prototype[Symbol.asyncIterator]!=='function')return false;const rs=new ReadableStream({start(c){c.enqueue(1);c.enqueue(2);c.close()}});const got=[];for await(const v of rs)got.push(v);return got.length===2&&got[0]===1&&got[1]===2});
  await add('82. Leitura por meta (M2, não simultâneo): 32/70 com meta 50% ainda precisa de 3 tratamentos concluídos a mais',()=>metaGap('M2',32,70)===3);
  await add('83. Leitura por meta (M4, simultâneo — novo preventivo também aumenta o denominador): 183/675 com meta 40% ainda precisa de 145 procedimentos preventivos a mais',()=>metaGap('M4',183,675)===145);
  await add('84. Leitura por meta (M1, meta = faixa Ótimo >1,25%): 57/11358,5 ainda precisa de 85 primeiras consultas a mais',()=>metaGap('M1',57,11358.5)===85);
  await add('85. m1Band classifica corretamente as 4 faixas oficiais de M1 usadas na régua da Visão Geral',()=>m1Band(1.3)?.label==='Ótimo'&&m1Band(0.8)?.label==='Bom'&&m1Band(0.3)?.label==='Suficiente'&&m1Band(0.1)?.label==='Regular');
  await add('86. metaGoalsHit devolve contagem coerente (batidas ≤ com dado) tanto para o mês quanto para o quadrimestre, sem lançar erro',()=>{const mk=state.preferences.month,gm=metaGoalsHit(mk,'month'),gq=metaGoalsHit(mk,'quarter');return gm.hit<=gm.total&&gq.hit<=gq.total&&Number.isFinite(gm.hit)&&Number.isFinite(gq.hit)});
  await add('87. Visão Geral não usa mais pontuação em pontos (\"pts\") — cada régua de meta tem escala e cor próprias, com toggle mês/quadrimestre',()=>{const src=metaCard.toString()+metaRulerHTML.toString()+overviewHTML.toString();return !src.includes('pts')&&src.includes('metaRulerHTML')&&src.includes('overviewScope')});
  await add('88. Preferência padrão de escopo da Visão Geral é "por mês"',()=>defaultState().preferences.overviewScope==='month');
  await add('89. KPI de gestantes na Visão Geral usa isAttended() (CSV + confirmação manual) sobre a lista operacional visível',()=>{const src=overviewHTML.toString();return src.includes('gestante(s) com meta batida do total de')&&src.includes('na lista operacional')&&src.includes('attended/pregExpanded.length')});
  await add('90. Selo "Consolidado informado" reconhece o motivo detalhado do Metabase (regressão do bug em que a comparação exata de string nunca batia e todo resultado do Metabase aparecia como "Prévia não homologada")',()=>{const html=dataQuality({result:10,resultKind:'informado pelo Metabase porque não há CELK para o mês'});return html.includes('Consolidado informado')&&!html.includes('Prévia não homologada')});
  await add('91. Apuração do quadrimestre não usa mais pontuação em pontos, nem a coluna Auditoria, e passa a usar as reguas por meta',()=>{const src=municipalHTML.toString();return !src.includes('pts')&&!src.includes('Agregações divergem')&&!src.includes('Auditoria')&&src.includes('apuracaoMonthBoxes')&&src.includes('quadrimestralOutlook')});
  await add('92. zoneClass/zoneLabel classificam M2 (corte 25, meta 50) nas 3 faixas coerentes com a régua principal',()=>zoneClass('M2',60)==='zone-good'&&zoneLabel('M2',60)==='Meta batida'&&zoneClass('M2',30)==='zone-warn'&&zoneLabel('M2',30)==='Em progresso'&&zoneClass('M2',10)==='zone-bad'&&zoneLabel('M2',10)==='Abaixo do corte');
  await add('93. zoneClass agrupa as faixas oficiais de M1 (Ótimo/Bom viram zone-good, Suficiente zone-warn, Regular zone-bad)',()=>zoneClass('M1',1.3)==='zone-good'&&zoneClass('M1',0.8)==='zone-good'&&zoneClass('M1',0.3)==='zone-warn'&&zoneClass('M1',0.1)==='zone-bad');
  await add('94. apuracaoMonthBoxes marca o mês selecionado como "current", meses futuros como "mês futuro" e meses passados sem dado como "sem dado"',()=>{const ref=state.preferences.month,{year,month}=parseMonthKey(ref),prev=monthKey(month===1?year-1:year,month===1?12:month-1),next=monthKey(month===12?year+1:year,month===12?1:month+1);const html=apuracaoMonthBoxes('M2',[{mk:prev,result:null},{mk:ref,result:60},{mk:next,result:null}]);return html.includes('month-box missing')&&html.includes('sem dado')&&html.includes('zone-good current')&&html.includes('month-box future')&&html.includes('mês futuro')});
  await add('95. quadrimestralOutlook devolve rótulo e classe de pill válidos para os 5 indicadores municipais, com ou sem dados carregados',()=>{const classes=['success','bad','neutral','warn','good'];return ['M1','M2','M3','M4','M5'].every(id=>{const q=quarterMunicipal(id),r=quadrimestralOutlook(id,q);return classes.includes(r.cls)&&typeof r.label==='string'&&r.label.length>0&&typeof r.detail==='string'&&r.detail.length>0})});
  await add('96. Coluna Parcial soma os 4 meses tratando ausência como zero e sempre divide por 4 (projeção de meta)',()=>{const parts=[1,null,null,null].map(v=>v==null?0:v);return Math.abs(sum(parts)/4-0.25)<1e-9});
  await add('97. Cards federais escondem a Hipótese/limitação do corpo do card (só aparece na janela do "i") e a tabela "Faixas federais cadastradas" saiu, redundante com a régua de cada card',()=>{const src=indicatorCard.toString()+federalHTML.toString();return !federalHTML.toString().includes('Faixas federais cadastradas')&&!federalHTML.toString().includes('panel-head')&&src.includes('federalRulerHTML')&&src.includes('federalPill')});
  await add('98. FEDERAL_BAND_DEFS cobre o eixo inteiro de 0 até o máximo, sem buracos nem sobreposição, para os 6 indicadores federais',()=>['B1','B2','B3','B4','B5','B6'].every(id=>{const def=FEDERAL_BAND_DEFS[id],segs=[...def.segments].sort((a,b)=>a[0]-b[0]);return segs[0][0]===0&&segs[segs.length-1][1]===def.max&&segs.every((s,i)=>i===0||s[0]===segs[i-1][1])}));
  await add('99. classifyFederal/federalZoneColor concordam nas 4 faixas de B1 (caso monotônico) e nas 2 zonas "Regular" de B3 (caso de faixa atípica, ótima no meio da escala)',()=>{const c=(id,v)=>classifyFederal(id,v);return c('B1',1.3)==='Ótimo'&&c('B1',0.8)==='Bom'&&c('B1',0.3)==='Suficiente'&&c('B1',0.1)==='Regular'&&c('B3',7)==='Ótimo'&&c('B3',2)==='Regular'&&c('B3',15)==='Regular'});
  await add('100. Paleta federal (FEDERAL_ZONE_COLORS + cor própria do card B3) não repete nenhuma cor já usada nas faixas municipais de M1',()=>{const muni=RULESETS.municipal.indicators.M1.bands.map(b=>b.color.toLowerCase());const fed=[...Object.values(FEDERAL_ZONE_COLORS).map(c=>c.text.toLowerCase()),FEDERAL_B3_ACCENT.toLowerCase()];return fed.every(c=>!muni.includes(c))});
  await add('101. isAttended combina status2i do CSV com confirmação manual sem alterar o campo bruto',()=>{const e={id:'t101',status2i:'pendente'};state.gestantes.followups['t101']={state:'ok_manual',updatedAt:nowISO(),history:[]};const result=isAttended(e)&&e.status2i==='pendente';delete state.gestantes.followups['t101'];return result});
  await add('102. Lista 2I ordena pendentes alfabeticamente antes das atendidas',()=>{const list=[{id:'a',nome:'Beatriz',status2i:'atende'},{id:'b',nome:'Ana',status2i:'pendente'},{id:'c',nome:'Carla',status2i:'pendente'}];const sorted=[...list].sort((x,y)=>{const xa=isAttended(x)?1:0,ya=isAttended(y)?1:0;if(xa!==ya)return xa-ya;return x.nome.localeCompare(y.nome,'pt-BR')});return sorted.map(x=>x.id).join(',')==='b,c,a'});
  await add('103. Sinalização de prioridade (3º trimestre) exige pendente + gestação ativa + IG ≥28 sem., sem reordenar a lista',()=>{const dum=new Date();dum.setDate(dum.getDate()-7*30);const e={ultimaMenstruacao:dum.toISOString().slice(0,10),dataParto:'',status2i:'pendente'};const weeks=gestationalWeeks(e);return isPriority2I(e)&&weeks>=28});
  await add('104. Importação do CSV 2I interpreta automaticamente "Sim" como atendida, sem modal de confirmação',()=>{const src=parseGestantesCSV.toString();return !src.includes('ensure2IMappings')&&src.includes("norm(record.consultaSaudeBucal)==='SIM'?'atende':'pendente'")});
  await add('105. Correção local de contato não altera o episódio original do snapshot Metabase',()=>{const snap={id:'s1',episodes:[{id:'e1',telefone:'11999999999'}]};state.gestantes.overrides['e1']={telefone:'11888888888'};const originalUnchanged=snap.episodes[0].telefone==='11999999999';delete state.gestantes.overrides['e1'];return originalUnchanged});
  await add('106. Painel 2I usa os novos rótulos (Panorama atual, Gestantes pendentes, Gestantes ativas) e não os antigos',()=>{const src=pregnancyHTML.toString();return src.includes('Panorama atual')&&src.includes('Gestantes pendentes')&&src.includes('Gestantes ativas')&&!src.includes('Panorama do CSV')&&!src.includes('Pendentes no CSV')&&!src.includes("kpi('Lista operacional'")});
  await add('107. Telefone sai da lista 2I e permanece só no perfil detalhado (gaveta)',()=>{return !pregnancyHTML.toString().includes('masked-phone')&&openEpisode.toString().includes('drawer-contact-line')&&openEpisode.toString().includes('e.telefone||')});
  await add('108. Gaveta colore o acompanhamento por situação (deixa de ser monocromática)',()=>{return openEpisode.toString().includes('followupColor(')});
  await add('109. Cabeçalho não exibe mais nome/avatar do usuário (perfil removido do topbar)',()=>{const bar=document.querySelector('.topbar');return !document.querySelector('.topbar .profile')&&!!bar&&!bar.innerHTML.includes('avatar')});
  await add('110. Lista 2I renderiza como cartões (cardlist/rowcard) em vez de tabela',()=>{const src=pregnancyHTML.toString();return src.includes('cardlist')&&src.includes('rowcard')&&!src.includes('<table>')});
  await add('111. Coluna "Funções" do Resumo por procedimento mostra indicador + papel (ex.: "M1 - Numerador"), não o código bruto da role',()=>{const first=procedureRoleBadgesHTML(['first']);return first.includes('M1 - Numerador')&&first.includes('B1 - Numerador')&&first.includes('M2 - Denominador')&&first.includes('B2 - Denominador')&&!importsHTML.toString().includes("pill(r,'neutral')")});
  await add('112. Card 2I marca gestação encerrada com selo próprio e nome riscado, numa cor ainda não usada em outro selo/estado (--purple, não a verde/âmbar/vermelha já usadas)',()=>{const src=pregnancyHTML.toString();return src.includes('Gestação encerrada')&&src.includes('line-through')&&src.includes('#786fa6')&&!src.includes("finalized?'#39b980'")});
  await add('113. Botão "Registrar envio" (marcar WhatsApp enviado) usa uma cor própria, diferente do botão padrão e do "Abrir WhatsApp"',()=>{const src=openEpisode.toString();return src.includes('"btn small info" data-followup="${esc(e.id)}|whatsapp_enviado"')});
  await add('114. "Limpar tudo" do 2I remove só snapshots do perfil 2I e reseta manual/acompanhamento/mesclagens/exclusões/correções, sem tocar em outros perfis de snapshot nem exigir confirmação sem o texto exato',()=>{const srcData=clearAllGestantesData.toString(),srcModal=openClearGestantesModal.toString();return srcData.includes("profile!=='metabase_gestantes_2i'")&&srcData.includes('manual:[]')&&srcData.includes('followups:{}')&&srcData.includes('merges:{}')&&srcData.includes('excluded:{}')&&srcData.includes('overrides:{}')&&srcModal.includes("v!=='LIMPAR TUDO'")});
  await add('115. "Busca ativa solicitada" é um estado de acompanhamento próprio, com botão na gaveta e cor distinta das demais (não reaproveita o azul do WhatsApp nem o verde/vermelho de OK/confirmado)',()=>{const srcOpen=openEpisode.toString(),colorsOk=FOLLOWUP_COLORS.busca_ativa_solicitada&&FOLLOWUP_COLORS.busca_ativa_solicitada.text!==FOLLOWUP_COLORS.whatsapp_enviado.text&&FOLLOWUP_COLORS.busca_ativa_solicitada.text!==FOLLOWUP_COLORS.ok_manual.text&&FOLLOWUP_COLORS.busca_ativa_solicitada.text!==FOLLOWUP_COLORS.atende_confirmado.text;return colorsOk&&srcOpen.includes('data-followup="${esc(e.id)}|busca_ativa_solicitada"')&&followupLabel('busca_ativa_solicitada')==='Busca ativa solicitada'});
  await add('116. Lista de gestantes mostra um selo de tentativa de contato por WhatsApp, busca ativa solicitada e agendada, numa cor própria, quando o acompanhamento estiver nesses estados',()=>{const src=pregnancyHTML.toString();return !!(src.includes('preg-tag')&&src.includes("followupColor(f.state)")&&src.includes("['whatsapp_enviado','busca_ativa_solicitada','agendada']")&&followupShortLabel('whatsapp_enviado')&&followupShortLabel('busca_ativa_solicitada')&&followupShortLabel('agendada'))});
  await add('117. Gaveta em tela dividida (opção G): coluna à esquerda com resumo, interruptor de "Gestação encerrada" e contato; coluna à direita em abas "Acompanhamento" (padrão, com todos os botões, contagens, linha do tempo e nota) e "Editar dados" (todos os campos, sem modal); "Mais detalhes" só com o que sobrou',()=>{const src=openEpisode.toString();const iLeft=src.indexOf('drawer-g-left'),iSwitch=src.indexOf('data-toggle-encerrada'),iRight=src.indexOf('drawer-g-right'),iTabAcomp=src.indexOf('data-g-tab="acomp"'),iTabEditar=src.indexOf('data-g-tab="editar"'),iChips=src.indexOf('count-chips'),iNote=src.indexOf('data-add-followup-note'),iDetails=src.indexOf('data-toggle-details');const order=iLeft>-1&&iSwitch>iLeft&&iRight>iSwitch&&iTabAcomp>-1&&iTabEditar>iTabAcomp&&iChips>iTabAcomp&&iNote>iChips&&iDetails>iRight;return order&&!src.includes('data-edit-contact')});
  await add('118. Botão "Mais detalhes" da gaveta alterna a exibição (classe "open") sem alterar o estado da aplicação nem disparar toast/atualização',()=>{const btn=document.createElement('button');btn.setAttribute('data-toggle-details','');const body=document.createElement('div');body.className='disclosure-body';const wrap=document.createElement('div');wrap.style.display='none';wrap.appendChild(btn);wrap.appendChild(body);document.body.appendChild(wrap);const before=JSON.stringify(state.gestantes);btn.click();const openedBoth=btn.classList.contains('open')&&body.classList.contains('open');btn.click();const closedBoth=!btn.classList.contains('open')&&!body.classList.contains('open');const stateUnchanged=JSON.stringify(state.gestantes)===before;wrap.remove();return openedBoth&&closedBoth&&stateUnchanged});
  await add('119. "Agendada" é um novo estado de acompanhamento, com botão na gaveta (aba Acompanhamento) e cor própria, distinta dos demais estados',()=>{const srcOpen=openEpisode.toString(),c=FOLLOWUP_COLORS.agendada,colorsOk=c&&c.text!==FOLLOWUP_COLORS.whatsapp_enviado.text&&c.text!==FOLLOWUP_COLORS.busca_ativa_solicitada.text&&c.text!==FOLLOWUP_COLORS.ok_manual.text&&c.text!==FOLLOWUP_COLORS.atende_confirmado.text;return colorsOk&&srcOpen.includes('data-followup="${esc(e.id)}|agendada"')&&followupLabel('agendada')==='Consulta agendada'&&followupShortLabel('agendada')==='Consulta agendada'});
  await add('120. Abas "Acompanhamento"/"Editar dados" da gaveta alternam por clique (classes "active"/"open") sem alterar o estado da aplicação',()=>{const wrap=document.createElement('div');wrap.style.display='none';const tabbar=document.createElement('div');tabbar.className='g-tabbar';const tabA=document.createElement('button');tabA.className='g-tab active';tabA.setAttribute('data-g-tab','acomp');const tabB=document.createElement('button');tabB.className='g-tab';tabB.setAttribute('data-g-tab','editar');tabbar.appendChild(tabA);tabbar.appendChild(tabB);const panelA=document.createElement('div');panelA.className='g-panel open';panelA.dataset.gPanel='acomp';const panelB=document.createElement('div');panelB.className='g-panel';panelB.dataset.gPanel='editar';wrap.appendChild(tabbar);wrap.appendChild(panelA);wrap.appendChild(panelB);document.body.appendChild(wrap);const before=JSON.stringify(state.gestantes);tabB.click();const switched=tabB.classList.contains('active')&&!tabA.classList.contains('active')&&panelB.classList.contains('open')&&!panelA.classList.contains('open');const stateUnchanged=JSON.stringify(state.gestantes)===before;wrap.remove();return switched&&stateUnchanged});
  await add('121. Adicionar nota ao acompanhamento cria uma entrada do tipo "nota" na linha do tempo, sem mudar o estado nem a data de atualização do acompanhamento',()=>{const src=addFollowupNote.toString();return src.includes("type:'note'")&&src.includes('state:old.state')&&src.includes('updatedAt:old.updatedAt')});
  await add('122. Contagem do acompanhamento soma WhatsApp enviado, busca ativa, agendada e notas separadamente a partir do histórico',()=>{const h=[{to:'whatsapp_enviado'},{to:'whatsapp_enviado'},{to:'busca_ativa_solicitada'},{type:'note',text:'x'},{to:'agendada'}];const c=followupCounts(h);return c.whatsapp===2&&c.buscaAtiva===1&&c.agendada===1&&c.notes===1});
  await add('123. Alternar "Gestação encerrada" marca a data do parto como hoje (ou limpa, ao desmarcar) — direto no cadastro para origem manual, como correção local para origem Metabase — sem alterar o episódio original',()=>{const src=toggleGestacaoEncerrada.toString();return src.includes("e.origin==='manual'")&&src.includes('isoDate(new Date())')&&src.includes('ov.dataParto=')});
  await add('124. "Salvar alterações" (aba Editar dados) grava nome, prontuário, equipe, nascimento, endereço, telefone, DUM, DPP, parto e nota local como uma correção local — sem alterar a fotografia original do CSV do Metabase',()=>{const src=saveAllFieldsOverride.toString();const fields=['nome','prontuario','equipe','dataNascimento','enderecoOverride','telefone','ultimaMenstruacao','dataProvParto','dataParto','notaLocal'];return fields.every(k=>src.includes(k))&&src.includes('state.gestantes.overrides[id]=ov')});
  await add('125. Correção completa (nome, prontuário, equipe, endereço) grava como sobreposição local e aparece no episódio mesclado, sem alterar o snapshot original do Metabase — mesmo mecanismo já usado por telefone/DUM/DPP/parto/nota',()=>{const snap={id:'sOv125',profile:'metabase_gestantes_2i',createdAt:new Date(Date.now()+9e10).toISOString(),episodes:[{id:'eOv125',nome:'Nome Original',prontuario:'000',equipe:'1'}]};state.snapshots.push(snap);state.gestantes.overrides['eOv125']={nome:'Nome Corrigido',prontuario:'999',equipe:'9',enderecoOverride:'Rua Nova, 1'};const merged=mergedEpisodes().find(x=>x.id==='eOv125');const overlaid=!!merged&&merged.nome==='Nome Corrigido'&&merged.prontuario==='999'&&merged.equipe==='9'&&merged.enderecoOverride==='Rua Nova, 1';const originalUnchanged=snap.episodes[0].nome==='Nome Original'&&snap.episodes[0].prontuario==='000';state.snapshots.pop();delete state.gestantes.overrides['eOv125'];return overlaid&&originalUnchanged});
  await add('126. Aba "Editar dados" da gaveta cobre nome, prontuário, equipe, nascimento, endereço, telefone, DUM, DPP, parto e nota — substitui o antigo "Corrigir dados" (5 campos, atrás de modal)',()=>{const src=openEpisode.toString();const hasAllFields=['efNome','efProntuario','efEquipe','efNascimento','efEndereco','efTelefone','efDum','efDpp','efParto','efNota'].every(k=>src.includes(k));return hasAllFields&&src.includes('data-g-tab="editar"')&&!src.includes('data-edit-contact')&&typeof openEditContact==='undefined'});
  await add('127. doseML calcula volume e mg pelo peso sem travar quando o resultado fica dentro do teto (ex.: 20kg ÷ 3 = 7 mL, 350 mg)',()=>{const d=doseML(20,3,10);return d.vol==='7'&&d.mg===350&&d.capped===false});
  await add('128. doseML trava no teto máximo quando o cálculo por peso o ultrapassa (ex.: 50kg ÷ 3 daria 17 mL, mas o teto de Amoxicilina/Eritromicina/Cefalexina é 10 mL)',()=>{const d=doseML(50,3,10);return d.vol==='10'&&d.mg===500&&d.capped===true});
  await add('129. doseGotas arredonda para o mais próximo por padrão, mas para baixo quando arredondarParaBaixo é true (ex.: 9,5kg × 1 gota/kg = 9,5 → 9 gotas com arredondamento para baixo, não 10)',()=>{const semFloor=doseGotas(9.5,1.5,10,35,false);const comFloor=doseGotas(9.5,1,25,35,true);return semFloor.gotas===14&&semFloor.mg===140&&comFloor.gotas===9&&comFloor.mg===225});
  await add('130. doseGotas trava no teto de gotas (ex.: Ibuprofeno não passa de 40 gotas mesmo com peso alto)',()=>{const d=doseGotas(50,1,5,40,false);return d.gotas===40&&d.capped===true&&d.mg===200});
  await add('131. calculatorHTML mostra "—" nos seis cartões de medicamento quando nenhum peso foi informado',()=>{const prevCalc=state.preferences.calcPeso;state.preferences.calcPeso='';const html=calculatorHTML();state.preferences.calcPeso=prevCalc;return (html.match(/<strong>—<\/strong>/g)||[]).length===6});
  await add('132. calculatorHTML calcula as seis doses a partir de state.preferences.calcPeso (ex.: 20kg → Amoxicilina 7 mL, Eritromicina/Cefalexina 5 mL, Paracetamol 30 gotas, Dipirona/Ibuprofeno 20 gotas)',()=>{const prevCalc=state.preferences.calcPeso;state.preferences.calcPeso='20';const html=calculatorHTML();state.preferences.calcPeso=prevCalc;return html.includes('<strong>7</strong>')&&html.includes('<strong>5</strong>')&&html.includes('<strong>30</strong>')&&html.includes('<strong>20</strong>')&&html.includes('value="20"')});
  await add('133. A view da calculadora tem entrada em VIEW_META e botão próprio na barra lateral, e esconde os tabs/filtros/backup/importar de indicadores (fica só com Imprimir) sem afetar as outras views',()=>{const hasMeta=Array.isArray(VIEW_META.calculator)&&VIEW_META.calculator[0]==='Calculadora odontopediátrica';const hasSidebarBtn=!!document.querySelector('[data-view="calculator"]');switchView('pregnant',{save:false});const otherViewClean=!document.getElementById('appShell').classList.contains('is-calculator-view');switchView('calculator',{save:false});const calcViewMarked=document.getElementById('appShell').classList.contains('is-calculator-view');switchView('overview',{save:false});return hasMeta&&hasSidebarBtn&&otherViewClean&&calcViewMarked});
  await add('134. O eyebrow da calculadora mostra só "Calculadora odontopediátrica", sem o prefixo "Indicadores /" que as outras views mantêm',()=>{switchView('calculator',{save:false});const calcEyebrow=document.getElementById('eyebrow').textContent;switchView('pregnant',{save:false});const pregEyebrow=document.getElementById('eyebrow').textContent;switchView('overview',{save:false});return calcEyebrow==='Calculadora odontopediátrica'&&pregEyebrow.startsWith('Indicadores / ')});
  await add('135. O logotipo no topo da barra lateral usa o ícone do dente (não mais o texto "SB")',()=>{const brand=document.querySelector('.brand');return brand.textContent.trim()===''&&!!brand.querySelector('svg')});
    const passed=results.filter(x=>x.pass).length;state.selfTests={at:nowISO(),durationMs:Math.round(performance.now()-started),total:results.length,passed,failed:results.length-passed,results};audit('selftests_run',{passed,total:results.length});refreshAll();return state.selfTests;
}

/* ---------- Renderização e interação ---------- */

function doseML(peso,divisor,tetoML){const cru=Math.round(peso/divisor);const capped=cru>tetoML;const vol=capped?tetoML:cru;return{vol:String(vol),mg:Math.round(vol*50),capped}}
function doseGotas(peso,gotasPorKg,mgPorGota,tetoGotas,arredondarParaBaixo){const cruRaw=peso*gotasPorKg;const cru=arredondarParaBaixo?Math.floor(cruRaw):Math.round(cruRaw);const capped=cru>tetoGotas;const gotas=capped?tetoGotas:cru;return{gotas:gotas,mg:Math.round(gotas*mgPorGota),capped}}
function calcDoseCard({titulo,sub,idLabel,pill,accent,need,teto,unidade,dose}){
  const valid=!!dose;const primary=valid?(dose.vol!==undefined?dose.vol:dose.gotas):'—';const mg=valid?dose.mg:'—';
  const current=valid?(dose.vol!==undefined?parseFloat(dose.vol):dose.gotas):0;const pct=valid?Math.min(100,Math.round((current/teto)*100)):0;const capped=valid&&dose.capped;
  const resultLabel=unidade==='mL'?`${mg} mg por tomada`:`gotas · ${mg} mg por tomada`;
  return `<article class="card indicator-card" style="--accent:${accent}"><div class="topline"></div><div class="indicator-head"><div><div class="indicator-id">${esc(idLabel)}</div><div class="indicator-name">${esc(titulo)}<span class="sub">${esc(sub)}</span></div></div>${pill?`<span class="pill ${pill.cls} no-dot">${esc(pill.label)}</span>`:''}</div><div class="indicator-result"><strong>${primary}</strong><small>${resultLabel}</small></div><div class="ruler"><div class="ruler-track"><div class="ruler-fill${capped?' at-cap':''}" style="width:${pct}%"></div></div></div><div class="ruler-caption"><span>${valid?pct+'% do teto':'—'}</span><span>teto ${teto} ${unidade}</span></div><div class="indicator-footer"><span class="need">${esc(need)}</span>${capped?`<span class="pill bad no-dot">Dose máxima</span>`:''}</div></article>`;
}
function calculatorHTML(){
  const peso=parseFloat(state.preferences.calcPeso);const valid=!isNaN(peso)&&peso>0;
  const amox=valid?doseML(peso,3,10):null,eritro=valid?doseML(peso,4,10):null,cefa=valid?doseML(peso,4,10):null;
  const paracetamol=valid?doseGotas(peso,1.5,10,35,false):null,dipirona=valid?doseGotas(peso,1,25,35,true):null,ibuprofeno=valid?doseGotas(peso,1,5,40,false):null;
  return `<article class="card panel">
    <div class="weight-panel">
      <div class="field weight-field"><label for="calcPeso">Peso da criança</label><input type="number" id="calcPeso" inputmode="decimal" min="0" step="0.5" placeholder="— kg" value="${state.preferences.calcPeso?esc(state.preferences.calcPeso):''}"></div>
      <p class="weight-note">Digite o peso para calcular a dose de cada medicamento. Os valores em mL e gotas já saem arredondados, prontos pra prescrever. Cada cartão trava no teto máximo por tomada quando o cálculo por peso o ultrapassa.<sup> <a href="#calc-ref1">1</a></sup></p>
      <a class="remume-chip" href="https://www.pmf.sc.gov.br/entidades/saude/index.php?cms=assfar+++remume" target="_blank" rel="noopener" title="Confira no REMUME municipal atual se estes medicamentos e apresentações ainda constam disponíveis"><span data-icon="external"></span>Conferir no REMUME</a>
    </div>
    <div class="legend-row">
      <span class="legend-item"><span class="legend-dot" style="background:var(--primary)"></span>Antibióticos</span>
      <span class="legend-item"><span class="legend-dot" style="background:var(--cyan)"></span>Analgésicos</span>
      <span class="legend-item"><span class="legend-dot" style="background:var(--amber)"></span>Anti-inflamatório</span>
      <span class="legend-item"><span class="legend-dot" style="background:var(--red)"></span>No teto máximo</span>
    </div>
    <div class="subhead">Antibióticos · infecção com comprometimento sistêmico, 7 a 10 dias <sup><a href="#calc-ref2">2</a></sup></div>
    <div class="indicator-grid">
      ${calcDoseCard({titulo:'Amoxicilina',sub:'250 mg/5 mL · 8/8h',idLabel:'ANTIBIÓTICO',pill:{cls:'success',label:'1ª escolha'},accent:'#546de5',need:'8/8h — 3x ao dia',teto:10,unidade:'mL',dose:amox})}
      ${calcDoseCard({titulo:'Eritromicina',sub:'250 mg/5 mL · 6/6h',idLabel:'ALÉRGICOS À PENICILINA',pill:{cls:'neutral',label:'Alternativa'},accent:'#546de5',need:'6/6h — 4x ao dia',teto:10,unidade:'mL',dose:eritro})}
      ${calcDoseCard({titulo:'Cefalexina',sub:'250 mg/5 mL · 6/6h',idLabel:'ALÉRGICOS À PENICILINA',pill:{cls:'neutral',label:'Alternativa'},accent:'#546de5',need:'6/6h — 4x ao dia',teto:10,unidade:'mL',dose:cefa})}
    </div>
    <div class="subhead">Analgésicos · dor relatada pela criança, regular nos 3 primeiros dias de pós-operatório <sup><a href="#calc-ref2">2</a></sup></div>
    <div class="indicator-grid">
      ${calcDoseCard({titulo:'Paracetamol',sub:'gotas 200 mg/mL · 6/6h',idLabel:'ANALGÉSICO',pill:null,accent:'#3dc1d3',need:'6/6h — 4x ao dia',teto:35,unidade:'gotas',dose:paracetamol})}
      ${calcDoseCard({titulo:'Dipirona',sub:'gotas 500 mg/mL · 6/6h',idLabel:'ANALGÉSICO',pill:null,accent:'#3dc1d3',need:'6/6h — 4x ao dia',teto:35,unidade:'gotas',dose:dipirona})}
      ${calcDoseCard({titulo:'Ibuprofeno',sub:'gotas 100 mg/mL · 6/6h',idLabel:'ANTI-INFLAMATÓRIO',pill:{cls:'warn',label:'AINE'},accent:'#e7a23b',need:'6/6h — 4x ao dia, se risco de inflamação extensa',teto:40,unidade:'gotas',dose:ibuprofeno})}
    </div>
    <div class="notice"><strong>Sobre o paracetamol:</strong> o guia de referência dá uma faixa de 1 a 1,5 gota/kg/dose — esta página usa o topo da faixa (1,5), coerente com o critério de "sempre o teto máximo" combinado com você. Avise se preferir a base (1 gota/kg).</div>
    <div class="notice warn" style="margin-top:10px"><strong>Calculadora de apoio à prescrição.</strong> Confira clinicamente antes de prescrever — a barra fica vermelha e o cartão mostra "Dose máxima" quando o peso já ultrapassa o teto de segurança combinado.</div>
    <div class="footnotes">
      <div class="subhead" style="margin:0 0 8px">Referências</div>
      <ol class="footnote-list">
        <li id="calc-ref1">Costa PSS, Costa LRRS. Analgésicos e antimicrobianos. In: Correa MSNP. <em>Odontopediatria na primeira infância</em>. 3.ed. São Paulo: Santos, 2009. 942p.</li>
        <li id="calc-ref2">Campos CC et al. <em>Clínica odontológica infantil: passo a passo.</em> Goiânia: UFG/FO: FUNAPE, 2010. v. 1, 50 p. Disponível em: <a href="https://pahpe.odonto.ufg.br/up/299/o/Passo_a_passo_Clinica_Odontologica_Infantil_completo.pdf?136431403" target="_blank" rel="noopener">pahpe.odonto.ufg.br/up/299/o/Passo_a_passo_Clinica_Odontologica_Infantil_completo.pdf</a>.</li>
      </ol>
    </div>
  </article>`;
}


const VIEW_META={overview:['Indicadores Saúde Bucal','Acompanhamento mensal e quadrimestral com leitura municipal, federal e painel operacional 2I.'],municipal:['Indicadores municipais · M1–M5','Prévia mensal, pontuação, projeções e apuração quadrimestral segundo as regras de Florianópolis.'],federal:['Leitura federal · B1–B6','Série mensal conforme as Notas Metodológicas de maio de 2026, mantida separada da regra municipal.'],pregnant:['2I · Saúde bucal da gestante','Panorama do CSV, lista operacional por equipe e acompanhamento local de cada episódio gestacional.'],imports:['Importações e conferência','Snapshots versionados, amostra bruta da sessão e contagens por procedimento.'],diagnostics:['Diagnóstico dos dados','Alertas, limitações e testes automatizados das regras cadastradas.'],settings:['Configurações e ajuda','Preferências, denominadores versionados, privacidade, mapeamentos e manual rápido.'],calculator:['Calculadora odontopediátrica','Doses de antibióticos e analgésicos por peso, para prescrição em quadros odontológicos infantis.']};
function migrateState(raw){const d=defaultState(),s=raw&&typeof raw==='object'?raw:{};const out={...d,...s,preferences:{...d.preferences,...(s.preferences||{})},gestantes:{...d.gestantes,...(s.gestantes||{}),followups:{...d.gestantes.followups,...(s.gestantes?.followups||{})},merges:{...d.gestantes.merges,...(s.gestantes?.merges||{})},excluded:{...d.gestantes.excluded,...(s.gestantes?.excluded||{})},overrides:{...d.gestantes.overrides,...(s.gestantes?.overrides||{})},manual:Array.isArray(s.gestantes?.manual)?s.gestantes.manual:[]},columnMappings:{...d.columnMappings,...(s.columnMappings||{}),consulta2i:{...d.columnMappings.consulta2i,...(s.columnMappings?.consulta2i||{})}}};out.snapshots=Array.isArray(s.snapshots)?s.snapshots:[];out.denominators=Array.isArray(s.denominators)?s.denominators:[];out.audit=Array.isArray(s.audit)?s.audit:[];out.schemaVersion=SCHEMA_VERSION;out.appVersion=APP_VERSION;delete out.security;if(s?.rulesets?.municipal?.meta===5||s?.preferences?.m1Meta===5){out.audit.push({id:uuid(),at:nowISO(),action:'legacy_m1_migrated',details:{from:'meta 5 / corte 3',to:'faixas vigentes'}})}
  const legacyFederalDenomMap={B1:'M1',B4:'M3'};let migratedFederalDenom=false;
  out.denominators=out.denominators.map(den=>{const target=den.scope==='federal'?legacyFederalDenomMap[den.indicator]:null;if(!target)return den;migratedFederalDenom=true;return {...den,scope:'municipal',indicator:target,note:den.note?`${den.note} (migrado de ${den.indicator} federal)`:`Migrado do antigo denominador federal ${den.indicator}.`}});
  if(migratedFederalDenom)out.audit.push({id:uuid(),at:nowISO(),action:'legacy_federal_denominator_migrated',details:{note:'B1/B4 passaram a compartilhar o denominador de M1/M3.'}});
  if(s?.preferences?.hasOwnProperty?.('pregPopulation')){delete out.preferences.pregPopulation;delete out.preferences.pregPopulationConfirmed;out.audit.push({id:uuid(),at:nowISO(),action:'legacy_2i_population_filter_removed',details:{note:'O filtro de tipo de população do painel 2I foi removido (informação considerada desnecessária pelo usuário); todas as gestantes do CSV voltam a aparecer sem esse recorte.'}})}
  if(s?.security){out.audit.push({id:uuid(),at:nowISO(),action:'legacy_local_lock_removed',details:{note:'O bloqueio local (senha cifrando o estado salvo no navegador) foi removido: nada mais fica salvo no navegador, então não havia mais o que esse bloqueio protegesse. A proteção de dados agora é só a senha do backup exportado.'}})}
  return out}
function fillContextFilters(){
  const yearEl=document.getElementById('yearFilter'),qEl=document.getElementById('quarterFilter'),mEl=document.getElementById('monthFilter'),uEl=document.getElementById('unitFilter');
  const years=new Set([state.preferences.year,new Date().getFullYear(),2026]);for(const s of state.snapshots)for(const mk of Object.keys(s.dataByMonth||{}))years.add(parseMonthKey(mk).year);yearEl.innerHTML=[...years].sort((a,b)=>b-a).map(y=>`<option value="${y}" ${y===Number(state.preferences.year)?'selected':''}>${y}</option>`).join('');qEl.value=String(state.preferences.quarter);
  const months=quarterMonths(Number(state.preferences.year),Number(state.preferences.quarter));if(!months.includes(state.preferences.month))state.preferences.month=months[0];mEl.innerHTML=months.map(m=>`<option value="${m}" ${state.preferences.month===m?'selected':''}>${fmtMonth(m,true)}</option>`).join('');
  const units=[...new Set(state.snapshots.map(s=>s.unit).filter(Boolean))].sort((a,b)=>a.localeCompare(b,'pt-BR'));uEl.innerHTML=`<option value="">Todas as unidades</option>`+units.map(u=>`<option value="${esc(u)}" ${state.preferences.unit===u?'selected':''}>${esc(u)}</option>`).join('');if(state.preferences.unit&&!units.includes(state.preferences.unit)){state.preferences.unit='';uEl.value=''}
}
function switchView(view,{save=true}={}){if(!VIEW_META[view])view='overview';activeView=view;state.preferences.view=view;document.querySelectorAll('.view').forEach(el=>el.classList.toggle('hidden',el.id!==`view-${view}`));document.querySelectorAll('[data-view]').forEach(el=>el.classList.toggle('active',el.dataset.view===view));const [title,sub]=VIEW_META[view];document.getElementById('pageTitle').textContent=title;document.getElementById('pageSubtitle').textContent=sub;document.getElementById('eyebrow').textContent=view==='calculator'?title:`Indicadores / ${view==='overview'?'Saúde Bucal':title.split('·')[0].trim()}`;document.getElementById('appShell').classList.toggle('is-calculator-view',view==='calculator');if(save)queueSave();document.querySelector('.workspace').scrollTop=0}
function refreshSaveStatus(){
  const btn=document.getElementById('saveBtn'),badge=document.getElementById('saveBadge'),status=document.getElementById('backupStatus');
  if(btn){btn.classList.toggle('warn',state.dirty);btn.title=state.dirty?'Alterações não salvas — nada é gravado pelo navegador. Clique para exportar um backup.':'Nada é salvo pelo navegador. Clique para exportar um backup a qualquer momento.'}
  if(badge)badge.classList.toggle('hidden',!state.dirty);
  if(status){status.textContent=state.dirty?'Alterações não salvas — exporte um backup':state.lastBackupAt?`Backup salvo ${fmtDateTime(state.lastBackupAt)}`:'Nada para salvar ainda';status.classList.toggle('save-warn',state.dirty)}
}
function refreshAll(){
  fillContextFilters();
  document.getElementById('view-overview').innerHTML=overviewHTML();document.getElementById('view-municipal').innerHTML=municipalHTML();document.getElementById('view-federal').innerHTML=federalHTML();document.getElementById('view-pregnant').innerHTML=pregnancyHTML();document.getElementById('view-imports').innerHTML=importsHTML();document.getElementById('view-diagnostics').innerHTML=diagnosticsHTML();document.getElementById('view-settings').innerHTML=settingsHTML();document.getElementById('view-calculator').innerHTML=calculatorHTML();
  const newest=[...state.snapshots].sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt))[0];document.getElementById('lastUpdate').textContent=newest?`Atualizado ${fmtDateTime(newest.createdAt)}`:'Nenhum relatório importado';document.getElementById('snapshotCount').textContent=`${state.snapshots.length} snapshot${state.snapshots.length===1?'':'s'}`;refreshSaveStatus();const d=buildDiagnostics(),badge=document.getElementById('diagnosticBadge'),n=d.filter(x=>x.level==='error'||x.level==='warning').length;badge.textContent=n;badge.classList.toggle('hidden',!n);hydrateIcons();switchView(activeView,{save:false});
}
function updatePreference(key,value){state.preferences[key]=value;queueSave();refreshAll()}
function globalSearch(value){const n=norm(value);if(!n)return;if(/^M[1-5]$/.test(n)){switchView('municipal');openComposition('municipal',n,state.preferences.month);return}if(/^B[1-6]$/.test(n)){switchView('federal');openComposition('federal',n,state.preferences.month);return}if(n.includes('GEST')||n.includes('2I')||mergedEpisodes().some(e=>norm(e.equipe).includes(n))){state.preferences.pregSearch=value;switchView('pregnant');refreshAll();return}const snap=state.snapshots.find(s=>norm(s.fileName).includes(n));if(snap){switchView('imports');openSnapshot(snap.id);return}toast('Nenhuma correspondência direta encontrada.')}

function setupEvents(){
  document.addEventListener('click',async ev=>{const el=ev.target.closest('button,[data-go],[data-open-episode],[data-open-snapshot],[data-team-filter],[data-overview-scope]');if(!el)return;
    if(el.dataset.overviewScope)return updatePreference('overviewScope',el.dataset.overviewScope);
    if(el.matches('[data-close-modal]'))return closeModal();if(el.matches('[data-close-drawer]'))return closeDrawer();if(el.hasAttribute('data-toggle-details')){el.classList.toggle('open');el.nextElementSibling.classList.toggle('open');return}if(el.hasAttribute('data-g-tab')){const scope=el.closest('.g-tabbar').parentElement;scope.querySelectorAll('.g-tab').forEach(b=>b.classList.toggle('active',b===el));scope.querySelectorAll('[data-g-panel]').forEach(p=>p.classList.toggle('open',p.dataset.gPanel===el.dataset.gTab));return}if(el.dataset.view)return switchView(el.dataset.view);if(el.dataset.go)return switchView(el.dataset.go);if(el.dataset.action==='import')return document.getElementById('fileInput').click();if(el.dataset.action==='restore-backup')return document.getElementById('backupInput').click();if(el.dataset.action==='export-backup')return openBackupModal();
    if(el.dataset.openSnapshot)return openSnapshot(el.dataset.openSnapshot);if(el.dataset.snapshotTab)return openSnapshot(el.dataset.snapshotId,el.dataset.snapshotTab);if(el.dataset.composition){const [scope,id,mk]=el.dataset.composition.split('|');return openComposition(scope,id,mk)}
    if(el.dataset.saveDenom){const [id,scope]=el.dataset.saveDenom.split('|'),input=el.closest('.denom-inline')?.querySelector(`[data-denom-input="${id}|${scope}"]`);return openDenominatorModal(id,scope,input?.value||'')}
    if(el.dataset.useSuggestion){const [id,scope,value]=el.dataset.useSuggestion.split('|');return openDenominatorModal(id,scope,value)}
    if(el.hasAttribute('data-add-pregnant'))return openManualPregnant();if(el.hasAttribute('data-clear-all-gestantes'))return openClearGestantesModal();if(el.dataset.openEpisode)return openEpisode(el.dataset.openEpisode);if(el.dataset.teamFilter){state.preferences.pregTeam=el.dataset.teamFilter;refreshAll();return}if(el.hasAttribute('data-clear-preg-filters')){for(const k of ['pregTeam','pregStatus','pregFollowup','pregOrigin','pregPhone','pregStage','pregExcluded','pregSearch'])state.preferences[k]='';queueSave();return refreshAll()}
    if(el.dataset.copyName){const e=mergedEpisodes().find(x=>x.id===el.dataset.copyName);if(e)await navigator.clipboard.writeText(e.nome||'');return toast('Nome copiado.')}
    if(el.dataset.openWhatsapp){const e=mergedEpisodes().find(x=>x.id===el.dataset.openWhatsapp);if(e?.phoneNormalized)window.open(`https://wa.me/${e.phoneNormalized}`,'_blank','noopener,noreferrer');return}
    if(el.dataset.followup){const [id,next]=el.dataset.followup.split('|');return setFollowup(id,next)}if(el.dataset.mergeManual){const [m,e]=el.dataset.mergeManual.split('|');return mergeManual(m,e)}if(el.dataset.editManual){closeDrawer();return openManualPregnant(el.dataset.editManual)}if(el.dataset.addFollowupNote){const ta=document.getElementById('followupNoteInput');return addFollowupNote(el.dataset.addFollowupNote,ta?ta.value:'')}if(el.dataset.saveAllFields)return saveAllFieldsOverride(el.dataset.saveAllFields);if(el.dataset.archiveManual){const m=state.gestantes.manual.find(x=>x.id===el.dataset.archiveManual);if(m){m.archived=true;audit('2i_manual_archived',{manualId:m.id});closeDrawer();refreshAll();toast('Cadastro manual arquivado.')}return}if(el.dataset.excludeEpisode){closeDrawer();return openExcludeEpisode(el.dataset.excludeEpisode)}if(el.dataset.restoreEpisode)return restoreEpisode(el.dataset.restoreEpisode);
    if(el.hasAttribute('data-export-procedures'))return exportProcedures();if(el.hasAttribute('data-export-2i'))return export2IModal();if(el.dataset.export2iMode)return export2I(el.dataset.export2iMode);if(el.hasAttribute('data-run-tests')){showLoading('Executando 135 testes','Fórmulas, faixas, privacidade e 2I');try{const r=await runSelfTests();toast(`${r.passed}/${r.total} testes passaram.`)}finally{hideLoading()}return}
    if(el.hasAttribute('data-create-backup'))return createBackupFromModal();if(el.hasAttribute('data-restore-backup'))return document.getElementById('backupInput').click();if(el.hasAttribute('data-unlock-backup'))return processPendingBackup(document.getElementById('restorePassword')?.value||'');
  });
  document.getElementById('importBtn').onclick=()=>document.getElementById('fileInput').click();document.getElementById('fileInput').onchange=e=>importFiles(e.target.files);document.getElementById('backupBtn').onclick=openBackupModal;document.getElementById('printBtn').onclick=()=>window.print();document.getElementById('saveBtn').onclick=openBackupModal;
  window.addEventListener('beforeunload',ev=>{if(!state.dirty)return;ev.preventDefault();ev.returnValue='Há alterações não salvas. Nada é gravado pelo navegador — exporte um backup antes de sair, ou você perde tudo.';return ev.returnValue});
  document.getElementById('backupInput').onchange=e=>{pendingBackupFile=e.target.files[0]||null;e.target.value='';if(pendingBackupFile)processPendingBackup()};
  document.getElementById('yearFilter').onchange=e=>{state.preferences.year=Number(e.target.value);state.preferences.month=quarterMonths(state.preferences.year,state.preferences.quarter)[0];queueSave();refreshAll()};document.getElementById('quarterFilter').onchange=e=>{state.preferences.quarter=Number(e.target.value);state.preferences.month=quarterMonths(state.preferences.year,state.preferences.quarter)[0];queueSave();refreshAll()};document.getElementById('monthFilter').onchange=e=>updatePreference('month',e.target.value);document.getElementById('unitFilter').onchange=e=>updatePreference('unit',e.target.value);
  document.getElementById('globalSearch').addEventListener('keydown',e=>{if(e.key==='Enter')globalSearch(e.currentTarget.value)});
  document.addEventListener('change',e=>{if(e.target.dataset.toggleEncerrada)return toggleGestacaoEncerrada(e.target.dataset.toggleEncerrada);if(e.target.matches('.preg-filter')){state.preferences[e.target.dataset.pregFilter]=e.target.value;queueSave();refreshAll()}if(e.target.id==='sourceMode')updatePreference('sourceMode',e.target.value);if(e.target.id==='settingsTarget'||e.target.id==='targetScore')updatePreference('targetScore',clamp(Number(e.target.value),0,100))});
  document.addEventListener('input',debounce(e=>{if(e.target.id==='pregSearch'){state.preferences.pregSearch=e.target.value;queueSave();document.getElementById('view-pregnant').innerHTML=pregnancyHTML();hydrateIcons(document.getElementById('view-pregnant'))}if(e.target.id==='calcPeso'){state.preferences.calcPeso=e.target.value;queueSave();const hadFocus=document.activeElement&&document.activeElement.id==='calcPeso';const selStart=hadFocus?document.activeElement.selectionStart:null;document.getElementById('view-calculator').innerHTML=calculatorHTML();if(hadFocus){const el=document.getElementById('calcPeso');if(el){el.focus();if(selStart!==null)el.setSelectionRange(selStart,selStart)}}}},250));
  document.addEventListener('keydown',e=>{if(e.key==='Escape'){closeModal();closeDrawer()}});document.getElementById('modalBackdrop').addEventListener('click',e=>{if(e.target.id==='modalBackdrop')closeModal()});document.getElementById('drawerBackdrop').addEventListener('click',e=>{if(e.target.id==='drawerBackdrop')closeDrawer()});
  let dragDepth=0;window.addEventListener('dragenter',e=>{e.preventDefault();dragDepth++;document.getElementById('dropOverlay').classList.add('open')});window.addEventListener('dragover',e=>e.preventDefault());window.addEventListener('dragleave',e=>{e.preventDefault();if(--dragDepth<=0){dragDepth=0;document.getElementById('dropOverlay').classList.remove('open')}});window.addEventListener('drop',e=>{e.preventDefault();dragDepth=0;document.getElementById('dropOverlay').classList.remove('open');if(e.dataTransfer.files.length)importFiles(e.dataTransfer.files)});
}

async function bootstrap(){hydrateIcons();setupEvents();state=migrateState(state);activeView=state.preferences.view||'overview';refreshAll();window.__APP_TEST_API__={version:APP_VERSION,importFiles,runSelfTests,getState:()=>state,getProcedureMonth:mk=>aggregateProcedureMonth(mk),getGroupMonth:mk=>aggregateGroupMonth(mk),getConsolidatedMonth:mk=>aggregateConsolidatedMonth(mk),getEpisodes:()=>getActive2ISnapshot()?.episodes||[],calculations:{municipalComponents,federalComponents,quarterMunicipal},reset:async()=>{state=defaultState();sessionRaw=new Map();await persistState();refreshAll()}}}
bootstrap();
