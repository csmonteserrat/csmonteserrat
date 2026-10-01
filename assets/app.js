/* Acompanhamento Odontológico — aplicação local-first
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

const APP_VERSION = '2.35';
const SELF_TEST_COUNT = 276;
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
        {label:'Ótimo',test:v=>v>1.25,color:'#2cc08b'},
        {label:'Bom',test:v=>v>0.75,color:'#2f80ed'},
        {label:'Suficiente',test:v=>v>0.25,color:'#f7821f'},
        {label:'Regular',test:()=>true,color:'#f0483e'}
      ],formula:'100 × primeiras consultas programadas ÷ denominador manual confirmado do indicador 1'},
      M2:{name:'Tratamento concluído',weight:1,cutoff:25,meta:50,polarity:'higher',formula:'100 × tratamentos concluídos ÷ primeiras consultas programadas'},
      M3:{name:'Escovação supervisionada (6 a 12 anos)',weight:1,cutoff:.5,meta:1,polarity:'higher',formula:'100 × participantes presentes ÷ denominador manual confirmado do indicador 3'},
      M4:{name:'Procedimentos preventivos individuais',weight:1,cutoff:20,meta:40,polarity:'higher',formula:'100 × procedimentos preventivos ÷ procedimentos da lista da Nota B5 (mesma conta da B5)'},
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

// nonDental: a fonte lança essas linhas na coluna "Procedimento" do relatório, mas o próprio usuário
// (cirurgião-dentista) confirmou que não são procedimentos odontológicos de fato — só registros
// administrativos/de atendimento (consulta, visita, apoio matricial) ou já contados em outro lugar
// (primeira consulta/tratamento concluído, que viram M1/M2 por campos próprios, não pela contagem de
// "procedimentos"). Continuam entrando no denominador de M4 (role m4den) e no "Resumo por procedimento"
// de Configurações — nada normativo mudou — mas saem do recorte de %, gráficos e tabelas da página
// Procedimentos (Agrupar por Procedimento/Dentista/Histórico mensal/Ano), que é uma leitura clínica dos
// procedimentos realizados, não um espelho 1:1 de toda linha do relatório. Ver groupProcedureItems.
// groupActivity: marca a única exceção que, além de sair da conta de "procedimentos", também alimenta a
// aba "Atividades coletivas" (Assunto), lado a lado com a evolução de Escovação Supervisionada — ver
// buildProcedureSnapshotFromRows (groupSubjectFromProcedures) e aggregateGroupMonth.
const PROCEDURE_RULES = [
  {re:/^PRIMEIRA CONSULTA ODONTOLOGICA/,code:'03.01.01.015-3',name:'Primeira consulta odontológica programada',roles:['first'],nonDental:true},
  {re:/^TRATAMENTO CONCLUIDO/,code:'',name:'Tratamento concluído (campo Conduta)',roles:['concluded'],nonDental:true},
  // Nota de registro da atividade em grupo que vaza para o relatório individual: não é procedimento, não entra em
  // indicador nem na página Procedimentos (v2.20).
  {re:/^EVOLUCAO DA ATIVIDADE EM GRUPO/,code:'',name:'Evolução da atividade em grupo (nota de registro)',roles:[],nonDental:true},
  {re:/ATIVIDADE EDUCATIVA\s+ORIENTA(?:C|Ç)AO EM GRUPO/,code:'',name:'Atividade educativa / orientação em grupo na atenção primária',roles:['m4den'],nonDental:true,groupActivity:true},
  {re:/ORIENTA(?:C|Ç)AO (?:DE|EM) HIGIENE BUCAL/,code:'01.01.02.010-4',name:'Orientação em higiene bucal',roles:['preventive','m4den','b5den']},
  {re:/ORIENTA(?:C|Ç)AO DE HIGIENIZA(?:C|Ç)AO DE/,code:'01.01.02.012-0',name:'Orientação de higienização de próteses',roles:['preventive','m4den','b5den','b3den']},
  {re:/APLICA(?:C|Ç)AO DE CARIOSTATICO/,code:'01.01.02.005-8',name:'Aplicação de cariostático',roles:['preventive','m4den','b5den','b3den']},
  {re:/APLICA(?:C|Ç)AO DE SELANTE/,code:'01.01.02.006-6',name:'Aplicação de selante',roles:['preventive','m4den','b5den','b3den']},
  {re:/APLICA(?:C|Ç)AO TOPICA DE FLUOR/,code:'01.01.02.007-4',name:'Aplicação tópica de flúor',roles:['preventive','m4den','b5den','b3den']},
  {re:/EVIDENCIA(?:C|Ç)AO DE PLACA/,code:'01.01.02.008-2',name:'Evidenciação de placa bacteriana',roles:['preventive','m4den','b5den','b3den']},
  {re:/PROFILAXIA\s+REMO(?:C|Ç)AO DA PLACA/,code:'03.07.03.004-0',name:'Profilaxia/remoção da placa',roles:['preventive','m4den','b5den','b3den']},
  {re:/RETIRADA DE PONTOS DE CIRURGIAS/,code:'',name:'Retirada de pontos de cirurgias (por paciente)',roles:['m4den']},
  {re:/^ATENDIMENTO ODONTOLOGICO$/,code:'',name:'Atendimento odontológico (registro geral de atendimento)',roles:['m4den'],nonDental:true},
  {re:/^ATENDIMENTO$/,code:'',name:'Atendimento (registro genérico)',roles:['m4den'],nonDental:true},
  {re:/ATENDIMENTO DE URGENCIA/,code:'',name:'Atendimento de urgência em atenção',roles:['m4den'],nonDental:true},
  {re:/AFERICAO DE PRESSAO ARTERIAL/,code:'',name:'Aferição de pressão arterial',roles:['m4den']},
  {re:/CONSULTA DE PROFISSIONAIS DE NIVEL/,code:'',name:'Consulta de profissionais de nível superior',roles:['m4den'],nonDental:true},
  {re:/ATIVIDADE DE APOIO MATRICIAL/,code:'',name:'Atividade de apoio matricial em cuidados paliativos',roles:['m4den'],nonDental:true},
  {re:/^VISITA DOMICILIAR/,code:'',name:'Visita domiciliar/institucional por profissional de nível superior',roles:['m4den'],nonDental:true},
  {re:/CURETAGEM PERIAPICAL/,code:'',name:'Curetagem periapical',roles:['m4den']},
  {re:/ODONTOSECCAO RADILECTOMIA/,code:'',name:'Odontossecção / radiculectomia',roles:['m4den']},
  // As duas grafias do CELK ("Excisão e/ou sutura simples de pequenas lesões…" e "Excisão de lesão e/ou sutura de
  // ferimento…") ficam num item só na página Procedimentos (v2.20). Nenhuma entra em indicador.
  {re:/EXCISAO (?:E OU SUTURA SIMPLES|DE LESAO E OU SUTURA)/,code:'',name:'Excisão e/ou sutura de lesão (pele, anexos e mucosa)',roles:['m4den']},
  {re:/CORRECAO DE IRREGULARIDADES/,code:'',name:'Correção de irregularidades',roles:['m4den']},
  {re:/^AJUSTE OCLUSAL$/,code:'',name:'Ajuste oclusal',roles:['m4den']},
  {re:/EXODONTIA DE DENTE DECIDUO/,code:'',name:'Exodontia de dente decíduo',roles:['m4den']},
  {re:/SELAMENTO PROVISORIO DE CAVIDADE/,code:'01.01.02.009-0',name:'Selamento provisório de cavidade',roles:['m4den','b5den','b3den']},
  {re:/CAPEAMENTO PULPAR/,code:'03.07.01.001-5',name:'Capeamento pulpar',roles:['m4den','b5den','b3den']},
  {re:/TRATAMENTO INICIAL DO DENTE/,code:'03.07.01.006-6',name:'Tratamento inicial do dente traumatizado',roles:['m4den','b5den','b3den']},
  {re:/TRATAMENTO RESTAURADOR/,code:'03.07.01.007-4',name:'Tratamento restaurador atraumático (ART)',roles:['art','restorative','m4den','b5den','b3den']},
  // Restaurações com a descrição completa (como no CSV do CELK) ganham o tipo e o SIGTAP da Nota B5; as regras
  // genéricas logo abaixo só pegam a descrição cortada (PDF), sem o tipo (v2.19).
  {re:/RESTAURA(?:C|Ç)AO DE DENTE PERMANENTE ANTERIOR COM RESINA/,code:'03.07.01.003-1',name:'Restauração de dente permanente anterior com resina composta',roles:['restorative','m4den','b5den','b3den']},
  {re:/RESTAURA(?:C|Ç)AO DE DENTE PERMANENTE POSTERIOR COM RESINA/,code:'03.07.01.012-0',name:'Restauração de dente permanente posterior com resina composta',roles:['restorative','m4den','b5den','b3den']},
  {re:/RESTAURA(?:C|Ç)AO DE DENTE DECIDUO POSTERIOR COM RESINA/,code:'03.07.01.008-2',name:'Restauração de dente decíduo posterior com resina composta',roles:['restorative','m4den','b5den','b3den']},
  {re:/RESTAURA(?:C|Ç)AO DE DENTE DECIDUO POSTERIOR COM IONOMERO/,code:'03.07.01.010-4',name:'Restauração de dente decíduo posterior com ionômero de vidro',roles:['restorative','m4den','b5den','b3den']},
  {re:/RESTAURA(?:C|Ç)AO DE DENTE DECIDUO ANTERIOR COM RESINA/,code:'03.07.01.011-2',name:'Restauração de dente decíduo anterior com resina composta',roles:['restorative','m4den','b5den','b3den']},
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
// Só redesenha o ícone quando ele ainda não foi desenhado (ou mudou): evita reescrever centenas de SVGs a cada atualização.
function hydrateIcons(root=document){ root.querySelectorAll('[data-icon]').forEach(el=>{ if(el.dataset.iconDone===el.dataset.icon&&el.firstChild)return; el.innerHTML=icon(el.dataset.icon); el.dataset.iconDone=el.dataset.icon; }); }
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
// Guarda o resultado por texto: a lista de gestantes lê as mesmas datas centenas de vezes a cada atualização (v2.22).
const parseDateCache=new Map();
function parseDate(v){
  if(!v)return null;if(v instanceof Date)return isNaN(v)?null:v;
  if(typeof v==='string'&&parseDateCache.has(v)){const t=parseDateCache.get(v);return t==null?null:new Date(t)}
  const d=parseDateRaw(v);if(typeof v==='string'){if(parseDateCache.size>20000)parseDateCache.clear();parseDateCache.set(v,d?+d:null)}return d;
}
function parseDateRaw(v){
  const s=String(v).trim();let m=s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2}))?/);
  if(m){const d=new Date(+m[3],+m[2]-1,+m[1],+(m[4]||0),+(m[5]||0));return isNaN(d)?null:d;}
  m=s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if(m){const d=new Date(+m[1],+m[2]-1,+m[3],+(m[4]||0),+(m[5]||0),+(m[6]||0));return isNaN(d)?null:d;}
  m=s.match(/^([A-Za-z]{3})\s+(\d{1,2}),\s*(\d{4})/);if(m&&EN_MONTH[m[1].toLowerCase()])return new Date(+m[3],EN_MONTH[m[1].toLowerCase()]-1,+m[2]);
  const d=new Date(s);return isNaN(d)?null:d;
}
// Converte uma data colada (dd/mm/aaaa, dd-mm-aaaa, dd.mm.aa, aaaa-mm-dd, com ou sem hora) para aaaa-mm-dd,
// o formato do campo de data do navegador; devolve '' quando o texto não é uma data válida (v2.22).
function pastedDateToIso(text){
  const t=String(text||'').trim();let m=t.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2}|\d{4})\b/),y,mo,d;
  if(m){d=+m[1];mo=+m[2];y=m[3].length===2?2000+Number(m[3]):+m[3]}else{m=t.match(/^(\d{4})[\/.\-](\d{1,2})[\/.\-](\d{1,2})\b/);if(!m)return '';y=+m[1];mo=+m[2];d=+m[3]}
  const dt=new Date(y,mo-1,d);if(dt.getFullYear()!==y||dt.getMonth()!==mo-1||dt.getDate()!==d)return '';
  return `${y}-${String(mo).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
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
function idPrefix(v){const m=String(v??'').match(/^\(\s*(\d+)\s*\)/);return m?m[1]:''}
function stripIdPrefix(v){return String(v??'').replace(/^\(\s*[0-9A-Za-z]+\s*\)\s*/,'').trim();}
function isScientificNotation(v){return /^\s*-?\d+([.,]\d+)?e[+\-]?\d+\s*$/i.test(String(v??''));}
function safeFileName(v){return norm(v).toLowerCase().replace(/\s+/g,'-').replace(/[^a-z0-9-]/g,'').slice(0,60)||'arquivo';}
function bytesToBase64(bytes){let out='';const chunk=0x8000;for(let i=0;i<bytes.length;i+=chunk)out+=String.fromCharCode(...bytes.subarray(i,i+chunk));return btoa(out)}
function base64ToBytes(s){const b=atob(s);const u=new Uint8Array(b.length);for(let i=0;i<b.length;i++)u[i]=b.charCodeAt(i);return u}
async function sha256(value){const bytes=value instanceof ArrayBuffer?new Uint8Array(value):value instanceof Uint8Array?value:new TextEncoder().encode(String(value));const hash=await crypto.subtle.digest('SHA-256',bytes);return [...new Uint8Array(hash)].map(b=>b.toString(16).padStart(2,'0')).join('');}
function downloadFile(name,content,type='application/octet-stream'){const blob=content instanceof Blob?content:new Blob([content],{type});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000)}

function defaultState(){
  const d=new Date();return {
    schemaVersion:SCHEMA_VERSION,appVersion:APP_VERSION,createdAt:nowISO(),updatedAt:nowISO(),snapshots:[],denominators:[],populationInputs:[],
    columnMappings:{consulta2i:{}},parserProfiles:{procedimentos:'CELK-PROC-1.0',atividades:'CELK-GRUPO-1.0',metabase:'METABASE-ESB-1.0',gestantes:'METABASE-2I-1.1'},
    gestantes:{manual:[],followups:{},merges:{},excluded:{},overrides:{},puerperioIgnored:{}},pse:{mine:{},dec:{},overrides:{},followups:{}},patientDirectory:{},manualOverrides:[],audit:[],lastBackupAt:null,dirty:false,
    preferences:{year:d.getFullYear(),quarter:quarterOfMonth(d.getMonth()+1),month:monthKey(d.getFullYear(),d.getMonth()+1),unit:'',view:'overview',settingsTab:'geral',sourceMode:'auto',targetScore:100,overviewScope:'month',pregTeam:'',pregTab:'a_contatar',pregPrioOnly:false,pregIncomplete:false,pregMoreFilters:false,pregOrigin:'',pregPhone:'',pregExcluded:'',pregSearch:'',calcPeso:'',
      pseTab:'panorama',pseEquipes:[],pseCamp:'all',pseEscola:'',pseTurma:'',pseSearch:'',procSource:'individual',procView:'overview',procPeriod:'Q',procOpenCats:['Periodontia','Preventivos'],procTab:'charts',procGroupBy:'procedure',procChartType:'bars',procRefineOpen:false,procCompareOpen:false,procSex:'',procAge:'',procDentist:'',procMonth:'',procSingleProcedure:'',procSingleAllMonths:false,procCompareSelection:[]},
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

/* Salvamento no navegador (v2.13): o estado é gravado automaticamente no IndexedDB deste navegador
 * (sem o limite de ~5 MB do localStorage) e volta quando o app é reaberto. Pode ser desligado em
 * Configurações. A amostra bruta dos arquivos (`sessionRaw`, com as linhas originais e nomes) continua
 * só na memória da aba. `state.dirty` continua significando "há mudanças que ainda não estão num backup
 * exportado" — o backup em arquivo segue sendo o único jeito de levar os dados para outro computador. */
const LOCAL_DB='indicadores-saude-bucal',LOCAL_STORE='kv',LOCAL_KEY='state',AUTOSAVE_PREF='isb-autosave';
let localSave={enabled:true,lastSavedAt:null,error:'',timer:null,pendingClearAfterBackup:false};
function readAutosavePref(){try{return localStorage.getItem(AUTOSAVE_PREF)!=='off'}catch{return true}}
function writeAutosavePref(on){try{localStorage.setItem(AUTOSAVE_PREF,on?'on':'off')}catch{}}
function openLocalDB(){return new Promise((resolve,reject)=>{if(typeof indexedDB==='undefined')return reject(new Error('Este navegador não oferece IndexedDB.'));const req=indexedDB.open(LOCAL_DB,1);req.onupgradeneeded=()=>req.result.createObjectStore(LOCAL_STORE);req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error)})}
async function localDB(mode,fn){const db=await openLocalDB();try{return await new Promise((resolve,reject)=>{const tx=db.transaction(LOCAL_STORE,mode),req=fn(tx.objectStore(LOCAL_STORE));tx.oncomplete=()=>resolve(req?.result);tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error)})}finally{db.close()}}
async function saveToBrowserNow(){clearTimeout(localSave.timer);localSave.timer=null;if(!localSave.enabled)return;try{const at=nowISO();await localDB('readwrite',st=>st.put({savedAt:at,appVersion:APP_VERSION,state:JSON.parse(JSON.stringify(state))},LOCAL_KEY));localSave.lastSavedAt=at;localSave.error=''}catch(e){localSave.error=e?.message||String(e)}refreshSaveStatus()}
function scheduleBrowserSave(){if(!localSave.enabled)return;clearTimeout(localSave.timer);localSave.timer=setTimeout(saveToBrowserNow,600)}
async function loadFromBrowser(){try{return await localDB('readonly',st=>st.get(LOCAL_KEY))||null}catch(e){localSave.error=e?.message||String(e);return null}}
async function deleteBrowserCopy(){clearTimeout(localSave.timer);localSave.timer=null;try{await localDB('readwrite',st=>st.delete(LOCAL_KEY))}catch(e){localSave.error=e?.message||String(e)}localSave.lastSavedAt=null}
async function clearBrowserData(){await deleteBrowserCopy();state=defaultState();sessionRaw=new Map();pregDrawer={id:null,tab:'acomp',edit:false,sched:false};prodIndexCache={key:'',map:new Map()};closeModal();closeDrawer();activeView='overview';refreshAll();toast('Dados apagados deste navegador. A tela voltou ao início.')}
async function setAutosave(on){localSave.enabled=on;writeAutosavePref(on);if(on){await saveToBrowserNow();toast('Salvamento automático ligado: os dados ficam guardados neste navegador.')}else{await deleteBrowserCopy();toast('Salvamento automático desligado. A cópia guardada neste navegador foi apagada; os dados continuam abertos nesta aba até você fechá-la.')}refreshAll()}
function openClearBrowserModal(){const n=state.snapshots.length,g=mergedEpisodes().length;openModal(`<div class="modal-head"><div><h2 id="modalTitle">Limpar dados do navegador</h2><p>Apaga tudo o que o app guardou neste navegador e esvazia a tela.</p></div></div><div class="modal-body"><div class="notice danger"><strong>Depois de limpar, os dados só voltam com um arquivo de backup.</strong> Hoje há ${fmtNum(n)} relatório(s) importado(s) e ${fmtNum(g)} gestante(s) na lista. ${state.lastBackupAt?`Último backup exportado em ${fmtDateTime(state.lastBackupAt)}${state.dirty?', mas houve mudanças depois dele':''}.`:'Nenhum backup foi exportado ainda.'}</div><p style="margin:14px 0 0;font-weight:700">Quer salvar um backup antes de limpar?</p></div><div class="modal-foot"><button class="btn" data-close-modal>Cancelar</button><button class="btn danger" data-clear-no-backup>Limpar sem backup</button><button class="btn primary" data-clear-with-backup>${icon('database')}Salvar backup e limpar</button></div>`)}
async function deriveKey(password,salt,usage=['encrypt','decrypt']){const base=await crypto.subtle.importKey('raw',new TextEncoder().encode(password),'PBKDF2',false,['deriveKey']);return crypto.subtle.deriveKey({name:'PBKDF2',salt,iterations:250000,hash:'SHA-256'},base,{name:'AES-GCM',length:256},false,usage)}
async function encryptJSON(payload,password){const salt=crypto.getRandomValues(new Uint8Array(16)),iv=crypto.getRandomValues(new Uint8Array(12)),key=await deriveKey(password,salt);const plain=new TextEncoder().encode(JSON.stringify(payload));const cipher=await crypto.subtle.encrypt({name:'AES-GCM',iv},key,plain);return {encrypted:true,kdf:'PBKDF2-SHA256',iterations:250000,cipher:'AES-GCM',salt:bytesToBase64(salt),iv:bytesToBase64(iv),ciphertext:bytesToBase64(new Uint8Array(cipher))}}
async function decryptJSON(wrapper,password){const salt=base64ToBytes(wrapper.salt),iv=base64ToBytes(wrapper.iv),key=await deriveKey(password,salt);const plain=await crypto.subtle.decrypt({name:'AES-GCM',iv},key,base64ToBytes(wrapper.ciphertext));return JSON.parse(new TextDecoder().decode(plain))}
async function persistState(){state.updatedAt=nowISO();refreshSaveStatus();scheduleBrowserSave()}
const queueSave=()=>{state.dirty=true;state.updatedAt=nowISO();refreshSaveStatus();scheduleBrowserSave()};
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

// Motor de agregação compartilhado por PDF e CSV de "Procedimentos Detalhado": recebe linhas já
// normalizadas no formato {patient,age,sex,date(DD/MM/YYYY),professional,procedure,unitOrigin,quantity,page?}
// e preenche snap.dataByMonth/snap.procedureCounts/snap.validations. Mantido como função pura (sem side
// effect fora de `snap`) para poder ser testado direto com linhas sintéticas, sem precisar de PDF/CSV real.
// Faixas etárias e sexo usados na página Procedimentos (Agrupar por Idade/Sexo e Refinar > cruzamento
// avançado). Guardadas agregadas por mês (crossRows) — não por linha crua — para sobreviver a um backup
// exportado/restaurado (sessionRaw, que tem a linha crua com nome do paciente, só existe na memória da aba).
function ageBandLabel(raw){const m=String(raw??'').match(/\d+/);if(!m)return '';const age=Number(m[0]);if(!Number.isFinite(age)||age<0)return '';if(age<=5)return '0-5';if(age<=11)return '6-11';if(age<=17)return '12-17';if(age<=59)return '18-59';return '60+'}
function sexLabel(raw){const c=String(raw??'').trim().toUpperCase().charAt(0);return c==='F'?'Feminino':c==='M'?'Masculino':''}
function buildProcedureSnapshotFromRows(snap,allRows){
  const names={};for(const r of allRows){const k=pid(r.patientId),nome=stripIdPrefix(r.patient);if(k&&nome)names[k]=nome}if(Object.keys(names).length)snap.patientNames=names;
  const monthGroups={};for(const r of allRows){const d=parseDate(r.date);if(!d)continue;const mk=monthKey(d.getFullYear(),d.getMonth()+1);(monthGroups[mk]??=[]).push(r)}
  const procGlobal={};
  for(const [mk,rows] of Object.entries(monthGroups)){
    const byProcedure={},firstPeople=new Set(),concludedPeople=new Set(),firstPatients=[],concludedPatients=[],byCross={},visitSeen=new Set(),visitsList=[];
    const groupActivityDates=new Set();let groupActivityPresent=0,groupActivitySubject='';const patientVisits=new Map();
    for(const r of rows){const match=procedureMatch(r.procedure);const key=norm(match.name);const pr=byProcedure[key]??={descriptionOriginal:r.procedure,descriptionVariants:new Set(),descriptionNormalized:match.name,sigtap:match.code,quantityRaw:0,quantityValid:0,lineCount:0,roles:match.roles,ambiguous:!!match.ambiguous,unrecognized:!!match.unrecognized,outOfScope:!!match.outOfScope,nonDental:!!match.nonDental,pages:new Set(),professionals:{}};pr.descriptionVariants.add(r.procedure);pr.quantityRaw+=r.quantity;pr.quantityValid+=r.quantity;pr.lineCount++;pr.pages.add(r.page);pr.professionals[r.professional]=(pr.professionals[r.professional]||0)+r.quantity;byProcedure[key]=pr;
      if(!match.nonDental){const crossKey=`${key}${r.professional||''}${sexLabel(r.sex)}${ageBandLabel(r.age)}`;const cr=byCross[crossKey]??={procKey:key,procLabel:match.name,professional:r.professional||'',sex:sexLabel(r.sex),age:ageBandLabel(r.age),quantity:0};cr.quantity+=r.quantity;byCross[crossKey]=cr}
      if(match.groupActivity){groupActivityDates.add(r.date);groupActivityPresent+=r.quantity;groupActivitySubject=match.name}
      else if(r.patientId){const id=pid(r.patientId),day=isoDate(r.date);if(id&&day){const v=patientVisits.get(`${id}|${day}`)||{id,date:day,procs:[],items:[]};if(v.procs.length<4&&!v.procs.includes(match.name))v.procs.push(match.name);
        // Análise estatística (v2.28): sexo, idade e todos os registros do dia (procedimento, quantidade, dentista e papel), sem nome.
        const sx=sexLabel(r.sex),ag=String(r.age??'').match(/(\d+)\s*(A|M|D)?/i);if(sx)v.sex=sx;if(v.age==null&&ag)v.age=/^[MD]/i.test(ag[2]||'')?0:Number(ag[1]);
        if(!/^EVOLUCAO DA ATIVIDADE EM GRUPO/.test(norm(r.procedure))){const fl=(match.roles.includes('first')?'f':'')+(match.roles.includes('concluded')?'c':'')+(match.nonDental?'n':'')+(/ATENDIMENTO DE URGENCIA/.test(norm(r.procedure))?'u':''),it=v.items.find(x=>x[0]===match.name&&x[2]===(r.professional||''));if(it)it[1]+=r.quantity;else v.items.push([match.name,r.quantity,r.professional||'',fl])}
        patientVisits.set(`${id}|${day}`,v)}}
      const vKey=`${norm(r.patient)}|${r.date}`;if(r.patient&&r.date&&!visitSeen.has(vKey)){visitSeen.add(vKey);visitsList.push({patient:norm(r.patient),date:r.date})}
      if(match.roles.includes('first')){firstPeople.add(norm(r.patient));firstPatients.push({name:r.patient,date:r.date,quantity:r.quantity})}
      if(match.roles.includes('concluded')){concludedPeople.add(norm(r.patient));concludedPatients.push({name:r.patient,date:r.date,quantity:r.quantity})}
    }
    // Quando duas grafias diferentes se fundiram na mesma chave canônica (>1 variante), mostra o nome
    // canônico (ex.: "Orientação em higiene bucal") em vez de uma grafia bruta escolhida ao acaso; com só
    // 1 variante, preserva o texto exatamente como veio do relatório, sem mudança de comportamento.
    const procs=Object.values(byProcedure).map(({descriptionVariants,...p})=>({...p,descriptionOriginal:descriptionVariants.size>1?p.descriptionNormalized:[...descriptionVariants][0],pages:[...p.pages].filter(x=>x!=null).sort((a,b)=>a-b)}));
    const roleQty=role=>sum(procs.filter(p=>p.roles.includes(role)).map(p=>p.quantityValid));
    // M4 (municipal): "número total de procedimentos individuais no mês", excluindo só primeira consulta,
    // tratamento concluído e a nota de evolução de atividade em grupo que vaza para este relatório.
    // Propositalmente inclui procedimentos ainda não identificados: são procedimentos individuais reais,
    // só não catalogados ainda. B5 (federal) é diferente: usa lista fechada de SIGTAP (role 'b5den'), sem
    // expandir automaticamente para itens não catalogados.
    const isGroupNote=p=>/^EVOLUCAO DA ATIVIDADE EM GRUPO/.test(norm(p.descriptionOriginal));
    const individualM4=sum(procs.filter(p=>!p.roles.includes('first')&&!p.roles.includes('concluded')&&!isGroupNote(p)).map(p=>p.quantityValid));
    snap.dataByMonth[mk]={kind:'procedure',firstConsultations:firstPeople.size,firstConsultationQuantity:roleQty('first'),treatmentsConcluded:concludedPeople.size,treatmentConcludedQuantity:roleQty('concluded'),preventive:roleQty('preventive'),individualProcedures:individualM4,art:roleQty('art'),restorative:roleQty('restorative'),b5Denominator:roleQty('b5den'),b3Numerator:roleQty('b3num'),b3Denominator:roleQty('b3den'),procedureCounts:procs,firstPatients,concludedPatients,crossRows:Object.values(byCross),visitsList,visitCount:visitsList.length,patientVisits:[...patientVisits.values()],groupSubjectFromProcedures:groupActivityDates.size?[{subject:groupActivitySubject,activities:groupActivityDates.size,present:groupActivityPresent}]:[]};
    for(const p of procs){const g=procGlobal[p.descriptionNormalized]??={...p,quantityRaw:0,quantityValid:0,lineCount:0,pages:new Set(),professionals:{}};g.quantityRaw+=p.quantityRaw;g.quantityValid+=p.quantityValid;g.lineCount+=p.lineCount;p.pages.forEach(x=>g.pages.add(x));for(const [n,q] of Object.entries(p.professionals))g.professionals[n]=(g.professionals[n]||0)+q;procGlobal[p.descriptionNormalized]=g}
    if(roleQty('first')!==firstPeople.size)snap.validations.push({level:'warning',code:'M1_QUANTITY_VS_PEOPLE',month:mk,message:`Primeira consulta: a fonte soma ${roleQty('first')} na coluna quantidade, mas contém ${firstPeople.size} pessoas distintas pelo nome exibido. A prévia usa pessoas distintas.`});
    if(roleQty('concluded')!==concludedPeople.size)snap.validations.push({level:'warning',code:'M2_QUANTITY_VS_PEOPLE',month:mk,message:`Tratamento concluído: a fonte soma ${roleQty('concluded')} na coluna quantidade, mas contém ${concludedPeople.size} pessoas distintas pelo nome exibido. A prévia usa pessoas distintas.`});
  }
  snap.procedureCounts=Object.values(procGlobal).map(p=>({...p,pages:[...p.pages].sort((a,b)=>a-b)}));
  if(snap.procedureCounts.some(p=>p.ambiguous))snap.validations.push({level:'warning',code:'TRUNCATED_RESTORATION',message:'O CELK abrevia descrições de restaurações. Elas entram na família restauradora, mas o SIGTAP específico não é afirmado.'});
}
// Dado um conjunto de linhas já com {unitOrigin}, decide qual unidade "vale" para o snapshot (a mais
// frequente no arquivo) e reporta quantas linhas tinham uma unidade de origem diferente registrada.
// Usado pelo CSV de "Procedimentos Detalhado", que pode trazer mais de uma unidade no mesmo arquivo
// (ex.: um profissional que atende em mais de um CS, ou um paciente de outra unidade que foi atendido
// aqui) — o PDF nunca tem esse problema porque cada relatório já é emitido para uma única unidade.
// IMPORTANTE: todas as linhas contam para a produção da unidade majoritária, nenhuma é descartada — se a
// linha está neste documento, o atendimento aconteceu na unidade majoritária, mesmo que o cadastro do
// paciente/profissional seja de outra unidade.
function pickDominantUnit(rows){
  const counts={};for(const r of rows){const u=r.unitOrigin||'';counts[u]=(counts[u]||0)+1}
  const sorted=Object.entries(counts).sort((a,b)=>b[1]-a[1]);
  const keepUnit=sorted[0]?.[0]||'';
  const otherUnitCounts={};for(const [u,c] of sorted)if(u!==keepUnit)otherUnitCounts[u]=c;
  return {keepUnit,otherUnitCounts};
}

async function parseProcedurePdf(file,hash,pages){
  const meta=extractPdfMetadata(pages),snap=makeSnapshotBase(file,hash,'celk_procedimentos_detalhado',meta);snap.status='prévia não homologada';
  const allRows=[];
  for(const page of pages){
    for(const line of page.lines){
      const dateCell=cellText(line,232,303),qtyCell=cellText(line,785,850);if(!/^\d{2}\/\d{2}\/\d{4}/.test(dateCell)||!/^\d+[.,]\d{2}$/.test(qtyCell))continue;
      const row={page:page.page,lineY:round(line.y,1),patientId:idPrefix(cellText(line,0,170)),patient:cellText(line,0,170),age:cellText(line,170,210),sex:cellText(line,210,235),date:dateCell,professional:cellText(line,303,447),procedure:cellText(line,447,624),unitOrigin:cellText(line,624,785),quantity:numeric(qtyCell)};
      if(!row.procedure||row.quantity==null)continue;allRows.push(row);
    }
  }
  if(!allRows.length)throw new Error('O PDF foi reconhecido como “Procedimentos Detalhado”, mas nenhuma linha produtiva pôde ser extraída.');
  buildProcedureSnapshotFromRows(snap,allRows);
  sessionRaw.set(snap.id,{type:'procedure',rows:allRows.map(r=>({...r,patientMasked:maskName(r.patient),sourceRef:`p.${r.page} · y ${r.lineY}`}))});return snap;
}

async function parseProcedureCsv(file,hash,text){
  const rows=parseCSVText(text),headers=rows.shift()||[],map=headersMap(headers);
  const required=['Paciente','Idade','Sexo','Data','Profissional','Procedimento','Unidade','Quantidade'];
  const missing=required.filter(h=>map[norm(h)]==null);if(missing.length)throw new Error(`CSV de Procedimentos Detalhado sem cabeçalhos obrigatórios: ${missing.join(', ')}`);
  const data=rows.filter(r=>r.some(v=>String(v).trim()));
  const parsedRows=data.map((r,i)=>{
    const d=parseDate(valueBy(r,map,'Data'));
    return {line:i+2,patientId:idPrefix(valueBy(r,map,'Paciente')),patient:stripIdPrefix(valueBy(r,map,'Paciente')),age:valueBy(r,map,'Idade'),sex:valueBy(r,map,'Sexo'),date:d?fmtDate(d):'',professional:stripIdPrefix(valueBy(r,map,'Profissional')),procedure:String(valueBy(r,map,'Procedimento')).trim(),unitOrigin:stripIdPrefix(valueBy(r,map,'Unidade')),quantity:numeric(valueBy(r,map,'Quantidade'))};
  }).filter(r=>r.date&&r.procedure&&r.quantity!=null);
  if(!parsedRows.length)throw new Error('O CSV foi reconhecido como "Procedimentos Detalhado", mas nenhuma linha produtiva pôde ser extraída.');
  const {keepUnit,otherUnitCounts}=pickDominantUnit(parsedRows);
  const allRows=parsedRows;
  const dates=allRows.map(r=>parseDate(r.date)).filter(Boolean).map(d=>d.getTime());
  const periodStart=dates.length?isoDate(new Date(Math.min(...dates))):'',periodEnd=dates.length?isoDate(new Date(Math.max(...dates))):'';
  const snap=makeSnapshotBase(file,hash,'celk_procedimentos_detalhado',{unit:keepUnit,periodStart,periodEnd});snap.status='prévia não homologada';
  buildProcedureSnapshotFromRows(snap,allRows);
  if(Object.keys(otherUnitCounts).length){
    const parts=Object.entries(otherUnitCounts).map(([u,c])=>`${c} de "${u||'unidade não informada'}"`).join(', ');
    snap.validations.push({level:'info',code:'CSV_OTHER_UNIT_COUNTED',message:`Este CSV trazia ${parts} com unidade de origem diferente de "${keepUnit}" registrada no cadastro. Como o atendimento consta neste documento, essas linhas foram contadas normalmente na produção de "${keepUnit}" (nenhuma linha foi descartada).`});
  }
  sessionRaw.set(snap.id,{type:'procedure',rows:allRows.map(r=>({...r,patientMasked:maskName(r.patient),sourceRef:`linha ${r.line}`}))});return snap;
}

// A diferença do aviso M1_QUANTITY_VS_PEOPLE (quantidade somada > pessoas distintas) tem duas causas possíveis,
// e o CSV do CELK mostrou que as duas acontecem na prática: (1) a mesma pessoa aparece em mais de uma linha
// de "primeira consulta" no mês (cada linha com quantidade 1), ou (2) uma única linha já vem com quantidade
// maior que 1 para a mesma pessoa (visto no CSV, sempre com um mesmo profissional — vale confirmar com ele se
// é um lançamento em dobro ou um jeito legítimo de registrar). Por isso a comparação usa a quantidade somada
// por pessoa (`totalQuantity`), não só a contagem de linhas — cobre os dois casos com a mesma regra.
function firstConsultationDuplicatesForMonth(s,mk){
  const list=(s?.dataByMonth?.[mk]?.firstPatients)||[];
  const groups=new Map();
  for(const p of list){const key=norm(p.name);if(!key)continue;if(!groups.has(key))groups.set(key,{name:p.name,occurrences:[]});groups.get(key).occurrences.push({date:p.date,quantity:p.quantity??1})}
  return [...groups.values()].map(g=>({...g,totalQuantity:sum(g.occurrences.map(o=>o.quantity??1))})).filter(g=>g.totalQuantity>1).sort((a,b)=>a.name.localeCompare(b.name,'pt-BR'));
}
// Antes (até v1.35), este par de funções só SINALIZAVA repetição entre arquivos como um alerta para revisão
// manual — o numerador do indicador continuava contando as duas ocorrências. A partir da v1.36, a pedido
// explícito do usuário, a exclusão passou a ser real (feita em aggregateProcedureMonth via reconcileNominalRole
// /nominalRoleRepeatGroups) — estas duas funções agora só formatam, para a página Diagnóstico, o MESMO
// resultado que já foi aplicado ao número, para que o usuário veja o motivo por trás da exclusão.
function firstConsultationRepeatsAcrossFiles(unit=state.preferences.unit){return nominalRoleRepeatGroups(unit,'firstPatients')}
function treatmentConcludedRepeatsAcrossFiles(unit=state.preferences.unit){return nominalRoleRepeatGroups(unit,'concludedPatients')}
function hasM1PatientData(){return (state.snapshots||[]).some(s=>!s.supersededBy&&Object.values(s.dataByMonth||{}).some(m=>m.firstPatients?.length||m.concludedPatients?.length))}
function duplicatesDisclosureHTML(dupes){
  if(!dupes||!dupes.length)return '';
  const items=dupes.map(g=>{
    const parts=g.occurrences.map(o=>o.quantity>1?`${esc(o.date)} · quantidade ${fmtNum(o.quantity)} nessa linha`:esc(o.date)).join(', ');
    const linhas=g.occurrences.length===1?'1 linha':`${g.occurrences.length} linhas`;
    return `<li><strong>${esc(g.name)}</strong> — quantidade total ${fmtNum(g.totalQuantity)} em ${linhas} (${parts})</li>`;
  }).join('');
  return `<div class="disclosure"><button class="disclosure-btn" data-toggle-details type="button"><span>Ver detalhamento dos nomes (${dupes.length})</span><span class="chev">${icon('chevron')}</span></button><div class="disclosure-body"><ul class="dup-list">${items}</ul></div></div>`;
}
function crossFileDuplicatesDisclosureHTML(groups){
  if(!groups||!groups.length)return '';
  const items=groups.map(g=>`<li><strong>${esc(g.name)}</strong> — ${g.occurrences.map(o=>`${esc(o.fileName)} (${esc(o.date)})${o.counted===false?' <em>excluída do numerador</em>':o.counted===true?' <em>contada</em>':''}`).join(' · ')}</li>`).join('');
  return `<div class="disclosure"><button class="disclosure-btn" data-toggle-details type="button"><span>Ver quem teve ocorrência excluída por repetir em menos de 12 meses (${groups.length})</span><span class="chev">${icon('chevron')}</span></button><div class="disclosure-body"><ul class="dup-list">${items}</ul></div></div>`;
}
// Motor de agregação compartilhado por PDF e CSV de "Atividades em Grupo": recebe uma lista de eventos já no
// nível de UMA atividade cada (não por participante) — {date(DD/MM/AAAA),subject,present,status} — e preenche
// snap.dataByMonth. "present" já chega pronto: o PDF manda o "Presentes" agregado do próprio relatório; o CSV
// manda a contagem de participantes elegíveis (idade 6–11) que o parser calculou por atividade antes de chamar
// esta função. Mantida pura (só mexe em `snap`) para poder ser testada com eventos sintéticos.
function buildGroupSnapshotFromEvents(snap,events){
  for(const ev of events){const d=parseDate(ev.date);if(!d)continue;const mk=monthKey(d.getFullYear(),d.getMonth()+1);snap.dataByMonth[mk]??={kind:'group',supervisedBrushingPresent:0,activities:0,eligibleActivities:0,brushingEvents:[],subjectCounts:{}};snap.dataByMonth[mk].activities++;if(/ESCOVACAO SUPERVISIONADA/.test(norm(ev.subject))){snap.dataByMonth[mk].eligibleActivities++;snap.dataByMonth[mk].supervisedBrushingPresent+=Number(ev.present)||0;snap.dataByMonth[mk].brushingEvents.push({date:ev.date,present:Number(ev.present)||0,status:ev.status||''})}
    const sKey=norm(ev.subject)||'(sem assunto)';const sc=snap.dataByMonth[mk].subjectCounts[sKey]??={subject:ev.subject||'(sem assunto)',activities:0,present:0};sc.activities++;sc.present+=Number(ev.present)||0;
  }
  for(const mk of Object.keys(snap.dataByMonth))snap.dataByMonth[mk].subjectCounts=Object.values(snap.dataByMonth[mk].subjectCounts);
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
  buildGroupSnapshotFromEvents(snap,events);
  snap.validations.push({level:'warning',code:'GROUP_AGGREGATED',message:'O relatório fornece “Presentes” agregados, sem identificar idade, participante, CBO ou deduplicação. M3/B4 são prévios.'});
  sessionRaw.set(snap.id,{type:'group',rows:events});return snap;
}

// CSV de "Atividades em Grupo": ao contrário do PDF (que só traz "Presentes" já agregado por atividade), o CSV
// traz UMA LINHA POR PARTICIPANTE, com nome, data de nascimento e o assunto da atividade — permite calcular a
// idade real de cada participante na data da atividade e restringir o numerador de M3/B4 à faixa etária oficial
// (6 a 11 anos, até o dia anterior de completar 12), em vez de aceitar cegamente o "Presentes" agregado do PDF.
async function parseGroupCsv(file,hash,text){
  const rows=parseCSVText(text),headers=rows.shift()||[],map=headersMap(headers);
  const requiredGroups=[['Unidade'],['Data'],['Código da Atividade'],['Assunto'],['Nome dos Participantes'],BIRTH_DATE_HEADER_ALIASES];
  const missing=requiredGroups.filter(g=>!g.some(h=>map[norm(h)]!=null)).map(g=>g[0]);if(missing.length)throw new Error(`CSV de Atividades em Grupo sem cabeçalhos obrigatórios: ${missing.join(', ')}`);
  const data=rows.filter(r=>r.some(v=>String(v).trim()));
  const parsedRows=data.map((r,i)=>{
    const d=parseDate(valueBy(r,map,'Data'));
    return {line:i+2,unitOrigin:stripIdPrefix(valueBy(r,map,'Unidade')),date:d?fmtDate(d):'',dateObj:d,activityCode:String(valueBy(r,map,'Código da Atividade')).trim(),subject:String(valueBy(r,map,'Assunto')).trim(),participant:String(valueBy(r,map,'Nome dos Participantes')).trim(),birthDate:String(valueBy(r,map,...BIRTH_DATE_HEADER_ALIASES)).trim(),targetAudience:valueBy(r,map,'Público Alvo'),turno:String(valueBy(r,map,'Turno')).trim(),local:String(valueBy(r,map,'Local Atividade')).trim(),temas:String(valueBy(r,map,'Temas')).trim(),tipo:String(valueBy(r,map,'Tipo de Atividade')).trim(),sex:sexLabel(valueBy(r,map,'Sexo')),cpf:String(valueBy(r,map,'CPF')).replace(/\D/g,''),cns:String(valueBy(r,map,'CNS')).trim(),altered:/^S/i.test(String(valueBy(r,map,'Avaliação Alterada')).trim())};
  }).filter(r=>r.date&&r.subject&&r.participant&&r.activityCode);
  if(!parsedRows.length)throw new Error('O CSV foi reconhecido como "Relação das Atividades em Grupo", mas nenhuma linha produtiva pôde ser extraída.');
  const {keepUnit,otherUnitCounts}=pickDominantUnit(parsedRows);
  const dates=parsedRows.map(r=>r.dateObj).filter(Boolean).map(d=>d.getTime());
  const periodStart=dates.length?isoDate(new Date(Math.min(...dates))):'',periodEnd=dates.length?isoDate(new Date(Math.max(...dates))):'';
  const snap=makeSnapshotBase(file,hash,'celk_atividades_grupo',{unit:keepUnit,periodStart,periodEnd});snap.status='prévia não homologada';

  let ineligibleCount=0,missingBirthCount=0;const ineligibleSample=[];
  const perActivity=new Map();
  for(const r of parsedRows){
    if(!perActivity.has(r.activityCode))perActivity.set(r.activityCode,{date:r.date,subject:r.subject,presentEligible:0});
    const ev=perActivity.get(r.activityCode);
    if(!/ESCOVACAO SUPERVISIONADA/.test(norm(r.subject)))continue;
    if(!r.birthDate){missingBirthCount++;continue}
    const age=ageAt({dataNascimento:r.birthDate},r.dateObj);
    if(age==null){missingBirthCount++;continue}
    if(age>=6&&age<=11)ev.presentEligible++;
    else{ineligibleCount++;if(ineligibleSample.length<20)ineligibleSample.push({participant:r.participant,age,date:r.date})}
  }
  const events=[...perActivity.values()].map(ev=>({date:ev.date,subject:ev.subject,present:ev.presentEligible,status:'Concluída'}));
  buildGroupSnapshotFromEvents(snap,events);
  // Detalhe por atividade para a página Procedimentos (v2.27): todos os participantes, quem entra em M3/B4, idade,
  // sexo e avaliação alterada. Não muda o cálculo de M3/B4 acima.
  const details=new Map();
  for(const r of parsedRows){const brush=/ESCOVACAO SUPERVISIONADA/.test(norm(r.subject));const a=details.get(r.activityCode)||{code:r.activityCode,date:r.date,mk:r.dateObj?monthKey(r.dateObj.getFullYear(),r.dateObj.getMonth()+1):'',subject:r.subject,turno:r.turno,local:r.local,publico:String(r.targetAudience||'').trim(),temas:r.temas,tipo:r.tipo,brush,total:0,eligible:0,outOfRange:0,noBirth:0,altered:0,ages:{},sex:{F:0,M:0},alteredNames:[]};details.set(r.activityCode,a);
    a.total++;const age=r.birthDate?ageAt({dataNascimento:r.birthDate},r.dateObj):null;if(age==null)a.noBirth++;else{const b=ageBandLabel(age);if(b)a.ages[b]=(a.ages[b]||0)+1;if(brush){if(age>=6&&age<=11)a.eligible++;else a.outOfRange++}}
    if(r.sex==='Feminino')a.sex.F++;else if(r.sex==='Masculino')a.sex.M++;if(r.altered){a.altered++;a.alteredNames.push(r.participant)}(a.kids??=[]).push([r.sex==='Feminino'?'F':r.sex==='Masculino'?'M':'',age,r.altered?1:0])}
  for(const a of details.values()){const d=snap.dataByMonth[a.mk];if(!d)continue;(d.activityDetails??=[]).push(a)}
  // Cruzamento com o PSE (v2.29): participantes com nome, nascimento, CPF, CNS e sexo. Dado nominal: o backup analítico remove.
  snap.participants=parsedRows.map(r=>({nome:r.participant.toUpperCase(),nasc:r.birthDate?isoDate(r.birthDate):'',cpf:r.cpf,cns:r.cns,sexo:r.sex==='Feminino'?'F':r.sex==='Masculino'?'M':'',alt:r.altered,date:r.dateObj?isoDate(r.dateObj):'',subject:r.subject}));
  if(ineligibleCount||missingBirthCount){
    const parts=[];
    if(ineligibleCount)parts.push(`${ineligibleCount} participante(s) fora da faixa etária de 6 a 11 anos na data da atividade`);
    if(missingBirthCount)parts.push(`${missingBirthCount} sem data de nascimento no CSV`);
    snap.validations.push({level:'info',code:'GROUP_AGE_FILTERED',message:`Este CSV traz idade real por participante: o numerador de M3/B4 (escovação supervisionada) já exclui quem não se enquadra na faixa etária oficial, mesmo quando a atividade está marcada como "Criança de 6 a 11 anos". Excluído(s) do numerador: ${parts.join('; ')}. O denominador continua manual, sem alteração.`});
  }
  if(Object.keys(otherUnitCounts).length){
    const parts=Object.entries(otherUnitCounts).map(([u,c])=>`${c} de "${u||'unidade não informada'}"`).join(', ');
    snap.validations.push({level:'info',code:'CSV_OTHER_UNIT_COUNTED',message:`Este CSV trazia ${parts} com unidade de origem diferente de "${keepUnit}" registrada no cadastro. Como o atendimento consta neste documento, essas linhas foram contadas normalmente na produção de "${keepUnit}" (nenhuma linha foi descartada).`});
  }
  sessionRaw.set(snap.id,{type:'group_csv',rows:parsedRows.map(r=>{const age=r.birthDate?ageAt({dataNascimento:r.birthDate},r.dateObj):null;return {sourceRef:`linha ${r.line}`,date:r.date,subject:r.subject,participantMasked:maskName(r.participant),age,eligible:/ESCOVACAO SUPERVISIONADA/.test(norm(r.subject))?(age!=null?(age>=6&&age<=11):null):null,activityCode:r.activityCode}}),ineligibleSample});
  return snap;
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

// "Data Nascimento" (sem "de") era o único cabeçalho de data de nascimento reconhecido até esta versão — puramente
// hipotético, nunca conferido contra um CSV real do CELK. O primeiro CSV real de "Relação das Atividades em Grupo"
// que o usuário anexou traz o cabeçalho como "Data de Nascimento" (com "de") — detectCSVProfile e parseGroupCsv
// passaram a aceitar as duas grafias (BIRTH_DATE_HEADER_ALIASES), em vez de travar num nome nunca verificado.
const BIRTH_DATE_HEADER_ALIASES=['Data Nascimento','Data de Nascimento'];
function detectCSVProfile(headers){const n=headers.map(norm);const hasAny=alts=>alts.some(a=>n.includes(norm(a)));if(['DS UNIDADE','MES REFERENCIA','INDICADOR','NUMERADOR','DENOMINADOR','RESULTADO'].every(h=>n.includes(h)))return 'metabase_esb';if(['CD USU CADSUS','NOME','EQUIPE','CONSULTA SAUDE BUCAL'].every(h=>n.includes(h)))return 'metabase_2i';if(['PACIENTE','IDADE','SEXO','DATA','PROFISSIONAL','PROCEDIMENTO','UNIDADE','QUANTIDADE'].every(h=>n.includes(h)))return 'celk_procedimentos_csv';if(['UNIDADE','CODIGO DA ATIVIDADE','ASSUNTO','NOME DOS PARTICIPANTES'].every(h=>n.includes(h))&&hasAny(BIRTH_DATE_HEADER_ALIASES))return 'celk_atividades_grupo_csv';if(['FAIXA ETARIA','TODOS OS SERVICOS'].every(h=>n.includes(h)))return 'metabase_populacao_ativa';if(['EQUIPE','USUARIA','PERIODO','CONS ODONTO'].every(h=>n.includes(h)))return 'monitora_aps_2i';if(['NOME','ESCOLA','NASCIMENTO','STATUS BUCAL','RISCO'].every(h=>n.includes(h)))return 'pse_avaliacao_csv';return 'unknown'}

/* ---------- População ativa (Data Studio) — só alimenta a SUGESTÃO de denominador de M1/B1, nunca M3/B4 (pedido explícito do usuário) ---------- */
const POPULATION_CSV_SOURCE_URL='https://datastudio.google.com/u/0/reporting/a9c928b0-9050-4fc3-b0b4-b72681077387/page/p_khcnk9b1oc';
async function parsePopulacaoAtivaCSV(file,hash,text){
  const rows=parseCSVText(text),headers=rows.shift()||[],map=headersMap(headers),required=['Faixa Etaria','Todos os Servicos'];
  const missing=required.filter(h=>map[norm(h)]==null);if(missing.length)throw new Error(`CSV de população ativa sem cabeçalhos obrigatórios: ${missing.join(', ')}`);
  const data=rows.filter(r=>r.some(v=>String(v).trim()));
  const bands=data.map(r=>({faixa:valueBy(r,map,'Faixa Etaria'),todos:numeric(valueBy(r,map,'Todos os Servicos'))||0,consultas:numeric(valueBy(r,map,'Consultas Med Enf Odonto'))||0,consultasCpfEquipe:numeric(valueBy(r,map,'Consultas Med Enf Odonto com CPF e Equipe'))||0}));
  const totalPopulation=sum(bands.map(b=>b.todos));
  const snap=makeSnapshotBase(file,hash,'metabase_populacao_ativa',{});
  snap.status='população ativa importada — aguardando confirmação de ESF/dentistas e vigência';
  snap.population={bands,totalPopulation};
  snap.validations.push({level:'info',code:'POPULATION_IMPORTED',message:`População ativa somada: ${fmtNum(totalPopulation,0)} pessoas em ${bands.length} faixas etárias (coluna "Todos os serviços"). Usada só para sugerir o denominador de M1/B1 — não é usada para M3/B4, que continuam manuais ou vindos do consolidado do Metabase.`});
  sessionRaw.set(snap.id,{type:'csv',headers,rows:data.slice(0,300)});return snap;
}
function activePopulationInput(mk,unit=state.preferences.unit){
  const valid=state.populationInputs.filter(p=>p.start<=mk&&p.end>=mk&&(!unit||!p.unit||p.unit===unit)&&Number(p.esfCount)>0&&Number(p.dentistCount)>0).sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt));
  return valid[0]||null;
}
function suggestedM1FromPopulation(mk){const p=activePopulationInput(mk);return p?p.totalPopulation/p.esfCount*p.dentistCount:null}
// Confirmar ESF/dentistas/vigência já calcula e aplica o denominador de M1 automaticamente (sem exigir um segundo
// clique de "usar sugestão" no painel Municipal) — pedido explícito do usuário (v1.39): informar ESF e dentistas já
// é a confirmação. Reeditar o mesmo registro (mesmo snapshot) atualiza o denominador já criado, em vez de duplicar.
function confirmPopulationInput(snap,esfCount,dentistCount,start,end){
  const existing=state.populationInputs.find(p=>p.snapshotId===snap.id);
  const record=existing||{id:uuid(),snapshotId:snap.id,fileName:snap.fileName,unit:snap.unit||state.preferences.unit,createdAt:nowISO()};
  record.totalPopulation=snap.population.totalPopulation;record.esfCount=esfCount;record.dentistCount=dentistCount;record.start=start;record.end=end;record.updatedAt=nowISO();
  if(!existing)state.populationInputs.push(record);
  const suggested=record.totalPopulation/esfCount*dentistCount;
  const note=`Calculado automaticamente a partir da população ativa importada: ${fmtNum(record.totalPopulation,0)} pessoas ÷ ${esfCount} ESF × ${dentistCount} dentistas.`;
  const existingDen=record.denomRecordId?state.denominators.find(d=>d.id===record.denomRecordId):null;
  if(existingDen){existingDen.value=suggested;existingDen.start=start;existingDen.end=end;existingDen.note=note;existingDen.updatedAt=nowISO();audit('denominator_confirmed',{indicator:'M1',scope:'municipal',value:suggested,start,end,origin:existingDen.origin})}
  else record.denomRecordId=commitDenominator('M1','municipal',suggested,start,end,'CSV população ativa (automático)',note).id;
  audit('population_input_confirmed',{snapshotId:snap.id,esfCount,dentistCount,start,end});
  return {record,suggested};
}
function openPopulationInputsModal(snap){
  const mk=state.preferences.month,{year}=parseMonthKey(mk),months=quarterMonths(year,state.preferences.quarter);
  const existing=state.populationInputs.find(p=>p.snapshotId===snap.id);
  openModal(`<div class="modal-head"><div><h2 id="modalTitle">Confirmar população ativa (denominador de M1/B1)</h2><p>Usada só para calcular o denominador de M1/B1: população ÷ nº de ESF × nº de dentistas (excluindo residentes). Não afeta M3/B4.</p></div></div><form id="popForm"><div class="modal-body"><div class="notice">${fmtNum(snap.population.totalPopulation,0)} pessoas somadas de ${snap.population.bands.length} faixas etárias (coluna "Todos os serviços") do arquivo ${esc(snap.fileName)}.</div><div class="form-grid" style="margin-top:12px"><label class="field"><span class="required">Quantidade de ESF do CS</span><input id="popEsf" inputmode="numeric" value="${existing?esc(existing.esfCount):''}" required></label><label class="field"><span class="required">Quantidade de dentistas (excluindo residentes)</span><input id="popDentists" inputmode="numeric" value="${existing?esc(existing.dentistCount):''}" required></label><label class="field"><span class="required">Vigência inicial</span><input id="popStart" type="month" value="${existing?.start||months[0]}" required></label><label class="field"><span class="required">Vigência final</span><input id="popEnd" type="month" value="${existing?.end||months.at(-1)}" required></label></div><div class="notice" style="margin-top:12px">Ao confirmar, o denominador de M1 já é calculado e passa a valer automaticamente para essa vigência — sem precisar de outra confirmação no painel Municipal. Dá para ajustar manualmente lá depois, se precisar.</div></div><div class="modal-foot"><button type="button" class="btn" data-close-modal>Cancelar</button><button class="btn primary" type="submit">Confirmar</button></div></form>`,{wide:false});
  document.getElementById('popForm').onsubmit=e=>{
    e.preventDefault();
    const esfCount=numeric(document.getElementById('popEsf').value),dentistCount=numeric(document.getElementById('popDentists').value),start=document.getElementById('popStart').value,end=document.getElementById('popEnd').value;
    if(!(esfCount>0)||!(dentistCount>0)||!start||!end||start>end){toast('Revise a quantidade de ESF, de dentistas e a vigência.');return}
    const {suggested}=confirmPopulationInput(snap,esfCount,dentistCount,start,end);
    closeModal();queueSave();refreshAll();toast(`População ativa confirmada. Denominador de M1/B1 calculado e aplicado automaticamente: ${fmtNum(suggested,2)}.`);
  };
}

async function episodeIdFor(record){const anchor=record.ultimaMenstruacao||record.dataProvParto||record.dataParto||'';return sha256(`2i|${record.prontuario}|${anchor}`)}
// ---- Monitora APS: lista anonimizada de gestantes e puérperas ----
// Usa só Equipe, Usuária e Cons.Odonto. "Usuária" é o mesmo número do prontuário do CELK: quando bate com
// uma gestante já guardada (CSV do Metabase ou cadastro manual), vira vínculo em vez de uma linha nova.
// Período = "Puerpério" não entra na lista e remove (de forma reversível) quem já estava nela.
const MONITORA_PROFILE='monitora_aps_gestantes';
function pid(v){return String(v??'').replace(/\D/g,'').replace(/^0+/,'')}
const MONITORA_STAT_COLS=['1ªCons.12s.','7 consultas','7 PA','7 PesoAlt','DTPA','Exames T1','Exames T3','Cons.Puérp.','Cons.Odonto'];
async function parseMonitoraCSV(file,hash,text){
  const rows=parseCSVText(text),headers=rows.shift()||[],map=headersMap(headers),required=['Equipe','Usuária','Período','Cons.Odonto'];const missing=required.filter(h=>map[norm(h)]==null);if(missing.length)throw new Error(`CSV do Monitora APS sem cabeçalhos obrigatórios: ${missing.join(', ')}`);
  const data=rows.filter(r=>r.some(v=>String(v).trim()));
  const snap=makeSnapshotBase(file,hash,MONITORA_PROFILE,{unit:valueBy(data[0]||[],map,'Unidade')});snap.status='lista anonimizada do Monitora APS';snap.monitoraRows=[];snap.puerperio=[];
  const byUser=new Map();
  data.forEach((r,i)=>{const usuaria=pid(valueBy(r,map,'Usuária')),periodo=String(valueBy(r,map,'Período')).trim(),odonto=String(valueBy(r,map,'Cons.Odonto')).trim();
    if(!usuaria){snap.validations.push({level:'warning',code:'MONITORA_SEM_USUARIA',message:`Linha ${i+2} sem número de Usuária; ignorada.`});return}
    if(byUser.has(usuaria))snap.validations.push({level:'info',code:'MONITORA_DUPLICADA',message:`Usuária ${usuaria} aparece mais de uma vez; vale a última linha (${i+2}).`});
    byUser.set(usuaria,{usuaria,equipe:String(valueBy(r,map,'Equipe')).trim(),periodo,consOdonto:odonto,monitoraOdonto:norm(odonto)==='SIM'?'atende':'pendente',line:i+2})});
  // Análise estatística (v2.28): todas as usuárias (inclusive puérperas) com os 9 indicadores do Monitora, sem nome.
  const yn=v=>{const n=norm(v);return n==='SIM'?'Sim':n==='NAO'?'Não':null};snap.monitoraStat=[];
  data.forEach(r=>{const u=pid(valueBy(r,map,'Usuária'));if(!u)return;const i=snap.monitoraStat.findIndex(x=>x.u===u),row={u,equipe:String(valueBy(r,map,'Equipe')).trim(),periodo:String(valueBy(r,map,'Período')).trim(),v:MONITORA_STAT_COLS.map(c=>yn(valueBy(r,map,c)))};if(i>=0)snap.monitoraStat[i]=row;else snap.monitoraStat.push(row)});
  for(const row of byUser.values()){if(norm(row.periodo)==='PUERPERIO')snap.puerperio.push(row.usuaria);else snap.monitoraRows.push(row)}
  snap.validations.push({level:'info',code:'MONITORA_RESUMO',message:`${snap.monitoraRows.length} gestante(s) e ${snap.puerperio.length} puérpera(s). Puérperas não entram na lista de trabalho.`});
  snap.validations.push({level:'warning',code:'MONITORA_ANONIMIZADO',message:'Lista anonimizada: nome, telefone e DUM/DPP precisam ser completados na gaveta de cada gestante que não tiver vínculo com um cadastro já guardado.'});
  sessionRaw.set(snap.id,{type:'monitora',headers,rows:data.map((r,i)=>({line:i+2,values:r}))});return snap;
}
// ---- Cadastro de pacientes (código do CELK → nome), alimentado pelos relatórios de produção ----
// Serve para completar automaticamente o nome em listas anonimizadas (Monitora APS e futuras) e no
// cadastro manual de gestante. A última importação vence (corrige grafias).
function patientNameFor(code){const k=pid(code);return k?state.patientDirectory?.[k]?.nome||'':''}
function rememberPatientNames(names,fonte){if(!names)return {total:0,changed:0};state.patientDirectory=state.patientDirectory||{};let changed=0,total=0;for(const [k,nome] of Object.entries(names)){if(!k||!nome)continue;total++;if(state.patientDirectory[k]?.nome!==nome)changed++;state.patientDirectory[k]={nome,fonte,atualizadoEm:nowISO()}}if(changed)audit('patient_directory_updated',{total,changed,fonte});return {total,changed}}
// ---- Listas de gestantes somadas (v2.15): nenhum arquivo apaga o outro ----
// Cada novo CSV do Metabase (gestantes) ou do Monitora APS é SOMADO aos anteriores: a mesma gestante não
// duplica (Metabase: mesmo episódio = prontuário + DUM/DPP; Monitora: mesmo número de Usuária), o dado mais
// recente atualiza o que mudou, "Sim" em consulta odontológica nunca volta para "Não", e quem não veio no
// arquivo novo é mantida. No Monitora, se a informação mais recente sobre a Usuária é "Puerpério", ela sai.
const CUMULATIVE_2I_PROFILES=['metabase_gestantes_2i','monitora_aps_gestantes','pse_avaliacao'];
let merged2ICache={key:'',value:[]},mergedMonCache={key:'',value:null};
function snapshotsAsc(profile){return state.snapshots.filter(s=>s.profile===profile).sort((a,b)=>new Date(a.createdAt)-new Date(b.createdAt))}
function merged2IEpisodes(){
  const snaps=snapshotsAsc('metabase_gestantes_2i'),key=snaps.map(s=>s.id).join('|');if(merged2ICache.key===key)return merged2ICache.value;
  const map=new Map();
  for(const s of snaps)for(const e of s.episodes||[]){const prev=map.get(e.id);if(!prev){map.set(e.id,{...e,seenInFiles:1});continue}
    const kept=prev.status2i==='atende'&&e.status2i!=='atende';
    map.set(e.id,{...prev,...Object.fromEntries(Object.entries(e).filter(([,v])=>v!==''&&v!=null)),status2i:kept?'atende':e.status2i,consultaSaudeBucal:kept?`${e.consultaSaudeBucal||'—'} (Sim em arquivo anterior)`:e.consultaSaudeBucal,seenInFiles:prev.seenInFiles+1})}
  merged2ICache={key,value:[...map.values()]};return merged2ICache.value;
}
function mergedMonitora(){
  const snaps=snapshotsAsc('monitora_aps_gestantes');if(!snaps.length)return null;const key=snaps.map(s=>s.id).join('|');if(mergedMonCache.key===key)return mergedMonCache.value;
  const map=new Map();
  for(const s of snaps){
    for(const r of s.monitoraRows||[]){const prev=map.get(r.usuaria),wasAttended=prev?.status==='active'&&prev.row.monitoraOdonto==='atende',keep=wasAttended&&r.monitoraOdonto!=='atende';
      map.set(r.usuaria,{status:'active',row:{...r,monitoraOdonto:keep?'atende':r.monitoraOdonto,consOdonto:keep?`${r.consOdonto} (Sim em arquivo anterior)`:r.consOdonto}})}
    for(const u of s.puerperio||[]){const prev=map.get(u);map.set(u,{status:'puerperio',row:prev?.row||{usuaria:u}})}
  }
  const latest=snaps.at(-1);
  mergedMonCache={key,value:{monitoraRows:[...map.values()].filter(x=>x.status==='active').map(x=>x.row),puerperio:[...map.entries()].filter(([,x])=>x.status==='puerperio').map(([u])=>u),unit:latest.unit,createdAt:latest.createdAt,files:snaps.length}};
  return mergedMonCache.value;
}
function monitoraRowSig(r){return r?`${r.periodo}|${r.monitoraOdonto}|${r.equipe}`:''}
function episodeSig(e){return e?['nome','prontuario','equipe','telefone','ultimaMenstruacao','dataProvParto','dataParto','status2i','logradouro','numero','bairro'].map(k=>e[k]||'').join('|'):''}
function cumulativeImportSummary(snap,before){
  if(snap.profile===MONITORA_PROFILE){const after=mergedMonitora(),bRows=new Map((before?.monitoraRows||[]).map(r=>[r.usuaria,r])),aRows=new Map(after.monitoraRows.map(r=>[r.usuaria,r])),inFile=new Set(snap.monitoraRows.map(r=>r.usuaria));let fresh=0,updated=0,same=0;
    for(const r of snap.monitoraRows){const b=bRows.get(r.usuaria);if(!b)fresh++;else if(monitoraRowSig(b)===monitoraRowSig(aRows.get(r.usuaria)))same++;else updated++}
    const kept=[...bRows.keys()].filter(u=>!inFile.has(u)&&aRows.has(u)).length;return {fresh,updated,same,kept,puerperio:snap.puerperio.length}}
  const after=new Map(merged2IEpisodes().map(e=>[e.id,e])),b=new Map((before||[]).map(e=>[e.id,e])),inFile=new Set((snap.episodes||[]).map(e=>e.id));let fresh=0,updated=0,same=0;
  for(const e of snap.episodes||[]){const old=b.get(e.id);if(!old)fresh++;else if(episodeSig(old)===episodeSig(after.get(e.id)))same++;else updated++}
  return {fresh,updated,same,kept:[...b.keys()].filter(id=>!inFile.has(id)).length};
}
function getActiveMonitoraSnapshot(){const all=state.snapshots.filter(s=>s.profile===MONITORA_PROFILE).sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt));return all.find(s=>!s.supersededBy)||all[0]||null}
function pregDisplayName(e){return e?.nome||(e?.origin==='monitora'?`Usuária ${e.prontuario}`:'Sem nome')}
// Dados que faltam para contatar e acompanhar a gestante (filtro "Dados incompletos", v2.24).
function missingDataFields(e){const out=[];if(!String(e.nome||'').trim())out.push('nome');if(!e.phoneNormalized)out.push('telefone');if(!(e.ultimaMenstruacao||e.dataProvParto||e.dataParto))out.push('DUM ou DPP');return out}
function needsData(e){return e.origin==='monitora'&&(!e.nome||!(e.ultimaMenstruacao||e.dataProvParto||e.dataParto))}
// Move acompanhamento e dados completados de uma gestante que veio só do Monitora ("mon-<usuária>") para o
// cadastro com o mesmo prontuário que apareceu depois (CSV do Metabase ou cadastro manual).
function migrateMonitoraLinks(){
  const g=state.gestantes,episodes2i=merged2IEpisodes();let moved=0;
  for(const e of mergedEpisodes()){
    if(!e.monitoraUsuaria||e.origin==='monitora')continue;const from=`mon-${e.monitoraUsuaria}`,to=e.id;
    if(g.followups[from]){const a=g.followups[from],b=g.followups[to];const newer=!b||new Date(a.updatedAt||0)>new Date(b.updatedAt||0)?a:b;g.followups[to]={...newer,history:[...(b?.history||[]),...(a.history||[])].sort((x,y)=>String(x.at).localeCompare(String(y.at)))};delete g.followups[from];moved++}
    if(g.overrides[from]){const ov=g.overrides[from],manual=g.manual.find(m=>m.id===to),raw=manual||episodes2i.find(x=>x.id===to)||{};const keep=Object.fromEntries(Object.entries(ov).filter(([k,v])=>v&&!(k==='enderecoOverride'?(raw.logradouro||raw.endereco):raw[k])));if(manual){const {enderecoOverride,notaLocal,...rest}=keep;Object.assign(manual,rest,enderecoOverride?{endereco:enderecoOverride}:{},{updatedAt:nowISO()})}else if(Object.keys(keep).length)g.overrides[to]={...keep,...(g.overrides[to]||{})};delete g.overrides[from];moved++}
    if(g.excluded[from]){if(!g.excluded[to])g.excluded[to]=g.excluded[from];delete g.excluded[from];moved++}
  }
  if(moved)audit('2i_monitora_linked',{moved});return moved;
}
function applyMonitoraPuerperio(){
  const set=new Set(mergedMonitora()?.puerperio||[]);if(!set.size)return 0;const g=state.gestantes;g.puerperioIgnored=g.puerperioIgnored||{};let n=0;
  for(const e of mergedEpisodes()){const k=pid(e.prontuario);if(!k||!set.has(k)||g.excluded[e.id]||g.puerperioIgnored[e.id])continue;g.excluded[e.id]={at:nowISO(),reason:'Puerpério no Monitora APS',source:'monitora_puerperio'};n++}
  if(n)audit('2i_monitora_puerperio_removed',{count:n});return n;
}
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
  let snap;const before2i=merged2IEpisodes(),beforeMon=mergedMonitora();
  if(file.name.toLowerCase().endsWith('.pdf')||file.type==='application/pdf'){
    const pages=await pdfPages(file),text=norm(pdfFullText(pages.slice(0,2)));
    if(text.includes('PROCEDIMENTOS DETALHADO'))snap=await parseProcedurePdf(file,hash,pages);
    else if(text.includes('RELACAO DAS ATIVIDADES EM GRUPO'))snap=await parseGroupPdf(file,hash,pages);
    else snap=await parseUnknownPdf(file,hash,pages);
  }else{
    const {text}=await readTextFile(file),parsed=parseCSVText(text),headers=parsed[0]||[],profile=detectCSVProfile(headers);
    if(profile==='metabase_esb')snap=await parseMetabaseConsolidated(file,hash,text);
    else if(profile==='metabase_2i')snap=await parseGestantesCSV(file,hash,text);
    else if(profile==='monitora_aps_2i')snap=await parseMonitoraCSV(file,hash,text);
    else if(profile==='celk_procedimentos_csv')snap=await parseProcedureCsv(file,hash,text);
    else if(profile==='celk_atividades_grupo_csv')snap=await parseGroupCsv(file,hash,text);
    else if(profile==='metabase_populacao_ativa')snap=await parsePopulacaoAtivaCSV(file,hash,text);
    else if(profile==='pse_avaliacao_csv')snap=await parsePseCSV(file,hash,text);
    else snap=await parseUnknownCSV(file,hash,text,headers,parsed.slice(1));
  }
  if(snap.patientNames){const r=rememberPatientNames(snap.patientNames,'Produção CELK');delete snap.patientNames;snap.validations.push({level:'info',code:'PATIENT_NAMES_SAVED',message:`${r.total} paciente(s) com código e nome guardados (${r.changed} novo(s) ou atualizado(s)). Servem para completar o nome em listas anonimizadas, como a do Monitora APS, e no cadastro de gestantes.`})}
  commitSnapshot(snap);
  if(snap.profile===MONITORA_PROFILE||snap.profile==='metabase_gestantes_2i'){migrateMonitoraLinks();const removed=applyMonitoraPuerperio();const c=cumulativeImportSummary(snap,snap.profile===MONITORA_PROFILE?beforeMon:before2i);snap.mergeSummary={fresh:c.fresh,updated:c.updated,same:c.same,kept:c.kept};const parts=`${c.fresh} nova(s), ${c.updated} atualizada(s), ${c.same} igual(is) ao que já havia${c.kept?`; ${c.kept} que não vieram neste arquivo foram mantidas`:''}`;if(snap.profile===MONITORA_PROFILE)lastImportNotice=`Monitora APS somado aos anteriores: ${parts}. ${c.puerperio} em puerpério não entraram${removed?` (${removed} removida(s) da lista)`:''}.`;else lastImportNotice=`CSV de gestantes somado aos anteriores: ${parts}.${removed?` ${removed} removida(s) da lista por puerpério no Monitora.`:''}`;queueSave();refreshAll()}
  return snap;
}
let lastImportNotice='';
function commitSnapshot(snap){
  for(const old of state.snapshots){if(!CUMULATIVE_2I_PROFILES.includes(snap.profile)&&old.profile===snap.profile&&old.unit===snap.unit&&old.periodStart===snap.periodStart&&old.periodEnd===snap.periodEnd&&!old.supersededBy)old.supersededBy=snap.id}
  state.snapshots.push(snap);state.dirty=true;audit('snapshot_imported',{snapshotId:snap.id,profile:snap.profile,fileName:snap.fileName,hash:snap.hash,periodStart:snap.periodStart,periodEnd:snap.periodEnd});
  const months=Object.keys(snap.dataByMonth||{}).sort();if(months.length){const latest=months.at(-1),{year,month}=parseMonthKey(latest);state.preferences.year=year;state.preferences.quarter=quarterOfMonth(month);state.preferences.month=latest}
  if(snap.unit&&!state.preferences.unit)state.preferences.unit=snap.unit;queueSave();refreshAll();
}
async function importFiles(files){
  const list=[...files];if(!list.length)return;showLoading('Preparando importação',`${list.length} arquivo(s)`);let ok=0;const failures=[],populationSnaps=[];
  try{for(let i=0;i<list.length;i++){setLoading(`Importando ${i+1} de ${list.length}`,list[i].name);try{const result=await importOne(list[i]);if(result){ok++;if(result.profile==='metabase_populacao_ativa')populationSnaps.push(result)}}catch(e){console.error(e);failures.push({name:list[i].name,message:e?.message||String(e)||'Erro desconhecido.',stack:e?.stack||''})}}}finally{hideLoading();document.getElementById('fileInput').value='';if(failures.length){audit('import_failed',{ok,failures:failures.map(f=>({name:f.name,message:f.message}))});showImportFailures(ok,failures)}else{toast(lastImportNotice||`${ok} importação(ões) concluída(s)`)}lastImportNotice=''}
  if(populationSnaps.length)openPopulationInputsModal(populationSnaps.at(-1));
}

/* ---------- Motor de cálculo e proveniência ---------- */

function latestSnapshots(profile,mk,unit=state.preferences.unit){
  const candidates=state.snapshots.filter(s=>s.profile===profile&&s.dataByMonth?.[mk]&&(!unit||s.unit===unit));const groups=new Map();
  for(const s of candidates){const key=s.unit||'__sem_unidade__';const prev=groups.get(key);if(!prev||new Date(s.createdAt)>new Date(prev.createdAt))groups.set(key,s)}
  return [...groups.values()];
}
// Reconciliação de 12 meses entre TODOS os meses/arquivos já importados (não só o mês em foco) para uma
// unidade: agrupa um campo nominal (firstPatients ou concludedPatients) por pessoa, ordena cronologicamente
// e só conta 1 ocorrência a cada 365 dias — a partir da última ocorrência efetivamente CONTADA, não da
// última ocorrência bruta (assim uma sequência de 3+ repetições em menos de 1 ano cada é tratada corretamente:
// só a 1ª de cada janela conta, mesmo que a 3ª esteja a mais de 12 meses da 1ª mas a menos de 12 meses da 2ª,
// que já tinha sido excluída). Pedido explícito do usuário: "primeira consulta" (e, pela mesma lógica,
// "tratamento concluído") não deve contar de novo antes de completar 12 meses da ocorrência anterior contada.
// Usa `latestSnapshots` (mesma fonte de verdade usada em todo o resto do app) para nunca ler um snapshot já
// substituído por uma reimportação mais recente do mesmo período. Só enxerga o que foi de fato importado —
// um período sem snapshot correspondente não pode ser verificado (por isso "quando os dados estiverem
// disponíveis", como pedido: fora do histórico importado, a ferramenta não tem como saber).
function nominalRoleOccurrences(unit,field){
  const months=new Set();
  for(const s of state.snapshots||[]){if(s.profile!=='celk_procedimentos_detalhado'||(s.unit||'')!==(unit||''))continue;for(const mk of Object.keys(s.dataByMonth||{}))months.add(mk)}
  const byName=new Map();
  for(const mk of months){
    for(const s of latestSnapshots('celk_procedimentos_detalhado',mk,unit)){
      const month=s.dataByMonth[mk];if(!month||month.kind!=='procedure')continue;
      const perPersonEarliest=new Map();
      for(const p of month[field]||[]){
        const key=norm(p.name);if(!key)continue;const d=parseDate(p.date);if(!d)continue;
        const cur=perPersonEarliest.get(key);if(!cur||d<cur.dateObj)perPersonEarliest.set(key,{name:p.name,date:p.date,dateObj:d,mk,snapshotId:s.id,fileName:s.fileName});
      }
      for(const occ of perPersonEarliest.values()){const key=norm(occ.name);if(!byName.has(key))byName.set(key,[]);byName.get(key).push(occ)}
    }
  }
  for(const list of byName.values())list.sort((a,b)=>a.dateObj-b.dateObj);
  return byName;
}
function reconcileNominalRole(unit,field){
  const byName=nominalRoleOccurrences(unit,field);
  const countedByMonth={},excludedByMonth={};
  for(const list of byName.values()){
    let last=null;
    for(const occ of list){
      occ.counted=!last||(occ.dateObj-last.dateObj)/86400000>=365;
      if(occ.counted){countedByMonth[occ.mk]=(countedByMonth[occ.mk]||0)+1;last=occ}
      else{(excludedByMonth[occ.mk]??=[]).push({name:occ.name,date:occ.date,fileName:occ.fileName,previousDate:last.date,previousFileName:last.fileName})}
    }
  }
  return {countedByMonth,excludedByMonth,byName};
}
// Grupos (nome + linha do tempo completa) só para quem teve pelo menos 1 ocorrência excluída — usado nos
// blocos expansíveis de Diagnóstico (M1_REPEAT_WITHIN_12M/M2_REPEAT_WITHIN_12M), reaproveitando a MESMA
// reconciliação que já decide o numerador oficial (não é um cálculo paralelo, é o motivo por trás do número).
function nominalRoleRepeatGroups(unit,field){
  const {byName}=reconcileNominalRole(unit,field);
  const groups=[];
  for(const list of byName.values()){if(list.some(o=>!o.counted))groups.push({name:list[0].name,occurrences:list.map(o=>({date:o.date,fileName:o.fileName,counted:o.counted}))})}
  return groups.sort((a,b)=>a.name.localeCompare(b.name,'pt-BR'));
}
function aggregateProcedureMonth(mk,unit=state.preferences.unit){
  const snaps=latestSnapshots('celk_procedimentos_detalhado',mk,unit);if(!snaps.length)return null;
  const keys=['firstConsultations','firstConsultationQuantity','treatmentsConcluded','treatmentConcludedQuantity','preventive','individualProcedures','art','restorative','b5Denominator','b3Numerator','b3Denominator'];const out=Object.fromEntries(keys.map(k=>[k,0]));out.snapshots=snaps;out.procedureCounts=[];out.crossRows=[];out.visitsList=[];
  const byProc={},byCross={};for(const s of snaps){const d=s.dataByMonth[mk];for(const k of keys)out[k]+=Number(d[k])||0;for(const p of d.procedureCounts||[]){const key=p.descriptionNormalized;const a=byProc[key]??={...p,quantityRaw:0,quantityValid:0,lineCount:0,pages:[],professionals:{},sources:[]};a.quantityRaw+=p.quantityRaw;a.quantityValid+=p.quantityValid;a.lineCount+=p.lineCount;a.pages=[...new Set([...a.pages,...(p.pages||[])])];for(const [n,q] of Object.entries(p.professionals||{}))a.professionals[n]=(a.professionals[n]||0)+q;a.sources.push(s.id);byProc[key]=a}
    for(const c of d.crossRows||[]){const ck=`${c.procKey}${c.professional}${c.sex}${c.age}`;const a=byCross[ck]??={...c,quantity:0};a.quantity+=c.quantity;byCross[ck]=a}
    out.visitsList.push(...(d.visitsList||[]));
  }
  out.procedureCounts=Object.values(byProc);out.crossRows=Object.values(byCross);
  // Numerador oficial de M1/B1 e M2/B2: substitui a contagem bruta de pessoas distintas NO MÊS (que já estava
  // em out.firstConsultations/out.treatmentsConcluded pelo loop acima) pela contagem deduzida entre TODO o
  // histórico importado, respeitando a regra de 12 meses entre ocorrências da mesma pessoa (reconcileNominalRole).
  const firstRec=reconcileNominalRole(unit,'firstPatients'),concludedRec=reconcileNominalRole(unit,'concludedPatients');
  out.firstConsultationsBeforeDedup=out.firstConsultations;out.firstConsultations=firstRec.countedByMonth[mk]||0;out.firstConsultationsExcluded=firstRec.excludedByMonth[mk]||[];
  out.treatmentsConcludedBeforeDedup=out.treatmentsConcluded;out.treatmentsConcluded=concludedRec.countedByMonth[mk]||0;out.treatmentsConcludedExcluded=concludedRec.excludedByMonth[mk]||[];
  return out;
}
// Além do relatório dedicado "Atividades em Grupo" (celk_atividades_grupo, fonte oficial de M3/B4 —
// supervisedBrushingPresent/eligibleActivities/brushingEvents/snapshots continuam vindo só dele), o relatório
// "Procedimentos Detalhado" pode conter a linha "Atividade educativa / orientação em grupo na atenção
// primária" (marcada com groupActivity em PROCEDURE_RULES). Essa linha não é uma atividade de grupo completa
// (não tem escovação supervisionada), mas o usuário pediu que ela apareça nesta aba, ao lado da evolução das
// escovações — por isso ela entra em subjectCounts/activities (via groupSubjectFromProcedures), mesmo quando
// não existe nenhum import de Atividades em Grupo para o mês.
function aggregateGroupMonth(mk,unit=state.preferences.unit){const snaps=latestSnapshots('celk_atividades_grupo',mk,unit);
  const procSnaps=latestSnapshots('celk_procedimentos_detalhado',mk,unit);
  const procSubjects=procSnaps.flatMap(s=>s.dataByMonth[mk]?.groupSubjectFromProcedures||[]);
  if(!snaps.length&&!procSubjects.length)return null;
  const bySubject={};for(const s of snaps)for(const sc of s.dataByMonth[mk].subjectCounts||[]){const key=norm(sc.subject);const a=bySubject[key]??={subject:sc.subject,activities:0,present:0};a.activities+=sc.activities;a.present+=sc.present}
  for(const sc of procSubjects){const key=norm(sc.subject);const a=bySubject[key]??={subject:sc.subject,activities:0,present:0};a.activities+=sc.activities;a.present+=sc.present}
  return {supervisedBrushingPresent:sum(snaps.map(s=>s.dataByMonth[mk].supervisedBrushingPresent)),eligibleActivities:sum(snaps.map(s=>s.dataByMonth[mk].eligibleActivities)),activities:sum(snaps.map(s=>s.dataByMonth[mk].activities))+sum(procSubjects.map(sc=>sc.activities)),brushingEvents:snaps.flatMap(s=>s.dataByMonth[mk].brushingEvents||[]).sort((a,b)=>(parseDate(a.date)?.getTime()||0)-(parseDate(b.date)?.getTime()||0)),subjectCounts:Object.values(bySubject),snapshots:snaps}}
/* ---------- Página Procedimentos: agregação por ano, cruzamentos e paleta de categorias ---------- */
const PROC_BASE_PALETTE=['#17b9ec','#7551e9','#2cc08b','#f7821f','#a855f7'];
// Paleta não fica travada em 5 cores (pode haver mais de 5 procedimentos/dentistas): usa as 5 cores fixas
// da especificação e, a partir da 6ª categoria, gera tons adicionais girando o matiz — sem repetir cor como
// status (continua só identificando categoria, igual às 5 primeiras).
function procPalette(n){const out=[];for(let i=0;i<n;i++){if(i<PROC_BASE_PALETTE.length)out.push(PROC_BASE_PALETTE[i]);else out.push(`hsl(${(210+(i-PROC_BASE_PALETTE.length)*47)%360} 72% 58%)`)}return out}
function procYearsAvailable(profile,unit=state.preferences.unit){const years=new Set();for(const s of state.snapshots){if(s.profile!==profile)continue;if(unit&&s.unit!==unit)continue;for(const mk of Object.keys(s.dataByMonth||{}))years.add(parseMonthKey(mk).year)}return [...years].sort((a,b)=>b-a)}
// Anos disponíveis para a aba "Atividades coletivas": une os anos do relatório dedicado
// (celk_atividades_grupo) com os anos em que o relatório "Procedimentos Detalhado" trouxe a linha "Atividade
// educativa / orientação em grupo" (groupSubjectFromProcedures) — assim a aba mostra dados mesmo quando só
// existe o relatório de procedimentos importado, sem nenhum "Relação das Atividades em Grupo".
function procMonthsOfYear(year){return Array.from({length:12},(_,i)=>monthKey(year,i+1))}
function aggregateProcedureYear(year,unit=state.preferences.unit,{onlyMonth=''}={}){
  const months=onlyMonth?[onlyMonth]:procMonthsOfYear(year);
  const out={year,firstConsultations:0,treatmentsConcluded:0,procedureCounts:[],crossRows:[],visitsList:[],monthsWithData:[]};
  const byProc={},byCross={};
  // aggregateProcedureYear alimenta só a página Procedimentos (groupProcedureItems, fullYearProcedureOptions,
  // procLabelFor) — por isso filtra nonDental aqui. aggregateProcedureMonth (usado por Configurações e pelo
  // drill-down M4/M5/B3/B5) continua completo, sem esse filtro.
  for(const mk of months){const agg=aggregateProcedureMonth(mk,unit);if(!agg)continue;out.monthsWithData.push(mk);out.firstConsultations+=agg.firstConsultations;out.treatmentsConcluded+=agg.treatmentsConcluded;out.visitsList.push(...agg.visitsList);
    for(const p of agg.procedureCounts.filter(x=>!x.nonDental)){const a=byProc[p.descriptionNormalized]??={...p,quantityValid:0,professionals:{}};a.quantityValid+=p.quantityValid;for(const [n,q] of Object.entries(p.professionals||{}))a.professionals[n]=(a.professionals[n]||0)+q;byProc[p.descriptionNormalized]=a}
    for(const c of agg.crossRows){const ck=`${c.procKey}${c.professional}${c.sex}${c.age}`;const a=byCross[ck]??={...c,quantity:0};a.quantity+=c.quantity;byCross[ck]=a}
  }
  out.procedureCounts=Object.values(byProc);out.crossRows=Object.values(byCross);
  return out;
}
function applyCrossFilters(crossRows,{sex='',age='',dentist=''}={}){return crossRows.filter(c=>(!sex||c.sex===sex)&&(!age||c.age===age)&&(!dentist||c.professional===dentist))}
function procDentistList(crossRows){return [...new Set(crossRows.map(c=>c.professional).filter(Boolean))].sort((a,b)=>a.localeCompare(b,'pt-BR'))}
// Agrupa os dados já filtrados (Refinar) na dimensão escolhida em "Agrupar por". Sempre devolve itens
// ordenados do maior para o menor valor, prontos para virar barras/linhas/pizza/tabela/comparação.
function groupProcedureItems(yearAgg,groupBy,filters,unit=state.preferences.unit){
  const filteredCross=applyCrossFilters(yearAgg.crossRows,filters);
  const filterActive=!!(filters.sex||filters.age||filters.dentist);
  if(groupBy==='procedure'){
    if(!filterActive)return yearAgg.procedureCounts.map(p=>({key:p.descriptionNormalized,label:p.descriptionOriginal||p.descriptionNormalized,value:p.quantityValid})).sort((a,b)=>b.value-a.value);
    const byProc={};for(const c of filteredCross){const a=byProc[c.procKey]??={key:c.procKey,label:c.procLabel,value:0};a.value+=c.quantity;byProc[c.procKey]=a}return Object.values(byProc).sort((a,b)=>b.value-a.value);
  }
  if(groupBy==='dentist'){
    if(!filterActive){const byD={};for(const p of yearAgg.procedureCounts)for(const [n,q] of Object.entries(p.professionals||{})){const key=n||'(sem profissional)';byD[key]=(byD[key]||0)+q}return Object.entries(byD).map(([label,value])=>({key:label,label,value})).sort((a,b)=>b.value-a.value)}
    const byD={};for(const c of filteredCross){const key=c.professional||'(sem profissional)';byD[key]=(byD[key]||0)+c.quantity}return Object.entries(byD).map(([label,value])=>({key:label,label,value})).sort((a,b)=>b.value-a.value);
  }
  if(groupBy==='age'){const bands=['0-5','6-11','12-17','18-59','60+'];const byA={};for(const c of filteredCross){if(!c.age)continue;byA[c.age]=(byA[c.age]||0)+c.quantity}return bands.filter(b=>byA[b]).map(b=>({key:b,label:b+' anos',value:byA[b]}));}
  if(groupBy==='sex'){const byS={};for(const c of filteredCross){if(!c.sex)continue;byS[c.sex]=(byS[c.sex]||0)+c.quantity}return Object.entries(byS).map(([label,value])=>({key:label,label,value})).sort((a,b)=>b.value-a.value);}
  if(groupBy==='month'){return yearAgg.monthsWithData.map(mk=>{const monthAgg=aggregateProcedureMonth(mk,unit);const rows=applyCrossFilters(monthAgg.crossRows,filters);const value=filterActive?sum(rows.map(r=>r.quantity)):sum(monthAgg.procedureCounts.filter(p=>!p.nonDental).map(p=>p.quantityValid));return {key:mk,label:fmtMonth(mk),value}});}
  if(groupBy==='year'){const years=procYearsAvailable('celk_procedimentos_detalhado',unit);return years.map(y=>{const agg=y===yearAgg.year?yearAgg:aggregateProcedureYear(y,unit);const rows=applyCrossFilters(agg.crossRows,filters);const value=filterActive?sum(rows.map(r=>r.quantity)):sum(agg.procedureCounts.map(p=>p.quantityValid));return {key:String(y),label:String(y),value}}).sort((a,b)=>a.key-b.key);}
  return [];
}
// Avaliação do paciente: reaproveita aggregateProcedureMonth (já com a dedução oficial de 12 meses de
// reconcileNominalRole, a mesma usada em M1/M2) mês a mês dentro do ano, e soma "visitas" (par paciente+data
// distinto, qualquer procedimento) pra estimar retornos e a distribuição de consultas por paciente — o nome
// bruto do paciente só é usado como chave interna de agrupamento aqui dentro, nunca exibido na tela.
// Pedido explícito do usuário: "retorno" não é mais "visitas do período menos 1ª consulta menos tratamento
// concluído" (uma subtração agregada) — passou a ser, por paciente, TODAS as vezes que ele voltou ao posto no
// ano, incluindo a própria visita já contada como 1ª consulta ou tratamento concluído em outra tabela. Ex.: se
// Maria teve 6 consultas em 2026, ela conta 1 vez em "1ª consulta" (tabela própria, indicador M1, sem mudança)
// E as mesmas 6 consultas contam como "6 vezes retornando ao posto" aqui — não 5. Na prática, "retornosTotal"
// vira o mesmo número que "totalVisits" (soma de todas as visitas distintas paciente+data do ano); a "Taxa de
// retorno" (retornos ÷ total de visitas) deixou de fazer sentido nessa definição (sempre daria 100%) e foi
// removida da tela. "Média de consultas/paciente" (totalVisits ÷ pacientes distintos) já media exatamente o
// que o usuário descreveu e não mudou.
function patientEvaluationStats(year,unit=state.preferences.unit){
  const months=procMonthsOfYear(year);const monthly=[];let firstTotal=0,concludedTotal=0;const visitsByPatient=new Map();let totalVisits=0;
  for(const mk of months){const agg=aggregateProcedureMonth(mk,unit);if(!agg){monthly.push({mk,first:0,retorno:0,concluded:0});continue}
    firstTotal+=agg.firstConsultations;concludedTotal+=agg.treatmentsConcluded;
    const visits=agg.visitsList||[];totalVisits+=visits.length;
    for(const v of visits)visitsByPatient.set(v.patient,(visitsByPatient.get(v.patient)||0)+1);
    monthly.push({mk,first:agg.firstConsultations,retorno:visits.length,concluded:agg.treatmentsConcluded});
  }
  const retornosTotal=totalVisits;
  const distinctPatients=visitsByPatient.size;
  const avgVisits=distinctPatients?totalVisits/distinctPatients:null;
  const buckets=[{key:'1',label:'1 consulta sem retorno',min:1,max:1,count:0},{key:'2-3',label:'2 a 3 consultas',min:2,max:3,count:0},{key:'4-6',label:'4 a 6 consultas',min:4,max:6,count:0},{key:'7+',label:'7 ou mais consultas',min:7,max:Infinity,count:0}];
  for(const c of visitsByPatient.values())for(const b of buckets)if(c>=b.min&&c<=b.max){b.count++;break}
  return {firstTotal,concludedTotal,retornosTotal,totalVisits,distinctPatients,avgVisits,monthly,buckets};
}
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
const FEDERAL_ZONE_COLORS={'Ótimo':{text:'#14539a',bg:'#e7eff8'},'Bom':{text:'#17b9ec',bg:'#e3f6fd'},'Suficiente':{text:'#c99400',bg:'#fbf3dc'},'Regular':{text:'#8c1d18',bg:'#f6e5e4'}};
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
  if(id==='M1'){numerator=proc?.firstConsultations??null;denomRecord=getDenominator('M1','municipal',mk);denominator=denomRecord?.value??null;snaps=proc?.snapshots||[];hypothesis=`Pessoas distintas pelo nome exibido; só conta 1 primeira consulta por pessoa a cada 12 meses, olhando todo o histórico importado (não só este mês) — repetição da mesma pessoa em menos de 365 dias da ocorrência anterior contada é excluída do numerador.${proc?.firstConsultationsExcluded?.length?` ${proc.firstConsultationsExcluded.length} repetição(ões) excluída(s) este mês.`:''} Só verifica o que foi de fato importado: um atendimento anterior ao primeiro arquivo importado não pode ser checado.`;if(!denomRecord)missing='Denominador do indicador 1 não informado.'}
  if(id==='M2'){numerator=proc?.treatmentsConcluded??null;denominator=proc?.firstConsultations??null;snaps=proc?.snapshots||[];hypothesis=`Pessoas distintas pelo nome exibido; só conta 1 tratamento concluído por pessoa a cada 12 meses, olhando todo o histórico importado (não só este mês) — repetição da mesma pessoa em menos de 365 dias da ocorrência anterior contada é excluída do numerador.${proc?.treatmentsConcludedExcluded?.length?` ${proc.treatmentsConcludedExcluded.length} repetição(ões) excluída(s) este mês.`:''} Simplificação em relação à Nota B2: o requisito de "até 12 meses após a primeira consulta, uma vez por dentista no ciclo" não é verificado por completo — só o intervalo de 12 meses entre conclusões da mesma pessoa.`}
  if(id==='M3'){numerator=group?.supervisedBrushingPresent??null;denomRecord=getDenominator('M3','municipal',mk);denominator=denomRecord?.value??null;snaps=group?.snapshots||[];hypothesis='Campo agregado “Presentes”; idade e deduplicação não verificáveis.';if(!denomRecord)missing='Denominador do indicador 3 não informado.'}
  if(id==='M4'){numerator=proc?.preventive??null;denominator=proc?.b5Denominator??null;snaps=proc?.snapshots||[];hypothesis='Mesma conta da Nota federal B5 (v2.18, pedido do usuário): numerador são os 7 procedimentos preventivos e o denominador é a lista fechada de 28 códigos SIGTAP da Nota B5 (preventivos, restauradores, endodontia, periodontia, mucosa, exodontia de dente permanente e adequação do comportamento). Não entram primeira consulta, tratamento concluído, atendimentos genéricos, atividade em grupo nem procedimentos fora da lista. Novo preventivo aumenta simultaneamente numerador e denominador.'}
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
const FEDERAL_MIRROR = {B1:'M1',B2:'M2',B4:'M3',B5:'M4',B6:'M5'};
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
  const result=numerator!=null&&denominator>0?100*numerator/denominator:null;return {id,mk,numerator,denominator,result,classification:classifyFederal(id,result),snapshots:snaps,source:sourceLabel(snaps),hypothesis,missing:result==null?(missing||(!snaps.length?'Relatório CELK aplicável ainda não importado.':'Denominador igual a zero ou ausente.')):''};
}
function remainingForM1(numerator,denominator,threshold){if(numerator==null||!(denominator>0))return null;return Math.max(0,Math.floor((threshold/100)*denominator)+1-numerator)}
function remainingInclusive(numerator,denominator,target,simultaneous=false){if(numerator==null||!(denominator>0))return null;const t=target/100;return Math.max(0,Math.ceil(simultaneous?(t*denominator-numerator)/(1-t):t*denominator-numerator))}
function quarterMunicipal(id,year=state.preferences.year,q=state.preferences.quarter){
  const months=quarterMonths(year,q),values=months.map(m=>municipalComponents(id,m));const valid=values.filter(v=>v.result!=null);
  if(id==='M1'){const result=mean(valid.map(v=>v.result));return {id,months,values,result,classification:classifyM1(result),label:'prévia analítica',validMonths:valid.length}}
  const scores=valid.map(v=>v.score).filter(v=>v!=null),score=mean(scores),rawMean=mean(valid.map(v=>v.result)),auditScore=scoreMunicipal(id,rawMean),remaining=4-valid.length,target=Number(state.preferences.targetScore)||100,needed=remaining?((4*target-sum(scores))/remaining):null;return {id,months,values,score,rawMean,auditScore,validMonths:valid.length,needed,status:needed==null?'Quadrimestre completo':needed>100?'Matematicamente impossível':needed<=0?'Já assegurado':'Ainda possível',diverges:score!=null&&auditScore!=null&&Math.abs(score-auditScore)>.01};
}
function quarterFederal(id,year=state.preferences.year,q=state.preferences.quarter){
  const months=quarterMonths(year,q),values=months.map(m=>federalComponents(id,m));
  return {id,months,values};
}
function cumulativeFederal(id,months){
  const vals=months.map(m=>federalComponents(id,m)).filter(v=>v.result!=null);
  if(!vals.length)return {numerator:null,denominator:null,result:null,validMonths:0};
  if(['B1','B4'].includes(id)){
    // B1/B4 espelham M1/M3 (denominador de população/faixa etária, não um fluxo mensal). Desde a v2.16 o quadrimestre
    // é a média dos 4 meses, como em M1/M3 (mês sem dado conta como 0%). Pedido do usuário: a soma dos numeradores
    // sobre o denominador de um único mês inflava o resultado (ex.: 2,93% "Ótimo" com meses de ~0,7%).
    const all=months.map(m=>federalComponents(id,m)),denominator=federalComponents(id,state.preferences.month).denominator;
    return {numerator:sum(vals.map(v=>v.numerator)),denominator:denominator>0?denominator:null,result:sum(all.map(v=>v.result??0))/4,validMonths:vals.length,average:true};
  }
  const numerator=sum(vals.map(v=>v.numerator)),denominator=sum(vals.map(v=>v.denominator));
  return {numerator,denominator,result:denominator>0?100*numerator/denominator:null,validMonths:vals.length};
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
  if(['M1','M3'].includes(id)){
    // M1/M3 têm denominador de população/faixa etária (confirmado manualmente por vigência), não um fluxo mensal —
    // somar o denominador dos 4 meses multiplicaria esse valor por até 4x. Pedido explícito do usuário (v1.38):
    // o denominador do acumulado do quadrimestre fica fixo no valor confirmado para o mês em foco; só o numerador soma.
    const ref=state.preferences.month,refComp=municipalComponents(id,ref),denominator=refComp.denominator;
    if(!(denominator>0))return {numerator:null,denominator:null,result:null,validMonths:0};
    const numerator=sum(vals.map(v=>v.numerator));
    return {numerator,denominator,result:100*numerator/denominator,validMonths:vals.length};
  }
  const numerator=sum(vals.map(v=>v.numerator)),denominator=sum(vals.map(v=>v.denominator));
  return {numerator,denominator,result:denominator>0?100*numerator/denominator:null,validMonths:vals.length};
}
// M1/M3 (denominador de população/faixa etária) — o "resultado do quadrimestre" é a MÉDIA das 4 percentagens mensais
// (mesma base da coluna "Parcial" da tabela de apuração), nunca a soma cumulativa de cumulativeMunicipal (que fica
// numa escala de até 4x uma percentagem mensal, incompatível com uma meta definida em escala mensal). Reaproveitada
// tanto pela Visão Geral (metaProgress/metaCard) quanto pela tabela de apuração (quadrimestralOutlook) — v1.40.
// Recebe `values` já calculados (não `months`) para nunca divergir de quem já tem essa lista pronta (quarterMunicipal).
function quarterAverageProgress(id,values){
  const validMonths=values.filter(v=>v.result!=null).length;
  if(!validMonths)return {result:null,numerator:null,denominator:null,validMonths:0};
  const parts=values.map(v=>v.result==null?0:v.result),partial=sum(parts)/4;
  const ref=state.preferences.month,denomRef=municipalComponents(id,ref).denominator,currentNumerator=sum(values.map(v=>v.numerator||0));
  return {result:partial,numerator:currentNumerator,denominator:denomRef,validMonths};
}
function gapCountForAverage(currentNumerator,denomRef,targetPct){return denomRef>0?Math.max(0,Math.ceil((targetPct/100)*4*denomRef-currentNumerator)):null}
function metaGap(id,numerator,denominator){
  if(numerator==null||!(denominator>0))return null;
  if(id==='M1')return remainingForM1(numerator,denominator,1.25);
  return remainingInclusive(numerator,denominator,metaTarget(id),['M4','M5'].includes(id));
}
function metaProgress(id,mk){
  const comp=municipalComponents(id,mk),months=quarterMonths(state.preferences.year,state.preferences.quarter),meta=metaTarget(id);
  const monthGap=metaGap(id,comp.numerator,comp.denominator);
  let quarterEntry;
  if(['M1','M3'].includes(id)){
    const avg=quarterAverageProgress(id,months.map(m=>municipalComponents(id,m))),achieved=avg.result!=null&&avg.result>=meta;
    const gap=achieved?0:(avg.validMonths?gapCountForAverage(avg.numerator,avg.denominator,meta):null);
    quarterEntry={result:avg.result,numerator:avg.numerator,denominator:avg.denominator,validMonths:avg.validMonths,gap,achieved};
  }else{
    const cum=cumulativeMunicipal(id,months),quarterGap=metaGap(id,cum.numerator,cum.denominator);
    quarterEntry={...cum,gap:quarterGap,achieved:quarterGap===0,validMonths:cum.validMonths};
  }
  return {id,meta,month:{...comp,gap:monthGap,achieved:monthGap===0},quarter:quarterEntry};
}
function metaLine(entry,unit,missingText,scopeWord,ended=false){
  if(entry.result==null)return missingText;
  if(entry.achieved)return `<strong>Meta garantida</strong> — não depende de mais nenhum ${unit.singular} ${scopeWord}.`;
  const verb=ended?(entry.gap===1?'Faltou':'Faltaram'):'Faltam',periodWord=scopeWord==='agora'?'este mês':'no quadrimestre';
  return `${verb} <strong>${fmtNum(entry.gap,0)}</strong> ${entry.gap===1?unit.singular:unit.plural} para bater a meta ${periodWord}.${ended?' Não há mais tempo para recuperar.':''}`;
}
function m1Band(result){return result==null?null:RULESETS.municipal.indicators.M1.bands.find(b=>b.test(result))}
function zoneRulerHTML(segs,pos){
  return `<div class="zone-ruler"><div class="zone-ruler-track">${segs.map(s=>`<span style="width:${s.w}%;background:${s.c}"></span>`).join('')}</div>${pos==null?'':`<i class="zone-ruler-marker" style="left:${pos}%"></i>`}</div><div class="zone-legend">${segs.map(s=>`<span class="zone-legend-item"><i style="background:${s.c}"></i>${esc(s.l)}</span>`).join('')}</div>`;
}
function metaRulerHTML(id,result){
  if(result==null)return `<div class="zone-ruler"><div class="zone-ruler-track zone-ruler-track--empty"><span style="width:100%"></span></div></div>`;
  if(id==='M1'){
    const max=1.7,bounds=[0,.25,.75,1.25,max];
    const labels=['Regular','Suficiente','Bom','Ótimo'],colors=['var(--mz-regular)','var(--mz-suficiente)','var(--mz-bom)','var(--mz-otimo)'];
    const segs=labels.map((l,i)=>({w:(bounds[i+1]-bounds[i])/max*100,c:colors[i],l}));
    return zoneRulerHTML(segs,clamp(result/max*100));
  }
  const r=RULESETS.municipal.indicators[id],max=r.meta*1.3;
  const segs=[{w:clamp(r.cutoff/max*100),c:'var(--mz-regular)',l:'Abaixo do corte'},{w:clamp((r.meta-r.cutoff)/max*100),c:'var(--mz-suficiente)',l:'Entre corte e meta'},{w:clamp((max-r.meta)/max*100),c:'var(--mz-otimo)',l:'Meta batida'}];
  return zoneRulerHTML(segs,clamp(result/max*100));
}
function overviewTint(cardState){
  if(cardState==='success')return {bg:'var(--mz-otimo-soft)',accent:'var(--mz-otimo)',pill:'mz-otimo'};
  if(cardState==='good')return {bg:'var(--mz-bom-soft)',accent:'var(--mz-bom)',pill:'mz-bom'};
  if(cardState==='warn')return {bg:'var(--mz-suficiente-soft)',accent:'var(--mz-suficiente)',pill:'mz-suficiente'};
  if(cardState==='bad')return {bg:'var(--mz-regular-soft)',accent:'var(--mz-regular)',pill:'mz-regular'};
  return {bg:'var(--inner)',accent:'var(--muted)',pill:'mz-neutral'};
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
  const episodes2i=merged2IEpisodes();for(const e of episodes2i){if(!e.phoneNormalized&&e.telefone)list.push({level:'info',code:'2I_PHONE_INVALID',episodeId:e.id,message:'Há telefone 2I inválido ou sem DDD; o WhatsApp permanece desabilitado.'})}
  for(const m of state.gestantes.manual.filter(x=>!x.archived)){const match=findManualMatch(m,episodes2i);if(match&&!state.gestantes.merges[m.id])list.push({level:'warning',code:'2I_MANUAL_MATCH',manualId:m.id,episodeId:match.id,message:'Cadastro manual possivelmente corresponde a registro posterior do Metabase; exige reconciliação explícita.'})}
  const crossRepeats=firstConsultationRepeatsAcrossFiles();if(crossRepeats.length)list.push({level:'info',code:'M1_REPEAT_WITHIN_12M',message:`${crossRepeats.length} paciente(s) com primeira consulta repetida em menos de 12 meses da ocorrência anterior — já excluída(s) automaticamente do numerador de M1/B1 no(s) mês(es) correspondente(s).`,dupGroups:crossRepeats});
  const crossRepeatsM2=treatmentConcludedRepeatsAcrossFiles();if(crossRepeatsM2.length)list.push({level:'info',code:'M2_REPEAT_WITHIN_12M',message:`${crossRepeatsM2.length} paciente(s) com tratamento concluído repetido em menos de 12 meses da ocorrência anterior — já excluída(s) automaticamente do numerador de M2/B2 no(s) mês(es) correspondente(s).`,dupGroups:crossRepeatsM2});
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
// ---- Produção (Procedimentos Detalhado do CELK) × prontuário da gestante ----
// O relatório traz o paciente como "( código ) NOME"; o código é o mesmo número do prontuário do CELK
// (Usuária no Monitora APS). Um atendimento da equipe de saúde bucal dentro da gestação conta como
// atendimento odontológico para o 2I. Atividade educativa em grupo não conta.
let prodIndexCache={key:'',map:new Map()};
function productionVisitsIndex(){
  const snaps=state.snapshots.filter(s=>s.profile==='celk_procedimentos_detalhado'&&!s.supersededBy),key=snaps.map(s=>s.id).join('|');
  if(prodIndexCache.key===key)return prodIndexCache.map;
  const map=new Map(),seen=new Set();
  for(const s of snaps)for(const m of Object.values(s.dataByMonth||{}))for(const v of m.patientVisits||[]){const k=`${v.id}|${v.date}`;if(seen.has(k))continue;seen.add(k);(map.get(v.id)||map.set(v.id,[]).get(v.id)).push(v)}
  for(const list of map.values())list.sort((a,b)=>a.date.localeCompare(b.date));
  prodIndexCache={key,map};return map;
}
function productionVisitsFor(e){
  const k=pid(e?.prontuario);if(!k)return [];const list=productionVisitsIndex().get(k);if(!list)return [];
  // Só conta atendimento entre a DUM e a DPP (ou o parto, se veio antes). Sem DUM e sem DPP não há como saber se o
  // atendimento foi na gestação, então não conta (v2.25, pedido do usuário; antes valiam os últimos 300 dias).
  const start=pregDum(e),dpp=pregDpp(e);if(!start||!dpp)return [];const parto=parseDate(e.dataParto),end=parto&&parto<dpp?parto:dpp;
  const from=isoDate(start),to=isoDate(end);return list.filter(v=>v.date>=from&&v.date<=to);
}
// Todos os atendimentos da gestante na produção do CELK, de qualquer data (histórico da gaveta, v2.26).
function productionVisitsAllFor(e){const k=pid(e?.prontuario);return k?(productionVisitsIndex().get(k)||[]):[]}
function hasProductionVisit(e){return productionVisitsFor(e).length>0}
function isAttended(e){return e.status2i==='atende'||e.monitoraOdonto==='atende'||hasProductionVisit(e)||['ok_manual','atende_confirmado'].includes(followupFor(e.id).state)}
function status2ILabel(v){return v==='atende'?'Atende':v==='pendente'?'Pendente':v==='indeterminado'?'Indeterminado':'Sem registro no Metabase'}
function episodeOverride(id){return state.gestantes.overrides[id]||{}}
function mergedEpisodes(){
  const metabase=merged2IEpisodes().map(e=>({...e,origin:'metabase'})),manual=state.gestantes.manual.filter(m=>!m.archived);const out=[];
  for(const e of metabase){const entry=[...manual].find(m=>state.gestantes.merges[m.id]===e.id);const ov=episodeOverride(e.id);
    if(entry){out.push({...entry,...e,...ov,origin:'metabase_manual',manualId:entry.id,metabaseId:e.id,observacao:entry.observacao||'',dataAtividadeManual:entry.dataAtividadeManual||'',phoneNormalized:normalizePhone(ov.telefone??e.telefone)})}
    else out.push({...e,...ov,phoneNormalized:normalizePhone(ov.telefone??e.telefone)})}
  for(const m of manual)if(!state.gestantes.merges[m.id])out.push({...m,origin:'manual',status2i:'sem_metabase',phoneNormalized:normalizePhone(m.telefone)});
  const mon=mergedMonitora();
  if(mon){const byUser=new Map((mon.monitoraRows||[]).map(r=>[r.usuaria,r])),used=new Set(),attach=(e,r)=>Object.assign(e,{monitoraUsuaria:r.usuaria,monitoraOdonto:r.monitoraOdonto,monitoraPeriodo:r.periodo,monitoraEquipe:r.equipe,consOdontoMonitora:r.consOdonto});
    for(const e of out){const k=pid(e.prontuario),r=k&&byUser.get(k);if(r&&!used.has(k)){used.add(k);attach(e,r)}}
    for(const r of mon.monitoraRows||[]){if(used.has(r.usuaria))continue;const id=`mon-${r.usuaria}`,ov=episodeOverride(id);out.push(attach({id,origin:'monitora',prontuario:r.usuaria,equipe:r.equipe,nome:patientNameFor(r.usuaria),nomeDaProducao:!ov.nome&&!!patientNameFor(r.usuaria),status2i:r.monitoraOdonto,unit:mon.unit,...ov,phoneNormalized:normalizePhone(ov.telefone)},r))}}
  return out;
}
function pregnancyStage(e){return e.dataParto?'finalizada':'ativa'}
function isExcluded(id){return !!state.gestantes.excluded[id]}
function visibleByExclusion(episodes){const only=state.preferences.pregExcluded==='only';return episodes.filter(e=>only?isExcluded(e.id):!isExcluded(e.id))}
function applyPregFilters(episodes,{ignoreIncomplete=false}={}){const p=ignoreIncomplete?{...state.preferences,pregIncomplete:false}:state.preferences;const search=norm(p.pregSearch);return episodes.filter(e=>(!p.pregTeam||e.equipe===p.pregTeam)&&(!p.pregOrigin||e.origin===p.pregOrigin)&&(!p.pregPhone||(p.pregPhone==='valid'?!!e.phoneNormalized:!e.phoneNormalized))&&(!p.pregIncomplete||missingDataFields(e).length>0)&&(!search||norm(`${e.nome} ${e.prontuario}`).includes(search)))}
function excludeEpisode(id,reason){state.gestantes.excluded[id]={at:nowISO(),reason:reason||''};audit('2i_episode_excluded',{episodeId:id,reason:reason||''});queueSave();closeDrawer();refreshAll();toast('Gestante excluída da lista operacional (dado preservado, pode ser restaurado).')}
function restoreEpisode(id){if(state.gestantes.excluded[id]?.source==='monitora_puerperio'){state.gestantes.puerperioIgnored=state.gestantes.puerperioIgnored||{};state.gestantes.puerperioIgnored[id]=true}delete state.gestantes.excluded[id];audit('2i_episode_restored',{episodeId:id});queueSave();closeDrawer();refreshAll();toast('Gestante restaurada na lista operacional.')}
function openExcludeEpisode(id){openModal(`<div class="modal-head"><div><h2 id="modalTitle">Excluir gestante da lista operacional</h2><p>Não apaga o cadastro nem altera o panorama do CSV — só some da lista operacional até ser restaurada.</p></div></div><form id="excludeForm"><div class="modal-body"><label class="field full"><span>Motivo (opcional)</span><textarea id="excludeReason" placeholder="Ex.: gestação encerrada, registro duplicado, mudou de unidade"></textarea></div><div class="modal-foot"><button type="button" class="btn" data-close-modal>Cancelar</button><button type="submit" class="btn danger">Confirmar exclusão</button></div></form>`,{wide:false});document.getElementById('excludeForm').onsubmit=e=>{e.preventDefault();excludeEpisode(id,document.getElementById('excludeReason').value.trim())}}
function ageAt(e,date=new Date()){const b=parseDate(e.dataNascimento);if(!b)return null;let age=date.getFullYear()-b.getFullYear();if(date<new Date(date.getFullYear(),b.getMonth(),b.getDate()))age--;return age}
function gestationalWeeks(e,at=new Date()){const dum=pregDum(e);if(!dum)return null;const end=parseDate(e.dataParto)||at;const weeks=Math.floor((end-dum)/(7*864e5));return weeks>=0&&weeks<=45?weeks:null}
function setFollowup(id,next,note='',extra={}){
  const old=followupFor(id),entry={at:nowISO(),from:old.state,to:next,note,...(extra.agendaAt?{agendaAt:extra.agendaAt}:{})};state.gestantes.followups[id]={state:next,updatedAt:entry.at,history:[...(old.history||[]),entry],...(next==='agendada'&&extra.agendaAt?{agendaAt:extra.agendaAt}:{})};audit('2i_followup_changed',{episodeId:id,from:old.state,to:next});queueSave();refreshAll();reopenDrawerIfOpen(id);
}
function reopenDrawerIfOpen(id){const b=document.getElementById('drawerBackdrop');if(!b||!b.classList.contains('open')||!document.querySelector('#drawer .pq-drawer'))return;openEpisode(pregDrawer.id||id)}
function addFollowupNote(id,text){text=(text||'').trim();if(!text){toast('Escreva algo antes de salvar a nota.');return}const old=followupFor(id),entry={at:nowISO(),type:'note',text};state.gestantes.followups[id]={state:old.state,updatedAt:old.updatedAt,history:[...(old.history||[]),entry]};audit('2i_followup_note_added',{episodeId:id});queueSave();refreshAll();toast('Nota adicionada ao acompanhamento.');reopenDrawerIfOpen(id);
}
function toggleGestacaoEncerrada(id){const e=mergedEpisodes().find(x=>x.id===id||x.manualId===id);if(!e)return;const finalized=pregnancyStage(e)==='finalizada',newParto=finalized?'':isoDate(new Date());if(e.origin==='manual'){const m=state.gestantes.manual.find(x=>x.id===id);if(m){m.dataParto=newParto;m.updatedAt=nowISO();m.edits=[...(m.edits||[]),{at:nowISO(),action:'gestacao_encerrada_toggle'}]}}else{const ov={...episodeOverride(id)};ov.dataParto=newParto;state.gestantes.overrides[id]=ov}audit('2i_gestacao_encerrada_toggle',{episodeId:id,to:finalized?'ativa':'finalizada'});queueSave();refreshAll();reopenDrawerIfOpen(id);
}
function saveAllFieldsOverride(id){const val=k=>{const el=document.getElementById(k);return el?el.value.trim():''};const dv=k=>{const el=document.getElementById(k);return el?el.value:''};const ov={...episodeOverride(id),nome:val('efNome'),prontuario:sanitizeProntuario(val('efProntuario')),equipe:val('efEquipe'),dataNascimento:dv('efNascimento'),enderecoOverride:val('efEndereco'),telefone:val('efTelefone'),ultimaMenstruacao:dv('efDum'),dataProvParto:dv('efDpp'),dataParto:dv('efParto'),notaLocal:val('efNota')};state.gestantes.overrides[id]=ov;audit('2i_full_override_saved',{episodeId:id});queueSave();refreshAll();toast('Dados atualizados localmente. O CSV original do Metabase continua intacto.');reopenDrawerIfOpen(id);
}
function mergeManual(manualId,episodeId){
  const m=state.gestantes.manual.find(x=>x.id===manualId),e=merged2IEpisodes().find(x=>x.id===episodeId);if(!m||!e)return;const mf=followupFor(manualId),ef=followupFor(episodeId);state.gestantes.merges[manualId]=episodeId;if((mf.history||[]).length){state.gestantes.followups[episodeId]={state:mf.state,updatedAt:mf.updatedAt,history:[...(ef.history||[]),...(mf.history||[]).map(h=>({...h,note:`${h.note||''} (origem: cadastro manual)`.trim()}))]};delete state.gestantes.followups[manualId]}
  audit('2i_manual_merged',{manualId,episodeId});queueSave();closeDrawer();refreshAll();toast('Cadastro manual mesclado com o episódio do Metabase.');
}
function gestantesDataCounts(){return {snapshots:state.snapshots.filter(s=>s.profile==='metabase_gestantes_2i'||s.profile===MONITORA_PROFILE).length,manual:state.gestantes.manual.length,followups:Object.keys(state.gestantes.followups).length,overrides:Object.keys(state.gestantes.overrides).length,excluded:Object.keys(state.gestantes.excluded).length}}
function clearAllGestantesData(){
  const before=gestantesDataCounts();
  for(const s of state.snapshots)if(s.profile==='metabase_gestantes_2i'||s.profile===MONITORA_PROFILE)sessionRaw.delete(s.id);
  state.snapshots=state.snapshots.filter(s=>s.profile!=='metabase_gestantes_2i'&&s.profile!==MONITORA_PROFILE);
  state.gestantes={manual:[],followups:{},merges:{},excluded:{},overrides:{},puerperioIgnored:{}};
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

function kpi(label,value,desc,accent='#7551e9',iconName='trend'){return `<article class="card kpi" style="--accent:${accent}"><div class="stripe"></div><div class="kpi-head"><div class="kpi-label">${esc(label)}</div><div class="soft-icon">${icon(iconName)}</div></div><div class="kpi-value">${value}</div><div class="kpi-desc">${desc}</div></article>`}
function overviewStat(label,value,desc,accent,accentSoft,iconName){return `<div class="stat-card" style="--stat-accent:${accent};--stat-bg:${accentSoft}"><div class="stat-head"><span class="stat-icon">${icon(iconName)}</span><span class="stat-label">${esc(label)}</span></div><div class="stat-value">${value}</div><div class="stat-desc">${desc}</div></div>`}
function pill(label,cls){return `<span class="pill ${cls||statusClass(label)}">${esc(label||'Indeterminado')}</span>`}
const ROLE_INDICATOR_MAP={first:[['M1','Numerador'],['B1','Numerador'],['M2','Denominador'],['B2','Denominador']],concluded:[['M2','Numerador'],['B2','Numerador']],preventive:[['M4','Numerador'],['B5','Numerador']],m4den:[],art:[['M5','Numerador'],['B6','Numerador']],restorative:[['M5','Denominador'],['B6','Denominador']],b3num:[['B3','Numerador']],b3den:[['B3','Denominador']],b5den:[['M4','Denominador'],['B5','Denominador']]};
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
/* ---------- Apuração do quadrimestre sem pontos (leitura por meta) ---------- */
function pctDecimals(id){return id==='M1'||id==='B1'?2:1}
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
function zonePillClass(id,result){const zc=zoneClass(id,result);return zc==='zone-good'?'success':zc==='zone-warn'?'warn':zc==='zone-bad'?'bad':'neutral'}
function quarterPartial(q){const parts=q.values.map(v=>v.result==null?0:v.result);return sum(parts)/4}
// O quadrimestre "já fechou" quando a data real de hoje (a do computador que acessa a ferramenta) passa do último dia
// do último mês do quadrimestre — não quando o "mês em foco" (filtro selecionado) chega lá. Isso decide o tempo verbal
// da "Projeção do quadrimestre": passado ("faltou") depois de fechado, futuro ("ainda faltam") enquanto ainda corre.
function isMonthOver(mk){const [y,m]=mk.split('-').map(Number);return new Date()>new Date(y,m,0,23,59,59,999)}
function isQuarterOver(months){return isMonthOver(months.at(-1))}
function quadrimestralOutlook(id,q){
  const unit=META_UNIT_LABEL[id],meta=metaTarget(id),ref=state.preferences.month,dec=pctDecimals(id),ended=isQuarterOver(q.months);
  if(['M1','M3'].includes(id)){
    // M1/M3 têm denominador de população/faixa etária — não é um fluxo mensal, então não faz sentido somar as 4
    // percentagens mensais (escalas diferentes de um alvo mensal, ver v1.38). A meta quadrimestral desses dois é a
    // MÉDIA simples dos 4 meses (mesma base já mostrada na coluna "Parcial", mês sem dado conta como 0%), comparada
    // ao mesmo alvo percentual mensal. Pedido explícito do usuário (v1.39) — mesma conta de quarterAverageProgress,
    // reaproveitada aqui também para nunca divergir do que a Visão Geral (metaProgress/metaCard) mostra.
    const avg=quarterAverageProgress(id,q.values);
    if(!avg.validMonths)return ended
      ?{cls:'bad',label:'Meta vencida e não cumprida',detail:'Quadrimestre encerrado sem dados suficientes para apurar o resultado.'}
      :{cls:'neutral',label:'Sem dados suficientes',detail:'Ainda não há dados no quadrimestre para projetar a meta.'};
    const partial=avg.result,cutoff=id==='M1'?0.25:RULESETS.municipal.indicators[id].cutoff;
    const denomRef=avg.denominator,currentNumerator=avg.numerator;
    const gapCount=target=>gapCountForAverage(currentNumerator,denomRef,target);
    const units=n=>n===1?unit.singular:unit.plural;
    if(partial>=meta)return {cls:'success',label:'Meta garantida',detail:ended?`O quadrimestre fechou com média de ${fmtPct(partial,dec)} (Parcial), acima da meta de ${fmtPct(meta,dec)}.`:`O quadrimestre já está com média de ${fmtPct(partial,dec)} (Parcial), acima da meta de ${fmtPct(meta,dec)} — não depende mais dos meses restantes.`};
    const gapMeta=gapCount(meta),gapCutoff=partial<cutoff?gapCount(cutoff):null;
    const denomNote=denomRef>0?` (estimativa com base no denominador de ${id} confirmado para ${fmtMonth(ref,true)}, mês em foco)`:' — sem denominador confirmado para converter a diferença em quantidade';
    if(ended)return {cls:'bad',label:'Meta vencida e não cumprida',detail:`O quadrimestre fechou com média de ${fmtPct(partial,dec)} (Parcial), abaixo da meta de ${fmtPct(meta,dec)}. ${gapMeta!=null?`${gapMeta===1?'Faltou':'Faltaram'} ${fmtNum(gapMeta,0)} ${units(gapMeta)}`:'Faltou atingir a meta'}${denomNote} — não há mais meses para recuperar.`};
    const cutoffPart=gapCutoff!=null?` ou ${fmtNum(gapCutoff,0)} ${units(gapCutoff)} para a nota de corte (${fmtPct(cutoff,dec)})`:'';
    return {cls:partial>=cutoff?'warn':'bad',label:partial>=cutoff?'Ainda possível':'Abaixo do corte',detail:`Média atual de ${fmtPct(partial,dec)} (Parcial). ${gapMeta!=null?`Ainda faltam ${fmtNum(gapMeta,0)} ${units(gapMeta)} para bater a meta (${fmtPct(meta,dec)})${cutoffPart}`:'Ainda é possível bater a meta'}${denomNote}.`};
  }
  const cum=cumulativeMunicipal(id,q.months);
  const gap=metaGap(id,cum.numerator,cum.denominator);
  if(gap===0)return {cls:'success',label:'Meta garantida',detail:ended?`O quadrimestre fechou somando ${fmtPct(cum.result,dec)}, acima da meta de ${fmtPct(meta,dec)}.`:`O quadrimestre já soma ${fmtPct(cum.result,dec)}, na meta de ${fmtPct(meta,dec)} — não depende mais dos meses restantes.`};
  if(gap==null)return ended
    ?{cls:'bad',label:'Meta vencida e não cumprida',detail:'Quadrimestre encerrado sem dados suficientes para apurar o resultado.'}
    :{cls:'neutral',label:'Sem dados suficientes',detail:'Ainda não há dados no quadrimestre para projetar a meta.'};
  if(ended)return {cls:'bad',label:'Meta vencida e não cumprida',detail:`Faltaram ${fmtNum(gap,0)} ${gap===1?unit.singular:unit.plural} para bater a meta neste quadrimestre — não há mais meses para recuperar.`};
  const remainingMonths=Math.max(1,q.months.filter(m=>m>ref).length),requiredPerMonth=gap/remainingMonths,validMonths=q.values.filter(v=>v.result!=null),avgMonthlyPace=validMonths.length?mean(validMonths.map(v=>v.numerator)):null,monthsWord=remainingMonths===1?'mês restante':'meses restantes';
  if(!avgMonthlyPace)return {cls:'warn',label:'Ainda possível',detail:`Faltam ${fmtNum(gap,0)} ${gap===1?unit.singular:unit.plural} em ${remainingMonths} ${monthsWord} (${fmtNum(requiredPerMonth,1)}/mês). Sem histórico no quadrimestre para comparar com o ritmo usual.`};
  const ratio=requiredPerMonth/avgMonthlyPace;
  if(ratio<=1)return {cls:'good',label:'Ainda possível, no ritmo normal',detail:`Precisa de ${fmtNum(requiredPerMonth,1)} ${unit.plural}/mês; a média já registrada no quadrimestre é ${fmtNum(avgMonthlyPace,1)}/mês.`};
  if(ratio<=2)return {cls:'warn',label:'Precisa acelerar o ritmo',detail:`Precisa de ${fmtNum(requiredPerMonth,1)} ${unit.plural}/mês; acima da média já registrada de ${fmtNum(avgMonthlyPace,1)}/mês.`};
  return {cls:'bad',label:'Ritmo exigido muito acima do histórico',detail:`Precisa de ${fmtNum(requiredPerMonth,1)} ${unit.plural}/mês, mas o histórico do quadrimestre é de só ${fmtNum(avgMonthlyPace,1)}/mês — bater a meta exigiria um ritmo bem fora do padrão.`};
}
/* ---------- Apuração do quadrimestre federal (paleta própria — nunca reaproveita as cores municipais) ---------- */
function federalZoneClass(id,result){
  if(result==null)return null;
  const label=classifyFederal(id,result);if(!label)return null;
  if(label.startsWith('Ótimo'))return 'fed-otimo';
  if(label.startsWith('Bom'))return 'fed-bom';
  if(label.startsWith('Suficiente'))return 'fed-suficiente';
  return 'fed-regular';
}
function federalShortLabel(label){return label&&label.includes('·')?label.split('·')[0].trim():label}
function federalQuadrimestralOutlook(id,q){
  const ref=state.preferences.month,cum=cumulativeFederal(id,q.months),fixedDen=['B1','B4'].includes(id);
  if(cum.result==null){
    const remainingMonths=q.months.filter(m=>m>ref).length;
    if(fixedDen)return {cls:'neutral',label:'Sem dados suficientes',detail:`Sem resultado de ${id} nos meses do quadrimestre — confirme o denominador de ${id==='B1'?'M1':'M3'} para calcular.`};
    return remainingMonths===0
      ?{cls:'bad',label:'Sem dados suficientes',detail:'Quadrimestre encerrado sem dados suficientes para apurar o acumulado.'}
      :{cls:'neutral',label:'Sem dados suficientes',detail:'Ainda não há dados suficientes no quadrimestre para calcular o acumulado.'};
  }
  const label=classifyFederal(id,cum.result),cls=statusClass(label);
  const detail=fixedDen
    ?`Resultado do quadrimestre: ${fmtPct(cum.result,pctDecimals(id))}, média dos 4 meses (mês sem dado conta como 0%), como ${id==='B1'?'M1':'M3'} no painel Municipal, classificado como ${label} pela Nota ${id}. O denominador é de população/faixa etária, não um fluxo mensal, então não se soma mês a mês.`
    :`Resultado acumulado do quadrimestre: ${fmtPct(cum.result,pctDecimals(id))} (${fmtNum(cum.numerator,0)} ÷ ${fmtNum(cum.denominator,2)}), classificado como ${label} pela Nota ${id}. Cálculo de conveniência da ferramenta (soma dos numeradores/denominadores dos meses com dado) — a Nota não define regra oficial de consolidação quadrimestral.`;
  return {cls,label:federalShortLabel(label),detail};
}
/* ---------- Visão Geral (v2.14): resumo, "o que falta" em ordem M1–M5, situação dos dados, cartões com os meses do quadrimestre e gaveta do indicador ---------- */
const OVERVIEW_IDS=['M1','M2','M3','M4','M5'];
const OV_SHORT_UNIT={M1:['primeira consulta','primeiras consultas'],M2:['tratamento concluído','tratamentos concluídos'],M3:['criança','crianças'],M4:['procedimento preventivo','procedimentos preventivos'],M5:['ART','ARTs']};
const OV_ZONE_COLOR={otimo:'var(--mz-otimo)',bom:'var(--mz-bom)',suf:'var(--mz-suficiente)',reg:'var(--mz-regular)'};
function ovZone(id,v){if(v==null)return null;if(id==='M1')return v>1.25?'otimo':v>.75?'bom':v>.25?'suf':'reg';const r=RULESETS.municipal.indicators[id];return v>=r.meta?'otimo':v>=r.cutoff?'suf':'reg'}
function ovDenDecimals(v){return v!=null&&v%1?1:0}
function ovMissingDenom(id,mk){return ['M1','M3'].includes(id)&&!getDenominator(id,'municipal',mk)}
function ovCurrentMonthKey(){const d=new Date();return monthKey(d.getFullYear(),d.getMonth()+1)}
function metaCardState(id,mk,scope){
  const p=metaProgress(id,mk),rule=RULESETS.municipal.indicators[id],unit=META_UNIT_LABEL[id],entry=scope==='quarter'?p.quarter:p.month;
  const months=quarterMonths(state.preferences.year,state.preferences.quarter),ended=scope==='quarter'?isQuarterOver(months):isMonthOver(mk);
  const metaLabel=id==='M1'?'Ótimo >1,25%':fmtPct(p.meta,p.meta<2?1:0);
  const band=id==='M1'?m1Band(entry.result):null;
  const label=id==='M1'?(band?.label||'Sem dados'):(entry.result==null?'Sem dados':entry.achieved?(scope==='quarter'?'Meta garantida':'Meta batida'):(scope==='quarter'?(ended?'Meta não atingida':'Ainda falta'):'Abaixo da meta'));
  const cardState=id==='M1'?(band?statusClass(band.label):'neutral'):(entry.result==null?'neutral':entry.achieved?'success':'warn');
  const noData=entry.result==null,missingDenom=ovMissingDenom(id,mk);
  const missing=noData?(missingDenom&&scope==='month'?'Denominador do mês ainda não confirmado.':scope==='quarter'?'Ainda sem meses suficientes com dado confirmado.':'Sem relatório desta competência ainda.'):'';
  const done=id==='M1'?band?.label==='Ótimo':!!entry.achieved;
  return {p,rule,unit,entry,ended,metaLabel,label,cardState,tint:overviewTint(cardState),noData,missing,missingDenom,done};
}
function ovRulerHTML(id,result){
  let segs,max;
  if(id==='M1'){max=1.7;segs=[[.25,'reg'],[.5,'suf'],[.5,'bom'],[.45,'otimo']]}else{const r=RULESETS.municipal.indicators[id];max=r.meta*1.3;segs=[[r.cutoff,'reg'],[r.meta-r.cutoff,'suf'],[max-r.meta,'otimo']]}
  const pos=result==null?null:clamp(100*result/max);
  return `<div class="ov-ruler${result==null?' empty':''}">${segs.map(([w,k])=>`<span style="width:${100*w/max}%;background:${OV_ZONE_COLOR[k]}"></span>`).join('')}${pos==null?'':`<em style="left:calc(${pos}% - 1.5px)"></em>`}</div>`;
}
function ovQuarterBarsHTML(id,mk){
  const months=quarterMonths(state.preferences.year,state.preferences.quarter),cur=ovCurrentMonthKey(),dec=pctDecimals(id);
  const vals=months.map(m=>({m,v:municipalComponents(id,m).result,future:m>cur}));
  const max=Math.max(...vals.map(x=>x.v??0),metaTarget(id))*1.1||1;
  return `<div class="ov-bars" title="Meses do quadrimestre Q${state.preferences.quarter}">${vals.map(x=>{const {month}=parseMonthKey(x.m),z=ovZone(id,x.v);return `<div class="${x.m===mk?'cur':''}">${x.v==null?`<i class="empty" title="${x.future?'Mês ainda não chegou':'Sem dado'}"></i>`:`<b>${fmtNum(x.v,dec)}%</b><i style="height:${Math.max(4,28*x.v/max)}px;background:${OV_ZONE_COLOR[z]}"></i>`}<span>${MONTHS_SHORT[month-1]}</span></div>`}).join('')}</div>`;
}
function ovNumText(id,s,scope){const e=s.entry;if(e.result==null)return '—';if(scope==='quarter'&&['M1','M3'].includes(id))return `média dos 4 meses · ${e.validMonths}/4 com dado`;const t=`${fmtNum(e.numerator)} de ${fmtNum(e.denominator,ovDenDecimals(e.denominator))}`;return scope==='quarter'?`${t} · ${e.validMonths}/4 meses`:t}
function metaCard(id,mk,scope){
  const s=metaCardState(id,mk,scope),{entry,tint,unit}=s;
  return `<article class="card ov-tile${s.noData?' no-data':''}">
<div class="ov-tile-h"><div><div class="indicator-id">${id} · MUNICIPAL</div><div class="ov-tile-name">${esc(s.rule.name)}</div></div><button class="ov-info" data-indicator-detail="${id}" aria-label="Detalhes de ${id}" title="Detalhes">i</button></div>
<div class="ov-val"><strong>${fmtPct(entry.result)}</strong>${pill(s.label,tint.pill)}</div>
<div class="ov-meta"><span>${esc(ovNumText(id,s,scope))}</span><span>meta <b>${s.metaLabel}</b></span></div>
${ovRulerHTML(id,entry.result)}
<div class="ov-gap">${metaLine(entry,unit,s.missing,scope==='quarter'?'no quadrimestre':'agora',s.ended)}</div>
${ovQuarterBarsHTML(id,mk)}
</article>`;
}
function ovPlanRow(id,mk,scope){
  const s=metaCardState(id,mk,scope),e=s.entry,u=OV_SHORT_UNIT[id],monthName=fmtMonth(mk,true).split('/')[0];
  const badge=`<span class="ov-id" style="color:${s.tint.accent};background:${s.tint.bg}">${id}</span>`;
  if(e.result==null&&s.missingDenom)return `<li class="block">${badge}<div class="ov-what"><b>Denominador de ${esc(monthName)} não confirmado</b><small>${esc(s.rule.name)} · sem ele, ${id} não é calculado.</small></div><div class="ov-prog"><div class="ov-prog-top"><span>resultado</span><b>—</b></div><div class="ov-track"></div></div><button class="btn small primary" data-indicator-detail="${id}">Confirmar</button></li>`;
  if(e.result==null)return `<li class="block">${badge}<div class="ov-what"><b>${esc(s.missing||'Sem dados')}</b><small>${esc(s.rule.name)}</small></div><div class="ov-prog"><div class="ov-prog-top"><span>resultado</span><b>—</b></div><div class="ov-track"></div></div><button class="btn small" data-action="import">Importar</button></li>`;
  const target=metaTarget(id),max=target*1.25,pos=clamp(100*e.result/max),tpos=clamp(100*target/max),z=ovZone(id,e.result);
  const title=s.done?(scope==='quarter'?'Meta garantida':'Meta batida'):`${s.ended?(e.gap===1?'Faltou':'Faltaram'):'Faltam'} ${fmtNum(e.gap)} ${e.gap===1?u[0]:u[1]}`;
  return `<li class="${s.done?'done':''}">${badge}<div class="ov-what"><b>${title}</b><small>${esc(s.rule.name)}${id==='M1'?' · para a faixa Ótimo':''}</small></div><div class="ov-prog"><div class="ov-prog-top"><span>${fmtPct(e.result)}</span><b>meta ${id==='M1'?'>1,25%':fmtPct(target,target<2?1:0)}</b></div><div class="ov-track"><i style="width:${pos}%;background:${OV_ZONE_COLOR[z]}"></i><em style="left:${tpos}%"></em></div></div><button class="btn small" data-indicator-detail="${id}">Detalhes</button></li>`;
}
function ovPlanHTML(mk,scope){return `<ol class="ov-plan">${OVERVIEW_IDS.map(id=>ovPlanRow(id,mk,scope)).join('')}</ol>`}
function ovSources(mk){
  const month=fmtMonth(mk,true),last=snaps=>[...snaps].sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt))[0];
  const prod=latestSnapshots('celk_procedimentos_detalhado',mk),grp=latestSnapshots('celk_atividades_grupo',mk),d1=getDenominator('M1','municipal',mk),d3=getDenominator('M3','municipal',mk),g2i=getActive2ISnapshot(),mon=getActiveMonitoraSnapshot();
  const den=(d,id,fed)=>d?{ok:true,title:`Denominador de ${id} e ${fed}`,sub:`${fmtNum(d.value,ovDenDecimals(Number(d.value)))} · ${d.origin||'confirmado'}`}:{ok:false,title:`Denominador de ${id} e ${fed}`,sub:`Não confirmado para ${month}`,action:`<button class="btn small primary" data-indicator-detail="${id}">Confirmar</button>`};
  return [
    prod.length?{ok:true,title:'Produção CELK',sub:`Procedimentos Detalhado · importado ${fmtDate(last(prod).createdAt)}`}:{ok:false,title:'Produção CELK',sub:`Procedimentos Detalhado de ${month} não importado`,action:'<button class="btn small" data-action="import">Importar</button>'},
    grp.length?{ok:true,title:'Atividades em grupo',sub:`Escovação supervisionada · importado ${fmtDate(last(grp).createdAt)}`}:{ok:false,title:'Atividades em grupo',sub:`Relatório de ${month} não importado`,action:'<button class="btn small" data-action="import">Importar</button>'},
    den(d1,'M1','B1'),den(d3,'M3','B4'),
    g2i||mon||state.gestantes.manual.length?{ok:true,title:'Gestantes',sub:[g2i?`Metabase ${fmtDate(g2i.createdAt)}`:'',mon?`Monitora APS ${fmtDate(mon.createdAt)}`:'',!g2i&&!mon?'Só cadastros manuais':''].filter(Boolean).join(' · ')}:{ok:false,title:'Gestantes',sub:'Nenhuma lista importada',action:'<button class="btn small" data-action="import">Importar</button>'}
  ];
}
function ovSourcesHTML(mk,sources,diag){
  const errs=diag.filter(d=>d.level==='error').length,warns=diag.filter(d=>d.level==='warning').length;
  return `<ul class="ov-sources">${sources.map(s=>`<li><span class="ov-st ${s.ok?'ok':'no'}">${s.ok?'✓':'!'}</span><div>${esc(s.title)}<small>${esc(s.sub)}</small></div>${s.action||'<span></span>'}</li>`).join('')}</ul><div class="ov-diag"><span><b>${fmtNum(warns)} alerta(s)</b> · ${fmtNum(errs)} crítico(s) nos diagnósticos</span><button class="ov-link" data-settings-tab="diagnostics">Ver →</button></div>`;
}
function ovTimeChip(mk,scope){
  const now=new Date(),cur=ovCurrentMonthKey();
  if(scope==='quarter'){const months=quarterMonths(state.preferences.year,state.preferences.quarter);if(isQuarterOver(months))return 'Quadrimestre encerrado';const {year,month}=parseMonthKey(months.at(-1)),ahead=months.filter(m=>m>cur).length;return `Q${state.preferences.quarter} termina em ${fmtDate(new Date(year,month,0))}${ahead?` · ${ahead} ${ahead===1?'mês':'meses'} pela frente`:' · último mês'}`}
  if(mk<cur)return 'Mês encerrado';if(mk>cur)return 'Mês ainda não começou';
  const days=new Date(now.getFullYear(),now.getMonth()+1,0).getDate()-now.getDate();return days?`Faltam ${days} dia(s) para o fim de ${MONTHS[now.getMonth()]}`:`Hoje é o último dia de ${MONTHS[now.getMonth()]}`;
}
function overviewHTML(){
  if(!state.snapshots.length)return emptyState('Importe os primeiros relatórios','Use o PDF “Procedimentos Detalhado” durante o mês, o relatório de atividades em grupo para M1–M5 e a lista de gestantes para o 2I.');
  const mk=state.preferences.month,scope=state.preferences.overviewScope==='quarter'?'quarter':'month',diag=buildDiagnostics(),monthName=fmtMonth(mk,true).split('/')[0];
  const goals=metaGoalsHit(mk,scope),states=OVERVIEW_IDS.map(id=>metaCardState(id,mk,scope)),waiting=OVERVIEW_IDS.filter(id=>ovMissingDenom(id,mk)).length;
  const pregExpanded=visibleByExclusion(mergedEpisodes()),attended=pregExpanded.filter(isAttended).length,priority=pregExpanded.filter(isPriority2I).length;
  const seg={atendida:attended,agendada:0,em_contato:0,a_contatar:0};for(const e of pregExpanded){if(isAttended(e))continue;const b=pregBucket(e);if(seg[b]!=null)seg[b]++}
  const segBar=pregExpanded.length?[['atendida','#39b980'],['agendada','#3dc1d3'],['em_contato','#6f84e8'],['a_contatar','#e7a23b']].filter(([k])=>seg[k]).map(([k,c])=>`<i style="width:${100*seg[k]/pregExpanded.length}%;background:${c}"></i>`).join(''):'';
  const sources=ovSources(mk),okCount=sources.filter(s=>s.ok).length,firstMissing=sources.find(s=>!s.ok);
  const dots=OVERVIEW_IDS.map((id,i)=>`<span class="ov-dot" style="color:${states[i].tint.accent};background:${states[i].tint.bg}" title="${esc(states[i].rule.name)}: ${esc(states[i].label)}"><i></i>${id}</span>`).join('');
  return `<div class="ov-ctx"><div class="scope-toggle" role="tablist" aria-label="Recorte"><button class="scope-btn ${scope==='month'?'active':''}" data-overview-scope="month">${esc(monthName.charAt(0).toUpperCase()+monthName.slice(1))}</button><button class="scope-btn ${scope==='quarter'?'active':''}" data-overview-scope="quarter">Quadrimestre Q${state.preferences.quarter}</button></div><span class="ov-chip">${esc(ovTimeChip(mk,scope))}</span></div>
  <section class="card ov-summary" aria-label="Resumo">
    <div class="ov-sum"><div class="ov-sec-t">Metas municipais</div><div class="ov-big">${fmtNum(goals.hit)}<small> de ${OVERVIEW_IDS.length} ${scope==='quarter'?'garantidas':'batidas'}</small></div><div class="ov-dots">${dots}</div><div class="ov-line">${fmtNum(goals.total)} com dado${waiting?` · <b>${waiting} aguardando denominador</b>`:''}.</div></div>
    <div class="ov-sum"><div class="ov-sec-t">Gestantes · 2I</div>${pregExpanded.length?`<div class="ov-big">${fmtPct(100*attended/pregExpanded.length,1)}<small> atendidas</small></div><div class="ov-gbar">${segBar}</div><div class="ov-line">${fmtNum(attended)} de ${fmtNum(pregExpanded.length)} gestante(s) na lista de trabalho.${priority?` <b class="ov-alert">${fmtNum(priority)} no 3º trimestre sem atendimento.</b>`:''}</div><button class="ov-link" data-go="pregnant">Abrir fila de gestantes →</button>`:`<div class="ov-line">Nenhuma gestante na lista ainda.</div><button class="ov-link" data-go="pregnant">Ir para Gestantes →</button>`}</div>
    <div class="ov-sum"><div class="ov-sec-t">Dados de ${esc(monthName)}</div><div class="ov-big">${okCount}<small> de ${sources.length} fontes</small></div><div class="ov-line">${firstMissing?`Falta: <b>${esc(firstMissing.title.charAt(0).toLowerCase()+firstMissing.title.slice(1))}</b>.`:'Tudo pronto para calcular.'} ${fmtNum(diag.filter(d=>d.level==='warning').length)} alerta(s) nos diagnósticos, ${fmtNum(diag.filter(d=>d.level==='error').length)} crítico(s).</div><button class="ov-link" data-ov-jump="ovDados">Ver situação dos dados →</button></div>
  </section>
  <div class="ov-two">
    <section class="card ov-panel" aria-labelledby="ovPlanTitle"><div class="ov-panel-h"><h2 id="ovPlanTitle">O que falta para bater as metas</h2><span>${scope==='quarter'?`Acumulado do Q${state.preferences.quarter} · ${fmtMonth(mk,true)} em foco`:fmtMonth(mk,true)}</span></div>${ovPlanHTML(mk,scope)}</section>
    <section class="card ov-panel" id="ovDados" aria-labelledby="ovSrcTitle"><div class="ov-panel-h"><h2 id="ovSrcTitle">Situação dos dados</h2><span>${esc(fmtMonth(mk,true))}</span></div>${ovSourcesHTML(mk,sources,diag)}</section>
  </div>
  <div class="ov-grp-h"><h2>Indicadores municipais · M1–M5</h2><div class="ov-legend"><span><i style="background:var(--mz-regular)"></i>Abaixo do corte</span><span><i style="background:var(--mz-suficiente)"></i>Entre corte e meta</span><span><i style="background:var(--mz-otimo)"></i>Meta batida</span><span>M1 usa as faixas oficiais: Regular, Suficiente, Bom e Ótimo</span></div></div>
  <section class="ov-tiles" aria-label="Indicadores municipais">${OVERVIEW_IDS.map(id=>metaCard(id,mk,scope)).join('')}</section>`;
}

// ---- Gaveta do indicador ----
const OV_WHY={M1:'O denominador não muda: cada primeira consulta a mais sobe o resultado. A faixa Ótimo começa acima de 1,25%.',M2:'O denominador são as primeiras consultas do período, que não mudam quando um tratamento é concluído.',M3:'O denominador (crianças de 6 a 12 anos) não muda: cada criança a mais em escovação supervisionada sobe o resultado.',M4:'Cada preventivo a mais também entra no denominador (lista da Nota B5), por isso a conta soma nos dois lados.',M5:'Cada ART a mais também entra no total de restaurações, por isso a conta soma nos dois lados.'};
const OV_QWHY={M1:'No quadrimestre, M1 é a média dos 4 meses (soma dos resultados ÷ 4), sobre o denominador do mês em foco.',M3:'No quadrimestre, M3 é a média dos 4 meses (soma dos resultados ÷ 4), sobre o denominador do mês em foco.',M2:'No quadrimestre, soma os tratamentos concluídos e as primeiras consultas dos 4 meses.',M4:'No quadrimestre, soma preventivos e procedimentos da lista da Nota B5 dos 4 meses.',M5:'No quadrimestre, soma ART e restaurações dos 4 meses.'};
function populationSnapshotLatest(){return state.snapshots.filter(s=>s.profile==='metabase_populacao_ativa'&&s.population).sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt))[0]||null}
function ovGapPreview(id,numerator,den){if(!(den>0)||numerator==null)return '';const r=100*numerator/den,g=metaGap(id,numerator,den),u=OV_SHORT_UNIT[id];return `Com esse denominador, ${id} fica em <b>${fmtPct(r)}</b>${g?` e faltam <b>${fmtNum(g)} ${g===1?u[0]:u[1]}</b>${id==='M1'?' para a faixa Ótimo':' para a meta'}`:' e a meta está batida'}.`}
function ovDenomSection(id,mk){
  const rec=getDenominator(id,'municipal',mk),comp=municipalComponents(id,mk),month=fmtMonth(mk,true),fed=id==='M1'?'B1':'B4';
  const status=rec?`<p class="ov-why"><b class="ov-ok">✓ Confirmado em ${fmtDate(rec.updatedAt)} · vale de ${fmtMonth(rec.start,true)} a ${fmtMonth(rec.end,true)} · também para o ${fed}.</b> Origem: ${esc(rec.origin||'—')}.</p>`:`<p class="ov-why"><b class="ov-warn">Ainda não confirmado para ${esc(month)}.</b> Também vale para o ${fed}.</p>`;
  const manual=`<div class="ov-denom" id="ovManualBox"${id==='M1'?' hidden':''}><label><span>Denominador do ${id} (${esc(month)})</span><input id="ovDenManual" data-ov-den-id="${id}" inputmode="decimal" value="${rec?esc(fmtNum(Number(rec.value),ovDenDecimals(Number(rec.value)))):''}" placeholder="ex.: 4200"></label><button class="btn small ${id==='M3'?'primary':''}" data-ov-den-save="${id}">${rec?'Salvar alteração':'Confirmar denominador'}</button></div>`;
  if(id!=='M1')return `<section class="pq-d-card"><div class="pq-sec-t">Denominador de ${esc(month)}</div>${status}${manual}<p class="ov-why" id="ovDenPreview">${rec?ovGapPreview(id,comp.reconstructedNumerator,Number(rec.value)):''}</p></section>`;
  const pop=activePopulationInput(mk),popSnap=populationSnapshotLatest(),total=pop?.totalPopulation??popSnap?.population?.totalPopulation??'',esf=pop?.esfCount??'',dent=pop?.dentistCount??'';
  const src=popSnap?`Do CSV "${popSnap.fileName}" importado em ${fmtDate(popSnap.createdAt)} · soma da coluna "Todos os serviços"`:'Nenhum CSV de população ativa importado: digite o total de pessoas.';
  const den=total>0&&esf>0&&dent>0?total/esf*dent:null;
  return `<section class="pq-d-card"><div class="pq-sec-t">Denominador de ${esc(month)}</div>${status}
    <label class="ov-pop-src"><span>População ativa (pessoas)</span><input id="ovPop" inputmode="numeric" value="${total===''?'':esc(fmtNum(total))}" data-csv="${popSnap?popSnap.population.totalPopulation:''}"><small id="ovPopSrc">${esc(pop?.manualTotal?`Digitado à mão${popSnap?` · o CSV importado traz ${fmtNum(popSnap.population.totalPopulation)}`:''}`:src)}</small></label>
    <div class="ov-popcalc"><span class="ov-op">÷</span><label class="ov-pc"><span>ESF do CS</span><input id="ovEsf" inputmode="numeric" value="${esc(esf)}"></label><span class="ov-op">×</span><label class="ov-pc"><span>Dentistas <em>(sem residentes)</em></span><input id="ovDent" inputmode="numeric" value="${esc(dent)}"></label><span class="ov-op">=</span><div class="ov-pc res"><span>Denominador</span><b id="ovPopOut">${den==null?'—':fmtNum(den,ovDenDecimals(den))}</b></div></div>
    <p class="ov-why" id="ovDenPreview">${den!=null?ovGapPreview('M1',comp.reconstructedNumerator,den):''}</p>
    <div class="ov-pc-actions"><button class="btn small primary" data-ov-pop-save>Salvar</button><button class="ov-link" data-ov-manual-toggle>Digitar o valor direto</button></div>
    ${manual}
  </section>`;
}
function ovDetailRows(items,numSet){const max=Math.max(1,...items.map(x=>x.q));return `<div class="ov-blist">${items.map(x=>`<div class="ov-brow"><span>${esc(x.n)}${numSet&&numSet.has(x.k)?' <em class="ov-both">também no numerador</em>':''}</span><b>${fmtNum(x.q)}</b><div class="ov-bt"><i style="width:${100*x.q/max}%;background:${!numSet||numSet.has(x.k)?'var(--primary)':'#9aa0bd'}"></i></div></div>`).join('')}</div>`}
function ovComposition(id,mk){
  const proc=aggregateProcedureMonth(mk),group=aggregateGroupMonth(mk),comp=municipalComponents(id,mk),pcs=proc?.procedureCounts||[],month=fmtMonth(mk,true);
  const has=role=>p=>(p.roles||[]).includes(role),row=p=>({k:p.descriptionNormalized,n:p.descriptionNormalized,q:p.quantityValid});
  const isGroupNote=p=>/^EVOLUCAO DA ATIVIDADE EM GRUPO/.test(norm(p.descriptionOriginal));
  let num='',den='';
  if(id==='M1'||id==='M2'){const role=id==='M1'?'first':'concluded',people=id==='M1'?proc?.firstConsultations:proc?.treatmentsConcluded,qty=id==='M1'?proc?.firstConsultationQuantity:proc?.treatmentConcludedQuantity,excl=(id==='M1'?proc?.firstConsultationsExcluded:proc?.treatmentsConcludedExcluded)||[];
    const items=pcs.filter(has(role)).map(p=>({k:p.descriptionNormalized,n:`${p.descriptionNormalized} · pessoas distintas`,q:people??0}));
    num=proc?`${ovDetailRows(items.length?items:[{k:role,n:id==='M1'?'Primeira consulta programada':'Tratamento concluído',q:people??0}])}<p class="ov-why">${fmtNum(qty??0)} lançamento(s) no relatório, ${fmtNum(people??0)} pessoa(s) distinta(s).${excl.length?` ${fmtNum(excl.length)} já tinha(m) ${id==='M1'?'primeira consulta':'tratamento concluído'} nos últimos 12 meses e não conta(m) de novo.`:''}</p>`:'';}
  if(id==='M3'&&group){num=group.brushingEvents?.length?`${ovDetailRows(group.brushingEvents.map((ev,i)=>({k:i,n:`Escovação supervisionada · ${ev.date}`,q:ev.present})))}<p class="ov-why">${fmtNum(group.supervisedBrushingPresent)} criança(s) presente(s) em ${fmtNum(group.eligibleActivities)} atividade(s) elegível(is).</p>`:'<p class="ov-why">Nenhuma escovação supervisionada encontrada neste mês.</p>'}
  if(id==='M4'){const n=pcs.filter(has('preventive')).sort((a,b)=>b.quantityValid-a.quantityValid);const set=new Set(n.map(p=>p.descriptionNormalized));const d=pcs.filter(has('b5den')).sort((a,b)=>(set.has(b.descriptionNormalized)-set.has(a.descriptionNormalized))||b.quantityValid-a.quantityValid);
    num=n.length?`${ovDetailRows(n.map(row))}<p class="ov-why">Soma: ${fmtNum(comp.reconstructedNumerator)} procedimento(s) preventivo(s).</p>`:'';den=d.length?`${ovDetailRows(d.map(row),set)}<p class="ov-why">Soma: ${fmtNum(comp.reconstructedDenominator)} procedimento(s) da lista da Nota B5 (mesma conta da B5). Não entram primeira consulta, tratamento concluído, atendimentos genéricos nem atividade em grupo.</p>`:''}
  if(id==='M5'){const n=pcs.filter(has('art')).sort((a,b)=>b.quantityValid-a.quantityValid);const set=new Set(n.map(p=>p.descriptionNormalized));const d=pcs.filter(has('restorative')).sort((a,b)=>(set.has(b.descriptionNormalized)-set.has(a.descriptionNormalized))||b.quantityValid-a.quantityValid);
    num=n.length?`${ovDetailRows(n.map(row))}<p class="ov-why">Soma: ${fmtNum(comp.reconstructedNumerator)} ART.</p>`:'';den=d.length?`${ovDetailRows(d.map(row),set)}<p class="ov-why">Soma: ${fmtNum(comp.reconstructedDenominator)} procedimento(s) restaurador(es).</p>`:''}
  return `${num?`<section class="pq-d-card"><div class="pq-sec-t">O que entrou no numerador · ${esc(month)}</div>${num}</section>`:''}${den?`<section class="pq-d-card"><div class="pq-sec-t">O que entrou no denominador · ${esc(month)}</div>${den}</section>`:''}`;
}
// A gaveta abre no escopo da Visão Geral (mês/quadrimestre), ou no escopo pedido pelo botão (a página Municipal abre
// pelo quadrimestre e o bloco de denominadores pelo mês). O escopo fica guardado para reabrir igual depois de salvar.
let ovDetailScope=null;
function openIndicatorDetail(id,scopeArg){
  ovDetailScope=scopeArg==='quarter'||scopeArg==='month'?scopeArg:null;
  const mk=state.preferences.month,scope=ovDetailScope||(state.preferences.overviewScope==='quarter'?'quarter':'month'),s=metaCardState(id,mk,scope),e=s.entry,comp=municipalComponents(id,mk),u=OV_SHORT_UNIT[id],month=fmtMonth(mk,true),monthName=month.split('/')[0];
  const tone={success:'green',good:'blue',warn:'amber',bad:'red',neutral:'violet'}[s.cardState]||'violet';
  let hero;
  if(e.result==null&&s.missingDenom)hero=`<div class="pq-sec-t">Para calcular</div><p class="pq-d-why alert">Falta o denominador de ${esc(monthName)}</p><p class="ov-why">${comp.reconstructedNumerator!=null?`O numerador já está pronto: <b>${fmtNum(comp.reconstructedNumerator)} ${comp.reconstructedNumerator===1?u[0]:u[1]}</b>. `:''}Confirme o denominador abaixo para calcular ${id}.</p>`;
  else if(e.result==null)hero=`<div class="pq-sec-t">Para calcular</div><p class="pq-d-why alert">${esc(s.missing||'Sem dados')}</p><div><button class="btn small" data-action="import">Importar relatório</button></div>`;
  else{const title=s.done?(scope==='quarter'?'Meta garantida':'Meta batida'):`${s.ended?(e.gap===1?'Faltou':'Faltaram'):'Faltam'} ${fmtNum(e.gap)} ${e.gap===1?u[0]:u[1]}${id==='M1'?' para a faixa Ótimo':''}${scope==='quarter'?' no quadrimestre':` em ${monthName}`}`;
    const sim=['M4','M5'].includes(id),avg=scope==='quarter'&&['M1','M3'].includes(id);
    const calc=!avg&&e.numerator!=null&&e.denominator>0?`<div class="ov-calc"><div><span>Hoje</span><span>${fmtNum(e.numerator)} ÷ ${fmtNum(e.denominator,ovDenDecimals(e.denominator))}</span><b>${fmtPct(e.result)}</b></div>${e.gap?`<div class="after"><span>Com +${fmtNum(e.gap)}</span><span>${fmtNum(e.numerator+e.gap)} ÷ ${fmtNum(e.denominator+(sim?e.gap:0),ovDenDecimals(e.denominator))}</span><b>${fmtPct(100*(e.numerator+e.gap)/(e.denominator+(sim?e.gap:0)))}${id==='M1'?' → faixa Ótimo':' ✓'}</b></div>`:''}</div>`:'';
    hero=`<div class="pq-sec-t">Para bater a meta</div><p class="pq-d-why${s.done?' ov-ok':''}">${title}</p>${calc}<p class="ov-why">${scope==='quarter'?OV_QWHY[id]:OV_WHY[id]}</p>`}
  const months=quarterMonths(state.preferences.year,state.preferences.quarter),cur=ovCurrentMonthKey();
  const monthRows=months.map(m=>{const c=municipalComponents(id,m),z=ovZone(id,c.result),future=m>cur;return `<tr class="${future?'future':''}"><td><span class="ov-zd" style="background:${z?OV_ZONE_COLOR[z]:'#d7dbe6'}"></span>${fmtMonth(m,true)}</td><td class="num">${c.reconstructedNumerator==null?'—':fmtNum(c.reconstructedNumerator)}</td><td class="num">${c.denominator==null?'—':fmtNum(c.denominator,ovDenDecimals(c.denominator))}</td><td class="num">${c.result!=null?`<b>${fmtPct(c.result)}</b>`:future?'a chegar':'sem dado'}</td></tr>`}).join('');
  const files=(comp.snapshots||[]).map(sn=>`<button class="btn small" data-open-snapshot="${sn.id}">${icon('file')}${esc(sn.fileName)}</button>`).join('');
  openDrawer(`<div class="pq-drawer tone-${tone}" data-ov-detail="${id}">
    <header class="pq-d-h"><div class="pq-d-h-top"><span class="indicator-id" style="margin-right:auto">${id} · MUNICIPAL</span><button class="pq-icon" data-close-drawer aria-label="Fechar">${icon('close')}</button></div>
      <h2>${esc(s.rule.name)}</h2><p class="pq-d-sub">${pill(s.label,s.tint.pill)} ${scope==='quarter'?`Quadrimestre Q${state.preferences.quarter} · acumulado`:esc(month)} · resultado <b>${fmtPct(e.result)}</b> · meta <b>${s.metaLabel}</b></p><div style="height:12px"></div></header>
    <div class="pq-d-b">
      <section class="pq-d-next">${hero}</section>
      ${['M1','M3'].includes(id)?ovDenomSection(id,mk):''}
      <section class="pq-d-card"><div class="pq-sec-t">Mês a mês no quadrimestre</div><div class="ov-mm-wrap"><table class="ov-mm"><thead><tr><th>Mês</th><th class="num">Numerador</th><th class="num">Denominador</th><th class="num">Resultado</th></tr></thead><tbody>${monthRows}</tbody></table></div></section>
      ${ovComposition(id,mk)}
      <details class="pq-d-card pq-tech"><summary>Como é calculado</summary><div class="formula">${esc(s.rule.formula)}</div><p class="ov-why">${esc(comp.hypothesis||'')}</p><p class="ov-why">Regra municipal: ${esc(RULESETS.municipal.fonte_normativa)}. Fonte do cálculo: ${esc(comp.source)}.</p><div class="drawer-actions">${files}<button class="btn small" data-composition="municipal|${id}|${mk}">Conferência completa (SIGTAP e páginas)</button></div></details>
    </div></div>`);
  document.getElementById('drawer').classList.add('pq-drawer-host');
}
function ovReopenDetail(id){const b=document.getElementById('drawerBackdrop');if(b?.classList.contains('open')&&document.querySelector(`#drawer [data-ov-detail="${id}"]`))openIndicatorDetail(id,ovDetailScope)}
// Denominador de M1 pela população ativa: população ÷ ESF × dentistas. A população pode vir do CSV importado ou
// ser digitada. Atualiza o mesmo registro de população/denominador quando já existe para o mês (não duplica).
function applyPopulationDenominator(mk,total,esf,dent){
  const months=quarterMonths(state.preferences.year,state.preferences.quarter),popSnap=populationSnapshotLatest();
  let rec=activePopulationInput(mk);
  if(!rec){rec={id:uuid(),snapshotId:popSnap?.id||null,fileName:popSnap?.fileName||'',unit:state.preferences.unit,createdAt:nowISO(),start:mk,end:months.at(-1)};state.populationInputs.push(rec)}
  rec.totalPopulation=total;rec.esfCount=esf;rec.dentistCount=dent;rec.manualTotal=!popSnap||Number(total)!==Number(popSnap.population.totalPopulation);rec.updatedAt=nowISO();
  const value=total/esf*dent,note=`População ativa ${rec.manualTotal?'digitada':'do CSV'}: ${fmtNum(total,0)} pessoas ÷ ${esf} ESF × ${dent} dentistas.`;
  const existing=rec.denomRecordId?state.denominators.find(d=>d.id===rec.denomRecordId):null;
  if(existing){existing.value=value;existing.note=note;existing.start=rec.start;existing.end=rec.end;existing.origin=rec.manualTotal?'População ativa digitada':'População ativa (CSV)';existing.updatedAt=nowISO();audit('denominator_confirmed',{indicator:'M1',scope:'municipal',value,start:rec.start,end:rec.end,origin:existing.origin})}
  else rec.denomRecordId=commitDenominator('M1','municipal',value,rec.start,rec.end,rec.manualTotal?'População ativa digitada':'População ativa (CSV)',note).id;
  audit('population_input_confirmed',{esfCount:esf,dentistCount:dent,totalPopulation:total,manualTotal:rec.manualTotal,start:rec.start,end:rec.end});
  return {record:rec,value};
}
function applyManualDenominator(id,mk,value){const months=quarterMonths(state.preferences.year,state.preferences.quarter);return commitDenominator(id,'municipal',value,mk,months.at(-1),'Informado manualmente (Visão Geral)')}
function ovNumInput(id){return numeric(String(document.getElementById(id)?.value||'').trim())}
function ovSavePopulation(){const mk=state.preferences.month,total=ovNumInput('ovPop'),esf=ovNumInput('ovEsf'),dent=ovNumInput('ovDent');if(!(total>0)||!(esf>0)||!(dent>0)){toast('Informe população ativa, ESF e dentistas (todos maiores que zero).');return}const {value}=applyPopulationDenominator(mk,total,esf,dent);queueSave();refreshAll();openIndicatorDetail('M1',ovDetailScope);toast(`Denominador de M1 e B1 salvo: ${fmtNum(value,ovDenDecimals(value))}.`)}
function ovSaveManual(id){const mk=state.preferences.month,v=ovNumInput('ovDenManual');if(!(v>0)){toast('Informe um denominador maior que zero.');return}applyManualDenominator(id,mk,v);queueSave();refreshAll();openIndicatorDetail(id,ovDetailScope);toast(`Denominador de ${id} e ${id==='M1'?'B1':'B4'} salvo: ${fmtNum(v,ovDenDecimals(v))}.`)}
function ovLivePreview(target){
  const box=document.querySelector('#drawer [data-ov-detail]');if(!box)return;const id=box.dataset.ovDetail,mk=state.preferences.month,num=municipalComponents(id,mk).reconstructedNumerator,out=document.getElementById('ovDenPreview');
  if(id==='M1'&&target?.id!=='ovDenManual'&&document.getElementById('ovPop')){const total=ovNumInput('ovPop'),esf=ovNumInput('ovEsf'),dent=ovNumInput('ovDent'),csv=Number(document.getElementById('ovPop').dataset.csv)||null,src=document.getElementById('ovPopSrc');
    if(src)src.textContent=csv&&total===csv?`Do CSV importado · soma da coluna "Todos os serviços"`:`Digitado à mão${csv?` · o CSV importado traz ${fmtNum(csv)}`:''}`;
    const den=total>0&&esf>0&&dent>0?total/esf*dent:null;document.getElementById('ovPopOut').textContent=den==null?'—':fmtNum(den,ovDenDecimals(den));if(out)out.innerHTML=den==null?'':`${ovGapPreview('M1',num,den)} <span class="ov-warn">Prévia: clique em Salvar para aplicar.</span>`;return}
  const v=ovNumInput('ovDenManual');if(out)out.innerHTML=v>0?`${ovGapPreview(id,num,v)} <span class="ov-warn">Prévia: clique em salvar para aplicar.</span>`:'';
}


/* ---------- Páginas Municipal e Federal (v2.16): resumo do quadrimestre, matriz indicador × mês e gavetas ---------- */
const FED_IDS=['B1','B2','B3','B4','B5','B6'];
const FED_MIRROR_OF={B1:'M1',B2:'M2',B4:'M3',B5:'M4',B6:'M5'};
const FED_BAND_COLOR={'Ótimo':['#14539a','#e7eff8'],'Bom':['#0b7fa6','#e3f6fd'],'Suficiente':['#8f6a00','#fbf3dc'],'Regular':['#8c1d18','#f6e5e4']};
const FED_RANK={'Regular':0,'Suficiente':1,'Bom':2,'Ótimo':3};
const FED_UNIT={B1:['primeira consulta','primeiras consultas'],B2:['tratamento concluído','tratamentos concluídos'],B3:['procedimento não exodôntico','procedimentos não exodônticos'],B4:['criança','crianças'],B5:['procedimento preventivo','procedimentos preventivos'],B6:['ART','ARTs']};
function fedBandKey(label){return label?Object.keys(FED_BAND_COLOR).find(k=>label.startsWith(k))||null:null}
function fedBandPill(label){const k=fedBandKey(label),c=k?FED_BAND_COLOR[k]:['#5c6080','#eef0f7'];return `<span class="pill" style="color:${c[0]};background:${c[1]}">${esc(label?federalShortLabel(label):'Sem dados')}</span>`}
function fedRank(id,v){const k=fedBandKey(classifyFederal(id,v));return k==null?-1:FED_RANK[k]}
function mxMunLabel(id,v){if(v==null)return null;if(id==='M1')return classifyM1(v);const z=ovZone(id,v);return z==='otimo'?'Meta batida':z==='suf'?'Entre corte e meta':'Abaixo do corte'}
function mxCellHTML(scope,id,result,{focus=false,future=false}={}){
  if(future)return `<div class="mx-cell future" title="Mês ainda não chegou"><b>—</b><small>a chegar</small></div>`;
  if(result==null)return `<div class="mx-cell missing" title="Sem dado"><b>—</b><small>sem dado</small></div>`;
  const label=scope==='municipal'?mxMunLabel(id,result):classifyFederal(id,result),cls=scope==='municipal'?`mz-${ovZone(id,result)}`:federalZoneClass(id,result)||'fed-none';
  return `<div class="mx-cell ${cls}${focus?' focus':''}" title="${esc(label)}"><b>${fmtPct(result,pctDecimals(id))}</b><small>${esc(scope==='municipal'?label:federalShortLabel(label))}</small></div>`;
}
function mxMonthsHead(months,mk){return months.map(m=>{const {month,year}=parseMonthKey(m);return `<span>${MONTHS_SHORT[month-1]}/${year}${m===mk?' · em foco':''}</span>`}).join('')}
function mxQuarterLabel(){const months=quarterMonths(state.preferences.year,state.preferences.quarter),a=parseMonthKey(months[0]),b=parseMonthKey(months.at(-1));return `Q${state.preferences.quarter} · ${MONTHS[a.month-1]} a ${MONTHS[b.month-1]}/${b.year}`}
// Quanto falta para a próxima faixa federal. x = quantidade que se soma: no numerador e no denominador quando o
// procedimento conta nos dois (B5 abaixo de 85%, B6), só no numerador (B1, B2, B4) ou só no denominador (B3 e B5
// acima de 85%: procedimentos que não são exodontia/preventivo). B1/B4 no quadrimestre usam a média dos 4 meses.
function fedNextBand(id,{numerator,denominator,average=false,sumResults=0,denRef=null}){
  const cur=average?sumResults/4:(numerator!=null&&denominator>0?100*numerator/denominator:null);if(cur==null)return null;
  const r=fedRank(id,cur);if(r===3)return {done:true};
  if(id==='B3'&&cur<3)return {note:'Abaixo de 3% também é Regular pela Nota. Confira a completude do registro; a ferramenta não recomenda produzir exodontias.'};
  const above85=id==='B5'&&cur>85,denOnly=id==='B3'||above85,both=['B5','B6'].includes(id)&&!above85;
  const value=x=>average?(sumResults+100*x/denRef)/4:100*(numerator+(denOnly?0:x))/(denominator+(denOnly||both?x:0));
  if(average&&!(denRef>0))return null;
  for(let x=1;x<=200000;x++){const v=value(x);if(fedRank(id,v)>r){const u=above85?['procedimento não preventivo','procedimentos não preventivos']:FED_UNIT[id];return {count:x,label:fedBandKey(classifyFederal(id,v)),unit:x===1?u[0]:u[1],after:v}}}
  return null;
}
function fedQuarter(id,mk){
  const months=quarterMonths(state.preferences.year,state.preferences.quarter),cum=cumulativeFederal(id,months),values=months.map(m=>federalComponents(id,m));
  const avg=['B1','B4'].includes(id),next=cum.result==null?null:fedNextBand(id,avg?{average:true,sumResults:sum(values.map(v=>v.result??0)),denRef:federalComponents(id,mk).denominator}:{numerator:cum.numerator,denominator:cum.denominator});
  return {months,values,cum,avg,next,label:classifyFederal(id,cum.result),ended:isQuarterOver(months)};
}
function fedSituation(id,fq){
  if(fq.cum.result==null)return ['B1','B4'].includes(id)&&!getDenominator(id==='B1'?'M1':'M3','municipal',state.preferences.month)?'Denominador não confirmado':'Sem dados suficientes';
  const n=fq.next;if(!n)return fq.avg?'Confirme o denominador do mês em foco para estimar.':'—';if(n.done)return '<b>Faixa Ótimo</b>';if(n.note)return esc(n.note);
  return `Para ${n.label}: ${fq.ended?(n.count===1?'faltou':'faltaram'):(n.count===1?'falta':'faltam')} <b>${fmtNum(n.count)} ${esc(n.unit)}</b>${id==='B3'?' no denominador':''}.`;
}
function municipalHTML(){
  const mk=state.preferences.month,months=quarterMonths(state.preferences.year,state.preferences.quarter),cur=ovCurrentMonthKey(),goals=metaGoalsHit(mk,'quarter'),ended=isQuarterOver(months);
  const rows=OVERVIEW_IDS.map(id=>{
    const s=metaCardState(id,mk,'quarter'),e=s.entry,u=OV_SHORT_UNIT[id],vals=months.map(m=>municipalComponents(id,m).result),avg=['M1','M3'].includes(id);
    const sit=e.result==null?(s.missingDenom?'Denominador não confirmado':'Sem dados suficientes'):s.done?`<b>${ended?'Meta cumprida':'Meta garantida'}</b>`:`${ended?(e.gap===1?'Faltou':'Faltaram'):'Faltam'} <b>${fmtNum(e.gap)} ${e.gap===1?u[0]:u[1]}</b>${id==='M1'?' para a faixa Ótimo':''}.`;
    const kind=e.result==null?'':avg?`média dos 4 meses${e.validMonths<4?` (${e.validMonths} com dado)`:''}`:`soma de ${e.validMonths} mês(es): ${fmtNum(e.numerator)} ÷ ${fmtNum(e.denominator,ovDenDecimals(e.denominator))}`;
    return `<button class="mx-row" data-indicator-detail="${id}" data-detail-scope="quarter"><div class="mx-who"><span class="mx-id" style="color:${s.tint.accent};background:${s.tint.bg}">${id}</span><div><b>${esc(s.rule.name)}</b><small>meta ${s.metaLabel}</small></div></div>${months.map((m,i)=>`<div class="mx-c${i+1}">${mxCellHTML('municipal',id,vals[i],{focus:m===mk,future:m>cur})}</div>`).join('')}<div class="mx-q"><b>${fmtPct(e.result,pctDecimals(id))}</b>${pill(s.label,s.tint.pill)}</div><div class="mx-sit">${sit}${kind?`<small>${esc(kind)}</small>`:''}</div><span class="mx-chev">›</span></button>`;
  }).join('');
  const dots=OVERVIEW_IDS.map(id=>{const s=metaCardState(id,mk,'quarter');return `<span class="ov-dot" style="color:${s.tint.accent};background:${s.tint.bg}" title="${esc(s.label)}"><i></i>${id}</span>`}).join('');
  const d1=getDenominator('M1','municipal',mk),pop=activePopulationInput(mk),d3s=months.map(m=>({m,d:getDenominator('M3','municipal',m)}));
  const m1Text=pop&&d1?`${fmtNum(pop.totalPopulation)} pessoas ÷ ${fmtNum(pop.esfCount)} ESF × ${fmtNum(pop.dentistCount)} dentistas = <b>${fmtNum(Number(d1.value),ovDenDecimals(Number(d1.value)))}</b>`:d1?`<b>${fmtNum(Number(d1.value),ovDenDecimals(Number(d1.value)))}</b> · ${esc(d1.origin||'confirmado')}`:`Não confirmado para ${esc(fmtMonth(mk,true))}`;
  const m3Text=d3s.map(({m,d})=>`${MONTHS_SHORT[parseMonthKey(m).month-1]} ${d?`<b>${fmtNum(Number(d.value),ovDenDecimals(Number(d.value)))}</b>`:'—'}`).join(' · ');
  return `<section class="card ov-summary mx-summary" aria-label="Resumo do quadrimestre">
    <div class="ov-sum"><div class="ov-sec-t">${esc(mxQuarterLabel())}</div><div class="ov-big">${fmtNum(goals.hit)}<small> de 5 metas ${ended?'cumpridas':'garantidas até agora'}</small></div><div class="ov-dots">${dots}</div></div>
    <div class="ov-sum"><div class="ov-sec-t">Situação</div><div><span class="ov-chip">${esc(ovTimeChip(mk,'quarter'))}</span></div><div class="ov-line">${ended?'Resultado final do quadrimestre.':'Os meses que ainda não chegaram também entram na conta.'} Clique em um indicador para ver a conta, o mês a mês e o que falta. Prévia calculada do CELK, não homologada.</div></div>
  </section>
  <section class="card mx-panel"><div class="ov-panel-h"><h2>Apuração do quadrimestre</h2><div class="ov-legend"><span><i style="background:var(--mz-otimo)"></i>Meta batida</span><span><i style="background:var(--mz-suficiente)"></i>Entre corte e meta</span><span><i style="background:var(--mz-regular)"></i>Abaixo do corte</span><span><i class="mx-hatch"></i>Mês a chegar</span><span>M1 usa as faixas oficiais (Regular, Suficiente, Bom, Ótimo)</span></div></div>
    <div class="mx-matrix"><div class="mx-row head"><span>Indicador</span>${mxMonthsHead(months,mk)}<span>Quadrimestre</span><span>Situação</span><span></span></div>${rows}</div></section>
  <div class="ov-two mx-two">
    <section class="card ov-panel"><div class="ov-panel-h"><h2>Denominadores</h2><span>${esc(mxQuarterLabel())}</span></div><ul class="ov-sources mx-dens">
      <li><span class="ov-st ${d1?'ok':'no'}">${d1?'✓':'!'}</span><div>M1 e B1 · pessoas de referência<small>${d1?`Vale de ${esc(fmtMonth(d1.start,true))} a ${esc(fmtMonth(d1.end,true))}`:'Pela população ativa (população ÷ ESF × dentistas) ou digitado'} · <a href="${POPULATION_CSV_SOURCE_URL}" target="_blank" rel="noopener noreferrer">CSV da população no Data Studio</a></small><div class="mx-calc">${m1Text}</div></div><button class="btn small${d1?'':' primary'}" data-indicator-detail="M1" data-detail-scope="month">${d1?'Editar':'Confirmar'}</button></li>
      <li><span class="ov-st ${d3s.find(x=>x.m===mk)?.d?'ok':'no'}">${d3s.find(x=>x.m===mk)?.d?'✓':'!'}</span><div>M3 e B4 · crianças de 6 a 12 anos<small>Valor confirmado em cada mês</small><div class="mx-calc">${m3Text}</div></div><button class="btn small${d3s.find(x=>x.m===mk)?.d?'':' primary'}" data-indicator-detail="M3" data-detail-scope="month">${d3s.find(x=>x.m===mk)?.d?'Editar':'Confirmar'}</button></li>
    </ul></section>
    <details class="card mx-rules"><summary>Como é calculado</summary><ul>
      <li><b>M1 e M3</b>: o resultado do quadrimestre é a média dos 4 meses. O denominador é de população, então não se soma mês a mês.</li>
      <li><b>M2, M4 e M5</b>: soma os numeradores e os denominadores dos meses com dado.</li>
      <li><b>Fonte</b>: relatórios Procedimentos Detalhado e Atividades em Grupo do CELK. Primeira consulta e tratamento concluído contam 1 vez por pessoa a cada 12 meses.</li>
      <li><b>Corte e meta</b>: M2 25% e 50%, M3 0,5% e 1%, M4 20% e 40%, M5 4% e 8%. M1 usa faixas: Suficiente >0,25%, Bom >0,75%, Ótimo >1,25%.</li>
      <li><b>Regra</b>: ${esc(RULESETS.municipal.fonte_normativa)}.</li>
    </ul></details>
  </div>`;
}
function federalHTML(){
  const mk=state.preferences.month,cur=ovCurrentMonthKey(),data=FED_IDS.map(id=>({id,fq:fedQuarter(id,mk)})),months=data[0].fq.months,count={};
  for(const {fq} of data){const k=fedBandKey(fq.label)||'Sem dados';count[k]=(count[k]||0)+1}
  const dots=data.map(({id,fq})=>{const k=fedBandKey(fq.label),c=k?FED_BAND_COLOR[k]:['#5c6080','#eef0f7'];return `<span class="ov-dot" style="color:${c[0]};background:${c[1]}" title="${esc(fq.label||'Sem dados')}"><i></i>${id}</span>`}).join('');
  const rows=data.map(({id,fq})=>{const k=fedBandKey(fq.label),c=k?FED_BAND_COLOR[k]:['#5c6080','#eef0f7'],rule=RULESETS.federal.indicators[id],kind=fq.cum.result==null?'':fq.avg?`média dos 4 meses${fq.cum.validMonths<4?` (${fq.cum.validMonths} com dado)`:''}`:`soma: ${fmtNum(fq.cum.numerator)} ÷ ${fmtNum(fq.cum.denominator)}${id==='B3'?' (lista da Nota B3)':id==='B5'?' (lista da Nota B5)':''}`;
    return `<button class="mx-row" data-fed-detail="${id}"><div class="mx-who"><span class="mx-id" style="color:${c[0]};background:${c[1]}">${id}</span><div><b>${esc(rule.name)}${FED_MIRROR_OF[id]?`<span class="mx-mirror">= ${FED_MIRROR_OF[id]}</span>`:'<span class="mx-own">regra própria</span>'}</b><small>${id==='B3'?'menor é melhor · Ótimo entre 3% e 10%':`faixas da Nota ${id}`}</small></div></div>${months.map((m,i)=>`<div class="mx-c${i+1}">${mxCellHTML('federal',id,fq.values[i].result,{focus:m===mk,future:m>cur})}</div>`).join('')}<div class="mx-q"><b>${fmtPct(fq.cum.result,pctDecimals(id))}</b>${fedBandPill(fq.label)}</div><div class="mx-sit">${fedSituation(id,fq)}${kind?`<small>${esc(kind)}</small>`:''}</div><span class="mx-chev">›</span></button>`}).join('');
  return `<section class="card ov-summary mx-summary" aria-label="Resumo do quadrimestre">
    <div class="ov-sum"><div class="ov-sec-t">${esc(mxQuarterLabel())}</div><div class="ov-big">${fmtNum(count['Ótimo']||0)}<small> Ótimo · ${fmtNum(count['Bom']||0)} Bom · ${fmtNum(count['Suficiente']||0)} Suficiente · ${fmtNum(count['Regular']||0)} Regular${count['Sem dados']?` · ${count['Sem dados']} sem dados`:''}</small></div><div class="ov-dots">${dots}</div></div>
    <div class="ov-sum"><div class="ov-sec-t">Leitura</div><div><span class="ov-chip">${esc(ovTimeChip(mk,'quarter'))}</span></div><div class="ov-line">B1, B2, B4, B5 e B6 usam os mesmos números do municipal (M1 a M5); muda só a faixa. <b>B3</b> tem lista própria da Nota. As Notas não definem como consolidar o quadrimestre, então o resultado do quadrimestre é um cálculo de conveniência. Prévia calculada do CELK, não homologada.</div></div>
  </section>
  <section class="card mx-panel"><div class="ov-panel-h"><h2>Apuração do quadrimestre</h2><div class="ov-legend"><span><i style="background:#14539a"></i>Ótimo</span><span><i style="background:#17b9ec"></i>Bom</span><span><i style="background:#c99400"></i>Suficiente</span><span><i style="background:#8c1d18"></i>Regular</span><span><i class="mx-hatch"></i>Mês a chegar</span></div></div>
    <div class="mx-matrix"><div class="mx-row head"><span>Indicador</span>${mxMonthsHead(months,mk)}<span>Quadrimestre</span><span>Para subir de faixa</span><span></span></div>${rows}</div></section>
  <details class="card mx-rules"><summary>Como é calculado</summary><ul>
    <li><b>B1, B2, B4, B5 e B6</b> repetem numerador e denominador de M1, M2, M3, M4 e M5; a Nota só muda as faixas. M4 e B5 usam a lista de 28 códigos SIGTAP da Nota B5 no denominador.</li>
    <li><b>B3</b>: exodontias ÷ procedimentos preventivos, curativos e exodontias (lista da Nota). Abaixo de 3% também é Regular. A ferramenta não recomenda produzir exodontias; mostra quanto o restante da produção precisaria crescer.</li>
    <li><b>Quadrimestre</b>: B1 e B4 pela média dos 4 meses (como M1 e M3); os demais somando numeradores e denominadores dos meses com dado.</li>
    <li><b>Limite do CELK</b>: o relatório não mostra INE, CBO nem CNS, por isso a leitura é uma prévia. Regra: ${esc(RULESETS.federal.fonte_normativa)}.</li>
  </ul></details>`;
}
function fedBandRulerHTML(id,result){
  const def=FEDERAL_BAND_DEFS[id];if(!def)return '';const max=def.max,pos=result==null?null:clamp(100*result/max);
  return `<div class="mx-bandr">${def.segments.map(([a,b,l])=>{const k=fedBandKey(l),c=k?FED_BAND_COLOR[k][0]:'#9aa0bd';return `<span style="width:${100*(Math.min(b,max)-a)/max}%;background:${c}"><i>${esc(l)}</i></span>`}).join('')}${pos==null?'':`<em style="left:calc(${pos}% - 1.5px)"></em>`}</div>`;
}
function openFederalDetail(id){
  const mk=state.preferences.month,fq=fedQuarter(id,mk),comp=federalComponents(id,mk),rule=RULESETS.federal.indicators[id],k=fedBandKey(fq.label),c=k?FED_BAND_COLOR[k]:['#5c6080','#eef0f7'],month=fmtMonth(mk,true),cur=ovCurrentMonthKey();
  const n=fq.next;
  const hero=fq.cum.result==null?`<div class="pq-sec-t">Para calcular</div><p class="pq-d-why alert">${esc(comp.missing||'Sem dados suficientes')}</p>${FED_MIRROR_OF[id]&&['B1','B4'].includes(id)?`<div><button class="btn small primary" data-indicator-detail="${FED_MIRROR_OF[id]}" data-detail-scope="month">Confirmar denominador</button></div>`:''}`
    :`<div class="pq-sec-t">Para subir de faixa</div><p class="pq-d-why${n?.done?' ov-ok':''}">${n?.done?'Faixa Ótimo':n?.note?esc(n.note):n?`Para ${n.label}: ${fq.ended?(n.count===1?'faltou':'faltaram'):(n.count===1?'falta':'faltam')} ${fmtNum(n.count)} ${esc(n.unit)}${fq.ended?'':' no quadrimestre'}`:'—'}</p>${fedBandRulerHTML(id,fq.cum.result)}<p class="ov-why">${fq.avg?'Resultado do quadrimestre: média dos 4 meses, como em M1/M3.':`Resultado do quadrimestre: ${fmtNum(fq.cum.numerator)} ÷ ${fmtNum(fq.cum.denominator)} (soma dos meses com dado, cálculo de conveniência).`}${id==='B3'?' Na B3 esses procedimentos entram só no denominador; a ferramenta não recomenda produzir exodontias.':''}</p>`;
  const rows=fq.months.map((m,i)=>{const v=fq.values[i],future=m>cur,kk=fedBandKey(v.classification);return `<tr class="${future?'future':''}"><td><span class="ov-zd" style="background:${kk?FED_BAND_COLOR[kk][0]:'#d7dbe6'}"></span>${fmtMonth(m,true)}</td><td class="num">${v.numerator==null?'—':fmtNum(v.numerator)}</td><td class="num">${v.denominator==null?'—':fmtNum(v.denominator,ovDenDecimals(v.denominator))}</td><td class="num">${v.result!=null?`<b>${fmtPct(v.result,pctDecimals(id))}</b>`:future?'a chegar':'sem dado'}</td><td>${v.result!=null?esc(federalShortLabel(v.classification)):''}</td></tr>`}).join('');
  let composition='';
  if(FED_MIRROR_OF[id])composition=`<section class="pq-d-card"><div class="pq-sec-t">Mesmos números do ${FED_MIRROR_OF[id]}</div><p class="ov-why">Numerador e denominador são os do ${FED_MIRROR_OF[id]} municipal; a Nota ${id} muda só as faixas.</p><div><button class="btn small" data-indicator-detail="${FED_MIRROR_OF[id]}" data-detail-scope="quarter">Abrir ${FED_MIRROR_OF[id]} →</button></div></section>`;
  else{const pcs=aggregateProcedureMonth(mk)?.procedureCounts||[],numRole=id==='B5'?'preventive':'b3num',denRole=id==='B5'?'b5den':'b3den',has=role=>p=>(p.roles||[]).includes(role),row=p=>({k:p.descriptionNormalized,n:`${p.descriptionNormalized}${p.sigtap?` · ${p.sigtap}`:''}`,q:p.quantityValid});
    const nums=pcs.filter(has(numRole)).sort((a,b)=>b.quantityValid-a.quantityValid),set=new Set(nums.map(p=>p.descriptionNormalized)),dens=pcs.filter(has(denRole)).sort((a,b)=>(set.has(b.descriptionNormalized)-set.has(a.descriptionNormalized))||b.quantityValid-a.quantityValid);
    composition=`${nums.length?`<section class="pq-d-card"><div class="pq-sec-t">O que entrou no numerador · ${esc(month)}</div>${ovDetailRows(nums.map(row))}<p class="ov-why">Soma: ${fmtNum(comp.numerator)}.</p></section>`:''}${dens.length?`<section class="pq-d-card"><div class="pq-sec-t">O que entrou no denominador · lista da Nota ${id}</div>${ovDetailRows(dens.map(row),set)}<p class="ov-why">Soma: ${fmtNum(comp.denominator)}.${id==='B5'?' Diferente do M4: aqui só entram os códigos da lista da Nota B5.':''}</p></section>`:''}`}
  const files=(comp.snapshots||[]).map(sn=>`<button class="btn small" data-open-snapshot="${sn.id}">${icon('file')}${esc(sn.fileName)}</button>`).join('');
  openDrawer(`<div class="pq-drawer" style="--tint:${c[1]};--edge:${c[0]};--ink:${c[0]}" data-fed-detail-open="${id}">
    <header class="pq-d-h"><div class="pq-d-h-top"><span class="indicator-id" style="margin-right:auto">${id} · FEDERAL</span><button class="pq-icon" data-close-drawer aria-label="Fechar">${icon('close')}</button></div>
      <h2>${esc(rule.name)}</h2><p class="pq-d-sub">${fedBandPill(fq.label)} ${esc(mxQuarterLabel())} · resultado <b>${fmtPct(fq.cum.result,pctDecimals(id))}</b></p><div style="height:12px"></div></header>
    <div class="pq-d-b">
      <section class="pq-d-next">${hero}</section>
      <section class="pq-d-card"><div class="pq-sec-t">Mês a mês no quadrimestre</div><div class="ov-mm-wrap"><table class="ov-mm"><thead><tr><th>Mês</th><th class="num">Numerador</th><th class="num">Denominador</th><th class="num">Resultado</th><th>Faixa</th></tr></thead><tbody>${rows}</tbody></table></div></section>
      ${composition}
      <details class="pq-d-card pq-tech"><summary>Como é calculado</summary><div class="formula">${esc(rule.formula)}</div><p class="ov-why">${esc(comp.hypothesis||'')}</p><p class="ov-why">Regra: ${esc(RULESETS.federal.fonte_normativa)}. Fonte do cálculo: ${esc(comp.source)}.</p><div class="drawer-actions">${files}<button class="btn small" data-composition="federal|${id}|${mk}">Conferência completa (SIGTAP e páginas)</button></div></details>
    </div></div>`);
  document.getElementById('drawer').classList.add('pq-drawer-host');
}

// ---- 2I: fila de trabalho (etapas, próxima ação, cards em cores) ----
const PREG_TABS=[['a_contatar','A contatar'],['em_contato','Em contato'],['agendada','Agendadas'],['atendida','Atendidas'],['encerrada','Encerradas'],['todas','Todas']];
const PREG_STAGE={a_contatar:['A contatar','amber'],em_contato:['Em contato','blue'],agendada:['Agendada','teal'],atendida:['Atendida','green'],encerrada:['Gestação encerrada','violet']};
const PREG_TAB_HINTS={a_contatar:'Ordenadas por prioridade: 3º trimestre sem atendimento primeiro, depois pela data provável do parto.',em_contato:'Contato iniciado e ainda sem consulta marcada. Depois de alguns dias sem resposta ao WhatsApp, a próxima ação sugerida passa a ser a busca ativa.',agendada:'Consulta marcada. Confirme o atendimento quando ele acontecer ou quando aparecer no próximo CSV.',atendida:'Já contam para o indicador 2I.',encerrada:'Parto registrado. Saem da fila de contato, mas continuam no cálculo do indicador.',todas:'Em ordem de prioridade: 3º trimestre sem atendimento, a contatar, em contato, agendadas, atendidas e, no fim, gestações encerradas.'};
const PREG_QUICK_NOTES=['Não atendeu','Número errado','Pediu retorno à tarde','Vai à UBS esta semana','Já fez consulta em outro serviço'];
const WHATSAPP_NO_REPLY_DAYS=5;
const DAY_MS=864e5;
let pregDrawer={id:null,tab:'acomp',edit:false,sched:false};
function startOfToday(){const d=new Date();return new Date(d.getFullYear(),d.getMonth(),d.getDate())}
function pregDum(e){const dum=parseDate(e.ultimaMenstruacao);if(dum)return dum;const dpp=parseDate(e.dataProvParto);return dpp?new Date(+dpp-280*DAY_MS):null}
function pregDpp(e){const dpp=parseDate(e.dataProvParto);if(dpp)return dpp;const dum=parseDate(e.ultimaMenstruacao);return dum?new Date(+dum+280*DAY_MS):null}
function weeksToDpp(e){const d=pregDpp(e);return d?Math.ceil((d-startOfToday())/(7*DAY_MS)):null}
function trimesterOf(w){return w==null?'':w>=28?'3º':w>=14?'2º':'1º'}
function daysAgo(v){const d=parseDate(v);return d?Math.floor((startOfToday()-new Date(d.getFullYear(),d.getMonth(),d.getDate()))/DAY_MS):null}
function agoLabel(v){const n=daysAgo(v);return n==null?'':n<=0?'hoje':n===1?'ontem':`há ${n} dias`}
function pregBucket(e){if(pregnancyStage(e)==='finalizada')return 'encerrada';if(isAttended(e))return 'atendida';const s=followupFor(e.id).state;return s==='agendada'?'agendada':['whatsapp_enviado','busca_ativa_solicitada'].includes(s)?'em_contato':'a_contatar'}
function pregTone(e){return isPriority2I(e)?'red':PREG_STAGE[pregBucket(e)][1]}
function lastContactEntry(e){return (followupFor(e.id).history||[]).filter(h=>h.type!=='note').at(-1)||null}
function lastContactText(e){const h=lastContactEntry(e);if(h)return `${followupLabel(h.to)} · ${agoLabel(h.at)}`;const pv=productionVisitsFor(e).at(-1);if(pv)return `Atendimento odontológico no CELK · ${fmtDate(pv.date)}`;return e.status2i==='atende'&&e.origin!=='monitora'?'Atendimento registrado no Metabase':e.monitoraOdonto==='atende'?'Consulta odontológica registrada no Monitora APS':'Nenhum contato registrado'}
function pregNextAction(e){
  const b=pregBucket(e),f=followupFor(e.id);
  if(b==='encerrada')return {kind:'open',label:'Ver perfil',cls:'soft',why:isAttended(e)?'Atendida antes do parto':'Parto sem atendimento odontológico'};
  if(b==='atendida')return {kind:'open',label:'Ver perfil',cls:'soft',why:e.status2i==='atende'&&e.origin!=='monitora'?'Registrada no Metabase · conta para a meta':e.monitoraOdonto==='atende'?'Consulta odontológica no Monitora APS · conta para a meta':hasProductionVisit(e)?`Atendida na produção do CELK em ${fmtDate(productionVisitsFor(e)[0].date)} · conta para a meta`:'Confirmação manual · conta para a meta'};
  if(needsData(e)&&!e.phoneNormalized)return {kind:'dados',label:'Completar dados',cls:'soft',icon:'file',why:'Lista anonimizada do Monitora APS'};
  if(b==='a_contatar')return e.phoneNormalized?{kind:'whatsapp',label:'Enviar WhatsApp',cls:'wa',icon:'message',why:isPriority2I(e)?'Prioridade: 3º trimestre':'Primeiro contato'}:{kind:'busca',label:'Pedir busca ativa',cls:'warn',icon:'search',why:'Sem telefone válido'};
  if(b==='em_contato'){const d=daysAgo(f.updatedAt);if(f.state==='whatsapp_enviado'&&d!=null&&d>=WHATSAPP_NO_REPLY_DAYS)return {kind:'busca',label:'Pedir busca ativa',cls:'warn',icon:'search',why:`Sem resposta há ${d} dias`,alert:true};return {kind:'agendar',label:'Agendar consulta',icon:'clock',why:f.state==='busca_ativa_solicitada'?`Busca ativa pedida ${agoLabel(f.updatedAt)}`:`WhatsApp enviado ${agoLabel(f.updatedAt)}`}}
  const ag=parseDate(f.agendaAt);if(!ag)return {kind:'atendida',label:'Confirmar atendimento',icon:'check',why:`Agendada ${agoLabel(f.updatedAt)}`};
  const dd=Math.round((new Date(ag.getFullYear(),ag.getMonth(),ag.getDate())-startOfToday())/DAY_MS);
  return {kind:'atendida',label:'Confirmar atendimento',icon:'check',why:dd<0?`Consulta foi em ${fmtDate(ag)} · confirmar`:dd===0?'Consulta hoje':`Consulta em ${fmtDate(ag)} (${dd} dia${dd>1?'s':''})`,alert:dd<0};
}
function pregNextBtn(e,n,extra=''){return n.kind==='open'?`<button class="pq-next soft ${extra}" data-open-episode="${esc(e.id)}">${n.label}</button>`:`<button class="pq-next ${n.cls||''} ${extra}" data-preg-act="${n.kind}|${esc(e.id)}">${n.icon?icon(n.icon):''}${n.label}</button>`}
function pregStagePill(e){const [label,tone]=PREG_STAGE[pregBucket(e)];return `<span class="pq-pill ink-${tone}">${label}</span>`}
function pregTags(e){const t=[],left=weeksToDpp(e),age=ageAt(e),b=pregBucket(e);
  if(isPriority2I(e))t.push(`<span class="pq-tag red">3º tri · ${left==null?'Monitora APS':left>0?`parto em ${left} sem.`:'parto em dias'}</span>`);
  const miss=state.preferences.pregIncomplete?missingDataFields(e):[];
  if(miss.length)t.push(`<span class="pq-tag amber">Falta: ${esc(miss.join(', '))}</span>`);
  else{if(needsData(e))t.push('<span class="pq-tag gray">Dados a completar</span>');
  if(!e.phoneNormalized&&b!=='atendida'&&b!=='encerrada')t.push('<span class="pq-tag amber">Sem telefone</span>');}
  if(age!=null&&age<20)t.push(`<span class="pq-tag blue">${age} anos</span>`);
  if(isExcluded(e.id))t.push('<span class="pq-tag red">Removida da lista</span>');
  return t.join('')}
function pregRuler(e){const w=gestationalWeeks(e),t3=isPriority2I(e);return `<div class="pq-ruler${t3?' t3':''}" title="${w==null?'IG não calculável':`IG ${w} de 40 semanas`}"><i style="width:${w==null?0:Math.min(100,100*w/40)}%"></i></div>`}
function pregRow(e){
  const w=gestationalWeeks(e),n=pregNextAction(e),age=ageAt(e),dpp=pregDpp(e),left=weeksToDpp(e),finalized=pregnancyStage(e)==='finalizada';
  const igLine=w==null?(e.monitoraPeriodo?`<b>${esc(e.monitoraPeriodo.replace(/^T(\d)$/,'$1º tri'))} · Monitora</b><span>DUM/DPP a completar</span>`:'<b>IG não calculável</b><span>sem DUM/DPP</span>'):`<b>${w} sem · ${trimesterOf(w)} tri</b><span>${finalized?`parto ${fmtDate(e.dataParto)}`:dpp?`DPP ${fmtDate(dpp).slice(0,5)} · ${left>0?`faltam ${left} sem.`:'vencida'}`:''}</span>`;
  const secondary=['atendida','encerrada'].includes(pregBucket(e))?'':`<button class="pq-icon" data-preg-act="wa-reg|${esc(e.id)}" ${e.phoneNormalized?'':'disabled'} title="Registrar WhatsApp enviado" aria-label="Registrar WhatsApp enviado">${icon('message')}</button><button class="pq-icon" data-open-episode="${esc(e.id)}" title="Abrir perfil" aria-label="Abrir perfil">${icon('chevron')}</button>`;
  return `<div class="pq-card tone-${pregTone(e)}" data-open-episode="${esc(e.id)}">
    <div class="pq-who"><button class="pq-name" data-open-episode="${esc(e.id)}">${esc(pregDisplayName(e))}</button><small>Equipe ${esc(e.equipe||'—')}${age!=null?` · ${age} anos`:''} · <span class="mono">${esc(e.prontuario||'ID local')}</span>${e.origin==='manual'?' · manual':e.origin==='monitora'?' · Monitora APS':''}</small><div class="pq-tags">${pregStagePill(e)}${pregTags(e)}</div></div>
    <div class="pq-ig"><div class="pq-ig-top">${igLine}</div>${pregRuler(e)}</div>
    <div class="pq-contact"><b>${e.telefone?esc(e.telefone):'Sem telefone válido'}</b><span>${esc(lastContactText(e))}</span></div>
    <div class="pq-go"><div>${secondary}${pregNextBtn(e,n)}</div><span class="pq-why${n.alert?' alert':''}">${esc(n.why)}</span></div>
  </div>`}
// Ordem da fila por prioridade: 3º trimestre sem atendimento que ainda precisa de contato, depois a contatar,
// em contato, agendadas, atendidas e, por último, gestação encerrada. Dentro de cada grupo, a DPP mais próxima
// primeiro; agendadas pela data da consulta (as que já passaram primeiro); encerradas pelo parto mais recente.
const PREG_RANK={a_contatar:1,em_contato:2,agendada:3,atendida:4,encerrada:5};
function pregRank(e){const b=pregBucket(e);return isPriority2I(e)&&(b==='a_contatar'||b==='em_contato')?0:PREG_RANK[b]}
// A ordenação calcula a situação de cada gestante uma vez só (antes recalculava a cada comparação, v2.22).
function pregSortKey(e){return {rank:pregRank(e),agenda:parseDate(followupFor(e.id).agendaAt),parto:parseDate(e.dataParto),dpp:pregDpp(e),name:pregDisplayName(e)}}
function pregSortKeys(ka,kb){if(ka.rank!==kb.rank)return ka.rank-kb.rank;
  const cmpDate=(x,y,desc=false)=>{if(x&&y&&+x!==+y)return desc?y-x:x-y;if(!!x!==!!y)return x?-1:1;return 0};
  let c=0;if(ka.rank===PREG_RANK.agendada)c=cmpDate(ka.agenda,kb.agenda);else if(ka.rank===PREG_RANK.encerrada)c=cmpDate(ka.parto,kb.parto,true);
  if(!c)c=cmpDate(ka.dpp,kb.dpp);return c||ka.name.localeCompare(kb.name,'pt-BR')}
function pregSort(a,b){return pregSortKeys(pregSortKey(a),pregSortKey(b))}
function pregQueue(){const p=state.preferences,tab=p.pregTab||'a_contatar';let rows=applyPregFilters(visibleByExclusion(mergedEpisodes()));if(tab!=='todas')rows=rows.filter(e=>pregBucket(e)===tab);if(p.pregPrioOnly)rows=rows.filter(isPriority2I);const keys=new Map(rows.map(e=>[e,pregSortKey(e)]));return rows.sort((a,b)=>pregSortKeys(keys.get(a),keys.get(b)))}
function toastAction(message,label,fn){const t=document.getElementById('toast');t.innerHTML=`<span>${esc(message)}</span><button type="button" class="toast-action">${esc(label)}</button>`;t.classList.add('show','has-action');t.querySelector('.toast-action').onclick=()=>{t.classList.remove('show','has-action');fn()};clearTimeout(toast._t);toast._t=setTimeout(()=>t.classList.remove('show','has-action'),6000)}
function setFollowupWithUndo(id,next,message,extra={}){const prev=state.gestantes.followups[id]?JSON.parse(JSON.stringify(state.gestantes.followups[id])):null;setFollowup(id,next,extra.note||'',extra);toastAction(message,'Desfazer',()=>{if(prev)state.gestantes.followups[id]=prev;else delete state.gestantes.followups[id];audit('2i_followup_undo',{episodeId:id,to:prev?.state||'nao_contatada'});queueSave();refreshAll();reopenDrawerIfOpen(id)})}
function firstName(e){return String(e?.nome||pregDisplayName(e)).split(' ')[0]}
function pregAct(kind,id){
  const e=mergedEpisodes().find(x=>x.id===id);if(!e)return;
  if(kind==='whatsapp'){if(e.phoneNormalized)window.open(`https://wa.me/${e.phoneNormalized}`,'_blank','noopener,noreferrer');return setFollowupWithUndo(id,'whatsapp_enviado',`WhatsApp aberto e registrado para ${firstName(e)}. Ela foi para "Em contato".`)}
  if(kind==='wa-reg')return setFollowupWithUndo(id,'whatsapp_enviado',`WhatsApp enviado registrado para ${firstName(e)}.`);
  if(kind==='busca')return setFollowupWithUndo(id,'busca_ativa_solicitada',`Busca ativa registrada para ${firstName(e)}.`);
  if(kind==='agendar')return openEpisode(id,'acomp',{sched:true});
  if(kind==='dados'){pregDrawer={id:e.id,tab:'dados',edit:true,sched:false};return openEpisode(id)}
  if(kind==='atendida')return setFollowupWithUndo(id,'ok_manual',`${firstName(e)} marcada como atendida. Já conta para a meta.`);
}
function pregSaveSchedule(id){const date=document.getElementById('pqSchedDate')?.value,time=document.getElementById('pqSchedTime')?.value||'';if(!date){toast('Escolha a data da consulta.');return}const at=time?`${date}T${time}`:date;pregDrawer.sched=false;const e=mergedEpisodes().find(x=>x.id===id);setFollowupWithUndo(id,'agendada',`Consulta de ${firstName(e)} agendada para ${fmtDate(date)}${time?` às ${time}`:''}.`,{agendaAt:at,note:`Consulta em ${fmtDate(date)}${time?` às ${time}`:''}`})}
function openPregHowTo(){openModal(`<div class="modal-head"><div><h2 id="modalTitle">Como o 2I é calculado aqui</h2><p>Leitura do CSV do Metabase somada ao acompanhamento feito nesta ferramenta.</p></div></div><div class="modal-body"><div class="notice"><strong>Atendida.</strong> Conta como atendida quem tem “Sim” em Consulta Saude Bucal no CSV do Metabase, ou quem foi confirmada manualmente no acompanhamento. Cada gestante conta uma única vez para a meta.</div><div class="notice" style="margin-top:9px"><strong>Prioridade.</strong> Gestantes no 3º trimestre (28 semanas ou mais) sem atendimento vão para o topo da fila e ganham destaque em vermelho.</div><div class="notice" style="margin-top:9px"><strong>Etapas.</strong> A contatar → Em contato (WhatsApp ou busca ativa) → Agendada → Atendida. Com parto registrado, a gestante sai da fila e fica em “Encerradas”.</div><div class="notice warn" style="margin-top:9px"><strong>Cadastros manuais</strong> entram na lista de trabalho sem alterar o CSV importado. Correções de dados também ficam só nesta ferramenta.</div></div><div class="modal-foot"><button class="btn primary" data-close-modal>Entendi</button></div>`)}
function isPriority2I(e){if(isAttended(e)||pregnancyStage(e)!=='ativa')return false;const w=gestationalWeeks(e);return w!=null?w>=28:e.monitoraPeriodo==='T3'}
function pregnancyHTML(){
  const snap=getActive2ISnapshot();
  const monSnap=mergedMonitora(),n2i=snapshotsAsc('metabase_gestantes_2i').length;
  if(!snap&&!monSnap&&!state.gestantes.manual.length)return `${emptyState('Importe o CSV de gestantes','O CSV do Metabase ou a lista do Monitora APS formam a lista do 2I. Gestantes que ainda não aparecem no CSV podem ser cadastradas à mão.')}<div style="margin-top:12px"><button class="btn" data-add-pregnant>${icon('plus')}Adicionar gestante manualmente</button></div>`;
  const p=state.preferences,tab=p.pregTab||'a_contatar';
  const expanded=visibleByExclusion(mergedEpisodes());
  const base=expanded.filter(e=>!p.pregTeam||e.equipe===p.pregTeam);
  const filtered=applyPregFilters(expanded);
  const sorted=pregQueue();
  // resumo da meta (Panorama atual): atendidas sobre o total da lista visível
  const attendedCount=base.filter(isAttended).length,pct=base.length?100*attendedCount/base.length:0;
  const seg={atendida:attendedCount,agendada:0,em_contato:0,a_contatar:0,encerrada:0};
  for(const e of base){if(isAttended(e))continue;const b=pregBucket(e);seg[b]++}
  const segDefs=[['atendida','Atendidas','green'],['agendada','Agendadas','teal'],['em_contato','Em contato','blue'],['a_contatar','A contatar','amber'],['encerrada','Parto sem atendimento','violet']];
  const bar=segDefs.filter(([k])=>seg[k]).map(([k,l,t])=>`<i class="bg-${t}" style="width:${100*seg[k]/base.length}%" title="${l}: ${seg[k]}"></i>`).join('');
  const legend=segDefs.filter(([k])=>k!=='encerrada'||seg[k]).map(([k,l,t])=>`<span><i class="pq-dot bg-${t}"></i>${l} <b>${fmtNum(seg[k])}</b></span>`).join('');
  const priority=base.filter(isPriority2I).length;
  const incompleteCount=applyPregFilters.call(null,expanded,{ignoreIncomplete:true}).filter(e=>missingDataFields(e).length>0).length;
  const tabs=PREG_TABS.map(([k,l])=>{const n=k==='todas'?filtered.length:filtered.filter(e=>pregBucket(e)===k).length;return `<button class="pq-tab${tab===k?' on':''}" role="tab" aria-selected="${tab===k}" data-preg-tab="${k}">${l}<span class="n">${fmtNum(n)}</span></button>`}).join('');
  const teams=[...new Set(expanded.map(e=>e.equipe).filter(Boolean))].sort((a,b)=>a.localeCompare(b,'pt-BR'));
  const teamChips=`<button class="pq-chip${!p.pregTeam?' on':''}" data-team-filter="">Todas as equipes</button>`+teams.map(team=>{const rows=expanded.filter(e=>e.equipe===team),ok=rows.filter(isAttended).length;return `<button class="pq-chip${p.pregTeam===team?' on':''}" data-team-filter="${esc(team)}">${esc(team)}<span class="pq-mini"><i style="width:${rows.length?100*ok/rows.length:0}%"></i></span><span class="f">${ok}/${rows.length}</span></button>`}).join('');
  const moreActive=!!(p.pregOrigin||p.pregPhone||p.pregExcluded),moreOpen=p.pregMoreFilters||moreActive;
  const sel=(k,opts)=>`<select class="filter preg-filter" data-preg-filter="${k}">${opts.map(([v,l])=>`<option value="${v}" ${p[k]===v?'selected':''}>${l}</option>`).join('')}</select>`;
  const more=moreOpen?`<div class="pq-more"><label><span>Origem</span>${sel('pregOrigin',[['','Todas'],['metabase','Metabase'],['manual','Cadastro manual'],['metabase_manual','Manual + Metabase'],['monitora','Só Monitora APS']])}</label><label><span>Telefone</span>${sel('pregPhone',[['','Todos'],['valid','Com WhatsApp válido'],['invalid','Sem número válido']])}</label><label><span>Lista</span>${sel('pregExcluded',[['','Ocultar removidas'],['only','Só removidas']])}</label>${moreActive||p.pregTeam||p.pregSearch?'<button class="btn small ghost" data-clear-preg-filters>Limpar filtros</button>':''}</div>`:'';
  const unit=snap?.unit||monSnap?.unit||'';
  const src=[snap?`CSV do Metabase ${n2i>1?`· ${n2i} arquivos somados, último em`:'importado em'} ${fmtDate(snap.createdAt)}`:monSnap?'':'Sem CSV importado · só cadastros manuais',monSnap?`Monitora APS ${monSnap.files>1?`· ${monSnap.files} arquivos somados, último em`:'importado em'} ${fmtDate(monSnap.createdAt)}`:'',`${fmtNum(expanded.length)} gestante(s) na lista`,unit].filter(Boolean).map(s=>`<span>${esc(s)}</span>`).join('');
  const rowsHTML=sorted.map(pregRow).join('');
  const empty=`<p class="pq-empty">${tab==='a_contatar'&&!p.pregTeam&&!p.pregSearch&&!p.pregPrioOnly?'Ninguém para contatar. Todas as gestantes ativas já têm algum contato registrado.':'Nenhuma gestante corresponde a esta aba e aos filtros.'}</p>`;
  return `<div class="pq-head"><div class="pq-src">${src}</div><div class="pq-actions"><button class="btn primary" data-add-pregnant>${icon('plus')}Adicionar gestante</button><div class="pq-menu-wrap"><button class="btn" data-preg-menu aria-haspopup="true">Mais${icon('chevron')}</button><div class="pq-menu" hidden><button data-action="import">${icon('upload')}Importar novo CSV</button><button data-export-2i>${icon('download')}Exportar lista</button><button data-preg-howto>${icon('info')}Como o 2I é calculado</button><button class="danger" data-clear-all-gestantes>${icon('trash')}Limpar todas as gestantes</button></div></div></div></div>
  <section class="card pq-goal" aria-label="Panorama atual"><div class="pq-goal-num" title="Panorama atual">${base.length?fmtPct(pct,1):'—'}<small>${fmtNum(attendedCount)} de ${fmtNum(base.length)} gestante(s) atendida(s)${p.pregTeam?` · ${esc(p.pregTeam)}`:''}</small></div><div><div class="pq-bar">${bar}</div><div class="pq-legend">${legend}</div></div>${priority?`<div class="pq-prio">${icon('alert')}<span><strong>${fmtNum(priority)} gestante(s) no 3º trimestre</strong> ainda sem atendimento odontológico. O parto está próximo.</span><button data-preg-prio>${p.pregPrioOnly?'Mostrar todas':'Ver só essas'}</button></div>`:''}</section>
  <article class="card pq-queue"><div class="pq-tabs" role="tablist">${tabs}</div><div class="pq-tools"><label class="search-box">${icon('search')}<input id="pregSearch" type="search" value="${esc(p.pregSearch)}" placeholder="Buscar nome ou prontuário..."></label><div class="pq-chips">${teamChips}</div><button class="pq-chip${p.pregIncomplete?' on':''}" data-preg-incomplete aria-pressed="${!!p.pregIncomplete}" title="Gestantes sem nome, telefone ou DUM/DPP">Dados incompletos<span class="f">${fmtNum(incompleteCount)}</span></button><button class="pq-chip${moreOpen?' on':''}" data-preg-more>Mais filtros${moreActive?' ·':''}</button></div>${more}<div class="pq-hint">${p.pregPrioOnly?'Mostrando só o 3º trimestre sem atendimento. ':''}${p.pregIncomplete?'Mostrando só gestantes sem nome, telefone ou DUM/DPP. ':''}${PREG_TAB_HINTS[tab]}</div><div class="pq-legend pq-legend-tones"><span><i class="pq-sw tone-red"></i>3º tri sem atendimento</span><span><i class="pq-sw tone-amber"></i>A contatar</span><span><i class="pq-sw tone-blue"></i>Em contato</span><span><i class="pq-sw tone-teal"></i>Agendada</span><span><i class="pq-sw tone-green"></i>Atendida</span><span><i class="pq-sw tone-violet"></i>Encerrada</span></div><div class="pq-list">${rowsHTML||empty}</div></article>`;
}
function profileLabel(profile){return ({celk_procedimentos_detalhado:'CELK · procedimentos detalhados',celk_atividades_grupo:'CELK · atividades em grupo',metabase_saude_bucal:'Metabase · consolidado Saúde Bucal',metabase_gestantes_2i:'Metabase · gestantes 2I',monitora_aps_gestantes:'Monitora APS · gestantes (anonimizado)',csv_manual_configuravel:'CSV · layout não reconhecido',pdf_nao_reconhecido:'PDF · layout não reconhecido'})[profile]||profile}
function snapshotPeriod(s){const months=Object.keys(s.dataByMonth||{}).sort();return months.length?`${fmtMonth(months[0])}${months.length>1?`–${fmtMonth(months.at(-1))}`:''}`:s.periodStart||s.periodEnd?`${fmtDate(s.periodStart)}–${fmtDate(s.periodEnd)}`:'sem competência detectada'}
/* ---------- Configurações (v2.17): quatro subabas com a situação no próprio botão ---------- */
const SETTINGS_TABS=[['geral','Geral','database'],['imports','Arquivos','file'],['diagnostics','Verificação','check'],['conferencia','Conferência por procedimento','tooth']];
// Avisos que valem para todo arquivo de um tipo: aparecem uma vez em "Limites das fontes", não como pendência.
const SOURCE_LIMIT_CODES=['TRUNCATED_RESTORATION','GROUP_AGGREGATED','2I_CONSOLIDATED_FIELD'];
function diagTitle(d){
  const c=d.code||'',id=c.split('_')[0],fed={M1:'B1',M3:'B4'}[id];
  if(/_DEN_MISSING$/.test(c))return `${id} e ${fed} sem denominador em ${fmtMonth(state.preferences.month,true)}`;
  if(/_DEN_ZERO$/.test(c))return `${id} com denominador zero`;
  if(/_OVER_100$/.test(c))return `${id} acima de 100%`;
  if(/_DEN_DIVERGE_SUGGESTION$/.test(c))return `Denominador de ${id} diferente do sugerido`;
  if(/^RECON_/.test(c))return `${c.slice(6)}: CELK diferente do Metabase`;
  return ({M1_QUANTITY_VS_PEOPLE:'Primeiras consultas repetidas da mesma pessoa',M2_QUANTITY_VS_PEOPLE:'Tratamentos concluídos repetidos da mesma pessoa',M1_REPEAT_WITHIN_12M:'Primeira consulta repetida em menos de 12 meses',M2_REPEAT_WITHIN_12M:'Tratamento concluído repetido em menos de 12 meses',
    TRUNCATED_RESTORATION:'Descrição de restauração abreviada pelo CELK',CSV_OTHER_UNIT_COUNTED:'Linhas de outra unidade contadas',GROUP_AGGREGATED:'Presentes sem idade',GROUP_AGE_FILTERED:'Idade dos participantes aplicada',CONSOLIDATED_REFERENCE:'Consolidado usado só como referência',M1_LEGACY_SCORE:'Pontuação antiga de M1 ignorada',
    MONITORA_SEM_USUARIA:'Linha do Monitora APS sem Usuária',MONITORA_DUPLICADA:'Usuária repetida no Monitora APS',MONITORA_ANONIMIZADO:'Gestantes do Monitora APS com dados a completar',MONITORA_RESUMO:'Resumo do Monitora APS',
    '2I_PRONTUARIO_SCIENTIFIC':'Prontuário em notação científica','2I_DUPLICATE_CONFLICT':'Gestação repetida com dados diferentes','2I_DUPLICATE':'Gestação repetida no CSV','2I_CONSOLIDATED_FIELD':'CSV de gestantes sem data da consulta','2I_PHONE_INVALID':'Telefone inválido ou sem DDD','2I_MANUAL_MATCH':'Cadastro manual pode ser a mesma gestante do Metabase',
    CSV_UNKNOWN:'CSV não reconhecido',PDF_UNKNOWN:'PDF não reconhecido',B5_NORMATIVE_TENSION:'B5 acima de 85%',B3_BELOW_3:'B3 abaixo de 3%',PATIENT_NAMES_SAVED:'Nomes de pacientes guardados',POPULATION_IMPORTED:'População ativa importada',PASSWORD_REQUIRED:'Backup com senha'})[c]||c||'Aviso';
}
function diagAction(d){
  const m=/^(M1|M3)_DEN_MISSING$/.exec(d.code||'');if(m)return `<button class="btn small primary" data-indicator-detail="${m[1]}" data-detail-scope="month">Confirmar</button>`;
  if(d.code==='MONITORA_ANONIMIZADO')return `<button class="btn small" data-preg-origin-go="monitora">Ver gestantes</button>`;
  if(d.episodeId&&d.code!=='2I_PHONE_INVALID')return `<button class="btn small" data-open-episode="${esc(d.episodeId)}">Abrir gestante</button>`;
  if(d.snapshotId)return `<button class="btn small" data-open-snapshot="${d.snapshotId}">Abrir arquivo</button>`;
  return '';
}
function diagDupHTML(d,snap){
  if(d.code==='M1_QUANTITY_VS_PEOPLE'&&snap)return duplicatesDisclosureHTML(firstConsultationDuplicatesForMonth(snap,d.month));
  if((d.code==='M1_REPEAT_WITHIN_12M'||d.code==='M2_REPEAT_WITHIN_12M')&&d.dupGroups)return crossFileDuplicatesDisclosureHTML(d.dupGroups);
  return '';
}
function diagRowHTML(d,{action=true,file=true,snap=null}={}){
  const lvl=d.level==='error'?'bad':d.level==='warning'?'warn':'info',sn=snap||(d.snapshotId?state.snapshots.find(s=>s.id===d.snapshotId):null);
  return `<div class="st-row"><span class="st-mark ${lvl}" aria-hidden="true">${lvl==='info'?'i':'!'}</span><div><b>${esc(diagTitle(d))}${d.count>1?` <em class="st-x">×${d.count}</em>`:''}</b><p>${esc(d.message)}</p>${diagDupHTML(d,sn)}<span class="st-code">${esc(d.code||'')}${file&&d.fileName?(d.count>1?` · ${d.count} arquivos`:` · ${esc(d.fileName)}`):''}</span></div><div class="st-acts">${action?diagAction(d):''}</div></div>`;
}
function groupDiagnostics(list){const map=new Map();for(const d of list){const k=`${d.level}|${d.code}|${d.message}`;const prev=map.get(k);if(prev)prev.count++;else map.set(k,{...d,count:1})}return [...map.values()]}
function settingsDiagnostics(){
  const all=groupDiagnostics(buildDiagnostics()),rank={error:0,warning:1,info:2};
  const todo=all.filter(d=>d.level!=='info'&&!SOURCE_LIMIT_CODES.includes(d.code)).sort((a,b)=>rank[a.level]-rank[b.level]);
  return {todo,info:all.filter(d=>d.level==='info'),all};
}
function fmtClock(iso){return iso?new Date(iso).toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'}):''}
function settingsTabStatus(tab){
  const mk=state.preferences.month;
  if(tab==='geral'){const saved=localSave.enabled?(localSave.error?'Falha ao salvar':localSave.lastSavedAt?`Salvo às ${fmtClock(localSave.lastSavedAt)}`:'Salvamento ligado'):'Salvamento desligado';return {cls:!localSave.enabled||localSave.error||state.dirty?'warn':'ok',text:`${saved} · backup ${state.dirty?'pendente':'em dia'}`}}
  if(tab==='imports'){const n=state.snapshots.length,newest=[...state.snapshots].sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt))[0];return {cls:'',text:n?`${n} arquivo${n===1?'':'s'} · último em ${fmtDate(newest.createdAt)}`:'Nenhum arquivo importado'}}
  if(tab==='diagnostics'){const n=settingsDiagnostics().todo.length;return {cls:n?'warn':'ok',text:n?`${n} pendência${n===1?'':'s'} em ${fmtMonth(mk,true)}`:`Nada para resolver em ${fmtMonth(mk,true)}`}}
  const n=(aggregateProcedureMonth(mk)?.procedureCounts||[]).length;return {cls:'',text:n?`${fmtMonth(mk,true)} · ${n} procedimento${n===1?'':'s'}`:`Sem produção em ${fmtMonth(mk,true)}`};
}
function settingsHTML(){
  const tab=SETTINGS_TABS.some(([id])=>id===state.preferences.settingsTab)?state.preferences.settingsTab:'geral';
  const content=tab==='imports'?importsHTML():tab==='diagnostics'?diagnosticsHTML():tab==='conferencia'?procedureCheckHTML():settingsPreferencesHTML();
  return `<div class="subtabs st-tabs" role="tablist">${SETTINGS_TABS.map(([id,label,ic])=>{const st=settingsTabStatus(id);return `<button class="subtab st-tab${tab===id?' active':''}" role="tab" aria-selected="${tab===id}" data-settings-tab="${id}"><span class="st-ic">${icon(ic)}</span><b>${esc(label)}</b><span class="st-st"><i class="st-dot ${st.cls}"></i><span>${esc(st.text)}</span></span></button>`}).join('')}</div>${content}`;
}
function settingsPreferencesHTML(){
  const mk=state.preferences.month,dirty=!!state.dirty,has2i=has2IData();
  const saveRow=`<div class="st-row"><span class="st-mark ${localSave.enabled&&!localSave.error?'ok':'warn'}" aria-hidden="true">${localSave.enabled&&!localSave.error?'✓':'!'}</span><div><b>${localSave.enabled?(localSave.error?'Falha ao salvar neste navegador':'Salvo neste navegador'):'Salvamento no navegador desligado'}</b><p>${localSave.enabled?(localSave.error?`${esc(localSave.error)}. Exporte um backup para não perder os dados.`:`${localSave.lastSavedAt?`Última gravação em ${fmtDateTime(localSave.lastSavedAt)}. `:''}Vale só para este computador e este perfil de navegador.`):'Nada fica guardado: fechar ou recarregar a aba sem exportar um backup apaga tudo.'}</p></div><label class="st-switch" title="Salvar automaticamente neste navegador"><input type="checkbox" data-autosave-toggle ${localSave.enabled?'checked':''} aria-label="Salvar automaticamente neste navegador"><i></i></label></div>`;
  const backupRow=`<div class="st-row"><span class="st-mark ${dirty?'warn':'ok'}" aria-hidden="true">${dirty?'!':'✓'}</span><div><b>Backup em arquivo ${dirty?'pendente':'em dia'}</b><p>${state.lastBackupAt?`Último backup em ${fmtDateTime(state.lastBackupAt)}.`:'Nenhum backup exportado.'}${dirty?' Há mudanças que só existem neste navegador.':''} O backup leva os dados para outro computador.${has2i?' Com dados de gestantes, use senha.':''}</p></div><div class="st-acts"><button class="btn small" data-action="restore-backup">Restaurar</button><button class="btn small primary" data-action="export-backup">Exportar</button></div></div>`;
  const denRow=id=>{const rec=getDenominator(id,'municipal',mk),fed=id==='M1'?'B1':'B4',pop=id==='M1'?activePopulationInput(mk):null,v=rec?Number(rec.value):null;
    const detail=rec?`${pop?`${fmtNum(pop.totalPopulation)} pessoas ÷ ${fmtNum(pop.esfCount)} ESF × ${fmtNum(pop.dentistCount)} dentistas · `:''}vale de ${fmtMonth(rec.start)} a ${fmtMonth(rec.end,true)} · ${esc(rec.origin||'confirmado')}`:`<span class="st-miss">Não confirmado para ${esc(fmtMonth(mk,true))}.</span> Sem ele, ${id} e ${fed} não são calculados neste mês.`;
    return `<div class="st-den"><div class="st-ids"><span>${id}</span><span>${fed}</span></div><div><b>${id==='M1'?'Pessoas de referência':'Crianças de 6 a 12 anos'}</b><p>${detail}</p></div><div class="st-den-v"><strong>${v==null?'—':fmtNum(v,ovDenDecimals(v))}</strong><button class="btn small${rec?'':' primary'}" data-indicator-detail="${id}" data-detail-scope="month">${rec?'Editar':'Confirmar'}</button></div></div>`};
  const hist=[...state.denominators].sort((a,b)=>String(b.updatedAt||'').localeCompare(String(a.updatedAt||'')));
  const histHTML=hist.length?`<details class="st-more"><summary>Histórico <small>${hist.length} registro${hist.length===1?'':'s'}</small></summary><div class="table-scroll"><table class="st-table"><thead><tr><th>Indicador</th><th class="num">Valor</th><th>Vigência</th><th>Origem</th><th>Alterado em</th></tr></thead><tbody>${hist.map(d=>`<tr><td>${esc(d.indicator)}${d.indicator==='M1'?' · B1':d.indicator==='M3'?' · B4':''}</td><td class="num">${fmtNum(Number(d.value),ovDenDecimals(Number(d.value)))}</td><td>${fmtMonth(d.start)} a ${fmtMonth(d.end)}</td><td>${esc(d.origin||'—')}</td><td>${d.updatedAt?fmtDate(d.updatedAt):'—'}</td></tr>`).join('')}</tbody></table></div></details>`:'';
  return `<div class="st-two">
    <article class="card st-box"><div class="st-box-h"><h2>Salvamento e backup</h2></div><div class="st-rows">${saveRow}${backupRow}</div>
      <div class="st-foot"><span>Os arquivos são lidos só neste computador; nada é enviado. As linhas originais com nomes somem ao fechar a aba.</span><button class="btn small st-danger" data-clear-browser>${icon('trash')}Limpar dados do navegador…</button></div></article>
    <article class="card st-box"><div class="st-box-h"><h2>Denominadores</h2><small>${esc(fmtMonth(mk,true))}</small></div><div>${denRow('M1')}${denRow('M3')}</div>${histHTML}</article>
  </div>
  <article class="card st-box"><div class="st-box-h"><h2>Sobre</h2></div>
    <dl class="st-kv"><dt>Versão</dt><dd>${esc(APP_VERSION)} · regras ${esc(RULE_VERSION)}</dd><dt>Regra municipal</dt><dd>${esc(RULESETS.municipal.fonte_normativa)}</dd><dt>Regra federal</dt><dd>${esc(RULESETS.federal.fonte_normativa)}</dd><dt>Fontes</dt><dd>O cálculo usa o CELK. O Metabase serve só para conferência e nunca substitui o CELK sem aviso.</dd></dl>
    <details class="st-more"><summary>Como usar, passo a passo</summary><ol class="st-steps">
      <li><b>Importe o Procedimentos Detalhado</b> do CELK durante o mês (PDF ou CSV).</li>
      <li><b>Importe a Relação das Atividades em Grupo</b> para M3 e B4.</li>
      <li><b>Confirme os denominadores</b> de M1 e M3. B1 e B4 usam os mesmos valores.</li>
      <li><b>Importe as listas de gestantes</b> do Metabase e do Monitora APS. Um arquivo novo soma ao anterior.</li>
      <li><b>Resolva as pendências</b> em Verificação antes de apresentar os números.</li>
      <li><b>Exporte um backup com senha</b> ao fechar o quadrimestre.</li>
    </ol></details></article>`;
}
/* ---- Arquivos ---- */
const SNAPSHOT_GROUPS=[['celk_procedimentos_detalhado','Produção','CELK · Procedimentos Detalhado'],['celk_atividades_grupo','Atividades em grupo','CELK'],['metabase_gestantes_2i','Gestantes','Metabase · 2I'],['monitora_aps_gestantes','Gestantes','Monitora APS'],['metabase_populacao_ativa','População ativa','usada em M1 e B1'],['pse_avaliacao','PSE','avaliações nas escolas']];
function snapshotState(s){return s.supersededBy?['old','Substituído']:CUMULATIVE_2I_PROFILES.includes(s.profile)?['sum','Somado']:['use','Em uso']}
function snapshotMonthsSum(s,key){return sum(Object.values(s.dataByMonth||{}).map(d=>Number(d?.[key])||0))}
function snapshotShortInfo(s){
  const p=s.profile,parts=[];const per=snapshotPeriod(s);if(!/sem competência/.test(per))parts.push(per);
  if(p==='celk_procedimentos_detalhado')parts.push(`${fmtNum(sum((s.procedureCounts||[]).map(x=>x.quantityValid)))} procedimentos válidos`);
  else if(p==='celk_atividades_grupo')parts.push(`${fmtNum(snapshotMonthsSum(s,'activities'))} atividades`);
  else if(p==='metabase_gestantes_2i')parts.push(`${fmtNum((s.episodes||[]).length)} gestantes`);
  else if(p==='monitora_aps_gestantes')parts.push(`${fmtNum((s.monitoraRows||[]).length)} gestantes e ${fmtNum((s.puerperio||[]).length)} puérperas`);
  else if(p==='metabase_populacao_ativa'&&s.population)parts.push(`${fmtNum(s.population.totalPopulation)} pessoas`);
  else if(p===PSE_PROFILE)parts.push(`${fmtNum((s.pse?.kids||[]).length)} crianças · ${(s.pse?.escolas||[]).join(', ')}`);
  if(s.supersededBy){const by=state.snapshots.find(x=>x.id===s.supersededBy);if(by)parts.push(`substituído pelo arquivo de ${fmtDate(by.createdAt)}`)}
  return parts.join(' · ');
}
function importsHTML(){
  const items=[...state.snapshots].sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt)),known=SNAPSHOT_GROUPS.map(g=>g[0]);
  const row=s=>{const [cls,label]=snapshotState(s);return `<div class="st-file${s.supersededBy?' old':''}"><div class="st-file-n"><b title="${esc(s.fileName)}">${esc(s.fileName)}</b><small>${esc(snapshotShortInfo(s))}</small></div><span class="st-when">${fmtDateTime(s.createdAt)}</span><span class="st-tag ${cls}">${label}</span><div class="st-file-acts"><button class="btn small" data-open-snapshot="${s.id}">Conferir</button><button class="btn small st-del" data-delete-snapshot="${s.id}" aria-label="Excluir ${esc(s.fileName)}" title="Excluir este arquivo">${icon('trash')}</button></div></div>`};
  const groups=[...SNAPSHOT_GROUPS,['__other','Outros arquivos','']].map(([p,title,sub])=>{const list=items.filter(s=>p==='__other'?!known.includes(s.profile):s.profile===p);return list.length?`<div class="st-group"><h3>${esc(title)} <span>${esc(sub)}</span></h3>${list.map(row).join('')}</div>`:''}).join('');
  return `<article class="card st-box"><div class="st-drop"><span class="st-drop-ic">${icon('upload')}</span><div><b>Importar relatórios</b><p>Arraste PDFs e CSVs para esta página ou escolha os arquivos. O tipo de cada arquivo é reconhecido sozinho.</p></div><button class="btn primary" data-action="import">${icon('upload')}Selecionar arquivos</button></div>
    <div class="st-rules"><div><b>O mesmo arquivo não entra duas vezes</b>Um arquivo já importado é reconhecido e ignorado.</div><div><b>Produção e atividades em grupo</b>Um arquivo novo do mesmo mês substitui o anterior, para não contar em dobro.</div><div><b>Listas de gestantes e Monitora</b>Os arquivos se somam: quem já estava continua, sem duplicar.</div></div></article>
  <article class="card st-box"><div class="st-box-h"><h2>Arquivos importados</h2><small>Conferir mostra o que cada arquivo trouxe, os avisos e as linhas lidas</small></div>${groups||'<p class="st-empty">Nenhum arquivo importado.</p>'}</article>`;
}
/* ---- Verificação ---- */
function diagnosticsHTML(){
  const {todo,info}=settingsDiagnostics(),mk=state.preferences.month,r=state.selfTests;
  const todoHTML=todo.length?`<div class="st-rows">${todo.map(d=>diagRowHTML(d)).join('')}</div>`:`<div class="st-ok"><span class="st-mark ok" aria-hidden="true">✓</span><span>Nada para resolver em ${esc(fmtMonth(mk,true))}.</span></div>`;
  return `<article class="card st-box"><div class="st-box-h"><h2>Para resolver</h2><small>${esc(fmtMonth(mk,true))}${state.preferences.unit?` · ${esc(state.preferences.unit)}`:''}</small></div>${todoHTML}
    ${info.length?`<details class="st-more"><summary>O que os arquivos trouxeram <small>${info.length} informaç${info.length===1?'ão':'ões'}</small></summary><div class="st-rows">${info.map(d=>diagRowHTML(d)).join('')}</div></details>`:''}
    <details class="st-more"><summary>Limites das fontes <small>o que os relatórios não trazem</small></summary><ul class="st-limits">
      <li><b>Procedimentos Detalhado</b>: não traz CBO, INE, CNS nem a janela federal de 12 meses, por isso B1–B6 são prévia. O CELK abrevia descrições de restaurações: elas entram na família restauradora, sem afirmar o SIGTAP específico.</li>
      <li><b>Atividades em grupo</b>: traz o total de presentes, sem idade e sem separar quem participou de mais de uma atividade (exceto o CSV com idade por participante).</li>
      <li><b>Gestantes (Metabase)</b>: não traz a data da consulta, o código nem o CBO. O app usa só o campo "Consulta Saúde Bucal" (Sim = atendida).</li>
      <li><b>Nenhum relatório traz</b>: o número de crianças de 6 a 12 anos (denominador de M3 e B4) nem a elegibilidade federal por CBO, INE e CNS.</li>
    </ul></details>
    <div class="st-golink"><span>Quanto de cada procedimento foi lido, quanto valeu e em que indicador entra fica na aba <b>Conferência por procedimento</b>.</span><button class="link-btn" data-settings-tab="conferencia">Abrir →</button></div></article>
  <article class="card st-box st-tests"><span class="st-score">${r?`${r.passed}/${r.total}`:'—'}</span><div><b>${r?(r.failed?'Há testes internos que falharam':'Testes internos passaram'):'Testes internos ainda não executados'}</b><span>${r?`Executados em ${fmtDateTime(r.at)} · ${r.durationMs} ms. `:''}Conferem fórmulas, faixas, privacidade e gestantes.</span></div><button class="btn small" data-run-tests>${icon('check')}Executar ${SELF_TEST_COUNT} testes</button></article>`;
}
/* ---- Conferência por procedimento ---- */
function procedureRoleChips(p){const b=procedureRoleBadges(p.roles);if(b.length)return b.map(x=>`<span class="st-c${x.part==='Numerador'?' n':''}">${esc(x.ind)} ${x.part==='Numerador'?'num':'den'}</span>`).join('');return p.outOfScope?pill('Fora do escopo','info'):p.unrecognized?pill('Não identificado','warn'):'—'}
function procedureCheckHTML(){
  const mk=state.preferences.month,proc=aggregateProcedureMonth(mk),rows=[...(proc?.procedureCounts||[])].sort((a,b)=>b.quantityValid-a.quantityValid);
  if(!rows.length)return `<article class="card st-box"><div class="st-box-h"><h2>Conferência por procedimento</h2><small>${esc(fmtMonth(mk,true))}</small></div><p class="st-empty">Nenhum relatório "Procedimentos Detalhado" para ${esc(fmtMonth(mk,true))}. Importe o relatório ou escolha outro mês no topo.</p></article>`;
  const body=rows.map(p=>`<tr><td><b>${esc(p.descriptionNormalized)}</b><br><span class="muted">${esc(p.descriptionOriginal)}</span></td><td class="mono nowrap">${esc(p.sigtap||'—')}</td><td class="num">${fmtNum(p.quantityRaw,2)}</td><td class="num">${fmtNum(Math.max(0,p.quantityRaw-p.quantityValid),2)}</td><td class="num"><strong>${fmtNum(p.quantityValid,2)}</strong></td><td><div class="st-chips">${procedureRoleChips(p)}</div></td></tr>`).join('');
  return `<article class="card st-box"><div class="st-box-h"><h2>Conferência por procedimento</h2><small>${esc(fmtMonth(mk,true))}${state.preferences.unit?` · ${esc(state.preferences.unit)}`:''} · ${rows.length} procedimento${rows.length===1?'':'s'}</small></div>
    <p class="st-note">Segue o mês e a unidade escolhidos no topo. Mostra quanto de cada procedimento foi lido, quanto foi excluído (repetições) e em qual indicador entra (num = numerador, den = denominador). As páginas e linhas de origem ficam no "Conferir" de cada arquivo.</p>
    <div class="table-scroll"><table class="st-table"><thead><tr><th>Procedimento</th><th>SIGTAP</th><th class="num">Lida</th><th class="num">Excluída</th><th class="num">Válida</th><th>Entra em</th></tr></thead><tbody>${body}</tbody><tfoot><tr><td colspan="2"><strong>Total</strong></td><td class="num"><strong>${fmtNum(sum(rows.map(p=>p.quantityRaw)),2)}</strong></td><td class="num"><strong>${fmtNum(sum(rows.map(p=>Math.max(0,p.quantityRaw-p.quantityValid))),2)}</strong></td><td class="num"><strong>${fmtNum(sum(rows.map(p=>p.quantityValid)),2)}</strong></td><td></td></tr></tfoot></table></div>
    <div class="st-foot"><span></span><button class="btn small" data-export-procedures>${icon('download')}Exportar CSV</button></div></article>`;
}
/* ---- Conferir (gaveta do arquivo) ---- */
function snapshotFacts(s){
  const p=s.profile,m=s.mergeSummary,per=snapshotPeriod(s),unit=s.unit||'Não identificada';
  if(p==='celk_procedimentos_detalhado'){const pcs=s.procedureCounts||[];return {facts:[[fmtNum(sum(pcs.map(x=>x.quantityValid))),'procedimentos válidos'],[fmtNum(sum(pcs.map(x=>Math.max(0,x.quantityRaw-x.quantityValid)))),'lançamentos excluídos'],[fmtNum(snapshotMonthsSum(s,'firstConsultations')),'pessoas com primeira consulta'],[fmtNum(snapshotMonthsSum(s,'treatmentsConcluded')),'tratamentos concluídos'],[per,'período'],[unit,'unidade']],uses:['M1','M2','M4','M5','B1','B2','B3','B5','B6'],usesText:`Entra em ${per} de`}}
  if(p==='celk_atividades_grupo')return {facts:[[fmtNum(snapshotMonthsSum(s,'activities')),'atividades'],[fmtNum(snapshotMonthsSum(s,'eligibleActivities')),'escovações supervisionadas'],[fmtNum(snapshotMonthsSum(s,'supervisedBrushingPresent')),'presentes nas escovações'],[fmtNum(Object.keys(s.dataByMonth||{}).length),'meses'],[per,'período'],[unit,'unidade']],uses:['M3','B4'],usesText:'Entra no numerador de'};
  if(p==='metabase_gestantes_2i'){const eps=s.episodes||[];return {facts:[[fmtNum(eps.length),'gestantes no arquivo'],...(m?[[fmtNum(m.fresh),'novas'],[fmtNum(m.updated),'atualizadas'],[fmtNum(m.same),'iguais ao que já havia']]:[[fmtNum(new Set(eps.map(e=>e.equipe).filter(Boolean)).size),'equipes']]),[fmtNum(eps.filter(e=>e.status2i==='atende').length),'com "Sim" em Consulta Saúde Bucal'],[unit,'unidade']],uses:['2I'],usesText:'Entra na lista de gestantes do'}}
  if(p==='monitora_aps_gestantes'){const rows=s.monitoraRows||[];return {facts:[[fmtNum(rows.length),'gestantes'],[fmtNum((s.puerperio||[]).length),'puérperas (fora da lista)'],...(m?[[fmtNum(m.fresh),'novas'],[fmtNum(m.updated),'atualizadas']]:[]),[fmtNum(rows.filter(r=>r.monitoraOdonto==='atende').length),'com "Sim" em Cons.Odonto'],[fmtNum(new Set(rows.map(r=>r.equipe).filter(Boolean)).size),'equipes']],uses:['2I'],usesText:'Entra na lista de gestantes do'}}
  if(p===PSE_PROFILE){const k=s.pse?.kids||[];return {facts:[[fmtNum(k.length),'crianças'],[fmtNum(k.filter(x=>x.status==='Preenchida').length),'avaliadas'],[fmtNum(k.filter(x=>x.risco==='Alto').length),'risco alto'],[(s.pse?.escolas||[]).join(', ')||'—','escola'],[per,'período']],uses:[],usesText:''}}
  if(p==='metabase_populacao_ativa'&&s.population){const inp=state.populationInputs.find(x=>x.snapshotId===s.id),den=inp&&inp.esfCount>0?inp.totalPopulation/inp.esfCount*inp.dentistCount:null;return {facts:[[fmtNum(s.population.totalPopulation),'pessoas'],[fmtNum((s.population.bands||[]).length),'faixas etárias'],...(inp?[[fmtNum(inp.esfCount),'ESF do CS'],[fmtNum(inp.dentistCount),'dentistas'],[den==null?'—':fmtNum(den,ovDenDecimals(den)),'denominador de M1 e B1']]:[])],uses:['M1','B1'],usesText:'Denominador de'}}
  return {facts:[[per,'período'],[unit,'unidade'],[fmtNum((s.validations||[]).length),'avisos']],uses:[],usesText:''};
}
function snapshotContentTab(s){
  if(s.profile==='celk_procedimentos_detalhado')return ['Procedimentos',snapshotProceduresHTML(s)];
  if(s.profile==='celk_atividades_grupo'){const months=Object.entries(s.dataByMonth||{}).sort(([a],[b])=>a.localeCompare(b));return ['Atividades',`<div class="table-scroll"><table class="st-table"><thead><tr><th>Mês</th><th class="num">Atividades</th><th class="num">Escovações</th><th class="num">Presentes</th></tr></thead><tbody>${months.map(([mk,d])=>`<tr><td>${fmtMonth(mk,true)}</td><td class="num">${fmtNum(d.activities||0)}</td><td class="num">${fmtNum(d.eligibleActivities||0)}</td><td class="num">${fmtNum(d.supervisedBrushingPresent||0)}</td></tr>`).join('')}</tbody></table></div>`]}
  if(s.profile==='metabase_populacao_ativa'&&s.population)return ['Faixas etárias',`<div class="table-scroll"><table class="st-table"><thead><tr><th>Faixa</th><th class="num">Pessoas</th></tr></thead><tbody>${(s.population.bands||[]).map(b=>`<tr><td>${esc(b.faixa)}</td><td class="num">${fmtNum(b.todos)}</td></tr>`).join('')}</tbody></table></div><p class="st-note">Soma da coluna "Todos os serviços".</p>`];
  return null;
}
function snapshotProceduresHTML(s){const procs=[...(s.procedureCounts||[])].sort((a,b)=>b.quantityValid-a.quantityValid);if(!procs.length)return '<p class="st-empty">Este arquivo não tem contagem por procedimento.</p>';return `<div class="table-scroll"><table class="st-table"><thead><tr><th>Procedimento</th><th>SIGTAP</th><th class="num">Válida</th><th class="num">Excluída</th><th>Páginas</th></tr></thead><tbody>${procs.map(p=>`<tr><td>${esc(p.descriptionNormalized)}<br><span class="muted">${esc(p.descriptionOriginal)}</span></td><td class="mono nowrap">${esc(p.sigtap||'—')}</td><td class="num">${fmtNum(p.quantityValid,2)}</td><td class="num">${fmtNum(Math.max(0,p.quantityRaw-p.quantityValid),2)}</td><td class="nowrap">${(p.pages||[]).join(', ')||'—'}</td></tr>`).join('')}</tbody></table></div>`}
function validationHTML(s){const list=groupDiagnostics(s.validations||[]);return list.length?`<div class="st-rows">${list.map(v=>diagRowHTML(v,{action:false,file:false,snap:s})).join('')}</div>`:'<p class="st-empty">Nenhum aviso para este arquivo.</p>'}
// Excluir um arquivo importado (v2.23): os dados dele saem de todos os cálculos e da lista; se ele tinha substituído
// um arquivo do mesmo período, o anterior volta a valer. Denominadores confirmados, acompanhamento das gestantes e o
// cadastro de nomes de pacientes ficam guardados.
function snapshotDeleteImpact(s){
  const restored=state.snapshots.filter(x=>x.supersededBy===s.id),p=s.profile,out=[];
  if(s.supersededBy)out.push('Ele já estava substituído por um arquivo mais novo do mesmo período e não entrava em nenhum cálculo.');
  else if(p==='celk_procedimentos_detalhado')out.push(`Os indicadores de ${esc(snapshotPeriod(s))} deixam de usar a produção deste arquivo (M1, M2, M4, M5 e B1 a B6), assim como a página Procedimentos e o cruzamento com as gestantes.`);
  else if(p==='celk_atividades_grupo')out.push(`M3 e B4 de ${esc(snapshotPeriod(s))} deixam de usar as atividades deste arquivo.`);
  else if(p===PSE_PROFILE)out.push('As avaliações deste arquivo saem da página PSE e da análise. O acompanhamento, os alunos marcados e os cadastros editados ficam guardados e voltam se o arquivo for importado de novo.');
  else if(CUMULATIVE_2I_PROFILES.includes(p))out.push('Quem veio só deste arquivo sai da lista de gestantes. Quem também está em outro arquivo continua, com os dados desse outro arquivo. O acompanhamento registrado (contatos, agendamentos, dados completados) fica guardado e volta se o arquivo for importado de novo.');
  else if(p==='metabase_populacao_ativa')out.push('O denominador de M1 e B1 já confirmado continua valendo. Para mudar, edite o denominador.');
  for(const r of restored)out.push(`O arquivo anterior do mesmo período, <b>${esc(r.fileName)}</b>, volta a valer.`);
  out.push('O cadastro de nomes de pacientes não é apagado.');
  return out;
}
function openDeleteSnapshotModal(id){
  const s=state.snapshots.find(x=>x.id===id);if(!s)return;closeDrawer();
  openModal(`<div class="modal-head"><div><h2 id="modalTitle">Excluir arquivo</h2><p>${esc(s.fileName)} · ${esc(profileLabel(s.profile))} · importado em ${fmtDateTime(s.createdAt)}</p></div></div><div class="modal-body"><ul class="st-limits" style="margin:0">${snapshotDeleteImpact(s).map(t=>`<li>${t}</li>`).join('')}</ul><p style="margin:12px 0 0;color:var(--muted);font-size:12.5px">Para desfazer, importe o arquivo de novo.</p></div><div class="modal-foot"><button class="btn" data-close-modal>Cancelar</button><button class="btn danger" data-confirm-delete-snapshot="${s.id}">${icon('trash')}Excluir arquivo</button></div>`);
}
function deleteSnapshot(id){
  const i=state.snapshots.findIndex(x=>x.id===id);if(i<0)return null;const [s]=state.snapshots.splice(i,1);
  sessionRaw.delete(s.id);for(const p of state.populationInputs||[])if(p.snapshotId===s.id)p.snapshotId=null;
  recomputeSupersession();audit('snapshot_deleted',{snapshotId:s.id,profile:s.profile,fileName:s.fileName,hash:s.hash,periodStart:s.periodStart,periodEnd:s.periodEnd});
  return s;
}
function confirmDeleteSnapshot(id){const s=deleteSnapshot(id);closeModal();closeDrawer();if(!s)return;queueSave();refreshAll();toast(`Arquivo excluído: ${s.fileName}.`)}
function openSnapshot(id,tab){
  const s=state.snapshots.find(x=>x.id===id);if(!s)return;
  const [cls,label]=snapshotState(s),f=snapshotFacts(s),content=snapshotContentTab(s),nv=(s.validations||[]).length;
  const tabs=[...(content?[['content',content[0],content[1]]]:[]),['avisos',`Avisos (${nv})`,validationHTML(s)],['raw','Linhas lidas',rawSampleHTML(s)]];
  const cur=tabs.find(t=>t[0]===tab)||tabs[0],by=s.supersededBy?state.snapshots.find(x=>x.id===s.supersededBy):null;
  openDrawer(`<div class="pq-drawer tone-violet st-snap" data-snapshot-open="${s.id}">
    <header class="pq-d-h"><div class="pq-d-h-top"><span class="indicator-id" style="margin-right:auto">ARQUIVO IMPORTADO</span><button class="pq-icon" data-close-drawer aria-label="Fechar">${icon('close')}</button></div>
      <h2 class="st-fname">${esc(s.fileName)}</h2><p class="pq-d-sub"><span class="st-tag ${cls}">${label}</span> ${esc(profileLabel(s.profile))} · importado em ${fmtDateTime(s.createdAt)}</p><div style="height:12px"></div></header>
    <div class="pq-d-b">
      ${s.supersededBy?`<p class="pq-d-why alert">Substituído${by?` em ${fmtDate(by.createdAt)} por ${esc(by.fileName)}`:''}, do mesmo período. Não entra em nenhum cálculo; fica só para consulta.</p>`:''}
      <section class="pq-d-card"><div class="pq-sec-t">O que o arquivo trouxe</div><div class="st-facts">${f.facts.map(([v,l])=>`<div><b>${esc(v)}</b><span>${esc(l)}</span></div>`).join('')}</div>${f.uses.length?`<div class="st-uses">${s.supersededBy?'Não entra em nenhum indicador.':`${esc(f.usesText)} ${f.uses.map(u=>`<span class="st-idb">${u}</span>`).join('')}`}</div>`:''}</section>
      <section class="pq-d-card"><div class="st-dtabs" role="tablist">${tabs.map(t=>`<button role="tab" aria-selected="${t===cur}" data-snapshot-tab="${t[0]}" data-snapshot-id="${s.id}">${esc(t[1])}</button>`).join('')}</div>${cur[2]}</section>
      <details class="pq-d-card pq-tech"><summary>Detalhes técnicos</summary><dl class="st-kv"><dt>Assinatura SHA-256</dt><dd class="mono st-break">${esc(s.hash||'—')}</dd><dt>Perfil</dt><dd class="mono">${esc(s.profile)}</dd><dt>Situação registrada</dt><dd>${esc(s.status||'—')}</dd><dt>Tamanho</dt><dd>${s.fileSize?`${fmtNum(Math.round(s.fileSize/1024))} KB`:'—'}</dd><dt>Leitor</dt><dd>versão ${esc(s.parserVersion||'—')}</dd></dl></details>
      <div class="st-del-row"><button class="btn small st-danger" data-delete-snapshot="${s.id}">${icon('trash')}Excluir este arquivo…</button></div>
    </div></div>`);
  document.getElementById('drawer').classList.add('pq-drawer-host');
}



/* ---------- Modais, gavetas e conferência ---------- */

function openModal(html,{wide=false,closable=true}={}){const b=document.getElementById('modalBackdrop'),m=document.getElementById('modal');m.className=`modal${wide?' wide':''}`;m.innerHTML=html;if(closable&&!m.querySelector('[data-close-modal]')){const head=m.querySelector('.modal-head');if(head)head.insertAdjacentHTML('beforeend',`<button class="close-btn" data-close-modal aria-label="Fechar">${icon('close')}</button>`)}b.classList.add('open');b.setAttribute('aria-hidden','false');hydrateIcons(m)}
function closeModal(){localSave.pendingClearAfterBackup=false;const b=document.getElementById('modalBackdrop');b.classList.remove('open');b.setAttribute('aria-hidden','true');document.getElementById('modal').innerHTML=''}
function openDrawer(html,opts={}){const b=document.getElementById('drawerBackdrop'),d=document.getElementById('drawer');d.innerHTML=html;d.classList.remove('pq-drawer-host');d.classList.toggle('wide',!!opts.wide);b.classList.add('open');b.setAttribute('aria-hidden','false');hydrateIcons(d)}
function closeDrawer(){pregDrawer={id:null,tab:'acomp',edit:false,sched:false};const b=document.getElementById('drawerBackdrop');b.classList.remove('open');b.setAttribute('aria-hidden','true');document.getElementById('drawer').innerHTML=''}
function toast(message){const t=document.getElementById('toast');t.classList.remove('has-action');t.textContent=message;t.classList.add('show');clearTimeout(toast._t);toast._t=setTimeout(()=>t.classList.remove('show'),3500)}
function showError(error){console.error(error);toast(error?.message||String(error)||'Ocorreu um erro.');}
function importFailureReportText(failures){const ua=navigator.userAgent||'(user agent indisponível)';const parts=failures.map(f=>`Arquivo: ${f.name}\nErro: ${f.message}${f.stack?`\nDetalhe técnico:\n${f.stack}`:''}`);return `Relatório de falha de importação — ${nowISO()}\nNavegador: ${ua}\n\n${parts.join('\n\n')}`}
function showImportFailures(ok,failures){const report=importFailureReportText(failures);openModal(`<div class="modal-head"><div><h2 id="modalTitle">Importação com falha</h2><p>${ok} importação(ões) concluída(s) · ${failures.length} falha(s). Nada foi salvo desses arquivos — reveja e importe de novo.</p></div></div><div class="modal-body"><div class="table-scroll"><table><thead><tr><th>Arquivo</th><th>Motivo</th></tr></thead><tbody>${failures.map(f=>`<tr><td>${esc(f.name)}</td><td>${esc(f.message)}</td></tr>`).join('')}</tbody></table></div><div class="notice warn" style="margin-top:12px"><strong>Se o erro persistir ou parecer estranho:</strong> copie o relatório técnico abaixo (botão "Copiar detalhes") e envie — ele já inclui o navegador e o detalhe técnico do erro, sem precisar abrir o console.</div><textarea id="importFailureReport" readonly style="width:100%;min-height:120px;margin-top:8px;font-family:monospace;font-size:11px;white-space:pre-wrap">${esc(report)}</textarea></div><div class="modal-foot"><button class="btn" id="copyImportFailureReport">${icon('file')}Copiar detalhes</button><button class="btn primary" data-close-modal>Entendi</button></div>`);const copyBtn=document.getElementById('copyImportFailureReport');copyBtn.onclick=async()=>{const area=document.getElementById('importFailureReport');try{await navigator.clipboard.writeText(report);toast('Detalhes copiados. Já pode colar e enviar.')}catch{area.focus();area.select();try{document.execCommand('copy');toast('Detalhes copiados. Já pode colar e enviar.')}catch{toast('Não deu para copiar automaticamente — selecione o texto acima e copie manualmente.')}}}}
function showLoading(title,detail=''){document.getElementById('loadingTitle').textContent=title;document.getElementById('loadingDetail').textContent=detail;document.getElementById('loading').classList.remove('hidden')}
function setLoading(title,detail=''){document.getElementById('loadingTitle').textContent=title;document.getElementById('loadingDetail').textContent=detail}
function hideLoading(){document.getElementById('loading').classList.add('hidden')}

function procedureRolesFor(id){return ({M1:['first'],M2:['first','concluded'],M3:[],M4:['preventive','b5den'],M5:['art','restorative'],B1:['first'],B2:['first','concluded'],B3:['b3num','b3den'],B4:[],B5:['preventive','b5den'],B6:['art','restorative']})[id]||[]}
function openComposition(scope,id,mk){
  const comp=scope==='municipal'?municipalComponents(id,mk):federalComponents(id,mk),rule=scope==='municipal'?RULESETS.municipal.indicators[id]:RULESETS.federal.indicators[id],proc=aggregateProcedureMonth(mk),group=aggregateGroupMonth(mk),roles=procedureRolesFor(id);
  // M4 usa denominador amplo por exclusão (todos os procedimentos individuais, exceto primeira consulta/
  // tratamento concluído/nota de evolução em grupo) — inclui itens ainda não identificados, então a lista
  // de composição usa a mesma exclusão em vez de depender só de role tags.
  const isM4=false; // desde a v2.18 o M4 usa a lista da Nota B5 (role b5den), como a B5
  const isGroupNoteRow=p=>/^EVOLUCAO DA ATIVIDADE EM GRUPO/.test(norm(p.descriptionOriginal));
  const relevant=(proc?.procedureCounts||[]).filter(p=>isM4?(!p.roles.includes('first')&&!p.roles.includes('concluded')&&!isGroupNoteRow(p)):(p.roles||[]).some(r=>roles.includes(r))).sort((a,b)=>b.quantityValid-a.quantityValid);
  const procedureTable=relevant.length?`<div class="table-scroll"><table><thead><tr><th>Procedimento</th><th>SIGTAP</th><th>Função no cálculo</th><th class="num">Válida</th><th>Páginas</th></tr></thead><tbody>${relevant.map(p=>{const rolePills=(p.roles||[]).filter(r=>roles.includes(r)).map(r=>pill(r,'neutral')).join(' ');const funcao=rolePills||(isM4?(p.unrecognized?pill('Não identificado · denominador M4','warn'):pill('denominador M4','neutral')):'—');return `<tr><td>${esc(p.descriptionNormalized)}<br><span class="muted">${esc(p.descriptionOriginal)}</span></td><td class="mono">${esc(p.sigtap||'—')}</td><td>${funcao}</td><td class="num">${fmtNum(p.quantityValid,2)}</td><td>${(p.pages||[]).join(', ')||'—'}</td></tr>`}).join('')}</tbody></table></div>`:'<div class="notice warn"><strong>Sem composição por procedimento.</strong> Este indicador depende de atividade coletiva, denominador manual ou fonte ainda não importada.</div>';
  const sources=(comp.snapshots||[]).map(s=>`<button class="btn small" data-open-snapshot="${s.id}">${icon('file')}${esc(s.fileName)}</button>`).join('');
  openDrawer(`<div class="drawer-head"><div><h2>${esc(id)} · ${esc(rule.name)}</h2><p>${scope==='municipal'?'Regra municipal':'Nota metodológica federal'} · ${fmtMonth(mk,true)}</p></div><button class="close-btn" data-close-drawer>${icon('close')}</button></div><div class="drawer-section"><h3>Resultado escolhido</h3><div class="facts"><div class="fact"><span>Resultado</span><strong>${fmtPct(comp.result)}</strong></div><div class="fact"><span>Classificação / nota</span><strong>${esc(comp.classification|| (comp.score!=null?`${fmtNum(comp.score,1)} pontos`:'—'))}</strong></div><div class="fact"><span>Numerador</span><strong>${fmtNum(comp.numerator,2)}</strong></div><div class="fact"><span>Denominador</span><strong>${fmtNum(comp.denominator,2)}</strong></div><div class="fact"><span>Fonte</span><strong>${esc(comp.source)}</strong></div><div class="fact"><span>Competência</span><strong>${fmtMonth(mk,true)}</strong></div></div></div><div class="drawer-section"><h3>Fórmula cadastrada</h3><div class="formula">${esc(rule.formula)}</div><div class="notice warn" style="margin-top:9px"><strong>Hipótese/limitação:</strong> ${esc(comp.hypothesis||comp.missing||'Sem observação adicional.')}</div></div><div class="drawer-section"><h3>Procedimentos que compõem a prévia</h3>${procedureTable}</div>${group&&['M3','B4'].includes(id)?`<div class="drawer-section"><h3>Atividades coletivas</h3><div class="facts"><div class="fact"><span>Presentes em escovação</span><strong>${fmtNum(group.supervisedBrushingPresent)}</strong></div><div class="fact"><span>Atividades elegíveis</span><strong>${fmtNum(group.eligibleActivities)}</strong></div></div>${group.brushingEvents?.length?`<div class="table-scroll" style="margin-top:10px"><table><thead><tr><th>Data</th><th>Assunto</th><th class="num">Presentes</th></tr></thead><tbody>${group.brushingEvents.map(ev=>`<tr><td>${esc(ev.date)}</td><td>Escovação Supervisionada</td><td class="num">${fmtNum(ev.present)}</td></tr>`).join('')}</tbody></table></div>`:'<div class="notice warn" style="margin-top:10px">Nenhuma atividade de escovação supervisionada encontrada nesta competência.</div>'}</div>`:''}<div class="drawer-section"><h3>Proveniência</h3><div class="drawer-actions">${sources||'<span class="muted">Nenhum snapshot aplicável.</span>'}</div></div>`);
}

function sensitiveColumn(h){return /NOME|CADSUS|PRONTUARIO|TELEFONE|LOGRADOURO|ENDERECO|NUMERO|COMPLEMENTO|BAIRRO/.test(norm(h))}
function rawSampleHTML(s){const raw=sessionRaw.get(s.id);if(!raw)return '<div class="notice warn"><strong>Amostra não disponível nesta sessão.</strong> O backup não guarda PDF/CSV original. Reimporte o arquivo para rever os trechos brutos.</div>';
  if(raw.type==='procedure')return `<div class="table-scroll"><table><thead><tr><th>Página/linha</th><th>Paciente mascarado</th><th>Data</th><th>Profissional</th><th>Procedimento exatamente extraído</th><th>Unidade</th><th>Qtd.</th></tr></thead><tbody>${raw.rows.slice(0,120).map(r=>`<tr><td>${esc(r.sourceRef||'—')}</td><td>${esc(r.patientMasked)}</td><td>${esc(r.date)}</td><td>${esc(r.professional)}</td><td>${esc(r.procedure)}</td><td>${esc(r.unitOrigin)}</td><td class="num">${fmtNum(r.quantity,2)}</td></tr>`).join('')}</tbody></table></div>`;
  if(raw.type==='group')return `<div class="table-scroll"><table><thead><tr><th>Página</th><th>Data</th><th>Assunto exatamente extraído</th><th>Presentes</th><th>Status</th></tr></thead><tbody>${raw.rows.slice(0,150).map(r=>`<tr><td>${r.page}</td><td>${esc(r.date)}</td><td>${esc(r.subject)}</td><td>${fmtNum(r.present)}</td><td>${esc(r.status)}</td></tr>`).join('')}</tbody></table></div>`;
  if(raw.type==='group_csv')return `<div class="table-scroll"><table><thead><tr><th>Linha</th><th>Data</th><th>Assunto exatamente extraído</th><th>Participante mascarado</th><th>Idade na data</th><th>Elegível (6–11)</th><th>Atividade</th></tr></thead><tbody>${raw.rows.slice(0,220).map(r=>`<tr><td>${esc(r.sourceRef||'—')}</td><td>${esc(r.date)}</td><td>${esc(r.subject)}</td><td>${esc(r.participantMasked)}</td><td>${r.age==null?'—':fmtNum(r.age)}</td><td>${r.eligible==null?'—':(r.eligible?'Sim':'Não')}</td><td class="mono">${esc(r.activityCode)}</td></tr>`).join('')}</tbody></table></div>`;
  if(raw.headers){return `<div class="table-scroll"><table><thead><tr>${raw.headers.map(h=>`<th>${esc(h||'(vazio)')}</th>`).join('')}</tr></thead><tbody>${raw.rows.slice(0,60).map((r,i)=>{const values=Array.isArray(r)?r:r.values||[];return `<tr>${raw.headers.map((h,j)=>`<td>${esc(sensitiveColumn(h)?(values[j]?'••••••':''):values[j])}</td>`).join('')}</tr>`}).join('')}</tbody></table></div>`}
  return `<pre class="formula">${esc(JSON.stringify(raw.rows?.slice(0,80)||raw,null,2))}</pre>`;
}

function commitDenominator(id,scope,value,start,end,origin,note=''){const record={id:uuid(),indicator:id,scope,value,start,end,unit:state.preferences.unit,origin,note,confirmed:true,updatedAt:nowISO(),ruleVersion:RULE_VERSION};state.denominators.push(record);audit('denominator_confirmed',{indicator:id,scope,value,start,end,origin});return record}
function openDenominatorModal(id,scope,value=''){const mk=state.preferences.month,{year}=parseMonthKey(mk),months=quarterMonths(year,state.preferences.quarter);openModal(`<div class="modal-head"><div><h2 id="modalTitle">Confirmar denominador ${esc(id)}</h2><p>O valor só passa a valer após confirmar origem e vigência.</p></div></div><form id="denomForm"><div class="modal-body"><div class="form-grid"><label class="field"><span class="required">Valor</span><input id="denomValue" inputmode="decimal" value="${esc(value)}" required></label><label class="field"><span class="required">Origem</span><input id="denomOrigin" value="Informado manualmente" required></label><label class="field"><span class="required">Vigência inicial</span><input id="denomStart" type="month" value="${months[0]}" required></label><label class="field"><span class="required">Vigência final</span><input id="denomEnd" type="month" value="${months.at(-1)}" required></label><label class="field full"><span>Nota de conferência</span><textarea id="denomNote" placeholder="Ex.: população confirmada no relatório da unidade em 21/08/2026"></textarea></label></div><div class="notice warn" style="margin-top:12px"><strong>Confirmação explícita:</strong> sugestões de PDF/CSV não substituem registros existentes automaticamente.</div></div><div class="modal-foot"><button type="button" class="btn" data-close-modal>Cancelar</button><button class="btn primary" type="submit">Confirmar e versionar</button></div></form>`,{wide:false});document.getElementById('denomForm').onsubmit=e=>{e.preventDefault();const v=numeric(document.getElementById('denomValue').value),start=document.getElementById('denomStart').value,end=document.getElementById('denomEnd').value;if(!(v>0)||!start||!end||start>end){toast('Revise o valor e a vigência.');return}commitDenominator(id,scope,v,start,end,document.getElementById('denomOrigin').value.trim(),document.getElementById('denomNote').value.trim());closeModal();refreshAll();toast('Denominador confirmado e versionado.')}}

let mpForm={ref:'dum',team:'',bucal:'nao',parto:false,editingId:null};
function openManualPregnant(existingId=null){
  const old=existingId?state.gestantes.manual.find(x=>x.id===existingId):null;
  const teams=[...new Set(mergedEpisodes().map(e=>e.equipe).filter(Boolean))].sort((a,b)=>a.localeCompare(b,'pt-BR'));
  const knownTeam=old?.equipe&&teams.includes(old.equipe);
  mpForm={ref:old&&!old.ultimaMenstruacao&&old.dataProvParto?'dpp':'dum',team:old?.equipe?(knownTeam?old.equipe:'__outra'):'',bucal:old?.dataAtividadeManual?'sim':'nao',parto:!!old?.dataParto,editingId:old?.id||null};
  const today=isoDate(new Date());
  openModal(`<div class="modal-head"><div><h2 id="modalTitle">${old?'Editar cadastro manual':'Adicionar gestante'}</h2><p>Para gestantes que ainda não aparecem no CSV do Metabase. O cadastro entra na lista de trabalho e não muda os números importados.</p></div></div>
  <form id="manualPregForm" novalidate><div class="mp-body"><div class="mp-main">
    <fieldset class="mp-sec"><legend><span>1</span>Quem é</legend>
      <label class="mp-f full"><span>Nome completo <em>obrigatório</em></span><input id="mpName" autocomplete="off" value="${esc(old?.nome||'')}" placeholder="Como está no prontuário"><small class="mp-msg" id="mpNameMsg"></small></label>
      <label class="mp-f"><span>Prontuário (CELK)</span><input id="mpRecord" inputmode="numeric" value="${esc(old?.prontuario||'')}"><small class="mp-msg" id="mpRecordMsg">Sem prontuário, ela recebe um código local temporário.</small></label>
      <label class="mp-f"><span>Nascimento</span><input id="mpBirth" type="date" max="${today}" value="${esc(old?.dataNascimento||'')}"><small class="mp-msg" id="mpAge"></small></label>
      <div class="mp-f full"><span>Equipe <em>obrigatório</em></span><div class="mp-chips">${teams.map(t=>`<button type="button" class="pq-chip" data-mp-team="${esc(t)}">${esc(t)}</button>`).join('')}<button type="button" class="pq-chip" data-mp-team="__outra">${teams.length?'Outra…':'Informar equipe'}</button></div><input id="mpTeamOther" placeholder="Nome da equipe" value="${esc(knownTeam?'':old?.equipe||'')}" hidden><small class="mp-msg" id="mpTeamMsg"></small></div>
    </fieldset>
    <fieldset class="mp-sec"><legend><span>2</span>Gestação</legend>
      <div class="mp-f full"><span>Qual data você tem? <em>obrigatório</em></span><div class="pq-seg" role="radiogroup"><button type="button" role="radio" data-mp-ref="dum">DUM</button><button type="button" role="radio" data-mp-ref="dpp">DPP</button></div></div>
      <label class="mp-f"><span id="mpRefLbl">Data da última menstruação</span><input id="mpRefDate" type="date" value="${esc(mpForm.ref==='dpp'?old?.dataProvParto||'':old?.ultimaMenstruacao||'')}"><small class="mp-msg" id="mpRefMsg"></small></label>
      <div class="mp-f"><span id="mpCalcLbl">DPP calculada</span><b class="mp-calc" id="mpCalc">—</b></div>
      <div class="mp-ig full" id="mpIg" hidden></div>
      <label class="mp-check full"><input type="checkbox" id="mpPartoChk" ${mpForm.parto?'checked':''}> O parto já aconteceu</label>
      <label class="mp-f" id="mpPartoWrap" hidden><span>Data do parto</span><input id="mpParto" type="date" max="${today}" value="${esc(old?.dataParto||'')}"></label>
    </fieldset>
    <fieldset class="mp-sec"><legend><span>3</span>Contato</legend>
      <label class="mp-f"><span>Telefone / WhatsApp</span><input id="mpPhone" inputmode="tel" value="${esc(old?.telefone||'')}" placeholder="(48) 99999-9999"><small class="mp-msg" id="mpPhoneMsg"></small></label>
      <label class="mp-f"><span>Endereço</span><input id="mpAddr" value="${esc(old?.endereco||'')}" placeholder="Rua, número, bairro"></label>
    </fieldset>
    <fieldset class="mp-sec"><legend><span>4</span>Saúde bucal</legend>
      <div class="mp-f full"><span>Ela já teve consulta odontológica nesta gestação?</span><div class="pq-seg" role="radiogroup"><button type="button" role="radio" data-mp-bucal="nao">Ainda não</button><button type="button" role="radio" data-mp-bucal="sim">Sim, já foi atendida</button></div></div>
      <div class="mp-bucal full" id="mpBucalSim" hidden>
        <label class="mp-f"><span>Data do atendimento <em>obrigatório</em></span><input id="mpActivity" type="date" max="${today}" value="${esc(old?.dataAtividadeManual||'')}"><small class="mp-msg" id="mpActivityMsg"></small></label>
        <label class="mp-f full"><span>Observação odontológica <em>obrigatório</em></span><textarea id="mpNote" rows="2" placeholder="Ex.: consulta inicial, orientação de higiene, raspagem">${esc(old?.observacao||'')}</textarea><small class="mp-msg" id="mpNoteMsg"></small></label>
      </div>
      ${old?'':'<label class="mp-f full"><span>Nota para o acompanhamento (opcional)</span><textarea id="mpFollowNote" rows="2" placeholder="Ex.: encaminhada pela enfermagem no pré-natal"></textarea></label>'}
    </fieldset>
  </div>
  <aside class="mp-side"><div class="pq-sec-t">Como vai aparecer na lista</div><div id="mpPreview"></div><div id="mpDup"></div></aside></div>
  <div class="modal-foot"><button type="button" class="btn" data-close-modal>Cancelar</button><span class="mp-spacer"></span>${old?'':'<button type="submit" class="btn" data-mp-again="1">Salvar e adicionar outra</button>'}<button type="submit" class="btn primary">${old?'Salvar alterações':'Salvar gestante'}</button></div></form>`,{wide:true});
  document.getElementById('modal').classList.add('mp-modal');
  const form=document.getElementById('manualPregForm');
  form.addEventListener('input',ev=>{if(ev.target.id==='mpName')ev.target.dataset.auto='';if(ev.target.id==='mpPartoChk')mpForm.parto=ev.target.checked;mpUpdate()});
  form.addEventListener('change',ev=>{if(ev.target.id==='mpPartoChk'){mpForm.parto=ev.target.checked;mpUpdate()}});
  form.addEventListener('click',ev=>{const b=ev.target.closest('button');if(!b)return;
    if(b.dataset.mpTeam!=null){mpForm.team=b.dataset.mpTeam;mpUpdate();if(mpForm.team==='__outra')document.getElementById('mpTeamOther').focus();return}
    if(b.dataset.mpRef){if(mpForm.ref!==b.dataset.mpRef){mpForm.ref=b.dataset.mpRef;document.getElementById('mpRefDate').value=''}mpUpdate();return}
    if(b.dataset.mpBucal){mpForm.bucal=b.dataset.mpBucal;mpUpdate();return}
    if(b.dataset.mpDup){closeModal();openEpisode(b.dataset.mpDup);return}});
  form.onsubmit=ev=>{ev.preventDefault();saveManualPregnant(ev.submitter?.dataset.mpAgain==='1')};
  mpUpdate();document.getElementById('mpName').focus();
}
function mpValue(id){const el=document.getElementById(id);return el?el.value.trim():''}
function mpRead(){
  const ref=mpValue('mpRefDate'),refDate=parseDate(ref);let dum=null,dpp=null;
  if(refDate){if(mpForm.ref==='dum'){dum=refDate;dpp=new Date(+refDate+280*DAY_MS)}else{dpp=refDate;dum=new Date(+refDate-280*DAY_MS)}}
  const team=mpForm.team==='__outra'?mpValue('mpTeamOther'):mpForm.team,tel=mpValue('mpPhone');
  return {nome:mpValue('mpName'),prontuario:sanitizeProntuario(mpValue('mpRecord')),dataNascimento:mpValue('mpBirth'),equipe:team,ref,dum,dpp,dataParto:mpForm.parto?mpValue('mpParto'):'',telefone:tel,phoneNormalized:normalizePhone(tel),endereco:mpValue('mpAddr'),dataAtividadeManual:mpForm.bucal==='sim'?mpValue('mpActivity'):'',observacao:mpForm.bucal==='sim'?mpValue('mpNote'):''};
}
function mpUpdate(){
  const known=patientNameFor(mpValue('mpRecord')),nameEl=document.getElementById('mpName');if(known&&(!nameEl.value.trim()||nameEl.dataset.auto==='1')&&!mpForm.editingId){nameEl.value=known;nameEl.dataset.auto='1'}
  const d=mpRead(),set=(id,text,cls='')=>{const el=document.getElementById(id);if(el){el.textContent=text;el.className=`mp-msg${cls?' '+cls:''}`}};
  document.querySelectorAll('[data-mp-team]').forEach(b=>b.classList.toggle('on',b.dataset.mpTeam===mpForm.team));
  document.getElementById('mpTeamOther').hidden=mpForm.team!=='__outra';
  document.querySelectorAll('[data-mp-ref]').forEach(b=>b.setAttribute('aria-checked',String(b.dataset.mpRef===mpForm.ref)));
  document.querySelectorAll('[data-mp-bucal]').forEach(b=>b.setAttribute('aria-checked',String(b.dataset.mpBucal===mpForm.bucal)));
  document.getElementById('mpRefLbl').textContent=mpForm.ref==='dum'?'Data da última menstruação':'Data provável do parto';
  document.getElementById('mpRefDate').max=mpForm.ref==='dum'?isoDate(new Date()):'';
  document.getElementById('mpCalcLbl').textContent=mpForm.ref==='dum'?'DPP calculada (DUM + 280 dias)':'DUM estimada (DPP − 280 dias)';
  document.getElementById('mpCalc').textContent=d.dum?fmtDate(mpForm.ref==='dum'?d.dpp:d.dum):'—';
  document.getElementById('mpPartoWrap').hidden=!mpForm.parto;
  document.getElementById('mpBucalSim').hidden=mpForm.bucal!=='sim';
  const birth=parseDate(d.dataNascimento);if(birth){const a=ageAt({dataNascimento:d.dataNascimento});set('mpAge',a<20?`${a} anos · adolescente`:`${a} anos`,a<20?'info':'')}else set('mpAge','');
  set('mpRecordMsg',known?`✓ Nome encontrado na produção do CELK: ${known}`:d.prontuario?'Prontuário ainda não visto nos relatórios de produção importados.':'Sem prontuário, ela recebe um código local temporário.',known?'ok':'');
  if(!d.telefone)set('mpPhoneMsg','Sem telefone, a próxima ação sugerida é a busca ativa.');else if(d.phoneNormalized)set('mpPhoneMsg','✓ Número válido para WhatsApp','ok');else set('mpPhoneMsg','Confira o número: DDD + 8 ou 9 dígitos.','warn');
  const ig=document.getElementById('mpIg'),end=parseDate(d.dataParto)||new Date(),w=d.dum?Math.floor((end-d.dum)/(7*DAY_MS)):null;
  if(w==null)ig.hidden=true;else if(w<0||w>45){ig.hidden=false;ig.innerHTML=`<p class="mp-msg warn">Com essa data a gestação teria ${w} semanas. Confira a ${mpForm.ref==='dum'?'DUM':'DPP'}.</p>`}
  else{const t3=w>=28&&!d.dataParto;ig.hidden=false;ig.innerHTML=`<div class="pq-ig-top"><b>${w} semanas · ${trimesterOf(w)} trimestre</b><span>${d.dataParto?`parto em ${fmtDate(d.dataParto)}`:'hoje'}</span></div><div class="pq-ruler${t3&&mpForm.bucal==='nao'?' t3':''}"><i style="width:${Math.min(100,100*w/40)}%"></i></div>${t3&&mpForm.bucal==='nao'?'<p class="mp-msg alert">3º trimestre sem atendimento: ela vai para o topo da fila.</p>':''}`}
  // prévia do card
  const fake={id:'__mp_preview__',nome:d.nome||'Nome da gestante',equipe:d.equipe||'—',prontuario:d.prontuario||'código local',dataNascimento:d.dataNascimento,ultimaMenstruacao:d.dum?isoDate(d.dum):'',dataProvParto:d.dpp?isoDate(d.dpp):'',dataParto:d.dataParto,telefone:d.telefone,phoneNormalized:d.phoneNormalized,origin:'manual',status2i:mpForm.bucal==='sim'?'atende':'sem_metabase'};
  const bucket=pregBucket(fake),n=pregNextAction(fake);
  document.getElementById('mpPreview').innerHTML=`<div class="mp-card tone-${pregTone(fake)}"><div><b>${esc(fake.nome)}</b><small>Equipe ${esc(fake.equipe)}${birth?` · ${ageAt(fake)} anos`:''} · cadastro manual</small></div><div class="pq-tags">${pregStagePill(fake)}${pregTags(fake)}</div><div class="pq-ig-top"><b>${w!=null&&w>=0&&w<=45?`${w} sem · ${trimesterOf(w)} tri`:'IG a calcular'}</b><span>${d.dpp?`DPP ${fmtDate(d.dpp).slice(0,5)}`:''}</span></div><div class="mp-next"><span class="pq-next ${n.cls||''}">${n.icon?icon(n.icon):''}${n.label}</span><small>${esc(n.why)}</small></div></div><p class="mp-dest">Entra na aba <b>${bucket==='atendida'?'Atendidas':bucket==='encerrada'?'Encerradas':'A contatar'}</b>${bucket==='atendida'?' e já conta para a meta':''}.</p>`;
  // duplicidade: prontuário igual bloqueia a confusão; nome parecido só alerta
  const others=mergedEpisodes().filter(e=>e.id!==mpForm.editingId&&e.manualId!==mpForm.editingId),dups=[];
  if(d.prontuario.length>=6){const m=others.find(e=>sanitizeProntuario(e.prontuario)===d.prontuario);if(m)dups.push(`<div class="pq-alert red"><strong>Este prontuário já está na lista:</strong> ${esc(m.nome||'—')} (Equipe ${esc(m.equipe||'—')}). <button type="button" data-mp-dup="${esc(m.id)}">Abrir o perfil dela</button></div>`)}
  if(!dups.length&&d.nome.split(/\s+/).length>=2){const parts=norm(d.nome).split(/\s+/),first=parts[0],last=parts.at(-1);const m=others.find(e=>{const n=norm(e.nome).split(/\s+/);return n[0]===first&&n.at(-1)===last});if(m)dups.push(`<div class="pq-alert amber"><strong>Nome parecido na lista:</strong> ${esc(m.nome)}, Equipe ${esc(m.equipe||'—')}${pregDpp(m)?`, DPP ${fmtDate(pregDpp(m))}`:''}. Se for a mesma pessoa, <button type="button" data-mp-dup="${esc(m.id)}">abra o perfil</button> em vez de cadastrar de novo.</div>`)}
  document.getElementById('mpDup').innerHTML=dups.join('');
}
function saveManualPregnant(again=false){
  const d=mpRead(),errs=[],set=(id,msg)=>{const el=document.getElementById(id);if(el){el.textContent=msg;el.className=`mp-msg${msg?' err':''}`}};
  set('mpNameMsg',d.nome?'':'Informe o nome.');if(!d.nome)errs.push('mpName');
  set('mpTeamMsg',d.equipe?'':'Escolha a equipe.');if(!d.equipe)errs.push(mpForm.team==='__outra'?'mpTeamOther':'mpTeamMsg');
  const w=d.dum?Math.floor(((parseDate(d.dataParto)||new Date())-d.dum)/(7*DAY_MS)):null;
  if(!d.dum&&!d.dataParto){set('mpRefMsg','Informe a DUM ou a DPP para calcular a idade gestacional.');errs.push('mpRefDate')}else if(w!=null&&(w<0||w>45)){set('mpRefMsg','Data fora do intervalo de uma gestação.');errs.push('mpRefDate')}else set('mpRefMsg','');
  if(mpForm.bucal==='sim'){set('mpActivityMsg',d.dataAtividadeManual?'':'Informe a data do atendimento.');set('mpNoteMsg',d.observacao?'':'Descreva o atendimento.');if(!d.dataAtividadeManual)errs.push('mpActivity');if(!d.observacao)errs.push('mpNote')}
  if(errs.length){const el=document.getElementById(errs[0]);el?.scrollIntoView({block:'center',behavior:'smooth'});if(el&&el.focus&&el.tagName!=='SMALL')el.focus();return}
  const old=mpForm.editingId?state.gestantes.manual.find(x=>x.id===mpForm.editingId):null;
  // guarda só a data informada (DUM ou DPP): a mesclagem com o CSV compara exatamente essa data
  const rec={id:old?.id||uuid(),localTemporary:!d.prontuario,nome:d.nome,prontuario:d.prontuario,equipe:d.equipe,telefone:d.telefone,phoneNormalized:d.phoneNormalized,endereco:d.endereco,dataNascimento:d.dataNascimento,dataAtividadeManual:d.dataAtividadeManual,ultimaMenstruacao:mpForm.ref==='dum'?d.ref:'',dataProvParto:mpForm.ref==='dpp'?d.ref:'',dataParto:d.dataParto,observacao:d.observacao,origin:'manual',status2i:'sem_metabase',tipoPopulacao:'Manual',createdAt:old?.createdAt||nowISO(),updatedAt:nowISO(),edits:[...(old?.edits||[]),{at:nowISO(),action:old?'editado':'criado'}],archived:false};
  if(old)Object.assign(old,rec);else state.gestantes.manual.push(rec);
  audit(old?'2i_manual_edited':'2i_manual_created',{manualId:rec.id,hasRecord:!!rec.prontuario,attended:mpForm.bucal==='sim'});
  // "Sim, já foi atendida" confirma o atendimento no acompanhamento (é o que faz contar para a meta)
  if(mpForm.bucal==='sim'&&!['ok_manual','atende_confirmado'].includes(followupFor(rec.id).state)){const f=followupFor(rec.id),entry={at:nowISO(),from:f.state,to:'ok_manual',note:`Atendimento em ${fmtDate(d.dataAtividadeManual)} informado no cadastro manual`};state.gestantes.followups[rec.id]={state:'ok_manual',updatedAt:entry.at,history:[...(f.history||[]),entry]}}
  const note=mpValue('mpFollowNote');if(note){const f=followupFor(rec.id);state.gestantes.followups[rec.id]={state:f.state,updatedAt:f.updatedAt,history:[...(f.history||[]),{at:nowISO(),type:'note',text:note}]}}
  migrateMonitoraLinks();queueSave();closeModal();refreshAll();
  const where=mpForm.bucal==='sim'?'Atendidas':pregnancyStage(rec)==='finalizada'?'Encerradas':'A contatar';
  if(again){openManualPregnant();toast(`${firstName(rec)} cadastrada em "${where}". Pode adicionar a próxima.`)}
  else{toast(old?'Cadastro manual atualizado. O CSV importado não muda.':`${firstName(rec)} cadastrada em "${where}". O CSV importado não muda.`);openEpisode(rec.id)}
}

function pregAddress(e){return e.enderecoOverride||[e.tipoLogradouro,e.logradouro,e.numero,e.complemento,e.bairro].filter(Boolean).join(', ')||e.endereco||''}
function openEpisode(id,tab,opts={}){
  const e=mergedEpisodes().find(x=>x.id===id||x.manualId===id);if(!e)return;
  if(pregDrawer.id!==e.id)pregDrawer={id:e.id,tab:'acomp',edit:false,sched:false};
  if(tab)pregDrawer.tab=tab==='editar'||tab==='dados'?'dados':'acomp';
  if(opts.sched){pregDrawer.sched=true;pregDrawer.tab='acomp'}
  const f=followupFor(e.id),match=e.origin==='manual'?findManualMatch(e,merged2IEpisodes()):null,weeks=gestationalWeeks(e),address=pregAddress(e),excl=state.gestantes.excluded[e.id],finalized=pregnancyStage(e)==='finalizada',counts=followupCounts(f.history);
  const b=pregBucket(e),n=pregNextAction(e),dum=pregDum(e),dpp=pregDpp(e),left=weeksToDpp(e),t3=isPriority2I(e);
  const q=pregQueue(),idx=q.findIndex(x=>x.id===e.id);
  const order=['a_contatar','em_contato','agendada','atendida'],labels=['A contatar','Em contato','Agendada','Atendida'],cur=order.indexOf(b);
  const pos=d=>{const x=parseDate(d);return dum&&x?clamp(100*((x-dum)/(7*DAY_MS))/40):null};
  const evs=(f.history||[]).filter(h=>h.type!=='note'&&h.to!=='nao_contatada').map(h=>({x:pos(h.at),c:followupColor(h.to).text,t:`${followupLabel(h.to)} · ${fmtDate(h.at)}`})).filter(v=>v.x!=null);
  const prodVisits=productionVisitsFor(e);for(const v of prodVisits)if(pos(v.date)!=null)evs.push({x:pos(v.date),c:'#7551e9',t:`Atendimento odontológico (produção CELK) · ${fmtDate(v.date)} · ${v.procs.join(', ')}`});
  if(f.state==='agendada'&&f.agendaAt&&pos(f.agendaAt)!=null)evs.push({x:pos(f.agendaAt),c:followupColor('agendada').text,t:`Consulta em ${fmtDate(f.agendaAt)}`,future:true});
  const nowX=dum?pos(finalized?e.dataParto:new Date()):null;
  const chips=[counts.whatsapp?`<span class="count-chip wa">${icon('message')}WhatsApp · ${counts.whatsapp}x</span>`:'',counts.buscaAtiva?`<span class="count-chip ba">${icon('search')}Busca ativa · ${counts.buscaAtiva}x</span>`:'',counts.agendada?`<span class="count-chip ag">${icon('clock')}Agendada · ${counts.agendada}x</span>`:'',counts.notes?`<span class="count-chip note">${icon('file')}Notas · ${counts.notes}</span>`:''].filter(Boolean).join('');
  const inWin=new Set(prodVisits.map(v=>v.date)),hasDates=!!(pregDum(e)&&pregDpp(e)),prodItems=productionVisitsAllFor(e).map(v=>({at:v.date,prod:v,counts:inWin.has(v.date)}));const timelineHTML=[...(f.history||[]),...prodItems].sort((a,b)=>String(a.at).localeCompare(String(b.at))).reverse().map(h=>h.prod?(h.counts?`<li><i style="background:#7551e9"></i><div><b style="color:#6540db">Atendimento odontológico na produção do CELK</b><small>${fmtDate(h.at)} · ${agoLabel(h.at)} · ${esc(h.prod.procs.join(', '))} · conta para a meta</small></div></li>`:`<li class="pq-tl-out"><i style="background:#b9bdd0"></i><div><b style="color:#5c6080">Atendimento odontológico na produção do CELK</b><small>${fmtDate(h.at)} · ${agoLabel(h.at)} · ${esc(h.prod.procs.join(', '))} · ${hasDates?'fora do período da gestação (DUM a DPP), não conta':'sem DUM/DPP, não conta'}</small></div></li>`):h.type==='note'?`<li><i style="background:#e7a23b"></i><div><b class="is-note">${esc(h.text)}</b><small>Nota · ${fmtDateTime(h.at)} · ${agoLabel(h.at)}</small></div></li>`:`<li><i style="background:${followupColor(h.to).text}"></i><div><b style="color:${followupColor(h.to).text}">${esc(followupLabel(h.to))}</b><small>${fmtDateTime(h.at)} · ${agoLabel(h.at)}${h.note?` · ${esc(h.note)}`:''}</small></div></li>`).join('');
  const alerts=`${needsData(e)?`<div class="pq-alert blue"><strong>Veio do Monitora APS, que é anonimizado.</strong> Complete nome, telefone e DUM ou DPP para poder contatar. Os dados ficam guardados pelo número da Usuária e são reaproveitados nas próximas importações. ${pregDrawer.tab==='dados'&&pregDrawer.edit?'':`<button data-preg-act="dados|${esc(e.id)}">Completar dados</button>`}</div>`:''}${excl?`<div class="pq-alert red"><strong>Removida da lista de trabalho</strong> em ${fmtDateTime(excl.at)}${excl.reason?` · ${esc(excl.reason)}`:''}. Os dados continuam guardados. <button data-restore-episode="${esc(e.id)}">Restaurar na lista</button></div>`:''}${match?`<div class="pq-alert amber"><strong>Pode ser a mesma gestante do CSV.</strong> Prontuário ${esc(match.prontuario)} e data ${fmtDate(episodeAnchor(match))} iguais a um registro do Metabase. O nome sozinho nunca é usado para mesclar. <button data-merge-manual="${esc(e.id)}|${esc(match.id)}">Confirmar mesclagem</button></div>`:''}`;
  const today=isoDate(new Date()),inAWeek=isoDate(new Date(Date.now()+7*DAY_MS));
  const acomp=`<section class="pq-d-next">
      <div class="pq-d-next-top"><div><div class="pq-sec-t">Próxima ação</div><p class="pq-d-why${n.alert?' alert':''}">${esc(n.why)}</p></div>${n.kind!=='open'?(n.kind==='agendar'?`<button class="pq-next" data-preg-sched="${esc(e.id)}">${icon('clock')}Agendar consulta</button>`:pregNextBtn(e,n)):''}</div>
      ${b!=='encerrada'?`<ol class="pq-steps" aria-label="Etapa do acompanhamento">${labels.map((l,j)=>`<li class="${j<cur?'done':''}${j===cur?' cur':''}"><i></i>${l}</li>`).join('')}</ol>`:''}
      <div class="pq-d-more"><span>Registrar:</span><button class="pq-qa" data-followup="${esc(e.id)}|whatsapp_enviado" ${e.phoneNormalized?'':'disabled'}>${icon('message')}WhatsApp enviado</button><button class="pq-qa" data-followup="${esc(e.id)}|busca_ativa_solicitada">${icon('search')}Busca ativa</button><button class="pq-qa" data-preg-sched="${esc(e.id)}">${icon('clock')}Agendar</button><button class="pq-qa" data-followup="${esc(e.id)}|ok_manual">${icon('check')}Atendida</button></div>
      <div class="pq-sched"${pregDrawer.sched?'':' hidden'}><label><span>Data da consulta</span><input type="date" id="pqSchedDate" min="${today}" value="${esc(isoDate(f.agendaAt)||inAWeek)}"></label><label><span>Horário (opcional)</span><input type="time" id="pqSchedTime" value="${esc(String(f.agendaAt||'').slice(11,16))}"></label><button class="pq-next" data-preg-sched-save="${esc(e.id)}">Salvar agendamento</button></div>
    </section>
    <section class="pq-d-card"><div class="pq-d-card-h"><div class="pq-sec-t">Contato</div>${e.phoneNormalized?'':'<span class="pq-tag amber">Sem telefone válido</span>'}</div>
      <div class="pq-d-phone drawer-contact-line"><div><b>${esc(e.telefone||'Telefone não informado')}</b><small>${esc(address||'Endereço não informado')}</small></div><div class="pq-d-phone-a">${e.phoneNormalized?`<button class="pq-next wa" data-open-whatsapp="${esc(e.id)}">${icon('message')}Abrir WhatsApp</button><button class="pq-icon" data-copy-text="${esc(e.telefone||'')}" title="Copiar número" aria-label="Copiar número">${icon('copy')}</button>`:`<button class="pq-qa" data-preg-dtab="dados">Corrigir telefone</button>`}</div></div>
    </section>
    <section class="pq-d-card"><div class="pq-d-card-h"><div class="pq-sec-t">Gestação</div><button class="pq-link" data-preg-parto="${esc(e.id)}">${finalized?'Reabrir gestação':'Registrar parto hoje'}</button></div>
      <div class="pq-d-facts"><div><span>IG</span><b>${weeks==null?(e.monitoraPeriodo?`${esc(e.monitoraPeriodo)} (Monitora)`:'—'):`${weeks} sem · ${trimesterOf(weeks)} tri`}</b></div><div><span>DUM</span><b>${fmtDate(e.ultimaMenstruacao)}</b></div><div><span>DPP</span><b>${dpp?fmtDate(dpp):'—'}</b></div><div><span>${finalized?'Parto':'Faltam'}</span><b${t3?' class="alert"':''}>${finalized?fmtDate(e.dataParto):left==null?'—':left>0?`${left} sem.`:'DPP vencida'}</b></div></div>
      ${dum?`<div class="pq-track" aria-label="Gestação: ${weeks??'—'} de 40 semanas"><div class="pq-bands"><i><span>1º tri</span></i><i><span>2º tri</span></i><i><span>3º tri</span></i></div><div class="pq-fill${t3?' t3':''}" style="width:${nowX??0}%"></div>${evs.map(v=>`<span class="pq-ev${v.future?' future':''}" title="${esc(v.t)}" style="left:${v.x}%;--c:${v.c}"></span>`).join('')}<span class="pq-now" style="left:${nowX??0}%"><span>${finalized?'parto':'hoje'}</span></span></div>`:''}
    </section>
    <section class="pq-d-card"><div class="pq-d-card-h"><div class="pq-sec-t">Histórico e notas</div><span class="pq-d-count">${(f.history||[]).length+prodVisits.length} registro(s)</span></div>
      ${chips?`<div class="count-chips">${chips}</div>`:''}
      <div class="pq-d-note"><textarea id="followupNoteInput" rows="2" placeholder="Escreva uma nota sobre o contato"></textarea><div class="pq-qn">${PREG_QUICK_NOTES.map(t=>`<button class="pq-chip" data-preg-qn="${esc(t)}">${esc(t)}</button>`).join('')}</div><div class="pq-d-note-a"><button type="button" class="btn small primary" data-add-followup-note="${esc(e.id)}">Salvar nota</button></div></div>
      ${timelineHTML?`<ol class="pq-hist">${timelineHTML}</ol>`:'<p class="pq-empty-s">Nenhum contato registrado ainda.</p>'}
    </section>`;
  const edit=pregDrawer.edit&&e.origin!=='manual';
  const field=(id,label,value,type='text',full=false,display)=>`<label class="pq-f${full?' full':''}"><span>${label}</span>${edit?(type==='textarea'?`<textarea id="${id}">${esc(value||'')}</textarea>`:`<input id="${id}" type="${type}" value="${esc(value||'')}">`):`<b>${esc(display??(value||'—'))}</b>`}</label>`;
  const dados=`<section class="pq-d-card"><div class="pq-d-card-h"><div class="pq-sec-t">Cadastro</div>${e.origin==='manual'?`<button class="pq-link" data-edit-manual="${esc(e.id)}">Editar cadastro</button>`:edit?'':'<button class="pq-link" data-preg-edit>Editar</button>'}</div>
      ${edit?`<p class="pq-d-hint">${e.origin==='monitora'?'Os dados ficam salvos só nesta ferramenta, guardados pelo número da Usuária do Monitora APS.':'As correções ficam salvas só nesta ferramenta. O CSV original do Metabase não é alterado.'}</p>`:e.origin==='manual'?'<p class="pq-d-hint">Cadastro manual: as alterações mudam o próprio cadastro.</p>':''}
      <div class="pq-form">${field('efNome','Nome',e.nome,'text',true)}${field('efProntuario','Prontuário (CELK)',e.prontuario)}${field('efEquipe','Equipe',e.equipe)}${field('efNascimento','Nascimento',isoDate(e.dataNascimento),'date',false,fmtDate(e.dataNascimento))}${field('efTelefone','Telefone',e.telefone)}${field('efEndereco','Endereço',address,'text',true)}${field('efDum','DUM',isoDate(e.ultimaMenstruacao),'date',false,fmtDate(e.ultimaMenstruacao))}${field('efDpp','DPP',isoDate(e.dataProvParto),'date',false,fmtDate(e.dataProvParto))}${field('efParto','Data do parto',isoDate(e.dataParto),'date',false,fmtDate(e.dataParto))}${field('efNota','Nota local',e.notaLocal,'textarea',true)}</div>
      ${edit?`<div class="pq-d-edit-a"><button type="button" class="btn" data-preg-edit>Cancelar</button><button type="button" class="btn primary" data-save-all-fields="${esc(e.id)}">Salvar correções</button></div>`:''}
    </section>
    <details class="pq-d-card pq-tech"><summary>Detalhes técnicos</summary><div class="facts"><div class="fact"><span>Origem</span><strong>${esc(e.origin==='manual'?'Cadastro manual':e.origin==='metabase_manual'?'Manual + Metabase':e.origin==='monitora'?'Monitora APS (lista anonimizada)':`CSV do Metabase${e.line?`, linha ${e.line}`:''}`)}</strong></div><div class="fact"><span>Telefone normalizado</span><strong>${esc(e.phoneNormalized||'Inválido ou sem DDD')}</strong></div><div class="fact"><span>Valor original do CSV</span><strong>${esc(e.consultaSaudeBucal||'Não veio do Metabase')}</strong></div><div class="fact"><span>Interpretação 2I</span><strong>${esc(status2ILabel(e.status2i))}</strong></div><div class="fact"><span>Atividade manual</span><strong>${fmtDate(e.dataAtividadeManual)}</strong></div><div class="fact"><span>Observação manual</span><strong>${esc(e.observacao||'—')}</strong></div>${e.nomeDaProducao?'<div class="fact"><span>Nome</span><strong>Preenchido automaticamente pelo relatório de produção do CELK</strong></div>':''}<div class="fact"><span>Produção CELK (Procedimentos Detalhado)</span><strong>${prodVisits.length?`${prodVisits.length} atendimento(s) na gestação: ${prodVisits.map(v=>fmtDate(v.date)).join(', ')}`:pid(e.prontuario)?'Nenhum atendimento com este prontuário na gestação':'Sem prontuário para cruzar'}</strong></div>${e.monitoraUsuaria?`<div class="fact"><span>Monitora APS</span><strong>Usuária ${esc(e.monitoraUsuaria)} · ${esc(e.monitoraPeriodo||'—')} · Cons.Odonto ${esc(e.consOdontoMonitora||'—')} · Equipe ${esc(e.monitoraEquipe||'—')}</strong></div>`:''}<div class="fact"><span>Situação na lista</span><strong>${excl?'Removida (pode ser restaurada)':'Na lista de trabalho'}</strong></div></div></details>`;
  const menu=`<button data-copy-name="${esc(e.id)}">${icon('copy')}Copiar nome</button>${e.prontuario?`<button data-copy-text="${esc(e.prontuario)}">${icon('copy')}Copiar prontuário</button>`:''}<button data-followup="${esc(e.id)}|atende_confirmado">${icon('check')}Marcar como confirmado no Metabase</button><button data-followup="${esc(e.id)}|nao_contatada">${icon('clock')}Reiniciar acompanhamento</button>${e.origin==='manual'?`<button data-archive-manual="${esc(e.id)}">${icon('file')}Arquivar cadastro manual</button>`:''}${excl?`<button data-restore-episode="${esc(e.id)}">${icon('check')}Restaurar na lista</button>`:`<button class="danger" data-exclude-episode="${esc(e.id)}">${icon('trash')}Remover da lista</button>`}`;
  openDrawer(`<div class="pq-drawer tone-${pregTone(e)}">
    <header class="pq-d-h">
      <div class="pq-d-h-top"><div class="pq-d-nav"><button class="pq-icon" data-preg-nav="-1" ${idx<=0?'disabled':''} aria-label="Gestante anterior"><span class="flip">${icon('chevron')}</span></button><span>${idx>=0?`${idx+1} de ${q.length}`:'fora da aba atual'}</span><button class="pq-icon" data-preg-nav="1" ${idx<0||idx>=q.length-1?'disabled':''} aria-label="Próxima gestante">${icon('chevron')}</button></div>
        <div class="pq-menu-wrap"><button class="pq-icon" data-preg-menu aria-label="Mais opções">•••</button><div class="pq-menu" hidden>${menu}</div></div>
        <button class="pq-icon" data-close-drawer aria-label="Fechar">${icon('close')}</button></div>
      <h2>${esc(pregDisplayName(e))}</h2>
      <p class="pq-d-sub">Equipe ${esc(e.equipe||'—')}${ageAt(e)==null?'':` · ${ageAt(e)} anos`} · <span class="mono">${esc(e.prontuario||'ID local temporário')}</span> · ${esc(e.origin==='manual'?'cadastro manual':e.origin==='metabase_manual'?'manual + Metabase':e.origin==='monitora'?'Monitora APS':'Metabase')}${e.monitoraUsuaria&&e.origin!=='monitora'?' + Monitora APS':''}</p>
      <div class="pq-tags">${pregStagePill(e)}${pregTags(e)}</div>
      <div class="pq-d-tabs"><button class="pq-d-tab${pregDrawer.tab==='acomp'?' on':''}" data-preg-dtab="acomp">Acompanhamento</button><button class="pq-d-tab${pregDrawer.tab==='dados'?' on':''}" data-preg-dtab="dados">Dados cadastrais</button></div>
    </header>
    <div class="pq-d-b">${alerts}${pregDrawer.tab==='dados'?dados:acomp}</div>
  </div>`,{wide:false});
  document.getElementById('drawer').classList.add('pq-drawer-host');
}

function exportProcedures(){const p=aggregateProcedureMonth(state.preferences.month);if(!p)return;const rows=[['procedimento_original','procedimento_normalizado','sigtap','quantidade_bruta','quantidade_excluida','quantidade_valida','paginas'],...p.procedureCounts.map(x=>[x.descriptionOriginal,x.descriptionNormalized,x.sigtap,x.quantityRaw,x.quantityRaw-x.quantityValid,x.quantityValid,(x.pages||[]).join('|')])];downloadFile(`procedimentos-${state.preferences.month}.csv`,csvString(rows),'text/csv;charset=utf-8')}
function csvString(rows){return '\ufeff'+rows.map(r=>r.map(v=>`"${String(v??'').replace(/"/g,'""')}"`).join(';')).join('\r\n')}
function export2IModal(){openModal(`<div class="modal-head"><div><h2 id="modalTitle">Exportar lista 2I</h2><p>Escolha o nível de identificação conscientemente.</p></div></div><div class="modal-body"><div class="notice"><strong>Recomendado:</strong> a versão desidentificada mantém equipe, status e datas sem nome, prontuário, telefone ou endereço.</div><div class="notice danger" style="margin-top:9px"><strong>Exportação nominal contém dados pessoais de saúde.</strong> Use somente em ambiente autorizado e mantenha o arquivo protegido.</div></div><div class="modal-foot"><button class="btn" data-export-2i-mode="analytic">Exportar desidentificado</button><button class="btn danger" data-export-2i-mode="nominal">Confirmar exportação nominal</button></div>`)}
function export2I(mode){const rows=applyPregFilters(mergedEpisodes()),nominal=mode==='nominal';const head=nominal?['nome','prontuario','equipe','telefone','dum','dpp','parto','consulta_original','situacao_2i','acompanhamento','origem']:['episodio_hash','equipe','dum','dpp','parto','situacao_2i','acompanhamento','origem'];const data=rows.map(e=>nominal?[e.nome,e.prontuario,e.equipe,e.telefone,e.ultimaMenstruacao,e.dataProvParto,e.dataParto,e.consultaSaudeBucal,status2ILabel(e.status2i),followupLabel(followupFor(e.id).state),e.origin]:[String(e.id).slice(0,16),e.equipe,e.ultimaMenstruacao,e.dataProvParto,e.dataParto,status2ILabel(e.status2i),followupLabel(followupFor(e.id).state),e.origin]);downloadFile(`2i-${nominal?'nominal':'desidentificado'}-${isoDate(new Date())}.csv`,csvString([head,...data]),'text/csv;charset=utf-8');audit('2i_exported',{mode,count:rows.length});closeModal()}

/* ---------- Backup e restauração (único jeito de salvar — nada persiste no navegador) ---------- */

function backupState(type='full'){
  const copy=structuredClone(state);copy.dirty=false;
  for(const snap of copy.snapshots||[]){for(const p of snap.procedureCounts||[])delete p.professionals;for(const month of Object.values(snap.dataByMonth||{}))for(const p of month.procedureCounts||[])delete p.professionals}
  if(type==='analytic'){copy.snapshots=copy.snapshots.filter(s=>s.profile!=='metabase_gestantes_2i'&&s.profile!==MONITORA_PROFILE&&s.profile!==PSE_PROFILE);copy.pse={mine:{},dec:{},overrides:{},followups:{}};for(const snap of copy.snapshots)delete snap.participants;copy.gestantes={manual:[],followups:{},merges:{},excluded:{},overrides:{},puerperioIgnored:{}};copy.patientDirectory={};copy.audit=(copy.audit||[]).filter(a=>!String(a.action).startsWith('2i_'));copy.columnMappings={...copy.columnMappings,consulta2i:{}};for(const snap of copy.snapshots||[])for(const month of Object.values(snap.dataByMonth||{})){delete month.firstPatients;delete month.concludedPatients;delete month.patientVisits;for(const a of month.activityDetails||[])delete a.alteredNames}}
  return copy;
}
async function createBackupEnvelope(type='full'){
  const data={state:backupState(type),rulesets:{municipal:{regra_id:RULESETS.municipal.regra_id,regra_versao:RULESETS.municipal.regra_versao,vigencia:RULESETS.municipal.vigencia},federal:{regra_id:RULESETS.federal.regra_id,regra_versao:RULESETS.federal.regra_versao,vigencia:RULESETS.federal.vigencia}},parserProfiles:state.parserProfiles,columnMappings:type==='full'?state.columnMappings:{consulta2i:{}}};
  return {format:'indicadores-saude-bucal-backup',formatVersion:'1.0',appVersion:APP_VERSION,schemaVersion:SCHEMA_VERSION,type,createdAt:nowISO(),checksum:await sha256(JSON.stringify(data)),data};
}
function has2IData(){return mergedEpisodes().length>0}
function openBackupModal(){const has2i=has2IData(),hasM1=hasM1PatientData(),clearAfter=localSave.pendingClearAfterBackup;openModal(`<div class="modal-head"><div><h2 id="modalTitle">Backup e restauração</h2><p>O backup nunca contém os PDFs/CSVs originais nem a amostra bruta da sessão.</p></div></div><div class="modal-body">${clearAfter?'<div class="notice warn" style="margin-bottom:10px"><strong>Depois de exportar, os dados deste navegador serão apagados.</strong> Para levar tudo, escolha o tipo Completo.</div>':''}${has2i||hasM1?`<div class="notice danger"><strong>${has2i&&hasM1?'Há dados de gestantes (2I) e nomes de pacientes de primeira consulta/tratamento concluído (M1/M2) importados.':has2i?'Há dados de gestantes (2I) importados.':'Há nomes de pacientes de primeira consulta e tratamento concluído (M1/M2) importados.'}</strong> Esses nomes + datas são o que permite ao app não contar a mesma pessoa de novo antes de completar 12 meses — restaurar um backup sem eles (Analítico) e continuar importando reinicia essa checagem do zero. Cifrar o backup com senha é a proteção padrão recomendada sempre que houver dados nominais.</div>`:''}<div class="split-grid"><div class="notice"><strong>Completo:</strong> preserva snapshots normalizados, denominadores, os nomes e datas de primeira consulta e tratamento concluído (M1/M2 — necessários para a dedução automática de 12 meses entre arquivos, não só para checagem de duplicidade) e o módulo 2I com contatos, origem e histórico. Recomendado cifrar; é o tipo indicado se você pretende continuar importando novos arquivos depois de restaurar.</div><div class="notice"><strong>Analítico:</strong> exclui integralmente snapshots, cadastros e acompanhamentos 2I, além dos nomes/datas de M1/M2. Mantém indicadores sem dados nominais — mas, se restaurado e usado para novas importações, a dedução de 12 meses não enxerga o histórico anterior ao backup.</div></div><div class="form-grid"><label class="field"><span>Tipo</span><select id="backupType"><option value="full">Completo</option><option value="analytic">Analítico · sem dados nominais</option></select></label><label class="field"><span>Proteção</span><select id="backupEncryption"><option value="yes">Cifrado com senha</option><option value="no">Sem cifra local</option></select></label><label class="field full"><span>Senha do arquivo (se cifrado)</span><input id="backupPassword" type="password" autocomplete="new-password" minlength="8" placeholder="Mínimo de 8 caracteres"></label></div><div class="notice warn" style="margin-top:12px"><strong>A senha não é armazenada e não pode ser recuperada.</strong> Guarde-a em local seguro.</div></div><div class="modal-foot"><button class="btn" data-restore-backup>${icon('upload')}Restaurar arquivo</button><button class="btn primary" data-create-backup>${icon('download')}Exportar backup</button></div>`)}
async function createBackupFromModal(){const clearAfter=localSave.pendingClearAfterBackup,type=document.getElementById('backupType').value,encrypted=document.getElementById('backupEncryption').value==='yes',password=document.getElementById('backupPassword').value;if(encrypted&&password.length<8){toast('Use pelo menos 8 caracteres para cifrar o backup.');return}showLoading('Criando backup','Calculando integridade e preparando o arquivo');try{const envelope=await createBackupEnvelope(type),out=encrypted?{format:'indicadores-saude-bucal-backup-encrypted',formatVersion:'1.0',createdAt:envelope.createdAt,payload:await encryptJSON(envelope,password)}:envelope;downloadFile(`indicadores-saude-bucal-${type}-${isoDate(new Date())}.saude-bucal-backup.json`,JSON.stringify(out,null,2),'application/json');state.lastBackupAt=nowISO();audit('backup_exported',{type,encrypted});state.dirty=false;await persistState();closeModal();refreshAll();if(clearAfter){localSave.pendingClearAfterBackup=false;await clearBrowserData();toast('Backup exportado e dados do navegador apagados.');return}toast(localSave.enabled?'Backup exportado e verificado. Os dados também continuam salvos neste navegador.':'Backup exportado e verificado. O salvamento no navegador está desligado — se editar algo depois, exporte de novo.')}catch(e){showError(e)}finally{hideLoading()}}
async function readBackupFile(file,password=''){const text=await file.text();let obj;try{obj=JSON.parse(text)}catch{throw new Error('O arquivo não contém JSON válido.')}if(obj.format==='indicadores-saude-bucal-backup-encrypted'){if(!password)throw Object.assign(new Error('PASSWORD_REQUIRED'),{code:'PASSWORD_REQUIRED',wrapper:obj});obj=await decryptJSON(obj.payload,password)}if(obj.format!=='indicadores-saude-bucal-backup'||!obj.data?.state)throw new Error('Formato de backup não reconhecido.');const check=await sha256(JSON.stringify(obj.data));if(check!==obj.checksum)throw new Error('A verificação de integridade falhou; o arquivo pode estar corrompido.');return obj}
function promptBackupPassword(wrapper){openModal(`<div class="modal-head"><div><h2 id="modalTitle">Desbloquear backup</h2><p>Este arquivo foi cifrado localmente.</p></div></div><div class="modal-body"><label class="field"><span>Senha</span><input id="restorePassword" type="password" autocomplete="current-password" autofocus></label></div><div class="modal-foot"><button class="btn" data-close-modal>Cancelar</button><button class="btn primary" data-unlock-backup>Desbloquear e validar</button></div>`,{closable:false});document.querySelector('[data-unlock-backup]').onclick=()=>processPendingBackup(document.getElementById('restorePassword').value)}
async function processPendingBackup(password=''){if(!pendingBackupFile)return;showLoading('Validando backup','Integridade, versão e conteúdo');try{const env=await readBackupFile(pendingBackupFile,password);hideLoading();openRestoreOptions(env)}catch(e){hideLoading();if(e.code==='PASSWORD_REQUIRED'||e.message==='PASSWORD_REQUIRED')promptBackupPassword(e.wrapper);else showError(e)}}
function openRestoreOptions(env){const s=env.data.state;openModal(`<div class="modal-head"><div><h2 id="modalTitle">Backup válido</h2><p>${esc(env.type)} · ${fmtDateTime(env.createdAt)} · esquema ${esc(env.schemaVersion)}</p></div></div><div class="modal-body"><div class="facts"><div class="fact"><span>Snapshots</span><strong>${s.snapshots?.length||0}</strong></div><div class="fact"><span>Denominadores</span><strong>${s.denominators?.length||0}</strong></div><div class="fact"><span>Cadastros manuais 2I</span><strong>${s.gestantes?.manual?.length||0}</strong></div><div class="fact"><span>Auditoria</span><strong>${s.audit?.length||0}</strong></div></div><div class="notice warn" style="margin-top:12px"><strong>Substituir</strong> troca o estado atual pelo backup. <strong>Mesclar</strong> adiciona itens que ainda não existem, identificados por hash ou ID.</div></div><div class="modal-foot"><button class="btn" data-close-modal>Cancelar</button><button class="btn" id="mergeRestore">Mesclar</button><button class="btn danger" id="replaceRestore">Substituir estado atual</button></div>`);document.getElementById('mergeRestore').onclick=()=>restoreBackup(env,'merge');document.getElementById('replaceRestore').onclick=()=>restoreBackup(env,'replace')}
function mergeArraysBy(arrA,arrB,key){const map=new Map((arrA||[]).map(x=>[x[key],x]));for(const x of arrB||[])if(!map.has(x[key]))map.set(x[key],x);return [...map.values()]}
function recomputeSupersession(){
  const groups=new Map();
  for(const s of state.snapshots){if(CUMULATIVE_2I_PROFILES.includes(s.profile)){s.supersededBy=null;continue}const key=`${s.profile}|${s.unit||''}|${s.periodStart||''}|${s.periodEnd||''}`;const list=groups.get(key)||[];list.push(s);groups.set(key,list)}
  for(const list of groups.values()){
    list.sort((a,b)=>new Date(a.createdAt)-new Date(b.createdAt));
    const newest=list.at(-1);
    for(const s of list)s.supersededBy=(s===newest)?undefined:newest.id;
  }
}
async function restoreBackup(env,mode){showLoading('Restaurando backup',mode==='replace'?'Substituindo o estado local':'Mesclando dados sem duplicação');try{preRestoreSnapshot={at:nowISO(),payload:state};const incoming=migrateState(env.data.state),incomingWasClean=!incoming.dirty;if(mode==='replace'){state=incoming}else{state.snapshots=mergeArraysBy(state.snapshots,incoming.snapshots,'hash');state.denominators=mergeArraysBy(state.denominators,incoming.denominators,'id');state.gestantes.manual=mergeArraysBy(state.gestantes.manual,incoming.gestantes.manual,'id');state.gestantes.followups={...state.gestantes.followups,...incoming.gestantes.followups};state.gestantes.merges={...state.gestantes.merges,...incoming.gestantes.merges};state.gestantes.excluded={...state.gestantes.excluded,...incoming.gestantes.excluded};state.gestantes.overrides={...state.gestantes.overrides,...incoming.gestantes.overrides};state.gestantes.puerperioIgnored={...(state.gestantes.puerperioIgnored||{}),...(incoming.gestantes.puerperioIgnored||{})};state.patientDirectory={...(state.patientDirectory||{}),...(incoming.patientDirectory||{})};state.columnMappings.consulta2i={...state.columnMappings.consulta2i,...incoming.columnMappings.consulta2i};state.audit=mergeArraysBy(state.audit,incoming.audit,'id');recomputeSupersession()}audit('backup_restored',{mode,type:env.type});state.dirty=!(mode==='replace'&&incomingWasClean);await persistState();pendingBackupFile=null;closeModal();refreshAll();toast(mode==='replace'?(state.dirty?'Backup restaurado. Nada é salvo automaticamente — exporte um novo backup antes de fechar.':'Backup restaurado — corresponde exatamente ao arquivo que você acabou de abrir.'):'Backup mesclado. O resultado da mesclagem ainda não está salvo — exporte um novo backup antes de fechar.')}catch(e){showError(e)}finally{hideLoading()}}

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
  await add('55. Reconhecimento de papéis: atendimento geral não é primeira consulta nem tratamento concluído, e flúor é preventivo (desde a v2.18 o denominador de M4 é a lista da Nota B5, ver teste 253)',()=>{const geral=procedureMatch('ATENDIMENTO ODONTOLOGICO'),primeira=procedureMatch('PRIMEIRA CONSULTA ODONTOLOGICA PROGRAMADA'),concluido=procedureMatch('TRATAMENTO CONCLUIDO'),flúor=procedureMatch('APLICACAO TOPICA DE FLUOR');return !geral.roles.includes('first')&&!geral.roles.includes('concluded')&&primeira.roles.includes('first')&&concluido.roles.includes('concluded')&&flúor.roles.includes('m4den')});
  await add('56. Denominador de B5 é a lista fechada da Nota B5; atendimento geral não entra',()=>{const geral=procedureMatch('ATENDIMENTO ODONTOLOGICO'),exodontiaMultipla=procedureMatch('EXODONTIA MULTIPLA'),flúor=procedureMatch('APLICACAO TOPICA DE FLUOR');return !geral.roles.includes('b5den')&&!exodontiaMultipla.roles.includes('b5den')&&flúor.roles.includes('b5den')});
  await add('57. Adequação do comportamento de crianças reconhece descrição truncada',()=>{const m=procedureMatch('ADEQUACAO DO COMPORTAMENTO DE');return !m.unrecognized&&m.code==='03.07.01.015-5'&&m.roles.includes('m4den')&&m.roles.includes('b5den')});
  await add('58. B1/B2/B4/B5/B6 espelham M1/M2/M3/M4/M5 (B5 = M4 desde a v2.18: mesma conta, lista de 28 códigos da Nota B5 no denominador); só B3 é independente',()=>FEDERAL_MIRROR.B1==='M1'&&FEDERAL_MIRROR.B2==='M2'&&FEDERAL_MIRROR.B4==='M3'&&FEDERAL_MIRROR.B5==='M4'&&FEDERAL_MIRROR.B6==='M5'&&!('B3' in FEDERAL_MIRROR)&&procedureRolesFor('M4').includes('b5den')&&!procedureRolesFor('M4').includes('m4den'));
  await add('253. M4 usa a mesma conta da B5: o denominador é a soma dos procedimentos da lista da Nota B5 (b5den), então atendimento genérico, aferição de pressão e exodontia de decíduo ficam fora; B5 dá o mesmo resultado que M4',()=>{const before=state.snapshots.length,u=state.preferences.unit,mk=state.preferences.month;try{const base={firstConsultations:0,firstConsultationQuantity:0,treatmentsConcluded:0,treatmentConcludedQuantity:0,preventive:4,individualProcedures:30,art:0,restorative:0,b5Denominator:10,b3Numerator:0,b3Denominator:0,procedureCounts:[],firstPatients:[],concludedPatients:[]};state.snapshots.push({id:'tm4b5_selftest',profile:'celk_procedimentos_detalhado',unit:u,fileName:'m4b5.pdf',createdAt:nowISO(),status:'x',validations:[],procedureCounts:[],dataByMonth:{[mk]:{...base,kind:'procedure'}}});const m=municipalComponents('M4',mk),f=federalComponents('B5',mk);const generic=procedureMatch('ATENDIMENTO ODONTOLOGICO'),pressao=procedureMatch('AFERICAO DE PRESSAO ARTERIAL'),dec=procedureMatch('EXODONTIA DE DENTE DECIDUO');return m.denominator===10&&Math.abs(m.result-40)<1e-9&&f.result===m.result&&f.mirrorOf==='M4'&&[generic,pressao,dec].every(x=>!x.roles.includes('b5den'))}finally{state.snapshots.length=before}});
  await add('59. Escovação supervisionada não confunde com atividade que só cita saúde bucal',()=>/ESCOVACAO SUPERVISIONADA/.test(norm('Escovação Supervisionada'))&&!/ESCOVACAO SUPERVISIONADA/.test(norm('cuidados em DM (saúde bucal)')));
  await add('60. Nota de evolução de atividade em grupo não conta como procedimento individual nem aparece na página Procedimentos (nonDental, sem papel em indicador); as duas grafias de excisão/sutura viram um item só',()=>{const g=procedureMatch('EVOLUÇÃO DA ATIVIDADE EM GRUPO'),a=procedureMatch('EXCISÃO E/OU SUTURA SIMPLES DE PEQUENAS LESÕES / FERIMENTOS DE PELE / ANEXOS E MUCOSA'),b=procedureMatch('EXCISAO DE LESAO E/OU SUTURA DE FERIMENTO DA PELE ANEXOS E MUCOSA');return !g.unrecognized&&g.nonDental===true&&g.roles.length===0&&!a.unrecognized&&!b.unrecognized&&a.name===b.name});
  await add('61. Hipótese de B6 herda a ressalva de amálgama/CBO do M5 espelhado',()=>{const h=federalComponents('B6','2026-07').hypothesis;return typeof h==='string'&&/amálgama/i.test(h)&&/CBO/i.test(h)});
  await add('62. Denominador de restaurador (M5/B6): ART, os 5 tipos de restauração da Nota B5 com SIGTAP e 2 regras genéricas para descrição cortada; nenhum código de amálgama',()=>{const rules=PROCEDURE_RULES.filter(r=>r.roles.includes('restorative'));const art=rules.filter(r=>r.code==='03.07.01.007-4'&&!r.ambiguous),trunc=rules.filter(r=>r.ambiguous),typed=rules.filter(r=>['03.07.01.003-1','03.07.01.012-0','03.07.01.008-2','03.07.01.010-4','03.07.01.011-2'].includes(r.code));return rules.length===8&&art.length===1&&trunc.length===2&&typed.length===5&&!rules.some(r=>r.code==='03.07.01.009-0'||r.code==='03.07.01.013-9')});
  await add('63. Numerador B3 cobre as duas exodontias e nada mais',()=>{const perm=procedureMatch('EXODONTIA DE DENTE PERMANENTE'),mult=procedureMatch('EXODONTIA MULTIPLA'),outros=PROCEDURE_RULES.filter(r=>r.roles.includes('b3num'));return perm.roles.includes('b3num')&&mult.roles.includes('b3num')&&outros.length===2});
  await add('64. Orientação de higiene bucal entra em B5 mas não em B3 (lista própria por indicador)',()=>{const m=procedureMatch('ORIENTACAO DE HIGIENE BUCAL');return m.roles.includes('b5den')&&!m.roles.includes('b3den')});
  await add('65. Lista viva de códigos b3den (incluindo as 2 restaurações ambíguas expandidas) bate exatamente com CODES.B3_DEN',()=>{const live=PROCEDURE_RULES.filter(r=>r.roles.includes('b3den'));const restauraPermanente=['0307010031','0307010120'],restauraDeciduo=['0307010082','0307010104','0307010112'];const covered=new Set();for(const r of live){if(r.code){covered.add(r.code.replace(/\D/g,''))}else if(/PERMANENTE/.test(norm(r.name))){restauraPermanente.forEach(c=>covered.add(c))}else if(/DECIDUO/.test(norm(r.name))){restauraDeciduo.forEach(c=>covered.add(c))}}return covered.size===CODES.B3_DEN.length&&CODES.B3_DEN.every(c=>covered.has(c))});
    await add('66. Painel 2I não trava equipe, origem, telefone nem prioridade por padrão e abre na fila "A contatar" (as outras etapas ficam em abas, incluindo "Todas")',()=>{const p=defaultState().preferences;return p.pregTeam===''&&p.pregOrigin===''&&p.pregPhone===''&&p.pregExcluded===''&&p.pregPrioOnly===false&&p.pregTab==='a_contatar'&&PREG_TABS.some(([k])=>k==='todas')&&!('pregPopulation' in p)});
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
  await add('77. Salvamento no navegador usa IndexedDB (sem o limite do localStorage), pode ser desligado e não grava a amostra bruta da sessão (sessionRaw, com as linhas originais)',()=>openLocalDB.toString().includes('indexedDB.open')&&!saveToBrowserNow.toString().includes('sessionRaw')&&typeof setAutosave==='function'&&readAutosavePref.toString().includes("!=='off'"));
  await add('78. Leitor de PDF referencia arquivos .js (não .mjs), evitando bloqueio de MIME type em hospedagem estática que não mapeia .mjs como JavaScript',()=>{const src=loadPdfJs.toString();return src.includes('pdf.min.js')&&src.includes('pdf.worker.min.js')&&!src.includes('.mjs')});
  await add('79. Falha de importação guarda o motivo por arquivo em vez de deixar o resumo final sobrescrever a mensagem de erro (regressão do bug em que o toast escondia o motivo real)',()=>{const src=importFiles.toString();return src.includes('failures.push')&&src.includes('showImportFailures')});
  await add('80. Relatório de falha de importação inclui navegador e detalhe técnico, sem depender do console do navegador',()=>{const rep=importFailureReportText([{name:'x.pdf',message:'erro teste',stack:'stack teste'}]);return rep.includes('x.pdf')&&rep.includes('erro teste')&&rep.includes('stack teste')&&rep.includes(navigator.userAgent)});
  await add('81. ReadableStream é assíncrono-iterável (nativo ou via polyfill) — sem isso o pdf.js falha só no Safari até a versão 26 ao ler o texto do PDF',async()=>{if(typeof ReadableStream==='undefined')return true;if(typeof ReadableStream.prototype[Symbol.asyncIterator]!=='function')return false;const rs=new ReadableStream({start(c){c.enqueue(1);c.enqueue(2);c.close()}});const got=[];for await(const v of rs)got.push(v);return got.length===2&&got[0]===1&&got[1]===2});
  await add('82. Leitura por meta (M2, não simultâneo): 32/70 com meta 50% ainda precisa de 3 tratamentos concluídos a mais',()=>metaGap('M2',32,70)===3);
  await add('83. Leitura por meta (M4, simultâneo — novo preventivo também aumenta o denominador): 183/675 com meta 40% ainda precisa de 145 procedimentos preventivos a mais',()=>metaGap('M4',183,675)===145);
  await add('84. Leitura por meta (M1, meta = faixa Ótimo >1,25%): 57/11358,5 ainda precisa de 85 primeiras consultas a mais',()=>metaGap('M1',57,11358.5)===85);
  await add('85. m1Band classifica corretamente as 4 faixas oficiais de M1 usadas na régua da Visão Geral',()=>m1Band(1.3)?.label==='Ótimo'&&m1Band(0.8)?.label==='Bom'&&m1Band(0.3)?.label==='Suficiente'&&m1Band(0.1)?.label==='Regular');
  await add('86. metaGoalsHit devolve contagem coerente (batidas ≤ com dado) tanto para o mês quanto para o quadrimestre, sem lançar erro',()=>{const mk=state.preferences.month,gm=metaGoalsHit(mk,'month'),gq=metaGoalsHit(mk,'quarter');return gm.hit<=gm.total&&gq.hit<=gq.total&&Number.isFinite(gm.hit)&&Number.isFinite(gq.hit)});
  await add('87. Visão Geral não usa pontuação em pontos ("pts"): cada cartão tem régua com a meta, faixa e os meses do quadrimestre, com toggle mês/quadrimestre',()=>{const src=metaCard.toString()+ovRulerHTML.toString()+overviewHTML.toString();return !src.includes('pts')&&src.includes('ovRulerHTML')&&src.includes('ovQuarterBarsHTML')&&src.includes('overviewScope')});
  await add('88. Preferência padrão de escopo da Visão Geral é "por mês"',()=>defaultState().preferences.overviewScope==='month');
  await add('89. Resumo de gestantes na Visão Geral usa isAttended() (CSV, Monitora, produção e confirmação manual) sobre a lista de trabalho visível e leva à fila',()=>{const src=overviewHTML.toString();return src.includes('visibleByExclusion(mergedEpisodes())')&&src.includes('filter(isAttended)')&&src.includes('100*attended/pregExpanded.length')&&src.includes('data-go="pregnant"')});
  await add('90. Selo "Consolidado informado" reconhece o motivo detalhado do Metabase (regressão do bug em que a comparação exata de string nunca batia e todo resultado do Metabase aparecia como "Prévia não homologada")',()=>{const html=dataQuality({result:10,resultKind:'informado pelo Metabase porque não há CELK para o mês'});return html.includes('Consolidado informado')&&!html.includes('Prévia não homologada')});
  await add('91. Página Municipal (v2.16): matriz de apuração sem pontos, sem Auditoria e sem a Reconciliação com o Metabase; cada linha abre a gaveta do indicador pelo quadrimestre, em ordem M1–M5',()=>{const html=municipalHTML(),pos=OVERVIEW_IDS.map(id=>html.indexOf(`data-indicator-detail="${id}" data-detail-scope="quarter"`));return !html.includes(' pts')&&!html.includes('Auditoria')&&!html.includes('Reconciliação')&&html.includes('Apuração do quadrimestre')&&html.includes('Denominadores')&&pos.every((x,i)=>x>0&&(i===0||x>pos[i-1]))});
  await add('92. zoneClass/zoneLabel classificam M2 (corte 25, meta 50) nas 3 faixas coerentes com a régua principal',()=>zoneClass('M2',60)==='zone-good'&&zoneLabel('M2',60)==='Meta batida'&&zoneClass('M2',30)==='zone-warn'&&zoneLabel('M2',30)==='Em progresso'&&zoneClass('M2',10)==='zone-bad'&&zoneLabel('M2',10)==='Abaixo do corte');
  await add('93. zoneClass agrupa as faixas oficiais de M1 (Ótimo/Bom viram zone-good, Suficiente zone-warn, Regular zone-bad)',()=>zoneClass('M1',1.3)==='zone-good'&&zoneClass('M1',0.8)==='zone-good'&&zoneClass('M1',0.3)==='zone-warn'&&zoneClass('M1',0.1)==='zone-bad');
  await add('94. Célula da matriz municipal (mxCellHTML) marca o mês em foco, o mês que ainda não chegou e o mês sem dado, e usa a zona da meta',()=>{const a=mxCellHTML('municipal','M2',60,{focus:true}),b=mxCellHTML('municipal','M2',30),c=mxCellHTML('municipal','M2',null),d=mxCellHTML('municipal','M2',null,{future:true}),e=mxCellHTML('municipal','M1',0.8);return a.includes('mz-otimo focus')&&a.includes('Meta batida')&&b.includes('mz-suf')&&b.includes('Entre corte e meta')&&c.includes('missing')&&c.includes('sem dado')&&d.includes('future')&&d.includes('a chegar')&&e.includes('mz-bom')&&e.includes('Bom')});
  await add('95. quadrimestralOutlook devolve rótulo e classe de pill válidos para os 5 indicadores municipais, com ou sem dados carregados',()=>{const classes=['success','bad','neutral','warn','good'];return ['M1','M2','M3','M4','M5'].every(id=>{const q=quarterMunicipal(id),r=quadrimestralOutlook(id,q);return classes.includes(r.cls)&&typeof r.label==='string'&&r.label.length>0&&typeof r.detail==='string'&&r.detail.length>0})});
  await add('96. Coluna Parcial soma os 4 meses tratando ausência como zero e sempre divide por 4 (projeção de meta)',()=>{const parts=[1,null,null,null].map(v=>v==null?0:v);return Math.abs(sum(parts)/4-0.25)<1e-9});
  await add('97. Página Federal: B1–B6 em ordem numérica, com selo "= M1/M2/M3/M4/M5" nos espelhos (B5 = M4 desde a v2.18) e "regra própria" só em B3, sem a tabela "Faixas federais cadastradas"',()=>{const html=federalHTML(),pos=FED_IDS.map(id=>html.indexOf(`data-fed-detail="${id}"`));return pos.every((x,i)=>x>0&&(i===0||x>pos[i-1]))&&!html.includes('Faixas federais cadastradas')&&['M1','M2','M3','M4','M5'].every(m=>html.includes(`= ${m}</span>`))&&(html.match(/regra própria<\/span>/g)||[]).length===1});
  await add('98. FEDERAL_BAND_DEFS cobre o eixo inteiro de 0 até o máximo, sem buracos nem sobreposição, para os 6 indicadores federais',()=>['B1','B2','B3','B4','B5','B6'].every(id=>{const def=FEDERAL_BAND_DEFS[id],segs=[...def.segments].sort((a,b)=>a[0]-b[0]);return segs[0][0]===0&&segs[segs.length-1][1]===def.max&&segs.every((s,i)=>i===0||s[0]===segs[i-1][1])}));
  await add('99. classifyFederal/federalZoneColor concordam nas 4 faixas de B1 (caso monotônico) e nas 2 zonas "Regular" de B3 (caso de faixa atípica, ótima no meio da escala)',()=>{const c=(id,v)=>classifyFederal(id,v);return c('B1',1.3)==='Ótimo'&&c('B1',0.8)==='Bom'&&c('B1',0.3)==='Suficiente'&&c('B1',0.1)==='Regular'&&c('B3',7)==='Ótimo'&&c('B3',2)==='Regular'&&c('B3',15)==='Regular'});
  await add('100. Paleta federal (FEDERAL_ZONE_COLORS + cor própria do card B3) não repete nenhuma cor já usada nas faixas municipais de M1',()=>{const muni=RULESETS.municipal.indicators.M1.bands.map(b=>b.color.toLowerCase());const fed=[...Object.values(FEDERAL_ZONE_COLORS).map(c=>c.text.toLowerCase()),FEDERAL_B3_ACCENT.toLowerCase()];return fed.every(c=>!muni.includes(c))});
  await add('101. isAttended combina status2i do CSV com confirmação manual sem alterar o campo bruto',()=>{const e={id:'t101',status2i:'pendente'};state.gestantes.followups['t101']={state:'ok_manual',updatedAt:nowISO(),history:[]};const result=isAttended(e)&&e.status2i==='pendente';delete state.gestantes.followups['t101'];return result});
  await add('102. Lista 2I ordena pendentes alfabeticamente antes das atendidas',()=>{const list=[{id:'a',nome:'Beatriz',status2i:'atende'},{id:'b',nome:'Ana',status2i:'pendente'},{id:'c',nome:'Carla',status2i:'pendente'}];const sorted=[...list].sort((x,y)=>{const xa=isAttended(x)?1:0,ya=isAttended(y)?1:0;if(xa!==ya)return xa-ya;return x.nome.localeCompare(y.nome,'pt-BR')});return sorted.map(x=>x.id).join(',')==='b,c,a'});
  await add('103. Sinalização de prioridade (3º trimestre) exige pendente + gestação ativa + IG ≥28 sem., sem reordenar a lista',()=>{const dum=new Date();dum.setDate(dum.getDate()-7*30);const e={ultimaMenstruacao:dum.toISOString().slice(0,10),dataParto:'',status2i:'pendente'};const weeks=gestationalWeeks(e);return isPriority2I(e)&&weeks>=28});
  await add('104. Importação do CSV 2I interpreta automaticamente "Sim" como atendida, sem modal de confirmação',()=>{const src=parseGestantesCSV.toString();return !src.includes('ensure2IMappings')&&src.includes("norm(record.consultaSaudeBucal)==='SIM'?'atende':'pendente'")});
  await add('105. Correção local de contato não altera o episódio original do snapshot Metabase',()=>{const snap={id:'s1',episodes:[{id:'e1',telefone:'11999999999'}]};state.gestantes.overrides['e1']={telefone:'11888888888'};const originalUnchanged=snap.episodes[0].telefone==='11999999999';delete state.gestantes.overrides['e1'];return originalUnchanged});
  await add('106. Painel 2I resume o Panorama atual numa barra de meta por etapa e organiza a lista em abas (A contatar, Em contato, Agendadas, Atendidas, Encerradas, Todas), sem os antigos KPIs soltos',()=>{const src=pregnancyHTML.toString(),labels=PREG_TABS.map(([,l])=>l).join('|');return src.includes('Panorama atual')&&src.includes('pq-bar')&&src.includes('data-preg-tab')&&labels==='A contatar|Em contato|Agendadas|Atendidas|Encerradas|Todas'&&!src.includes("kpi('Gestantes pendentes'")&&!src.includes("kpi('Gestantes ativas'")});
  await add('107. Telefone aparece no card da lista (para agir direto) e na gaveta, com copiar e abrir WhatsApp',()=>{return pregRow.toString().includes('e.telefone?esc(e.telefone)')&&openEpisode.toString().includes('data-copy-text')&&openEpisode.toString().includes('data-open-whatsapp')});
  await add('108. Gaveta colore o acompanhamento por situação (deixa de ser monocromática)',()=>{return openEpisode.toString().includes('followupColor(')});
  await add('109. Cabeçalho não exibe mais nome/avatar do usuário (perfil removido do topbar)',()=>{const bar=document.querySelector('.topbar');return !document.querySelector('.topbar .profile')&&!!bar&&!bar.innerHTML.includes('avatar')});
  await add('110. Lista 2I renderiza como cards horizontais com fundo pastel da situação (pq-card + tone-*), sem tabela',()=>{const src=pregnancyHTML.toString(),row=pregRow.toString();return src.includes('map(pregRow)')&&row.includes('pq-card tone-')&&!src.includes('<table>')&&pregTone.toString().includes("isPriority2I(e)?'red'")});
  await add('111. Coluna "Funções" do Resumo por procedimento mostra indicador + papel (ex.: "M1 - Numerador"), não o código bruto da role',()=>{const first=procedureRoleBadgesHTML(['first']);return first.includes('M1 - Numerador')&&first.includes('B1 - Numerador')&&first.includes('M2 - Denominador')&&first.includes('B2 - Denominador')&&!importsHTML.toString().includes("pill(r,'neutral')")});
  await add('112. Gestação encerrada tem etapa e cor próprias (lilás), distintas das outras etapas, e vale mesmo quando ela foi atendida',()=>{const tones=Object.values(PREG_STAGE).map(v=>v[1]);const unique=new Set(tones).size===tones.length;const e={id:'t112',status2i:'atende',dataParto:'2026-01-10',ultimaMenstruacao:'2025-04-01'};return unique&&PREG_STAGE.encerrada[0]==='Gestação encerrada'&&PREG_STAGE.encerrada[1]==='violet'&&pregBucket(e)==='encerrada'&&isAttended(e)});
  await add('113. "Enviar WhatsApp" do card abre a conversa e registra o envio; o ícone ao lado e a gaveta registram sem abrir',()=>{const act=pregAct.toString();return act.includes("kind==='whatsapp'")&&act.includes('wa.me/')&&act.includes("'whatsapp_enviado'")&&act.includes("kind==='wa-reg'")&&pregRow.toString().includes('wa-reg|')&&openEpisode.toString().includes('|whatsapp_enviado"')});
  await add('114. "Limpar tudo" do 2I remove só snapshots do perfil 2I e reseta manual/acompanhamento/mesclagens/exclusões/correções, sem tocar em outros perfis de snapshot nem exigir confirmação sem o texto exato',()=>{const srcData=clearAllGestantesData.toString(),srcModal=openClearGestantesModal.toString();return srcData.includes("profile!=='metabase_gestantes_2i'")&&srcData.includes('manual:[]')&&srcData.includes('followups:{}')&&srcData.includes('merges:{}')&&srcData.includes('excluded:{}')&&srcData.includes('overrides:{}')&&srcModal.includes("v!=='LIMPAR TUDO'")});
  await add('115. "Busca ativa solicitada" é um estado de acompanhamento próprio, com botão na gaveta e cor distinta das demais (não reaproveita o azul do WhatsApp nem o verde/vermelho de OK/confirmado)',()=>{const srcOpen=openEpisode.toString(),colorsOk=FOLLOWUP_COLORS.busca_ativa_solicitada&&FOLLOWUP_COLORS.busca_ativa_solicitada.text!==FOLLOWUP_COLORS.whatsapp_enviado.text&&FOLLOWUP_COLORS.busca_ativa_solicitada.text!==FOLLOWUP_COLORS.ok_manual.text&&FOLLOWUP_COLORS.busca_ativa_solicitada.text!==FOLLOWUP_COLORS.atende_confirmado.text;return colorsOk&&srcOpen.includes('data-followup="${esc(e.id)}|busca_ativa_solicitada"')&&followupLabel('busca_ativa_solicitada')==='Busca ativa solicitada'});
  await add('116. Etapa da fila vem do acompanhamento: WhatsApp enviado e busca ativa = Em contato, agendada = Agendadas, confirmação manual = Atendida, sem registro = A contatar',()=>{const e={id:'t116',status2i:'pendente',ultimaMenstruacao:isoDate(new Date(Date.now()-100*864e5))};const at=st=>{if(st)state.gestantes.followups['t116']={state:st,updatedAt:nowISO(),history:[]};else delete state.gestantes.followups['t116'];return pregBucket(e)};const r=[at(null),at('whatsapp_enviado'),at('busca_ativa_solicitada'),at('agendada'),at('ok_manual'),at('atende_confirmado')];delete state.gestantes.followups['t116'];return r.join('|')==='a_contatar|em_contato|em_contato|agendada|atendida|atendida'});
  await add('117. Gaveta da gestante: topo na cor do card com navegação entre gestantes da fila, abas "Acompanhamento" (próxima ação, etapas, registrar, contato, gestação, histórico e notas) e "Dados cadastrais"; ações raras no menu ⋯',()=>{const src=openEpisode.toString();const iNext=src.indexOf('pq-d-next'),iSteps=src.indexOf('pq-steps'),iContato=src.indexOf('>Contato<'),iGest=src.indexOf('>Gestação<'),iHist=src.indexOf('Histórico e notas'),iNote=src.indexOf('data-add-followup-note');return src.includes('data-preg-nav')&&src.includes('data-preg-dtab="acomp"')&&src.includes('data-preg-dtab="dados"')&&src.includes('pq-drawer tone-')&&iNext>-1&&iSteps>iNext&&iContato>iSteps&&iGest>iContato&&iHist>iGest&&iNote>iHist&&src.includes('data-exclude-episode')&&src.includes('data-preg-menu')});
  await add('118. Botão "Mais detalhes" da gaveta alterna a exibição (classe "open") sem alterar o estado da aplicação nem disparar toast/atualização',()=>{const btn=document.createElement('button');btn.setAttribute('data-toggle-details','');const body=document.createElement('div');body.className='disclosure-body';const wrap=document.createElement('div');wrap.style.display='none';wrap.appendChild(btn);wrap.appendChild(body);document.body.appendChild(wrap);const before=JSON.stringify(state.gestantes);btn.click();const openedBoth=btn.classList.contains('open')&&body.classList.contains('open');btn.click();const closedBoth=!btn.classList.contains('open')&&!body.classList.contains('open');const stateUnchanged=JSON.stringify(state.gestantes)===before;wrap.remove();return openedBoth&&closedBoth&&stateUnchanged});
  await add('119. "Agendada" guarda data (e horário opcional) da consulta; passada a data sem confirmação, a próxima ação vira "Confirmar atendimento" em alerta',()=>{const c=FOLLOWUP_COLORS.agendada,colorsOk=c&&c.text!==FOLLOWUP_COLORS.whatsapp_enviado.text&&c.text!==FOLLOWUP_COLORS.busca_ativa_solicitada.text&&c.text!==FOLLOWUP_COLORS.ok_manual.text&&c.text!==FOLLOWUP_COLORS.atende_confirmado.text;state.gestantes.followups['t119']={state:'agendada',agendaAt:'2020-01-02T08:30',updatedAt:nowISO(),history:[]};const n=pregNextAction({id:'t119',status2i:'pendente'});delete state.gestantes.followups['t119'];return colorsOk&&setFollowup.toString().includes('agendaAt')&&openEpisode.toString().includes('pqSchedDate')&&openEpisode.toString().includes('pqSchedTime')&&n.kind==='atendida'&&n.alert===true&&followupLabel('agendada')==='Consulta agendada'});
  await add('120. Abas da gaveta trocam pelo estado da gaveta (pregDrawer.tab), sem alterar os dados da gestante',()=>{const src=openEpisode.toString();return src.includes("pregDrawer.tab==='dados'?dados:acomp")&&setupEvents.toString().includes('pregDrawer.tab=el.dataset.pregDtab')&&!setupEvents.toString().includes('data-g-tab')});
  await add('121. Adicionar nota ao acompanhamento cria uma entrada do tipo "nota" na linha do tempo, sem mudar o estado nem a data de atualização do acompanhamento',()=>{const src=addFollowupNote.toString();return src.includes("type:'note'")&&src.includes('state:old.state')&&src.includes('updatedAt:old.updatedAt')});
  await add('122. Contagem do acompanhamento soma WhatsApp enviado, busca ativa, agendada e notas separadamente a partir do histórico',()=>{const h=[{to:'whatsapp_enviado'},{to:'whatsapp_enviado'},{to:'busca_ativa_solicitada'},{type:'note',text:'x'},{to:'agendada'}];const c=followupCounts(h);return c.whatsapp===2&&c.buscaAtiva===1&&c.agendada===1&&c.notes===1});
  await add('123. Alternar "Gestação encerrada" marca a data do parto como hoje (ou limpa, ao desmarcar) — direto no cadastro para origem manual, como correção local para origem Metabase — sem alterar o episódio original',()=>{const src=toggleGestacaoEncerrada.toString();return src.includes("e.origin==='manual'")&&src.includes('isoDate(new Date())')&&src.includes('ov.dataParto=')});
  await add('124. "Salvar alterações" (aba Editar dados) grava nome, prontuário, equipe, nascimento, endereço, telefone, DUM, DPP, parto e nota local como uma correção local — sem alterar a fotografia original do CSV do Metabase',()=>{const src=saveAllFieldsOverride.toString();const fields=['nome','prontuario','equipe','dataNascimento','enderecoOverride','telefone','ultimaMenstruacao','dataProvParto','dataParto','notaLocal'];return fields.every(k=>src.includes(k))&&src.includes('state.gestantes.overrides[id]=ov')});
  await add('125. Correção completa (nome, prontuário, equipe, endereço) grava como sobreposição local e aparece no episódio mesclado, sem alterar o snapshot original do Metabase — mesmo mecanismo já usado por telefone/DUM/DPP/parto/nota',()=>{const snap={id:'sOv125',profile:'metabase_gestantes_2i',createdAt:new Date(Date.now()+9e10).toISOString(),episodes:[{id:'eOv125',nome:'Nome Original',prontuario:'000',equipe:'1'}]};state.snapshots.push(snap);state.gestantes.overrides['eOv125']={nome:'Nome Corrigido',prontuario:'999',equipe:'9',enderecoOverride:'Rua Nova, 1'};const merged=mergedEpisodes().find(x=>x.id==='eOv125');const overlaid=!!merged&&merged.nome==='Nome Corrigido'&&merged.prontuario==='999'&&merged.equipe==='9'&&merged.enderecoOverride==='Rua Nova, 1';const originalUnchanged=snap.episodes[0].nome==='Nome Original'&&snap.episodes[0].prontuario==='000';state.snapshots.pop();delete state.gestantes.overrides['eOv125'];return overlaid&&originalUnchanged});
  await add('126. Aba "Dados cadastrais" da gaveta cobre nome, prontuário (CELK), equipe, nascimento, endereço, telefone, DUM, DPP, parto e nota, e só vira formulário ao clicar em Editar',()=>{const src=openEpisode.toString();const hasAllFields=['efNome','efProntuario','efEquipe','efNascimento','efEndereco','efTelefone','efDum','efDpp','efParto','efNota'].every(k=>src.includes(k));return hasAllFields&&src.includes('Prontuário (CELK)')&&src.includes('data-preg-edit')&&src.includes('data-preg-dtab="dados"')&&!src.includes('data-edit-contact')&&typeof openEditContact==='undefined'});
  await add('127. doseML calcula volume e mg pelo peso sem travar quando o resultado fica dentro do teto (ex.: 20kg ÷ 3 = 7 mL, 350 mg)',()=>{const d=doseML(20,3,10);return d.vol==='7'&&d.mg===350&&d.capped===false});
  await add('128. doseML trava no teto máximo quando o cálculo por peso o ultrapassa (ex.: 50kg ÷ 3 daria 17 mL, mas o teto de Amoxicilina/Eritromicina/Cefalexina é 10 mL)',()=>{const d=doseML(50,3,10);return d.vol==='10'&&d.mg===500&&d.capped===true});
  await add('129. doseGotas arredonda para o mais próximo por padrão, mas para baixo quando arredondarParaBaixo é true (ex.: 9,5kg × 1 gota/kg = 9,5 → 9 gotas com arredondamento para baixo, não 10)',()=>{const semFloor=doseGotas(9.5,1.5,10,35,false);const comFloor=doseGotas(9.5,1,25,35,true);return semFloor.gotas===14&&semFloor.mg===140&&comFloor.gotas===9&&comFloor.mg===225});
  await add('130. doseGotas trava no teto de gotas (ex.: Ibuprofeno a 50 mg/mL não passa de 40 gotas mesmo com peso alto)',()=>{const d=doseGotas(50,1,2.5,40,false);return d.gotas===40&&d.capped===true&&d.mg===100});
  await add('131. calculatorHTML mostra "—" nos seis cartões de medicamento quando nenhum peso foi informado',()=>{const prevCalc=state.preferences.calcPeso;state.preferences.calcPeso='';const html=calculatorHTML();state.preferences.calcPeso=prevCalc;return (html.match(/<strong>—<\/strong>/g)||[]).length===6});
  await add('132. calculatorHTML calcula as seis doses a partir de state.preferences.calcPeso (ex.: 20kg → Amoxicilina 7 mL, Eritromicina/Cefalexina 5 mL, Paracetamol 30 gotas, Dipirona/Ibuprofeno 20 gotas)',()=>{const prevCalc=state.preferences.calcPeso;state.preferences.calcPeso='20';const html=calculatorHTML();state.preferences.calcPeso=prevCalc;return html.includes('<strong>7</strong>')&&html.includes('<strong>5</strong>')&&html.includes('<strong>30</strong>')&&html.includes('<strong>20</strong>')&&html.includes('value="20"')});
  await add('133. A view da calculadora tem entrada em VIEW_META e botão próprio na barra lateral, e esconde os tabs/filtros/backup/importar de indicadores (fica só com Imprimir) sem afetar as outras views',()=>{const hasMeta=Array.isArray(VIEW_META.calculator)&&VIEW_META.calculator[0]==='Calculadora odontopediátrica';const hasSidebarBtn=!!document.querySelector('[data-view="calculator"]');switchView('pregnant',{save:false});const otherViewClean=!document.getElementById('appShell').classList.contains('is-calculator-view');switchView('calculator',{save:false});const calcViewMarked=document.getElementById('appShell').classList.contains('is-calculator-view');switchView('overview',{save:false});return hasMeta&&hasSidebarBtn&&otherViewClean&&calcViewMarked});
  await add('134. O eyebrow da calculadora mostra só "Calculadora odontopediátrica", sem o prefixo "Indicadores /" que as outras views mantêm',()=>{switchView('calculator',{save:false});const calcEyebrow=document.getElementById('eyebrow').textContent;switchView('pregnant',{save:false});const pregEyebrow=document.getElementById('eyebrow').textContent;switchView('overview',{save:false});return calcEyebrow==='Calculadora odontopediátrica'&&pregEyebrow.startsWith('Indicadores / ')});
  await add('135. O logotipo no topo da barra lateral usa o ícone do dente (não mais o texto "SB")',()=>{const brand=document.querySelector('.brand');return brand.textContent.trim()===''&&!!brand.querySelector('svg')});
  await add('136. Ibuprofeno calcula mg pela concentração de 50 mg/mL (2,5 mg/gota), conferida no REMUME — não mais 100 mg/mL (ex.: 20kg → 20 gotas → 50 mg, não 100 mg)',()=>{const prevCalc=state.preferences.calcPeso;state.preferences.calcPeso='20';const html=calculatorHTML();state.preferences.calcPeso=prevCalc;const d=doseGotas(20,1,2.5,40,false);return d.gotas===20&&d.mg===50&&html.includes("gotas 50 mg/mL · 6/6h")&&!html.includes("gotas 100 mg/mL")});
  await add('137. Importação de "Procedimentos Detalhado" não gera mais o aviso CBO_NOT_AVAILABLE (a pedido do usuário: os relatórios enviados já filtram só cirurgiões-dentistas) — os avisos TRUNCATED_RESTORATION e M1_QUANTITY_VS_PEOPLE continuam intactos (agora gerados em buildProcedureSnapshotFromRows, compartilhado com o CSV)',()=>{const srcPdf=parseProcedurePdf.toString(),srcShared=buildProcedureSnapshotFromRows.toString();return !srcPdf.includes('CBO_NOT_AVAILABLE')&&srcShared.includes('TRUNCATED_RESTORATION')&&srcShared.includes('M1_QUANTITY_VS_PEOPLE')});
  await add('138. firstConsultationDuplicatesForMonth detecta nome repetido dentro do mesmo arquivo (mesma primeira consulta duas vezes) e não sinaliza quem aparece uma única vez com quantidade 1',()=>{const fakeSnap={dataByMonth:{'2026-05':{firstPatients:[{name:'Maria Fulana da Silva',date:'02/05/2026',quantity:1},{name:'Maria Fulana da Silva',date:'20/05/2026',quantity:1},{name:'Joao Souza',date:'05/05/2026',quantity:1}]}}};const dupes=firstConsultationDuplicatesForMonth(fakeSnap,'2026-05');return dupes.length===1&&dupes[0].name==='Maria Fulana da Silva'&&dupes[0].occurrences.length===2&&dupes[0].totalQuantity===2&&!dupes.some(g=>g.name==='Joao Souza')});
  await add('139. firstConsultationRepeatsAcrossFiles encontra o mesmo paciente com primeira consulta em dois arquivos diferentes com menos de 12 meses de intervalo, mas não sinaliza quem só aparece em um arquivo',()=>{const before=state.snapshots.length;const u=state.preferences.unit;try{const s1={id:'t1_selftest',profile:'celk_procedimentos_detalhado',unit:u,fileName:'jan.pdf',dataByMonth:{'2026-01':{kind:'procedure',firstPatients:[{name:'Ana Paula Souza',date:'10/01/2026'}]}}};const s2={id:'t2_selftest',profile:'celk_procedimentos_detalhado',unit:u,fileName:'jun.pdf',dataByMonth:{'2026-06':{kind:'procedure',firstPatients:[{name:'Ana Paula Souza',date:'10/06/2026'}]}}};const s3={id:'t3_selftest',profile:'celk_procedimentos_detalhado',unit:u,fileName:'unico.pdf',dataByMonth:{'2026-02':{kind:'procedure',firstPatients:[{name:'Paciente Unico',date:'10/02/2026'}]}}};state.snapshots.push(s1,s2,s3);const groups=firstConsultationRepeatsAcrossFiles();const found=groups.find(g=>g.name==='Ana Paula Souza');return !!found&&found.occurrences.length===2&&!groups.some(g=>g.name==='Paciente Unico')}finally{state.snapshots.length=before}});
  await add('140. firstConsultationRepeatsAcrossFiles não sinaliza o mesmo paciente quando o intervalo entre arquivos é maior que 12 meses (365 dias)',()=>{const before=state.snapshots.length;const u=state.preferences.unit;try{const s4={id:'t4_selftest',profile:'celk_procedimentos_detalhado',unit:u,fileName:'jan26.pdf',dataByMonth:{'2026-01':{kind:'procedure',firstPatients:[{name:'Carlos Eduardo Lima',date:'01/01/2026'}]}}};const s5={id:'t5_selftest',profile:'celk_procedimentos_detalhado',unit:u,fileName:'mar27.pdf',dataByMonth:{'2027-03':{kind:'procedure',firstPatients:[{name:'Carlos Eduardo Lima',date:'10/03/2027'}]}}};state.snapshots.push(s4,s5);const groups=firstConsultationRepeatsAcrossFiles();return !groups.some(g=>g.name==='Carlos Eduardo Lima')}finally{state.snapshots.length=before}});
  await add('141. Backup Completo preserva os nomes de primeira consulta (firstPatients) usados na checagem de duplicidade M1; backup Analítico os remove',()=>{const before=state.snapshots.length;try{const snap={id:'tbk_selftest',profile:'celk_procedimentos_detalhado',fileName:'teste_backup.pdf',status:'prévia não homologada',validations:[],procedureCounts:[],dataByMonth:{'2026-07':{kind:'procedure',firstConsultations:1,firstConsultationQuantity:1,treatmentsConcluded:0,treatmentConcludedQuantity:0,preventive:0,individualProcedures:0,art:0,restorative:0,b5Denominator:0,b3Numerator:0,b3Denominator:0,procedureCounts:[],firstPatients:[{name:'Teste Backup Paciente',date:'01/07/2026'}]}}};state.snapshots.push(snap);const full=backupState('full'),analytic=backupState('analytic');const fullHas=full.snapshots.find(s=>s.id==='tbk_selftest')?.dataByMonth['2026-07'].firstPatients?.length===1;const analyticSnap=analytic.snapshots.find(s=>s.id==='tbk_selftest');const analyticStripped=!!analyticSnap&&analyticSnap.dataByMonth['2026-07'].firstPatients===undefined;return fullHas&&analyticStripped}finally{state.snapshots.length=before}});
  await add('142. A aba "Validações" de um snapshot mostra o nome completo (não mascarado) dos pacientes duplicados por trás do aviso M1_QUANTITY_VS_PEOPLE, dentro de um bloco expansível',()=>{const snap={fileName:'x.pdf',validations:[{level:'warning',code:'M1_QUANTITY_VS_PEOPLE',month:'2026-08',message:'teste'}],dataByMonth:{'2026-08':{firstPatients:[{name:'Roberta Nomecompleto Teste',date:'01/08/2026'},{name:'Roberta Nomecompleto Teste',date:'15/08/2026'}]}}};const html=validationHTML(snap);return html.includes('Roberta Nomecompleto Teste')&&html.includes('data-toggle-details')&&!html.includes(maskName('Roberta Nomecompleto Teste'))});
  await add('143. A página Diagnóstico exibe o alerta M1_REPEAT_WITHIN_12M com o nome completo do paciente repetido entre arquivos, dentro de um bloco expansível',()=>{const before=state.snapshots.length;const u=state.preferences.unit;try{const s1={id:'td1_selftest',profile:'celk_procedimentos_detalhado',unit:u,fileName:'fev.pdf',createdAt:nowISO(),status:'x',validations:[],procedureCounts:[],dataByMonth:{'2026-02':{kind:'procedure',firstPatients:[{name:'Paciente Repetido Teste',date:'02/02/2026'}]}}};const s2={id:'td2_selftest',profile:'celk_procedimentos_detalhado',unit:u,fileName:'marco.pdf',createdAt:nowISO(),status:'x',validations:[],procedureCounts:[],dataByMonth:{'2026-03':{kind:'procedure',firstPatients:[{name:'Paciente Repetido Teste',date:'02/03/2026'}]}}};state.snapshots.push(s1,s2);const html=diagnosticsHTML();return html.includes('M1_REPEAT_WITHIN_12M')&&html.includes('Paciente Repetido Teste')&&html.includes('data-toggle-details')}finally{state.snapshots.length=before}});
  await add('144. parseDate reconhece o timestamp "AAAA-MM-DD HH:MM:SS.mmm" usado pelo CSV de Procedimentos Detalhado do CELK, sem depender do parser genérico do navegador',()=>{const d=parseDate('2026-07-06 09:04:19.603');return !!d&&d.getFullYear()===2026&&d.getMonth()===6&&d.getDate()===6});
  await add('145. stripIdPrefix remove o "( id )" que o CSV do CELK antepõe a paciente/profissional/unidade, mantendo intacto um valor que já vem sem prefixo',()=>{return stripIdPrefix('( 2149034 ) ABIGAIL ALZIRA DE OLIVEIRA NETA')==='ABIGAIL ALZIRA DE OLIVEIRA NETA'&&stripIdPrefix('( 257607 ) CS MONTE SERRAT')==='CS MONTE SERRAT'&&stripIdPrefix('SEM PREFIXO')==='SEM PREFIXO'});
  await add('146. detectCSVProfile reconhece o CSV de "Procedimentos Detalhado" (Paciente/Idade/Sexo/Data/Profissional/Procedimento/Unidade/Quantidade) sem confundir com os dois perfis de CSV já suportados',()=>{const headers=['Paciente','Idade','Sexo','Data','Profissional','Procedimento','Unidade','Quantidade',''];return detectCSVProfile(headers)==='celk_procedimentos_csv'&&detectCSVProfile(['Cd Usu Cadsus','Nome','Equipe','Consulta Saude Bucal'])==='metabase_2i'&&detectCSVProfile(['Ds Unidade','Mes Referencia','Indicador','Numerador','Denominador','Resultado'])==='metabase_esb'});
  await add('147. pickDominantUnit escolhe a unidade majoritária de um CSV como unidade do snapshot e apenas reporta (sem excluir) quantas linhas tinham outra unidade de origem registrada (o PDF nunca mistura unidade porque cada relatório já é de uma unidade só)',()=>{const rows=[{unitOrigin:'CS MONTE SERRAT'},{unitOrigin:'CS MONTE SERRAT'},{unitOrigin:'CS MONTE SERRAT'},{unitOrigin:'CS CAPOEIRAS'}];const {keepUnit,otherUnitCounts}=pickDominantUnit(rows);return keepUnit==='CS MONTE SERRAT'&&otherUnitCounts['CS CAPOEIRAS']===1&&Object.keys(otherUnitCounts).length===1});
  await add('148. buildProcedureSnapshotFromRows (motor compartilhado por PDF e CSV) calcula M1/M2/M4 corretamente a partir de linhas sintéticas, sem depender de página/coordenadas do PDF',()=>{const snap={dataByMonth:{},procedureCounts:[],validations:[]};const rows=[{patient:'Fulana da Silva',date:'05/06/2026',professional:'Caio',procedure:'PRIMEIRA CONSULTA ODONTOLOGICA PROGRAMÁTICA',quantity:1},{patient:'Beltrano Souza',date:'10/06/2026',professional:'Caio',procedure:'PRIMEIRA CONSULTA ODONTOLOGICA PROGRAMÁTICA',quantity:1},{patient:'Fulana da Silva',date:'20/06/2026',professional:'Caio',procedure:'TRATAMENTO CONCLUIDO',quantity:1},{patient:'Beltrano Souza',date:'12/06/2026',professional:'Caio',procedure:'RESTAURAÇÃO DE DENTE PERMANENTE ANTERIOR COM RESINA COMPOSTA',quantity:1},{patient:'Ciclana Lima',date:'15/06/2026',professional:'Caio',procedure:'AFERIÇÃO DE PRESSÃO ARTERIAL',quantity:1}];buildProcedureSnapshotFromRows(snap,rows);const m=snap.dataByMonth['2026-06'];return m.firstConsultations===2&&m.firstConsultationQuantity===2&&m.treatmentsConcluded===1&&m.restorative===1&&m.individualProcedures===2&&!snap.validations.some(v=>v.code==='M1_QUANTITY_VS_PEOPLE')&&snap.procedureCounts.some(p=>p.sigtap==='03.07.01.003-1'&&!p.ambiguous)&&!snap.validations.some(v=>v.code==='TRUNCATED_RESTORATION')});
  await add('149. buildProcedureSnapshotFromRows dispara M1_QUANTITY_VS_PEOPLE quando a mesma pessoa aparece duas vezes como primeira consulta no mesmo mês, e guarda os dois registros em firstPatients',()=>{const snap={dataByMonth:{},procedureCounts:[],validations:[]};const rows=[{patient:'Fulana da Silva',date:'05/07/2026',professional:'Caio',procedure:'PRIMEIRA CONSULTA ODONTOLOGICA PROGRAMÁTICA',quantity:1},{patient:'Fulana da Silva',date:'20/07/2026',professional:'Caio',procedure:'PRIMEIRA CONSULTA ODONTOLOGICA PROGRAMÁTICA',quantity:1}];buildProcedureSnapshotFromRows(snap,rows);const m=snap.dataByMonth['2026-07'];return m.firstConsultations===1&&m.firstConsultationQuantity===2&&m.firstPatients.length===2&&snap.validations.some(v=>v.code==='M1_QUANTITY_VS_PEOPLE'&&v.month==='2026-07')});
  await add('150. Importação de CSV com o perfil "celk_procedimentos_csv" é despachada para parseProcedureCsv, que gera o aviso informativo CSV_OTHER_UNIT_COUNTED (não exclui nada) quando há mais de uma unidade de origem no arquivo',()=>{const srcImport=importOne.toString(),srcParse=parseProcedureCsv.toString();return srcImport.includes('celk_procedimentos_csv')&&srcImport.includes('parseProcedureCsv')&&srcParse.includes('CSV_OTHER_UNIT_COUNTED')});
  await add('150b. parseProcedureCsv conta TODAS as linhas do arquivo na produção da unidade majoritária, inclusive as de pacientes/profissionais com outra unidade de origem registrada — nenhuma linha é descartada (correção explícita: se está no mesmo documento, o atendimento foi na unidade majoritária)',async()=>{const csv=['Paciente,Idade,Sexo,Data,Profissional,Procedimento,Unidade,Quantidade','( 1 ) Fulana da Silva,30,F,2026-07-05 09:00:00.000,( 9 ) Caio,PRIMEIRA CONSULTA ODONTOLOGICA PROGRAMÁTICA,( 100 ) CS MONTE SERRAT,1.0','( 2 ) Beltrano Souza,40,M,2026-07-06 09:00:00.000,( 9 ) Caio,PRIMEIRA CONSULTA ODONTOLOGICA PROGRAMÁTICA,( 100 ) CS MONTE SERRAT,1.0','( 3 ) Ciclana Lima,50,F,2026-07-07 09:00:00.000,( 9 ) Caio,PRIMEIRA CONSULTA ODONTOLOGICA PROGRAMÁTICA,( 200 ) CS OUTRA UNIDADE,1.0'].join('\n');const fakeFile={name:'teste.csv'};const snap=await parseProcedureCsv(fakeFile,'hash_selftest_150b',csv);const m=snap.dataByMonth['2026-07'];const v=snap.validations.find(v=>v.code==='CSV_OTHER_UNIT_COUNTED');return snap.unit==='CS MONTE SERRAT'&&m.firstConsultations===3&&m.firstConsultationQuantity===3&&!!v&&v.message.includes('CS OUTRA UNIDADE')&&!v.message.toLowerCase().includes('ignorad')&&v.message.toLowerCase().includes('nenhuma linha foi descartada')});
  await add('151. A amostra bruta de um snapshot de procedimentos mostra a referência da linha de origem (sourceRef) tanto para PDF ("p.X · y Y") quanto para CSV ("linha N")',()=>{const fakeId='rawtest_selftest';sessionRaw.set(fakeId,{type:'procedure',rows:[{sourceRef:'linha 5',patientMasked:'F•••• S••••',date:'05/07/2026',professional:'Caio',procedure:'TESTE',unitOrigin:'CS MONTE SERRAT',quantity:1}]});try{const html=rawSampleHTML({id:fakeId});return html.includes('linha 5')}finally{sessionRaw.delete(fakeId)}});
  await add('152. firstConsultationDuplicatesForMonth também sinaliza quem tem uma única linha de "primeira consulta", mas com quantidade maior que 1 nela — achado real ao importar o CSV do CELK (mesma pessoa, mesma linha, quantidade 2), sem precisar de nome repetido em linhas diferentes',()=>{const fakeSnap={dataByMonth:{'2026-07':{firstPatients:[{name:'Alana Vaz de Jesus',date:'14/07/2026',quantity:2},{name:'Outra Pessoa Unica',date:'10/07/2026',quantity:1}]}}};const dupes=firstConsultationDuplicatesForMonth(fakeSnap,'2026-07');const alana=dupes.find(g=>g.name==='Alana Vaz de Jesus');return !!alana&&alana.occurrences.length===1&&alana.totalQuantity===2&&!dupes.some(g=>g.name==='Outra Pessoa Unica')});
  await add('153. Backup Completo preserva a quantidade por linha dentro de firstPatients (necessária para explicar a diferença do M1_QUANTITY_VS_PEOPLE); backup Analítico remove firstPatients inteiro, então a quantidade some junto',()=>{const before=state.snapshots.length;try{const snap={id:'tbkq_selftest',profile:'celk_procedimentos_detalhado',fileName:'teste_backup_qty.csv',status:'prévia não homologada',validations:[],procedureCounts:[],dataByMonth:{'2026-07':{kind:'procedure',firstConsultations:1,firstConsultationQuantity:2,treatmentsConcluded:0,treatmentConcludedQuantity:0,preventive:0,individualProcedures:0,art:0,restorative:0,b5Denominator:0,b3Numerator:0,b3Denominator:0,procedureCounts:[],firstPatients:[{name:'Teste Quantidade',date:'01/07/2026',quantity:2}]}}};state.snapshots.push(snap);const full=backupState('full');const fullQty=full.snapshots.find(s=>s.id==='tbkq_selftest')?.dataByMonth['2026-07'].firstPatients?.[0]?.quantity;return fullQty===2}finally{state.snapshots.length=before}});
  await add('154. detectCSVProfile reconhece o CSV de "Relação das Atividades em Grupo" (Unidade/Código da Atividade/Assunto/Nome dos Participantes/Data Nascimento) sem confundir com os três perfis de CSV já suportados',()=>{const headers=['Unidade','Cnes','INE','Nome da Equipe','Data','Turno','Código da Atividade','Situação','Público Alvo','Temas','Práticas','Profissionais','Tipo de Atividade','Nr. INEP','Assunto','Local Atividade','Nome dos Participantes','CNS','CPF','Data Nascimento','Sexo'];return detectCSVProfile(headers)==='celk_atividades_grupo_csv'&&detectCSVProfile(['Paciente','Idade','Sexo','Data','Profissional','Procedimento','Unidade','Quantidade'])==='celk_procedimentos_csv'&&detectCSVProfile(['Cd Usu Cadsus','Nome','Equipe','Consulta Saude Bucal'])==='metabase_2i'&&detectCSVProfile(['Ds Unidade','Mes Referencia','Indicador','Numerador','Denominador','Resultado'])==='metabase_esb'});
  await add('155. buildGroupSnapshotFromEvents (motor compartilhado por PDF e CSV de Atividades em Grupo) soma "present" por evento de escovação supervisionada e conta toda atividade em "activities", a partir de eventos sintéticos já no nível de uma atividade',()=>{const snap={dataByMonth:{}};const events=[{date:'10/06/2026',subject:'Escovação Supervisionada',present:5,status:'Concluída'},{date:'11/06/2026',subject:'Reunião de Equipe',present:null,status:'Concluída'}];buildGroupSnapshotFromEvents(snap,events);const m=snap.dataByMonth['2026-06'];return m.activities===2&&m.eligibleActivities===1&&m.supervisedBrushingPresent===5&&m.brushingEvents.length===1});
  await add('156. parseGroupCsv calcula a idade real de cada participante na data da atividade (não usa Idade/Público Alvo do CSV) e só conta no numerador de M3/B4 quem está entre 6 e 11 anos — inclusive o caso-limite de completar 12 anos no próprio dia da atividade, que já fica de fora',async()=>{const csv=['Unidade,Data,Código da Atividade,Assunto,Nome dos Participantes,Data Nascimento','CS MONTE SERRAT,2026-06-10 09:00:00.0,ACT1,Escovação Supervisionada,Participante A,2018-06-01','CS MONTE SERRAT,2026-06-10 09:00:00.0,ACT1,escovação supervisionada,Participante B,2014-06-15','CS MONTE SERRAT,2026-06-10 09:00:00.0,ACT1,Escovação Supervisionada,Participante C,2014-06-01','CS MONTE SERRAT,2026-06-10 09:00:00.0,ACT1,Escovação Supervisionada,Participante D,2021-01-01','CS MONTE SERRAT,2026-06-11 10:00:00.0,ACT2,Reunião de Equipe,Participante E,1980-01-01'].join('\n');const fakeFile={name:'grupo_teste.csv'};const snap=await parseGroupCsv(fakeFile,'hash_selftest_156',csv);const m=snap.dataByMonth['2026-06'];const v=snap.validations.find(x=>x.code==='GROUP_AGE_FILTERED');return m.activities===2&&m.eligibleActivities===1&&m.supervisedBrushingPresent===2&&!!v&&v.message.includes('2 participante')});
  await add('157. Importação de CSV com o perfil "celk_atividades_grupo_csv" é despachada para parseGroupCsv, que grava o snapshot com o MESMO profile do PDF (celk_atividades_grupo) — mesma dedução já usada em Procedimentos Detalhado, para PDF e CSV do mesmo relatório se substituírem em vez de somar em dobro',()=>{const srcImport=importOne.toString(),srcParse=parseGroupCsv.toString();return srcImport.includes('celk_atividades_grupo_csv')&&srcImport.includes('parseGroupCsv')&&srcParse.includes("'celk_atividades_grupo'")});
  await add('158. A amostra bruta de um snapshot de Atividades em Grupo importado via CSV mostra o participante mascarado, a idade calculada e a elegibilidade (6–11), sem expor o nome completo',()=>{const fakeId='rawtest_group_selftest';sessionRaw.set(fakeId,{type:'group_csv',rows:[{sourceRef:'linha 3',date:'10/06/2026',subject:'Escovação Supervisionada',participantMasked:'P•••••••• A',age:8,eligible:true,activityCode:'ACT1'}]});try{const html=rawSampleHTML({id:fakeId});return html.includes('linha 3')&&html.includes('P•••••••• A')&&html.includes('Sim')&&!html.includes('Participante A')}finally{sessionRaw.delete(fakeId)}});
  await add('159. parseGroupCsv também conta (sem excluir) linhas com outra unidade cadastrada, igual à correção da v1.34 em Procedimentos Detalhado — mesmo padrão reaproveitado via pickDominantUnit',async()=>{const csv=['Unidade,Data,Código da Atividade,Assunto,Nome dos Participantes,Data Nascimento','CS MONTE SERRAT,2026-06-10 09:00:00.0,ACT1,Escovação Supervisionada,Participante A,2018-06-01','CS MONTE SERRAT,2026-06-10 09:00:00.0,ACT1,Escovação Supervisionada,Participante B,2018-06-01','CS OUTRA UNIDADE,2026-06-10 09:00:00.0,ACT1,Escovação Supervisionada,Participante C,2018-06-01'].join('\n');const fakeFile={name:'grupo_teste2.csv'};const snap=await parseGroupCsv(fakeFile,'hash_selftest_159',csv);const m=snap.dataByMonth['2026-06'];const v=snap.validations.find(x=>x.code==='CSV_OTHER_UNIT_COUNTED');return snap.unit==='CS MONTE SERRAT'&&m.supervisedBrushingPresent===3&&!!v&&v.message.includes('CS OUTRA UNIDADE')});
  await add('160. reconcileNominalRole só conta 1 ocorrência por pessoa a cada 12 meses — exatamente 365 dias de intervalo ainda conta, 364 dias já é excluído (regra pedida pelo usuário: 1 primeira consulta por pessoa por ano, considerando 12 meses entre uma ocorrência e outra)',()=>{const before=state.snapshots.length;const u=state.preferences.unit;try{const s1={id:'trec1_selftest',profile:'celk_procedimentos_detalhado',unit:u,fileName:'a.pdf',dataByMonth:{'2026-01':{kind:'procedure',firstPatients:[{name:'Zeca Boundary',date:'10/01/2026'},{name:'Rita Excluida',date:'10/01/2026'}]}}};const s2={id:'trec2_selftest',profile:'celk_procedimentos_detalhado',unit:u,fileName:'b.pdf',dataByMonth:{'2027-01':{kind:'procedure',firstPatients:[{name:'Zeca Boundary',date:'10/01/2027'},{name:'Rita Excluida',date:'09/01/2027'}]}}};state.snapshots.push(s1,s2);const {countedByMonth,excludedByMonth}=reconcileNominalRole(u,'firstPatients');return countedByMonth['2026-01']===2&&countedByMonth['2027-01']===1&&(excludedByMonth['2027-01']||[]).length===1&&excludedByMonth['2027-01'][0].name==='Rita Excluida'}finally{state.snapshots.length=before}});
  await add('161. reconcileNominalRole ancora a janela de 12 meses na última ocorrência CONTADA, não na última ocorrência bruta — uma repetição a ~200 dias fica excluída, mas a seguinte, a 400 dias da 1ª (mesmo estando a só ~200 dias da excluída), volta a contar',()=>{const before=state.snapshots.length;const u=state.preferences.unit;try{const s1={id:'tchain1_selftest',profile:'celk_procedimentos_detalhado',unit:u,fileName:'a.pdf',dataByMonth:{'2026-01':{kind:'procedure',firstPatients:[{name:'Chain Testes',date:'10/01/2026'}]}}};const s2={id:'tchain2_selftest',profile:'celk_procedimentos_detalhado',unit:u,fileName:'b.pdf',dataByMonth:{'2026-07':{kind:'procedure',firstPatients:[{name:'Chain Testes',date:'29/07/2026'}]}}};const s3={id:'tchain3_selftest',profile:'celk_procedimentos_detalhado',unit:u,fileName:'c.pdf',dataByMonth:{'2027-02':{kind:'procedure',firstPatients:[{name:'Chain Testes',date:'14/02/2027'}]}}};state.snapshots.push(s1,s2,s3);const {countedByMonth,excludedByMonth}=reconcileNominalRole(u,'firstPatients');return countedByMonth['2026-01']===1&&!countedByMonth['2026-07']&&countedByMonth['2027-02']===1&&(excludedByMonth['2026-07']||[]).length===1}finally{state.snapshots.length=before}});
  await add('162. aggregateProcedureMonth substitui firstConsultations pela contagem deduzida de 12 meses (não a bruta do mês) — pedido explícito do usuário para não contar a mesma pessoa de novo antes de completar 1 ano; firstConsultationQuantity continua bruta, sem mudança (é só para a checagem de qualidade M1_QUANTITY_VS_PEOPLE)',()=>{const before=state.snapshots.length;const u=state.preferences.unit;try{const base={firstConsultations:1,firstConsultationQuantity:1,treatmentsConcluded:0,treatmentConcludedQuantity:0,preventive:0,individualProcedures:0,art:0,restorative:0,b5Denominator:0,b3Numerator:0,b3Denominator:0,procedureCounts:[]};const s1={id:'tagg1_selftest',profile:'celk_procedimentos_detalhado',unit:u,fileName:'a.pdf',dataByMonth:{'2026-01':{...base,kind:'procedure',firstPatients:[{name:'Repetida Teste',date:'10/01/2026',quantity:1}]}}};const s2={id:'tagg2_selftest',profile:'celk_procedimentos_detalhado',unit:u,fileName:'b.pdf',dataByMonth:{'2026-03':{...base,kind:'procedure',firstPatients:[{name:'Repetida Teste',date:'10/03/2026',quantity:1}]}}};state.snapshots.push(s1,s2);const m1=aggregateProcedureMonth('2026-01',u),m2=aggregateProcedureMonth('2026-03',u);return m1.firstConsultations===1&&m2.firstConsultations===0&&m2.firstConsultationQuantity===1&&m2.firstConsultationsExcluded.length===1&&m2.firstConsultationsExcluded[0].name==='Repetida Teste'}finally{state.snapshots.length=before}});
  await add('163. aggregateProcedureMonth aplica a mesma dedução de 12 meses a treatmentsConcluded (tratamento concluído/M2), a pedido explícito do usuário ("o mesmo vale para tratamento concluído")',()=>{const before=state.snapshots.length;const u=state.preferences.unit;try{const base={firstConsultations:0,firstConsultationQuantity:0,treatmentsConcluded:1,treatmentConcludedQuantity:1,preventive:0,individualProcedures:0,art:0,restorative:0,b5Denominator:0,b3Numerator:0,b3Denominator:0,procedureCounts:[],firstPatients:[]};const s1={id:'tagg3_selftest',profile:'celk_procedimentos_detalhado',unit:u,fileName:'a.pdf',dataByMonth:{'2026-01':{...base,kind:'procedure',concludedPatients:[{name:'Concluido Repetido',date:'10/01/2026',quantity:1}]}}};const s2={id:'tagg4_selftest',profile:'celk_procedimentos_detalhado',unit:u,fileName:'b.pdf',dataByMonth:{'2026-05':{...base,kind:'procedure',concludedPatients:[{name:'Concluido Repetido',date:'10/05/2026',quantity:1}]}}};state.snapshots.push(s1,s2);const m1=aggregateProcedureMonth('2026-01',u),m2=aggregateProcedureMonth('2026-05',u);return m1.treatmentsConcluded===1&&m2.treatmentsConcluded===0&&m2.treatmentConcludedQuantity===1&&m2.treatmentsConcludedExcluded.length===1}finally{state.snapshots.length=before}});
  await add('164. A página Diagnóstico mostra M1_REPEAT_WITHIN_12M e M2_REPEAT_WITHIN_12M com o bloco expansível marcando qual ocorrência foi excluída do numerador e qual foi contada',()=>{const before=state.snapshots.length;const u=state.preferences.unit;try{const s1={id:'tdiag1_selftest',profile:'celk_procedimentos_detalhado',unit:u,fileName:'a.pdf',createdAt:nowISO(),status:'x',validations:[],procedureCounts:[],dataByMonth:{'2026-01':{kind:'procedure',firstPatients:[{name:'Diag Primeira',date:'10/01/2026'}],concludedPatients:[{name:'Diag Concluida',date:'10/01/2026'}]}}};const s2={id:'tdiag2_selftest',profile:'celk_procedimentos_detalhado',unit:u,fileName:'b.pdf',createdAt:nowISO(),status:'x',validations:[],procedureCounts:[],dataByMonth:{'2026-03':{kind:'procedure',firstPatients:[{name:'Diag Primeira',date:'10/03/2026'}],concludedPatients:[{name:'Diag Concluida',date:'10/03/2026'}]}}};state.snapshots.push(s1,s2);const html=diagnosticsHTML();return html.includes('M1_REPEAT_WITHIN_12M')&&html.includes('M2_REPEAT_WITHIN_12M')&&html.includes('Diag Primeira')&&html.includes('Diag Concluida')&&html.includes('excluída do numerador')&&html.includes('contada')}finally{state.snapshots.length=before}});
  await add('165. Backup Completo preserva concludedPatients (necessário para a dedução de 12 meses de M2); backup Analítico remove firstPatients e concludedPatients dos dois',()=>{const before=state.snapshots.length;try{const snap={id:'tbk2_selftest',profile:'celk_procedimentos_detalhado',fileName:'teste_backup2.pdf',status:'prévia não homologada',validations:[],procedureCounts:[],dataByMonth:{'2026-07':{kind:'procedure',firstConsultations:1,firstConsultationQuantity:1,treatmentsConcluded:1,treatmentConcludedQuantity:1,preventive:0,individualProcedures:0,art:0,restorative:0,b5Denominator:0,b3Numerator:0,b3Denominator:0,procedureCounts:[],firstPatients:[{name:'Teste Backup Paciente',date:'01/07/2026'}],concludedPatients:[{name:'Teste Backup Concluido',date:'01/07/2026'}]}}};state.snapshots.push(snap);const full=backupState('full'),analytic=backupState('analytic');const fullOk=full.snapshots.find(s=>s.id==='tbk2_selftest')?.dataByMonth['2026-07'].concludedPatients?.length===1;const analyticSnap=analytic.snapshots.find(s=>s.id==='tbk2_selftest');const analyticOk=!!analyticSnap&&analyticSnap.dataByMonth['2026-07'].firstPatients===undefined&&analyticSnap.dataByMonth['2026-07'].concludedPatients===undefined;return fullOk&&analyticOk}finally{state.snapshots.length=before}});
  await add('166. hasM1PatientData (aciona o aviso de dado nominal no modal de backup) também detecta quando só há concludedPatients, sem firstPatients',()=>{const before=state.snapshots.length;try{const snap={id:'thas1_selftest',profile:'celk_procedimentos_detalhado',fileName:'teste.pdf',status:'x',validations:[],procedureCounts:[],dataByMonth:{'2026-07':{kind:'procedure',firstPatients:[],concludedPatients:[{name:'Só Concluido',date:'01/07/2026'}]}}};state.snapshots.push(snap);return hasM1PatientData()===true}finally{state.snapshots.length=before}});
  await add('167. Células federais da matriz usam a paleta federal própria (federalZoneClass → fed-otimo/fed-bom/fed-suficiente/fed-regular), nunca as zonas municipais — mantém a decisão de paleta federal própria confirmada na v1.21',()=>{const cells=[1.5,0.9,0.4,0.1].map(v=>mxCellHTML('federal','B1',v));return cells[0].includes('fed-otimo')&&cells[1].includes('fed-bom')&&cells[2].includes('fed-suficiente')&&cells[3].includes('fed-regular')&&cells.every(c=>!c.includes('mz-'))&&federalZoneClass('B1',1.5)==='fed-otimo'&&federalZoneClass('B1',0.1)==='fed-regular'});
  await add('168. Célula federal da matriz marca o mês em foco, o mês que ainda não chegou e o mês sem dado — mesmo padrão da célula municipal (teste 94)',()=>{const a=mxCellHTML('federal','B1',1.5,{focus:true}),c=mxCellHTML('federal','B1',null),d=mxCellHTML('federal','B1',null,{future:true});return a.includes('fed-otimo focus')&&a.includes('Ótimo')&&c.includes('missing')&&c.includes('sem dado')&&d.includes('future')&&d.includes('a chegar')});
  await add('169. federalQuadrimestralOutlook devolve rótulo/classe de pill válidos para os 6 indicadores federais, com ou sem dados carregados, e o detalhe deixa explícito o motivo (cálculo de conveniência para a maioria; média dos 4 meses para B1/B4)',()=>{const classes=['success','bad','neutral','warn','good'];return ['B1','B2','B3','B4','B5','B6'].every(id=>{const q=quarterFederal(id),r=federalQuadrimestralOutlook(id,q);return classes.includes(r.cls)&&typeof r.label==='string'&&r.label.length>0&&typeof r.detail==='string'&&(r.detail.includes('conveniência')||r.detail.includes('dados suficientes')||r.detail.includes('denominador'))})});
  await add('170. federalHTML tem a "Apuração do quadrimestre" com a coluna "Para subir de faixa" e deixa claro que o quadrimestre é cálculo de conveniência, sem afirmar que a ferramenta "não inventa resultado federal quadrimestral"',()=>{const html=federalHTML();return html.includes('Apuração do quadrimestre')&&html.includes('Para subir de faixa')&&!html.includes('não inventa resultado federal quadrimestral')&&html.includes('cálculo de conveniência')});
  await add('172. detectCSVProfile reconhece o CSV de "População ativa no SUS municipal" (Data Studio) pelos cabeçalhos faixa_etaria + Todos os serviços, sem confundir com os perfis de CSV já suportados',()=>{return detectCSVProfile(['faixa_etaria','Todos os serviços','Consultas Méd/Enf/Odonto','Consultas Méd/Enf/Odonto com CPF e Equipe'])==='metabase_populacao_ativa'&&detectCSVProfile(['Cd Usu Cadsus','Nome','Equipe','Consulta Saude Bucal'])==='metabase_2i'});
  await add('173. parsePopulacaoAtivaCSV soma a coluna "Todos os serviços" de todas as faixas etárias; o CSV não tem competência própria, então não popula dataByMonth — vira sugestão de M1/B1 só depois de confirmar ESF/dentistas/vigência',async()=>{const csv=['faixa_etaria,Todos os serviços,Consultas Méd/Enf/Odonto,Consultas Méd/Enf/Odonto com CPF e Equipe','00-04,587,490,481','05-09,624,500,497','90-mais,78,40,40'].join('\n');const fakeFile={name:'populacao_teste.csv'};const snap=await parsePopulacaoAtivaCSV(fakeFile,'hash_selftest_pop1',csv);return snap.profile==='metabase_populacao_ativa'&&snap.population.totalPopulation===587+624+78&&snap.population.bands.length===3&&Object.keys(snap.dataByMonth).length===0&&snap.validations.some(v=>v.code==='POPULATION_IMPORTED')});
  await add('174. suggestedM1FromPopulation calcula população ÷ ESF × dentistas só dentro da vigência confirmada; fora da vigência (ou sem registro) não sugere nada',()=>{const before=state.populationInputs.length,u=state.preferences.unit;try{state.populationInputs.push({id:'tpop1_selftest',snapshotId:'x',fileName:'pop.csv',unit:u,totalPopulation:10000,esfCount:5,dentistCount:2,start:'2026-01',end:'2026-06',createdAt:nowISO()});const inRange=suggestedM1FromPopulation('2026-03'),outRange=suggestedM1FromPopulation('2026-09');return inRange===10000/5*2&&outRange===null}finally{state.populationInputs.length=before}});
  await add('175. A conta pela população ativa só aparece para M1 (nunca para M3/B4, pedido explícito do usuário de não usar esse CSV em M3/B4); o link do Data Studio fica no bloco de denominadores da página Municipal; o campo digitado mostra o valor já confirmado para a vigência',()=>{const beforePop=state.populationInputs.length,beforeDenom=state.denominators.length,u=state.preferences.unit,mk=state.preferences.month;try{state.populationInputs.push({id:'tpop2_selftest',snapshotId:'x',fileName:'pop.csv',unit:u,totalPopulation:10000,esfCount:5,dentistCount:2,start:mk,end:mk,createdAt:nowISO()});state.denominators.push({id:'tden2_selftest',indicator:'M1',scope:'municipal',value:999,start:mk,end:mk,unit:u,origin:'teste',confirmed:true,updatedAt:nowISO(),ruleVersion:RULE_VERSION});const m1=ovDenomSection('M1',mk),m3=ovDenomSection('M3',mk),page=municipalHTML();return m1.includes('id="ovPop"')&&m1.includes('value="999"')&&!m3.includes('id="ovPop"')&&page.includes(POPULATION_CSV_SOURCE_URL)&&page.includes('10.000 pessoas ÷ 5 ESF × 2 dentistas')}finally{state.populationInputs.length=beforePop;state.denominators.length=beforeDenom}});
  await add('176. cumulativeMunicipal mantém o denominador de M1/M3 fixo no mês em foco (não soma os 4 meses do quadrimestre) — só o numerador soma, a pedido explícito do usuário (v1.38)',()=>{const beforeSnaps=state.snapshots.length,beforeDenoms=state.denominators.length,u=state.preferences.unit,prevMonth=state.preferences.month;try{const months=quarterMonths(state.preferences.year,state.preferences.quarter),ref=months[months.length-1];state.preferences.month=ref;state.denominators.push({id:'tden_ref_selftest',indicator:'M1',scope:'municipal',value:2000,start:ref,end:ref,unit:u,origin:'teste',confirmed:true,updatedAt:nowISO(),ruleVersion:RULE_VERSION});for(const mk of months)if(mk!==ref)state.denominators.push({id:`tden_${mk}_selftest`,indicator:'M1',scope:'municipal',value:1000,start:mk,end:mk,unit:u,origin:'teste',confirmed:true,updatedAt:nowISO(),ruleVersion:RULE_VERSION});const base={firstConsultations:1,firstConsultationQuantity:1,treatmentsConcluded:0,treatmentConcludedQuantity:0,preventive:0,individualProcedures:0,art:0,restorative:0,b5Denominator:0,b3Numerator:0,b3Denominator:0,procedureCounts:[],concludedPatients:[]};months.forEach((mk,i)=>{state.snapshots.push({id:`tcum_${mk}_selftest`,profile:'celk_procedimentos_detalhado',unit:u,fileName:`${mk}.csv`,createdAt:nowISO(),dataByMonth:{[mk]:{...base,kind:'procedure',firstPatients:[{name:`Paciente Cum ${i}`,date:`10/${mk.slice(5)}/${mk.slice(0,4)}`}]}}})});const cum=cumulativeMunicipal('M1',months);return cum.numerator===4&&cum.denominator===2000&&Math.abs(cum.result-100*4/2000)<1e-9}finally{state.snapshots.length=beforeSnaps;state.denominators.length=beforeDenoms;state.preferences.month=prevMonth}});
  await add('177. cumulativeFederal usa a média dos 4 meses para B1/B4 no quadrimestre (como M1/M3, v2.16): meses de 0,1%, 0,1%, 0,1% e 0,05% dão 0,0875%, não a soma dos numeradores sobre um denominador só; o denominador de referência é o do mês em foco e o detalhe cita a média',()=>{const beforeSnaps=state.snapshots.length,beforeDenoms=state.denominators.length,u=state.preferences.unit,prevMonth=state.preferences.month;try{const months=quarterMonths(state.preferences.year,state.preferences.quarter),ref=months[months.length-1];state.preferences.month=ref;state.denominators.push({id:'tdenf_ref_selftest',indicator:'M1',scope:'municipal',value:2000,start:ref,end:ref,unit:u,origin:'teste',confirmed:true,updatedAt:nowISO(),ruleVersion:RULE_VERSION});for(const mk of months)if(mk!==ref)state.denominators.push({id:`tdenf_${mk}_selftest`,indicator:'M1',scope:'municipal',value:1000,start:mk,end:mk,unit:u,origin:'teste',confirmed:true,updatedAt:nowISO(),ruleVersion:RULE_VERSION});const base={firstConsultations:1,firstConsultationQuantity:1,treatmentsConcluded:0,treatmentConcludedQuantity:0,preventive:0,individualProcedures:0,art:0,restorative:0,b5Denominator:0,b3Numerator:0,b3Denominator:0,procedureCounts:[],concludedPatients:[]};months.forEach((mk,i)=>{state.snapshots.push({id:`tcumf_${mk}_selftest`,profile:'celk_procedimentos_detalhado',unit:u,fileName:`${mk}.csv`,createdAt:nowISO(),dataByMonth:{[mk]:{...base,kind:'procedure',firstPatients:[{name:`Paciente CumFed ${i}`,date:`12/${mk.slice(5)}/${mk.slice(0,4)}`}]}}})});const q={id:'B1',months,values:months.map(m=>federalComponents('B1',m))};const cum=cumulativeFederal('B1',months),outlook=federalQuadrimestralOutlook('B1',q);return cum.numerator===4&&cum.denominator===2000&&cum.average===true&&Math.abs(cum.result-0.0875)<1e-9&&outlook.detail.includes('média dos 4 meses')&&outlook.label==='Regular'}finally{state.snapshots.length=beforeSnaps;state.denominators.length=beforeDenoms;state.preferences.month=prevMonth}});
  await add('178. cumulativeFederal só usa a média dos 4 meses para B1/B4 — B2, B3, B5 e B6 continuam somando numerador e denominador dos 4 meses normalmente (o usuário confirmou que esses quatro "estão certos")',()=>{const src=cumulativeFederal.toString();return (src.includes("['B1','B4']")||src.includes('["B1","B4"]'))&&!/\[.?B1.?,.?B4.?,.?B2.?\]/.test(src)});
  await add('179. confirmPopulationInput já calcula e confirma o denominador de M1 automaticamente ao informar ESF/dentistas — sem exigir clique em "usar sugestão" no painel Municipal (pedido explícito do usuário, v1.39)',()=>{const beforePop=state.populationInputs.length,beforeDen=state.denominators.length,mk=state.preferences.month;try{const snap={id:'tsnap179_selftest',fileName:'pop179.csv',unit:state.preferences.unit,population:{totalPopulation:10000,bands:[{}]}};const {record,suggested}=confirmPopulationInput(snap,5,2,mk,mk);const den=state.denominators.find(d=>d.id===record.denomRecordId);return suggested===10000/5*2&&!!den&&den.value===suggested&&den.confirmed===true&&den.scope==='municipal'&&den.indicator==='M1'&&getDenominator('M1','municipal',mk).value===suggested}finally{state.populationInputs.length=beforePop;state.denominators.length=beforeDen}});
  await add('180. Reeditar a mesma população ativa (mesmo snapshot, ex.: corrigindo a quantidade de ESF) atualiza o denominador de M1 já criado, em vez de duplicar um novo registro',()=>{const beforePop=state.populationInputs.length,beforeDen=state.denominators.length,mk=state.preferences.month;try{const snap={id:'tsnap180_selftest',fileName:'pop180.csv',unit:state.preferences.unit,population:{totalPopulation:10000,bands:[{}]}};const first=confirmPopulationInput(snap,5,2,mk,mk);const second=confirmPopulationInput(snap,4,2,mk,mk);return state.populationInputs.length===beforePop+1&&state.denominators.length===beforeDen+1&&second.record.denomRecordId===first.record.denomRecordId&&second.suggested===10000/4*2}finally{state.populationInputs.length=beforePop;state.denominators.length=beforeDen}});
  await add('181. isQuarterOver decide pela data real do sistema (não pelo "mês em foco" selecionado) se o quadrimestre já terminou',()=>{return isQuarterOver(['2020-01','2020-02','2020-03','2020-04'])===true&&isQuarterOver(['2099-01','2099-02','2099-03','2099-04'])===false});
  await add('182. quadrimestralOutlook (M1/M3) decide "meta garantida" pela MÉDIA dos 4 meses (mesma base da coluna Parcial) — não pela soma cumulativa, que inflaria um denominador fixo até 4x e bateria a meta indevidamente (pedido explícito do usuário, v1.39)',()=>{const q={id:'M1',months:['2020-01','2020-02','2020-03','2020-04'],values:[{result:.4,numerator:8,denominator:2000},{result:.4,numerator:8,denominator:2000},{result:.4,numerator:8,denominator:2000},{result:.4,numerator:8,denominator:2000}]};const outlook=quadrimestralOutlook('M1',q);return quarterPartial(q)===.4&&outlook.label!=='Meta garantida'&&outlook.cls!=='success'});
  await add('183. Projeção do quadrimestre troca o tempo verbal conforme a data real de hoje (não o "mês em foco"): passado ("Faltou"/quadrimestre encerrado) depois do último mês, futuro ("Ainda faltam") enquanto ainda há tempo',()=>{const beforeDen=state.denominators.length,u=state.preferences.unit,mk=state.preferences.month;try{state.denominators.push({id:'tden183_selftest',indicator:'M1',scope:'municipal',value:2000,start:mk,end:mk,unit:u,origin:'teste',confirmed:true,updatedAt:nowISO(),ruleVersion:RULE_VERSION});const base={result:.4,numerator:8,denominator:2000};const past=quadrimestralOutlook('M1',{id:'M1',months:['2020-01','2020-02','2020-03','2020-04'],values:[base,base,base,base]});const future=quadrimestralOutlook('M1',{id:'M1',months:['2099-01','2099-02','2099-03','2099-04'],values:[base,base,base,base]});return past.label==='Meta vencida e não cumprida'&&/Falt(ou|aram)/.test(past.detail)&&future.label!=='Meta vencida e não cumprida'&&future.detail.includes('Ainda faltam')}finally{state.denominators.length=beforeDen}});
  await add('184. metaProgress (Visão Geral) usa a MÉDIA do quadrimestre para M1 — mesma base de quadrimestralOutlook — mesmo com denominador diferente em cada mês, e não a soma cumulativa sobre um denominador fixo (bug reportado pelo usuário: a Visão Geral continuava com o erro do M1 no quadrimestre depois do v1.39, que só tinha corrigido a tabela do painel Municipal)',()=>{
    const beforeSnaps=state.snapshots.length,beforeDenoms=state.denominators.length,u=state.preferences.unit,prevMonth=state.preferences.month;
    try{
      const months=quarterMonths(state.preferences.year,state.preferences.quarter),ref=months[months.length-1];
      state.preferences.month=ref;
      state.denominators.push({id:'tden184_ref',indicator:'M1',scope:'municipal',value:2000,start:ref,end:ref,unit:u,origin:'teste',confirmed:true,updatedAt:nowISO(),ruleVersion:RULE_VERSION});
      for(const mk of months)if(mk!==ref)state.denominators.push({id:`tden184_${mk}`,indicator:'M1',scope:'municipal',value:1000,start:mk,end:mk,unit:u,origin:'teste',confirmed:true,updatedAt:nowISO(),ruleVersion:RULE_VERSION});
      const base={firstConsultations:1,firstConsultationQuantity:1,treatmentsConcluded:0,treatmentConcludedQuantity:0,preventive:0,individualProcedures:0,art:0,restorative:0,b5Denominator:0,b3Numerator:0,b3Denominator:0,procedureCounts:[],concludedPatients:[]};
      months.forEach((mk,i)=>{state.snapshots.push({id:`tm184_${mk}`,profile:'celk_procedimentos_detalhado',unit:u,fileName:`${mk}.csv`,createdAt:nowISO(),dataByMonth:{[mk]:{...base,kind:'procedure',firstPatients:[{name:`Paciente184 ${i}`,date:`10/${mk.slice(5)}/${mk.slice(0,4)}`}]}}})});
      const p=metaProgress('M1',ref);
      const expectedAvg=(100/2000+100/1000+100/1000+100/1000)/4,buggySum=100*4/2000;
      return Math.abs(p.quarter.result-expectedAvg)<1e-9&&Math.abs(p.quarter.result-buggySum)>0.01;
    }finally{state.snapshots.length=beforeSnaps;state.denominators.length=beforeDenoms;state.preferences.month=prevMonth}
  });
  await add('185. metaCard (Visão Geral, escopo quadrimestre) classifica M1 pela faixa da MÉDIA — a soma cumulativa antiga inflaria o resultado até 4x sobre um denominador fixo e classificaria "Ótimo" indevidamente; a média correta mantém "Suficiente"',()=>{
    const beforeSnaps=state.snapshots.length,beforeDenoms=state.denominators.length,u=state.preferences.unit,prevMonth=state.preferences.month;
    try{
      const months=quarterMonths(state.preferences.year,state.preferences.quarter),ref=months[months.length-1];
      state.preferences.month=ref;
      for(const mk of months)state.denominators.push({id:`tden185_${mk}`,indicator:'M1',scope:'municipal',value:2000,start:mk,end:mk,unit:u,origin:'teste',confirmed:true,updatedAt:nowISO(),ruleVersion:RULE_VERSION});
      const base={firstConsultationQuantity:8,treatmentsConcluded:0,treatmentConcludedQuantity:0,preventive:0,individualProcedures:0,art:0,restorative:0,b5Denominator:0,b3Numerator:0,b3Denominator:0,procedureCounts:[],concludedPatients:[]};
      months.forEach((mk,i)=>{const patients=Array.from({length:8},(_,j)=>({name:`Paciente185 ${i}-${j}`,date:`10/${mk.slice(5)}/${mk.slice(0,4)}`}));state.snapshots.push({id:`tm185_${mk}`,profile:'celk_procedimentos_detalhado',unit:u,fileName:`${mk}.csv`,createdAt:nowISO(),dataByMonth:{[mk]:{...base,kind:'procedure',firstConsultations:8,firstPatients:patients}}})});
      const p=metaProgress('M1',ref);
      if(Math.abs(p.quarter.result-.4)>0.01)return false;
      const html=metaCard('M1',ref,'quarter');
      // a legenda estática da meta de M1 sempre cita "Ótimo >1,25%" (faixas oficiais) e, desde o redesign da
      // Visão Geral (v2.2), a régua de zona também lista as 4 faixas por nome (Regular/Suficiente/Bom/Ótimo)
      // como legenda fixa — então ">Ótimo<" sozinho aparece no HTML mesmo quando a classificação real é
      // "Suficiente". A verificação precisa ser sobre a classe do pill de classificação em si, que é única
      // por faixa (mz-suficiente vs. mz-otimo), não sobre uma substring solta de texto.
      return html.includes('pill mz-suficiente')&&!html.includes('pill mz-otimo');
    }finally{state.snapshots.length=beforeSnaps;state.denominators.length=beforeDenoms;state.preferences.month=prevMonth}
  });
  await add('186. metaCard (Visão Geral) troca o tempo verbal e o rótulo conforme a data real de hoje, não o "mês em foco": quadrimestre encerrado usa "Faltou/Faltaram" + "Não há mais tempo para recuperar." + rótulo "Meta não atingida"; quadrimestre em curso usa "Faltam" e o rótulo "Ainda falta", sem a frase de encerramento',()=>{
    const beforeSnaps=state.snapshots.length,beforeDenoms=state.denominators.length,u=state.preferences.unit,prevMonth=state.preferences.month,prevYear=state.preferences.year,prevQuarter=state.preferences.quarter;
    try{
      // M4 (não M1): o rótulo "Ainda falta"/"Meta não atingida" só existe na ramificação não-M1 de metaCard —
      // M1 sempre usa o rótulo de faixa (Ótimo/Bom/Suficiente/Regular), então precisa de outro indicador para testar o rótulo.
      const setupQuarter=(year,quarter)=>{
        const months=quarterMonths(year,quarter),ref=months[months.length-1];
        state.preferences.year=year;state.preferences.quarter=quarter;state.preferences.month=ref;
        const base={firstConsultations:0,firstConsultationQuantity:0,treatmentsConcluded:0,treatmentConcludedQuantity:0,preventive:0,individualProcedures:10,art:0,restorative:0,b5Denominator:10,b3Numerator:0,b3Denominator:0,procedureCounts:[],firstPatients:[],concludedPatients:[]};
        months.forEach((mk,i)=>state.snapshots.push({id:`tm186_${year}_${mk}`,profile:'celk_procedimentos_detalhado',unit:u,fileName:`${mk}.csv`,createdAt:nowISO(),dataByMonth:{[mk]:{...base,kind:'procedure'}}}));
        return ref;
      };
      const refPast=setupQuarter(2020,1);
      const pastHtml=metaCard('M4',refPast,'quarter');
      const pastOk=/Falt(ou|aram)/.test(pastHtml)&&pastHtml.includes('Não há mais tempo para recuperar.')&&pastHtml.includes('>Meta não atingida<');
      const refFuture=setupQuarter(2099,1);
      const futureHtml=metaCard('M4',refFuture,'quarter');
      const futureOk=futureHtml.includes('Faltam')&&!futureHtml.includes('Não há mais tempo para recuperar.')&&futureHtml.includes('>Ainda falta<');
      return pastOk&&futureOk;
    }finally{state.snapshots.length=beforeSnaps;state.denominators.length=beforeDenoms;state.preferences.month=prevMonth;state.preferences.year=prevYear;state.preferences.quarter=prevQuarter}
  });
  await add('187. VIEW_META não tem mais entradas de nível superior para imports/diagnostics — Importações e Diagnóstico viraram subabas de Configurações (v2.0)',()=>!('imports' in VIEW_META)&&!('diagnostics' in VIEW_META)&&Array.isArray(VIEW_META.settings));
  await add('188. A barra lateral tem um botão por view de nível superior, sem duplicidade de Importações/Diagnóstico, e o badge de diagnóstico fica dentro do botão Configurações',()=>{const btns=[...document.querySelectorAll('.side-btn[data-view]')];const badgeEl=document.getElementById('diagnosticBadge');return btns.length===Object.keys(VIEW_META).length&&btns.every(b=>!!VIEW_META[b.dataset.view])&&!!badgeEl&&badgeEl.closest('[data-view="settings"]')===document.querySelector('[data-view="settings"]')});
  await add('189. Configurações alterna 4 subabas (Geral/Arquivos/Verificação/Conferência por procedimento) via state.preferences.settingsTab, e cada botão mostra a situação da aba',()=>{const prev=state.preferences.settingsTab;try{const html={};for(const t of ['geral','imports','diagnostics','conferencia']){state.preferences.settingsTab=t;html[t]=settingsHTML()}const tabs=(html.geral.match(/data-settings-tab="/g)||[]).length;return tabs>=4&&html.geral.includes('Salvamento e backup')&&html.geral.includes('Denominadores')&&html.imports.includes('Arquivos importados')&&html.diagnostics.includes('Para resolver')&&html.conferencia.includes('Conferência por procedimento')&&['geral','imports','diagnostics','conferencia'].every(t=>html.geral.includes(esc(settingsTabStatus(t).text)))}finally{state.preferences.settingsTab=prev}});
  await add('190. Matriz municipal (v2.16) não usa pontuação em "pts": M2–M5 pela zona da meta (Meta batida / Entre corte e meta / Abaixo do corte) e M1 pelas faixas oficiais',()=>{const src=mxMunLabel.toString()+mxCellHTML.toString();return !src.includes('pts')&&mxMunLabel('M4',50)==='Meta batida'&&mxMunLabel('M4',25)==='Entre corte e meta'&&mxMunLabel('M4',10)==='Abaixo do corte'&&mxMunLabel('M1',1.3)==='Ótimo'&&mxMunLabel('M1',null)===null});
  await add('191. Paleta municipal (MZ) e paleta federal (FZ) seguem os tokens do Boardto Design System v2.0 e continuam sem nenhuma cor em comum',()=>{const mz=RULESETS.municipal.indicators.M1.bands.map(b=>b.color.toLowerCase());const mzOk=mz.includes('#2cc08b')&&mz.includes('#2f80ed')&&mz.includes('#f7821f')&&mz.includes('#f0483e');const fzOk=FEDERAL_ZONE_COLORS['Ótimo'].text.toLowerCase()==='#14539a'&&FEDERAL_ZONE_COLORS['Bom'].text.toLowerCase()==='#17b9ec'&&FEDERAL_ZONE_COLORS['Suficiente'].text.toLowerCase()==='#c99400'&&FEDERAL_ZONE_COLORS['Regular'].text.toLowerCase()==='#8c1d18';const fz=[...Object.values(FEDERAL_ZONE_COLORS).map(c=>c.text.toLowerCase()),FEDERAL_B3_ACCENT.toLowerCase()];return mzOk&&fzOk&&fz.every(c=>!mz.includes(c))});
  await add('192. ageBandLabel (página Procedimentos) classifica as faixas etárias 0-5, 6-11, 12-17, 18-59 e 60+ pelos limites corretos',()=>{
    return ageBandLabel('0')==='0-5'&&ageBandLabel('5')==='0-5'&&ageBandLabel('6')==='6-11'&&ageBandLabel('11')==='6-11'&&ageBandLabel('12')==='12-17'&&ageBandLabel('17')==='12-17'&&ageBandLabel('18')==='18-59'&&ageBandLabel('59')==='18-59'&&ageBandLabel('60')==='60+'&&ageBandLabel('120')==='60+'&&ageBandLabel('')===''&&ageBandLabel('abc')==='';
  });
  await add('193. sexLabel (página Procedimentos) normaliza as variações de sexo do CELK para "Feminino"/"Masculino", sem afirmar nada para valor vazio ou não reconhecido',()=>{
    return sexLabel('F')==='Feminino'&&sexLabel('Feminino')==='Feminino'&&sexLabel('f')==='Feminino'&&sexLabel('M')==='Masculino'&&sexLabel('Masculino')==='Masculino'&&sexLabel('')===''&&sexLabel('X')==='';
  });
  await add('194. procPalette usa as 5 cores fixas da especificação (ciano/roxo/verde/laranja/magenta) para até 5 categorias e gera cores adicionais sem repetir quando há mais de 5 (paleta não fica travada em 5)',()=>{
    const base=['#17b9ec','#7551e9','#2cc08b','#f7821f','#a855f7'];
    const p5=procPalette(5);const p5Ok=p5.length===5&&p5.every((c,i)=>c===base[i]);
    const p8=procPalette(8);const p8Ok=p8.length===8&&base.every((c,i)=>p8[i]===c)&&new Set(p8).size===8;
    return p5Ok&&p8Ok;
  });
  await add('195. buildProcedureSnapshotFromRows agrega crossRows (procedimento × dentista × sexo × idade) por mês e deduplica visitsList por paciente+data — 2 procedimentos da mesma pessoa no mesmo dia contam como 1 visita, não 2',()=>{
    const snap=makeSnapshotBase({name:'t195.csv',size:1},'hash195','celk_procedimentos_detalhado',{});
    const rows=[
      {patient:'Ana Teste',age:'34',sex:'F',date:'10/07/2026',professional:'Dra. Camila Souza',procedure:'Aplicação tópica de flúor',unitOrigin:'U1',quantity:1},
      {patient:'Ana Teste',age:'34',sex:'F',date:'10/07/2026',professional:'Dra. Camila Souza',procedure:'Evidenciação de placa bacteriana',unitOrigin:'U1',quantity:1},
      {patient:'Bruno Teste',age:'8',sex:'M',date:'15/07/2026',professional:'Dr. Rafael Nunes',procedure:'Aplicação tópica de flúor',unitOrigin:'U1',quantity:1},
    ];
    buildProcedureSnapshotFromRows(snap,rows);
    const month=snap.dataByMonth['2026-07'];
    const visitsOk=month.visitCount===2;
    const crossOk=month.crossRows.some(c=>c.age==='18-59'&&c.sex==='Feminino'&&c.professional==='Dra. Camila Souza')&&month.crossRows.some(c=>c.age==='6-11'&&c.sex==='Masculino');
    return visitsOk&&crossOk;
  });
  await add('196. aggregateProcedureYear soma os 12 meses do ano e usa só o snapshot mais recente por unidade em cada mês (mesma regra de latestSnapshots do resto do app) — uma reimportação de janeiro não soma janeiro duas vezes',()=>{
    const beforeSnaps=state.snapshots.length,u=state.preferences.unit;
    try{
      const base={firstConsultations:0,firstConsultationQuantity:0,treatmentsConcluded:0,treatmentConcludedQuantity:0,preventive:0,individualProcedures:0,art:0,restorative:0,b5Denominator:0,b3Numerator:0,b3Denominator:0,concludedPatients:[],firstPatients:[],crossRows:[],visitsList:[]};
      const proc=(desc,qty)=>({descriptionOriginal:desc,descriptionNormalized:norm(desc),sigtap:'',quantityRaw:qty,quantityValid:qty,lineCount:1,roles:[],ambiguous:false,unrecognized:false,outOfScope:false,pages:[],professionals:{'Dra. Teste 196':qty}});
      state.snapshots.push({id:'tm196_jan_old',profile:'celk_procedimentos_detalhado',unit:u,fileName:'jan_old.csv',createdAt:'2020-01-01T00:00:00.000Z',dataByMonth:{'2020-01':{...base,kind:'procedure',procedureCounts:[proc('Procedimento A',5)]}}});
      state.snapshots.push({id:'tm196_jan_new',profile:'celk_procedimentos_detalhado',unit:u,fileName:'jan_new.csv',createdAt:'2020-01-05T00:00:00.000Z',dataByMonth:{'2020-01':{...base,kind:'procedure',procedureCounts:[proc('Procedimento A',9)]}}});
      state.snapshots.push({id:'tm196_fev',profile:'celk_procedimentos_detalhado',unit:u,fileName:'fev.csv',createdAt:'2020-02-01T00:00:00.000Z',dataByMonth:{'2020-02':{...base,kind:'procedure',procedureCounts:[proc('Procedimento A',3)]}}});
      const agg=aggregateProcedureYear(2020,u);
      const found=agg.procedureCounts.find(x=>x.descriptionNormalized===norm('Procedimento A'));
      return !!found&&found.quantityValid===12;
    }finally{state.snapshots.length=beforeSnaps}
  });
  await add('197. groupProcedureItems aplica os filtros de Refinar (sexo/idade/dentista) antes de agrupar por Idade, Sexo ou Dentista, somando certo mesmo com mais de um dentista/procedimento no cruzamento',()=>{
    const yearAgg={year:2020,procedureCounts:[{descriptionNormalized:'a',descriptionOriginal:'A',quantityValid:10,professionals:{'Dr. X':6,'Dr. Y':4}},{descriptionNormalized:'b',descriptionOriginal:'B',quantityValid:5,professionals:{'Dr. X':5}}],crossRows:[
      {procKey:'a',procLabel:'A',professional:'Dr. X',sex:'Feminino',age:'18-59',quantity:6},
      {procKey:'a',procLabel:'A',professional:'Dr. Y',sex:'Masculino',age:'6-11',quantity:4},
      {procKey:'b',procLabel:'B',professional:'Dr. X',sex:'Feminino',age:'60+',quantity:5},
    ],monthsWithData:['2020-01']};
    const bySex=groupProcedureItems(yearAgg,'sex',{sex:'',age:'',dentist:''});
    const sexOk=bySex.find(x=>x.key==='Feminino')?.value===11&&bySex.find(x=>x.key==='Masculino')?.value===4;
    const byAgeFilteredByDentist=groupProcedureItems(yearAgg,'age',{sex:'',age:'',dentist:'Dr. X'});
    const ageOk=byAgeFilteredByDentist.length===2&&byAgeFilteredByDentist.every(x=>['18-59','60+'].includes(x.key));
    const byDentist=groupProcedureItems(yearAgg,'dentist',{sex:'',age:'',dentist:''});
    const dentistOk=byDentist.find(x=>x.key==='Dr. X')?.value===11&&byDentist.find(x=>x.key==='Dr. Y')?.value===4;
    return sexOk&&ageOk&&dentistOk;
  });
  await add('198. patientEvaluationStats (Avaliação do paciente) calcula retornos como o total de visitas do ano (cada visita do paciente conta, inclusive a que já é 1ª consulta/tratamento concluído em outra tabela), além da média de consultas por paciente e da distribuição por faixa, a partir de visitas distintas (paciente+data)',()=>{
    const beforeSnaps=state.snapshots.length,u=state.preferences.unit;
    try{
      const visitsList=[
        {patient:'PACIENTE A',date:'01/03/2020'},{patient:'PACIENTE A',date:'08/03/2020'},{patient:'PACIENTE A',date:'15/03/2020'},
        {patient:'PACIENTE B',date:'02/03/2020'},
        {patient:'PACIENTE C',date:'03/03/2020'},
      ];
      const base={firstConsultations:2,firstConsultationQuantity:2,treatmentsConcluded:1,treatmentConcludedQuantity:1,preventive:0,individualProcedures:0,art:0,restorative:0,b5Denominator:0,b3Numerator:0,b3Denominator:0,procedureCounts:[],firstPatients:[{name:'Paciente A',date:'01/03/2020'},{name:'Paciente B',date:'02/03/2020'}],concludedPatients:[{name:'Paciente C',date:'03/03/2020'}],crossRows:[],visitsList};
      state.snapshots.push({id:'tm198',profile:'celk_procedimentos_detalhado',unit:u,fileName:'m198.csv',createdAt:nowISO(),dataByMonth:{'2020-03':{...base,kind:'procedure'}}});
      const stats=patientEvaluationStats(2020,u);
      const retOk=stats.retornosTotal===5&&stats.retornosTotal===stats.totalVisits;
      const avgOk=Math.abs(stats.avgVisits-5/3)<1e-9;
      const bucketOk=stats.buckets.find(b=>b.key==='1').count===2&&stats.buckets.find(b=>b.key==='2-3').count===1;
      return retOk&&avgOk&&bucketOk;
    }finally{state.snapshots.length=beforeSnaps}
  });
  await add('199. VIEW_META tem a entrada "procedures" e switchView("procedures") mostra a section view-procedures com o título "Procedimentos realizados" e o item do menu marcado como ativo',()=>{
    const prevView=activeView;
    try{
      switchView('procedures',{save:false});
      const title=document.getElementById('pageTitle').textContent;
      const sectionVisible=!document.getElementById('view-procedures').classList.contains('hidden');
      const navActive=document.querySelector('[data-view="procedures"]')?.classList.contains('active');
      return ('procedures' in VIEW_META)&&title==='Procedimentos realizados'&&sectionVisible&&!!navActive;
    }finally{switchView(prevView,{save:false})}
  });
  await add('200. Página Procedimentos (v2.27): agrupa por categoria clínica com nome legível, SIGTAP e indicador, tem período Mês/Quadrimestre/Ano e filtros de dentista, idade e sexo, sem gráfico de pizza nem "Agrupar por"',()=>{const before=state.snapshots.length,prev={...state.preferences};try{const mk='2031-02',u=state.preferences.unit;Object.assign(state.preferences,{year:2031,quarter:1,month:mk,procSource:'individual',procView:'overview',procPeriod:'Q',procDentist:'',procAge:'',procSex:'',procOpenCats:['Preventivos']});state.snapshots.push({id:'tproc200_selftest',profile:'celk_procedimentos_detalhado',unit:u,fileName:'p.csv',createdAt:nowISO(),validations:[],procedureCounts:[],dataByMonth:{[mk]:{kind:'procedure',firstConsultations:1,treatmentsConcluded:0,procedureCounts:[{descriptionOriginal:'APLICAÇÃO TÓPICA DE FLÚOR',descriptionNormalized:'Aplicação tópica de flúor',sigtap:'01.01.02.007-4',quantityRaw:3,quantityValid:3,roles:['preventive','m4den','b5den','b3den']}],crossRows:[{procKey:norm('Aplicação tópica de flúor'),procLabel:'Aplicação tópica de flúor',professional:'Dentista X',sex:'Feminino',age:'6-11',quantity:3}],visitsList:[{patient:'P1',date:'01/02/2031'}]}}});const h=proceduresHTML();return h.includes('Preventivos')&&h.includes('Aplicação tópica de flúor')&&h.includes('01.01.02.007-4')&&h.includes('M4 num')&&h.includes('data-proc-period="M"')&&h.includes('data-proc-dentist-sel')&&h.includes('data-proc-open=')&&!h.includes('Pizza')&&!h.includes('Agrupar por')}finally{state.snapshots.length=before;Object.assign(state.preferences,prev)}});
  await add('201. buildProcedureSnapshotFromRows funde "ORIENTAÇÃO DE HIGIENE BUCAL" e "ORIENTAÇÃO EM HIGIENE BUCAL" (duas grafias do mesmo procedimento no relatório) numa única linha, somando as quantidades e exibindo o nome canônico "Orientação em higiene bucal"',()=>{
    const snap={dataByMonth:{},procedureCounts:[],validations:[]};
    const rows=[{patient:'Fulana',date:'05/06/2026',professional:'Caio',procedure:'ORIENTAÇÃO DE HIGIENE BUCAL',quantity:2},{patient:'Beltrano',date:'06/06/2026',professional:'Caio',procedure:'ORIENTAÇÃO EM HIGIENE BUCAL',quantity:3}];
    buildProcedureSnapshotFromRows(snap,rows);
    const m=snap.dataByMonth['2026-06'];
    const merged=m.procedureCounts.filter(p=>p.descriptionNormalized==='Orientação em higiene bucal');
    return merged.length===1&&merged[0].quantityValid===5&&merged[0].descriptionOriginal==='Orientação em higiene bucal';
  });
  await add('202. buildProcedureSnapshotFromRows marca "ATENDIMENTO" e "CONSULTA DE PROFISSIONAIS DE NÍVEL SUPERIOR..." (itens da lista que o usuário identificou como não sendo procedimentos odontológicos) como nonDental: eles não entram em crossRows (cruzamento avançado da página Procedimentos), mas continuam contando no M4 (individualProcedures)',()=>{
    const snap={dataByMonth:{},procedureCounts:[],validations:[]};
    const rows=[{patient:'Fulana',date:'05/06/2026',professional:'Caio',procedure:'ATENDIMENTO',quantity:1,sex:'F',age:30},{patient:'Beltrano',date:'06/06/2026',professional:'Caio',procedure:'CONSULTA DE PROFISSIONAIS DE NÍVEL SUPERIOR NA ATENÇÃO PRIMÁRIA (EXCETO MÉDICO)',quantity:1,sex:'M',age:40},{patient:'Ciclana',date:'07/06/2026',professional:'Caio',procedure:'APLICAÇÃO TÓPICA DE FLÚOR',quantity:1,sex:'F',age:10}];
    buildProcedureSnapshotFromRows(snap,rows);
    const m=snap.dataByMonth['2026-06'];
    const nonDentalFlags=m.procedureCounts.filter(p=>p.nonDental).length;
    const crossHasNonDental=m.crossRows.some(c=>/ATENDIMENTO|CONSULTA DE PROFISSIONAIS/.test(norm(c.procLabel)));
    return nonDentalFlags===2&&!crossHasNonDental&&m.crossRows.length===1&&m.individualProcedures===3;
  });
  await add('203. aggregateProcedureYear e groupProcedureItems (Agrupar por Procedimento/Dentista) excluem os itens nonDental da página Procedimentos, mesmo que aggregateProcedureMonth (usado em Configurações › Importações e no drill-down M4/M5/B3/B5) continue trazendo todos, sem filtro',()=>{
    const prevSnaps=state.snapshots.length,u=state.preferences.unit;
    try{
      const base={firstConsultations:0,firstConsultationQuantity:0,treatmentsConcluded:0,treatmentConcludedQuantity:0,preventive:0,individualProcedures:2,art:0,restorative:0,b5Denominator:0,b3Numerator:0,b3Denominator:0,firstPatients:[],concludedPatients:[],visitsList:[]};
      const dental={descriptionOriginal:'Aplicação tópica de flúor',descriptionNormalized:'Aplicação tópica de flúor',sigtap:'',quantityRaw:4,quantityValid:4,lineCount:1,roles:['preventive','m4den'],ambiguous:false,unrecognized:false,outOfScope:false,nonDental:false,pages:[],professionals:{'Dra. Teste 203':4}};
      const admin={descriptionOriginal:'Atendimento',descriptionNormalized:'Atendimento (registro genérico)',sigtap:'',quantityRaw:7,quantityValid:7,lineCount:1,roles:['m4den'],ambiguous:false,unrecognized:false,outOfScope:false,nonDental:true,pages:[],professionals:{'Dra. Teste 203':7}};
      state.snapshots.push({id:'tm203',profile:'celk_procedimentos_detalhado',unit:u,fileName:'m203.csv',createdAt:nowISO(),dataByMonth:{'2020-07':{...base,kind:'procedure',procedureCounts:[dental,admin],crossRows:[{procKey:dental.descriptionNormalized,procLabel:dental.descriptionOriginal,professional:'Dra. Teste 203',sex:'',age:'',quantity:4}]}}});
      const monthAgg=aggregateProcedureMonth('2020-07',u);
      const yearAgg=aggregateProcedureYear(2020,u);
      const procItems=groupProcedureItems(yearAgg,'procedure',{},u);
      const dentistItems=groupProcedureItems(yearAgg,'dentist',{},u);
      const dentistRow=dentistItems.find(d=>d.key==='Dra. Teste 203');
      return monthAgg.procedureCounts.length===2&&yearAgg.procedureCounts.length===1&&!procItems.some(i=>i.key===admin.descriptionNormalized)&&!!dentistRow&&dentistRow.value===4;
    } finally { state.snapshots.length=prevSnaps; }
  });
  await add('204. Uma linha "ATIVIDADE EDUCATIVA / ORIENTAÇÃO EM GRUPO NA ATENÇÃO PRIMÁRIA" no relatório Procedimentos Detalhado alimenta aggregateGroupMonth (aba Atividades coletivas, ao lado da evolução de escovação supervisionada) mesmo sem nenhum snapshot de "Relação das Atividades em Grupo" importado',()=>{
    const snap={dataByMonth:{},procedureCounts:[],validations:[]};
    const rows=[{patient:'Fulana',date:'03/06/2026',professional:'Caio',procedure:'ATIVIDADE EDUCATIVA / ORIENTAÇÃO EM GRUPO NA ATENÇÃO PRIMÁRIA',quantity:12},{patient:'Beltrano',date:'03/06/2026',professional:'Caio',procedure:'ATIVIDADE EDUCATIVA / ORIENTAÇÃO EM GRUPO NA ATENÇÃO PRIMÁRIA',quantity:8},{patient:'Ciclana',date:'17/06/2026',professional:'Caio',procedure:'ATIVIDADE EDUCATIVA / ORIENTAÇÃO EM GRUPO NA ATENÇÃO PRIMÁRIA',quantity:5}];
    buildProcedureSnapshotFromRows(snap,rows);
    const prevSnaps=state.snapshots.length,u=state.preferences.unit;
    try{
      state.snapshots.push({id:'tm204',profile:'celk_procedimentos_detalhado',unit:u,fileName:'m204.csv',createdAt:nowISO(),dataByMonth:snap.dataByMonth});
      const hasNoGroupSnap=!latestSnapshots('celk_atividades_grupo','2026-06',u).length;
      const agg=aggregateGroupMonth('2026-06',u);
      const subj=agg?.subjectCounts?.find(s=>norm(s.subject)===norm('Atividade educativa / orientação em grupo na atenção primária'));
      return hasNoGroupSnap&&!!agg&&agg.activities===2&&!!subj&&subj.present===25;
    } finally { state.snapshots.length=prevSnaps; }
  });
  await add('205. procCategory separa os procedimentos em Preventivos, Periodontia, Restauradores, Endodontia, Cirurgia e Outros (selamento provisório em Restauradores, capeamento em Endodontia)',()=>procCategory('Aplicação tópica de flúor')==='Preventivos'&&procCategory('Orientação em higiene bucal')==='Preventivos'&&procCategory('RASPAGEM CORONO-RADICULAR (POR SEXTANTE)')==='Periodontia'&&procCategory('Selamento provisório de cavidade')==='Restauradores'&&procCategory('Restauração de dente permanente anterior com resina composta')==='Restauradores'&&procCategory('Capeamento pulpar')==='Endodontia'&&procCategory('Exodontia de dente permanente')==='Cirurgia'&&procCategory('DRENAGEM DE ABSCESSO DA BOCA E ANEXOS')==='Cirurgia'&&procCategory('Ajuste oclusal')==='Outros');
  await add('206. patientEvaluationStats conta "retorno" como o total de vezes que o MESMO paciente veio no ano, incluindo a visita que já é sua 1ª consulta — pedido explícito do usuário ("se Maria veio em 2026 6 vezes... ela conta como 6 vezes retornando ao posto")',()=>{
    const snap={dataByMonth:{},procedureCounts:[],validations:[]};
    const rows=[
      {patient:'Maria',date:'10/01/2021',professional:'Caio',procedure:'PRIMEIRA CONSULTA ODONTOLOGICA PROGRAMÁTICA',quantity:1},
      {patient:'Maria',date:'15/02/2021',professional:'Caio',procedure:'APLICAÇÃO TÓPICA DE FLÚOR',quantity:1},
      {patient:'Maria',date:'20/03/2021',professional:'Caio',procedure:'PROFILAXIA / REMOÇÃO DA PLACA',quantity:1},
      {patient:'Maria',date:'25/04/2021',professional:'Caio',procedure:'EVIDENCIAÇÃO DE PLACA BACTERIANA',quantity:1},
      {patient:'Maria',date:'30/05/2021',professional:'Caio',procedure:'APLICAÇÃO DE SELANTE',quantity:1},
      {patient:'Maria',date:'05/06/2021',professional:'Caio',procedure:'ORIENTAÇÃO EM HIGIENE BUCAL',quantity:1},
    ];
    buildProcedureSnapshotFromRows(snap,rows);
    const beforeSnaps=state.snapshots.length,u=state.preferences.unit;
    try{
      state.snapshots.push({id:'tm206',profile:'celk_procedimentos_detalhado',unit:u,fileName:'m206.csv',createdAt:nowISO(),dataByMonth:snap.dataByMonth});
      const stats=patientEvaluationStats(2021,u);
      return stats.distinctPatients===1&&stats.totalVisits===6&&stats.retornosTotal===6&&stats.firstTotal===1&&stats.avgVisits===6;
    }finally{state.snapshots.length=beforeSnaps}
  });
  await add('207. CSV de atividades em grupo guarda o detalhe de cada atividade (todos os participantes, quem entra em M3/B4, fora da faixa, idade, sexo e avaliação alterada) sem mudar o numerador de M3/B4, e a página mostra "fora da faixa"',async()=>{const csv=['Unidade,Data,Turno,Código da Atividade,Público Alvo,Temas,Tipo de Atividade,Assunto,Local Atividade,Nome dos Participantes,Data de Nascimento,Sexo,Avaliação Alterada','CS X,2031-03-10 13:00:00.0,Tarde,1,Criança de 6 a 11 anos,Saúde bucal,Coletivo,Escovação Supervisionada - Turma 1,Escola,Ana A,2022-01-01,F,Sim','CS X,2031-03-10 13:00:00.0,Tarde,1,Criança de 6 a 11 anos,Saúde bucal,Coletivo,Escovação Supervisionada - Turma 1,Escola,Beto B,2018-05-01,M,Não','CS X,2031-03-11 09:00:00.0,Manhã,2,Comunidade,Saúde bucal,Grupo,SAÚDE BUCAL,CS,Carla C,1980-01-01,F,Não'].join('\n');const snap=await parseGroupCsv({name:'g.csv'},'hash_selftest_207',csv);const d=snap.dataByMonth['2031-03'],a=d.activityDetails.find(x=>x.code==='1'),b=d.activityDetails.find(x=>x.code==='2');const before=state.snapshots.length,prev={...state.preferences};try{state.snapshots.push(snap);Object.assign(state.preferences,{year:2031,quarter:1,month:'2031-03',procSource:'group',procPeriod:'M',unit:snap.unit});const h=proceduresHTML();return d.supervisedBrushingPresent===1&&a.total===2&&a.eligible===1&&a.outOfRange===1&&a.altered===1&&a.alteredNames[0]==='Ana A'&&a.sex.F===1&&b.total===1&&!b.brush&&h.includes('fora da faixa')&&h.includes('Avaliação alterada')}finally{state.snapshots.length=before;Object.assign(state.preferences,prev)}});
  await add('208. detectCSVProfile reconhece o cabeçalho real do CELK "Data de Nascimento" (com "de") para o CSV de Atividades em Grupo — o primeiro CSV real anexado pelo usuário usa essa grafia, diferente da "Data Nascimento" (sem "de") assumida sem verificação até a v2.6',()=>{
    const headersReal=['Unidade','Cnes','INE','Nome da Equipe','Data','Turno','Código da Atividade','Situação','Público Alvo','Temas','Práticas','Profissionais','Tipo de Atividade','Nr. INEP','Assunto','Local Atividade','Nome dos Participantes','CNS','CPF','Data de Nascimento','Sexo','I.M.C','Peso','Altura','PAS','PAD','Avaliação Alterada',''];
    return detectCSVProfile(headersReal)==='celk_atividades_grupo_csv'&&detectCSVProfile(['Unidade','Código da Atividade','Assunto','Nome dos Participantes','Data Nascimento'])==='celk_atividades_grupo_csv';
  });
  await add('209. parseGroupCsv processa de ponta a ponta um CSV estruturalmente igual ao arquivo real do CELK (cabeçalho "Data de Nascimento", colunas extras de sinais vitais vazias, coluna final sem nome, "Assunto" com sufixo "- Turma N" e variação de maiúsculas/minúsculas em "Saúde bucal") — calcula idade real, filtra elegibilidade de M3/B4 e não deixa as colunas extras quebrarem o parser',async()=>{
    const header='Unidade,Cnes,INE,Nome da Equipe,Data,Turno,Código da Atividade,Situação,Público Alvo,Temas,Práticas,Profissionais,Tipo de Atividade,Nr. INEP,Assunto,Local Atividade,Nome dos Participantes,CNS,CPF,Data de Nascimento,Sexo,I.M.C,Peso,Altura,PAS,PAD,Avaliação Alterada,';
    const rows=[
      'CS MONTE SERRAT,0020036,0002022168,MONTE SERRAT - 1120,2026-09-15 13:00:00.0,Tarde,ACT1,Concluída,Criança de 6 a 11 anos,Saúde bucal,Escovação,Caio,Avaliação,4.2E7,Escovação Supervisionada - Turma 48,Instituto Estadual,Participante A,111,222,2018-09-01,F,,,,,,Não,',
      'CS MONTE SERRAT,0020036,0002022168,MONTE SERRAT - 1120,2026-09-15 13:00:00.0,Tarde,ACT1,Concluída,Criança de 6 a 11 anos,Saúde bucal,Escovação,Caio,Avaliação,4.2E7,escovação supervisionada - turma 48,Instituto Estadual,Participante B,111,222,2010-01-01,M,,,,,,Não,',
      'CS MONTE SERRAT,0020036,0002022168,MONTE SERRAT - 1120,2026-09-16 10:00:00.0,Manhã,ACT2,Concluída,Comunidade em geral,Saúde bucal,Palestra,Caio,Avaliação,4.2E7,SAÚDE BUCAL,Instituto Estadual,Participante C,111,222,1980-01-01,F,,,,,,Não,'
    ];
    const csv=[header,...rows].join('\n');
    const fakeFile={name:'grupo_real.csv'};
    const snap=await parseGroupCsv(fakeFile,'hash_selftest_209',csv);
    const m=snap.dataByMonth['2026-09'];
    return snap.profile==='celk_atividades_grupo'&&m.activities===2&&m.eligibleActivities===1&&m.supervisedBrushingPresent===1&&m.subjectCounts.some(s=>norm(s.subject)==='SAUDE BUCAL');
  });
  await add('210. WhatsApp sem resposta há 5 dias ou mais: a próxima ação sugerida passa a ser a busca ativa, em alerta',()=>{const old=new Date(Date.now()-6*864e5).toISOString(),recent=new Date().toISOString();state.gestantes.followups['t210']={state:'whatsapp_enviado',updatedAt:old,history:[]};const a=pregNextAction({id:'t210',status2i:'pendente',phoneNormalized:'5548999999999'});state.gestantes.followups['t210'].updatedAt=recent;const b=pregNextAction({id:'t210',status2i:'pendente',phoneNormalized:'5548999999999'});delete state.gestantes.followups['t210'];return WHATSAPP_NO_REPLY_DAYS===5&&a.kind==='busca'&&a.alert===true&&b.kind==='agendar'});
  await add('211. Gestante a contatar sem telefone válido: a próxima ação é pedir busca ativa; com telefone, enviar WhatsApp',()=>{const a=pregNextAction({id:'t211a',status2i:'pendente',phoneNormalized:''}),b=pregNextAction({id:'t211b',status2i:'pendente',phoneNormalized:'5548999999999'});return a.kind==='busca'&&b.kind==='whatsapp'});
  await add('212. Idade gestacional e prioridade de 3º trimestre também funcionam só com a DPP (DUM estimada = DPP − 280 dias)',()=>{const dpp=new Date(Date.now()+8*7*864e5);const e={id:'t212',status2i:'pendente',dataProvParto:isoDate(dpp)};const w=gestationalWeeks(e);return w>=31&&w<=32&&isPriority2I(e)});
  await add('213. Fila ordena 3º trimestre sem atendimento primeiro e, depois, pela data provável do parto mais próxima',()=>{const d=days=>isoDate(new Date(Date.now()+days*864e5));const a={id:'t213a',nome:'A',status2i:'pendente',dataProvParto:d(150)},b={id:'t213b',nome:'B',status2i:'pendente',dataProvParto:d(60)},c={id:'t213c',nome:'C',status2i:'pendente',dataProvParto:d(20)},x={id:'t213x',nome:'X',status2i:'pendente',dataProvParto:d(100)};const order=[a,x,b,c].sort(pregSort).map(e=>e.nome).join('');return order==='CBXA'});
  await add('214. Cadastro manual usa "Prontuário (CELK)", escolhe a equipe entre as existentes e só exige data e observação do atendimento quando "Sim, já foi atendida"',()=>{const open=openManualPregnant.toString(),save=saveManualPregnant.toString();return open.includes('Prontuário (CELK)')&&!open.includes('CNS')&&open.includes('data-mp-team')&&save.includes("if(mpForm.bucal==='sim'){set('mpActivityMsg'")&&save.includes("to:'ok_manual'")});
  await add('215. Cadastro manual guarda só a data informada (DUM ou DPP), para a mesclagem com o CSV continuar comparando exatamente a mesma data',()=>{const save=saveManualPregnant.toString();return save.includes("ultimaMenstruacao:mpForm.ref==='dum'?d.ref:''")&&save.includes("dataProvParto:mpForm.ref==='dpp'?d.ref:''")});
  await add('216. "Desfazer" depois de registrar um contato restaura o acompanhamento anterior (ou remove, se não havia)',()=>{const src=setFollowupWithUndo.toString();return src.includes('JSON.parse(JSON.stringify(state.gestantes.followups[id]))')&&src.includes('state.gestantes.followups[id]=prev')&&src.includes('delete state.gestantes.followups[id]')&&src.includes("'Desfazer'")});
  await add('217. Filtros de ano, quadrimestre e mês ficam ocultos na view de gestantes (não afetam o 2I) e voltam nas outras views',()=>{switchView('pregnant',{save:false});const hidden=document.getElementById('appShell').classList.contains('is-pregnant-view');switchView('overview',{save:false});const back=!document.getElementById('appShell').classList.contains('is-pregnant-view');return hidden&&back});
  await add('218. detectCSVProfile reconhece a lista de gestantes do Monitora APS pelos cabeçalhos Equipe/Usuária/Período/Cons.Odonto (cabeçalho real do arquivo exportado)',()=>detectCSVProfile('Unidade,Equipe,Usuária,Período,1ªCons.12s.,7 consultas,7 PA,7 PesoAlt,DTPA,Exames T1,Exames T3,Cons.Puérp.,Cons.Odonto'.split(','))==='monitora_aps_2i');
  await add('219. parseMonitoraCSV lê só Equipe, Usuária e Cons.Odonto e separa quem está em Puerpério (não entra na lista)',async()=>{const csv=['Unidade,Equipe,Usuária,Período,1ªCons.12s.,7 consultas,7 PA,7 PesoAlt,DTPA,Exames T1,Exames T3,Cons.Puérp.,Cons.Odonto','CS MONTE SERRAT,120,78503,Puerpério,Sim,Não,Não,Não,Não,Não,Não,Não,Não','CS MONTE SERRAT,120,721139,T3,Sim,Sim,Não,Sim,Sim,Sim,Sim,Não,Sim','CS MONTE SERRAT,121,71735,T3,Sim,Sim,Não,Não,Sim,Sim,Não,Não,Não'].join('\n');const snap=await parseMonitoraCSV({name:'monitora.csv'},'hash_selftest_219',csv);sessionRaw.delete(snap.id);const r=Object.fromEntries(snap.monitoraRows.map(x=>[x.usuaria,x]));return snap.profile===MONITORA_PROFILE&&snap.puerperio.join()==='78503'&&snap.monitoraRows.length===2&&r['721139'].monitoraOdonto==='atende'&&r['71735'].monitoraOdonto==='pendente'&&r['71735'].equipe==='121'&&snap.unit==='CS MONTE SERRAT'});
  await add('220. Usuária do Monitora com o mesmo número de um prontuário já guardado vira vínculo (sem linha nova) e Cons.Odonto = Sim conta como atendida sem mudar o status bruto do CSV',()=>{const mb={id:'sMb220',profile:'metabase_gestantes_2i',createdAt:new Date(Date.now()+9e10).toISOString(),episodes:[{id:'e220',nome:'Ana',prontuario:'000721139',equipe:'ESF 120',status2i:'pendente'}]},mon={id:'sMon220',profile:MONITORA_PROFILE,createdAt:new Date(Date.now()+9e10).toISOString(),monitoraRows:[{usuaria:'721139',equipe:'120',periodo:'T3',consOdonto:'Sim',monitoraOdonto:'atende'}],puerperio:[]};const saved220=state.snapshots;state.snapshots=[mb,mon];const eps=mergedEpisodes(),e=eps.find(x=>x.id==='e220');const ok=!eps.some(x=>x.id==='mon-721139')&&!!e&&e.monitoraUsuaria==='721139'&&e.status2i==='pendente'&&isAttended(e);state.snapshots=saved220;return ok});
  await add('221. Usuária do Monitora sem vínculo entra como gestante nova "mon-<usuária>" com Dados a completar; T3 já conta como prioridade e a próxima ação é Completar dados',()=>{const mon={id:'sMon221',profile:MONITORA_PROFILE,createdAt:new Date(Date.now()+9e10).toISOString(),monitoraRows:[{usuaria:'999221',equipe:'122',periodo:'T3',consOdonto:'Não',monitoraOdonto:'pendente'}],puerperio:[]};const saved=state.snapshots;state.snapshots=[mon];const e=mergedEpisodes().find(x=>x.id==='mon-999221');const n=e&&pregNextAction(e);const ok=!!e&&e.origin==='monitora'&&needsData(e)&&isPriority2I(e)&&n.kind==='dados'&&pregDisplayName(e)==='Usuária 999221'&&pregTags(e).includes('Dados a completar');state.snapshots=saved;return ok});
  await add('222. Puerpério no Monitora remove da lista quem já estava nela (de forma reversível) e, se restaurada, não é removida de novo na próxima importação',()=>{const mb={id:'sMb222',profile:'metabase_gestantes_2i',createdAt:new Date(Date.now()+9e10).toISOString(),episodes:[{id:'e222',nome:'Bia',prontuario:'274599',equipe:'ESF 120',status2i:'pendente'}]},mon={id:'sMon222',profile:MONITORA_PROFILE,createdAt:new Date(Date.now()+9e10).toISOString(),monitoraRows:[],puerperio:['274599']};const saved=state.snapshots;state.snapshots=[mb,mon];const removed=applyMonitoraPuerperio(),wasExcluded=state.gestantes.excluded['e222']?.source==='monitora_puerperio';restoreEpisode('e222');const again=applyMonitoraPuerperio();const ok=removed===1&&wasExcluded&&again===0&&!isExcluded('e222');delete state.gestantes.puerperioIgnored['e222'];state.snapshots=saved;return ok});
  await add('223. Dados completados e acompanhamento de uma gestante do Monitora migram para o registro com o mesmo prontuário quando ela aparece no CSV do Metabase, sem sobrescrever o que o Metabase já traz',()=>{const mon={id:'sMon223',profile:MONITORA_PROFILE,createdAt:new Date(Date.now()+9e10).toISOString(),monitoraRows:[{usuaria:'71735',equipe:'120',periodo:'T3',consOdonto:'Não',monitoraOdonto:'pendente'}],puerperio:[]},mb={id:'sMb223',profile:'metabase_gestantes_2i',createdAt:new Date(Date.now()+9e10).toISOString(),episodes:[{id:'e223',nome:'Nome Oficial',prontuario:'71735',equipe:'ESF 120',telefone:'',status2i:'pendente'}]};const saved=state.snapshots;state.snapshots=[mon];state.gestantes.overrides['mon-71735']={nome:'Nome Digitado',telefone:'48988887777'};state.gestantes.followups['mon-71735']={state:'whatsapp_enviado',updatedAt:nowISO(),history:[{at:nowISO(),from:'nao_contatada',to:'whatsapp_enviado'}]};state.snapshots=[mb,mon];migrateMonitoraLinks();const e=mergedEpisodes().find(x=>x.id==='e223');const ok=!!e&&e.nome==='Nome Oficial'&&e.telefone==='48988887777'&&followupFor('e223').state==='whatsapp_enviado'&&!state.gestantes.overrides['mon-71735']&&!state.gestantes.followups['mon-71735'];delete state.gestantes.overrides['e223'];delete state.gestantes.followups['e223'];state.snapshots=saved;return ok});
  await add('224. "Limpar tudo" do 2I e o backup analítico também removem a lista do Monitora APS',()=>{const b=backupState('analytic');return clearAllGestantesData.toString().includes('MONITORA_PROFILE')&&!b.snapshots.some(s=>s.profile===MONITORA_PROFILE)&&profileLabel(MONITORA_PROFILE).includes('Monitora APS')});
  await add('225. idPrefix lê o código "( id )" que o CELK antepõe ao paciente nos relatórios de produção (o mesmo número do prontuário/Usuária); stripIdPrefix continua devolvendo só o nome',()=>idPrefix('( 2149034 ) ABIGAIL ALZIRA DE OLIVEIRA NETA')==='2149034'&&idPrefix('SEM PREFIXO')===''&&stripIdPrefix('( 2149034 ) ABIGAIL ALZIRA DE OLIVEIRA NETA')==='ABIGAIL ALZIRA DE OLIVEIRA NETA');
  await add('226. Procedimentos Detalhado guarda, por mês, os atendimentos por código de paciente (sem nome), sem contar atividade educativa em grupo',async()=>{const csv=['Paciente,Idade,Sexo,Data,Profissional,Procedimento,Unidade,Quantidade','( 071735 ) FULANA,28,F,2026-09-10 09:00:00.0,( 1 ) DENTISTA,ORIENTAÇÃO DE HIGIENE BUCAL,( 257607 ) CS MONTE SERRAT,1','( 071735 ) FULANA,28,F,2026-09-10 09:00:00.0,( 1 ) DENTISTA,PRIMEIRA CONSULTA ODONTOLÓGICA PROGRAMÁTICA,( 257607 ) CS MONTE SERRAT,1','( 555 ) GRUPO,30,F,2026-09-12 09:00:00.0,( 1 ) DENTISTA,ATIVIDADE EDUCATIVA / ORIENTAÇÃO EM GRUPO NA ATENÇÃO PRIMÁRIA,( 257607 ) CS MONTE SERRAT,1'].join('\n');const snap=await parseProcedureCsv({name:'prod.csv'},'hash_selftest_226',csv);sessionRaw.delete(snap.id);const v=snap.dataByMonth['2026-09'].patientVisits;return v.length===1&&v[0].id==='71735'&&v[0].date==='2026-09-10'&&v[0].procs.length===2&&!JSON.stringify(v).includes('FULANA')});
  await add('227. Atendimento na produção do CELK entre a DUM e a DPP (ou o parto, se veio antes) conta a gestante como atendida; antes da DUM, depois da DPP, depois do parto ou sem DUM/DPP não conta (v2.25)',()=>{const d=days=>isoDate(new Date(Date.now()+days*864e5));const snap={id:'sProd227',profile:'celk_procedimentos_detalhado',createdAt:nowISO(),dataByMonth:{x:{patientVisits:[{id:'227001',date:d(-10),procs:['A']},{id:'227002',date:d(-200),procs:['B']},{id:'227003',date:d(-100),procs:['C']},{id:'227004',date:d(-5),procs:['D']},{id:'227005',date:d(-20),procs:['E']},{id:'227006',date:d(-30),procs:['F']}]}}};state.snapshots.push(snap);try{const inside=isAttended({id:'a',status2i:'pendente',prontuario:'0227001',ultimaMenstruacao:d(-150)}),before=isAttended({id:'b',status2i:'pendente',prontuario:'227002',ultimaMenstruacao:d(-150)}),noDum=isAttended({id:'c',status2i:'pendente',prontuario:'227003'}),afterDpp=isAttended({id:'e',status2i:'pendente',prontuario:'227004',dataProvParto:d(-10)}),afterBirth=isAttended({id:'f',status2i:'pendente',prontuario:'227005',ultimaMenstruacao:d(-250),dataParto:d(-25)}),dppOnly=isAttended({id:'g',status2i:'pendente',prontuario:'227006',dataProvParto:d(60)}),noRecord=isAttended({id:'d',status2i:'pendente'});return inside&&!before&&!noDum&&!afterDpp&&!afterBirth&&dppOnly&&!noRecord}finally{state.snapshots=state.snapshots.filter(x=>x!==snap)}});
  await add('228. Backup analítico não leva os códigos de paciente dos atendimentos da produção',()=>backupState.toString().includes('delete month.patientVisits'));
  await add('229. Relatório de produção (CSV) monta o cadastro código → nome do paciente, a partir do "( código ) NOME" do CELK',async()=>{const csv=['Paciente,Idade,Sexo,Data,Profissional,Procedimento,Unidade,Quantidade','( 0229001 ) MARIA DA SILVA,28,F,2026-09-10 09:00:00.0,( 1 ) DENTISTA,ORIENTAÇÃO DE HIGIENE BUCAL,( 257607 ) CS MONTE SERRAT,1','( 229002 ) JOANA SOUZA,30,F,2026-09-11 09:00:00.0,( 1 ) DENTISTA,ORIENTAÇÃO DE HIGIENE BUCAL,( 257607 ) CS MONTE SERRAT,1'].join('\n');const snap=await parseProcedureCsv({name:'prod.csv'},'hash_selftest_229',csv);sessionRaw.delete(snap.id);return snap.patientNames?.['229001']==='MARIA DA SILVA'&&snap.patientNames?.['229002']==='JOANA SOUZA'});
  await add('230. Cadastro de pacientes preenche o nome de uma gestante anonimizada do Monitora APS; o nome digitado à mão continua valendo',()=>{const saved=state.snapshots,dir=state.patientDirectory;state.patientDirectory={...dir,'230001':{nome:'NOME DA PRODUCAO',fonte:'teste'}};state.snapshots=[{id:'sMon230',profile:MONITORA_PROFILE,createdAt:nowISO(),monitoraRows:[{usuaria:'230001',equipe:'120',periodo:'T2',consOdonto:'Não',monitoraOdonto:'pendente'}],puerperio:[]}];const a=mergedEpisodes().find(x=>x.id==='mon-230001');state.gestantes.overrides['mon-230001']={nome:'Nome Digitado'};const b=mergedEpisodes().find(x=>x.id==='mon-230001');delete state.gestantes.overrides['mon-230001'];state.snapshots=saved;state.patientDirectory=dir;return a.nome==='NOME DA PRODUCAO'&&a.nomeDaProducao===true&&b.nome==='Nome Digitado'&&!b.nomeDaProducao});
  await add('231. Cadastro de pacientes: a última importação atualiza o nome, e a busca por código ignora zeros à esquerda',()=>{const dir=state.patientDirectory;state.patientDirectory={};rememberPatientNames({'231001':'GRAFIA ANTIGA'},'teste');const r=rememberPatientNames({'231001':'GRAFIA NOVA'},'teste');const ok=patientNameFor('000231001')==='GRAFIA NOVA'&&r.changed===1&&patientNameFor('')==='';state.patientDirectory=dir;return ok});
  await add('232. Backup analítico não leva o cadastro de pacientes; a mesclagem de backup soma os cadastros',()=>backupState('analytic').patientDirectory&&Object.keys(backupState('analytic').patientDirectory).length===0&&restoreBackup.toString().includes('state.patientDirectory={...(state.patientDirectory||{}),...(incoming.patientDirectory||{})}'));
  await add('233. Fila completa em ordem de prioridade: 3º tri sem atendimento, a contatar, em contato, agendada, atendida e gestação encerrada por último',()=>{const d=days=>isoDate(new Date(Date.now()+days*864e5));const mk=(id,extra)=>({id,nome:id,status2i:'pendente',...extra});const fu=(id,st,extra={})=>state.gestantes.followups[id]={state:st,updatedAt:nowISO(),history:[],...extra};const enc=mk('t233enc',{dataProvParto:d(5),ultimaMenstruacao:d(-275),dataParto:d(-1)}),at=mk('t233at',{dataProvParto:d(10)}),ag=mk('t233ag',{dataProvParto:d(150)}),ct=mk('t233ct',{dataProvParto:d(160)}),ac=mk('t233ac',{dataProvParto:d(170)}),pr=mk('t233pr',{dataProvParto:d(20)});fu('t233at','ok_manual');fu('t233ag','agendada',{agendaAt:d(3)});fu('t233ct','whatsapp_enviado');const order=[enc,at,ag,ct,ac,pr].sort(pregSort).map(e=>e.id.slice(4)).join(',');['t233at','t233ag','t233ct'].forEach(k=>delete state.gestantes.followups[k]);return order==='pr,ac,ct,ag,at,enc'});
  await add('234. Toda mudança (queueSave) agenda a gravação no navegador, e a gravação volta igual na leitura',async()=>{const src=queueSave.toString().includes('scheduleBrowserSave');if(!localSave.enabled)return src;const marker=state.updatedAt;await saveToBrowserNow();const r=await loadFromBrowser();return src&&!!r&&r.state.updatedAt===marker&&r.appVersion===APP_VERSION});
  await add('235. "Limpar dados do navegador" pergunta se quer salvar backup antes (Salvar backup e limpar / Limpar sem backup com segunda confirmação / Cancelar)',()=>{const m=openClearBrowserModal.toString(),ev=setupEvents.toString();return m.includes('Quer salvar um backup antes de limpar?')&&m.includes('data-clear-with-backup')&&m.includes('data-clear-no-backup')&&ev.includes('Confirmar: apagar sem backup')&&createBackupFromModal.toString().includes('clearAfter')&&clearBrowserData.toString().includes('state=defaultState()')});
  await add('236. Ao abrir, o app carrega o que estava salvo neste navegador (se o salvamento estiver ligado)',()=>{const src=bootstrap.toString();return src.includes('readAutosavePref()')&&src.includes('loadFromBrowser()')&&src.includes('migrateState(state)')});
  await add('237. "O que falta para bater as metas" lista sempre M1, M2, M3, M4 e M5 nessa ordem, sem reordenar pela distância da meta',()=>{const mk=state.preferences.month,html=ovPlanHTML(mk,'month'),order=[...html.matchAll(/class="ov-id"[^>]*>(M\d)</g)].map(m=>m[1]),pos=OVERVIEW_IDS.map(id=>order.indexOf(id));return order.join()===OVERVIEW_IDS.join()&&pos.every((p,i)=>p===i)});
  await add('238. Sem denominador confirmado, M1/M3 aparecem na lista como tarefa "Confirmar" (não como cartão vazio), e a situação dos dados aponta a falta',()=>{const before=state.denominators.length,mk='2099-01',prev={month:state.preferences.month,year:state.preferences.year,quarter:state.preferences.quarter};try{state.preferences.year=2099;state.preferences.quarter=1;state.preferences.month=mk;const row=ovPlanRow('M3',mk,'month'),src=ovSources(mk).find(x=>x.title.startsWith('Denominador de M3'));return row.includes('não confirmado')&&row.includes('>Confirmar<')&&src&&!src.ok&&!ovSourcesHTML.toString().includes('Metabase consolidado')}finally{state.denominators.length=before;Object.assign(state.preferences,prev)}});
  await add('239. Denominador de M1 pela população ativa: população ÷ ESF × dentistas; salvar de novo atualiza o mesmo registro (sem duplicar) e população digitada fica marcada como digitada',()=>{const beforeD=state.denominators.length,beforeP=state.populationInputs.length,prev={month:state.preferences.month,year:state.preferences.year,quarter:state.preferences.quarter};try{state.preferences.year=2098;state.preferences.quarter=1;state.preferences.month='2098-01';const a=applyPopulationDenominator('2098-01',45434,8,2),v1=Number(getDenominator('M1','municipal','2098-01').value);const b=applyPopulationDenominator('2098-01',50000,8,2),d2=getDenominator('M1','municipal','2098-01');return a.value===11358.5&&v1===11358.5&&b.value===12500&&Number(d2.value)===12500&&state.denominators.length===beforeD+1&&state.populationInputs.length===beforeP+1&&b.record.manualTotal===true&&d2.origin==='População ativa digitada'}finally{state.denominators.length=beforeD;state.populationInputs.length=beforeP;Object.assign(state.preferences,prev)}});
  await add('240. Cartões da Visão Geral mostram só os 4 meses do quadrimestre, e o denominador digitado à mão vale do mês em foco até o fim do quadrimestre (não altera meses anteriores)',()=>{const beforeD=state.denominators.length,prev={month:state.preferences.month,year:state.preferences.year,quarter:state.preferences.quarter};try{state.preferences.year=2097;state.preferences.quarter=1;state.preferences.month='2097-02';const bars=ovQuarterBarsHTML('M2','2097-02'),labels=(bars.match(/<span>[a-z]{3}<\/span>/g)||[]).length;const r=applyManualDenominator('M3','2097-02',4200);return labels===4&&r.start==='2097-02'&&r.end==='2097-04'&&!getDenominator('M3','municipal','2097-01')}finally{state.denominators.length=beforeD;Object.assign(state.preferences,prev)}});
  await add('241. Gaveta do indicador: M4 e M5 mostram o que entrou no numerador e no denominador (marcando o que conta nos dois), M1 tem a conta da população ativa e todos levam à conferência completa com SIGTAP',()=>{const c=ovComposition.toString(),d=ovDenomSection.toString(),o=openIndicatorDetail.toString();return c.includes('O que entrou no denominador')&&ovDetailRows.toString().includes('também no numerador')&&d.includes('id="ovPop"')&&d.includes('id="ovEsf"')&&d.includes('id="ovDent"')&&o.includes('data-composition="municipal|')&&!o.includes('Por profissional')});
  await add('242. Dois arquivos do Monitora APS se somam: quem não veio no segundo é mantida, a mesma Usuária não duplica, o período mais recente vale, "Sim" em Cons.Odonto não volta para "Não" e Puerpério no arquivo mais recente tira da lista',()=>{const saved=state.snapshots;try{const t=Date.now();const a={id:'sMonA242',profile:MONITORA_PROFILE,createdAt:new Date(t).toISOString(),monitoraRows:[{usuaria:'1',equipe:'120',periodo:'T2',consOdonto:'Sim',monitoraOdonto:'atende'},{usuaria:'2',equipe:'120',periodo:'T1',consOdonto:'Não',monitoraOdonto:'pendente'},{usuaria:'3',equipe:'121',periodo:'T3',consOdonto:'Não',monitoraOdonto:'pendente'}],puerperio:[]},b={id:'sMonB242',profile:MONITORA_PROFILE,createdAt:new Date(t+1000).toISOString(),monitoraRows:[{usuaria:'1',equipe:'120',periodo:'T3',consOdonto:'Não',monitoraOdonto:'pendente'},{usuaria:'4',equipe:'122',periodo:'T1',consOdonto:'Não',monitoraOdonto:'pendente'}],puerperio:['3']};state.snapshots=[b,a];const m=mergedMonitora(),r=Object.fromEntries(m.monitoraRows.map(x=>[x.usuaria,x]));return m.monitoraRows.length===3&&!!r['2']&&!!r['4']&&!r['3']&&r['1'].periodo==='T3'&&r['1'].monitoraOdonto==='atende'&&m.puerperio.join()==='3'&&m.files===2}finally{state.snapshots=saved}});
  await add('243. Dois CSVs de gestantes do Metabase se somam por episódio: sem duplicar, o dado mais recente atualiza, campo vazio não apaga o que havia e "atende" não volta para "pendente"',()=>{const saved=state.snapshots;try{const t=Date.now();const a={id:'sMbA243',profile:'metabase_gestantes_2i',createdAt:new Date(t).toISOString(),episodes:[{id:'e1',nome:'Ana',telefone:'48999990001',status2i:'atende',consultaSaudeBucal:'Sim'},{id:'e2',nome:'Bia',telefone:'',status2i:'pendente'}]},b={id:'sMbB243',profile:'metabase_gestantes_2i',createdAt:new Date(t+1000).toISOString(),episodes:[{id:'e1',nome:'Ana Maria',telefone:'',status2i:'pendente',consultaSaudeBucal:'Não'},{id:'e3',nome:'Cris',status2i:'pendente'}]};state.snapshots=[a,b];const list=merged2IEpisodes(),r=Object.fromEntries(list.map(x=>[x.id,x]));return list.length===3&&r.e1.nome==='Ana Maria'&&r.e1.telefone==='48999990001'&&r.e1.status2i==='atende'&&!!r.e2&&!!r.e3}finally{state.snapshots=saved}});
  await add('244. Importar um novo CSV de gestantes (Metabase ou Monitora) não marca o anterior como substituído, e o resumo da importação diz quantas eram novas, atualizadas, iguais e mantidas',()=>{const c=commitSnapshot.toString(),r=recomputeSupersession.toString(),i=importOne.toString();return c.includes('CUMULATIVE_2I_PROFILES.includes(snap.profile)')&&r.includes('CUMULATIVE_2I_PROFILES.includes(s.profile)')&&i.includes('cumulativeImportSummary')&&i.includes('somado aos anteriores')});
  await add('245. fedNextBand: B1 só soma no numerador, B5 abaixo de 85% soma nos dois lados, B5 acima de 85% e B3 só no denominador, B3 abaixo de 3% não recomenda exodontia, média do quadrimestre (B1/B4) e faixa Ótimo já alcançada',()=>{const b1=fedNextBand('B1',{numerator:5,denominator:1000}),b5=fedNextBand('B5',{numerator:30,denominator:100}),b5h=fedNextBand('B5',{numerator:90,denominator:100}),b3=fedNextBand('B3',{numerator:20,denominator:100}),b3l=fedNextBand('B3',{numerator:1,denominator:100}),avg=fedNextBand('B1',{average:true,sumResults:2,denRef:1000}),done=fedNextBand('B6',{numerator:9,denominator:100});
    const ok=(r,c,l)=>r&&r.count===c&&r.label===l;
    return ok(b1,3,'Bom')&&b1.unit==='primeiras consultas'&&ok(b5,17,'Suficiente')&&ok(b5h,6,'Ótimo')&&b5h.unit==='procedimentos não preventivos'&&ok(b3,43,'Suficiente')&&!!b3l?.note&&b3l.note.includes('não recomenda')&&ok(avg,11,'Bom')&&done?.done===true});
  await add('246. Gaveta aberta pela página Municipal usa o escopo do botão (quadrimestre), sem mudar a preferência da Visão Geral; sem escopo, segue a Visão Geral',()=>{const prev=state.preferences.overviewScope;try{state.preferences.overviewScope='month';openIndicatorDetail('M2','quarter');const q=document.querySelector('#drawer .pq-d-sub')?.textContent||'',sq=ovDetailScope;openIndicatorDetail('M2');const m=document.querySelector('#drawer .pq-d-sub')?.textContent||'';return q.includes(`Quadrimestre Q${state.preferences.quarter}`)&&sq==='quarter'&&!m.includes('Quadrimestre Q')&&ovDetailScope===null&&state.preferences.overviewScope==='month'}finally{state.preferences.overviewScope=prev;closeDrawer()}});
  await add('247. Gaveta federal: B1 (espelho) aponta para os números do M1; B5 e B3 mostram "Para subir de faixa" ou "Para calcular", o mês a mês com a coluna Faixa e a conferência completa',()=>{try{openFederalDetail('B1');const b1=document.getElementById('drawer').innerHTML;openFederalDetail('B5');const b5=document.getElementById('drawer').innerHTML;openFederalDetail('B3');const b3=document.getElementById('drawer').innerHTML;return b1.includes('Mesmos números do M1')&&b1.includes('data-indicator-detail="M1"')&&[b5,b3].every(h=>(h.includes('Para subir de faixa')||h.includes('Para calcular'))&&h.includes('Mês a mês no quadrimestre')&&h.includes('<th>Faixa</th>')&&h.includes('Conferência completa'))&&b5.includes('data-fed-detail-open="B5"')&&b3.includes('data-composition="federal|B3|')}finally{closeDrawer()}});
  await add('248. Configurações (v2.17) sem blocos repetidos ou sem uso: saem "Nota quadrimestral desejada", "Prioridade das fontes" como campo, "Interpretação do CSV 2I", "Sessão atual", "Fontes mais recentes" e a tabela em JSON; a regra de duplicidade diz que as listas de gestantes se somam',()=>{const prev=state.preferences.settingsTab;try{let all='';for(const t of ['geral','imports','diagnostics','conferencia']){state.preferences.settingsTab=t;all+=settingsHTML()}return !all.includes('Nota quadrimestral desejada')&&!all.includes('Prioridade das fontes')&&!all.includes('Interpretação do CSV 2I')&&!all.includes('Sessão atual')&&!all.includes('Fontes mais recentes')&&!all.includes('Manual rápido')&&all.includes('Os arquivos se somam')&&all.includes('Limites das fontes')}finally{state.preferences.settingsTab=prev}});
  await add('249. Verificação: avisos que valem para todo arquivo de um tipo vão para "Limites das fontes" (não viram pendência), avisos iguais se agrupam (×n), denominador faltando tem o botão Confirmar que abre a gaveta no mês e os títulos ficam em português com o código pequeno',()=>{const g=groupDiagnostics([{level:'info',code:'2I_PHONE_INVALID',message:'x'},{level:'info',code:'2I_PHONE_INVALID',message:'x'}]);const row=diagRowHTML({level:'warning',code:'M3_DEN_MISSING',message:'m'});const {todo}=settingsDiagnostics();return g.length===1&&g[0].count===2&&diagRowHTML(g[0]).includes('×2')&&row.includes('data-indicator-detail="M3" data-detail-scope="month"')&&row.includes('M3 e B4 sem denominador')&&row.includes('class="st-code">M3_DEN_MISSING')&&todo.every(d=>!SOURCE_LIMIT_CODES.includes(d.code)&&d.level!=='info')});
  await add('250. Conferir abre a gaveta do arquivo: "O que o arquivo trouxe", aba Procedimentos só na produção, avisos, linhas lidas e a assinatura em Detalhes técnicos; arquivo substituído avisa que não entra em nenhum cálculo',()=>{const before=state.snapshots.length;try{const prod={id:'tsnapA_selftest',profile:'celk_procedimentos_detalhado',unit:'U',fileName:'prod.pdf',hash:'abc123hash',createdAt:nowISO(),status:'x',validations:[{level:'warning',code:'TRUNCATED_RESTORATION',message:'m'}],procedureCounts:[{descriptionNormalized:'Exodontia',descriptionOriginal:'EXO',sigtap:'04.14.02.013-8',quantityRaw:3,quantityValid:2,roles:['b3num'],pages:[1]}],dataByMonth:{'2026-02':{kind:'procedure',firstConsultations:4,treatmentsConcluded:1}}};const g2={id:'tsnapB_selftest',profile:'metabase_gestantes_2i',unit:'U',fileName:'g.csv',hash:'h2',createdAt:nowISO(),status:'x',validations:[],episodes:[{id:'e1',status2i:'atende',equipe:'A'}],dataByMonth:{},supersededBy:null};const old={...prod,id:'tsnapC_selftest',fileName:'velho.pdf',supersededBy:'tsnapA_selftest'};state.snapshots.push(prod,g2,old);
    openSnapshot(prod.id);const a0=document.getElementById('drawer').innerHTML;openSnapshot(prod.id,'avisos');const a=a0+document.getElementById('drawer').innerHTML;openSnapshot(g2.id);const b=document.getElementById('drawer').innerHTML;openSnapshot(old.id);const c=document.getElementById('drawer').innerHTML;
    return a.includes('O que o arquivo trouxe')&&a.includes('data-snapshot-tab="content"')&&a.includes('>Procedimentos<')&&a.includes('Avisos (1)')&&a.includes('Linhas lidas')&&a.includes('abc123hash')&&a.includes('Descrição de restauração abreviada')&&!a.includes('"kind"')&&!b.includes('>Procedimentos<')&&b.includes('gestantes no arquivo')&&c.includes('Não entra em nenhum cálculo')&&c.includes('Substituído')}finally{state.snapshots.length=before;closeDrawer()}});
  await add('251. Arquivos importados ficam agrupados por tipo de relatório, com o estado de cada um: Em uso, Somado (listas de gestantes) ou Substituído',()=>{const before=state.snapshots.length;try{state.snapshots.push({id:'tsA_selftest',profile:'celk_procedimentos_detalhado',fileName:'p1.pdf',createdAt:nowISO(),procedureCounts:[],dataByMonth:{}},{id:'tsB_selftest',profile:'celk_procedimentos_detalhado',fileName:'p0.pdf',createdAt:nowISO(),procedureCounts:[],dataByMonth:{},supersededBy:'tsA_selftest'},{id:'tsC_selftest',profile:'monitora_aps_gestantes',fileName:'m.csv',createdAt:nowISO(),monitoraRows:[{}],puerperio:[],dataByMonth:{}});const h=importsHTML();return h.includes('Produção <span>CELK · Procedimentos Detalhado</span>')&&h.includes('Gestantes <span>Monitora APS</span>')&&h.includes('st-tag use">Em uso')&&h.includes('st-tag old">Substituído')&&h.includes('st-tag sum">Somado')&&h.includes('1 gestantes e 0 puérperas')}finally{state.snapshots.length=before}});
  await add('252. Conferência por procedimento mostra em que indicador cada procedimento entra como "M1 num"/"M2 den" e mantém a exportação em CSV',()=>{const chips=procedureRoleChips({roles:['first']});const src=procedureCheckHTML.toString();return chips.includes('M1 num')&&chips.includes('B1 num')&&chips.includes('M2 den')&&src.includes('data-export-procedures')});
  await add('254. Restauração com descrição completa (como no CSV do CELK) é reconhecida pelo tipo, com o SIGTAP da Nota B5, sem o aviso de descrição abreviada; a descrição cortada continua na regra genérica com o aviso',()=>{const c=[['RESTAURAÇÃO DE DENTE PERMANENTE ANTERIOR COM RESINA COMPOSTA','03.07.01.003-1'],['RESTAURAÇÃO DE DENTE PERMANENTE POSTERIOR COM RESINA COMPOSTA','03.07.01.012-0'],['RESTAURAÇÃO DE DENTE DECÍDUO POSTERIOR COM RESINA COMPOSTA','03.07.01.008-2'],['RESTAURAÇÃO DE DENTE DECÍDUO POSTERIOR COM IONÔMERO DE VIDRO','03.07.01.010-4'],['RESTAURAÇÃO DE DENTE DECÍDUO ANTERIOR COM RESINA COMPOSTA.','03.07.01.011-2']];const cut=procedureMatch('RESTAURAÇÃO DE DENTE PERMANENTE POS');return c.every(([d,code])=>{const m=procedureMatch(d);return m.code===code&&!m.ambiguous&&['restorative','m4den','b5den','b3den'].every(r=>m.roles.includes(r))})&&cut.ambiguous===true&&cut.roles.includes('b5den')});
  await add('255. Colar data: dd/mm/aaaa, dd-mm-aa, dd.mm.aaaa e aaaa-mm-dd (com ou sem hora) viram aaaa-mm-dd; data impossível ou texto qualquer não é aceito',()=>pastedDateToIso('05/03/2026')==='2026-03-05'&&pastedDateToIso(' 5-3-26 ')==='2026-03-05'&&pastedDateToIso('05.03.2026 14:30')==='2026-03-05'&&pastedDateToIso('2026-03-05')==='2026-03-05'&&pastedDateToIso('2026-03-05 08:05:13.478')==='2026-03-05'&&pastedDateToIso('31/02/2026')===''&&pastedDateToIso('ontem')===''&&pastedDateToIso('')==='');
  await add('256. Lista de gestantes: a ordenação calcula a situação de cada gestante uma vez (pregSortKey) e dá o mesmo resultado que a comparação direta; parseDate guarda o resultado sem devolver o mesmo objeto',()=>{const eps=visibleByExclusion(mergedEpisodes());const a=[...eps].sort(pregSort).map(e=>e.id),keys=new Map(eps.map(e=>[e,pregSortKey(e)])),b=[...eps].sort((x,y)=>pregSortKeys(keys.get(x),keys.get(y))).map(e=>e.id);const d1=parseDate('05/03/2026'),d2=parseDate('05/03/2026');return a.join()===b.join()&&d1!==d2&&+d1===+d2&&parseDate('xx')===null&&parseDate('xx')===null});
  await add('257. refreshAll desenha só a página aberta; as outras são desenhadas ao abrir (switchView) e renderAllViews desenha as pendentes',()=>{const prev=activeView;try{switchView('overview',{save:false});refreshAll();const staleOk=staleViews.has('settings')&&!staleViews.has('overview');switchView('settings',{save:false});const rendered=!staleViews.has('settings')&&document.getElementById('view-settings').innerHTML.includes('Salvamento e backup');renderAllViews();return staleOk&&rendered&&staleViews.size===0}finally{switchView(prev,{save:false})}});
  await add('258. Excluir um arquivo importado tira os dados dele do cálculo e da lista, devolve o arquivo substituído do mesmo período, mantém denominadores e o acompanhamento das gestantes, e registra na auditoria',()=>{const before=state.snapshots.length,u=state.preferences.unit,mk=state.preferences.month,fu=JSON.stringify(state.gestantes.followups);try{const base={kind:'procedure',firstConsultations:0,firstConsultationQuantity:0,treatmentsConcluded:0,treatmentConcludedQuantity:0,preventive:4,individualProcedures:10,art:0,restorative:0,b5Denominator:10,b3Numerator:0,b3Denominator:0,procedureCounts:[],firstPatients:[],concludedPatients:[]};const mk2='2031-01';const old={id:'tdelA_selftest',profile:'celk_procedimentos_detalhado',unit:u,fileName:'antigo.pdf',createdAt:'2031-01-02T00:00:00Z',periodStart:'2031-01-01',periodEnd:'2031-01-31',status:'x',validations:[],procedureCounts:[],dataByMonth:{[mk2]:{...base,preventive:2}}};const neu={...old,id:'tdelB_selftest',fileName:'novo.pdf',createdAt:'2031-01-03T00:00:00Z',dataByMonth:{[mk2]:{...base,preventive:5}}};state.snapshots.push(old,neu);recomputeSupersession();const a=municipalComponents('M4',mk2).numerator;const impact=snapshotDeleteImpact(neu).join(' ');const denBefore=state.denominators.length;const del=deleteSnapshot(neu.id);const b=municipalComponents('M4',mk2).numerator;return a===5&&b===2&&!!del&&!state.snapshots.some(s=>s.id===neu.id)&&!old.supersededBy&&impact.includes('antigo.pdf')&&state.denominators.length===denBefore&&JSON.stringify(state.gestantes.followups)===fu&&state.audit.at(-1).action==='snapshot_deleted'}finally{state.snapshots=state.snapshots.filter(s=>!/^tdel[AB]_selftest$/.test(s.id));while(state.snapshots.length>before)state.snapshots.pop();recomputeSupersession()}});
  await add('259. Filtro "Dados incompletos" na lista de gestantes: mostra só quem não tem nome, telefone válido ou DUM/DPP, e cada linha diz o que falta',()=>{const p=state.preferences,prev=p.pregIncomplete;try{const a={nome:'Ana',phoneNormalized:'5548999990000',ultimaMenstruacao:'2026-03-01'},b={nome:'',phoneNormalized:'',dataProvParto:''};const ok1=missingDataFields(a).length===0&&missingDataFields(b).join(',')==='nome,telefone,DUM ou DPP';p.pregIncomplete=true;const f=applyPregFilters([{...a,id:'x1'},{...b,id:'x2'}]);const tag=pregTags({...b,id:'x2',prontuario:''});p.pregIncomplete=false;const all=applyPregFilters([{...a,id:'x1'},{...b,id:'x2'}]);return ok1&&f.length===1&&f[0].id==='x2'&&tag.includes('Falta: nome, telefone, DUM ou DPP')&&all.length===2&&pregnancyHTML.toString().includes('data-preg-incomplete')}finally{p.pregIncomplete=prev}});
  await add('260. Histórico da gestante mostra todos os atendimentos dela na produção do CELK, de qualquer data; os de fora do período DUM–DPP aparecem marcados como "não conta"',()=>{const d=days=>isoDate(new Date(Date.now()+days*864e5));const snap={id:'sProd260',profile:'celk_procedimentos_detalhado',createdAt:nowISO(),dataByMonth:{x:{patientVisits:[{id:'260001',date:d(-400),procs:['Antigo']},{id:'260001',date:d(-20),procs:['Recente']}]}}};state.snapshots.push(snap);try{const e={id:'e260',status2i:'pendente',prontuario:'260001',ultimaMenstruacao:d(-100)};return productionVisitsAllFor(e).length===2&&productionVisitsFor(e).length===1&&productionVisitsAllFor({prontuario:''}).length===0}finally{state.snapshots=state.snapshots.filter(x=>x!==snap)}});
  await add('261. Procedimentos Detalhado guarda, em cada atendimento, sexo, idade e todos os registros do dia (procedimento, quantidade, dentista e papel: 1ª consulta, conclusão, urgência) para a análise estatística, sem nome',async()=>{const csv=['Paciente,Idade,Sexo,Data,Profissional,Procedimento,Unidade,Quantidade','( 261001 ) FULANA,28 Anos,Feminino,2026-09-10 09:00:00.0,( 1 ) DENTISTA X,PRIMEIRA CONSULTA ODONTOLÓGICA PROGRAMÁTICA,( 257607 ) CS MONTE SERRAT,1','( 261001 ) FULANA,28 Anos,Feminino,2026-09-10 09:00:00.0,( 1 ) DENTISTA X,EXODONTIA DE DENTE PERMANENTE,( 257607 ) CS MONTE SERRAT,2','( 261001 ) FULANA,28 Anos,Feminino,2026-09-10 09:00:00.0,( 1 ) DENTISTA X,TRATAMENTO CONCLUÍDO,( 257607 ) CS MONTE SERRAT,1','( 261002 ) BELTRANO,5 Meses,Masculino,2026-09-11 09:00:00.0,( 2 ) DENTISTA Y,ATENDIMENTO DE URGÊNCIA EM ATENÇÃO BÁSICA,( 257607 ) CS MONTE SERRAT,1'].join('\n');const snap=await parseProcedureCsv({name:'prod.csv'},'hash_selftest_261',csv);sessionRaw.delete(snap.id);const v=snap.dataByMonth['2026-09'].patientVisits,a=v.find(x=>x.id==='261001'),b=v.find(x=>x.id==='261002');const exo=a.items.find(x=>/Exodontia/i.test(x[0]));return a.sex==='Feminino'&&a.age===28&&b.age===0&&exo[1]===2&&exo[2]==='DENTISTA X'&&a.items.some(x=>x[3].includes('f'))&&a.items.some(x=>x[3].includes('c'))&&b.items[0][3].includes('u')&&!JSON.stringify(v).match(/FULANA|BELTRANO/)});
  await add('262. Análise estatística monta uma linha por paciente: concluiu no mesmo dia da 1ª consulta, urgência, dentista principal, nº de procedimentos e "Teve o procedimento…"; quem não teve 1ª consulta fica vazio em "concluiu"',()=>{const it=(n,q,prof,fl)=>[n,q,prof,fl];const snap={id:'sx262',profile:'celk_procedimentos_detalhado',unit:'U262',createdAt:nowISO(),dataByMonth:{'2026-09':{patientVisits:[{id:'1',date:'2026-09-02',sex:'Feminino',age:30,procs:[],items:[it('Primeira consulta odontológica programada',1,'Dra A','fn'),it('Exodontia de dente permanente',1,'Dra A',''),it('Tratamento concluído (campo Conduta)',1,'Dra A','cn')]},{id:'2',date:'2026-09-03',sex:'Masculino',age:8,procs:[],items:[it('Atendimento de urgência em atenção',1,'Dr B','nu'),it('Profilaxia / remoção da placa bacteriana',1,'Dr B','')]},{id:'2',date:'2026-09-20',sex:'Masculino',age:8,procs:[],items:[it('Restauração de dente permanente anterior',2,'Dra A','')]}]}}};state.snapshots.push(snap);sxCache={key:'',value:null};try{const {rows}=sxPatientRows(['2026-09'],'U262'),r1=rows.find(r=>r[17]===30),r2=rows.find(r=>r[17]===8);return rows.length===2&&r1[6]==='Sim'&&r1[7]==='Sim'&&r1[8]==='Sim'&&r1[20]===0&&r1[13]==='Sim'&&r1[22].includes('Exodontia de dente permanente')&&r2[7]===null&&r2[10]==='Sim'&&r2[11]==='Sim'&&r2[12]==='Sim'&&r2[9]==='Sim'&&r2[18]===2&&r2[19]===3&&r2[3]==='Sim'&&r2[21]===2&&r2[1]==='0–11'}finally{state.snapshots=state.snapshots.filter(x=>x!==snap);sxCache={key:'',value:null}}});
  await add('263. Testes estatísticos batem com valores de referência: qui-quadrado (3,84 com 1 gl → p 0,05), Fisher (3/1/1/3 → 0,486), Wilson (169 de 212 → 73,8% a 84,6%) e regressão logística (OR 4 numa tabela 2×2)',()=>{const [p,lo,hi]=sxWilson(169,212);const X=[],y=[];for(let i=0;i<10;i++){X.push([1,0]);y.push(i<2?1:0);X.push([1,1]);y.push(i<5?1:0)}const m=sxLogit(X,y);return Math.abs(sxChi2p(3.841459,1)-0.05)<1e-4&&Math.abs(sxFisher(3,1,1,3)-0.4857)<1e-3&&Math.abs(lo-0.738)<0.001&&Math.abs(hi-0.846)<0.001&&Math.abs(Math.exp(m.b[1])-4)<1e-6&&Math.abs(sxTp(2.0452,29)-0.05)<1e-3}); 
  await add('264. Monitora APS guarda os 9 indicadores de todas as usuárias (inclusive puérperas) para a análise estatística; com dois arquivos vale a informação mais recente',async()=>{const h='Unidade,Equipe,Usuária,Período,1ªCons.12s.,7 consultas,7 PA,7 PesoAlt,DTPA,Exames T1,Exames T3,Cons.Puérp.,Cons.Odonto';const s1=await parseMonitoraCSV({name:'m1.csv'},'h264a',[h,'CS,120,26401,T2,Sim,Não,Não,Não,Não,Não,Não,Não,Não','CS,121,26402,Puerpério,Não,Sim,Não,Não,Não,Não,Não,Sim,Sim'].join('\n'));const s2=await parseMonitoraCSV({name:'m2.csv'},'h264b',[h,'CS,120,26401,T3,Sim,Sim,Não,Não,Não,Não,Não,Não,Sim'].join('\n'));sessionRaw.delete(s1.id);sessionRaw.delete(s2.id);s1.createdAt='2026-01-01T00:00:00Z';s2.createdAt='2026-02-01T00:00:00Z';const keep=state.snapshots;state.snapshots=[s1,s2];try{const {rows}=sxMonitoraRows(),a=rows.find(r=>r[1]==='T3'),b=rows.find(r=>r[1]==='Puerpério');return s1.monitoraStat.length===2&&rows.length===2&&a[10]==='Sim'&&a[3]==='Sim'&&b[9]==='Sim'&&b[0]==='121'}finally{state.snapshots=keep}});
  await add('265. Atividades em grupo guardam, por escovação, sexo, idade e avaliação alterada de cada participante (sem nome); a análise conta todos e avisa quantos estão fora da faixa de 6 a 11 anos de M3/B4',()=>{const snap={id:'sx265',profile:'celk_atividades_grupo',unit:'U265',createdAt:nowISO(),dataByMonth:{'2026-09':{kind:'group',activityDetails:[{code:'1',subject:'Escovação Supervisionada - Turma 1',brush:true,temas:'',local:'Escola',turno:'Manhã',kids:[['F',9,1],['M',12,0],['F',null,0]]}]}}};state.snapshots.push(snap);try{const {rows}=sxKidRows(['2026-09'],'U265');return rows.length===3&&rows[0][2]==='Turma 1'&&rows[0][5]==='Sim'&&rows[1][1]==='12 anos'&&rows[2][1]===null&&parseGroupCsv.toString().includes('(a.kids??=[]).push([r.sex')&&statsHTML.toString().includes('fora da faixa de 6 a 11 anos do indicador M3/B4')}finally{state.snapshots=state.snapshots.filter(x=>x!==snap)}});
  await add('266. "Baixar dados para análise" exporta uma linha por pessoa sem código de paciente, troca o nome dos dentistas por Dentista A, B… e gera um script R que refaz a regressão com a mesma referência',()=>{const it=(n,prof,fl)=>[n,1,prof,fl];const visits=[];for(let i=0;i<40;i++)visits.push({id:String(266000+i),date:'2026-09-0'+(1+i%9),sex:i%2?'Feminino':'Masculino',age:10+i,procs:[],items:[it('Primeira consulta odontológica programada',i%3?'Dra Alfa':'Dr Beta','fn'),...(i%4?[it('Tratamento concluído (campo Conduta)','Dra Alfa','cn')]:[])]});const snap={id:'sx266',profile:'celk_procedimentos_detalhado',unit:'U266',createdAt:nowISO(),dataByMonth:{'2026-09':{patientVisits:visits}}};const p=state.preferences,prev={unit:p.unit,procPeriod:p.procPeriod,month:p.month},prevSt=sxSt;state.snapshots.push(snap);sxCache={key:'',value:null};p.unit='U266';p.procPeriod='M';p.month='2026-09';sxSt={...sxSt,base:'pat',test:'lr',a:7,b:null,xs:[2,17],fv:null,fval:null,merge:{},proc:{}};try{const exp=sxExportData(true),txt=JSON.stringify(exp.data),r=sxRScript('x.csv',exp);return exp.data.length===40&&exp.head[0]==='id'&&!txt.includes('2660')&&!txt.includes('Alfa')&&txt.includes('Dentista A')&&/glm\(y ~ dentista \+ I\(idade \/ 10\)/.test(r)&&/ref = "Dentista [AB]"/.test(r)&&!r.includes('Alfa')&&r.includes('read.csv2')}finally{state.snapshots=state.snapshots.filter(x=>x!==snap);Object.assign(p,prev);sxSt=prevSt;sxCache={key:'',value:null}}});
  await add('267. Página Procedimentos tem as abas "Visão geral" e "Análise estatística", e a análise tem os 7 testes, junção de categorias, subgrupo e exportação',()=>{const src=proceduresHTML.toString(),st=statsHTML.toString();return src.includes('data-proc-view="stats"')&&Object.keys(SX_TESTS).join(',')==='chi,ic,p2,tr,gr,co,lr'&&sxVarField.toString().includes('data-sx-mopen')&&st.includes('data-sx-fvar')&&st.includes('data-sx-export')&&st.includes('data-sx-copy')});
  await add('268. CSV de avaliação do PSE é reconhecido pelos cabeçalhos, descarta só quem está pendente no Status Bucal e no Status ART (preenchida em uma das duas entra) e é lido com escola, lesões cavitadas, necessidade de exodontia, dentes de ART e a data da avaliação tirada de "Editado por … em"',async()=>{const h='Nome,Escola,Ano,Turma,Nascimento,CPF,Status Bucal,Lesões cariosas cavitadas,Necessidade de exodontia,Risco,Conduta,PcD,Problemas periodontais,Presença de dor,Indicação ART (Bucal),Escovação supervisionada realizada,Atendimento em consultório,Encaminhado à UBS (Bucal),Aplicação Tópica de Flúor realizada,Observações (Bucal),Editado por (Bucal),Status ART,Tipo de dentição,Dentes a fazer (ART),Dentes feitos (ART),TCLE assinado (ART),Encaminhamento à UBS (ART),Sem necessidade (ART),Observações (ART),Editado por (ART)';const csv=[h,'ANA TESTE,Escola X,4,401 · Matutino,13/09/2016,—,Preenchida,3 a 4 dentes,1 dente,Alto,Encaminhar,Não,Não,Sim,Sim,Não,Não,Sim,Não,—,"Editado por Fulano em 28/09/2026, 21:46",Preenchida,Mista,"54, 55",61,Sim,Não,Não,—,—','CAIO PENDENTE,Escola X,4,401 · Matutino,01/03/2016,—,Pendente,—,—,—,—,Não,Não,Não,Não,Não,Não,Não,Não,—,—,Pendente,—,—,—,Não,Não,Não,—,—','DUDA SO ART,Escola X,4,401 · Matutino,01/04/2016,—,Pendente,—,—,—,—,Não,Não,Não,Não,Não,Não,Não,Não,—,—,Preenchida,—,—,—,Não,Não,Não,—,—','BIA TESTE,Escola X,4,401 · Matutino,01/02/2016,—,Ausente,—,—,—,—,Não,Não,Não,Não,Não,Não,Não,Não,—,—,Ausente,—,—,—,Não,Não,Não,—,—'].join('\n');const snap=await parsePseCSV({name:'pse.csv'},'h268',csv);sessionRaw.delete(snap.id);const [a,duda,b]=snap.pse.kids;return snap.pse.kids.length===3&&!snap.pse.kids.some(k=>k.nome==='CAIO PENDENTE')&&duda.nome==='DUDA SO ART'&&duda.status==='Pendente'&&pseBothPending('Pendente','—')&&!pseBothPending('Pendente','Preenchida')&&!pseBothPending('Preenchida','Pendente')&&snap.validations.some(v=>/1 pendente\(s\) no Status Bucal e no Status ART/.test(v.message))&&detectCSVProfile(h.split(','))==='pse_avaliacao_csv'&&snap.profile===PSE_PROFILE&&snap.pse.escolas[0]==='Escola X'&&a.lesoes==='3 a 4 dentes'&&a.exo==='1 dente'&&a.dor&&a.encUbs&&a.aFazer.join(',')==='54,55'&&a.feitos[0]==='61'&&a.dataAval==='2026-09-28'&&a.nasc==='2016-09-13'&&a.cpf===''&&b.risco===''&&b.dataAval==='2026-09-28'&&CUMULATIVE_2I_PROFILES.includes(PSE_PROFILE)});
  await add('269. Cruzamento do PSE só liga sozinho com dado igual: atividade coletiva por CPF ou nome + nascimento; produção por nome igual e idade no atendimento igual à do nascimento. Nome diferente, nascimento diferente, idade que não confere ou dois prontuários com o mesmo nome ficam "A definir"',()=>{const keep={snaps:state.snapshots,dir:state.patientDirectory,pse:state.pse};try{
      const pse={id:'p269',profile:PSE_PROFILE,createdAt:nowISO(),pse:{escolas:['E'],kids:[['ANA SOUZA','2016-01-10'],['BRUNO LIMA','2016-03-05'],['CAIO REIS','2016-07-01'],['DORA MELO','2015-02-02'],['EVA LUZ','2015-05-05'],['FABIO PAZ','2016-06-06']].map(([nome,nasc])=>({nome,nasc,cpf:'',escola:'E',turma:'T',status:'Preenchida',risco:'Baixo',aFazer:[],feitos:[],dataAval:'2026-09-20'}))}};
      const grp={id:'g269',profile:'celk_atividades_grupo',createdAt:nowISO(),dataByMonth:{},participants:[{nome:'ANA SOUZA',nasc:'2016-01-10',cpf:'111',cns:'898',sexo:'F',date:'2026-09-15'},{nome:'BRUNO LIMA',nasc:'2016-05-03',cpf:'222',sexo:'M',date:'2026-09-15'},{nome:'CAIO DOS REIS',nasc:'2016-07-01',cpf:'333',sexo:'M',date:'2026-09-15'}]};
      const it=[['Profilaxia',1,'D','']];const prod={id:'pr269',profile:'celk_procedimentos_detalhado',createdAt:nowISO(),dataByMonth:{'2026-08':{patientVisits:[{id:'901',date:'2026-08-10',age:11,procs:[],items:it},{id:'902',date:'2026-08-10',age:9,procs:[],items:it},{id:'903',date:'2026-08-10',age:10,procs:[],items:it},{id:'904',date:'2026-08-11',age:10,procs:[],items:it}]}}};
      state.snapshots=[pse,grp,prod];state.patientDirectory={'901':{nome:'DORA MELO'},'902':{nome:'EVA LUZ'},'903':{nome:'FABIO PAZ'},'904':{nome:'FABIO PAZ'}};state.pse={mine:{},dec:{},overrides:{},followups:{}};pseCache={key:'',value:null};pseColCache={key:'',value:[]};pseProdCache={key:'',value:null};prodIndexCache={key:'',map:new Map()};
      const L=n=>pseLinks(pseChildren().find(c=>c.last.nome===n).last);
      const a=L('ANA SOUZA'),b=L('BRUNO LIMA'),c=L('CAIO REIS'),d=L('DORA MELO'),e=L('EVA LUZ'),f=L('FABIO PAZ');
      return a.col?.cpf==='111'&&a.state==='ok'&&b.pendCol&&b.t.colWhy==='nascimento diferente'&&c.pendCol&&c.t.colWhy==='nome diferente'&&d.prod?.code==='901'&&d.state==='ok'&&e.pendProd&&/idade/.test(e.t.prodWhy)&&f.pendProd&&f.t.prod.length===2&&pseCad(pseChildren().find(x=>x.last.nome==='ANA SOUZA').last).sexo==='F'}finally{state.snapshots=keep.snaps;state.patientDirectory=keep.dir;state.pse=keep.pse;pseCache={key:'',value:null};pseColCache={key:'',value:[]};pseProdCache={key:'',value:null};prodIndexCache={key:'',map:new Map()}}});
  await add('270. Acompanhamento do PSE só mostra as crianças marcadas como "meu aluno", e a etapa vira "Atendida" sozinha quando o prontuário ligado tem atendimento depois da avaliação',()=>{const keep={snaps:state.snapshots,dir:state.patientDirectory,pse:state.pse};try{const k=(nome,risco)=>({nome,nasc:'2016-01-01',cpf:'',escola:'E',turma:'T',status:'Preenchida',risco,aFazer:[],feitos:[],dataAval:'2026-09-20'});
      state.snapshots=[{id:'p270',profile:PSE_PROFILE,createdAt:nowISO(),pse:{escolas:['E'],kids:[k('ANA','Alto'),k('BIA','Alto')]}},{id:'pr270',profile:'celk_procedimentos_detalhado',createdAt:nowISO(),dataByMonth:{'2026-09':{patientVisits:[{id:'7001',date:'2026-09-25',age:10,procs:[],items:[['Restauração',1,'D','']]}]}}}];state.patientDirectory={'7001':{nome:'ANA'}};state.pse={mine:{},dec:{},overrides:{},followups:{}};pseCache={key:'',value:null};pseProdCache={key:'',value:null};prodIndexCache={key:'',map:new Map()};
      const [a,b]=pseChildren().map(c=>c.last);const before=pseAcompHTML().includes('Nenhum aluno seu');state.pse.mine[a.key]=true;const html=pseAcompHTML();return before&&html.includes('Ana')&&!html.includes('Bia')&&pseStage(a)==='atendida'&&pseStage(b)==='contatar'}finally{state.snapshots=keep.snaps;state.patientDirectory=keep.dir;state.pse=keep.pse;pseCache={key:'',value:null};pseProdCache={key:'',value:null};prodIndexCache={key:'',map:new Map()}}});
  await add('271. Atividades em grupo guardam os participantes com CPF e CNS para o cruzamento com o PSE, e o backup analítico tira as avaliações do PSE, o acompanhamento e esses participantes',()=>{const keep={snaps:state.snapshots,pse:state.pse};try{state.snapshots=[{id:'p271',profile:PSE_PROFILE,createdAt:nowISO(),pse:{kids:[]}},{id:'g271',profile:'celk_atividades_grupo',createdAt:nowISO(),dataByMonth:{},participants:[{nome:'X',cpf:'1'}]}];state.pse={mine:{a:true},dec:{},overrides:{a:{tel:'1'}},followups:{}};const c=backupState('analytic'),full=backupState('full');return parseGroupCsv.toString().includes('snap.participants=')&&!c.snapshots.some(s=>s.profile===PSE_PROFILE)&&!c.snapshots.some(s=>s.participants)&&!Object.keys(c.pse.mine).length&&!Object.keys(c.pse.overrides).length&&full.snapshots.some(s=>s.participants)&&full.pse.mine.a}finally{state.snapshots=keep.snaps;state.pse=keep.pse}});
  await add('272. Página PSE no menu: Panorama com todas as avaliações (lesões cavitadas e exodontia), Meus alunos, Acompanhamento e Vínculos a definir; e a base "Crianças do PSE" na análise estatística',()=>{const src=pseHTML.toString()+psePanoramaHTML.toString();return VIEW_RENDERERS.pse&&VIEW_META.pse&&src.includes("['def','Vínculos a definir'")&&src.includes('Lesões cariosas cavitadas')&&src.includes('Necessidade de exodontia')&&SX_BASES.pse&&SX_BASES.pse.vars.some(v=>v.k==='lesoes_cavitadas')&&SX_BASES.pse.vars.some(v=>v.k==='atendida_depois')&&sxBaseData.toString().includes('pseStatRows')});
  await add('273. No PSE, um dia na produção só com orientação de higiene bucal + aplicação tópica de flúor (com ou sem "atendimento odontológico" ou "urgência") é o lançamento do flúor da escola e não conta como atendida; restauração ou primeira consulta conta. A fila de acompanhamento filtra por mais de uma equipe',()=>{const it=(n,f='')=>[n,1,'D',f];const fl=pseIsSchoolFluor({items:[it('Orientação em higiene bucal'),it('Atendimento odontológico (registro geral de atendimento)','n'),it('Aplicação tópica de flúor')]}),urg=pseIsSchoolFluor({items:[it('Aplicação tópica de flúor'),it('Orientação em higiene bucal'),it('Atendimento de urgência em atenção','nu')]}),rest=pseIsSchoolFluor({items:[it('Aplicação tópica de flúor'),it('Restauração de dente decíduo')]}),pc=pseIsSchoolFluor({items:[it('Primeira consulta odontológica programada','fn'),it('Aplicação tópica de flúor')]}),ori=pseIsSchoolFluor({items:[it('Orientação em higiene bucal')]});const src=pseAcompHTML.toString()+pseClick.toString();return fl&&urg&&!rest&&!pc&&!ori&&src.includes('data-ps-team')&&src.includes('pseEquipes')});
  await add('274. Gaveta da criança do PSE: registros feitos por você (agendamento, contatos, atendida, notas) podem ser removidos e a etapa volta a ser calculada; aba "Histórico" mostra todos os atendimentos do prontuário com os procedimentos, as escovações e as avaliações do PSE',()=>{const keep={snaps:state.snapshots,dir:state.patientDirectory,pse:state.pse};try{const k={nome:'ANA',nasc:'2016-01-01',cpf:'',escola:'E',turma:'T',status:'Preenchida',risco:'Alto',aFazer:[],feitos:[],dataAval:'2026-09-20'};
      state.snapshots=[{id:'p274',profile:PSE_PROFILE,createdAt:nowISO(),pse:{escolas:['E'],kids:[k]}},{id:'pr274',profile:'celk_procedimentos_detalhado',createdAt:nowISO(),dataByMonth:{'2026-08':{patientVisits:[{id:'7401',date:'2026-08-10',age:10,procs:[],items:[['Profilaxia',1,'DRA X',''],['Restauração de dente decíduo',2,'DRA X','']]}]}}}];state.patientDirectory={'7401':{nome:'ANA'}};state.pse={mine:{},dec:{},overrides:{},followups:{}};pseCache={key:'',value:null};pseProdCache={key:'',value:null};prodIndexCache={key:'',map:new Map()};
      const r=pseChildren()[0].last;state.pse.mine[r.key]=true;pseRegister(r.key,'agendada','Consulta agendada para 01/10/2026','agendada',{agendaAt:'2026-10-01'});const s1=pseStage(r);state.pse.followups[r.key].history.splice(0,1);const s2=pseStage(r);const h=pseHistHTML(r,pseChildren()[0],pseLinks(r));
      return s1==='agendada'&&s2==='contatar'&&h.includes('Restauração de dente decíduo ×2')&&h.includes('Prontuário 7401')&&h.includes('Avaliações do PSE')&&pseClick.toString().includes('data-ps-del')}finally{state.snapshots=keep.snaps;state.patientDirectory=keep.dir;state.pse=keep.pse;pseCache={key:'',value:null};pseProdCache={key:'',value:null};prodIndexCache={key:'',map:new Map()}}});
  await add('276. PSE: criança só da ação de ART (parte bucal pendente ou vazia e Status ART preenchido) fica à parte: não entra em "Risco por turma" nem nas porcentagens de risco, aparece no card "Só ação de ART" e tem o chip "Só ART"',()=>{const keep={snaps:state.snapshots,pse:state.pse};try{const k=(nome,turma,status,risco,statusArt,aFazer=[])=>({nome,nasc:'2016-01-01',cpf:'',escola:'E',turma,status,risco,statusArt,aFazer,feitos:[],dataAval:'2026-09-20'});
      state.snapshots=[{id:'p276',profile:PSE_PROFILE,createdAt:nowISO(),pse:{escolas:['E'],kids:[k('ANA','401','Preenchida','Alto','Pendente'),k('BIA','ART 1','Pendente','','Preenchida',['55','65']),k('CAI','ART 1','','','Preenchida')]}}];state.pse={mine:{},dec:{},overrides:{},followups:{}};pseCache={key:'',value:null};
      const html=psePanoramaHTML(),recs=pseRecords(),bia=recs.find(r=>r.nome==='BIA');return pseOnlyArt(bia)&&!pseOnlyArt(recs.find(r=>r.nome==='ANA'))&&html.includes('Só ação de ART')&&!/<span class="n"[^>]*>ART 1</.test(html)&&html.includes('2 só na ação de ART')&&pseEvalChip(bia).includes('Só ART')}finally{state.snapshots=keep.snaps;state.pse=keep.pse;pseCache={key:'',value:null}}});
  await add('275. Botões da gaveta do PSE com a chave da criança (que tem "|" entre nome e nascimento) separam no último "|": "Sim, é meu aluno", registrar contato, ligar prontuário e remover registro gravam na criança certa',()=>{const [k,v]=psSplitKey('nn:ANA SOUZA|2016-01-10|1');const src=pseClick.toString();return k==='nn:ANA SOUZA|2016-01-10'&&v==='1'&&!/d\.ps(Del|MineSet|Prod|Reg)\.split\('\|'\)/.test(src)&&src.includes('psSplitKey(d.psMineSet)')});
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
  const paracetamol=valid?doseGotas(peso,1.5,10,35,false):null,dipirona=valid?doseGotas(peso,1,25,35,true):null,ibuprofeno=valid?doseGotas(peso,1,2.5,40,false):null;
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
      ${calcDoseCard({titulo:'Amoxicilina',sub:'250 mg/5 mL · 8/8h',idLabel:'ANTIBIÓTICO',pill:{cls:'success',label:'1ª escolha'},accent:'#7551e9',need:'8/8h — 3x ao dia',teto:10,unidade:'mL',dose:amox})}
      ${calcDoseCard({titulo:'Eritromicina',sub:'250 mg/5 mL · 6/6h',idLabel:'ALÉRGICOS À PENICILINA',pill:{cls:'neutral',label:'Alternativa'},accent:'#7551e9',need:'6/6h — 4x ao dia',teto:10,unidade:'mL',dose:eritro})}
      ${calcDoseCard({titulo:'Cefalexina',sub:'250 mg/5 mL · 6/6h',idLabel:'ALÉRGICOS À PENICILINA',pill:{cls:'neutral',label:'Alternativa'},accent:'#7551e9',need:'6/6h — 4x ao dia',teto:10,unidade:'mL',dose:cefa})}
    </div>
    <div class="subhead">Analgésicos · dor relatada pela criança, regular nos 3 primeiros dias de pós-operatório <sup><a href="#calc-ref2">2</a></sup></div>
    <div class="indicator-grid">
      ${calcDoseCard({titulo:'Paracetamol',sub:'gotas 200 mg/mL · 6/6h',idLabel:'ANALGÉSICO',pill:null,accent:'#3dc1d3',need:'6/6h — 4x ao dia',teto:35,unidade:'gotas',dose:paracetamol})}
      ${calcDoseCard({titulo:'Dipirona',sub:'gotas 500 mg/mL · 6/6h',idLabel:'ANALGÉSICO',pill:null,accent:'#3dc1d3',need:'6/6h — 4x ao dia',teto:35,unidade:'gotas',dose:dipirona})}
      ${calcDoseCard({titulo:'Ibuprofeno',sub:'gotas 50 mg/mL · 6/6h',idLabel:'ANTI-INFLAMATÓRIO',pill:{cls:'warn',label:'AINE'},accent:'#e7a23b',need:'6/6h — 4x ao dia, se risco de inflamação extensa',teto:40,unidade:'gotas',dose:ibuprofeno})}
    </div>
    <div class="notice"><strong>Sobre o paracetamol:</strong> o guia de referência dá uma faixa de 1 a 1,5 gota/kg/dose — esta página usa o topo da faixa (1,5), coerente com o critério de "sempre o teto máximo" combinado com você. Avise se preferir a base (1 gota/kg).</div>
    <div class="notice"><strong>Sobre o ibuprofeno:</strong> a concentração foi conferida no REMUME municipal (50 mg/mL) e a fórmula foi ajustada para essa apresentação — a versão anterior desta calculadora assumia 100 mg/mL, o que subdosava pela metade.</div>
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


/* ---------- Página Procedimentos: gráficos, tabela e avaliação do paciente ---------- */
/* ---------- Página Procedimentos (v2.27): categorias clínicas, período, mês a mês, dentistas, pacientes e gavetas ---------- */
const PROC_CATS=[['Preventivos','#0f9d8a'],['Periodontia','#7551e9'],['Restauradores','#2f80ed'],['Endodontia','#d98a1c'],['Cirurgia','#d9486a'],['Outros','#8a8fab']];
const PROC_CAT_COLOR=Object.fromEntries(PROC_CATS);
const PROC_AGE_BANDS=['0-5','6-11','12-17','18-59','60+'];
function procCategory(name){const n=norm(name);
  if(/^(ORIENTACAO|PROFILAXIA|APLICACAO TOPICA|APLICACAO DE SELANTE|APLICACAO DE CARIOSTATICO|EVIDENCIACAO)/.test(n))return 'Preventivos';
  if(/^(RASPAGEM|GENGIVECTOMIA|TRATAMENTO DE GENGIVITE|TRATAMENTO DE PERICORONARITE)/.test(n))return 'Periodontia';
  if(/^(RESTAURACAO|TRATAMENTO RESTAURADOR|SELAMENTO PROVISORIO)/.test(n))return 'Restauradores';
  if(/^(ACESSO A POLPA|CURATIVO DE DEMORA|PULPOTOMIA|CAPEAMENTO|TRATAMENTO INICIAL DO DENTE)/.test(n))return 'Endodontia';
  if(/^(EXODONTIA|RETIRADA DE PONTOS|EXCISAO|CURETAGEM|ODONTOSEC|CORRECAO DE IRREG|DRENAGEM)/.test(n))return 'Cirurgia';
  return 'Outros';
}
function procPeriod(){const p=state.preferences,mode=['M','Q','Y'].includes(p.procPeriod)?p.procPeriod:'Q',year=Number(p.year),q=Number(p.quarter);
  const qm=quarterMonths(year,q),months=mode==='M'?[p.month]:mode==='Q'?qm:procMonthsOfYear(year),chart=mode==='Y'?procMonthsOfYear(year):qm;
  const a=parseMonthKey(qm[0]),b=parseMonthKey(qm.at(-1));
  return {mode,months,chart,label:mode==='M'?fmtMonth(p.month,true):mode==='Q'?`Q${q} · ${MONTHS[a.month-1]} a ${MONTHS[b.month-1]}/${b.year}`:String(year)};
}
function procFilters(){const p=state.preferences;return {dentist:p.procDentist||'',age:PROC_AGE_BANDS.includes(p.procAge)?p.procAge:'',sex:['Feminino','Masculino'].includes(p.procSex)?p.procSex:''}}
// Linhas de cruzamento (procedimento × dentista × sexo × idade) por mês, sem os registros que não são procedimento.
function procCrossByMonth(months,unit=state.preferences.unit){const out={};for(const mk of months){const agg=aggregateProcedureMonth(mk,unit);out[mk]=agg?{cross:agg.crossRows||[],agg}:null}return out}
function procInfoMap(byMonth){const info={};for(const v of Object.values(byMonth))if(v)for(const p of v.agg.procedureCounts||[])if(!p.nonDental)info[norm(p.descriptionNormalized)]??={name:p.descriptionNormalized,sigtap:p.sigtap,roles:p.roles||[],unrecognized:!!p.unrecognized};return info}
function procSumBy(rows,f){const m=new Map();for(const r of rows){const k=f(r);m.set(k,(m.get(k)||0)+r.quantity)}return m}
function procChipsHTML(roles){const b=procedureRoleBadges(roles).sort((x,y)=>(x.part==='Numerador'?0:1)-(y.part==='Numerador'?0:1));return b.map(x=>`<span class="pr-ic${x.part==='Numerador'?'':' den'}">${esc(x.ind)} ${x.part==='Numerador'?'num':'den'}</span>`).join('')}
function proceduresHTML(){
  const p=state.preferences,unit=p.unit,source=p.procSource==='group'?'group':'individual',per=procPeriod(),f=procFilters(),stats=p.procView==='stats';
  const tabs=`<nav class="sx-tabs" role="tablist" aria-label="Procedimentos"><button type="button" role="tab" data-proc-view="overview" aria-selected="${!stats}">Visão geral</button><button type="button" role="tab" data-proc-view="stats" aria-selected="${stats}">Análise estatística</button></nav>`;
  if(stats)return tabs+statsHTML();
  const seg=(key,val,label,cur)=>`<button class="pr-sb" data-${key}="${val}" aria-pressed="${cur===val}">${label}</button>`;
  const hasAny=state.snapshots.some(s=>s.profile===(source==='group'?'celk_atividades_grupo':'celk_procedimentos_detalhado'));
  const byMonth=source==='individual'?procCrossByMonth([...new Set([...per.chart,...per.months])],unit):null;
  const dentists=byMonth?[...new Set(Object.values(byMonth).flatMap(v=>v?v.cross.map(c=>c.professional):[]).filter(Boolean))].sort((a,b)=>a.localeCompare(b,'pt-BR')):[];
  const bar=`<section class="card pr-bar" aria-label="Filtros">
    <div class="pr-fg"><span>Fonte</span><div class="pr-seg">${seg('proc-source','individual','Individuais',source)}${seg('proc-source','group','Atividades coletivas',source)}</div></div>
    <div class="pr-fg"><span>Período</span><div class="pr-seg">${seg('proc-period','M','Mês',per.mode)}${seg('proc-period','Q','Quadrimestre',per.mode)}${seg('proc-period','Y','Ano',per.mode)}</div><b class="pr-per">${esc(per.label)}</b></div>
    ${source==='individual'?`<div class="pr-fg"><span>Dentista</span><select class="filter" data-proc-dentist-sel aria-label="Dentista"><option value="">Todos</option>${dentists.map(d=>`<option value="${esc(d)}"${f.dentist===d?' selected':''}>${esc(d)}</option>`).join('')}</select></div>
    <div class="pr-fg"><span>Idade</span><span class="pr-chips">${PROC_AGE_BANDS.map(a=>`<button class="pr-chip" data-proc-age="${a}" aria-pressed="${f.age===a}">${a.replace('-','–')}</button>`).join('')}</span></div>
    <div class="pr-fg"><span>Sexo</span><span class="pr-chips">${['Feminino','Masculino'].map(s=>`<button class="pr-chip" data-proc-sex="${s}" aria-pressed="${f.sex===s}">${s}</button>`).join('')}</span></div>
    ${f.dentist||f.age||f.sex?'<button class="link-btn pr-clear" data-proc-clear>Limpar filtros</button>':''}`:''}
  </section>`;
  if(!hasAny)return tabs+bar+emptyState('Nenhum relatório importado para esta fonte',source==='group'?'Importe um relatório "Relação das Atividades em Grupo" do CELK (PDF ou CSV) para ver as atividades aqui.':'Importe um relatório "Procedimentos Detalhado" do CELK (PDF ou CSV) para ver os procedimentos aqui.');
  return tabs+bar+(source==='group'?groupActivitiesHTML(per):procIndividualHTML(per,f,byMonth));
}
function procIndividualHTML(per,f,byMonth){
  const p=state.preferences,info=procInfoMap(byMonth),rowsOf=(months,{skipDent=false}={})=>months.flatMap(mk=>byMonth[mk]?byMonth[mk].cross:[]).filter(c=>(skipDent||!f.dentist||c.professional===f.dentist)&&(!f.age||c.age===f.age)&&(!f.sex||c.sex===f.sex));
  const rows=rowsOf(per.months),total=sum(rows.map(r=>r.quantity)),withData=per.months.filter(mk=>byMonth[mk]);
  const visits=withData.flatMap(mk=>byMonth[mk].agg.visitsList||[]),patients=new Set(visits.map(v=>v.patient)),filtered=!!(f.dentist||f.age||f.sex);
  const scope=[per.label,f.dentist,f.age?`${f.age.replace('-','–')} anos`:'',f.sex].filter(Boolean).join(' · ');
  if(!withData.length)return `<article class="card pr-box"><p class="pr-note">Nenhum relatório "Procedimentos Detalhado" para ${esc(per.label)}. Escolha outro período no topo ou importe o relatório.</p></article>`;
  const kpis=`<section class="pr-kpis" aria-label="Resumo">
    <div class="card pr-kpi"><span class="pq-sec-t">Procedimentos</span><b>${fmtNum(total)}</b><small>${per.mode==='M'?esc(per.label):`${fmtNum(total/Math.max(1,withData.length))} por mês com dado, em média`}</small></div>
    <div class="card pr-kpi"><span class="pq-sec-t">Pacientes atendidos</span><b>${fmtNum(patients.size)}</b><small>pessoas diferentes${filtered?' · sem os filtros':''}</small></div>
    <div class="card pr-kpi"><span class="pq-sec-t">Dias de atendimento</span><b>${fmtNum(visits.length)}</b><small>paciente × dia com registro${filtered?' · sem os filtros':''}</small></div>
    <div class="card pr-kpi"><span class="pq-sec-t">Por atendimento</span><b>${visits.length&&!filtered?fmtNum(total/visits.length,1):'—'}</b><small>${filtered?'não se aplica com filtros':'procedimentos em média'}</small></div>
  </section>`;
  const byCat=procSumBy(rows,r=>procCategory(r.procLabel)),byProc=procSumBy(rows,r=>r.procKey),maxP=Math.max(1,...byProc.values()),open=new Set(Array.isArray(p.procOpenCats)?p.procOpenCats:['Periodontia','Preventivos']);
  const cats=PROC_CATS.filter(([c])=>byCat.get(c)).sort((a,b)=>byCat.get(b[0])-byCat.get(a[0])).map(([c,color])=>{const procs=[...byProc.entries()].filter(([k])=>procCategory(info[k]?.name||rows.find(r=>r.procKey===k)?.procLabel||k)===c).sort((a,b)=>b[1]-a[1]),isOpen=open.has(c);
    return `<div class="pr-cat${isOpen?' open':''}"><button class="pr-cat-h" data-proc-cat="${c}" aria-expanded="${isOpen}"><span class="pr-dot" style="background:${color}"></span><b>${c} <small>· ${procs.length} procedimento${procs.length===1?'':'s'}</small></b><span class="pr-n">${fmtNum(byCat.get(c))}</span><span class="pr-pct">${fmtPct(100*byCat.get(c)/total,1)}</span><span class="pr-chev">›</span></button>${isOpen?`<div class="pr-rows">${procs.map(([k,q])=>{const i=info[k]||{name:rows.find(r=>r.procKey===k)?.procLabel||k,sigtap:'',roles:[]};return `<button class="pr-row" data-proc-open="${esc(k)}"><span class="pr-nm"><b>${esc(i.name)}</b><small>${i.sigtap?`<span class="mono">${esc(i.sigtap)}</span>`:'<span>sem código SIGTAP no relatório</span>'}${procChipsHTML(i.roles)}</small></span><span class="pr-track"><i style="width:${100*q/maxP}%;background:${color}"></i></span><span class="pr-q">${fmtNum(q)}</span><span class="pr-p">${fmtPct(100*q/total,1)}</span></button>`}).join('')}</div>`:''}</div>`}).join('');
  const mix=PROC_CATS.map(([c,color])=>byCat.get(c)?`<i style="width:${100*byCat.get(c)/total}%;background:${color}" title="${c}: ${fmtNum(byCat.get(c))}"></i>`:'').join('');
  const legend=PROC_CATS.filter(([c])=>byCat.get(c)).map(([c,color])=>`<span><i style="background:${color}"></i>${c} ${fmtPct(100*byCat.get(c)/total,1)}</span>`).join('');
  const mRows=per.chart.map(mk=>({mk,cat:procSumBy(rowsOf([mk]),r=>procCategory(r.procLabel))})),mTot=mRows.map(x=>sum([...x.cat.values()])),mMax=Math.max(1,...mTot);
  const months=`<div class="pr-months" style="grid-template-columns:repeat(${per.chart.length},minmax(0,1fr))">${mRows.map((x,i)=>{const sel=per.mode==='M'&&x.mk===p.month,dim=per.mode==='M'&&!sel;return `<button class="pr-mcol${sel?' sel':''}${dim?' dim':''}" data-proc-month="${x.mk}" aria-label="${esc(fmtMonth(x.mk,true))}: ${fmtNum(mTot[i])} procedimentos"><span class="pr-mtot">${mTot[i]?fmtNum(mTot[i]):'—'}</span><span class="pr-mstack"><span style="height:${100*mTot[i]/mMax}%">${PROC_CATS.map(([c,color])=>x.cat.get(c)?`<i style="height:${100*x.cat.get(c)/mTot[i]}%;background:${color}"></i>`:'').join('')}</span></span><span class="pr-mlab">${MONTHS_SHORT[parseMonthKey(x.mk).month-1]}</span></button>`}).join('')}</div>`;
  const dRows=rowsOf(per.months,{skipDent:true}),dCat=new Map();for(const r of dRows){const d=r.professional||'(sem profissional)',m=dCat.get(d)||new Map();m.set(procCategory(r.procLabel),(m.get(procCategory(r.procLabel))||0)+r.quantity);dCat.set(d,m)}
  const dList=[...dCat.entries()].map(([d,m])=>[d,m,sum([...m.values()])]).sort((a,b)=>b[2]-a[2]),dMax=Math.max(1,...dList.map(x=>x[2]));
  const dents=dList.map(([d,m,t])=>`<button class="pr-drow${f.dentist===d?' sel':''}${f.dentist&&f.dentist!==d?' dim':''}" data-proc-dentist="${esc(d)}"><b title="${esc(d)}">${esc(d)}</b><span class="pr-mix" style="height:10px;width:${Math.max(4,100*t/dMax)}%">${PROC_CATS.map(([c,color])=>m.get(c)?`<i style="width:${100*m.get(c)/t}%;background:${color}"></i>`:'').join('')}</span><span class="pr-q">${fmtNum(t)}</span></button>`).join('')||'<p class="pr-note">Sem dados.</p>';
  const pRows=per.chart.map(mk=>{const a=byMonth[mk]?.agg;return `<tr class="${per.mode==='M'&&mk===p.month?'sel':''}"><td>${esc(fmtMonth(mk,true))}</td><td class="num">${a?fmtNum(a.firstConsultations):'—'}</td><td class="num">${a?fmtNum((a.visitsList||[]).length):'—'}</td><td class="num">${a?fmtNum(a.treatmentsConcluded):'—'}</td></tr>`}).join('');
  const perPat=new Map();for(const v of visits)perPat.set(v.patient,(perPat.get(v.patient)||0)+1);const dist=[['1 vez',1,1],['2 a 3 vezes',2,3],['4 a 6 vezes',4,6],['7 ou mais',7,Infinity]].map(([l,a,b])=>[l,[...perPat.values()].filter(n=>n>=a&&n<=b).length]),distMax=Math.max(1,...dist.map(x=>x[1]));
  const ageRows=rowsOf(per.months).filter(r=>r.age),ages=procSumBy(ageRows,r=>r.age),ageMax=Math.max(1,...ages.values()),sx=procSumBy(rows.filter(r=>r.sex),r=>r.sex),sxT=(sx.get('Feminino')||0)+(sx.get('Masculino')||0);
  const hb=(l,v,max,color)=>`<div class="pr-hb"><span>${l}</span><span class="pr-track"><i style="width:${100*v/max}%;background:${color}"></i></span><span class="pr-q">${fmtNum(v)}</span></div>`;
  return `${kpis}
  <div class="pr-cols">
    <section class="card pr-box"><div class="pr-box-h"><h2>O que foi feito</h2><small>${esc(scope)}</small></div>
      ${total?`<div><div class="pr-mix">${mix}</div><div class="pr-legend">${legend}</div></div><div>${cats}</div>`:'<p class="pr-note">Nenhum procedimento com esses filtros.</p>'}
      <p class="pr-note">Primeira consulta, tratamento concluído e atendimentos gerais não são procedimentos: entram em "Pacientes", abaixo.</p></section>
    <div class="pr-side">
      <section class="card pr-box"><div class="pr-box-h"><h2>Mês a mês</h2><small>clique num mês para filtrar</small></div>${months}</section>
      <section class="card pr-box"><div class="pr-box-h"><h2>Por dentista</h2><small>clique para filtrar</small></div><div>${dents}</div></section>
    </div>
  </div>
  <section class="card pr-box"><div class="pr-box-h"><h2>Pacientes</h2><small>${esc(per.label)}${filtered?' · sem os filtros de dentista, idade e sexo':''}</small></div>
    <div class="pr-pgrid">
      <div><div class="pq-sec-t">Por mês</div><div class="table-scroll"><table class="pr-table"><thead><tr><th>Mês</th><th class="num">Primeiras consultas</th><th class="num">Dias de atendimento</th><th class="num">Tratamentos concluídos</th></tr></thead><tbody>${pRows}</tbody></table></div><p class="pr-note">Primeira consulta e tratamento concluído contam 1 vez por pessoa a cada 12 meses, como em M1 e M2.</p></div>
      <div><div class="pq-sec-t">Quantas vezes cada paciente veio</div>${dist.map(([l,v])=>hb(l,v,distMax,'var(--primary)')).join('')}${patients.size?`<p class="pr-note">${fmtPct(100*dist[0][1]/patients.size,1)} dos pacientes vieram uma vez só no período.</p>`:''}</div>
      <div><div class="pq-sec-t">Idade e sexo dos procedimentos</div>${PROC_AGE_BANDS.map(a=>hb(`${a.replace('-','–')} anos`,ages.get(a)||0,ageMax,'#2f80ed')).join('')}${sxT?`<div class="pr-sexbar"><i style="width:${100*(sx.get('Feminino')||0)/sxT}%;background:#d9486a"></i><i style="width:${100*(sx.get('Masculino')||0)/sxT}%;background:#2f80ed"></i></div><p class="pr-note">Feminino ${fmtPct(100*(sx.get('Feminino')||0)/sxT,1)} · Masculino ${fmtPct(100*(sx.get('Masculino')||0)/sxT,1)}</p>`:''}</div>
    </div></section>`;
}
function openProcedureDetail(key){
  const per=procPeriod(),f=procFilters(),byMonth=procCrossByMonth([...new Set([...per.chart,...per.months])]),info=procInfoMap(byMonth)[key]||{name:key,sigtap:'',roles:[]},c=procCategory(info.name),color=PROC_CAT_COLOR[c];
  const base=mks=>mks.flatMap(mk=>byMonth[mk]?byMonth[mk].cross:[]).filter(r=>r.procKey===key);
  const flt=(rows,{dent=true,age=true,sex=true}={})=>rows.filter(r=>(!dent||!f.dentist||r.professional===f.dentist)&&(!age||!f.age||r.age===f.age)&&(!sex||!f.sex||r.sex===f.sex));
  const inPer=flt(base(per.months)),tot=sum(inPer.map(r=>r.quantity));
  const bars=(pairs,col)=>{const mx=Math.max(1,...pairs.map(x=>x[1]));return pairs.map(([l,v])=>`<div class="pr-hb"><span>${esc(l)}</span><span class="pr-track"><i style="width:${100*v/mx}%;background:${col}"></i></span><span class="pr-q">${fmtNum(v)}</span></div>`).join('')};
  const mPairs=per.chart.map(mk=>[fmtMonth(mk,true),sum(flt(byMonth[mk]?byMonth[mk].cross.filter(r=>r.procKey===key):[]).map(r=>r.quantity))]);
  const dPairs=[...procSumBy(flt(base(per.months),{dent:false}),r=>r.professional||'(sem profissional)').entries()].sort((a,b)=>b[1]-a[1]);
  const aPairs=PROC_AGE_BANDS.map(a=>[`${a.replace('-','–')} anos`,sum(flt(base(per.months),{age:false}).filter(r=>r.age===a).map(r=>r.quantity))]);
  const sPairs=['Feminino','Masculino'].map(s=>[s,sum(flt(base(per.months),{sex:false}).filter(r=>r.sex===s).map(r=>r.quantity))]);
  const uses=procedureRoleBadges(info.roles).map(x=>`${x.ind} (${x.part.toLowerCase()})`).join(', ');
  openDrawer(`<div class="pq-drawer" style="--tint:#f6f7fb;--edge:${color};--ink:${color}" data-proc-detail-open="${esc(key)}">
    <header class="pq-d-h"><div class="pq-d-h-top"><span class="indicator-id" style="margin-right:auto;color:${color}">${esc(c.toUpperCase())}</span><button class="pq-icon" data-close-drawer aria-label="Fechar">${icon('close')}</button></div>
      <h2>${esc(info.name)}</h2><p class="pq-d-sub">${info.sigtap?`<span class="mono">${esc(info.sigtap)}</span>`:'sem código SIGTAP no relatório'} ${procChipsHTML(info.roles)}</p><p class="pq-d-sub"><b>${fmtNum(tot)}</b> em ${esc(per.label)}${f.dentist?` · ${esc(f.dentist)}`:''}</p><div style="height:12px"></div></header>
    <div class="pq-d-b">
      <section class="pq-d-card"><div class="pq-sec-t">Mês a mês</div>${bars(mPairs,color)}</section>
      <section class="pq-d-card"><div class="pq-sec-t">Por dentista · ${esc(per.label)}</div>${dPairs.length?bars(dPairs,color):'<p class="pr-note">Sem registros.</p>'}</section>
      <section class="pq-d-card"><div class="pq-sec-t">Idade</div>${bars(aPairs,'#2f80ed')}</section>
      <section class="pq-d-card"><div class="pq-sec-t">Sexo</div>${bars(sPairs,'#d9486a')}</section>
      <p class="ov-why">Onde entra nos indicadores: ${uses?esc(uses):'nenhum indicador'}.</p>
    </div></div>`);
  document.getElementById('drawer').classList.add('pq-drawer-host');
}
/* ---- Atividades coletivas ---- */
// Atividades do período: o CSV traz uma linha por participante (idade, sexo, avaliação alterada); o PDF só traz o total.
function groupActivitiesFor(months,unit=state.preferences.unit){
  const out=[];
  for(const mk of months)for(const s of latestSnapshots('celk_atividades_grupo',mk,unit)){const d=s.dataByMonth[mk];if(!d)continue;
    if(Array.isArray(d.activityDetails))d.activityDetails.forEach((a,i)=>out.push({...a,mk,ref:`${s.id}|${mk}|${i}`,detail:true}));
    else{(d.brushingEvents||[]).forEach(ev=>out.push({date:ev.date,subject:'Escovação supervisionada',brush:true,total:ev.present,eligible:ev.present,outOfRange:0,altered:null,mk,ref:'',detail:false}));
      for(const sc of d.subjectCounts||[])if(!/ESCOVACAO SUPERVISIONADA/.test(norm(sc.subject)))out.push({date:'',subject:sc.subject,brush:false,total:sc.present||null,eligible:0,activitiesCount:sc.activities,altered:null,mk,ref:'',detail:false})}}
  return out.sort((a,b)=>(parseDate(a.date)?.getTime()||0)-(parseDate(b.date)?.getTime()||0));
}
function groupActivitiesHTML(per){
  const acts=groupActivitiesFor(per.months),brush=acts.filter(a=>a.brush),other=acts.filter(a=>!a.brush),hasDetail=acts.some(a=>a.detail);
  if(!acts.length)return `<article class="card pr-box"><p class="pr-note">Nenhuma atividade em grupo em ${esc(per.label)}. Escolha outro período no topo ou importe o relatório.</p></article>`;
  const partTotal=sum(acts.map(a=>a.total||0)),elig=sum(brush.map(a=>a.eligible||0)),alt=sum(acts.map(a=>a.altered||0)),nAct=sum(acts.map(a=>a.activitiesCount||1));
  const kpis=`<section class="pr-kpis" aria-label="Resumo das atividades coletivas">
    <div class="card pr-kpi"><span class="pq-sec-t">Atividades</span><b>${fmtNum(nAct)}</b><small>${fmtNum(brush.length)} escovaç${brush.length===1?'ão':'ões'} · ${fmtNum(nAct-brush.length)} outra${nAct-brush.length===1?'':'s'}</small></div>
    <div class="card pr-kpi"><span class="pq-sec-t">Participantes</span><b>${hasDetail?fmtNum(partTotal):'—'}</b><small>${hasDetail?'somando todas as atividades':'o PDF não traz participantes'}</small></div>
    <div class="card pr-kpi"><span class="pq-sec-t">Escovação supervisionada</span><b>${fmtNum(elig)}</b><small>crianças de 6 a 11 anos · entram em M3 e B4</small></div>
    <div class="card pr-kpi"><span class="pq-sec-t">Avaliação alterada</span><b>${hasDetail?fmtNum(alt):'—'}</b><small>${hasDetail?'crianças para chamar para consulta':'só o CSV traz esse dado'}</small></div>
  </section>`;
  const name=a=>String(a.subject||'').replace(/^Escova[cç][aã]o Supervisionada\s*-\s*/i,'').replace(/^sa[úu]de bucal$/i,'Saúde bucal')||'(sem assunto)';
  const row=a=>{const sub=a.brush?(a.detail?`${fmtNum(a.eligible)} entram em M3/B4${a.outOfRange?` · <b class="pr-bad">${fmtNum(a.outOfRange)} fora da faixa</b>`:''}${a.noBirth?` · ${fmtNum(a.noBirth)} sem nascimento`:''} · ${fmtNum(a.altered||0)} com avaliação alterada`:`${fmtNum(a.eligible)} presentes (PDF)`):esc([a.publico,a.temas].filter(Boolean).join(' · ')||(a.activitiesCount?`${a.activitiesCount} atividade(s)`:''));
    return `<button class="pr-row pr-grow" ${a.ref?`data-group-act="${esc(a.ref)}"`:'disabled'}><span class="pr-nm"><b>${esc(name(a))}</b><small>${esc([a.date,a.turno,a.local].filter(Boolean).join(' · '))}</small></span><span class="pr-nm"><small>${sub}</small></span><span class="pr-q">${a.total!=null?fmtNum(a.total):'—'}</span></button>`};
  const grp=(title,color,list)=>list.length?`<div class="pr-cat open"><div class="pr-cat-h" style="cursor:default"><span class="pr-dot" style="background:${color}"></span><b>${title} <small>· ${list.length} atividade${list.length===1?'':'s'}</small></b><span class="pr-n">${hasDetail?fmtNum(sum(list.map(a=>a.total||0))):''}</span><span class="pr-pct">${hasDetail?'partic.':''}</span><span></span></div><div class="pr-rows">${list.map(row).join('')}</div></div>`:'';
  const ages={},sx={F:0,M:0};for(const a of acts){for(const [k,v] of Object.entries(a.ages||{}))ages[k]=(ages[k]||0)+v;sx.F+=a.sex?.F||0;sx.M+=a.sex?.M||0}
  const ageMax=Math.max(1,...Object.values(ages)),sxT=sx.F+sx.M;
  const mRows=per.chart.map(mk=>{const l=groupActivitiesFor([mk]);return [mk,sum(l.map(a=>a.activitiesCount||1)),sum(l.map(a=>a.total||0))]}),mMax=Math.max(1,...mRows.map(x=>x[1]));
  return `${kpis}
  <div class="pr-cols">
    <section class="card pr-box"><div class="pr-box-h"><h2>Atividades</h2><small>${esc(per.label)}${hasDetail?' · clique para ver os participantes':''}</small></div>
      ${grp('Escovação supervisionada','#0f9d8a',brush)}${grp('Educação em saúde e outras atividades','#2f80ed',other)}
      <p class="pr-note">"Participantes" conta todo mundo que estava na atividade. Só as crianças de 6 a 11 anos (até a véspera de completar 12) das escovações entram no numerador de M3 e B4.${acts.some(a=>!a.detail)?' Atividades importadas por PDF ou antes da v2.27 mostram só o total; importe o CSV de novo para ver idade, sexo e avaliação alterada.':''}</p></section>
    <div class="pr-side">
      <section class="card pr-box"><div class="pr-box-h"><h2>Quem participou</h2><small>${esc(per.label)}</small></div>${sxT?`${PROC_AGE_BANDS.map(a=>`<div class="pr-hb"><span>${a.replace('-','–')} anos</span><span class="pr-track"><i style="width:${100*(ages[a]||0)/ageMax}%;background:#2f80ed"></i></span><span class="pr-q">${fmtNum(ages[a]||0)}</span></div>`).join('')}<div class="pr-sexbar"><i style="width:${100*sx.F/sxT}%;background:#d9486a"></i><i style="width:${100*sx.M/sxT}%;background:#2f80ed"></i></div><p class="pr-note">Feminino ${fmtPct(100*sx.F/sxT,1)} · Masculino ${fmtPct(100*sx.M/sxT,1)}</p>`:'<p class="pr-note">Idade e sexo só vêm no CSV.</p>'}</section>
      <section class="card pr-box"><div class="pr-box-h"><h2>Mês a mês</h2><small>atividades</small></div><div class="pr-months" style="grid-template-columns:repeat(${per.chart.length},minmax(0,1fr))">${mRows.map(([mk,n,part])=>`<button class="pr-mcol${per.mode==='M'&&mk===state.preferences.month?' sel':''}" data-proc-month="${mk}" aria-label="${esc(fmtMonth(mk,true))}: ${n} atividades"><span class="pr-mtot">${n||'—'}</span><span class="pr-mstack"><span style="height:${100*n/mMax}%"><i style="height:100%;background:#0f9d8a"></i></span></span><span class="pr-mlab">${MONTHS_SHORT[parseMonthKey(mk).month-1]}</span></button>`).join('')}</div></section>
    </div>
  </div>`;
}
function openGroupActivity(ref){
  const [sid,mk,i]=ref.split('|'),s=state.snapshots.find(x=>x.id===sid),a=s?.dataByMonth?.[mk]?.activityDetails?.[Number(i)];if(!a)return;
  const ageMax=Math.max(1,...Object.values(a.ages||{})),names=a.alteredNames||[];
  openDrawer(`<div class="pq-drawer" style="--tint:#f6f7fb;--edge:${a.brush?'#0f9d8a':'#2f80ed'};--ink:${a.brush?'#0f9d8a':'#2f80ed'}">
    <header class="pq-d-h"><div class="pq-d-h-top"><span class="indicator-id" style="margin-right:auto">${a.brush?'ESCOVAÇÃO SUPERVISIONADA':'ATIVIDADE EM GRUPO'}</span><button class="pq-icon" data-close-drawer aria-label="Fechar">${icon('close')}</button></div>
      <h2>${esc(a.subject||'(sem assunto)')}</h2><p class="pq-d-sub">${esc([a.date,a.turno,a.local].filter(Boolean).join(' · '))}</p><p class="pq-d-sub">${esc([a.tipo,a.publico?`público: ${a.publico}`:''].filter(Boolean).join(' · '))}</p><div style="height:12px"></div></header>
    <div class="pq-d-b">
      <section class="pq-d-card"><div class="pq-sec-t">Participantes</div><div class="pr-hb"><span>Total</span><span></span><span class="pr-q">${fmtNum(a.total)}</span></div>${a.brush?`<div class="pr-hb"><span>Entram em M3/B4</span><span class="pr-track"><i style="width:${a.total?100*a.eligible/a.total:0}%;background:#0f9d8a"></i></span><span class="pr-q">${fmtNum(a.eligible)}</span></div>${a.outOfRange?`<p class="ov-why">${fmtNum(a.outOfRange)} participante(s) fora de 6 a 11 anos na data da atividade: não entram em M3/B4.</p>`:''}${a.noBirth?`<p class="ov-why">${fmtNum(a.noBirth)} sem data de nascimento no CSV.</p>`:''}`:''}</section>
      <section class="pq-d-card"><div class="pq-sec-t">Idade</div>${PROC_AGE_BANDS.filter(b=>a.ages?.[b]).map(b=>`<div class="pr-hb"><span>${b.replace('-','–')} anos</span><span class="pr-track"><i style="width:${100*a.ages[b]/ageMax}%;background:#2f80ed"></i></span><span class="pr-q">${fmtNum(a.ages[b])}</span></div>`).join('')||'<p class="ov-why">Sem data de nascimento.</p>'}<p class="ov-why">Feminino ${fmtNum(a.sex?.F||0)} · Masculino ${fmtNum(a.sex?.M||0)}</p></section>
      ${a.altered?`<section class="pq-d-card"><div class="pq-sec-t">Avaliação alterada · ${fmtNum(a.altered)} participante${a.altered===1?'':'s'}</div>${names.length?`<ul class="pr-names">${names.map(n=>`<li>${esc(n)}</li>`).join('')}</ul><p class="ov-why">Para chamar para consulta. Os nomes não vão no backup analítico.</p>`:'<p class="ov-why">Os nomes não estão guardados (backup analítico ou importação antiga).</p>'}</section>`:''}
    </div></div>`);
  document.getElementById('drawer').classList.add('pq-drawer-host');
}
function sourceLabelForProc(source){return source==='group'?'CELK · atividades em grupo':'CELK · procedimentos detalhados'}
function fullYearProcedureOptions(year,unit){return aggregateProcedureYear(year,unit).procedureCounts.map(p=>p.descriptionNormalized).sort((a,b)=>a.localeCompare(b,'pt-BR'))}
function procLabelFor(key,year,unit){const p=aggregateProcedureYear(year,unit).procedureCounts.find(x=>x.descriptionNormalized===key);return p?(p.descriptionOriginal||p.descriptionNormalized):key}

const VIEW_META={overview:['Acompanhamento Odontológico','Acompanhamento mensal e quadrimestral com leitura municipal, federal e painel operacional 2I.'],municipal:['Indicadores municipais · M1–M5','Apuração do quadrimestre pelas regras de Florianópolis. Prévia calculada do CELK, não homologada.'],federal:['Leitura federal · B1–B6','Faixas das Notas Metodológicas de maio de 2026, mês a mês e no quadrimestre. Prévia calculada do CELK, não homologada.'],pregnant:['Gestantes · 2I','Fila de contato do indicador 2I: quem ainda falta atender, em que etapa está cada gestante e o que fazer agora.'],procedures:['Procedimentos realizados','O que a equipe de saúde bucal fez, calculado direto dos relatórios Procedimentos Detalhado e Atividades em Grupo do CELK.'],settings:['Configurações','Salvamento e backup, arquivos importados, verificação dos dados e conferência por procedimento.'],pse:['PSE · Avaliações nas escolas','Avaliações de saúde bucal do PSE, cruzadas com a atividade coletiva e a produção do CELK, e o acompanhamento dos seus alunos.'],calculator:['Calculadora odontopediátrica','Doses de antibióticos e analgésicos por peso, para prescrição em quadros odontológicos infantis.']};
function migrateState(raw){const d=defaultState(),s=raw&&typeof raw==='object'?raw:{};const out={...d,...s,preferences:{...d.preferences,...(s.preferences||{})},gestantes:{...d.gestantes,...(s.gestantes||{}),followups:{...d.gestantes.followups,...(s.gestantes?.followups||{})},merges:{...d.gestantes.merges,...(s.gestantes?.merges||{})},excluded:{...d.gestantes.excluded,...(s.gestantes?.excluded||{})},overrides:{...d.gestantes.overrides,...(s.gestantes?.overrides||{})},manual:Array.isArray(s.gestantes?.manual)?s.gestantes.manual:[]},columnMappings:{...d.columnMappings,...(s.columnMappings||{}),consulta2i:{...d.columnMappings.consulta2i,...(s.columnMappings?.consulta2i||{})}}};out.snapshots=Array.isArray(s.snapshots)?s.snapshots:[];for(const sn of out.snapshots)if(CUMULATIVE_2I_PROFILES.includes(sn.profile)&&sn.supersededBy)sn.supersededBy=null;out.patientDirectory=s.patientDirectory&&typeof s.patientDirectory==='object'?s.patientDirectory:{};out.pse={mine:{...(s.pse?.mine||{})},dec:{...(s.pse?.dec||{})},overrides:{...(s.pse?.overrides||{})},followups:{...(s.pse?.followups||{})}};out.denominators=Array.isArray(s.denominators)?s.denominators:[];out.populationInputs=Array.isArray(s.populationInputs)?s.populationInputs:[];out.audit=Array.isArray(s.audit)?s.audit:[];out.schemaVersion=SCHEMA_VERSION;out.appVersion=APP_VERSION;delete out.security;
  if(out.preferences.view==='imports'||out.preferences.view==='diagnostics'){out.preferences.settingsTab=out.preferences.view;out.preferences.view='settings';out.audit.push({id:uuid(),at:nowISO(),action:'legacy_view_migrated_to_settings',details:{note:'Importações e Diagnóstico viraram subabas de Configurações na v2.0.'}})}
  if(!['geral','imports','diagnostics','conferencia'].includes(out.preferences.settingsTab))out.preferences.settingsTab='geral';
  if(s?.rulesets?.municipal?.meta===5||s?.preferences?.m1Meta===5){out.audit.push({id:uuid(),at:nowISO(),action:'legacy_m1_migrated',details:{from:'meta 5 / corte 3',to:'faixas vigentes'}})}
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
function switchView(view,{save=true}={}){if(!VIEW_META[view])view='overview';const changed=view!==activeView;activeView=view;if(staleViews.has(view))renderView(view);state.preferences.view=view;document.querySelectorAll('.view').forEach(el=>el.classList.toggle('hidden',el.id!==`view-${view}`));document.querySelectorAll('[data-view]').forEach(el=>el.classList.toggle('active',el.dataset.view===view));const [title,sub]=VIEW_META[view];document.getElementById('pageTitle').textContent=title;document.getElementById('pageSubtitle').textContent=sub;document.getElementById('eyebrow').textContent=view==='calculator'?title:`Indicadores / ${view==='overview'?'Saúde Bucal':title.split('·')[0].trim()}`;document.getElementById('appShell').classList.toggle('is-calculator-view',view==='calculator');document.getElementById('appShell').classList.toggle('is-pregnant-view',view==='pregnant');if(save)queueSave();if(changed)document.querySelector('.workspace').scrollTop=0}
function refreshSaveStatus(){
  const btn=document.getElementById('saveBtn'),badge=document.getElementById('saveBadge'),status=document.getElementById('backupStatus'),side=document.getElementById('sideSaveNote');
  const onBrowser=localSave.enabled&&!localSave.error,savedTxt=localSave.lastSavedAt?`Salvo neste navegador às ${new Date(localSave.lastSavedAt).toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'})}`:'Salvando neste navegador…';
  const warn=onBrowser?false:state.dirty||!!localSave.error;
  const backupTxt=state.lastBackupAt?`último backup ${fmtDateTime(state.lastBackupAt)}`:'nenhum backup exportado';
  if(btn){btn.classList.toggle('warn',warn);btn.title=localSave.error?`Não foi possível salvar neste navegador (${localSave.error}). Exporte um backup.`:onBrowser?`${savedTxt}. Clique para exportar um backup em arquivo.`:state.dirty?'Alterações não salvas — o salvamento no navegador está desligado. Clique para exportar um backup.':'O salvamento no navegador está desligado. Clique para exportar um backup a qualquer momento.'}
  if(badge)badge.classList.toggle('hidden',!warn);
  if(status){status.textContent=localSave.error?'Não foi possível salvar no navegador — exporte um backup':onBrowser?`${savedTxt} · ${backupTxt}`:state.dirty?'Alterações não salvas — exporte um backup':state.lastBackupAt?`Backup salvo ${fmtDateTime(state.lastBackupAt)}`:'Nada para salvar ainda';status.classList.toggle('save-warn',warn)}
  if(side)side.textContent=onBrowser?'Tudo fica salvo neste navegador. Para outro computador, exporte um backup.':'Salvamento no navegador desligado. Só o backup exportado guarda os dados.';
}
const VIEW_RENDERERS={overview:()=>overviewHTML(),municipal:()=>municipalHTML(),federal:()=>federalHTML(),pregnant:()=>pregnancyHTML(),procedures:()=>proceduresHTML(),pse:()=>pseHTML(),settings:()=>settingsHTML(),calculator:()=>calculatorHTML()};
let staleViews=new Set(Object.keys(VIEW_RENDERERS));
function renderView(v){const el=document.getElementById(`view-${v}`);if(!el||!VIEW_RENDERERS[v])return;el.innerHTML=VIEW_RENDERERS[v]();hydrateIcons(el);staleViews.delete(v)}
function renderAllViews(){for(const v of Object.keys(VIEW_RENDERERS))if(staleViews.has(v))renderView(v)}
function refreshAll(){
  fillContextFilters();
  // Desenha só a página aberta; as outras ficam marcadas e são desenhadas quando forem abertas (v2.22).
  // Antes as 7 páginas eram redesenhadas a cada edição, o que deixava lenta a lista de gestantes.
  staleViews=new Set(Object.keys(VIEW_RENDERERS));renderView(VIEW_RENDERERS[activeView]?activeView:'overview');
  const newest=[...state.snapshots].sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt))[0];document.getElementById('lastUpdate').textContent=newest?`Atualizado ${fmtDateTime(newest.createdAt)}`:'Nenhum relatório importado';document.getElementById('snapshotCount').textContent=`${state.snapshots.length} snapshot${state.snapshots.length===1?'':'s'}`;refreshSaveStatus();hydrateIcons();switchView(activeView,{save:false});
}
function updatePreference(key,value){state.preferences[key]=value;queueSave();refreshAll()}
function globalSearch(value){const n=norm(value);if(!n)return;if(/^M[1-5]$/.test(n)){switchView('municipal');openComposition('municipal',n,state.preferences.month);return}if(/^B[1-6]$/.test(n)){switchView('federal');openComposition('federal',n,state.preferences.month);return}if(n.includes('GEST')||n.includes('2I')||mergedEpisodes().some(e=>norm(e.equipe).includes(n))){state.preferences.pregSearch=value;switchView('pregnant');refreshAll();return}const snap=state.snapshots.find(s=>norm(s.fileName).includes(n));if(snap){state.preferences.settingsTab='imports';switchView('settings');refreshAll();openSnapshot(snap.id);return}toast('Nenhuma correspondência direta encontrada.')}

/* ---------- PSE: avaliações de saúde bucal nas escolas (v2.29) ---------- */
// Cada CSV exportado da ferramenta do PSE vira um snapshot "pse_avaliacao" (os arquivos se somam). A mesma criança é
// reconhecida entre campanhas pelo CPF ou por nome + nascimento. O cruzamento com o CELK só liga sozinho quando o dado é
// exatamente igual: atividade coletiva (CPF, ou nome + nascimento) e produção (nome igual + idade no atendimento igual à
// calculada pelo nascimento). Qualquer diferença fica "A definir". Só as crianças marcadas como "meu aluno" entram no
// acompanhamento. Nome, CPF e contato ficam só no navegador e no backup completo.
const PSE_PROFILE='pse_avaliacao';
const PSE_LESOES=['Zero','1 a 2 dentes','3 a 4 dentes','5 ou mais dentes'],PSE_EXO=['Não necessita','1 dente','2 ou mais dentes'],PSE_RISK=['Baixo','Médio','Alto'];
const PSE_STAGES=[['contatar','A contatar'],['contato','Em contato'],['agendada','Agendada'],['atendida','Atendida']];
// Criança que participou só da ação/avaliação de ART: parte bucal pendente ou vazia e Status ART preenchido (v2.35).
function pseOnlyArt(r){const pend=x=>{const n=norm(pseDash(x));return !n||n==='PENDENTE'};return pend(r.status)&&!pend(r.statusArt)}
function pseBothPending(bucal,art){const pend=x=>{const n=norm(pseDash(x));return !n||n==='PENDENTE'};return pend(bucal)&&pend(art)}
function pseDash(v){const s=String(v??'').trim();return s==='—'||s==='-'?'':s}
function pseTeeth(v){return pseDash(v).split(',').map(x=>x.trim()).filter(Boolean)}
async function parsePseCSV(file,hash,text){
  const rows=parseCSVText(text),headers=rows.shift()||[],map=headersMap(headers),required=['Nome','Escola','Nascimento','Status Bucal','Risco'];const missing=required.filter(h=>map[norm(h)]==null);if(missing.length)throw new Error(`CSV de avaliação do PSE sem cabeçalhos obrigatórios: ${missing.join(', ')}`);
  const data=rows.filter(r=>r.some(v=>String(v).trim())),yes=v=>norm(pseDash(v))==='SIM',kids=[];
  let pendentes=0;
  // Regra do usuário: só não entra quem está "Pendente" (ou vazio) no Status Bucal E no Status ART; preenchida em uma das duas, entra.
  data.forEach((r,i)=>{const v=h=>pseDash(valueBy(r,map,h));const nome=v('Nome').trim(),nasc=isoDate(v('Nascimento'));if(!nome){return}if(pseBothPending(v('Status Bucal'),v('Status ART'))){pendentes++;return}
    const ed=v('Editado por (Bucal)'),edArt=v('Editado por (ART)'),when=s=>{const m=String(s).match(/em (\d{2}\/\d{2}\/\d{4})/);return m?isoDate(m[1]):''};
    kids.push({line:i+2,nome:nome.toUpperCase(),escola:v('Escola'),ano:v('Ano'),turma:v('Turma'),nasc,cpf:v('CPF').replace(/\D/g,''),status:v('Status Bucal')||'Pendente',lesoes:v('Lesões cariosas cavitadas'),exo:v('Necessidade de exodontia'),risco:v('Risco'),conduta:v('Conduta'),pcd:yes(v('PcD')),perio:yes(v('Problemas periodontais')),dor:yes(v('Presença de dor')),art:yes(v('Indicação ART (Bucal)')),escov:yes(v('Escovação supervisionada realizada')),consult:yes(v('Atendimento em consultório')),encUbs:yes(v('Encaminhado à UBS (Bucal)')),fluor:yes(v('Aplicação Tópica de Flúor realizada')),obs:v('Observações (Bucal)'),editadoPor:ed.replace(/^Editado por\s*/i,''),dataAval:when(ed)||when(edArt),statusArt:v('Status ART'),denticao:v('Tipo de dentição'),aFazer:pseTeeth(v('Dentes a fazer (ART)')),feitos:pseTeeth(v('Dentes feitos (ART)')),tcle:yes(v('TCLE assinado (ART)')),encArt:yes(v('Encaminhamento à UBS (ART)')),semNec:yes(v('Sem necessidade (ART)')),obsArt:v('Observações (ART)')})});
  if(!kids.length)throw new Error(pendentes?`O CSV do PSE só tem crianças pendentes no Status Bucal e no Status ART (${pendentes}), que não são importadas.`:'O CSV foi reconhecido como avaliação do PSE, mas nenhuma criança pôde ser lida.');
  const dates=kids.map(k=>k.dataAval).filter(Boolean).sort(),fallback=isoDate(new Date());for(const k of kids)if(!k.dataAval)k.dataAval=dates.at(-1)||fallback;
  const escolas=[...new Set(kids.map(k=>k.escola).filter(Boolean))];
  const snap=makeSnapshotBase(file,hash,PSE_PROFILE,{unit:'',periodStart:dates[0]||'',periodEnd:dates.at(-1)||''});snap.status='avaliação do PSE';snap.pse={escolas,kids};
  const st=s=>kids.filter(k=>k.status===s).length;
  snap.validations.push({level:'info',code:'PSE_RESUMO',message:`${kids.length} criança(s) de ${escolas.join(', ')||'escola não informada'}: ${st('Preenchida')} avaliada(s), ${st('Ausente')} ausente(s), ${st('Recusou')} recusa(s).${st('Pendente')?` ${st('Pendente')} com saúde bucal pendente e ART preenchida.`:''}${pendentes?` ${pendentes} pendente(s) no Status Bucal e no Status ART não foi(ram) importada(s).`:''}`});
  if(!escolas.length)snap.validations.push({level:'warning',code:'PSE_SEM_ESCOLA',message:'O arquivo não tem a coluna Escola preenchida.'});
  snap.validations.push({level:'warning',code:'PSE_NOMINAL',message:'Arquivo com nome e nascimento das crianças. Fica só neste navegador e no backup completo; o backup analítico sai sem ele.'});
  sessionRaw.set(snap.id,{type:'csv',headers,rows:data.slice(0,300)});return snap;
}
// ---- crianças (uma por pessoa, com todas as avaliações) ----
const pseNN=(nome,nasc)=>`nn:${norm(nome)}|${nasc||''}`;
let pseCache={key:'',value:null};
function pseSnaps(){return state.snapshots.filter(s=>s.profile===PSE_PROFILE).sort((a,b)=>new Date(a.createdAt)-new Date(b.createdAt))}
function pseChildren(){
  const snaps=pseSnaps(),key=snaps.map(s=>s.id).join('|');if(pseCache.key===key)return pseCache.value;
  const byKey=new Map(),cpfKey={};
  const recs=snaps.flatMap(s=>(s.pse?.kids||[]).filter(k=>!pseBothPending(k.status,k.statusArt)).map(k=>({...k,snapId:s.id}))).sort((a,b)=>String(a.dataAval).localeCompare(String(b.dataAval)));
  for(const r of recs){const k=(r.cpf&&cpfKey[r.cpf])||pseNN(r.nome,r.nasc);if(r.cpf)cpfKey[r.cpf]??=k;r.key=k;const c=byKey.get(k)||{key:k,evals:[]};c.evals.push(r);byKey.set(k,c)}
  for(const c of byKey.values()){const per=new Map();for(const e of c.evals)per.set(e.snapId,e);c.evals=[...per.values()].sort((a,b)=>String(a.dataAval).localeCompare(String(b.dataAval)));c.last=c.evals.at(-1)}
  pseCache={key,value:[...byKey.values()]};return pseCache.value;
}
const psePrefs=()=>state.preferences;
function pseStore(){return state.pse||(state.pse={mine:{},dec:{},overrides:{},followups:{}})}
// Registros da campanha escolhida (todas: a avaliação mais recente de cada criança).
function pseRecords({ignoreTurma=false}={}){const p=psePrefs(),camp=p.pseCamp||'all';let recs=pseChildren().map(c=>camp==='all'?c.last:c.evals.find(e=>e.snapId===camp)).filter(Boolean);if(p.pseEscola)recs=recs.filter(r=>r.escola===p.pseEscola);if(!ignoreTurma&&p.pseTurma)recs=recs.filter(r=>r.turma===p.pseTurma);return recs}
// ---- CELK: atividade coletiva (CPF, CNS, sexo) e produção (prontuário, idade no atendimento) ----
let pseColCache={key:'',value:[]};
function pseColParticipants(){const snaps=state.snapshots.filter(s=>s.profile==='celk_atividades_grupo'&&!s.supersededBy&&s.participants),key=snaps.map(s=>s.id).join('|');if(pseColCache.key===key)return pseColCache.value;
  const seen=new Map();for(const s of snaps)for(const p of s.participants){const k=p.cpf||pseNN(p.nome,p.nasc);const prev=seen.get(k);if(!prev)seen.set(k,{...p,dates:[{date:p.date,subject:p.subject,alt:p.alt}]});else{prev.dates.push({date:p.date,subject:p.subject,alt:p.alt});prev.cns=prev.cns||p.cns;prev.sexo=prev.sexo||p.sexo}}
  for(const p of seen.values())p.dates.sort((a,b)=>String(a.date).localeCompare(String(b.date)));pseColCache={key,value:[...seen.values()]};return pseColCache.value}
let pseProdCache={key:'',value:null};
function pseProdByName(){const dir=state.patientDirectory||{},key=`${Object.keys(dir).length}|${state.snapshots.length}`;if(pseProdCache.key===key)return pseProdCache.value;const m=new Map();for(const [code,v] of Object.entries(dir)){const n=norm(v?.nome);if(!n)continue;(m.get(n)||m.set(n,[]).get(n)).push(code)}pseProdCache={key,value:m};return m}
function pseProdPatient(code){const visits=productionVisitsIndex().get(pid(code))||[];return {code:pid(code),nome:patientNameFor(code),visits}}
const pseTokensSimilar=(a,b)=>{a=norm(a).split(' ');b=norm(b).split(' ');return a.filter(x=>b.includes(x)).length/Math.max(a.length,b.length)>=0.6};
function pseTriangulate(r){
  const ov=pseStore().overrides[r.key]||{},nome=ov.nome||r.nome,nasc=ov.nasc||r.nasc,cpf=(ov.cpf||r.cpf||'').replace(/\D/g,''),out={col:null,colState:'none',colWhy:'',prod:[],prodState:'none',prodWhy:''},col=pseColParticipants();
  let c=cpf&&col.find(p=>p.cpf===cpf);if(c)Object.assign(out,{col:c,colState:'ok',colWhy:'CPF igual'});
  else{c=col.find(p=>norm(p.nome)===norm(nome)&&p.nasc===nasc);if(c)Object.assign(out,{col:c,colState:'ok',colWhy:'nome e nascimento iguais'});
    else{c=col.find(p=>norm(p.nome)===norm(nome)&&p.nasc!==nasc)||col.find(p=>p.nasc===nasc&&pseTokensSimilar(p.nome,nome));if(c)Object.assign(out,{col:c,colState:'def',colWhy:norm(c.nome)===norm(nome)?'nascimento diferente':'nome diferente'})}}
  if(ov.pront){const p=pseProdPatient(ov.pront);return {...out,prod:[p],prodState:'ok',prodWhy:'prontuário informado por você'}}
  const codes=pseProdByName().get(norm(nome))||[];
  if(codes.length>1)Object.assign(out,{prod:codes.map(pseProdPatient),prodState:'def',prodWhy:`${codes.length} prontuários com o mesmo nome`});
  else if(codes.length===1){const p=pseProdPatient(codes[0]),v=p.visits.find(x=>x.age!=null);out.prod=[p];if(!v||!nasc)Object.assign(out,{prodState:'def',prodWhy:'sem idade no relatório para conferir'});else{const exp=ageAt({dataNascimento:nasc},parseDate(v.date));if(exp===v.age)Object.assign(out,{prodState:'ok',prodWhy:'nome igual e idade confere'});else Object.assign(out,{prodState:'def',prodWhy:`idade no atendimento ${v.age} anos, pelo nascimento seria ${exp}`})}}
  return out}
const pseColKey=p=>p?(p.cpf||pseNN(p.nome,p.nasc)):'';
function pseLinks(r){const t=pseTriangulate(r),d=pseStore().dec[r.key]||{};
  const col=d.col==='no'?null:d.col?pseColParticipants().find(p=>pseColKey(p)===d.col)||null:t.colState==='ok'?t.col:null;
  const prod=d.prod==='no'?null:d.prod?pseProdPatient(d.prod):t.prodState==='ok'?t.prod[0]:null;
  const pendCol=t.colState==='def'&&!d.col,pendProd=t.prodState==='def'&&!d.prod;
  return {t,col,prod,pendCol,pendProd,state:pendCol||pendProd?'def':col||prod?'ok':'none'}}
function pseCad(r){const L=pseLinks(r),ov=pseStore().overrides[r.key]||{};return {nome:r.nome,nasc:r.nasc,sexo:L.col?.sexo||'',cpf:r.cpf||L.col?.cpf||'',cns:L.col?.cns||'',pront:L.prod?.code||'',equipe:'',resp:'',tel:'',end:'',nota:'',...Object.fromEntries(Object.entries(ov).filter(([,v])=>v!==''&&v!=null))}}
const pseIsMine=r=>pseStore().mine[r.key]===true;
// ---- acompanhamento ----
const pseNeeds=r=>pseOnlyArt(r)?!!r.encArt:r.status==='Preenchida'&&(r.risco==='Alto'||r.risco==='Médio'||r.encUbs||r.dor);
// Regra do usuário (v2.32), só para o PSE: um dia na produção que tem apenas orientação de higiene bucal + aplicação tópica de
// flúor (com ou sem "atendimento odontológico" ou "atendimento de urgência" como registro do dia) é o lançamento posterior do
// flúor aplicado na escola, não um atendimento na UBS.
const PSE_FLUOR_ONLY=/^(APLICACAO TOPICA DE FLUOR|ORIENTACAO (DE|EM) HIGIENE BUCAL)/;
function pseVisitProcs(v){return v.items?v.items.filter(x=>{const f=String(x[3]||'');return !(f.includes('n')&&!f.includes('f')&&!f.includes('c'))}).map(x=>x[0]):(v.procs||[]).filter(n=>!/^(ATENDIMENTO|CONSULTA DE PROF)/.test(norm(n)))}
function pseIsSchoolFluor(v){const ns=pseVisitProcs(v).map(norm);return ns.some(n=>/^APLICACAO TOPICA DE FLUOR/.test(n))&&ns.every(n=>PSE_FLUOR_ONLY.test(n))}
function pseVisitsAfter(r){const L=pseLinks(r);return (L.prod?.visits||[]).filter(v=>v.date>=r.dataAval&&!pseIsSchoolFluor(v))}
function pseStage(r){const f=pseStore().followups[r.key],hist=(f?.history||[]).filter(h=>h.at>=r.dataAval&&h.to);if(pseVisitsAfter(r).length)return 'atendida';const last=hist.at(-1);if(last)return last.to;return pseNeeds(r)?'contatar':null}
function pseRegister(key,type,text,to,extra={}){const s=pseStore(),f=s.followups[key]||(s.followups[key]={history:[]});f.history.push({at:nowISO(),type,text,to,...extra});audit('pse_followup',{type});queueSave()}
// ---- página ----
const pseRiskCls=r=>r==='Alto'?'red':r==='Médio'?'amber':r==='Baixo'?'green':'gray';
const pseEvalChip=r=>pseOnlyArt(r)?'<span class="ps-chip blue">Só ART</span>':r.status==='Preenchida'&&r.risco?`<span class="ps-chip ${pseRiskCls(r.risco)}">Risco ${esc(r.risco.toLowerCase())}</span>`:`<span class="ps-chip gray">${esc(r.status)}</span>`;
const pseStageChip=s=>s?`<span class="ps-chip ${s==='atendida'?'green':s==='agendada'?'blue':s==='contato'?'violet':'amber'}">${PSE_STAGES.find(x=>x[0]===s)[1]}</span>`:'';
const pseTriChip=s=>s==='def'?'<span class="ps-chip amber">A definir</span>':s==='ok'?'<span class="ps-chip blue">Confirmado</span>':'<span class="ps-chip gray">Sem registro no CELK</span>';
function pseSrcs(L){return `<span class="ps-srcs" title="PSE · atividade coletiva · produção"><i class="on">PSE</i><i class="${L.col?'on':L.pendCol?'warn':''}">Col</i><i class="${L.prod?'on':L.pendProd?'warn':''}">Prod</i></span>`}
const pseTitle=s=>String(s||'').toLowerCase().replace(/(^|\s)(\S)/g,(m,a,b)=>a+b.toUpperCase()).replace(/\b(Da|De|Do|Dos|Das|E)\b/g,w=>w.toLowerCase());
const psePc=(a,b)=>b?`${Math.round(100*a/b)}%`:'—';
let pseNav=[];
function pseHTML(){
  const p=psePrefs(),snaps=pseSnaps(),tab=['panorama','mine','acomp','def'].includes(p.pseTab)?p.pseTab:'panorama';
  if(!snaps.length)return emptyState('Nenhuma avaliação do PSE importada','Importe o CSV exportado da ferramenta de avaliação do PSE (colunas Nome, Escola, Turma, Nascimento, Status Bucal, Risco…). Os arquivos se somam: cada importação vira uma campanha.');
  const all=pseChildren(),defN=all.filter(c=>pseLinks(c.last).state==='def').length,mineN=all.filter(c=>pseIsMine(c.last)).length;
  const escolas=[...new Set(all.flatMap(c=>c.evals.map(e=>e.escola)).filter(Boolean))].sort((a,b)=>a.localeCompare(b,'pt-BR')),turmas=[...new Set(pseRecords({ignoreTurma:true}).map(r=>r.turma).filter(Boolean))].sort((a,b)=>a.localeCompare(b,'pt-BR',{numeric:true}));
  const campOpts=[['all','Todas as importações'],...[...snaps].reverse().map(s=>[s.id,`${(s.pse?.escolas||[]).join(', ')||'Escola não informada'} · ${fmtDate(s.periodStart)}${s.periodEnd&&s.periodEnd!==s.periodStart?` a ${fmtDate(s.periodEnd)}`:''}`])];
  const bar=`<section class="card pr-bar" aria-label="Filtros do PSE"><div class="pr-fg"><span>Período</span><select class="filter" data-ps-pref="pseCamp" aria-label="Campanha">${campOpts.map(([v,l])=>`<option value="${esc(v)}"${(p.pseCamp||'all')===v?' selected':''}>${esc(l)}</option>`).join('')}</select></div>
    <div class="pr-fg"><span>Escola</span><select class="filter" data-ps-pref="pseEscola" aria-label="Escola"><option value="">Todas</option>${escolas.map(e=>`<option${p.pseEscola===e?' selected':''}>${esc(e)}</option>`).join('')}</select></div>
    <div class="pr-fg"><span>Turma</span><select class="filter" data-ps-pref="pseTurma" aria-label="Turma"><option value="">Todas</option>${turmas.map(t=>`<option${p.pseTurma===t?' selected':''}>${esc(t)}</option>`).join('')}</select></div></section>`;
  const tabs=`<nav class="sx-tabs" role="tablist" aria-label="PSE">${[['panorama','Panorama',''],['mine','Meus alunos',mineN?`<span class="ps-count v">${mineN}</span>`:''],['acomp','Acompanhamento',''],['def','Vínculos a definir',defN?`<span class="ps-count">${defN}</span>`:'']].map(([k,l,c])=>`<button type="button" role="tab" data-ps-tab="${k}" aria-selected="${tab===k}">${l}${c}</button>`).join('')}</nav>`;
  pseNav=[];
  return tabs+bar+(tab==='mine'?pseMineHTML():tab==='acomp'?pseAcompHTML():tab==='def'?pseDefHTML():psePanoramaHTML());
}
function pseDist(ev,key,levels,colors){return `<div class="ps-dist">${levels.map((l,i)=>{const n=ev.filter(r=>r[key]===l).length;return `<div class="ps-drow"><span>${esc(l)}</span><div class="ps-dbar"><span style="width:${ev.length?100*n/ev.length:0}%;background:${colors[i]}"></span></div><span class="ps-t">${n} · ${psePc(n,ev.length)}</span></div>`}).join('')}</div>`}
function psePanoramaHTML(){
  const ALL=pseRecords(),AO=ALL.filter(pseOnlyArt),A=ALL.filter(r=>!pseOnlyArt(r)),ev=A.filter(r=>r.status==='Preenchida'),hi=ev.filter(r=>r.risco==='Alto'),dor=ev.filter(r=>r.dor),cav=ev.filter(r=>r.lesoes&&r.lesoes!=='Zero'),exo=ev.filter(r=>r.exo&&r.exo!=='Não necessita'),todo=sum(ALL.map(r=>r.aFazer.length)),done=sum(ALL.map(r=>r.feitos.length));
  if(!ALL.length)return '<article class="card ps-box"><p class="ps-hint">Nenhuma criança neste filtro.</p></article>';
  const dates=ALL.map(r=>r.dataAval).filter(Boolean).sort(),turmas=[...new Set(A.map(r=>r.turma))].sort((a,b)=>a.localeCompare(b,'pt-BR',{numeric:true}));
  const bars=turmas.map(t=>{const s=A.filter(r=>r.turma===t),e=s.filter(r=>r.status==='Preenchida'),c=x=>e.filter(r=>r.risco===x).length,na=s.length-e.length,w=x=>100*x/s.length;return `<div class="ps-trow"><span class="n" title="${esc(t)}">${esc(t||'Sem turma')}</span><div class="ps-stack" role="img" aria-label="${esc(t)}: ${c('Baixo')} baixo, ${c('Médio')} médio, ${c('Alto')} alto, ${na} sem avaliação"><span style="width:${w(c('Baixo'))}%;background:var(--green)"></span><span style="width:${w(c('Médio'))}%;background:var(--amber)"></span><span style="width:${w(c('Alto'))}%;background:var(--red)"></span><span style="width:${w(na)}%;background:var(--inner)"></span></div><span class="ps-t">${e.length} de ${s.length}</span></div>`}).join('');
  const tri=s=>ALL.filter(r=>pseLinks(r).state===s).length,mine=ALL.filter(pseIsMine).length,sug=ALL.filter(r=>!pseIsMine(r)&&pseLinks(r).state==='ok').length;
  const kpi=(l,v,s,cls='')=>`<div class="card ps-kpi ${cls}"><span>${l}</span><b>${v}</b><small>${s}</small></div>`;
  return `<p class="ps-scope"><span class="ps-chip gray">Todas as avaliações</span>${fmtNum(ALL.length)} criança(s) ${dates.length?`de ${fmtDate(dates[0])} a ${fmtDate(dates.at(-1))}`:''}, de qualquer CS: ${fmtNum(A.length)} na avaliação de saúde bucal${AO.length?` e ${fmtNum(AO.length)} só na ação de ART (contadas à parte)`:''}.</p>
  <div class="ps-kpis">${kpi('Avaliadas',fmtNum(ev.length),`de ${A.length} · ${A.filter(r=>r.status==='Ausente').length} ausentes, ${A.filter(r=>r.status==='Recusou').length} recusaram`)}${kpi('Risco alto',fmtNum(hi.length),`${psePc(hi.length,ev.length)} das avaliadas · ${dor.length} com dor`,'hi')}${kpi('Lesão cariosa cavitada',fmtNum(cav.length),`${psePc(cav.length,ev.length)} das avaliadas`)}${kpi('Precisam de exodontia',fmtNum(exo.length),`${psePc(exo.length,ev.length)} das avaliadas`)}${kpi('Dentes para ART',fmtNum(todo),`${fmtNum(done)} já feitos${AO.length?' · inclui só ART':''}`)}</div>
  <div class="ps-grid2"><article class="card ps-box"><div class="ps-h"><h2>Risco por turma</h2><small>avaliação de saúde bucal</small></div>${bars||'<p class="ps-hint">Nenhuma criança na avaliação de saúde bucal neste filtro.</p>'}<div class="ps-legend"><span><i style="background:var(--green)"></i>Baixo</span><span><i style="background:var(--amber)"></i>Médio</span><span><i style="background:var(--red)"></i>Alto</span><span><i style="background:var(--inner)"></i>Sem avaliação</span></div></article>
    <article class="card ps-box"><div class="ps-h"><h2>Lesões cariosas cavitadas</h2><small>${ev.length} avaliadas</small></div>${pseDist(ev,'lesoes',PSE_LESOES,['var(--green)','var(--amber)','var(--red)','var(--red)'])}<div class="ps-h"><h2>Necessidade de exodontia</h2></div>${pseDist(ev,'exo',PSE_EXO,['var(--green)','var(--amber)','var(--red)'])}</article></div>
  ${AO.length?psePanoramaArtHTML(AO):''}
  <div class="ps-grid2"><article class="card ps-box"><div class="ps-h"><h2>Cruzamento com o CELK</h2><small>atividade coletiva e produção</small></div><div class="ps-funnel">${[['ok','Confirmado','dado exatamente igual','var(--cyan)'],['def','A definir','parecido, divergente ou nome repetido','var(--amber)'],['none','Sem registro no CELK','','var(--placeholder)']].map(([s,l,h,c])=>`<div class="ps-fstep"><span>${l}${h?` <small>(${h})</small>`:''}</span><b>${tri(s)}</b><div class="ps-track"><span style="width:${100*tri(s)/A.length}%;background:${c}"></span></div></div>`).join('')}</div>${tri('def')?`<div><button class="btn small" type="button" data-ps-tab="def">Resolver ${tri('def')} a definir</button></div>`:''}</article>
    <article class="card ps-box"><div class="ps-h"><h2>Meus alunos</h2><small>só eles vão para o acompanhamento</small></div><p class="ps-hint"><b class="ps-big">${mine}</b> de ${A.length} marcados como da sua área adscrita.${sug?` ${sug} com vínculo confirmado no CELK ainda não marcados.`:''}</p><div><button class="btn small primary" type="button" data-ps-tab="mine">Escolher meus alunos</button></div></article></div>`;
}
// Card "Só ação de ART": crianças sem avaliação bucal (só as colunas de ART preenchidas), separadas dos gráficos de risco.
function psePanoramaArtHTML(AO){const turmas=[...new Set(AO.map(r=>r.turma))].sort((a,b)=>String(a).localeCompare(String(b),'pt-BR',{numeric:true})),st=x=>AO.filter(r=>norm(r.statusArt)===norm(x)).length,todo=sum(AO.map(r=>r.aFazer.length)),done=sum(AO.map(r=>r.feitos.length)),withTodo=AO.filter(r=>r.aFazer.length).length;
  return `<article class="card ps-box ps-artbox"><div class="ps-h"><h2>Só ação de ART</h2><small>${AO.length} criança(s) sem avaliação de saúde bucal · fora dos gráficos de risco</small></div>
    <div class="pq-d-facts"><div><span>Preenchidas</span><b>${st('Preenchida')}</b></div><div><span>Ausentes / recusas</span><b>${st('Ausente')+st('Recusou')}</b></div><div><span>Com dentes a fazer</span><b>${withTodo}</b></div><div><span>Dentes a fazer · feitos</span><b>${todo} · ${done}</b></div></div>
    <div class="pq-d-facts"><div><span>TCLE assinado</span><b>${AO.filter(r=>r.tcle).length}</b></div><div><span>Encaminhadas à UBS</span><b>${AO.filter(r=>r.encArt).length}</b></div><div><span>Sem necessidade</span><b>${AO.filter(r=>r.semNec).length}</b></div><div><span>Turmas</span><b>${turmas.length}</b></div></div>
    <div class="table-scroll"><table class="ps-table"><thead><tr><th>Turma</th><th>Crianças</th><th>Com dentes a fazer</th><th>Dentes a fazer</th><th>Dentes feitos</th><th>TCLE</th></tr></thead><tbody>${turmas.map(t=>{const g=AO.filter(r=>r.turma===t);return `<tr><td><b>${esc(t||'Sem turma')}</b></td><td>${g.length}</td><td>${g.filter(r=>r.aFazer.length).length}</td><td>${sum(g.map(r=>r.aFazer.length))}</td><td>${sum(g.map(r=>r.feitos.length))}</td><td>${g.filter(r=>r.tcle).length}</td></tr>`}).join('')}</tbody></table></div></article>`}
function pseMineHTML(){const p=psePrefs(),q=norm(p.pseSearch||''),A=pseRecords().filter(r=>!q||norm(r.nome).includes(q)).sort((a,b)=>String(a.turma).localeCompare(String(b.turma),'pt-BR',{numeric:true})||a.nome.localeCompare(b.nome,'pt-BR')),sug=A.filter(r=>!pseIsMine(r)&&pseLinks(r).state==='ok').length;pseNav=A.map(r=>r.key);
  return `<article class="card ps-box"><div class="ps-sel-h"><div><h2>Quem é da sua área adscrita?</h2><p class="ps-hint">Marque as crianças que você vai acompanhar. As outras continuam no Panorama e na análise, fora da fila.</p></div><div class="ps-acts"><input class="ps-search" id="pseSearch" type="search" placeholder="Buscar pelo nome" value="${esc(p.pseSearch||'')}" aria-label="Buscar pelo nome">${sug?`<button class="btn small" type="button" data-ps-mine-sug>Marcar os ${sug} confirmados no CELK</button>`:''}</div></div>
  <div class="table-scroll"><table class="ps-table"><thead><tr><th class="cb"><span class="sr-only">Meu aluno</span></th><th>Criança</th><th>Avaliação</th><th>Fontes</th><th>Cruzamento</th><th>Equipe · prontuário</th></tr></thead><tbody>${A.map(r=>{const L=pseLinks(r),c=pseCad(r);return `<tr><td class="cb"><input class="ps-cb" type="checkbox" data-ps-mine-cb="${esc(r.key)}" ${pseIsMine(r)?'checked':''} aria-label="Meu aluno: ${esc(pseTitle(r.nome))}"></td><td><button class="ps-name" type="button" data-ps-open="${esc(r.key)}">${esc(pseTitle(c.nome))}</button><small>${ageAt({dataNascimento:r.nasc},parseDate(r.dataAval))??'—'} anos · ${esc(r.turma)}</small></td><td>${pseEvalChip(r)}${r.dor?' <span class="ps-chip red">Dor</span>':''}</td><td>${pseSrcs(L)}</td><td>${pseTriChip(L.state)}</td><td>${c.equipe?`Equipe ${esc(c.equipe)}`:'<span class="muted">—</span>'}${c.pront?`<small class="mono">${esc(c.pront)}</small>`:''}</td></tr>`}).join('')}</tbody></table></div>
  ${p.pseTurma?`<div class="ps-acts"><span class="ps-hint">Turma ${esc(p.pseTurma)} inteira:</span><button class="btn small" type="button" data-ps-turma-mine="1">Marcar todas</button><button class="btn small" type="button" data-ps-turma-mine="0">Desmarcar todas</button></div>`:''}</article>`}
function pseRow(r){const c=pseCad(r),L=pseLinks(r),age=ageAt({dataNascimento:r.nasc},parseDate(r.dataAval));return `<tr class="ps-row" data-ps-open="${esc(r.key)}"><td><b>${esc(pseTitle(c.nome))}</b><small>${age??'—'} anos · ${esc(r.turma)}${c.pront?` · <span class="mono">${esc(c.pront)}</span>`:''}</small></td><td>${pseEvalChip(r)}${r.dor?' <span class="ps-chip red">Dor</span>':''}</td><td>${pseStageChip(pseStage(r))}</td><td>${c.tel?esc(c.tel):'<span class="ps-chip amber">Sem telefone</span>'}</td><td>${pseSrcs(L)}</td></tr>`}
function pseTeamOf(r){return String(pseCad(r).equipe||'').trim()}
function pseAcompHTML(){const all=pseRecords().filter(pseIsMine),teams=[...new Set(all.map(pseTeamOf))].sort((a,b)=>!a?1:!b?-1:a.localeCompare(b,'pt-BR',{numeric:true})),sel=(psePrefs().pseEquipes||[]).filter(t=>teams.includes(t)),M=sel.length?all.filter(r=>sel.includes(pseTeamOf(r))):all,need=M.filter(r=>pseStage(r)),ord=PSE_STAGES.map(x=>x[0]),rk=x=>x==='Alto'?0:x==='Médio'?1:2;need.sort((a,b)=>ord.indexOf(pseStage(a))-ord.indexOf(pseStage(b))||rk(a.risco)-rk(b.risco)||(b.dor-a.dor));pseNav=need.map(r=>r.key);
  const teamBar=teams.length>1||teams[0]?`<div class="ps-teams" role="group" aria-label="Filtrar por equipe"><span>Equipes</span>${teams.map(t=>`<button type="button" class="pr-chip" data-ps-team="${esc(t)}" aria-pressed="${sel.includes(t)}">${t?`Equipe ${esc(t)}`:'Sem equipe'} <i>${all.filter(r=>pseTeamOf(r)===t).length}</i></button>`).join('')}${sel.length?'<button type="button" class="link-btn" data-ps-team-clear>Todas</button>':''}</div>`:'';
  if(!all.length)return `<article class="card ps-box"><p class="ps-hint"><b>Nenhum aluno seu marcado neste filtro.</b> O acompanhamento mostra só as crianças da sua área adscrita.</p><div><button class="btn small primary" type="button" data-ps-tab="mine">Escolher meus alunos</button></div></article>`;
  return `${teamBar}<div class="ps-kpis four">${PSE_STAGES.map(([s,l])=>`<div class="card ps-kpi"><span>${l}</span><b>${need.filter(r=>pseStage(r)===s).length}</b><small>de ${need.length} que precisam de atendimento</small></div>`).join('')}</div>
  <article class="card ps-box"><div class="ps-h"><h2>Fila de acompanhamento</h2><small>${M.length} alunos seus · ${need.length} com risco alto ou médio, dor ou encaminhados · dor e risco alto primeiro</small></div><div class="table-scroll"><table class="ps-table"><thead><tr><th>Criança</th><th>Avaliação</th><th>Situação</th><th>Telefone</th><th>Fontes</th></tr></thead><tbody>${need.map(pseRow).join('')||'<tr><td colspan="5" class="muted">Nenhum dos seus alunos precisa de atendimento nesta campanha.</td></tr>'}</tbody></table></div></article>`}
function pseKV(rows){return `<div class="ps-kv">${rows.map(([l,v,m])=>`<span>${l}</span><b>${v?esc(v):'<span class="muted">não tem</span>'}${m==null?'':`<i class="ps-mk ${m?'ok':'no'}">${m?'igual':'diferente'}</i>`}</b>`).join('')}</div>`}
function pseTriHTML(r,{actions=false}={}){const L=pseLinks(r),t=L.t,c=pseCad(r),eqN=x=>norm(x)===norm(c.nome),maskCpf=v=>String(v||'').replace(/^(\d{3})\d{6}(\d{2})$/,'$1.•••.•••-$2');
  const pse=`<div class="ps-side"><span class="ps-src">PSE · ${esc(r.escola||'escola')}</span>${pseKV([['Nome',pseTitle(c.nome)],['Nascimento',fmtDate(c.nasc)],['CPF',maskCpf(c.cpf)],['Turma',r.turma]])}</div>`;
  const colP=L.col||t.col,colS=colP?`<div class="ps-side"><span class="ps-src">Atividade coletiva · ${fmtDate(colP.dates?.at(-1)?.date||colP.date)}</span>${pseKV([['Nome',pseTitle(colP.nome),eqN(colP.nome)],['Nascimento',fmtDate(colP.nasc),colP.nasc===c.nasc],['CPF',maskCpf(colP.cpf),c.cpf&&colP.cpf?colP.cpf===c.cpf:null],['CNS',colP.cns]])}</div>`:'<div class="ps-side none">Não aparece na atividade coletiva</div>';
  const prods=L.prod?[L.prod]:t.prod,prodS=prods.length?prods.map(p=>{const v=p.visits.find(x=>x.age!=null),exp=v&&c.nasc?ageAt({dataNascimento:c.nasc},parseDate(v.date)):null;return `<div class="ps-side"><span class="ps-src">Produção · prontuário ${esc(p.code)}</span>${pseKV([['Nome',pseTitle(p.nome),eqN(p.nome)],['Idade',v?`${v.age} anos em ${fmtDate(v.date)}`:'',v&&exp!=null?exp===v.age:null],['Atendimentos',p.visits.length?`${p.visits.length} (último ${fmtDate(p.visits.at(-1).date)})`:'']])}${actions&&prods.length>1&&!L.prod?`<button class="btn small" type="button" data-ps-prod="${esc(r.key)}|${esc(p.code)}">É este prontuário</button>`:''}</div>`}).join(''):'<div class="ps-side none">Não aparece na produção</div>';
  return `<div class="ps-tri">${pse}${colS}${prodS}</div>`}
function pseDefHTML(){const D=pseChildren().map(c=>c.last).filter(r=>pseLinks(r).state==='def');pseNav=D.map(r=>r.key);
  const cards=D.map(r=>{const L=pseLinks(r),t=L.t;return `<article class="card ps-box"><div class="ps-h"><h2><button class="ps-name" type="button" data-ps-open="${esc(r.key)}">${esc(pseTitle(pseCad(r).nome))}</button></h2><span class="ps-acts">${L.pendCol?`<span class="ps-chip amber wrap">Atividade coletiva: ${esc(t.colWhy)}</span>`:''}${L.pendProd?`<span class="ps-chip amber wrap">Produção: ${esc(t.prodWhy)}</span>`:''}</span></div>${pseTriHTML(r,{actions:true})}
    <div class="ps-acts">${L.pendCol?`<button class="btn small ps-good" type="button" data-ps-col-yes="${esc(r.key)}">Atividade coletiva: é a mesma</button><button class="btn small" type="button" data-ps-col-no="${esc(r.key)}">Não é</button>`:''}${L.pendProd&&t.prod.length===1?`<button class="btn small ps-good" type="button" data-ps-prod="${esc(r.key)}|${esc(t.prod[0].code)}">Prontuário: é a mesma</button>`:''}${L.pendProd?`<button class="btn small" type="button" data-ps-prod-no="${esc(r.key)}">${t.prod.length>1?'Nenhum deles':'Não é'}</button>`:''}</div></article>`}).join('');
  return `<div class="ps-stackv">${cards||'<article class="card ps-box"><p class="ps-hint"><b>Nada a definir.</b> Todos os cruzamentos foram resolvidos.</p></article>'}
  <article class="card ps-box"><div class="ps-h"><h2>Regras do cruzamento</h2></div><ol class="ps-rules">
    <li><b>PSE ↔ atividade coletiva</b> (Relação das Atividades em Grupo, que tem CPF e CNS): liga sozinho com CPF igual, ou com nome e nascimento iguais. Traz CPF, CNS e sexo.</li>
    <li><b>PSE ↔ produção</b> (Procedimentos Detalhado, que tem nome, idade e prontuário): liga sozinho com nome igual e idade no dia do atendimento igual à calculada pelo nascimento. Traz o prontuário e todos os atendimentos.</li>
    <li><b>A definir</b>: nome ou nascimento diferente, idade que não confere, ou mais de um prontuário com o mesmo nome. Nada disso liga sem você confirmar.</li>
    <li>Diferença de acento, maiúscula e espaço não conta. Relatórios importados antes da versão 2.29 precisam ser importados de novo para entrar no cruzamento.</li></ol></article></div>`}
// ---- gaveta da criança ----
let pseDrawer={key:null,tab:'acomp',edit:false,sched:false};
function pseFindRecord(key){const c=pseChildren().find(x=>x.key===key);if(!c)return null;const camp=psePrefs().pseCamp||'all';return (camp==='all'?null:c.evals.find(e=>e.snapId===camp))||c.last}
function openPseChild(key,tab){const r=pseFindRecord(key);if(!r)return;if(pseDrawer.key!==key)pseDrawer={key,tab:'acomp',edit:false,sched:false};if(tab)pseDrawer.tab=tab;
  const c=pseCad(r),L=pseLinks(r),mine=pseIsMine(r),s=mine?pseStage(r):null,age=ageAt({dataNascimento:c.nasc},parseDate(r.dataAval)),child=pseChildren().find(x=>x.key===key),idx=pseNav.indexOf(key),tone=s==='atendida'?'green':r.risco==='Alto'||r.dor?'red':r.risco==='Médio'?'amber':'blue';
  const head=`<header class="pq-d-h"><div class="pq-d-h-top"><div class="pq-d-nav"><button class="pq-icon" data-ps-nav="-1" ${idx<=0?'disabled':''} aria-label="Criança anterior"><span class="flip">${icon('chevron')}</span></button><span>${idx>=0?`${idx+1} de ${pseNav.length}`:'fora da lista'}</span><button class="pq-icon" data-ps-nav="1" ${idx<0||idx>=pseNav.length-1?'disabled':''} aria-label="Próxima criança">${icon('chevron')}</button></div><button class="pq-icon" data-close-drawer aria-label="Fechar">${icon('close')}</button></div>
    <h2>${esc(pseTitle(c.nome))}</h2><p class="pq-d-sub">${age??'—'} anos · ${esc(r.escola)} · ${esc(r.turma)}${c.equipe?` · Equipe ${esc(c.equipe)}`:''}${c.pront?` · <span class="mono">${esc(c.pront)}</span>`:''}</p>
    <div class="ps-acts" style="margin-top:6px">${pseEvalChip(r)}${r.dor?'<span class="ps-chip red">Dor</span>':''}${pseStageChip(s)}${mine?'<span class="ps-chip violet">Meu aluno</span>':''}${pseTriChip(L.state)}</div>
    <div class="pq-d-tabs">${[['acomp','Acompanhamento'],['hist','Histórico'],['celk','Cruzamento CELK'],['dados','Dados cadastrais']].map(([k,l])=>`<button class="pq-d-tab${pseDrawer.tab===k?' on':''}" data-ps-dtab="${k}">${l}</button>`).join('')}</div></header>`;
  const mineBox=`<section class="pq-d-card"><div class="pq-d-card-h"><div class="pq-sec-t">Da minha área adscrita?</div></div><div class="ps-mine"><button type="button" data-ps-mine-set="${esc(key)}|1" aria-pressed="${mine}">Sim, é meu aluno</button><button type="button" data-ps-mine-set="${esc(key)}|0" aria-pressed="${!mine}">Não</button></div><p class="pq-empty-s">${mine?'Entra na fila de acompanhamento.':'Aparece no Panorama e na análise, fora da fila de acompanhamento.'}</p></section>`;
  let body;
  if(pseDrawer.tab==='hist')body=pseHistHTML(r,child,L);
  else if(pseDrawer.tab==='celk'){const t=L.t,d=pseStore().dec[key]||{};body=`<section class="pq-d-card"><div class="pq-d-card-h"><div class="pq-sec-t">PSE × atividade coletiva × produção</div>${pseTriChip(L.state)}</div>${pseTriHTML(r,{actions:true})}
    <div class="ps-links"><div><span>Atividade coletiva</span><b>${L.col?'Ligada':L.pendCol?'A definir':'Sem registro'}</b><small>${esc(L.col?(d.col?'confirmado por você':t.colWhy):t.colWhy||'—')}</small></div><div><span>Produção</span><b>${L.prod?`Prontuário ${esc(L.prod.code)}`:L.pendProd?'A definir':'Sem registro'}</b><small>${esc(L.prod?(d.prod?'confirmado por você':t.prodWhy):t.prodWhy||'—')}</small></div></div>
    <div class="ps-acts">${L.pendCol?`<button class="btn small ps-good" type="button" data-ps-col-yes="${esc(key)}">Atividade coletiva: é a mesma</button><button class="btn small" type="button" data-ps-col-no="${esc(key)}">Não é</button>`:''}${L.pendProd&&t.prod.length===1?`<button class="btn small ps-good" type="button" data-ps-prod="${esc(key)}|${esc(t.prod[0].code)}">Prontuário: é a mesma</button>`:''}${L.pendProd?`<button class="btn small" type="button" data-ps-prod-no="${esc(key)}">${t.prod.length>1?'Nenhum deles':'Não é'}</button>`:''}${d.col||d.prod?`<button class="pq-link" type="button" data-ps-undo="${esc(key)}">Desfazer minhas decisões</button>`:''}</div>
    <p class="pq-d-hint">Se souber o prontuário, digite em "Dados cadastrais": o app puxa os atendimentos desse prontuário.</p></section>${mineBox}`}
  else if(pseDrawer.tab==='dados'){const e=pseDrawer.edit,f=(id,lab,v,{full=false,src='',type='text',display}={})=>`<label class="pq-f${full?' full':''}"><span>${lab}${src&&v?` <i class="ps-src-tag">${src}</i>`:''}</span>${e?(type==='sexo'?`<select id="${id}"><option value="">—</option><option value="F"${v==='F'?' selected':''}>Feminino</option><option value="M"${v==='M'?' selected':''}>Masculino</option></select>`:type==='textarea'?`<textarea id="${id}">${esc(v||'')}</textarea>`:`<input id="${id}" type="${type}" value="${esc(v||'')}">`):`<b>${esc(display??(v||'—'))}</b>`}</label>`;
    body=`<section class="pq-d-card"><div class="pq-d-card-h"><div class="pq-sec-t">Cadastro</div>${e?'':'<button class="pq-link" data-ps-edit>Editar</button>'}</div>${e?'<p class="pq-d-hint">As correções ficam salvas só nesta ferramenta e são mantidas nas próximas importações. O arquivo do PSE e o CELK não são alterados.</p>':''}
      <div class="pq-form">${f('psNome','Nome',pseTitle(c.nome),{full:true,src:'PSE'})}${f('psNasc','Nascimento',c.nasc,{src:'PSE',type:'date',display:fmtDate(c.nasc)})}${f('psSexo','Sexo',c.sexo,{src:'coletiva',type:'sexo',display:c.sexo==='F'?'Feminino':c.sexo==='M'?'Masculino':'—'})}${f('psCpf','CPF',c.cpf,{src:L.col&&!r.cpf?'coletiva':'PSE'})}${f('psCns','CNS',c.cns,{src:'coletiva'})}${f('psPront','Prontuário (CELK)',c.pront,{src:'produção'})}${f('psEquipe','Equipe',c.equipe)}${f('psResp','Responsável',c.resp,{full:true})}${f('psTel','Telefone do responsável',c.tel)}${f('psEsc','Escola · turma',`${r.escola} · ${r.turma}`,{src:'PSE'})}${f('psEnd','Endereço',c.end,{full:true})}${f('psNota','Nota local',c.nota,{full:true,type:'textarea'})}</div>
      ${e?`<div class="pq-d-edit-a"><button type="button" class="btn" data-ps-edit>Cancelar</button><button type="button" class="btn primary" data-ps-save="${esc(key)}">Salvar correções</button></div>`:''}</section>${mineBox}`}
  else{const f=pseStore().followups[key]||{history:[]},after=pseVisitsAfter(r),ev=[];
    for(const v of L.prod?.visits||[]){const sf=v.date>=r.dataAval&&pseIsSchoolFluor(v);ev.push({at:v.date,c:sf?'#9aa0bd':'#39b980',t:sf?'Lançamento do flúor aplicado na escola (não conta como atendimento)':v.date>=r.dataAval?'Atendimento na UBS depois da avaliação':'Atendimento na UBS',s:`${(v.items||[]).filter(x=>!String(x[3]||'').includes('n')||/urg/i.test(x[0])).map(x=>x[0]).join(', ')||(v.procs||[]).join(', ')} · prontuário ${L.prod.code}`});}
    for(const d of L.col?.dates||[])ev.push({at:d.date,c:'#3dc1d3',t:'Escovação supervisionada (atividade coletiva)',s:`${d.subject||''}${d.alt!=null?` · avaliação alterada: ${d.alt?'sim':'não'}`:''}`});
    f.history.forEach((h,hi)=>ev.push({at:h.at,c:h.type==='note'?'#e7a23b':'#7551e9',t:h.text,s:`${h.type==='note'?'Nota':'Registro'} · ${fmtDateTime(h.at)}`,note:h.type==='note',del:hi}));
    for(const e2 of child?.evals||[])ev.push({at:e2.dataAval,c:'#e15f41',t:`Avaliação do PSE · ${e2.status==='Preenchida'&&e2.risco?`risco ${e2.risco.toLowerCase()}`:e2.status.toLowerCase()}`,s:[e2.conduta,e2.editadoPor&&`por ${e2.editadoPor}`].filter(Boolean).join(' · ')});
    ev.sort((a,b)=>String(b.at).localeCompare(String(a.at)));
    const next=!mine?'Não está na sua área adscrita. Marque "Sim, é meu aluno" para acompanhar.':!s?'Sem necessidade de acompanhamento nesta campanha.':s==='contatar'?(normalizePhone(c.tel)?'Avisar o responsável e agendar.':'Sem telefone: mandar bilhete pela escola ou pedir busca ativa.'):s==='contato'?'Aguardando resposta do responsável.':s==='agendada'?`Consulta agendada${f.history.at(-1)?.agendaAt?` para ${fmtDate(f.history.at(-1).agendaAt)}`:''}. Confirmar se compareceu.`:`Atendida na UBS depois da avaliação${after[0]?` (${fmtDate(after[0].date)})`:''}.`;
    const cur=PSE_STAGES.findIndex(x=>x[0]===s),today=isoDate(new Date()),week=isoDate(new Date(Date.now()+7*DAY_MS)),prev=child?.evals.length>1?child.evals.at(-2):null,delta=prev&&prev.risco&&r.risco?PSE_RISK.indexOf(r.risco)-PSE_RISK.indexOf(prev.risco):null;
    const flags=[['Dor',r.dor],['Problemas periodontais',r.perio],['PcD',r.pcd],['Indicação de ART',r.art],['Encaminhada à UBS',r.encUbs],['Atendimento em consultório',r.consult],['Escovação realizada',r.escov],['Flúor',r.fluor]];
    body=`<section class="pq-d-next"><div class="pq-d-next-top"><div><div class="pq-sec-t">Próxima ação</div><p class="pq-d-why">${esc(next)}</p></div>${!mine?`<button class="pq-next" data-ps-mine-set="${esc(key)}|1">Sim, é meu aluno</button>`:''}</div>
      ${s?`<ol class="pq-steps" aria-label="Etapa do acompanhamento">${PSE_STAGES.map(([,l],j)=>`<li class="${j<cur?'done':''}${j===cur?' cur':''}"><i></i>${l}</li>`).join('')}</ol>
      <div class="pq-d-more"><span>Registrar:</span><button class="pq-qa" data-ps-reg="${esc(key)}|whatsapp">${icon('message')}WhatsApp</button><button class="pq-qa" data-ps-reg="${esc(key)}|bilhete">${icon('file')}Bilhete pela escola</button><button class="pq-qa" data-ps-reg="${esc(key)}|busca">${icon('search')}Busca ativa</button><button class="pq-qa" data-ps-sched="${esc(key)}">${icon('clock')}Agendar</button><button class="pq-qa" data-ps-reg="${esc(key)}|atendida">${icon('check')}Atendida</button></div>
      <div class="pq-sched"${pseDrawer.sched?'':' hidden'}><label><span>Data da consulta</span><input type="date" id="psSchedDate" min="${today}" value="${week}"></label><button class="pq-next" data-ps-sched-save="${esc(key)}">Salvar agendamento</button></div>`:''}</section>
    ${mine?`<section class="pq-d-card"><div class="pq-d-card-h"><div class="pq-sec-t">Contato do responsável</div>${normalizePhone(c.tel)?'':'<span class="pq-tag amber">Sem telefone válido</span>'}</div><div class="pq-d-phone"><div><b>${esc(c.resp||'Responsável não informado')}</b><small>${esc(c.tel||'Telefone não informado')} · ${esc(c.end||'Endereço não informado')}</small></div><div class="pq-d-phone-a">${normalizePhone(c.tel)?`<button class="pq-next wa" data-ps-wa="${esc(key)}">${icon('message')}Abrir WhatsApp</button>`:`<button class="pq-qa" data-ps-dtab="dados" data-ps-editgo="1">Completar contato</button>`}</div></div></section>`:''}
    <section class="pq-d-card"><div class="pq-d-card-h"><div class="pq-sec-t">${pseOnlyArt(r)?'Só ação de ART':'Saúde bucal'} · ${fmtDate(r.dataAval)}</div>${delta!=null?`<span class="ps-chip ${delta>0?'red':delta<0?'green':'gray'}">${delta>0?'Piorou':delta<0?'Melhorou':'Igual'} desde ${fmtDate(prev.dataAval)}</span>`:''}</div>
      ${pseOnlyArt(r)?`<p class="pq-d-hint">Participou só da ação ou avaliação de ART: não tem avaliação de saúde bucal (risco, lesões, exodontia). Status ART: ${esc(r.statusArt)}${r.semNec?' · sem necessidade':''}${r.encArt?' · encaminhada à UBS pelo ART':''}${r.obsArt?` · ${esc(r.obsArt)}`:''}.</p>`:''}<div class="pq-d-facts"><div><span>Risco</span><b>${esc(pseOnlyArt(r)?'—':(r.risco||r.status))}</b></div><div><span>Lesões cavitadas</span><b>${esc(r.lesoes||'—')}</b></div><div><span>Exodontia</span><b>${esc(r.exo||'—')}</b></div><div><span>ART</span><b>${r.aFazer.length} a fazer · ${r.feitos.length} feito(s)</b></div></div>
      <div class="ps-flags">${flags.map(([t,v])=>`<span class="${v?'on':''}">${v?'✓ ':''}${esc(t)}</span>`).join('')}</div>
      ${r.aFazer.length||r.feitos.length?`<div class="ps-teeth">${r.aFazer.map(t=>`<span>${esc(t)}</span>`).join('')}${r.feitos.map(t=>`<span class="ok">✓ ${esc(t)}</span>`).join('')}</div><p class="pq-empty-s">Dentição ${esc((r.denticao||'não informada').toLowerCase())} · TCLE ${r.tcle?'assinado':'não assinado'}</p>`:''}${r.obs?`<p class="pq-d-hint">Observação: ${esc(r.obs)}</p>`:''}${r.conduta?`<p class="pq-empty-s">Conduta: ${esc(r.conduta)}</p>`:''}</section>
    <section class="pq-d-card"><div class="pq-d-card-h"><div class="pq-sec-t">Linha do tempo</div><span class="pq-d-count">${ev.length} registro(s)</span></div>
      <div class="pq-d-note"><textarea id="psNoteInput" rows="2" placeholder="Escreva uma nota sobre a criança ou o contato"></textarea><div class="pq-d-note-a"><button type="button" class="btn small primary" data-ps-note="${esc(key)}">Salvar nota</button></div></div>
      <ol class="pq-hist">${ev.map(x=>`<li${x.del!=null?' class="ps-hist-del"':''}><i style="background:${x.c}"></i><div><b class="${x.note?'is-note':''}">${esc(x.t)}</b><small>${fmtDate(x.at)}${x.s?` · ${esc(x.s)}`:''}</small></div>${x.del!=null?`<button type="button" class="pq-icon ps-del" data-ps-del="${esc(key)}|${x.del}" title="Remover este registro" aria-label="Remover este registro">${icon('trash')}</button>`:''}</li>`).join('')}</ol><p class="pq-empty-s">Registros feitos por você (contatos, agendamento, atendida e notas) têm a lixeira para remover. Os que vêm do CELK e do PSE não podem ser removidos aqui.</p></section>`}
  openDrawer(`<div class="pq-drawer tone-${tone}">${head}<div class="pq-d-b">${body}</div></div>`);document.getElementById('drawer').classList.add('pq-drawer-host');
}
// Aba "Histórico" da gaveta: tudo o que existe no nome da criança — atendimentos do prontuário (com todos os procedimentos,
// quantidade e dentista), escovações da atividade coletiva e todas as avaliações do PSE. Registros com o mesmo nome que ainda
// não foram ligados aparecem à parte, marcados como "não ligado".
function pseHistHTML(r,child,L){const t=L.t,evalDate=r.dataAval;
  const visitHTML=(p,linked)=>{const vs=[...p.visits].sort((a,b)=>String(b.date).localeCompare(String(a.date)));return vs.length?`<ol class="ps-hv">${vs.map(v=>{const sf=linked&&v.date>=evalDate&&pseIsSchoolFluor(v),items=v.items?v.items.map(x=>`${esc(x[0])}${Number(x[1])>1?` ×${fmtNum(Number(x[1]))}`:''}${x[2]?` <span class="muted">· ${esc(pseTitle(x[2]))}</span>`:''}`):(v.procs||[]).map(esc);return `<li><div class="ps-hv-h"><b>${fmtDate(v.date)}</b>${v.age!=null?`<span class="muted">${v.age} anos</span>`:''}${sf?'<span class="ps-chip gray">lançamento do flúor da escola</span>':linked&&v.date>=evalDate?'<span class="ps-chip green">depois da avaliação</span>':''}</div><ul>${items.map(x=>`<li>${x}</li>`).join('')}</ul></li>`}).join('')}</ol>`:'<p class="pq-empty-s">Nenhum atendimento nos relatórios importados.</p>'};
  const prodLinked=L.prod?`<div class="ps-hsub"><b>Prontuário ${esc(L.prod.code)}</b><span class="muted">${L.prod.visits.length} atendimento(s) · ${sum(L.prod.visits.map(v=>(v.items||[]).filter(x=>!String(x[3]||'').includes('n')).reduce((a,x)=>a+(Number(x[1])||0),0)))} procedimento(s)</span></div>${visitHTML(L.prod,true)}`:'';
  const prodOthers=(t.prod||[]).filter(p=>!L.prod||p.code!==L.prod.code);
  const prodOtherHTML=prodOthers.length?`<div class="ps-hother"><div class="ps-hsub"><b>Com o mesmo nome, não ligado${prodOthers.length>1?'s':''}</b><span class="muted">${esc(L.pendProd?t.prodWhy:'você decidiu que não é esta criança')}</span></div>${prodOthers.map(p=>`<div class="ps-hsub"><span>Prontuário ${esc(p.code)}</span></div>${visitHTML(p,false)}`).join('')}</div>`:'';
  const colP=L.col||t.col,colHTML=colP?`<div${L.col?'':' class="ps-hother"'}>${L.col?'':`<div class="ps-hsub"><b>Com o mesmo nome, não ligado</b><span class="muted">${esc(t.colWhy)}</span></div>`}<ol class="ps-hv">${[...(colP.dates||[{date:colP.date,subject:colP.subject,alt:colP.alt}])].sort((a,b)=>String(b.date).localeCompare(String(a.date))).map(d=>`<li><div class="ps-hv-h"><b>${fmtDate(d.date)}</b>${d.alt?'<span class="ps-chip amber">avaliação alterada</span>':''}</div><ul><li>${esc(d.subject||'Atividade coletiva')}</li></ul></li>`).join('')}</ol><p class="pq-empty-s">CPF ${esc(String(colP.cpf||'—').replace(/^(\d{3})\d{6}(\d{2})$/,'$1.•••.•••-$2'))} · CNS ${esc(colP.cns||'—')} · nascimento ${fmtDate(colP.nasc)}</p></div>`:'<p class="pq-empty-s">Não aparece na Relação das Atividades em Grupo importada.</p>';
  const evals=[...(child?.evals||[r])].sort((a,b)=>String(b.dataAval).localeCompare(String(a.dataAval)));
  const evHTML=`<ol class="ps-hv">${evals.map(e=>`<li><div class="ps-hv-h"><b>${fmtDate(e.dataAval)}</b><span class="muted">${esc(e.escola)} · ${esc(e.turma)}</span>${pseEvalChip(e)}</div><ul>${e.status==='Preenchida'?`<li>Lesões cavitadas: ${esc(e.lesoes||'—')} · exodontia: ${esc(e.exo||'—')}${e.dor?' · dor':''}</li>`:''}${e.conduta?`<li>${esc(e.conduta)}</li>`:''}${e.aFazer.length||e.feitos.length?`<li>ART: ${e.aFazer.length} a fazer${e.aFazer.length?` (${esc(e.aFazer.join(', '))})`:''} · ${e.feitos.length} feito(s)${e.feitos.length?` (${esc(e.feitos.join(', '))})`:''}</li>`:''}${e.editadoPor?`<li class="muted">por ${esc(e.editadoPor)}</li>`:''}</ul></li>`).join('')}</ol>`;
  const nVis=L.prod?.visits.length||0,nCol=L.col?.dates?.length||0;
  return `<div class="pq-d-facts"><div><span>Atendimentos</span><b>${nVis}</b></div><div><span>Escovações</span><b>${nCol}</b></div><div><span>Avaliações PSE</span><b>${evals.length}</b></div><div><span>Prontuário</span><b>${esc(L.prod?.code||'—')}</b></div></div>
    <section class="pq-d-card"><div class="pq-d-card-h"><div class="pq-sec-t">Produção do CELK (Procedimentos Detalhado)</div>${L.pendProd?'<span class="ps-chip amber">A definir</span>':''}</div>${prodLinked||(prodOthers.length?'':'<p class="pq-empty-s">Nenhum prontuário com este nome nos relatórios de produção importados.</p>')}${prodOtherHTML}</section>
    <section class="pq-d-card"><div class="pq-d-card-h"><div class="pq-sec-t">Escovações (Relação das Atividades em Grupo)</div>${L.pendCol?'<span class="ps-chip amber">A definir</span>':''}</div>${colHTML}</section>
    <section class="pq-d-card"><div class="pq-d-card-h"><div class="pq-sec-t">Avaliações do PSE</div></div>${evHTML}</section>
    ${L.state==='def'?'<p class="pq-d-hint">Há registros com o mesmo nome ainda não ligados. Resolva em "Cruzamento CELK".</p>':''}`}
function pseRefresh(){renderView('pse');if(pseDrawer.key&&document.getElementById('drawerBackdrop').classList.contains('open'))openPseChild(pseDrawer.key)}
function pseSaveCad(key){const v=id=>document.getElementById(id)?.value??'',s=pseStore(),r=pseFindRecord(key),base={nome:pseTitle(r.nome),nasc:r.nasc,cpf:r.cpf},vals={nome:norm(v('psNome')),nasc:v('psNasc'),sexo:v('psSexo'),cpf:v('psCpf').replace(/\D/g,''),cns:v('psCns').trim(),pront:pid(v('psPront')),equipe:v('psEquipe').trim(),resp:v('psResp').trim(),tel:v('psTel').trim(),end:v('psEnd').trim(),nota:v('psNota').trim()};
  if(vals.nome===norm(base.nome))delete vals.nome;if(vals.nasc===base.nasc)delete vals.nasc;s.overrides[key]={...(s.overrides[key]||{}),...vals};pseDrawer.edit=false;audit('pse_child_edited',{});queueSave();toast('Cadastro salvo.');pseRefresh()}
// A chave da criança tem "|" (nome|nascimento): separa só no último "|".
function psSplitKey(v){const i=String(v).lastIndexOf('|');return [v.slice(0,i),v.slice(i+1)]}
function pseClick(ev){const el=ev.target.closest('[data-ps-tab],[data-ps-open],[data-ps-nav],[data-ps-dtab],[data-ps-edit],[data-ps-save],[data-ps-mine-set],[data-ps-mine-sug],[data-ps-turma-mine],[data-ps-col-yes],[data-ps-col-no],[data-ps-prod],[data-ps-prod-no],[data-ps-undo],[data-ps-del],[data-ps-team],[data-ps-team-clear],[data-ps-reg],[data-ps-sched],[data-ps-sched-save],[data-ps-note],[data-ps-wa]');if(!el)return;const d=el.dataset,s=pseStore();
  if(d.psTab){state.preferences.pseTab=d.psTab;queueSave();if(el.closest('#drawer'))closeDrawer();return renderView('pse')}
  if(d.psOpen)return openPseChild(d.psOpen,'acomp');
  if(d.psNav){const i=pseNav.indexOf(pseDrawer.key)+Number(d.psNav);if(pseNav[i])openPseChild(pseNav[i],pseDrawer.tab);return}
  if(d.psDtab){pseDrawer.tab=d.psDtab;pseDrawer.edit=!!d.psEditgo;return openPseChild(pseDrawer.key)}
  if(el.hasAttribute('data-ps-edit')){pseDrawer.edit=!pseDrawer.edit;return openPseChild(pseDrawer.key)}
  if(d.psSave)return pseSaveCad(d.psSave);
  if(d.psMineSet){const [k,v]=psSplitKey(d.psMineSet);s.mine[k]=v==='1';audit('pse_mine_changed',{});queueSave();toast(v==='1'?'Aluno adicionado ao acompanhamento.':'Fora do acompanhamento.');return pseRefresh()}
  if(el.hasAttribute('data-ps-mine-sug')){let n=0;for(const r of pseRecords())if(!pseIsMine(r)&&pseLinks(r).state==='ok'){s.mine[r.key]=true;n++}queueSave();toast(`${n} aluno(s) marcados. Confira a lista e desmarque quem não é da sua área.`);return pseRefresh()}
  if(d.psTurmaMine){for(const r of pseRecords())s.mine[r.key]=d.psTurmaMine==='1';queueSave();return pseRefresh()}
  if(d.psColYes){const r=pseFindRecord(d.psColYes),t=pseTriangulate(r);(s.dec[d.psColYes]??={}).col=pseColKey(t.col);queueSave();toast('Atividade coletiva ligada: CPF, CNS e sexo foram para a ficha.');return pseRefresh()}
  if(d.psColNo){(s.dec[d.psColNo]??={}).col='no';queueSave();toast('Não é a mesma criança.');return pseRefresh()}
  if(d.psProd){const [k,code]=psSplitKey(d.psProd);(s.dec[k]??={}).prod=code;queueSave();toast(`Prontuário ${code} ligado. Os atendimentos entram na linha do tempo.`);return pseRefresh()}
  if(d.psProdNo){(s.dec[d.psProdNo]??={}).prod='no';queueSave();toast('Prontuário não ligado.');return pseRefresh()}
  if(d.psTeam!=null){const p=psePrefs(),cur=new Set(p.pseEquipes||[]);cur.has(d.psTeam)?cur.delete(d.psTeam):cur.add(d.psTeam);p.pseEquipes=[...cur];queueSave();return renderView('pse')}
  if(el.hasAttribute('data-ps-team-clear')){psePrefs().pseEquipes=[];queueSave();return renderView('pse')}
  if(d.psDel){const [k,i]=psSplitKey(d.psDel),f=s.followups[k],idx=Number(i);if(!f?.history?.[idx])return;const [removed]=f.history.splice(idx,1);audit('pse_followup_removed',{type:removed.type});queueSave();pseRefresh();toastAction(`Removido: ${removed.text}`,'Desfazer',()=>{const g=s.followups[k]||(s.followups[k]={history:[]});g.history.splice(Math.min(idx,g.history.length),0,removed);queueSave();pseRefresh()});return}
  if(d.psUndo){delete s.dec[d.psUndo];queueSave();return pseRefresh()}
  if(d.psReg){const [k,type]=psSplitKey(d.psReg),m={whatsapp:['WhatsApp enviado ao responsável','contato'],bilhete:['Bilhete enviado pela escola','contato'],busca:['Busca ativa solicitada','contato'],atendida:['Atendida (registrado por você)','atendida']}[type];pseRegister(k,type,m[0],m[1]);toast(`${m[0]} · registrado.`);return pseRefresh()}
  if(d.psSched){pseDrawer.sched=!pseDrawer.sched;return openPseChild(pseDrawer.key)}
  if(d.psSchedSave){const dt=document.getElementById('psSchedDate')?.value;if(!dt)return toast('Escolha a data da consulta.');pseRegister(d.psSchedSave,'agendada',`Consulta agendada para ${fmtDate(dt)}`,'agendada',{agendaAt:dt});pseDrawer.sched=false;toast('Agendamento registrado.');return pseRefresh()}
  if(d.psNote){const v=document.getElementById('psNoteInput')?.value.trim();if(!v)return toast('Escreva a nota primeiro.');pseRegister(d.psNote,'note',v,null);toast('Nota salva.');return openPseChild(d.psNote)}
  if(d.psWa){const r=pseFindRecord(d.psWa),ph=normalizePhone(pseCad(r).tel);if(ph){window.open(`https://wa.me/${ph}`,'_blank','noopener,noreferrer');pseRegister(d.psWa,'whatsapp','WhatsApp aberto para o responsável','contato');pseRefresh()}return}
}
function pseChange(ev){const t=ev.target;if(t.dataset?.psPref){state.preferences[t.dataset.psPref]=t.value;if(t.dataset.psPref!=='pseTurma')state.preferences.pseTurma='';queueSave();return renderView('pse')}
  if(t.dataset?.psMineCb){pseStore().mine[t.dataset.psMineCb]=t.checked;queueSave();const tabs=document.querySelector('#view-pse .sx-tabs');if(tabs){const n=pseChildren().filter(c=>pseIsMine(c.last)).length,b=tabs.querySelector('[data-ps-tab="mine"]');if(b)b.innerHTML=`Meus alunos${n?`<span class="ps-count v">${n}</span>`:''}`}}}
function pseInput(ev){if(ev.target.id==='pseSearch'){state.preferences.pseSearch=ev.target.value;const pos=ev.target.selectionStart;renderView('pse');const q=document.getElementById('pseSearch');if(q){q.focus();q.setSelectionRange(pos,pos)}}}
// ---- base da análise estatística ----
function pseStatRows(months){const set=new Set(months),out=[];
  for(const c of pseChildren())for(const r of c.evals){if(!set.has(String(r.dataAval).slice(0,7)))continue;const L=pseLinks(r),cad=pseCad(r),ev=r.status==='Preenchida',y=b=>ev?sxYN(b):null,age=ageAt({dataNascimento:cad.nasc},parseDate(r.dataAval)),vis=L.prod?.visits||[],after=vis.filter(v=>v.date>=r.dataAval&&!pseIsSchoolFluor(v)),before=vis.filter(v=>v.date<r.dataAval),alt=L.col?.dates?.some(d=>d.alt),hist=(pseStore().followups[r.key]?.history||[]).filter(h=>h.at>=r.dataAval&&h.type!=='note');
    out.push([cad.sexo==='F'?'Feminino':cad.sexo==='M'?'Masculino':null,r.escola||null,r.turma||null,r.ano||null,sxYN(pseIsMine(r)),pseOnlyArt(r)?'Só ART':r.status||null,ev&&r.risco?r.risco:null,ev&&r.risco?sxYN(r.risco==='Alto'):null,ev&&r.lesoes?r.lesoes:null,ev&&r.lesoes?sxYN(r.lesoes!=='Zero'):null,ev&&r.exo?r.exo:null,ev&&r.exo?sxYN(r.exo!=='Não necessita'):null,y(r.dor),y(r.perio),sxYN(r.pcd),y(r.art),y(r.encUbs),y(r.fluor),L.prod?sxYN(before.length>0):null,L.prod?sxYN(after.length>0):null,L.col?sxYN(!!alt):null,age,r.aFazer.length,r.feitos.length,after.length?Math.round((parseDate(after[0].date)-parseDate(r.dataAval))/864e5):null,pseIsMine(r)?hist.length:null,L.state==='ok'?'Confirmado':L.state==='def'?'A definir':'Sem registro'])}
  return {rows:out,legacy:0}}

/* ---------- Análise estatística (v2.28): aba da página Procedimentos ---------- */
// Uma linha por pessoa (paciente da produção, gestante do Monitora ou participação em escovação), sem nome.
// Os testes rodam no navegador; "Baixar dados para análise" gera o CSV + um script R para conferir em outro programa.
const sxF=(x,d=2)=>Number(x).toLocaleString('pt-BR',{minimumFractionDigits:d,maximumFractionDigits:d}),sxPc=(x,d=1)=>sxF(100*x,d)+'%',sxP=p=>p<0.001?'< 0,001':sxF(p,3);
function sxLnGamma(z){const c=[76.18009172947146,-86.50532032941677,24.01409824083091,-1.231739572450155,.1208650973866179e-2,-.5395239384953e-5];let x=z,y=z,t=x+5.5;t-=(x+.5)*Math.log(t);let s=1.000000000190015;for(const v of c)s+=v/++y;return -t+Math.log(2.5066282746310005*s/x)}
function sxGammaQ(a,x){if(x<=0)return 1;if(x<a+1){let sum=1/a,del=sum,ap=a;for(let n=0;n<500;n++){ap++;del*=x/ap;sum+=del;if(Math.abs(del)<Math.abs(sum)*1e-14)break}return 1-sum*Math.exp(-x+a*Math.log(x)-sxLnGamma(a))}let b=x+1-a,c=1e300,d=1/b,h=d;for(let i=1;i<500;i++){const an=-i*(i-a);b+=2;d=an*d+b;if(Math.abs(d)<1e-300)d=1e-300;c=b+an/c;if(Math.abs(c)<1e-300)c=1e-300;d=1/d;const del=d*c;h*=del;if(Math.abs(del-1)<1e-14)break}return Math.exp(-x+a*Math.log(x)-sxLnGamma(a))*h}
const sxChi2p=(x,df)=>df>0?sxGammaQ(df/2,x/2):1;
const sxNormp=z=>sxChi2p(z*z,1); // bicaudal
function sxBetacf(a,b,x){let qab=a+b,qap=a+1,qam=a-1,c=1,d=1-qab*x/qap;if(Math.abs(d)<1e-300)d=1e-300;d=1/d;let h=d;for(let m=1;m<=300;m++){const m2=2*m;let aa=m*(b-m)*x/((qam+m2)*(a+m2));d=1+aa*d;if(Math.abs(d)<1e-300)d=1e-300;c=1+aa/c;if(Math.abs(c)<1e-300)c=1e-300;d=1/d;h*=d*c;aa=-(a+m)*(qab+m)*x/((a+m2)*(qap+m2));d=1+aa*d;if(Math.abs(d)<1e-300)d=1e-300;c=1+aa/c;if(Math.abs(c)<1e-300)c=1e-300;d=1/d;const del=d*c;h*=del;if(Math.abs(del-1)<1e-12)break}return h}
function sxBetai(a,b,x){if(x<=0)return 0;if(x>=1)return 1;const bt=Math.exp(sxLnGamma(a+b)-sxLnGamma(a)-sxLnGamma(b)+a*Math.log(x)+b*Math.log(1-x));return x<(a+1)/(a+b+2)?bt*sxBetacf(a,b,x)/a:1-bt*sxBetacf(b,a,1-x)/b}
const sxTp=(t,df)=>sxBetai(df/2,.5,df/(df+t*t));
function sxFisher(a,b,c,d){const lnF=n=>sxLnGamma(n+1),n=a+b+c+d,r1=a+b,c1=a+c,lp=x=>lnF(r1)+lnF(n-r1)+lnF(c1)+lnF(n-c1)-lnF(n)-lnF(x)-lnF(r1-x)-lnF(c1-x)-lnF(n-r1-c1+x);const obs=lp(a);let p=0;for(let x=Math.max(0,r1+c1-n);x<=Math.min(r1,c1);x++){const v=lp(x);if(v<=obs+1e-7)p+=Math.exp(v)}return Math.min(1,p)}
function sxWilson(k,n){if(!n)return [0,0,0];const z=1.96,p=k/n,den=1+z*z/n,c=(p+z*z/(2*n))/den,h=z*Math.sqrt(p*(1-p)/n+z*z/(4*n*n))/den;return [p,Math.max(0,c-h),Math.min(1,c+h)]}
function sxRanks(v){const idx=v.map((x,i)=>[x,i]).sort((a,b)=>a[0]-b[0]),r=new Array(v.length);let ties=0;for(let i=0;i<idx.length;){let j=i;while(j+1<idx.length&&idx[j+1][0]===idx[i][0])j++;const avg=(i+j)/2+1;for(let k=i;k<=j;k++)r[idx[k][1]]=avg;const t=j-i+1;ties+=t*t*t-t;i=j+1}return {r,ties}}
const sxQuant=(s,q)=>{const a=[...s].sort((x,y)=>x-y);if(!a.length)return 0;const pos=(a.length-1)*q,lo=Math.floor(pos),hi=Math.ceil(pos);return a[lo]+(a[hi]-a[lo])*(pos-lo)};
function sxSolve(A,b){const n=A.length,M=A.map((r,i)=>[...r,b[i]]);for(let c=0;c<n;c++){let p=c;for(let r=c+1;r<n;r++)if(Math.abs(M[r][c])>Math.abs(M[p][c]))p=r;[M[c],M[p]]=[M[p],M[c]];if(Math.abs(M[c][c])<1e-12)return null;for(let r=0;r<n;r++)if(r!==c){const k=M[r][c]/M[c][c];for(let j=c;j<=n;j++)M[r][j]-=k*M[c][j]}}return M.map((r,i)=>r[n]/r[i])}
function sxInverse(A){const n=A.length,cols=Array.from({length:n},(_,j)=>sxSolve(A,A.map((_,i)=>i===j?1:0)));if(cols.some(c=>!c))return null;return A.map((_,i)=>cols.map(c=>c[i]))}
// Regressão logística por Newton-Raphson (IRLS). Devolve coeficientes, erros-padrão (Wald) e log-verossimilhança.
function sxLogit(X,y){const k=X[0].length;let b=new Array(k).fill(0),ll=0;for(let it=0;it<30;it++){const H=Array.from({length:k},()=>new Array(k).fill(0)),g=new Array(k).fill(0);ll=0;for(let i=0;i<X.length;i++){const eta=X[i].reduce((a,x,j)=>a+x*b[j],0),p=1/(1+Math.exp(-eta)),w=Math.max(p*(1-p),1e-10);ll+=y[i]?Math.log(Math.max(p,1e-15)):Math.log(Math.max(1-p,1e-15));for(let j=0;j<k;j++){g[j]+=(y[i]-p)*X[i][j];for(let l=0;l<k;l++)H[j][l]+=w*X[i][j]*X[i][l]}}const d=sxSolve(H,g);if(!d)return null;b=b.map((v,j)=>v+d[j]);if(Math.max(...d.map(Math.abs))<1e-8)break}
  ll=0;const H=Array.from({length:k},()=>new Array(k).fill(0));for(let i=0;i<X.length;i++){const x=X[i],eta=x.reduce((a,v,j)=>a+v*b[j],0),p=1/(1+Math.exp(-eta)),w=Math.max(p*(1-p),1e-10);ll+=y[i]?Math.log(Math.max(p,1e-15)):Math.log(Math.max(1-p,1e-15));for(let j=0;j<k;j++)for(let l=0;l<k;l++)H[j][l]+=w*x[j]*x[l]}const V=sxInverse(H);if(!V)return null;return {b,se:b.map((_,j)=>Math.sqrt(Math.max(0,V[j][j]))),ll}}

// ---- bases de dados (uma linha por pessoa) ----
const SX_BIN='bin';
const SX_AGE_BANDS=['0–11','12–17','18–39','40–59','60+'];
const sxAgeBand=a=>a==null?null:a<=11?'0–11':a<=17?'12–17':a<=39?'18–39':a<=59?'40–59':'60+';
const sxYN=b=>b?'Sim':'Não';
const sxHas=(set,re)=>[...set].some(n=>re.test(norm(n)));
let sxCache={key:'',value:null};
// Pacientes da produção (Procedimentos Detalhado) nos meses do período. Índices das colunas = SX_BASES.pat.vars[].i.
function sxPatientRows(months,unit=state.preferences.unit){
  const snapsBy=months.map(mk=>[mk,latestSnapshots('celk_procedimentos_detalhado',mk,unit)]),key='pat|'+snapsBy.map(([mk,ss])=>mk+':'+ss.map(s=>s.id).join(',')).join('|');
  if(sxCache.key===key)return sxCache.value;
  const visits=new Map(),withData=new Set();let legacy=0;
  for(const [mk,ss] of snapsBy)for(const s of ss){const list=s.dataByMonth[mk]?.patientVisits||[];if(list.length)withData.add(mk);for(const v of list){if(!v.items){legacy++;continue}const k=`${v.id}|${v.date}`;if(!visits.has(k))visits.set(k,v)}}
  const P=new Map();
  for(const v of [...visits.values()].sort((a,b)=>a.date.localeCompare(b.date))){const p=P.get(v.id)||{sex:'',age:null,days:new Set(),dent:new Map(),first:[],conc:[],urg:false,np:0,pr:new Set(),m:v.date.slice(0,7),months:new Set()};P.set(v.id,p);
    if(v.sex)p.sex=v.sex;if(p.age==null&&v.age!=null)p.age=v.age;p.days.add(v.date);p.months.add(v.date.slice(0,7));
    for(const [name,qty,prof,fl] of v.items){if(prof)p.dent.set(prof,(p.dent.get(prof)||0)+1);if(fl.includes('f'))p.first.push(v.date);if(fl.includes('c'))p.conc.push(v.date);if(fl.includes('u'))p.urg=true;if(!fl.includes('n')){p.np+=Number(qty)||0;p.pr.add(name)}}}
  const rows=[];
  for(const p of P.values()){
    const f1=p.first.length?p.first.sort()[0]:null,cs=f1?p.conc.filter(c=>c>=f1).sort():[],c1=cs[0]||null,{year,month}=parseMonthKey(p.m),qF=quarterOfMonth(month);
    const next=qF<3?quarterMonths(year,qF+1).filter(mk=>withData.has(mk)):[],back=next.length?sxYN(next.some(mk=>p.months.has(mk))):null;
    const dents=[...p.dent.entries()].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0],'pt-BR'));
    rows.push([p.sex||null,sxAgeBand(p.age),dents[0]?.[0]||null,dents.length?sxYN(dents.length>1):null,MONTHS_SHORT[month-1],`Q${qF}`,
      sxYN(f1),f1?sxYN(c1):null,c1?sxYN(c1===f1):null,sxYN(p.days.size>1),sxYN(p.urg),
      sxYN(sxHas(p.pr,/^(ORIENTACAO|PROFILAXIA|APLICACAO TOPICA|APLICACAO DE SELANTE|APLICACAO DE CARIOSTATICO|EVIDENCIACAO)/)),sxYN(sxHas(p.pr,/^(RESTAURACAO|TRATAMENTO RESTAURADOR)/)),sxYN(sxHas(p.pr,/^EXODONTIA/)),sxYN(sxHas(p.pr,/^(RASPAGEM|GENGIVECTOMIA|TRATAMENTO DE GENGIVITE|TRATAMENTO DE PERICORONARITE)/)),sxYN(sxHas(p.pr,/^TRATAMENTO RESTAURADOR/)),back,
      p.age,p.days.size,Math.round(p.np),c1?Math.round((new Date(c1)-new Date(f1))/864e5):null,dents.length||null,[...p.pr]])}
  sxCache={key,value:{rows,legacy}};return sxCache.value;
}
// Gestantes e puérperas do Monitora APS: a informação mais recente de cada Usuária (os arquivos se somam).
function sxMonitoraRows(){const snaps=snapshotsAsc(MONITORA_PROFILE),map=new Map();let legacy=0;for(const s of snaps){if(!s.monitoraStat){legacy++;continue}for(const r of s.monitoraStat)map.set(r.u,r)}return {rows:[...map.values()].map(r=>[r.equipe||null,r.periodo||null,...r.v]),legacy}}
// Participações em escovação supervisionada (Relação das Atividades em Grupo) nos meses do período.
function sxKidRows(months,unit=state.preferences.unit){const rows=[];let legacy=0;
  for(const mk of months)for(const s of latestSnapshots('celk_atividades_grupo',mk,unit))for(const a of s.dataByMonth[mk]?.activityDetails||[]){if(!(a.brush||/ESCOV/.test(norm(a.temas))))continue;if(!a.kids){legacy++;continue}
    const turma=String(a.subject||'').replace(/^escova[cç][aã]o supervisionada\s*-\s*/i,'')||a.subject||null;
    for(const [sx,age,alt] of a.kids)rows.push([sx==='F'?'Feminino':sx==='M'?'Masculino':null,age==null?null:`${age} anos`,turma,a.local||null,a.turno||null,sxYN(alt),age])}
  return {rows,legacy};
}
const SX_BASES={
  pat:{label:'Pacientes da produção',unit:'paciente',vars:[{l:'Sexo',k:'sexo',i:0,t:'cat'},{l:'Faixa etária',k:'faixa_etaria',i:1,t:'ord',o:SX_AGE_BANDS},{l:'Dentista principal',k:'dentista',i:2,t:'cat'},{l:'Atendido por mais de um dentista',k:'mais_de_um_dentista',i:3,t:SX_BIN},{l:'Mês de entrada',k:'mes_entrada',i:4,t:'ord',o:MONTHS_SHORT},{l:'Quadrimestre de entrada',k:'quadrimestre_entrada',i:5,t:'ord',o:['Q1','Q2','Q3']},
    {l:'Teve primeira consulta',k:'primeira_consulta',i:6,t:SX_BIN},{l:'Concluiu tratamento',k:'concluiu',i:7,t:SX_BIN,only:'quem teve primeira consulta'},{l:'Concluiu no mesmo dia da 1ª consulta',k:'concluiu_mesmo_dia',i:8,t:SX_BIN,only:'quem concluiu tratamento'},{l:'Voltou mais de uma vez',k:'voltou',i:9,t:SX_BIN},{l:'Teve urgência',k:'urgencia',i:10,t:SX_BIN},{l:'Teve preventivo',k:'preventivo',i:11,t:SX_BIN},{l:'Teve restauração',k:'restauracao',i:12,t:SX_BIN},{l:'Teve exodontia',k:'exodontia',i:13,t:SX_BIN},{l:'Teve periodontia',k:'periodontia',i:14,t:SX_BIN},{l:'Teve ART',k:'art',i:15,t:SX_BIN},{l:'Voltou no quadrimestre seguinte',k:'voltou_quadrimestre_seguinte',i:16,t:SX_BIN,only:'quem entrou num quadrimestre cujo seguinte já foi importado (use o período Ano)'},
    {l:'Idade (anos)',k:'idade',i:17,t:'num',per10:true},{l:'Dias de atendimento',k:'dias_atendimento',i:18,t:'num'},{l:'Número de procedimentos',k:'n_procedimentos',i:19,t:'num'},{l:'Dias da 1ª consulta à conclusão',k:'dias_ate_conclusao',i:20,t:'num',only:'quem concluiu'},{l:'Número de dentistas',k:'n_dentistas',i:21,t:'num'},{l:'Teve o procedimento…',k:'teve',i:22,t:SX_BIN,custom:true}]},
  ges:{label:'Gestantes (Monitora APS)',unit:'gestante',noPeriod:true,vars:[{l:'Equipe',k:'equipe',i:0,t:'cat'},{l:'Período da gestação',k:'periodo_gestacao',i:1,t:'ord',o:['T1','T2','T3','Puerpério','Sem PN aberto'],trend:['T1','T2','T3']},{l:'1ª consulta até 12 semanas',k:'captacao_12s',i:2,t:SX_BIN},{l:'7 consultas de pré-natal',k:'sete_consultas',i:3,t:SX_BIN},{l:'7 aferições de pressão',k:'sete_pa',i:4,t:SX_BIN},{l:'7 registros de peso e altura',k:'sete_peso_altura',i:5,t:SX_BIN},{l:'Vacina DTPA',k:'dtpa',i:6,t:SX_BIN},{l:'Exames do 1º trimestre',k:'exames_t1',i:7,t:SX_BIN},{l:'Exames do 3º trimestre',k:'exames_t3',i:8,t:SX_BIN},{l:'Consulta de puerpério',k:'consulta_puerperio',i:9,t:SX_BIN},{l:'Consulta odontológica',k:'consulta_odonto',i:10,t:SX_BIN}]},
  kids:{label:'Crianças das escovações',unit:'participação',vars:[{l:'Sexo',k:'sexo',i:0,t:'cat'},{l:'Idade',k:'idade_faixa',i:1,t:'ord',o:Array.from({length:19},(_,i)=>`${i} anos`)},{l:'Turma',k:'turma',i:2,t:'cat'},{l:'Local',k:'local',i:3,t:'cat'},{l:'Turno',k:'turno',i:4,t:'cat'},{l:'Avaliação alterada',k:'avaliacao_alterada',i:5,t:SX_BIN},{l:'Idade (anos)',k:'idade',i:6,t:'num'}]},
  pse:{label:'Crianças do PSE',unit:'avaliação',vars:[{l:'Sexo (da atividade coletiva)',k:'sexo',i:0,t:'cat'},{l:'Escola',k:'escola',i:1,t:'cat'},{l:'Turma',k:'turma',i:2,t:'cat'},{l:'Ano escolar',k:'ano_escolar',i:3,t:'cat'},{l:'Meu aluno',k:'meu_aluno',i:4,t:SX_BIN},{l:'Status da avaliação',k:'status',i:5,t:'cat'},{l:'Risco',k:'risco',i:6,t:'ord',o:PSE_RISK,only:'quem foi avaliado'},{l:'Risco alto',k:'risco_alto',i:7,t:SX_BIN,only:'quem foi avaliado'},{l:'Lesões cariosas cavitadas',k:'lesoes_cavitadas',i:8,t:'ord',o:PSE_LESOES,only:'quem foi avaliado'},{l:'Tem lesão cavitada',k:'tem_lesao',i:9,t:SX_BIN,only:'quem foi avaliado'},{l:'Necessidade de exodontia',k:'necessidade_exodontia',i:10,t:'ord',o:PSE_EXO,only:'quem foi avaliado'},{l:'Precisa de exodontia',k:'precisa_exodontia',i:11,t:SX_BIN,only:'quem foi avaliado'},{l:'Dor',k:'dor',i:12,t:SX_BIN,only:'quem foi avaliado'},{l:'Problemas periodontais',k:'periodontal',i:13,t:SX_BIN,only:'quem foi avaliado'},{l:'PcD',k:'pcd',i:14,t:SX_BIN},{l:'Indicação de ART',k:'indicacao_art',i:15,t:SX_BIN,only:'quem foi avaliado'},{l:'Encaminhada à UBS',k:'encaminhada',i:16,t:SX_BIN,only:'quem foi avaliado'},{l:'Flúor aplicado',k:'fluor',i:17,t:SX_BIN,only:'quem foi avaliado'},{l:'Já era paciente antes da avaliação',k:'paciente_antes',i:18,t:SX_BIN,only:'quem tem prontuário ligado'},{l:'Atendida na UBS depois da avaliação',k:'atendida_depois',i:19,t:SX_BIN,only:'quem tem prontuário ligado'},{l:'Avaliação alterada na escovação',k:'alterada_escovacao',i:20,t:SX_BIN,only:'quem está ligado à atividade coletiva'},{l:'Idade (anos)',k:'idade',i:21,t:'num'},{l:'Dentes para ART',k:'dentes_art',i:22,t:'num'},{l:'Dentes de ART feitos',k:'dentes_art_feitos',i:23,t:'num'},{l:'Dias até o 1º atendimento na UBS',k:'dias_ate_atendimento',i:24,t:'num',only:'quem foi atendida depois'},{l:'Registros de contato',k:'contatos',i:25,t:'num',only:'meus alunos'},{l:'Cruzamento com o CELK',k:'cruzamento',i:26,t:'cat'}]}};
const SX_TESTS={
  chi:{l:'Duas características estão relacionadas?',s:'Qui-quadrado (ou Fisher)',f:[['a','Característica 1',['cat','ord',SX_BIN]],['b','Característica 2',['cat','ord',SX_BIN]]]},
  ic:{l:'Qual a porcentagem, com margem de erro?',s:'Intervalo de confiança 95%',f:[['a','Porcentagem de',[SX_BIN]],['b','Separar por (opcional)',['cat','ord',SX_BIN],true]]},
  p2:{l:'Dois grupos têm porcentagens diferentes?',s:'Comparação de duas proporções',f:[['a','Porcentagem de',[SX_BIN]],['b','Comparar grupos de',['cat','ord',SX_BIN]]],pick:true},
  tr:{l:'A porcentagem sobe ou desce com a ordem?',s:'Qui-quadrado de tendência',f:[['a','Porcentagem de',[SX_BIN]],['b','Em ordem de',['ord']]]},
  gr:{l:'Um número é diferente entre grupos?',s:'Mann-Whitney ou Kruskal-Wallis',f:[['a','Número',['num']],['b','Entre grupos de',['cat','ord',SX_BIN]]]},
  co:{l:'Dois números andam juntos?',s:'Correlação de Spearman',f:[['a','Número 1',['num']],['b','Número 2',['num']]]},
  lr:{l:'O que explica um resultado, considerando vários fatores juntos?',s:'Regressão logística',f:[['a','Resultado (Sim/Não)',[SX_BIN]]],multi:true}};
const SX_SUGG={pat:[['lr',7,null,'O que explica concluir o tratamento?'],['ic',8,null,'Quantos concluem no mesmo dia da 1ª consulta?'],['chi',8,1,'Concluiu no mesmo dia × faixa etária'],['p2',8,10,'Concluiu no mesmo dia: com e sem urgência'],['tr',13,1,'Exodontia sobe com a idade?'],['chi',10,7,'Urgência × concluiu tratamento'],['gr',20,2,'Dias até concluir, por dentista'],['ic',16,1,'Voltou no quadrimestre seguinte, por faixa etária'],['lr',13,null,'O que explica ter exodontia?']],
  ges:[['chi',3,10,'7 consultas × consulta odontológica'],['chi',2,10,'Captação precoce × consulta odontológica'],['ic',10,0,'Consulta odontológica por equipe'],['tr',10,1,'Odonto sobe com o período da gestação?'],['lr',10,null,'O que explica a consulta odontológica?']],
  kids:[['chi',0,5,'Sexo × avaliação alterada'],['ic',5,2,'Avaliação alterada por turma'],['tr',5,1,'Avaliação alterada sobe com a idade?']],
  pse:[['ic',9,2,'Lesão cavitada por turma'],['chi',9,12,'Lesão cavitada × dor'],['gr',21,8,'Idade por nº de lesões cavitadas'],['ic',7,1,'Risco alto por escola'],['lr',11,null,'O que explica precisar de exodontia?'],['p2',19,12,'Atendida depois: com e sem dor']]};
const SX_DEFP={pat:{chi:[1,7],ic:[7,1],p2:[11,2],tr:[13,1],gr:[18,2],co:[17,18],lr:[7]},ges:{chi:[3,10],ic:[10,0],p2:[10,0],tr:[10,1],gr:[0,0],co:[0,0],lr:[10]},kids:{chi:[0,5],ic:[5,2],p2:[5,0],tr:[5,1],gr:[6,0],co:[6,6],lr:[5]},pse:{chi:[9,12],ic:[7,2],p2:[19,12],tr:[9,3],gr:[22,6],co:[21,22],lr:[11]}};
const SX_DEFX={pat:[1,0,2,10],ges:[0,1,2,3],kids:[0,1,2],pse:[21,12,14]};
let sxSt={base:'pat',test:'chi',a:1,b:7,g1:null,g2:null,proc:{},merge:{},mergeOpen:null,mergeSel:[],fv:null,fval:null,xs:SX_DEFX.pat.slice()};
function sxBaseData(base,per=procPeriod()){if(base==='ges')return sxMonitoraRows();if(base==='pse')return pseStatRows(per.months);if(base==='kids')return sxKidRows(per.months);return sxPatientRows(per.months)}
function sxProcList(rows){return [...new Set(rows.flatMap(r=>r[22]||[]))].sort((a,b)=>a.localeCompare(b,'pt-BR'))}
function sxPickProc(key,rows){const list=sxProcList(rows);if(!list.includes(sxSt.proc[key]))sxSt.proc[key]=list.find(p=>/^EXODONTIA DE DENTE PERMANENTE/.test(norm(p)))||list[0]||'';return sxSt.proc[key]}
function sxVname(v,key){return v.custom?`Teve: ${String(sxSt.proc[key]||'procedimento').toLowerCase()}`:v.l}
function sxMergeMap(vi){return sxSt.merge[`${sxSt.base}:${vi}`]||[]}
function sxVal(r,vi,key){const v=SX_BASES[sxSt.base].vars[vi];let x=v.custom?((r[v.i]||[]).includes(sxSt.proc[key])?'Sim':'Não'):r[v.i];if(x==null||x==='')return null;if(v.t!=='num'){for(const g of sxMergeMap(vi))if(g.includes(x))return g.join(' + ')}return x}
function sxLevels(vi,rows,key){const v=SX_BASES[sxSt.base].vars[vi],seen=[...new Set(rows.map(r=>sxVal(r,vi,key)))].filter(x=>x!=null);if(v.t===SX_BIN&&!sxMergeMap(vi).length)return ['Sim','Não'].filter(x=>seen.includes(x));const ord=v.o||[];const k2=x=>{const i=ord.indexOf(String(x).split(' + ')[0]);return i<0?999:i};return seen.sort((a,b)=>k2(a)-k2(b)||String(a).localeCompare(String(b),'pt-BR',{numeric:true}))}
const sxStrength=v=>v<0.1?'desprezível':v<0.3?'fraca':v<0.5?'moderada':'forte';
function sxRows(all){let rows=all;if(sxSt.fv!=null&&sxSt.fval!=null)rows=rows.filter(r=>String(sxVal(r,sxSt.fv,'f'))===sxSt.fval);return rows}
const SX_HOW_P='<b>Valor de p</b>: abaixo de 0,05, a diferença é maior do que o acaso explicaria. Acima de 0,05, os dados não mostram diferença, o que não prova que ela não exista.';
function sxForest(rowsF,total){return `<div class="sx-axis"><span>0%</span><span>25%</span><span>50%</span><span>75%</span><span>100%</span></div><div class="sx-forest">${rowsF.map(r=>`<div class="sx-frow"><span class="sx-lab" title="${esc(r.l)}">${esc(r.l)}</span><div class="sx-track">${total!=null?`<span class="sx-tot" style="left:${100*total}%"></span>`:''}<span class="sx-ci" style="left:${100*r.lo}%;width:${100*(r.hi-r.lo)}%"></span><span class="sx-pt" style="left:${100*r.p}%"></span></div><span class="sx-val"><b>${sxPc(r.p)}</b> · ${r.k} de ${r.n}<br>IC ${sxF(100*r.lo,0)}% a ${sxF(100*r.hi,0)}%</span></div>`).join('')}</div>${total!=null?'<p class="sx-note">Linha tracejada: todos juntos.</p>':''}`}
const sxGroupTable=g=>[['Grupo','Sim','Total','%','IC 95% inferior','IC 95% superior'],...g.map(x=>[x.l,x.k,x.n,sxF(100*x.p,1),sxF(100*x.lo,1),sxF(100*x.hi,1)])];
function sxDesign(rows,xs){const cols=[],terms=[];for(const vi of xs){const v=SX_BASES[sxSt.base].vars[vi];if(v.t==='num'){const sc=v.per10?10:1;terms.push({vi,name:v.l,num:true,sc,cols:[cols.length]});cols.push(r=>Number(sxVal(r,vi,'x'+vi))/sc)}else{const lv=sxLevels(vi,rows,'x'+vi);if(lv.length<2)continue;const ref=v.t===SX_BIN&&lv.includes('Não')?'Não':lv[0],others=lv.filter(x=>x!==ref);terms.push({vi,name:sxVname(v,'x'+vi),ref,levels:others,cols:others.map((_,i)=>cols.length+i)});for(const o of others)cols.push(r=>sxVal(r,vi,'x'+vi)===o?1:0)}}return {cols,terms}}
function sxRunLR(rows,A,title){const xs=sxSt.xs.filter(vi=>vi!==sxSt.a);if(!xs.length)return {title,stop:['Escolha pelo menos um fator','Marque os fatores que podem explicar o resultado.']};
  const ok=rows.filter(r=>sxVal(r,sxSt.a,'a')!=null&&xs.every(vi=>sxVal(r,vi,'x'+vi)!=null)),lost=rows.length-ok.length;if(ok.length<30)return {title,n:ok.length,stop:['Dados insuficientes para a regressão',`Só ${ok.length} pessoa(s) com todos os dados. A regressão precisa de pelo menos 30, e bem mais para vários fatores.`]};
  const {cols,terms}=sxDesign(ok,xs);if(!terms.length)return {title,n:ok.length,stop:['Não há o que comparar','Os fatores escolhidos têm uma categoria só neste período ou subgrupo.']};
  const X=ok.map(r=>[1,...cols.map(c=>c(r))]),y=ok.map(r=>sxVal(r,sxSt.a,'a')==='Sim'?1:0),ev=y.reduce((a,b)=>a+b,0),ne=y.length-ev,k=cols.length,epv=Math.min(ev,ne)/k;
  if(!ev||!ne)return {title,n:ok.length,stop:['Não há o que explicar',`Todos têm "${ev?'Sim':'Não'}" em ${esc(sxVname(A,'a').toLowerCase())}.`]};
  const m=sxLogit(X,y);if(!m)return {title,n:ok.length,stop:['O modelo não pôde ser calculado','Algum fator repete a informação de outro. Tire um fator ou junte categorias.']};
  const p0=ev/y.length,ll0=y.reduce((a,v)=>a+(v?Math.log(p0):Math.log(1-p0)),0),lr=2*(m.ll-ll0),pm=sxChi2p(lr,k),r2=1-m.ll/ll0,sep=m.b.slice(1).some((b,j)=>Math.abs(b)>8||m.se[j+1]>20);
  // "Sozinho": o mesmo modelo com um fator de cada vez.
  const crude={};for(const t of terms){const d=sxDesign(ok,[t.vi]),mm=sxLogit(ok.map(r=>[1,...d.cols.map(c=>c(r))]),y);if(mm)d.terms[0].cols.forEach((c,i)=>{crude[`${t.vi}|${i}`]=[mm.b[c+1],mm.se[c+1]]})}
  const rowsT=[],sigList=[];for(const t of terms){rowsT.push({grp:t.name});if(!t.num)rowsT.push({ref:true,l:`${t.ref} (referência)`});(t.num?[null]:t.levels).forEach((lev,i)=>{const c=t.cols[i]+1,b=m.b[c],se=m.se[c],or=Math.exp(b),lo=Math.exp(b-1.96*se),hi=Math.exp(b+1.96*se),p=sxNormp(b/se),cr=crude[`${t.vi}|${i}`];const lab=t.num?(t.sc===10?'a cada 10 anos':'a cada 1 a mais'):lev;rowsT.push({l:lab,f:t.name,num:t.num,or,lo,hi,p,cor:cr?Math.exp(cr[0]):null,cp:cr?sxNormp(cr[0]/cr[1]):null});if(p<0.05)sigList.push({t,lab,or,lo,hi})})}
  const out2=sxVname(A,'a').toLowerCase(),phr=s=>`<b>${esc(s.t.name)}${s.t.num?` (${s.lab})`:`: ${esc(s.lab)}`}</b> ${s.or>=1?`tem ${sxF(s.or,1)} vez${s.or>=1.95?'es':''} a chance`:`tem ${sxF(s.or,2)} vez a chance (${sxF(100*(1-s.or),0)}% menos)`}`;
  const pos=v=>{const lg=Math.log10(Math.min(20,Math.max(0.05,v)));return 50+50*lg/Math.log10(20)},col=r=>r.p<0.05?(r.or>1?'var(--sx-pos)':'var(--sx-neg)'):'var(--sx-faint)';
  const table=`<div class="sx-tw"><table class="sx-lr"><thead><tr><th>Fator</th><th>Ajustado (todos juntos)</th><th></th><th>IC 95%</th><th>p</th><th>Sozinho</th></tr></thead><tbody>${rowsT.map(r=>r.grp?`<tr class="grp"><td colspan="6">${esc(r.grp)}</td></tr>`:r.ref?`<tr class="ref"><td>${esc(r.l)}</td><td>1</td><td></td><td></td><td></td><td>1</td></tr>`:`<tr><td>${esc(r.l)}</td><td class="${r.p<0.05?(r.or>1?'sig':'sigd'):''}">${sxF(r.or,2)}</td><td style="width:34%"><div class="sx-orplot"><span class="one"></span><span class="ci" style="left:${pos(r.lo)}%;width:${Math.max(.5,pos(r.hi)-pos(r.lo))}%;background:${col(r)}"></span><span class="pt" style="left:${pos(r.or)}%;background:${col(r)}"></span></div></td><td>${sxF(r.lo,2)}–${sxF(r.hi,2)}</td><td>${sxP(r.p)}</td><td style="color:var(--muted)">${r.cor!=null?`${sxF(r.cor,2)}${r.cp<0.05?'*':''}`:'—'}</td></tr>`).join('')}</tbody></table></div><div class="sx-legend"><span>Razão de chances (OR): 1 = sem efeito; acima de 1 = mais chance; abaixo de 1 = menos chance</span><span>eixo em escala log de 0,05 a 20</span><span>* p &lt; 0,05 quando o fator é analisado sozinho</span></div>`;
  const changed=rowsT.filter(r=>r.cor!=null&&r.cp<0.05&&r.p>=0.05),chTxt=changed.map(r=>esc(r.num?`${r.f} (${r.l})`:`${r.f}: ${r.l}`)).join(', ');
  const warn=[epv<10?`<b>Poucos casos para tantos fatores</b>: ${Math.min(ev,ne)} pessoas no grupo menor (${ev} "Sim", ${ne} "Não") para ${k} coeficientes (${sxF(epv,1)} por coeficiente; o recomendado é 10 ou mais). Tire fatores ou junte categorias.`:'',sep?'<b>Alguma categoria tem quase todo mundo com o mesmo resultado</b>: o valor dela fica instável (intervalo enorme). Junte essa categoria com outra.':'',lost?`${lost} pessoa(s) ficaram de fora por não terem algum dos dados${A.only?` (o resultado só vale para ${A.only})`:''}.`:''].filter(Boolean).join('<br>');
  return {title,n:ok.length,sig:pm<0.05&&sigList.length?true:pm<0.05?null:false,
    verdict:sigList.length?`<b>Considerando os fatores juntos, o que muda a chance de ${esc(out2)}:</b><p>${sigList.map(phr).join('; ')}, comparado à referência.${changed.length?` <br>Sozinho parecia fazer diferença, mas deixa de fazer quando os outros fatores entram: <b>${chTxt}</b> (efeito explicado pelos outros fatores).`:''}</p>`:`<b>Nenhum fator muda a chance de ${esc(out2)} de forma significativa</b><p>Considerando os fatores juntos, nenhum tem efeito maior do que o acaso explicaria${changed.length?`, embora ${chTxt} ${changed.length>1?'parecessem':'parecesse'} fazer diferença ${changed.length>1?'sozinhos':'sozinho'}`:''}.</p>`,
    stats:[['Regressão logística',`${terms.length} fator(es)`],[`${ev} de ${y.length}`,`com "Sim" (${sxPc(ev/y.length)})`],[sxP(pm),'modelo × acaso (p)'],[sxF(r2,2),'R² de McFadden'],[sxF(epv,1),'casos por coeficiente']],warn,viz:table,
    table:[['Fator','Categoria','OR ajustado','IC 95% inferior','IC 95% superior','p','OR sozinho','p sozinho'],...rowsT.filter(r=>!r.grp).map((r,i,arr)=>r.ref?null:[r.f,r.l,sxF(r.or,3),sxF(r.lo,3),sxF(r.hi,3),sxF(r.p,4),r.cor!=null?sxF(r.cor,3):'',r.cp!=null?sxF(r.cp,4):'']).filter(Boolean)],
    how:['<b>Razão de chances (OR)</b>: compara com a categoria de referência. OR 2 = o dobro da chance; OR 0,5 = metade.','<b>Ajustado</b>: efeito de cada fator com os outros fixos. É o que separa, por exemplo, "o dentista" de "o tipo de paciente que ele atende".','<b>Sozinho</b>: o mesmo fator sem os outros. Quando o efeito some no ajustado, ele era explicado pelos outros fatores.','<b>IC 95%</b>: se não cruza o 1, o efeito é significativo (p &lt; 0,05).','<b>R² de McFadden</b>: quanto o modelo explica. De 0,2 a 0,4 já é considerado bom; valores baixos são comuns em saúde.','<b>Casos por coeficiente</b>: pessoas no grupo menor (Sim ou Não) dividido pelo número de coeficientes. Abaixo de 10, o modelo fica instável.']}}
// Roda o teste escolhido e devolve o resultado (sem mexer na tela).
function sxRun(all,per){
  const st=sxSt,base=SX_BASES[st.base];for(const k of ['a','b'])if(st[k]!=null&&base.vars[st[k]]?.custom)sxPickProc(k,all);
  const rows=sxRows(all),A=base.vars[st.a],B=st.b!=null?base.vars[st.b]:null;
  const nA=sxVname(A,'a'),nB=B?sxVname(B,'b'):'';const title=st.test==='lr'?`O que explica: ${nA.toLowerCase()}`:st.test==='ic'&&!B?nA:`${nA} × ${nB.toLowerCase()}`;
  if(!rows.length)return {title,n:0,stop:['Sem dados neste período',`Não há ${base.label.toLowerCase()} em ${esc(per.label)}${st.fv!=null?' com esse subgrupo':''}. Escolha outro período ou importe os relatórios.`]};
  if(rows.length<20)return {title,n:rows.length,stop:['Dados insuficientes para o teste',`Só ${rows.length} pessoa(s). Com menos de 20 o resultado não é confiável. Escolha um período maior ou tire o filtro de subgrupo.`]};
  if(st.test==='lr')return sxRunLR(rows,A,title);
  const r2=rows.filter(r=>sxVal(r,st.a,'a')!=null&&(!B||sxVal(r,st.b,'b')!=null)),lost=rows.length-r2.length,lostTxt=lost?`${lost} pessoa(s) ficaram de fora porque a variável não se aplica a elas${A.only?` (${esc(nA.toLowerCase())}: só ${A.only})`:B&&B.only?` (${esc(nB.toLowerCase())}: só ${B.only})`:''}.`:'';
  if(r2.length<20)return {title,n:r2.length,stop:['Dados insuficientes para o teste',`Só ${r2.length} pessoa(s) com os dois dados. ${lostTxt}`]};
  if(B&&st.a===st.b&&!(A.custom&&st.proc.a!==st.proc.b))return {title,stop:['Escolha duas variáveis diferentes','O teste compara duas coisas diferentes.']};
  const lv=(vi,key)=>sxLevels(vi,r2,key),one=(vi,key,name)=>{const l=lv(vi,key);return l.length<2?{title,n:r2.length,stop:['Não há o que comparar',`Todas as pessoas têm o mesmo valor em "${esc(name.toLowerCase())}" (${esc(l[0]??'—')}).`]}:null};
  const W=m=>[lostTxt,m].filter(Boolean).join('<br>');let o;
  if(st.test==='chi'){if((o=one(st.a,'a',nA)||one(st.b,'b',nB)))return o;const ra=lv(st.a,'a'),cb=lv(st.b,'b'),O=ra.map(()=>cb.map(()=>0));for(const r of r2)O[ra.indexOf(sxVal(r,st.a,'a'))][cb.indexOf(sxVal(r,st.b,'b'))]++;
    const n=r2.length,R=O.map(x=>x.reduce((a,b)=>a+b,0)),C=cb.map((_,j)=>O.reduce((a,x)=>a+x[j],0)),E=O.map((x,i)=>x.map((_,j)=>R[i]*C[j]/n));let chi=0;O.forEach((x,i)=>x.forEach((ov,j)=>{chi+=(ov-E[i][j])**2/E[i][j]}));
    const df=(ra.length-1)*(cb.length-1),low=E.flat().filter(e=>e<5).length,useF=df===1&&low>0,p=useF?sxFisher(O[0][0],O[0][1],O[1][0],O[1][1]):sxChi2p(chi,df),V=Math.sqrt(chi/(n*(Math.min(ra.length,cb.length)-1))),sig=p<0.05;
    const adj=O.map((x,i)=>x.map((ov,j)=>{const e=E[i][j],d=Math.sqrt(e*(1-R[i]/n)*(1-C[j]/n));return d>0?(ov-e)/d:0}));let top=null,best=0;adj.forEach((x,i)=>x.forEach((z,j)=>{if(z>best){best=z;top=[i,j]}}));
    const cell=(i,j)=>{const z=adj[i][j],s=Math.abs(z)>=1.96,c=z>0?'var(--sx-pos)':'var(--sx-neg)';return `<td style="${Math.abs(z)>=1?`background:${z>0?'var(--sx-pos-soft)':'var(--sx-neg-soft)'};`:''}${s?`outline:1.5px solid ${c};`:''}" title="esperado ${sxF(E[i][j],1)} · resíduo ${sxF(z)}"><b style="${s?`color:${c}`:''}">${O[i][j]}</b><small>${sxPc(O[i][j]/R[i])}</small></td>`};
    const bad=(low/E.flat().length>0.2||E.flat().some(e=>e<1))&&!useF;
    return {title,n,sig:bad?null:sig,fisher:useF,verdict:sig?`<b>Há relação entre ${esc(nA.toLowerCase())} e ${esc(nB.toLowerCase())}</b><p>p ${p<0.001?'< 0,001':'= '+sxP(p)} · força ${sxStrength(V)} (V de Cramér ${sxF(V)}).${top?` O que mais pesa: <b>"${esc(ra[top[0]])}"</b> tem mais <b>"${esc(cb[top[1]])}"</b> do que o esperado (${sxPc(O[top[0]][top[1]]/R[top[0]])} contra ${sxPc(C[top[1]]/n)} no total).`:''}</p>`:`<b>Não há evidência de relação</b><p>As diferenças da tabela podem ser acaso (p = ${sxP(p)}).</p>`,
      stats:[[useF?'Fisher':'Qui-quadrado',useF?'teste usado':`χ² = ${sxF(chi)}`],[df,'graus de liberdade'],[sxP(p),'valor de p'],[sxF(V),`V de Cramér · ${sxStrength(V)}`],[n,'pessoas']],
      warn:W(useF?'Tabela 2×2 com valor esperado abaixo de 5: o valor de p é do teste exato de Fisher.':bad?`<b>Dados insuficientes para confiar no resultado.</b> ${low} de ${E.flat().length} células com valor esperado abaixo de 5. Junte categorias, pegue um período maior ou troque de variável.`:''),
      viz:`<div class="sx-tw"><table class="sx-ct"><thead><tr><th class="rowh">${esc(nA)} \\ ${esc(nB)}</th>${cb.map(c=>`<th>${esc(c)}</th>`).join('')}<th>Total</th></tr></thead><tbody>${ra.map((r,i)=>`<tr><td class="rowh">${esc(r)}</td>${cb.map((_,j)=>cell(i,j)).join('')}<td class="tot">${R[i]}</td></tr>`).join('')}</tbody></table></div><div class="sx-legend"><span><i style="background:var(--sx-pos-soft);outline:1px solid var(--sx-pos)"></i>mais que o esperado</span><span><i style="background:var(--sx-neg-soft);outline:1px solid var(--sx-neg)"></i>menos que o esperado</span><span>% = da linha</span></div>`,
      table:[[`${nA} \\ ${nB}`,...cb,'Total'],...ra.map((r,i)=>[r,...O[i],R[i]]),['Total',...C,n]],
      how:[SX_HOW_P,'<b>V de Cramér</b>: força da relação (até 0,1 desprezível; 0,1–0,3 fraca; 0,3–0,5 moderada; acima de 0,5 forte).','<b>Células coloridas</b>: onde está a diferença; borda forte = significativa (resíduo ajustado acima de 1,96).']}}
  if(st.test==='ic'){const yes=r=>sxVal(r,st.a,'a')==='Sim',k=r2.filter(yes).length,[p,lo,hi]=sxWilson(k,r2.length);let groups=[];
    if(B){groups=lv(st.b,'b').map(g=>{const s=r2.filter(r=>sxVal(r,st.b,'b')===g),kk=s.filter(yes).length,[pp,ll,hh]=sxWilson(kk,s.length);return {l:g,k:kk,n:s.length,p:pp,lo:ll,hi:hh}})}
    const small=groups.filter(g=>g.n<10),gAll={l:'Todos',k,n:r2.length,p,lo,hi};
    return {title:B?`${nA} por ${nB.toLowerCase()}`:nA,n:r2.length,sig:null,verdict:`<b>${sxPc(p)}: ${esc(nA.toLowerCase())}</b><p>${k} de ${r2.length} pessoas. Com 95% de confiança, o valor real está entre <b>${sxPc(lo)}</b> e <b>${sxPc(hi)}</b>.${groups.length?' Grupos com intervalos que não se cruzam têm porcentagens diferentes.':''}</p>`,
      stats:[[sxPc(p),'porcentagem'],[`${sxF(100*lo,1)}–${sxF(100*hi,1)}%`,'intervalo de 95%'],[`± ${sxF(100*(hi-lo)/2,1)} p.p.`,'margem de erro'],[k,'com "Sim"'],[r2.length,'pessoas']],
      warn:W(small.length?`<b>Margem grande em ${small.map(g=>esc(g.l)).join(', ')}</b>: menos de 10 pessoas no grupo.`:''),viz:sxForest(groups.length?groups:[gAll],groups.length?p:null),table:sxGroupTable([...groups,gAll]),
      how:['<b>Intervalo de 95%</b> (Wilson): a faixa onde o valor real provavelmente está. Quanto menos pessoas, mais largo.','<b>Margem de erro</b>: metade do intervalo, em pontos percentuais.','Intervalos que não se cruzam indicam diferença; para testar, use "Dois grupos têm porcentagens diferentes?".']}}
  if(st.test==='p2'){if((o=one(st.b,'b',nB)))return o;const l=lv(st.b,'b');if(st.g1==null||!l.includes(st.g1))st.g1=l[0];if(st.g2==null||!l.includes(st.g2)||st.g2===st.g1)st.g2=l.find(x=>x!==st.g1);
    const grp=g=>{const s=r2.filter(r=>sxVal(r,st.b,'b')===g),k=s.filter(r=>sxVal(r,st.a,'a')==='Sim').length,[p,lo,hi]=sxWilson(k,s.length);return {l:g,k,n:s.length,p,lo,hi}},x=grp(st.g1),y=grp(st.g2);
    if(x.n<5||y.n<5)return {title,n:r2.length,pick:l,stop:['Dados insuficientes para comparar',`Um dos grupos tem menos de 5 pessoas (${esc(x.l)}: ${x.n}; ${esc(y.l)}: ${y.n}).`]};
    const pp=(x.k+y.k)/(x.n+y.n),se0=Math.sqrt(pp*(1-pp)*(1/x.n+1/y.n)),z=se0?(x.p-y.p)/se0:0,diff=x.p-y.p,se=Math.sqrt(x.p*(1-x.p)/x.n+y.p*(1-y.p)/y.n),low=[x.k,x.n-x.k,y.k,y.n-y.k].some(v=>v<5),p=low?sxFisher(x.k,x.n-x.k,y.k,y.n-y.k):sxNormp(z),sig=p<0.05;
    return {title:`${nA}: ${st.g1} × ${st.g2}`,n:x.n+y.n,pick:l,sig,fisher:low,verdict:sig?`<b>${esc(x.l)} e ${esc(y.l)} têm porcentagens diferentes</b><p>${sxPc(x.p)} contra ${sxPc(y.p)}: diferença de <b>${sxF(100*Math.abs(diff),1)} pontos percentuais</b>, p ${p<0.001?'< 0,001':'= '+sxP(p)}.</p>`:`<b>Não há evidência de diferença</b><p>${sxPc(x.p)} contra ${sxPc(y.p)} (p = ${sxP(p)}).</p>`,
      stats:[[low?'Fisher':'Teste z',low?'grupo pequeno':`z = ${sxF(z)}`],[`${sxF(100*diff,1)} p.p.`,'diferença'],[`${sxF(100*(diff-1.96*se),1)} a ${sxF(100*(diff+1.96*se),1)}`,'IC 95% (p.p.)'],[sxP(p),'valor de p'],[x.n+y.n,'pessoas']],
      warn:W(low?'Menos de 5 casos em algum grupo: o valor de p é do teste exato de Fisher.':''),viz:sxForest([x,y],null),table:sxGroupTable([x,y]),how:[SX_HOW_P,'<b>Pontos percentuais</b>: 38% contra 23% são 15 p.p.','Se o IC da diferença não inclui o zero, ela é significativa.']}}
  if(st.test==='tr'){if((o=one(st.b,'b',nB)))return o;const tv=base.vars[st.b],tl=lv(st.b,'b').filter(l=>!tv.trend||tv.trend.includes(l)),trOut=tv.trend?r2.filter(r=>{const x=sxVal(r,st.b,'b');return x!=null&&!tv.trend.includes(x)}).length:0;
    st._lastTrend=tl;const g=tl.map((lev,i)=>{const s=r2.filter(r=>sxVal(r,st.b,'b')===lev),k=s.filter(r=>sxVal(r,st.a,'a')==='Sim').length,[p,lo,hi]=sxWilson(k,s.length);return {l:lev,k,n:s.length,t:i+1,p,lo,hi}});
    if(g.length<2)return {title,n:r2.length,stop:['Não há o que comparar','A tendência precisa de pelo menos 2 níveis em ordem.']};
    const N=g.reduce((a,x)=>a+x.n,0),Rr=g.reduce((a,x)=>a+x.k,0),pb=Rr/N,Tt=g.reduce((a,x)=>a+x.t*(x.k-x.n*pb),0),V=pb*(1-pb)*(g.reduce((a,x)=>a+x.n*x.t*x.t,0)-g.reduce((a,x)=>a+x.n*x.t,0)**2/N),z=V>0?Tt/Math.sqrt(V):0,p=sxNormp(z),sig=p<0.05,small=g.filter(x=>x.n<10),outTxt=trOut?` ${trOut} pessoa(s) fora de ${tv.trend.join('/')} não entram na tendência.`:'';
    return {title:`${nA} por ${nB.toLowerCase()}`,n:N,sig,trendLevels:tl,verdict:sig?`<b>A porcentagem ${z>0?'sobe':'desce'} conforme ${esc(nB.toLowerCase())}</b><p>De ${sxPc(g[0].p)} em "${esc(g[0].l)}" para ${sxPc(g.at(-1).p)} em "${esc(g.at(-1).l)}" (p ${p<0.001?'< 0,001':'= '+sxP(p)}).${outTxt}</p>`:`<b>Não há tendência clara</b><p>A porcentagem não sobe nem desce de forma consistente (p = ${sxP(p)}).${outTxt}</p>`,
      stats:[['Tendência','Cochran-Armitage'],[`z = ${sxF(z)}`,z>0?'sobe':'desce'],[sxP(p),'valor de p'],[g.length,'níveis em ordem'],[N,'pessoas']],warn:W(small.length?`Poucas pessoas em ${small.map(x=>esc(x.l)).join(', ')}.`:''),viz:sxForest(g,pb),table:sxGroupTable(g),how:[SX_HOW_P,'<b>Tendência</b>: testa se a porcentagem sobe ou desce seguindo a ordem (idade, mês, trimestre).']}}
  if(st.test==='gr'){if((o=one(st.b,'b',nB)))return o;const g=lv(st.b,'b').map(lev=>({l:lev,v:r2.filter(r=>sxVal(r,st.b,'b')===lev).map(r=>Number(sxVal(r,st.a,'a')))})).filter(x=>x.v.length);const all=g.flatMap(x=>x.v),N=all.length,{r,ties}=sxRanks(all);let off=0;for(const x of g){x.r=r.slice(off,off+x.v.length);off+=x.v.length;x.med=sxQuant(x.v,.5);x.q1=sxQuant(x.v,.25);x.q3=sxQuant(x.v,.75);x.min=Math.min(...x.v);x.max=Math.max(...x.v);x.mean=x.v.reduce((a,b)=>a+b,0)/x.v.length;x.mr=x.r.reduce((a,b)=>a+b,0)/x.v.length}
    if(new Set(all).size<2)return {title,n:N,stop:['Não há o que comparar','Todos têm o mesmo valor.']};let p,stat,name,eff;
    if(g.length===2){const [x,y]=g,n1=x.v.length,n2=y.v.length,R1=x.r.reduce((a,b)=>a+b,0),U=R1-n1*(n1+1)/2,mu=n1*n2/2,sd=Math.sqrt(n1*n2/12*((N+1)-ties/(N*(N-1)))),z=sd?(U-mu-Math.sign(U-mu)*.5)/sd:0;p=sxNormp(z);stat=`U = ${sxF(U,0)}`;name='Mann-Whitney';eff=`r = ${sxF(Math.abs(z)/Math.sqrt(N))}`}
    else{const H=(12/(N*(N+1))*g.reduce((a,x)=>a+x.r.reduce((s,b)=>s+b,0)**2/x.v.length,0)-3*(N+1))/(1-ties/(N**3-N));p=sxChi2p(H,g.length-1);stat=`H = ${sxF(H)}`;name='Kruskal-Wallis';eff=`ε² = ${sxF(Math.max(0,H/(N-1)))}`}
    const sig=p<0.05,mx=Math.max(...all)||1,hi=[...g].sort((a,b)=>b.mr-a.mr),dec=Number.isInteger(mx)&&mx>20?0:1;
    return {title:`${nA} por ${nB.toLowerCase()}`,n:N,sig,groups:g.length,verdict:sig?`<b>${esc(nA)} é diferente entre os grupos</b><p>Mais alto em <b>${esc(hi[0].l)}</b> (média ${sxF(hi[0].mean,1)}, mediana ${sxF(hi[0].med,dec)}) e mais baixo em <b>${esc(hi.at(-1).l)}</b> (média ${sxF(hi.at(-1).mean,1)}, mediana ${sxF(hi.at(-1).med,dec)}); p ${p<0.001?'< 0,001':'= '+sxP(p)}.</p>`:`<b>Não há evidência de diferença</b><p>p = ${sxP(p)}.</p>`,
      stats:[[name,`${g.length} grupos`],[stat,'estatística'],[sxP(p),'valor de p'],[eff,'tamanho do efeito'],[N,'pessoas']],warn:W(g.some(x=>x.v.length<5)?'Menos de 5 pessoas em algum grupo.':''),
      viz:`<div class="sx-forest">${g.map(x=>`<div class="sx-frow"><span class="sx-lab">${esc(x.l)}</span><div class="sx-bplot"><span class="wh" style="left:${100*x.min/mx}%;width:${100*(x.max-x.min)/mx}%"></span><span class="bx" style="left:${100*x.q1/mx}%;width:${Math.max(.8,100*(x.q3-x.q1)/mx)}%"></span><span class="md" style="left:${100*x.med/mx}%"></span></div><span class="sx-val">mediana <b>${sxF(x.med,dec)}</b> · média ${sxF(x.mean,1)} · n ${x.v.length}<br>metade do meio: ${sxF(x.q1,dec)} a ${sxF(x.q3,dec)}</span></div>`).join('')}</div><div class="sx-axis"><span>0</span><span>${sxF(mx/2,0)}</span><span>${sxF(mx,0)}</span></div>`,
      table:[['Grupo','Pessoas','Mediana','1º quartil','3º quartil','Média','Mínimo','Máximo'],...g.map(x=>[x.l,x.v.length,sxF(x.med,1),sxF(x.q1,1),sxF(x.q3,1),sxF(x.mean,2),x.min,x.max])],
      how:[SX_HOW_P,'<b>Mediana</b>: o valor do meio, mais adequado que a média quando a maioria tem valores pequenos e poucos têm valores altos.','<b>Mann-Whitney</b> (2 grupos) e <b>Kruskal-Wallis</b> (3 ou mais) não exigem curva normal.']}}
  if(st.test==='co'){const pts=r2.map(r=>[Number(sxVal(r,st.a,'a')),Number(sxVal(r,st.b,'b'))]),n=pts.length;
    if(new Set(pts.map(p=>p[0])).size<2||new Set(pts.map(p=>p[1])).size<2)return {title,n,stop:['Não há o que comparar','Um dos números é igual para todos.']};
    const rx=sxRanks(pts.map(p=>p[0])).r,ry=sxRanks(pts.map(p=>p[1])).r,mx=rx.reduce((a,b)=>a+b)/n,my=ry.reduce((a,b)=>a+b)/n;let sxy=0,sxx=0,syy=0;for(let i=0;i<n;i++){sxy+=(rx[i]-mx)*(ry[i]-my);sxx+=(rx[i]-mx)**2;syy+=(ry[i]-my)**2}
    const rho=sxy/Math.sqrt(sxx*syy),t=rho*Math.sqrt((n-2)/Math.max(1e-12,1-rho*rho)),p=sxTp(Math.abs(t),n-2),sig=p<0.05,ar=Math.abs(rho),fo=ar<0.1?'desprezível':ar<0.3?'fraca':ar<0.5?'moderada':'forte';
    const X=pts.map(p=>p[0]),Y=pts.map(p=>p[1]),x0=Math.min(...X),x1=Math.max(...X),y0=Math.min(...Y),y1=Math.max(...Y),Wd=600,Hh=240,pad=36;let seed=7;const rnd=()=>((seed=seed*16807%2147483647)/2147483647-.5);const sx=v=>pad+(Wd-pad-10)*(v-x0)/Math.max(1,x1-x0),sy=v=>Hh-pad-(Hh-pad-10)*(v-y0)/Math.max(1,y1-y0);
    const svg=`<svg class="sx-scatter" viewBox="0 0 ${Wd} ${Hh}" role="img" aria-label="Dispersão"><line x1="${pad}" y1="${Hh-pad}" x2="${Wd-10}" y2="${Hh-pad}" stroke="var(--border)"/><line x1="${pad}" y1="10" x2="${pad}" y2="${Hh-pad}" stroke="var(--border)"/>${pts.map(([a,b])=>`<circle cx="${(sx(a)+rnd()*6).toFixed(1)}" cy="${(sy(b)+rnd()*6).toFixed(1)}" r="3" fill="var(--primary)" fill-opacity=".3"/>`).join('')}<text x="${pad}" y="${Hh-pad+16}" font-size="11" fill="var(--muted)">${x0}</text><text x="${Wd-10}" y="${Hh-pad+16}" font-size="11" fill="var(--muted)" text-anchor="end">${x1}</text><text x="${(Wd+pad)/2}" y="${Hh-6}" font-size="11.5" fill="var(--text)" text-anchor="middle">${esc(nA)}</text><text x="${pad-6}" y="${Hh-pad}" font-size="11" fill="var(--muted)" text-anchor="end">${y0}</text><text x="${pad-6}" y="16" font-size="11" fill="var(--muted)" text-anchor="end">${y1}</text><text x="12" y="${Hh/2}" font-size="11.5" fill="var(--text)" transform="rotate(-90 12 ${Hh/2})" text-anchor="middle">${esc(nB)}</text></svg>`;
    return {title,n,sig,verdict:sig?`<b>${esc(nA)} e ${esc(nB.toLowerCase())} andam juntos</b><p>Relação ${fo} e ${rho>0?'positiva':'negativa'}: ρ = ${sxF(rho)}, p ${p<0.001?'< 0,001':'= '+sxP(p)}.</p>`:`<b>Não há evidência de que andem juntos</b><p>ρ = ${sxF(rho)} (p = ${sxP(p)}).</p>`,
      stats:[['Spearman','correlação'],[`ρ = ${sxF(rho)}`,fo],[sxP(p),'valor de p'],[rho>0?'positiva':'negativa','direção'],[n,'pessoas']],warn:W(''),viz:svg,table:[['Medida','Valor'],['rho de Spearman',sxF(rho,4)],['p',sxF(p,4)],['pessoas',n]],how:[SX_HOW_P,'<b>ρ de Spearman</b>: de −1 a +1; até 0,3 é fraca. Usa a ordem dos valores, sem exigir curva normal.']}}
}
function sxSetTest(t){const st=sxSt;st.test=t;const d=SX_DEFP[st.base][t];st.a=d[0];st.b=SX_TESTS[t].f[1]?(d[1]??null):null;st.g1=st.g2=null;if(t==='lr')st.xs=SX_DEFX[st.base].filter(x=>x!==st.a)}
function sxVarField(key,label,types,optional,rows){const st=sxSt,base=SX_BASES[st.base],cur=st[key],v=cur!=null?base.vars[cur]:null;
  const sel=`<select class="sx-sel" data-sx-var="${key}" aria-label="${esc(label)}">${optional?'<option value="-1">— ninguém, todos juntos —</option>':''}${base.vars.map((vv,i)=>types.includes(vv.t)?`<option value="${i}"${i===cur?' selected':''}>${esc(vv.l)}</option>`:'').join('')}</select>`;
  const proc=v&&v.custom?`<select class="sx-sel" data-sx-proc="${key}" aria-label="Procedimento">${sxProcList(rows).map(p=>`<option value="${esc(p)}"${p===sxPickProc(key,rows)?' selected':''}>${esc(p)}</option>`).join('')}</select>`:'';
  let merge='';if(v&&!v.custom&&(v.t==='cat'||v.t==='ord')){const lv=sxLevels(cur,rows,key),groups=sxMergeMap(cur);merge=st.mergeOpen===key?`<div class="sx-mergebox"><span class="sx-note">Escolha 2 ou mais para juntar:</span><div class="sx-chipset">${lv.map(l=>`<button type="button" data-sx-mchip="${esc(l)}" aria-pressed="${st.mergeSel.includes(l)}">${esc(l)}</button>`).join('')}</div><div class="sx-row"><button class="sx-mini" type="button" data-sx-mdo="${key}">Juntar selecionadas</button>${groups.length?`<button class="sx-mini" type="button" data-sx-mundo="${key}">Desfazer tudo</button>`:''}<button class="sx-mini" type="button" data-sx-mclose>Fechar</button></div></div>`:`<button class="sx-mini" type="button" data-sx-mopen="${key}">Juntar categorias${groups.length?` (${groups.length} junção${groups.length>1?'ões':''})`:''}</button>`}
  return `<div class="sx-field"><span>${esc(label)}${v&&v.only?` <small>· só ${esc(v.only)}</small>`:''}</span>${sel}${proc}${merge}</div>`}
function statsHTML(){
  const st=sxSt,per=procPeriod(),seg=(val,label)=>`<button class="pr-sb" data-proc-period="${val}" aria-pressed="${per.mode===val}">${label}</button>`;
  const data=Object.fromEntries(Object.keys(SX_BASES).map(k=>[k,sxBaseData(k,per)]));
  const base=SX_BASES[st.base],all=data[st.base].rows;if(st.fv!=null){const l=sxLevels(st.fv,all,'f');if(!l.includes(st.fval))st.fval=l[0]??null}
  const R=sxRun(all,per),T=SX_TESTS[st.test];
  const subs={pse:`uma linha por criança avaliada no PSE · ${per.label}`,pat:`uma linha por paciente · ${per.label}`,ges:'lista mais recente do Monitora APS (sem data; o período não se aplica)',kids:`uma linha por participação em escovação · ${per.label}`};
  const legacyTxt=Object.entries(data).filter(([,d])=>d.legacy).map(([k])=>({pat:'Procedimentos Detalhado',ges:'Monitora APS',kids:'Relação das Atividades em Grupo',pse:'avaliação do PSE'})[k]);
  const bases=Object.entries(SX_BASES).map(([k,b])=>`<button class="sx-base" type="button" data-sx-base="${k}" aria-pressed="${st.base===k}"><i>${fmtNum(data[k].rows.length)}</i><b>${esc(b.label)}</b><small>${esc(subs[k])}</small></button>`).join('');
  const tests=Object.entries(SX_TESTS).map(([k,t])=>`<button class="sx-test" type="button" data-sx-test="${k}" aria-pressed="${st.test===k}"><b>${esc(t.l)}</b><small>${esc(t.s)}</small></button>`).join('');
  let fields=T.f.map(([key,label,types,optional])=>sxVarField(key,label,types,optional,all)).join('');
  if(T.pick&&R.pick)fields+=`<div class="sx-field"><span>Grupo 1</span><select class="sx-sel" data-sx-g="1">${R.pick.map(x=>`<option${x===st.g1?' selected':''}>${esc(x)}</option>`).join('')}</select></div><div class="sx-field"><span>Grupo 2</span><select class="sx-sel" data-sx-g="2">${R.pick.filter(x=>x!==st.g1).map(x=>`<option${x===st.g2?' selected':''}>${esc(x)}</option>`).join('')}</select></div>`;
  if(T.multi)fields+=`<div class="sx-field"><span>Fatores que podem explicar</span><div class="sx-checks">${base.vars.map((v,i)=>i===st.a||v.custom?'':`<label><input type="checkbox" data-sx-x="${i}" ${st.xs.includes(i)?'checked':''}> ${esc(v.l)}${v.t==='num'?' <small>(número)</small>':''}</label>`).join('')}</div><span class="sx-note">Dica: comece com 2 a 4 fatores. Categorias com poucas pessoas deixam o modelo instável; junte-as acima.</span></div>`;
  const fOpts=base.vars.map((v,i)=>v.t!=='num'&&!v.custom?`<option value="${i}"${st.fv===i?' selected':''}>${esc(v.l)}</option>`:'').join('');
  let fVal='';if(st.fv!=null){const l=sxLevels(st.fv,all,'f');fVal=`<select class="sx-sel" data-sx-fval aria-label="Valor do subgrupo">${l.map(x=>`<option${x===st.fval?' selected':''}>${esc(x)}</option>`).join('')}</select>`}
  const outRange=st.base==='kids'?sxRows(all).filter(r=>r[6]!=null&&(r[6]<6||r[6]>11)).length:0;
  const fl=st.fv!=null&&st.fval!=null?` · só ${base.vars[st.fv].l.toLowerCase()}: ${st.fval}`:'';
  const warn=[R.warn,outRange?`${outRange} participação(ões) fora da faixa de 6 a 11 anos do indicador M3/B4 (entram nesta análise).`:''].filter(Boolean).join('<br>');
  const result=R.stop?`<div class="sx-stop"><b>${esc(R.stop[0])}</b><p>${R.stop[1]}</p></div>`:`<div class="sx-verdict ${R.sig==null?'na':R.sig?'yes':'no'}">${R.verdict}</div><div class="sx-stats">${R.stats.map(([v,l])=>`<div class="sx-stat"><b>${esc(v)}</b><span>${esc(l)}</span></div>`).join('')}</div>${warn?`<div class="sx-warn">${warn}</div>`:''}${R.viz||''}`;
  return `<div class="sx">
    ${legacyTxt.length?`<div class="notice" style="margin-bottom:14px"><strong>Parte dos dados foi importada antes da análise estatística.</strong> Importe de novo os relatórios de ${esc(legacyTxt.join(', '))} para que todas as pessoas entrem aqui.</div>`:''}
    <div class="sx-cols">
    <section class="card sx-box" aria-label="Montar a análise"><div class="sx-h"><h2>Montar a análise</h2><button class="sx-mini" type="button" data-sx-notes aria-expanded="${!!st.notes}">Como funciona</button></div>
      ${st.notes?`<ol class="sx-notes"><li><b>Uma linha por pessoa</b>, sem nome: paciente da produção, gestante do Monitora ou participação em escovação.</li><li><b>"Teve o procedimento…"</b> transforma qualquer procedimento em Sim/Não por paciente.</li><li><b>Juntar categorias</b> (ex.: 40–59 com 60+) e <b>analisar só um subgrupo</b> (ex.: só quem teve urgência).</li><li><b>Regressão logística</b>: efeito de cada fator considerando os outros ao mesmo tempo, comparado ao efeito "sozinho".</li><li>Variáveis que valem só para parte das pessoas deixam as outras de fora, e o app diz quantas.</li><li>Resultados mostram associação, não causa. Para conferir em outro programa, use "Baixar dados para análise".</li></ol>`:''}
      <div class="sx-field"><span>Quem entra na análise</span><div class="sx-bases">${bases}</div></div>
      ${base.noPeriod?'':`<div class="sx-field"><span>Período</span><div class="sx-per"><div class="pr-seg">${seg('M','Mês')}${seg('Q','Quadrimestre')}${seg('Y','Ano')}</div><b class="pr-per">${esc(per.label)}</b></div></div>`}
      <div class="sx-field"><span>O que você quer saber</span><div class="sx-tests">${tests}</div></div>
      ${fields}
      <div class="sx-field"><span>Analisar só um subgrupo (opcional)</span><select class="sx-sel" data-sx-fvar aria-label="Subgrupo"><option value="-1">Todos</option>${fOpts}</select>${fVal}</div>
      <div class="sx-field"><span>Sugestões</span><div class="sx-sugg">${(SX_SUGG[st.base]||[]).map(([,,,l],i)=>`<button type="button" data-sx-sugg="${i}">${esc(l)}</button>`).join('')}</div></div>
    </section>
    <section class="card sx-box" aria-live="polite"><div class="sx-h"><h2>${esc(R.title)}</h2><small>${esc(base.label)} · ${esc(base.noPeriod?'lista atual':per.label)}${esc(fl)}${R.n!=null?` · ${fmtNum(R.n)} pessoas`:''}</small></div>
      ${result}
      <div class="sx-row"><button class="btn" type="button" data-sx-export>${icon('download')}Baixar dados para análise</button>${R.stop?'':`<button class="btn" type="button" data-sx-table>Baixar tabela do resultado</button><button class="btn" type="button" data-sx-copy>Copiar resultado</button>`}</div>
      ${R.how?.length?`<details class="sx-how"><summary>Como ler o resultado</summary><ul>${R.how.map(h=>`<li>${h}</li>`).join('')}</ul></details>`:''}
    </section></div></div>`;
}
function sxRefresh(){renderView('procedures')}
// ---- Exportação: dados por pessoa (CSV) + script R que refaz o teste ----
function sxSlug(s){return norm(s).toLowerCase().replace(/[^a-z0-9]+/g,'_').replace(/^_|_$/g,'').slice(0,40)}
function sxExportColumns(){const st=sxSt,base=SX_BASES[st.base],cols=[];
  for(const [i,v] of base.vars.entries()){if(v.custom)continue;cols.push({vi:i,name:v.k,label:v.l,v});if(sxMergeMap(i).length)cols.push({vi:i,name:`${v.k}_juntas`,label:`${v.l} (categorias juntas)`,v,merged:true})}
  const procs=[...new Set(['a','b'].filter(k=>st[k]!=null&&base.vars[st[k]].custom).map(k=>st.proc[k]))].filter(Boolean);
  for(const p of procs)cols.push({proc:p,name:`teve_${sxSlug(p)}`,label:`Teve o procedimento: ${p}`});
  return cols}
function sxColFor(vi,key){const st=sxSt,v=SX_BASES[st.base].vars[vi];if(v.custom)return `teve_${sxSlug(st.proc[key])}`;return sxMergeMap(vi).length?`${v.k}_juntas`:v.k}
function sxExportData(anonDentists){const st=sxSt,per=procPeriod(),all=sxBaseData(st.base,per).rows,rows=sxRows(all),base=SX_BASES[st.base],cols=sxExportColumns();
  const dmap=new Map();const dent=x=>{if(!anonDentists||x==null)return x;if(!dmap.has(x))dmap.set(x,`Dentista ${String.fromCharCode(65+dmap.size%26)}${dmap.size>=26?Math.floor(dmap.size/26):''}`);return dmap.get(x)};
  const isDent=c=>st.base==='pat'&&c.v?.k==='dentista';
  const cell=(r,c)=>{if(c.proc)return (r[22]||[]).includes(c.proc)?'Sim':'Não';const raw=r[c.v.i];if(raw==null||raw==='')return '';if(c.merged){const g=sxMergeMap(c.vi).find(g=>g.includes(raw));const x=g?g.join(' + '):raw;return isDent(c)?x.split(' + ').map(dent).join(' + '):x}return isDent(c)?dent(raw):raw};
    return {cols,head:['id',...cols.map(c=>c.name)],data:rows.map((r,i)=>[i+1,...cols.map(c=>cell(r,c))]),per,base,dmap}}
function sxRScript(file,exp){const st=sxSt,base=SX_BASES[st.base],T=SX_TESTS[st.test],q0=s=>`"${String(s).replace(/\\/g,'\\\\').replace(/"/g,'\\"')}"`,q=s=>q0(exp.dmap.size?String(s).split(' + ').map(x=>exp.dmap.get(x)??x).join(' + '):s),c=(vi,key)=>sxColFor(vi,key),A=st.a!=null?c(st.a,'a'):null,B=st.b!=null?c(st.b,'b'):null;
  const lines=[`# Acompanhamento Odontológico · análise estatística · gerado em ${fmtDateTime(nowISO())}`,`# Base: ${base.label} · ${base.noPeriod?'lista atual do Monitora APS':exp.per.label}${sxSt.fv!=null&&sxSt.fval!=null?` · só ${base.vars[sxSt.fv].l.toLowerCase()}: ${sxSt.fval}`:''}`,`# Arquivo de dados: ${file} (uma linha por ${base.unit}, sem nome; separador ";" e UTF-8)`,'#','# Dicionário das variáveis',`#   id: número sequencial da linha (não identifica ninguém)`];
  for(const col of exp.cols){const v=col.v,info=col.proc?'Sim/Não':v.t==='num'?'número':v.t===SX_BIN?'Sim/Não':v.o&&v.t==='ord'?`categorias em ordem`:'categorias';lines.push(`#   ${col.name}: ${col.label} (${info}${v?.only?`; vazio para quem não é "${v.only}"`:''})`)}
  if(exp.dmap.size)lines.push('#   (os nomes dos dentistas foram trocados por Dentista A, B, C…)');
  lines.push('#','# Vazio = não se aplica (NA). O R deixa essas linhas de fora, como o app.','',`d <- read.csv2(${q(file)}, fileEncoding = "UTF-8-BOM", na.strings = "", stringsAsFactors = FALSE)`,'');
  const fac=(col,vi)=>{const v=base.vars[vi];if(v.t==='ord'&&v.o&&!sxMergeMap(vi).length)return `d$${col} <- factor(d$${col}, levels = c(${v.o.map(q).join(', ')}))`;return null};
  const pre=[A&&st.a!=null&&fac(A,st.a),B&&st.b!=null&&fac(B,st.b)].filter(Boolean);lines.push(...pre);
  lines.push(`# Teste escolhido no app: ${T.l} (${T.s})`);
  if(st.test==='chi')lines.push(`t <- table(d$${A}, d$${B})`,'t','chisq.test(t, correct = FALSE)      # qui-quadrado (sem correção de Yates, como o app)','fisher.test(t)                       # exato de Fisher (o app usa quando a tabela é 2x2 com esperado < 5)','# V de Cramér:',`sqrt(chisq.test(t, correct = FALSE)$statistic / (sum(t) * (min(dim(t)) - 1)))`);
  if(st.test==='ic'){lines.push(`x <- na.omit(d$${A})`,'prop.test(sum(x == "Sim"), length(x), correct = FALSE)$conf.int   # intervalo de Wilson, como o app');if(B)lines.push('# Por grupo:',`sapply(split(d$${A}, d$${B}), function(x) { x <- na.omit(x); c(n = length(x), p = mean(x == "Sim"), prop.test(sum(x == "Sim"), length(x), correct = FALSE)$conf.int) })`)}
  if(st.test==='p2')lines.push(`g <- d[d$${B} %in% c(${q(st.g1)}, ${q(st.g2)}) & !is.na(d$${A}), ]`,`k <- c(sum(g$${A}[g$${B} == ${q(st.g1)}] == "Sim"), sum(g$${A}[g$${B} == ${q(st.g2)}] == "Sim"))`,`n <- c(sum(g$${B} == ${q(st.g1)}), sum(g$${B} == ${q(st.g2)}))`,'prop.test(k, n, correct = FALSE)     # igual ao teste z do app (z² = qui-quadrado)','fisher.test(matrix(c(k, n - k), 2))  # o app usa Fisher quando algum grupo tem menos de 5 casos');
  if(st.test==='tr'){const lv=sxSt._lastTrend||[];lines.push(`g <- d[!is.na(d$${A}) & d$${B} %in% c(${lv.map(q).join(', ')}), ]`,`g$${B} <- factor(g$${B}, levels = c(${lv.map(q).join(', ')}))`,`k <- tapply(g$${A} == "Sim", g$${B}, sum)`,`n <- tapply(g$${A}, g$${B}, length)`,'prop.trend.test(k, n)                # Cochran-Armitage, escores 1, 2, 3…')}
  if(st.test==='gr')lines.push(`g <- d[!is.na(d$${A}) & !is.na(d$${B}), ]`,`tapply(g$${A}, g$${B}, summary)`,`if (length(unique(g$${B})) == 2) wilcox.test(${A} ~ ${B}, data = g, exact = FALSE) else kruskal.test(${A} ~ factor(${B}), data = g)`);
  if(st.test==='co')lines.push(`cor.test(d$${A}, d$${B}, method = "spearman", exact = FALSE)`);
  if(st.test==='lr'){const xs=st.xs.filter(vi=>vi!==st.a),terms=[];lines.push(`d$y <- ifelse(is.na(d$${A}), NA, as.integer(d$${A} == "Sim"))`);
    for(const vi of xs){const v=base.vars[vi],col=c(vi,'x'+vi);if(v.t==='num'){terms.push(v.per10?`I(${col} / 10)`:col);continue}const lv=sxLevels(vi,sxRows(sxBaseData(st.base,exp.per).rows),'x'+vi),ref=v.t===SX_BIN&&lv.includes('Não')?'Não':lv[0];lines.push(`d$${col} <- relevel(factor(d$${col}), ref = ${q(ref)})`);terms.push(col)}
    lines.push(`m <- glm(y ~ ${terms.join(' + ')}, family = binomial, data = d)`,'summary(m)','exp(cbind(OR = coef(m), confint.default(m)))   # razão de chances com IC de Wald, como o app','1 - as.numeric(logLik(m)) / as.numeric(logLik(update(m, . ~ 1)))   # R² de McFadden')}
  return lines.join('\n')+'\n'}
function sxOpenExport(){const st=sxSt,n=sxRows(sxBaseData(st.base).rows).length;openModal(`<div class="modal-head"><div><h2 id="modalTitle">Baixar dados para análise</h2><p>${esc(SX_BASES[st.base].label)} · ${fmtNum(n)} linhas, uma por ${esc(SX_BASES[st.base].unit)}, sem nome, CNS ou prontuário.</p></div></div><div class="modal-body"><div class="notice">Baixa dois arquivos: <b>os dados (CSV)</b>, com as mesmas variáveis e o mesmo período e subgrupo da tela, e <b>um script R</b> com o dicionário das variáveis e o código que refaz o teste escolhido. O CSV abre no Excel, jamovi, SPSS e Stata.</div>${st.base==='pat'?'<label class="sx-check"><input type="checkbox" id="sxAnon" checked> Trocar o nome dos dentistas por Dentista A, B, C…</label>':''}</div><div class="modal-foot"><button class="btn" data-close-modal>Cancelar</button><button class="btn primary" data-sx-export-go>${icon('download')}Baixar</button></div>`)}
function sxDoExport(){const st=sxSt,anon=st.base!=='pat'||!!document.getElementById('sxAnon')?.checked,exp=sxExportData(anon),stamp=isoDate(new Date()),file=`analise-${({pat:'pacientes',ges:'gestantes',kids:'escovacao',pse:'pse'})[st.base]}-${stamp}.csv`;
  downloadFile(file,csvString([exp.head,...exp.data]),'text/csv;charset=utf-8');setTimeout(()=>downloadFile(file.replace(/\.csv$/,'.R'),sxRScript(file,exp),'text/plain;charset=utf-8'),400);
  audit('stats_data_exported',{base:st.base,rows:exp.data.length,anonDentists:anon});closeModal();toast(`${fmtNum(exp.data.length)} linhas exportadas, com o script R.`)}
function sxCurrentResult(){const per=procPeriod();return sxRun(sxBaseData(sxSt.base,per).rows,per)}
function sxResultText(R){const base=SX_BASES[sxSt.base],per=procPeriod(),strip=h=>String(h||'').replace(/<br\s*\/?>/g,' ').replace(/<\/p>|<\/b>(?=<p>)/g,'. ').replace(/<[^>]+>/g,'').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/\s+/g,' ').replace(/\.\s*\./g,'.').trim();
  return [R.title,`${base.label} · ${base.noPeriod?'lista atual':per.label}${sxSt.fv!=null&&sxSt.fval!=null?` · só ${base.vars[sxSt.fv].l.toLowerCase()}: ${sxSt.fval}`:''} · ${R.n} pessoas`,strip(R.verdict),R.stats.map(([v,l],i)=>i?`${l}: ${v}`:`${v} (${l})`).join(' · ')].join('\n')}
async function sxCopy(){const R=sxCurrentResult();if(R.stop)return;try{await navigator.clipboard.writeText(sxResultText(R));toast('Resultado copiado.')}catch{toast('Não foi possível copiar neste navegador.')}}
function sxTableCsv(){const R=sxCurrentResult();if(R.stop||!R.table)return;const head=[[R.title],[sxResultText(R).split('\n')[1]],...R.stats.map(([v,l],i)=>i?[l,v]:['Teste',`${v} (${l})`]),[]];downloadFile(`resultado-${sxSt.test}-${isoDate(new Date())}.csv`,csvString([...head,...R.table]),'text/csv;charset=utf-8')}
function sxClick(ev){const el=ev.target.closest('[data-proc-view],[data-sx-base],[data-sx-test],[data-sx-sugg],[data-sx-mopen],[data-sx-mchip],[data-sx-mdo],[data-sx-mundo],[data-sx-mclose],[data-sx-notes],[data-sx-export],[data-sx-export-go],[data-sx-table],[data-sx-copy]');if(!el)return;const st=sxSt,d=el.dataset;
  if(d.procView){state.preferences.procView=d.procView==='stats'?'stats':'overview';queueSave();return sxRefresh()}
  if(d.sxBase){st.base=d.sxBase;st.fv=st.fval=null;st.mergeOpen=null;st.xs=SX_DEFX[st.base].slice();sxSetTest(st.test);return sxRefresh()}
  if(d.sxTest){sxSetTest(d.sxTest);return sxRefresh()}
  if(d.sxSugg!=null){const [t,a,b]=SX_SUGG[st.base][+d.sxSugg];st.test=t;st.a=a;st.b=b;st.g1=st.g2=null;if(t==='lr')st.xs=SX_DEFX[st.base].filter(x=>x!==a);if(t==='p2'&&st.base==='pat'&&a===8&&b===10){st.g1='Sim';st.g2='Não'}if(t==='ic'&&a===16&&state.preferences.procPeriod!=='Y'){state.preferences.procPeriod='Y';queueSave()}return sxRefresh()}
  if(d.sxMopen){st.mergeOpen=d.sxMopen;st.mergeSel=[];return sxRefresh()}
  if(d.sxMchip!=null){const x=d.sxMchip;st.mergeSel=st.mergeSel.includes(x)?st.mergeSel.filter(y=>y!==x):[...st.mergeSel,x];return sxRefresh()}
  if(d.sxMdo){if(st.mergeSel.length<2)return toast('Escolha pelo menos 2 categorias.');const vi=st[d.sxMdo],k=`${st.base}:${vi}`,parts=st.mergeSel.flatMap(x=>x.split(' + '));st.merge[k]=(st.merge[k]||[]).filter(g=>!g.some(x=>parts.includes(x))).concat([parts]);st.mergeSel=[];st.mergeOpen=null;return sxRefresh()}
  if(d.sxMundo){delete st.merge[`${st.base}:${st[d.sxMundo]}`];st.mergeOpen=null;return sxRefresh()}
  if(el.hasAttribute('data-sx-mclose')){st.mergeOpen=null;return sxRefresh()}
  if(el.hasAttribute('data-sx-notes')){st.notes=!st.notes;return sxRefresh()}
  if(el.hasAttribute('data-sx-export'))return sxOpenExport();
  if(el.hasAttribute('data-sx-export-go'))return sxDoExport();
  if(el.hasAttribute('data-sx-table'))return sxTableCsv();
  if(el.hasAttribute('data-sx-copy'))return sxCopy();
}
function sxChange(ev){const t=ev.target,st=sxSt,d=t.dataset||{};
  if(d.sxVar){const v=+t.value;st[d.sxVar]=v<0?null:v;st.g1=st.g2=null;st.mergeOpen=null;if(st.test==='lr')st.xs=st.xs.filter(x=>x!==st.a);return sxRefresh()}
  if(d.sxProc){st.proc[d.sxProc]=t.value;return sxRefresh()}
  if(d.sxX!=null){const i=+d.sxX;st.xs=t.checked?[...st.xs,i]:st.xs.filter(x=>x!==i);return sxRefresh()}
  if(t.hasAttribute('data-sx-fvar')){const v=+t.value;st.fv=v<0?null:v;st.fval=null;return sxRefresh()}
  if(t.hasAttribute('data-sx-fval')){st.fval=t.value;return sxRefresh()}
  if(d.sxG==='1'){st.g1=t.value;st.g2=null;return sxRefresh()}if(d.sxG==='2'){st.g2=t.value;return sxRefresh()}
}

function setupEvents(){
  document.addEventListener('click',async ev=>{const el=ev.target.closest('button,[data-go],[data-open-episode],[data-open-snapshot],[data-team-filter],[data-overview-scope],[data-indicator-detail],[data-fed-detail]');if(!el||!el.hasAttribute('data-preg-menu'))document.querySelectorAll('.pq-menu:not([hidden])').forEach(m=>m.hidden=true);if(!el)return;
    if(el.dataset.pregTab){state.preferences.pregTab=el.dataset.pregTab;queueSave();return refreshAll()}if(el.hasAttribute('data-preg-incomplete')){state.preferences.pregIncomplete=!state.preferences.pregIncomplete;queueSave();return refreshAll()}if(el.hasAttribute('data-preg-prio')){state.preferences.pregPrioOnly=!state.preferences.pregPrioOnly;if(state.preferences.pregPrioOnly&&['atendida','encerrada'].includes(state.preferences.pregTab))state.preferences.pregTab='todas';queueSave();return refreshAll()}if(el.hasAttribute('data-preg-more')){state.preferences.pregMoreFilters=!state.preferences.pregMoreFilters;queueSave();return refreshAll()}if(el.hasAttribute('data-preg-menu')){const m=el.nextElementSibling,willOpen=m.hidden;document.querySelectorAll('.pq-menu').forEach(x=>x.hidden=true);m.hidden=!willOpen;return}if(el.hasAttribute('data-preg-howto'))return openPregHowTo();
    if(el.dataset.pregAct){const [k,id]=el.dataset.pregAct.split('|');return pregAct(k,id)}if(el.dataset.pregNav){const q=pregQueue(),i=q.findIndex(x=>x.id===pregDrawer.id),nx=q[i+Number(el.dataset.pregNav)];if(nx)openEpisode(nx.id);return}if(el.dataset.pregDtab){pregDrawer.tab=el.dataset.pregDtab;pregDrawer.edit=false;return openEpisode(pregDrawer.id)}if(el.hasAttribute('data-preg-edit')){pregDrawer.edit=!pregDrawer.edit;return openEpisode(pregDrawer.id)}if(el.dataset.pregSched){pregDrawer.sched=!pregDrawer.sched;return openEpisode(el.dataset.pregSched)}if(el.dataset.pregSchedSave)return pregSaveSchedule(el.dataset.pregSchedSave);if(el.dataset.pregQn){const ta=document.getElementById('followupNoteInput');if(ta){const cur=ta.value.trim();ta.value=(cur?cur.replace(/\.?$/,'. '):'')+el.dataset.pregQn;ta.focus()}return}if(el.dataset.pregParto)return toggleGestacaoEncerrada(el.dataset.pregParto);if(el.dataset.copyText!=null){try{await navigator.clipboard.writeText(el.dataset.copyText);toast('Copiado.')}catch{toast(el.dataset.copyText)}return}
    if(el.dataset.overviewScope)return updatePreference('overviewScope',el.dataset.overviewScope);
    if(el.dataset.indicatorDetail)return openIndicatorDetail(el.dataset.indicatorDetail,el.dataset.detailScope);if(el.dataset.fedDetail)return openFederalDetail(el.dataset.fedDetail);if(el.dataset.ovJump){document.getElementById(el.dataset.ovJump)?.scrollIntoView({behavior:'smooth',block:'start'});return}if(el.hasAttribute('data-ov-pop-save'))return ovSavePopulation();if(el.dataset.ovDenSave)return ovSaveManual(el.dataset.ovDenSave);if(el.hasAttribute('data-ov-manual-toggle')){const box=document.getElementById('ovManualBox');if(box){box.hidden=!box.hidden;el.textContent=box.hidden?'Digitar o valor direto':'Esconder valor direto'}return}
    if(el.matches('[data-close-modal]'))return closeModal();if(el.matches('[data-close-drawer]'))return closeDrawer();if(el.hasAttribute('data-toggle-details')){el.classList.toggle('open');el.nextElementSibling.classList.toggle('open');return}if(el.dataset.view)return switchView(el.dataset.view);if(el.dataset.go)return switchView(el.dataset.go);if(el.dataset.action==='import')return document.getElementById('fileInput').click();if(el.dataset.action==='restore-backup')return document.getElementById('backupInput').click();if(el.dataset.action==='export-backup')return openBackupModal();
    if(el.dataset.openSnapshot)return openSnapshot(el.dataset.openSnapshot);if(el.dataset.deleteSnapshot)return openDeleteSnapshotModal(el.dataset.deleteSnapshot);if(el.dataset.confirmDeleteSnapshot)return confirmDeleteSnapshot(el.dataset.confirmDeleteSnapshot);if(el.dataset.pregOriginGo){const p=state.preferences;p.pregOrigin=el.dataset.pregOriginGo;p.pregTab='todas';p.pregMoreFilters=true;queueSave();return switchView('pregnant')}if(el.dataset.snapshotTab)return openSnapshot(el.dataset.snapshotId,el.dataset.snapshotTab);if(el.dataset.composition){const [scope,id,mk]=el.dataset.composition.split('|');return openComposition(scope,id,mk)}
    if(el.dataset.saveDenom){const [id,scope]=el.dataset.saveDenom.split('|'),input=el.closest('.denom-inline')?.querySelector(`[data-denom-input="${id}|${scope}"]`);return openDenominatorModal(id,scope,input?.value||'')}
    if(el.dataset.useSuggestion){const [id,scope,value]=el.dataset.useSuggestion.split('|');return openDenominatorModal(id,scope,value)}
    if(el.hasAttribute('data-add-pregnant'))return openManualPregnant();if(el.hasAttribute('data-clear-all-gestantes'))return openClearGestantesModal();if(el.dataset.openEpisode)return openEpisode(el.dataset.openEpisode);if(el.dataset.teamFilter!=null){const t=el.dataset.teamFilter;state.preferences.pregTeam=state.preferences.pregTeam===t?'':t;queueSave();refreshAll();return}if(el.hasAttribute('data-clear-preg-filters')){for(const k of ['pregTeam','pregOrigin','pregPhone','pregExcluded','pregSearch','pregIncomplete'])state.preferences[k]='';state.preferences.pregPrioOnly=false;queueSave();return refreshAll()}
    if(el.dataset.copyName){const e=mergedEpisodes().find(x=>x.id===el.dataset.copyName);if(e)await navigator.clipboard.writeText(e.nome||'');return toast('Nome copiado.')}
    if(el.dataset.openWhatsapp){const e=mergedEpisodes().find(x=>x.id===el.dataset.openWhatsapp);if(e?.phoneNormalized)window.open(`https://wa.me/${e.phoneNormalized}`,'_blank','noopener,noreferrer');return}
    if(el.dataset.followup){const [id,next]=el.dataset.followup.split('|');return setFollowupWithUndo(id,next,next==='nao_contatada'?'Acompanhamento reiniciado.':`${followupLabel(next)} · registrado.`)}if(el.dataset.mergeManual){const [m,e]=el.dataset.mergeManual.split('|');return mergeManual(m,e)}if(el.dataset.editManual){closeDrawer();return openManualPregnant(el.dataset.editManual)}if(el.dataset.addFollowupNote){const ta=document.getElementById('followupNoteInput');return addFollowupNote(el.dataset.addFollowupNote,ta?ta.value:'')}if(el.dataset.saveAllFields)return saveAllFieldsOverride(el.dataset.saveAllFields);if(el.dataset.archiveManual){const m=state.gestantes.manual.find(x=>x.id===el.dataset.archiveManual);if(m){m.archived=true;audit('2i_manual_archived',{manualId:m.id});closeDrawer();refreshAll();toast('Cadastro manual arquivado.')}return}if(el.dataset.excludeEpisode){closeDrawer();return openExcludeEpisode(el.dataset.excludeEpisode)}if(el.dataset.restoreEpisode)return restoreEpisode(el.dataset.restoreEpisode);
    if(el.hasAttribute('data-export-procedures'))return exportProcedures();if(el.hasAttribute('data-export-2i'))return export2IModal();if(el.dataset.export2iMode)return export2I(el.dataset.export2iMode);if(el.hasAttribute('data-run-tests')){showLoading(`Executando ${SELF_TEST_COUNT} testes`,'Fórmulas, faixas, privacidade e 2I');try{const r=await runSelfTests();toast(`${r.passed}/${r.total} testes passaram.`)}finally{hideLoading()}return}
    if(el.dataset.settingsTab){state.preferences.settingsTab=el.dataset.settingsTab;if(activeView!=='settings'){switchView('settings')}else{queueSave();refreshAll()}return}
    if(el.dataset.procSource){state.preferences.procSource=el.dataset.procSource;queueSave();return refreshAll()}
    if(el.dataset.procPeriod){state.preferences.procPeriod=el.dataset.procPeriod;queueSave();return refreshAll()}
    if(el.dataset.procMonth){const p=state.preferences;if(p.procPeriod==='M'&&p.month===el.dataset.procMonth){p.procPeriod='Q'}else{p.procPeriod='M';p.month=el.dataset.procMonth;const {year,month}=parseMonthKey(p.month);p.year=year;p.quarter=quarterOfMonth(month)}queueSave();return refreshAll()}
    if(el.dataset.procAge){state.preferences.procAge=state.preferences.procAge===el.dataset.procAge?'':el.dataset.procAge;queueSave();return refreshAll()}
    if(el.dataset.procSex){state.preferences.procSex=state.preferences.procSex===el.dataset.procSex?'':el.dataset.procSex;queueSave();return refreshAll()}
    if(el.dataset.procDentist!=null){state.preferences.procDentist=state.preferences.procDentist===el.dataset.procDentist?'':el.dataset.procDentist;queueSave();return refreshAll()}
    if(el.hasAttribute('data-proc-clear')){for(const k of ['procSex','procAge','procDentist'])state.preferences[k]='';queueSave();return refreshAll()}
    if(el.dataset.procCat){const p=state.preferences,open=new Set(Array.isArray(p.procOpenCats)?p.procOpenCats:['Periodontia','Preventivos']);open.has(el.dataset.procCat)?open.delete(el.dataset.procCat):open.add(el.dataset.procCat);p.procOpenCats=[...open];queueSave();return refreshAll()}
    if(el.dataset.procOpen)return openProcedureDetail(el.dataset.procOpen);
    if(el.dataset.groupAct)return openGroupActivity(el.dataset.groupAct);
    if(el.hasAttribute('data-clear-browser'))return openClearBrowserModal();if(el.hasAttribute('data-clear-with-backup')){localSave.pendingClearAfterBackup=true;return openBackupModal()}if(el.hasAttribute('data-clear-no-backup')){if(el.dataset.armed!=='1'){el.dataset.armed='1';el.textContent='Confirmar: apagar sem backup';return}return clearBrowserData()}
    if(el.hasAttribute('data-create-backup'))return createBackupFromModal();if(el.hasAttribute('data-restore-backup'))return document.getElementById('backupInput').click();if(el.hasAttribute('data-unlock-backup'))return processPendingBackup(document.getElementById('restorePassword')?.value||'');
  });
  document.getElementById('importBtn').onclick=()=>document.getElementById('fileInput').click();document.getElementById('fileInput').onchange=e=>importFiles(e.target.files);document.getElementById('backupBtn').onclick=openBackupModal;document.getElementById('printBtn').onclick=()=>window.print();document.getElementById('saveBtn').onclick=openBackupModal;
  document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='hidden'&&localSave.timer)saveToBrowserNow()});
  window.addEventListener('beforeunload',ev=>{if(localSave.enabled&&!localSave.error){if(localSave.timer)saveToBrowserNow();return}if(!state.dirty)return;ev.preventDefault();ev.returnValue='Há alterações não salvas. Nada é gravado pelo navegador — exporte um backup antes de sair, ou você perde tudo.';return ev.returnValue});
  document.getElementById('backupInput').onchange=e=>{pendingBackupFile=e.target.files[0]||null;e.target.value='';if(pendingBackupFile)processPendingBackup()};
  document.getElementById('yearFilter').onchange=e=>{state.preferences.year=Number(e.target.value);state.preferences.month=quarterMonths(state.preferences.year,state.preferences.quarter)[0];queueSave();refreshAll()};document.getElementById('quarterFilter').onchange=e=>{state.preferences.quarter=Number(e.target.value);state.preferences.month=quarterMonths(state.preferences.year,state.preferences.quarter)[0];queueSave();refreshAll()};document.getElementById('monthFilter').onchange=e=>updatePreference('month',e.target.value);document.getElementById('unitFilter').onchange=e=>updatePreference('unit',e.target.value);
  document.getElementById('globalSearch').addEventListener('keydown',e=>{if(e.key==='Enter')globalSearch(e.currentTarget.value)});
  document.addEventListener('change',e=>{if(e.target.hasAttribute('data-autosave-toggle'))return setAutosave(e.target.checked);if(e.target.dataset.toggleEncerrada)return toggleGestacaoEncerrada(e.target.dataset.toggleEncerrada);if(e.target.matches('.preg-filter')){state.preferences[e.target.dataset.pregFilter]=e.target.value;queueSave();refreshAll()}if(e.target.id==='sourceMode')updatePreference('sourceMode',e.target.value);if(e.target.id==='settingsTarget'||e.target.id==='targetScore')updatePreference('targetScore',clamp(Number(e.target.value),0,100));
    if(e.target.hasAttribute('data-proc-dentist-sel')){state.preferences.procDentist=e.target.value;queueSave();refreshAll()}
  });
  document.addEventListener('click',sxClick);document.addEventListener('change',sxChange);document.addEventListener('click',pseClick);document.addEventListener('change',pseChange);document.addEventListener('input',debounce(pseInput,250));
  document.addEventListener('input',e=>{if(['ovPop','ovEsf','ovDent','ovDenManual'].includes(e.target.id))ovLivePreview(e.target)});
  // Campo de data aceita colar "dd/mm/aaaa" (o navegador sozinho só aceita digitar dígito por dígito).
  document.addEventListener('paste',e=>{const t=e.target;if(!(t instanceof HTMLInputElement)||t.type!=='date')return;const iso=pastedDateToIso(e.clipboardData?.getData('text'));if(!iso){toast('A data colada não foi reconhecida. Use dd/mm/aaaa.');e.preventDefault();return}e.preventDefault();t.value=iso;t.dispatchEvent(new Event('input',{bubbles:true}));t.dispatchEvent(new Event('change',{bubbles:true}))},true);
  document.addEventListener('input',debounce(e=>{if(e.target.id==='pregSearch'){state.preferences.pregSearch=e.target.value;queueSave();document.getElementById('view-pregnant').innerHTML=pregnancyHTML();hydrateIcons(document.getElementById('view-pregnant'))}if(e.target.id==='calcPeso'){state.preferences.calcPeso=e.target.value;queueSave();const hadFocus=document.activeElement&&document.activeElement.id==='calcPeso';const selStart=hadFocus?document.activeElement.selectionStart:null;document.getElementById('view-calculator').innerHTML=calculatorHTML();if(hadFocus){const el=document.getElementById('calcPeso');if(el){el.focus();if(selStart!==null)el.setSelectionRange(selStart,selStart)}}}},250));
  document.addEventListener('keydown',e=>{if(e.key==='Escape'){closeModal();closeDrawer()}});document.getElementById('modalBackdrop').addEventListener('click',e=>{if(e.target.id==='modalBackdrop')closeModal()});document.getElementById('drawerBackdrop').addEventListener('click',e=>{if(e.target.id==='drawerBackdrop')closeDrawer()});
  let dragDepth=0;window.addEventListener('dragenter',e=>{e.preventDefault();dragDepth++;document.getElementById('dropOverlay').classList.add('open')});window.addEventListener('dragover',e=>e.preventDefault());window.addEventListener('dragleave',e=>{e.preventDefault();if(--dragDepth<=0){dragDepth=0;document.getElementById('dropOverlay').classList.remove('open')}});window.addEventListener('drop',e=>{e.preventDefault();dragDepth=0;document.getElementById('dropOverlay').classList.remove('open');if(e.dataTransfer.files.length)importFiles(e.dataTransfer.files)});
}

async function bootstrap(){hydrateIcons();setupEvents();localSave.enabled=readAutosavePref();let restored=null;if(localSave.enabled){restored=await loadFromBrowser();if(restored?.state){state=restored.state;localSave.lastSavedAt=restored.savedAt||null}}state=migrateState(state);activeView=state.preferences.view||'overview';refreshAll();if(restored?.state)toast(`Dados restaurados deste navegador (salvos em ${fmtDateTime(restored.savedAt)}).`);window.__APP_TEST_API__={version:APP_VERSION,importFiles,runSelfTests,getState:()=>state,getProcedureMonth:mk=>aggregateProcedureMonth(mk),getGroupMonth:mk=>aggregateGroupMonth(mk),getConsolidatedMonth:mk=>aggregateConsolidatedMonth(mk),getEpisodes:()=>getActive2ISnapshot()?.episodes||[],calculations:{municipalComponents,federalComponents,quarterMunicipal,quarterFederal,federalQuadrimestralOutlook,quadrimestralOutlook,metaProgress,metaCard,quarterMonths,nowISO,isMonthOver,isQuarterOver},reset:async()=>{state=defaultState();sessionRaw=new Map();await persistState();refreshAll()}}}
bootstrap();
