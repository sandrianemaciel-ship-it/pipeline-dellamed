"use strict";
// Serviço de sincronização Qlik -> Firestore da Pipeline de Retenção.
//   node index.js --once       roda uma vez e sai
//   node index.js --dry-run    lê o Qlik e mostra o que faria, sem gravar
//   node index.js              fica rodando: agenda (CRON) + atende o botão da página
//   --limpar                   antes de gravar, remove os clientes gravados com
//                              colunas trocadas (junto com --dry-run, só mostra)
process.env.TZ = process.env.TZ || "America/Sao_Paulo"; // "mês atual" das regras = horário de Brasília
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const cron = require("node-cron");
const admin = require("firebase-admin");
const { fetchTable, fetchPedidos, discoverApp } = require("./qlik");
const { mapRows } = require("./mapping");
const { groupByMonth, commitMonth, cleanupMonth, indexPedidos, commitPedidosMonth, closeMonth, removeFutureMonth } = require("./firestoreSync");

const args = new Set(process.argv.slice(2));
const DRY = args.has("--dry-run");
const ONCE = args.has("--once") || DRY;
const RECONHECER = args.has("--reconhecer");
const LIMPAR = args.has("--limpar") || process.env.LIMPAR_COLUNAS_TROCADAS === "true";

function log(...a){ console.log(new Date().toLocaleString("pt-BR"), "-", ...a); }

function loadConfig(){
  // Limpa espaços/quebras de linha que às vezes vêm junto ao colar os segredos.
  const e = {};
  Object.entries(process.env).forEach(([k, v]) => { e[k] = typeof v === "string" ? v.trim() : v; });
  if(e.QLIK_HOST) e.QLIK_HOST = e.QLIK_HOST.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  const need = (k) => { if(!e[k]) throw new Error(`Faltou ${k} no arquivo .env`); return e[k]; };
  const authMode = (e.QLIK_AUTH || "jwt").toLowerCase();
  const qlik = {
    host: need("QLIK_HOST"),
    appId: need("QLIK_APP_ID"),
    objectId: e.QLIK_OBJECT_ID || null,
    fields: e.QLIK_FIELDS ? e.QLIK_FIELDS.split("|").map(s => s.trim()).filter(Boolean) : null,
    authMode,
    virtualProxy: e.QLIK_VIRTUAL_PROXY || "",
    jwt: authMode === "jwt" ? need("QLIK_JWT") : null,
    certRoot: e.QLIK_CERT_ROOT, certClient: e.QLIK_CERT_CLIENT, certKey: e.QLIK_CERT_KEY,
    enginePort: Number(e.QLIK_ENGINE_PORT || 4747),
    userDirectory: e.QLIK_USER_DIRECTORY || "INTERNAL", userId: e.QLIK_USER_ID || "sa_api",
    rejectUnauthorized: e.QLIK_REJECT_UNAUTHORIZED !== "false"
  };
  if(authMode === "cert") ["QLIK_CERT_ROOT", "QLIK_CERT_CLIENT", "QLIK_CERT_KEY"].forEach(need);
  const mapFile = path.resolve(e.COLUMN_MAP_FILE || "config/column-map.json");
  const columnMap = fs.existsSync(mapFile) ? JSON.parse(fs.readFileSync(mapFile, "utf8")) : {};
  return {
    qlik, columnMap,
    serviceAccount: e.FIREBASE_SERVICE_ACCOUNT || "config/firebase-service-account.json",
    cron: e.SYNC_CRON || "0 7 * * 1-5",
    fromMonth: e.SYNC_FROM_MONTH || "2026-09",
    pedidosAppId: e.QLIK_PEDIDOS_APP_ID || null,
    fechamento: e.SYNC_FECHAMENTO !== "false"
  };
}

let db = null;
function initFirestore(cfg){
  if(db) return db;
  // No GitHub Actions a chave vem inteira num segredo (FIREBASE_SERVICE_ACCOUNT_JSON);
  // numa máquina local, vem do arquivo indicado em FIREBASE_SERVICE_ACCOUNT.
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON
    || fs.readFileSync(path.resolve(cfg.serviceAccount), "utf8");
  const sa = JSON.parse(raw);
  admin.initializeApp({ credential: admin.credential.cert(sa) });
  db = admin.firestore();
  return db;
}

async function setStatus(data){
  if(!db || DRY) return; // simulação não grava nada
  await db.doc("sync/status").set({ ...data, updatedAt: new Date().toISOString() }, { merge: true });
}

let running = false;
async function runSync(cfg, origem){
  if(running){ log("Sincronização já em andamento — pedido ignorado."); return; }
  running = true;
  const startedAt = new Date().toISOString();
  try{
    log(`Iniciando sincronização (${origem})...`);
    await setStatus({ state: "running", origem, startedAt, message: "Buscando dados no Qlik..." });
    const table = await fetchTable(cfg.qlik, log);
    const { records, unmapped, semData } = mapRows(table, cfg.columnMap);
    if(unmapped.length) log("Colunas do Qlik ignoradas (sem correspondência):", unmapped.join(", "));
    if(semData) log(`${semData} linhas sem Data Inativação foram ignoradas.`);
    if(!records.length) throw new Error("Nenhuma linha válida (confira as colunas Cód Cliente e Data Inativação).");
    const semVend = records.filter(r => !(r.vendInt || r.keyAcc || r.prospect || r.rep || r.sucCli)).length;
    if(semVend / records.length > 0.7) log(`ATENÇÃO: ${semVend}/${records.length} sem Representante/Vendedor — confira o mapeamento de colunas.`);

    if(LIMPAR) await limparColunasTrocadas(cfg, records);
    const byMonth = groupByMonth(records, cfg.fromMonth);
    // Um mês por vez: só o mês vigente recebe clientes (Data de Inativação de
    // 01 ao último dia do mês). Meses anteriores ficam fechados/congelados e
    // os seguintes entram quando chegar o dia 01 deles.
    const atual = mesAtual();
    const meses = Object.keys(byMonth).filter(mk => mk === atual);
    const baseBI = { total: (byMonth[atual] || []).length, de: `${atual}-01`, ate: ultimoDia(atual) };
    log(`Base do BI em ${atual}: ${baseBI.total} clientes com Data de Inativação de ${fmtBR(baseBI.de)} a ${fmtBR(baseBI.ate)}.`);
    await removerMesesFuturos(atual);
    if(DRY){
      await pedidosEFechamento(cfg);
      meses.forEach(mk => log(`[simulação] ${mk}: ${byMonth[mk].length} clientes`));
      // Distribuição de TODAS as Datas de Inativação (inclusive antes de
      // SYNC_FROM_MONTH), para conferir se a coluna lida é mesmo a certa.
      const porMes = {};
      records.forEach(r => { const mk = r.dtInat.slice(0, 7); porMes[mk] = (porMes[mk] || 0) + 1; });
      const todos = Object.keys(porMes).sort();
      log(`[simulação] Data Inativação vai de ${records.reduce((m, r) => r.dtInat < m ? r.dtInat : m, "9999")} a ${records.reduce((m, r) => r.dtInat > m ? r.dtInat : m, "0000")}.`);
      log("[simulação] Clientes por mês de inativação (últimos 18 meses lidos):",
        todos.slice(-18).map(mk => `${mk}=${porMes[mk]}`).join(", "));
      log("Exemplo do primeiro registro:", JSON.stringify(records[0]));
      const ex = records.filter(r => r.dtInat.slice(0, 7) >= cfg.fromMonth).slice(0, 3);
      ex.forEach(r => log("Exemplo a partir de " + cfg.fromMonth + ":", JSON.stringify(r)));
      return;
    }
    const resumo = [];
    const label = `Qlik ${cfg.qlik.appId}${cfg.qlik.objectId ? "/" + cfg.qlik.objectId : ""}`;
    for(const mk of meses){
      const r = await commitMonth(db, mk, byMonth[mk], label, baseBI);
      log(`${mk}: ${r.novos} novos, ${r.atualizados} atualizados`);
      resumo.push(r);
    }
    const novos = resumo.reduce((s, r) => s + r.novos, 0);
    const atualizados = resumo.reduce((s, r) => s + r.atualizados, 0);
    const extra = await pedidosEFechamento(cfg);
    await setStatus({
      state: "ok", origem, startedAt, finishedAt: new Date().toISOString(),
      message: `${novos} novos e ${atualizados} atualizados em ${meses.length} mês(es). ${extra}`.trim(),
      meses: resumo
    });
    log("Sincronização concluída.");
  }catch(err){
    log("ERRO:", err && err.message || err);
    await setStatus({ state: "error", origem, startedAt, finishedAt: new Date().toISOString(),
      message: String(err && err.message || err) }).catch(() => {});
    if(ONCE) process.exitCode = 1;
  }finally{
    running = false;
  }
}

// Depois de gravar os clientes: busca os pedidos do Qlik para os meses ainda
// abertos (tag "PEDIDO IDENTIFICADO, MOVA PARA GANHO" e valor do pedido) e,
// a partir do dia 01, fecha e congela os meses anteriores ao atual.
function mesAtual(){
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}
const fmtBR = (iso) => iso.split("-").reverse().join("/");
async function removerMesesFuturos(atual){
  const tag = DRY ? "[simulação] " : "";
  const snap = await db.collection("months").get();
  for(const mk of snap.docs.map(d => d.id).filter(id => /^\d{4}-\d{2}$/.test(id) && id > atual).sort()){
    const r = await removeFutureMonth(db, mk, { dryRun: DRY });
    if(r.apagado) log(`${tag}${mk}: mês futuro removido (${r.total} clientes, nenhum trabalhado). Volta no dia 01 do mês.`);
    else log(`${tag}${mk}: mês futuro mantido — ${r.trabalhados.length} cliente(s) já trabalhado(s): ${r.trabalhados.slice(0, 20).map(x => `${x.cod} [${x.motivo}]`).join(", ")}`);
  }
}
function ultimoDia(mk){
  const [y, m] = mk.split("-").map(Number);
  return `${mk}-${String(new Date(y, m, 0).getDate()).padStart(2, "0")}`;
}
async function pedidosEFechamento(cfg){
  const tag = DRY ? "[simulação] " : "";
  const snap = await db.collection("months").get();
  const abertos = snap.docs.filter(d => /^\d{4}-\d{2}$/.test(d.id) && d.id >= cfg.fromMonth && !d.data().fechado)
    .map(d => d.id).sort();
  if(!abertos.length) return "";
  const d = new Date();
  const hoje = `${mesAtual()}-${String(d.getDate()).padStart(2, "0")}`;
  const fim = ultimoDia(abertos[abertos.length - 1]) < hoje ? ultimoDia(abertos[abertos.length - 1]) : hoje;
  const pedidos = await fetchPedidos({ ...cfg.qlik, appId: cfg.pedidosAppId || cfg.qlik.appId }, `${abertos[0]}-01`, fim, log);
  // Trava: nenhum pedido no período inteiro não é plausível (leitura falhou ou
  // o filtro de data não bateu). Sem pedidos, não mexe em tags nem fecha mês,
  // para não mandar todo mundo para Perdido por engano.
  if(!pedidos.length){
    log("ATENÇÃO: nenhum pedido encontrado no Qlik para o período — tags e fechamento do mês não foram aplicados nesta execução.");
    return "Pedidos: nenhum encontrado no Qlik (tags e fechamento suspensos).";
  }
  const porCod = indexPedidos(pedidos);
  let tags = 0, novasTags = 0;
  for(const mk of abertos){
    const r = await commitPedidosMonth(db, mk, porCod, { dryRun: DRY });
    tags += r.identificados; novasTags += r.novos;
    if(r.identificados || r.removidos) log(`${tag}${mk}: ${r.identificados} cliente(s) com pedido identificado (${r.novos} novos, ${r.removidos} tags removidas).`);
  }
  if(cfg.fechamento === false) return `${tags} com pedido identificado.`;
  const atual = mesAtual();
  const fechados = [];
  for(const mk of abertos.filter(m => m < atual)){
    const r = await closeMonth(db, mk, { dryRun: DRY, pedidosByCod: porCod });
    if(r.jaFechado) continue;
    log(`${tag}Fechamento ${mk}: ${r.ganhoAuto} movidos para Ganho (pedido identificado) e ${r.perdidoAuto} para Negociação Perdida, sem ação do vendedor. Mês congelado.`);
    fechados.push(`${mk} (${r.ganhoAuto} ganho auto, ${r.perdidoAuto} perdido auto)`);
  }
  return `${tags} com pedido identificado (${novasTags} novos).` + (fechados.length ? ` Mês(es) fechado(s): ${fechados.join(", ")}.` : "");
}

// Remove do Firestore os clientes que foram gravados com as colunas do Qlik
// trocadas (antes da correção do qColumnOrder). Detalhes em firestoreSync.js.
async function limparColunasTrocadas(cfg, records){
  const freshByCod = {};
  records.forEach(r => { freshByCod[r.cod] = r; });
  const snap = await db.collection("months").get();
  const meses = snap.docs.map(d => d.id).filter(id => /^\d{4}-\d{2}$/.test(id) && id >= cfg.fromMonth).sort();
  const tag = DRY ? "[simulação] " : "";
  let total = 0;
  for(const mk of meses){
    const r = await cleanupMonth(db, mk, freshByCod, { dryRun: DRY });
    total += r.removidos.length;
    if(r.removidos.length){
      log(`${tag}Limpeza ${mk}: ${r.removidos.length} cliente(s) com colunas trocadas removido(s)${r.mesApagado ? " (mês ficou vazio e foi apagado)" : ""}.`);
      r.removidos.slice(0, 20).forEach(x => log(`   - ${x.cod}: ${x.motivo}`));
      if(r.removidos.length > 20) log(`   ... e mais ${r.removidos.length - 20}.`);
    }
    if(r.revisar.length){
      log(`${tag}Limpeza ${mk}: ${r.revisar.length} cliente(s) suspeito(s) já trabalhado(s) pelo vendedor — mantidos, revisar à mão:`);
      const porMotivo = {};
      r.revisar.forEach(x => { porMotivo[x.trabalhado] = (porMotivo[x.trabalhado] || 0) + 1; });
      log("   Por que contam como trabalhados:", Object.entries(porMotivo).map(([k, v]) => `${k}=${v}`).join(", "));
      r.revisar.forEach(x => log(`   - ${x.cod}: ${x.motivo} [${x.trabalhado}]`));
    }
  }
  log(`${tag}Limpeza concluída: ${total} cliente(s) removido(s) em ${meses.length} mês(es) verificados.`);
}

async function main(){
  const cfg = loadConfig();
  if(RECONHECER){
    // Só leitura: mostra pastas, objetos, fórmulas e campos dos apps.
    const ids = [...new Set([cfg.qlik.appId, process.env.QLIK_PEDIDOS_APP_ID].filter(Boolean))];
    for(const appId of ids){
      try{ await discoverApp({ ...cfg.qlik, appId }, log); }
      catch(e){ log(`Reconhecimento do app ${appId} falhou: ${e.message}`); }
    }
    return;
  }
  initFirestore(cfg); // na simulação só lê
  if(ONCE){ await runSync(cfg, DRY ? "simulação" : "manual"); return; }

  // 1) Agenda automática
  if(!cron.validate(cfg.cron)) throw new Error("SYNC_CRON inválido: " + cfg.cron);
  cron.schedule(cfg.cron, () => runSync(cfg, "agendada"), { timezone: "America/Sao_Paulo" });
  log(`Agendado: "${cfg.cron}" (horário de Brasília).`);

  // 2) Botão "Sincronizar com Qlik" da página: ela grava sync/request.
  let lastHandled = null;
  const statusSnap = await db.doc("sync/status").get();
  if(statusSnap.exists) lastHandled = statusSnap.data().lastRequestAt || null;
  db.doc("sync/request").onSnapshot(snap => {
    if(!snap.exists) return;
    const req = snap.data();
    if(!req.requestedAt || req.requestedAt === lastHandled) return;
    lastHandled = req.requestedAt;
    setStatus({ lastRequestAt: req.requestedAt, requestedBy: req.requestedBy || null }).catch(() => {});
    runSync(cfg, "botão" + (req.requestedBy ? ` (${req.requestedBy})` : ""));
  }, err => log("Erro ao escutar pedidos da página:", err.message));
  log("Escutando o botão da página. Deixe este processo rodando.");
}

main().catch(err => { log("Falha ao iniciar:", err.message); process.exit(1); });
