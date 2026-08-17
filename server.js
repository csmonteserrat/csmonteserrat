/*
 * Sistema de Chamada de Pacientes — Centro de Saúde Monte Serrat
 * Servidor: Express + Socket.IO, estado em memória com persistência em JSON.
 * Rotas: /painel (profissional) e /tv (recepção).
 */

const path = require("path");
const fs = require("fs");
const http = require("http");
const express = require("express");
const { Server } = require("socket.io");

const PORT = process.env.PORT || 3000;
const ARQUIVO_ESTADO = path.join(__dirname, "estado-turno.json");
// Avisos, frases e farmácia ficam num arquivo separado do turno: eles não
// são apagados ao encerrar o turno e sobrevivem a reinicializações.
const ARQUIVO_CONTEUDO = path.join(__dirname, "conteudo-tv.json");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// Código de acesso (6 dígitos). Em produção, defina CODIGO_ACESSO nas
// variáveis de ambiente do Render para trocar sem mexer no código.
const CODIGO_ACESSO = process.env.CODIGO_ACESSO || "246810";

// A TV conecta sem código, em modo somente-leitura (apenas recebe as
// chamadas). O painel do profissional exige o código de 6 dígitos, pois
// é quem pode chamar, mudar status e encerrar o turno.
io.use((socket, next) => {
  const auth = socket.handshake.auth || {};
  if (auth.tela === "tv") {
    socket.data.somenteLeitura = true;
    return next();
  }
  if (String(auth.codigo) === String(CODIGO_ACESSO)) return next();
  next(new Error("codigo-invalido"));
});

// Rota leve para o monitor do UptimeRobot manter o servidor acordado
app.get("/ping", (_req, res) => res.type("text").send("ok"));

/* ------------------------------------------------------------------ */
/* Voz sintetizada no servidor (/tts)                                  */
/* Navegadores de Smart TV (ex.: LG WebOS) não têm vozes de síntese.  */
/* Este endpoint gera o áudio da frase com o espeak-ng e a TV apenas  */
/* toca o WAV, como toca o bipe. Cache em memória por frase.          */
/* ------------------------------------------------------------------ */

const { execFile } = require("child_process");
const cacheTts = new Map();
let motorTts = null; // "espeak-ng", "espeak" ou false

function detectarMotorTts(cb) {
  if (motorTts !== null) return cb(motorTts);
  execFile("espeak-ng", ["--version"], (e1) => {
    if (!e1) { motorTts = "espeak-ng"; return cb(motorTts); }
    execFile("espeak", ["--version"], (e2) => {
      motorTts = e2 ? false : "espeak";
      cb(motorTts);
    });
  });
}

// Reserva quando o servidor não tem espeak instalado (runtime Node do
// Render, por exemplo): usa a voz do Google Tradutor, que é natural em
// pt-BR. Endpoint público não oficial — por isso é a segunda opção, e o
// resultado fica em cache para reduzir as chamadas.
async function vozOnline(texto) {
  const url = "https://translate.google.com/translate_tts?ie=UTF-8"
    + "&client=tw-ob&tl=pt-BR&q=" + encodeURIComponent(texto.slice(0, 190));
  const resp = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        + "(KHTML, like Gecko) Chrome/120.0 Safari/537.36",
      "Referer": "https://translate.google.com/",
    },
  });
  if (!resp.ok) throw new Error("HTTP " + resp.status);
  const buf = Buffer.from(await resp.arrayBuffer());
  if (buf.length < 500) throw new Error("áudio vazio");
  return { buffer: buf, tipo: "audio/mpeg" };
}

// Gera o áudio da frase: espeak local, senão voz online.
function gerarAudio(texto, vel) {
  return new Promise((resolve, reject) => {
    detectarMotorTts((motor) => {
      if (motor) {
        return execFile(motor, ["-v", "pt-br", "-s", String(vel), "--stdout", texto],
          { encoding: "buffer", maxBuffer: 10 * 1024 * 1024 },
          (err, stdout) => {
            if (!err && stdout && stdout.length > 100) {
              return resolve({ buffer: stdout, tipo: "audio/wav" });
            }
            vozOnline(texto).then(resolve).catch(reject);
          });
      }
      vozOnline(texto).then(resolve).catch(reject);
    });
  });
}

// Diagnóstico: informa se o servidor consegue gerar voz (útil para a TV
// mostrar no menu e para conferir se o deploy usou o runtime Docker)
app.get("/tts-status", (_req, res) => {
  detectarMotorTts(async (motor) => {
    if (motor) return res.json({ disponivel: true, motor });
    // sem espeak: testa a voz online
    try {
      await vozOnline("teste");
      res.json({ disponivel: true, motor: "voz online (Google)" });
    } catch (e) {
      res.json({
        disponivel: false,
        motor: null,
        erro: String(e.message || e).slice(0, 80),
        dica: "Sem espeak local e a voz online falhou. Recrie o serviço no Render com o runtime Docker.",
      });
    }
  });
});

app.get("/tts", (req, res) => {
  const texto = String(req.query.texto || "").slice(0, 300).trim();
  if (!texto) return res.status(400).type("text").send("texto vazio");
  const vel = Math.max(80, Math.min(260, parseInt(req.query.vel, 10) || 160));
  const chave = `${vel}|${texto}`;
  if (cacheTts.has(chave)) {
    const item = cacheTts.get(chave);
    return res.type(item.tipo).send(item.buffer);
  }
  gerarAudio(texto, vel).then(({ buffer, tipo }) => {
    if (cacheTts.size > 300) cacheTts.clear();
    cacheTts.set(chave, { buffer, tipo });
    res.type(tipo).send(buffer);
  }).catch((e) => {
    res.status(503).type("text").send("Falha na síntese: " + (e.message || e));
  });
});

/* ------------------------------------------------------------------ */
/* Histórico mensal (sem nomes de pacientes — LGPD)                    */
/* Guarda até 31 dias de registros anonimizados para acompanhamento   */
/* de absenteísmo e produção. Alimentado ao encerrar cada turno.      */
/* ------------------------------------------------------------------ */

const ARQUIVO_MENSAL = path.join(__dirname, "historico-mensal.json");
let historicoMensal = [];
try {
  if (fs.existsSync(ARQUIVO_MENSAL)) {
    const bruto = JSON.parse(fs.readFileSync(ARQUIVO_MENSAL, "utf8"));
    if (Array.isArray(bruto)) historicoMensal = bruto;
  }
} catch (e) {
  console.warn("Não foi possível ler o histórico mensal, iniciando vazio.");
}

function limparAntigos() {
  const limite = Date.now() - 31 * 24 * 60 * 60 * 1000;
  historicoMensal = historicoMensal.filter((r) => new Date(r.hora).getTime() >= limite);
}

function gravarMensal() {
  limparAntigos();
  fs.writeFile(ARQUIVO_MENSAL, JSON.stringify(historicoMensal), (err) => {
    if (err) console.error("Falha ao gravar histórico mensal:", err.message);
  });
}

// Exporta o histórico mensal em CSV (exige o código de acesso)
app.get("/exportar-mes", (req, res) => {
  if (String(req.query.codigo) !== String(CODIGO_ACESSO)) {
    return res.status(403).type("text").send("Código de acesso inválido.");
  }
  limparAntigos();
  const linhas = ["data;horario;sala;categoria;modo;vezes_chamado;status"];
  for (const r of historicoMensal) {
    const d = new Date(r.hora);
    linhas.push([
      d.toLocaleDateString("pt-BR"),
      d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }),
      r.sala, r.categoria, r.modo, r.vezes, r.status,
    ].map((v) => String(v).replace(/;/g, ",")).join(";"));
  }
  res.setHeader("Content-Disposition",
    `attachment; filename="historico-mensal-monte-serrat.csv"`);
  res.type("text/csv; charset=utf-8").send("\uFEFF" + linhas.join("\n"));
});

/* ------------------------------------------------------------------ */
/* Chat da equipe (mural coletivo + mensagem direta)                   */
/* Só circula entre painéis de profissionais: as conexões da TV nunca  */
/* entram na sala "equipe", então nenhuma mensagem chega à recepção.   */
/* Retenção de 24 horas — depois disso as mensagens somem sozinhas.    */
/* ------------------------------------------------------------------ */

const ARQUIVO_CHAT = path.join(__dirname, "chat-equipe.json");
const RETENCAO_CHAT = 24 * 60 * 60 * 1000; // 24 horas
const MAX_MENSAGENS = 400;                 // teto de segurança de memória
const TAMANHO_MENSAGEM = 500;

let mensagens = [];
let proximoIdMsg = 1;

try {
  if (fs.existsSync(ARQUIVO_CHAT)) {
    const bruto = JSON.parse(fs.readFileSync(ARQUIVO_CHAT, "utf8"));
    if (Array.isArray(bruto)) mensagens = bruto;
    proximoIdMsg = Math.max(0, ...mensagens.map((m) => m.id || 0)) + 1;
  }
} catch (e) {
  console.warn("Não foi possível ler o chat da equipe, iniciando vazio.");
}

// Identidade da pessoa no chat: o nome sem acentos e em minúsculas. Assim a
// mesma pessoa recebe suas mensagens diretas mesmo que troque de aparelho,
// recarregue a página ou abra o painel em duas abas.
function chaveNome(nome) {
  return String(nome || "").trim().toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ");
}

function limparChatAntigo() {
  const limite = Date.now() - RETENCAO_CHAT;
  const antes = mensagens.length;
  mensagens = mensagens.filter((m) => new Date(m.hora).getTime() >= limite);
  if (mensagens.length > MAX_MENSAGENS) mensagens = mensagens.slice(-MAX_MENSAGENS);
  return antes !== mensagens.length;
}

let timerChat = null;
function gravarChat() {
  clearTimeout(timerChat);
  timerChat = setTimeout(() => {
    fs.writeFile(ARQUIVO_CHAT, JSON.stringify(mensagens), (err) => {
      if (err) console.error("Falha ao gravar o chat:", err.message);
    });
  }, 500);
}

// O que cada pessoa pode ver: o mural inteiro e apenas as mensagens diretas
// que ela mandou ou recebeu.
function mensagensVisiveis(chave) {
  return mensagens.filter((m) => !m.paraChave || m.paraChave === chave || m.deChave === chave);
}

// Quem está com o painel aberto agora. Vários aparelhos da mesma pessoa
// contam como uma só entrada na lista.
const presentes = new Map(); // socket.id -> { nome, categoria, sala, chave, desde }

function listaPresentes() {
  const porPessoa = new Map();
  for (const p of presentes.values()) {
    if (!p.chave) continue;
    const atual = porPessoa.get(p.chave);
    if (!atual || p.desde < atual.desde) porPessoa.set(p.chave, p);
  }
  return [...porPessoa.values()]
    .map(({ chave, nome, categoria, sala, desde }) => ({ chave, nome, categoria, sala, desde }))
    .sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR", { sensitivity: "base" }));
}

function difundirPresenca() {
  io.to("equipe").emit("chat-presenca", listaPresentes());
}

app.use(express.static(path.join(__dirname, "public")));
app.get("/painel", (_req, res) =>
  res.sendFile(path.join(__dirname, "public", "painel.html"))
);
app.get("/tv", (_req, res) =>
  res.sendFile(path.join(__dirname, "public", "tv.html"))
);
// Janela flutuante só com o botão de emergência
app.get("/emergencia", (_req, res) =>
  res.sendFile(path.join(__dirname, "public", "emergencia.html"))
);
app.get("/", (_req, res) => res.redirect("/painel"));

/* ------------------------------------------------------------------ */
/* Estado do turno                                                     */
/* ------------------------------------------------------------------ */

let estado = {
  chamadas: [], // mais recente primeiro
  privacidade: "completo", // "completo" | "abreviado"
  avisos: [], // recados lidos na TV de tempos em tempos
  modoTela: "avisos", // "video" | "avisos" — o que ocupa o lado esquerdo da TV
  frases: [],        // frases de orientação que passam em rodízio na TV
  farmacia: { ativo: false, itens: [] }, // medicamentos em falta
};

// Recupera o turno após reinicialização do servidor
try {
  if (fs.existsSync(ARQUIVO_ESTADO)) {
    const bruto = JSON.parse(fs.readFileSync(ARQUIVO_ESTADO, "utf8"));
    if (bruto && Array.isArray(bruto.chamadas)) {
      estado = bruto;
      if (!Array.isArray(estado.avisos)) estado.avisos = [];
      if (!estado.modoTela) estado.modoTela = "avisos";
      if (!Array.isArray(estado.frases)) estado.frases = [];
      if (!estado.farmacia) estado.farmacia = { ativo: false, itens: [] };
    }
    console.log(`Turno recuperado: ${estado.chamadas.length} chamada(s).`);
  }
} catch (e) {
  console.warn("Não foi possível ler o estado salvo, iniciando turno vazio.");
}

let timerGravacao = null;
function persistir() {
  clearTimeout(timerGravacao);
  timerGravacao = setTimeout(() => {
    fs.writeFile(ARQUIVO_ESTADO, JSON.stringify(estado), (err) => {
      if (err) console.error("Falha ao gravar estado:", err.message);
    });
  }, 300);
}

function difundirEstado() {
  io.emit("estado", Object.assign({ conteudoSalvo }, estado));
}

if (!estado.avisos.length) {
  estado.avisos.push({
    id: 1,
    texto: "Atenção: hoje teremos reunião de equipe e o funcionamento será diferente, das 7 às 15 horas.",
    minutos: 20,
    ativo: false, // a equipe liga no dia da reunião
    falar: true,  // false = aviso estático, só aparece na faixa da TV
    ultimoAnuncio: 0,
  });
}

// Frases de orientação que vêm prontas na primeira execução
if (!estado.frases.length) {
  estado.frases = [
    "Aguarde, seu nome aparecerá aqui em breve",
    "Fique atento à tela e ao chamado por voz",
    "Se precisar de ajuda, procure a recepção",
    "Mantenha seu cartão SUS e documento em mãos",
    "Ao ser chamado, dirija-se à sala indicada na tela",
    "Se precisar sair da sala de espera, avise a recepção",
  ].map((texto, i) => ({ id: i + 1, texto, ativo: true }));
}

// Recupera o conteúdo salvo (tem prioridade sobre o que veio do turno)
let conteudoSalvo = false;
try {
  if (fs.existsSync(ARQUIVO_CONTEUDO)) {
    const c = JSON.parse(fs.readFileSync(ARQUIVO_CONTEUDO, "utf8"));
    if (c && typeof c === "object") {
      if (Array.isArray(c.avisos)) estado.avisos = c.avisos;
      if (Array.isArray(c.frases) && c.frases.length) estado.frases = c.frases;
      if (c.farmacia) estado.farmacia = c.farmacia;
      if (c.modoTela) estado.modoTela = c.modoTela;
      conteudoSalvo = true;
      console.log(`Conteúdo da TV recuperado: ${estado.avisos.length} aviso(s), ` +
        `${estado.frases.length} frase(s), ${estado.farmacia.itens.length} medicamento(s).`);
    }
  }
} catch (e) {
  console.warn("Não foi possível ler o conteúdo salvo da TV.");
}

let timerConteudo = null;
function persistirConteudo() {
  conteudoSalvo = true; // marca já, para dois painéis não restaurarem em duplicidade
  clearTimeout(timerConteudo);
  timerConteudo = setTimeout(() => {
    const dados = {
      avisos: estado.avisos,
      frases: estado.frases,
      farmacia: estado.farmacia,
      modoTela: estado.modoTela,
      atualizadoEm: new Date().toISOString(),
    };
    fs.writeFile(ARQUIVO_CONTEUDO, JSON.stringify(dados), (err) => {
      if (err) console.error("Falha ao gravar conteúdo da TV:", err.message);
    });
  }, 300);
}

let proximoIdFrase = Math.max(0, ...estado.frases.map((f) => f.id)) + 1;
let proximoIdItem = Math.max(0, ...estado.farmacia.itens.map((i) => i.id || 0)) + 1;

let proximoId = Date.now();
let proximoIdAviso = Math.max(1, ...estado.avisos.map((a) => a.id)) + 1;

/* ------------------------------------------------------------------ */
/* Fila de anúncios                                                    */
/* Todas as chamadas passam por uma fila única em ordem de chegada.    */
/* O servidor calcula quando cada anúncio entra no ar e informa a      */
/* espera ao painel, para o profissional saber que a vez dele vem.     */
/* ------------------------------------------------------------------ */

// Estimativa por anúncio: bipes + frase falada (2x com fila curta, 1x quando
// a fila passa de 3, como a /tv faz para escoar mais rápido).
const DURACAO_ANUNCIO = 11000;
const DURACAO_ANUNCIO_RAPIDO = 6000;
let fimDoUltimoAnuncio = 0;

function agendarAnuncio() {
  const agora = Date.now();
  const inicio = Math.max(agora, fimDoUltimoAnuncio);
  const espera = inicio - agora;
  // fila grande => a TV encurta o anúncio, então a estimativa acompanha
  const duracao = espera > 3 * DURACAO_ANUNCIO ? DURACAO_ANUNCIO_RAPIDO : DURACAO_ANUNCIO;
  fimDoUltimoAnuncio = inicio + duracao;
  return { espera, ordem: Math.round(espera / duracao) };
}

/* ------------------------------------------------------------------ */
/* Eventos                                                             */
/* ------------------------------------------------------------------ */

io.on("connection", (socket) => {
  socket.emit("estado", Object.assign({ conteudoSalvo }, estado));

  // Conexões da TV são somente-leitura: qualquer tentativa de escrita
  // (chamar, mudar status, encerrar turno) é ignorada. Também não entram na
  // sala "equipe", portanto não recebem nada do chat.
  if (socket.data.somenteLeitura) return;

  /* --- Chat da equipe --- */
  socket.join("equipe");

  // O painel se identifica ao conectar e a cada troca de nome ou sala.
  socket.on("chat-entrar", (perfil) => {
    const nome = String((perfil && perfil.nome) || "").trim().slice(0, 60);
    const chave = chaveNome(nome);
    const anterior = presentes.get(socket.id);
    if (anterior && anterior.chave && anterior.chave !== chave) {
      socket.leave("u:" + anterior.chave);
    }
    if (chave) {
      socket.join("u:" + chave);
      presentes.set(socket.id, {
        nome,
        chave,
        categoria: String((perfil && perfil.categoria) || "").trim().slice(0, 60),
        sala: String((perfil && perfil.sala) || "").trim().slice(0, 60),
        desde: (anterior && anterior.chave === chave) ? anterior.desde : Date.now(),
      });
    } else {
      presentes.delete(socket.id);
    }
    socket.data.chatChave = chave;
    socket.data.chatNome = nome;
    limparChatAntigo();
    socket.emit("chat-historico", {
      mensagens: mensagensVisiveis(chave),
      eu: chave,
      retencaoHoras: RETENCAO_CHAT / 3600000,
    });
    difundirPresenca();
  });

  // Uma mensagem a cada 1,5 s por aparelho, para um clique preso não
  // encher a tela dos colegas.
  let ultimaMsg = 0;

  socket.on("chat-mensagem", (dados) => {
    const de = socket.data.chatNome;
    const deChave = socket.data.chatChave;
    if (!de || !deChave) return; // sem nome preenchido não envia
    const texto = String((dados && dados.texto) || "").trim().slice(0, TAMANHO_MENSAGEM);
    if (!texto) return;
    const agora = Date.now();
    if (agora - ultimaMsg < 1500) return;
    ultimaMsg = agora;

    const paraChave = chaveNome((dados && dados.para) || "");
    let paraNome = "";
    if (paraChave) {
      // O destinatário precisa estar (ou ter estado) presente na lista
      const alvo = [...presentes.values()].find((p) => p.chave === paraChave);
      paraNome = alvo ? alvo.nome : String(dados.paraNome || "").trim().slice(0, 60);
      if (!paraNome) return;
    }

    const msg = {
      id: proximoIdMsg++,
      hora: new Date().toISOString(),
      de,
      deChave,
      categoria: (presentes.get(socket.id) || {}).categoria || "",
      sala: (presentes.get(socket.id) || {}).sala || "",
      texto,
      paraChave: paraChave || null,
      paraNome: paraNome || null,
    };
    mensagens.push(msg);
    limparChatAntigo();
    gravarChat();

    if (paraChave) {
      // Mensagem direta: só os aparelhos de quem enviou e de quem recebe
      io.to("u:" + deChave).to("u:" + paraChave).emit("chat-mensagem", msg);
    } else {
      io.to("equipe").emit("chat-mensagem", msg);
    }
  });

  socket.on("disconnect", () => {
    if (presentes.delete(socket.id)) difundirPresenca();
  });

  // Nova chamada vinda do /painel
  socket.on("chamar", (dados) => {
    if (!dados || (dados.modo !== "nome" && dados.modo !== "senha")) return;
    const chamada = {
      id: ++proximoId,
      modo: dados.modo,
      paciente: dados.modo === "nome" ? String(dados.paciente || "").trim() : "",
      senha: dados.modo === "senha" ? String(dados.senha || "").trim() : "",
      profissional: String(dados.profissional || "").trim(),
      categoria: String(dados.categoria || "").trim(),
      sala: String(dados.sala || "").trim(),
      hora: new Date().toISOString(),
      vezes: 1,
      status: "aguardando",
    };
    if (chamada.modo === "nome" && !chamada.paciente) return;
    if (chamada.modo === "senha" && !chamada.senha) return;
    estado.chamadas.unshift(chamada);
    persistir();
    difundirEstado();
    const agenda = agendarAnuncio();
    io.emit("anunciar", { chamada, rechamada: false, ...agenda });
  });

  // Rechamar (repete som e destaque, incrementa contador)
  socket.on("rechamar", (id) => {
    const chamada = estado.chamadas.find((c) => c.id === id);
    if (!chamada) return;
    chamada.vezes += 1;
    chamada.hora = new Date().toISOString();
    persistir();
    difundirEstado();
    const agenda = agendarAnuncio();
    io.emit("anunciar", { chamada, rechamada: true, ...agenda });
  });

  // Mudança de status: nunca dispara áudio, só atualiza telas
  socket.on("status", ({ id, status }) => {
    const validos = ["aguardando", "atendimento", "atendido", "faltante"];
    const chamada = estado.chamadas.find((c) => c.id === id);
    if (!chamada || !validos.includes(status)) return;
    chamada.status = status;
    persistir();
    difundirEstado();
  });

  // --- Emergência (código de segurança) ---
  // Não entra no histórico do turno (não é chamada de paciente), mas fica
  // registrado sem nomes no histórico mensal, para a unidade acompanhar.
  socket.on("emergencia", ({ sala }) => {
    const local = String(sala || "").trim().slice(0, 60) || "recepção";
    const evento = { local, hora: new Date().toISOString() };
    historicoMensal.push({
      hora: evento.hora, sala: local, categoria: "Emergência",
      modo: "emergencia", vezes: 1, status: "emergencia",
    });
    gravarMensal();
    // prioridade: vai na frente de tudo que estiver na fila
    io.emit("emergencia", evento);
  });

  // Escolhe o que ocupa o lado esquerdo da TV
  socket.on("modo-tela", (modo) => {
    if (modo !== "video" && modo !== "avisos") return;
    estado.modoTela = modo;
    persistir();
    persistirConteudo();
    difundirEstado();
  });

  // Restaura avisos, frases e farmácia a partir da cópia guardada no
  // navegador do painel. Serve quando o servidor perde o arquivo (por
  // exemplo, num novo deploy do Render, cujo disco é temporário).
  socket.on("restaurar-conteudo", (dados) => {
    if (!dados || conteudoSalvo) return; // nunca sobrescreve o que já existe
    if (Array.isArray(dados.avisos)) estado.avisos = dados.avisos.slice(0, 30);
    if (Array.isArray(dados.frases) && dados.frases.length) estado.frases = dados.frases.slice(0, 40);
    if (dados.farmacia && Array.isArray(dados.farmacia.itens)) estado.farmacia = dados.farmacia;
    if (dados.modoTela === "video" || dados.modoTela === "avisos") estado.modoTela = dados.modoTela;
    proximoIdAviso = Math.max(0, ...estado.avisos.map((a) => a.id || 0)) + 1;
    proximoIdFrase = Math.max(0, ...estado.frases.map((f) => f.id || 0)) + 1;
    proximoIdItem = Math.max(0, ...estado.farmacia.itens.map((i) => i.id || 0)) + 1;
    persistirConteudo();
    difundirEstado();
    console.log("Conteúdo da TV restaurado a partir do painel.");
  });

  // --- Frases de orientação ---
  socket.on("frase-adicionar", (texto) => {
    const t = String(texto || "").trim().slice(0, 160);
    if (!t) return;
    estado.frases.push({ id: proximoIdFrase++, texto: t, ativo: true });
    persistir();
    persistirConteudo();
    difundirEstado();
  });

  socket.on("frase-alternar", (id) => {
    const f = estado.frases.find((x) => x.id === id);
    if (!f) return;
    f.ativo = !f.ativo;
    persistir();
    persistirConteudo();
    difundirEstado();
  });

  socket.on("frase-remover", (id) => {
    estado.frases = estado.frases.filter((f) => f.id !== id);
    persistir();
    persistirConteudo();
    difundirEstado();
  });

  // --- Farmácia: medicamentos em falta ---
  socket.on("farmacia-adicionar", (nome) => {
    const n = String(nome || "").trim().slice(0, 80);
    if (!n) return;
    estado.farmacia.itens.push({ id: proximoIdItem++, nome: n });
    if (estado.farmacia.itens.length === 1) estado.farmacia.ativo = true;
    persistir();
    persistirConteudo();
    difundirEstado();
  });

  socket.on("farmacia-remover", (id) => {
    estado.farmacia.itens = estado.farmacia.itens.filter((i) => i.id !== id);
    persistir();
    persistirConteudo();
    difundirEstado();
  });

  socket.on("farmacia-alternar", () => {
    estado.farmacia.ativo = !estado.farmacia.ativo;
    persistir();
    persistirConteudo();
    difundirEstado();
  });

  socket.on("farmacia-limpar", () => {
    estado.farmacia = { ativo: false, itens: [] };
    persistir();
    persistirConteudo();
    difundirEstado();
  });

  // --- Avisos ---
  socket.on("aviso-adicionar", ({ texto, minutos, falar }) => {
    const t = String(texto || "").trim().slice(0, 300);
    if (!t) return;
    estado.avisos.push({
      id: proximoIdAviso++,
      texto: t,
      minutos: Math.max(5, Math.min(240, parseInt(minutos, 10) || 30)),
      ativo: true,
      falar: falar !== false, // padrão: com áudio
      ultimoAnuncio: 0,
    });
    persistir();
    persistirConteudo();
    difundirEstado();
  });

  socket.on("aviso-remover", (id) => {
    estado.avisos = estado.avisos.filter((a) => a.id !== id);
    persistir();
    persistirConteudo();
    difundirEstado();
  });

  socket.on("aviso-alternar", (id) => {
    const a = estado.avisos.find((x) => x.id === id);
    if (!a) return;
    a.ativo = !a.ativo;
    a.ultimoAnuncio = 0; // ao ligar, entra na próxima verificação
    persistir();
    persistirConteudo();
    difundirEstado();
  });

  socket.on("aviso-alternar-audio", (id) => {
    const a = estado.avisos.find((x) => x.id === id);
    if (!a) return;
    a.falar = !a.falar;
    a.ultimoAnuncio = 0;
    persistir();
    persistirConteudo();
    difundirEstado();
  });

  socket.on("aviso-editar", ({ id, texto, minutos }) => {
    const a = estado.avisos.find((x) => x.id === id);
    if (!a) return;
    if (texto !== undefined) a.texto = String(texto).trim().slice(0, 300) || a.texto;
    if (minutos !== undefined) a.minutos = Math.max(5, Math.min(240, parseInt(minutos, 10) || a.minutos));
    persistir();
    persistirConteudo();
    difundirEstado();
  });

  socket.on("aviso-ler-agora", (id) => {
    const a = estado.avisos.find((x) => x.id === id);
    if (!a || a.falar === false) return;
    a.ultimoAnuncio = Date.now();
    persistir();
    io.emit("anunciar-aviso", { aviso: a, ...agendarAnuncio() });
  });

  // Alternância de privacidade (nome completo x abreviado)
  socket.on("privacidade", (modo) => {
    if (modo !== "completo" && modo !== "abreviado") return;
    estado.privacidade = modo;
    persistir();
    difundirEstado();
  });

  // Limpa a lista de chamadas sem encerrar o turno. Os registros sem nomes
  // continuam indo para o histórico mensal, como no encerramento.
  socket.on("limpar-historico", () => {
    for (const c of estado.chamadas) {
      historicoMensal.push({
        hora: c.hora, sala: c.sala, categoria: c.categoria,
        modo: c.modo, vezes: c.vezes, status: c.status,
      });
    }
    gravarMensal();
    estado.chamadas = [];
    persistir();
    difundirEstado();
    io.emit("historico-limpo");
  });

  // Encerrar turno: arquiva registros SEM nomes no histórico mensal e
  // apaga o histórico com nomes (LGPD — nomes não persistem)
  socket.on("encerrar-turno", () => {
    for (const c of estado.chamadas) {
      historicoMensal.push({
        hora: c.hora, sala: c.sala, categoria: c.categoria,
        modo: c.modo, vezes: c.vezes, status: c.status,
      });
    }
    gravarMensal();
    estado.chamadas = [];
    persistir();
    difundirEstado();
    io.emit("turno-encerrado");
  });
});

/* ------------------------------------------------------------------ */

// Verifica periodicamente quais avisos devem ir ao ar. O anúncio entra na
// mesma fila das chamadas, então nunca se sobrepõe a uma chamada de paciente.
setInterval(() => {
  const agora = Date.now();
  for (const a of estado.avisos) {
    if (!a.ativo || a.falar === false) continue; // estático: só faixa, sem áudio
    const intervalo = a.minutos * 60 * 1000;
    if (agora - (a.ultimoAnuncio || 0) < intervalo) continue;
    a.ultimoAnuncio = agora;
    persistir();
    persistirConteudo();
    io.emit("anunciar-aviso", { aviso: a, ...agendarAnuncio() });
  }
}, 15000);

// Faxina do chat: de dez em dez minutos apaga o que passou de 24 horas.
setInterval(() => {
  if (limparChatAntigo()) gravarChat();
}, 10 * 60 * 1000);

server.listen(PORT, () => {
  const os = require("os");
  const redes = os.networkInterfaces();
  const ips = [];
  for (const nome of Object.keys(redes)) {
    for (const rede of redes[nome]) {
      if (rede.family === "IPv4" && !rede.internal) ips.push(rede.address);
    }
  }
  console.log("");
  console.log("Sistema de Chamada — CS Monte Serrat");
  console.log("------------------------------------");
  console.log(`Painel do profissional:  http://localhost:${PORT}/painel`);
  console.log(`TV da recepção:          http://localhost:${PORT}/tv`);
  if (ips.length) {
    console.log("");
    console.log("Na rede local, use um destes endereços nos outros dispositivos:");
    ips.forEach((ip) => console.log(`  http://${ip}:${PORT}/painel   |   http://${ip}:${PORT}/tv`));
  }
  console.log("");
});
