"use strict";
// Leitura de uma tabela do Qlik pela Engine API.
// Suporta dois tipos de autenticação:
//   • JWT  — chave de API / token no header (Qlik Cloud ou virtual proxy JWT).
//   • CERT — certificados exportados do QMC (client.pem, client_key.pem, root.pem),
//            conexão direta na porta 4747 com o usuário no header X-Qlik-User.
const fs = require("fs");
const enigma = require("enigma.js");
const WebSocket = require("ws");
const schema = require("enigma.js/schemas/12.2027.0.json");

const PAGE_CELLS = 10000; // limite de células por página do Engine

function buildSocketUrl(cfg){
  const appPath = "app/" + encodeURIComponent(cfg.appId);
  if(cfg.authMode === "cert"){
    return `wss://${cfg.host}:${cfg.enginePort || 4747}/${appPath}`;
  }
  const prefix = cfg.virtualProxy ? "/" + cfg.virtualProxy.replace(/^\/|\/$/g, "") : "";
  return `wss://${cfg.host}${prefix}/${appPath}`;
}

function buildSocketOptions(cfg){
  const opts = { rejectUnauthorized: cfg.rejectUnauthorized !== false };
  if(cfg.authMode === "cert"){
    opts.ca = [fs.readFileSync(cfg.certRoot)];
    opts.cert = fs.readFileSync(cfg.certClient);
    opts.key = fs.readFileSync(cfg.certKey);
    opts.headers = { "X-Qlik-User": `UserDirectory=${cfg.userDirectory}; UserId=${cfg.userId}` };
  }else{
    opts.headers = { Authorization: "Bearer " + cfg.jwt };
  }
  return opts;
}

// Converte uma célula do Qlik no valor mais útil para o mapeamento:
// número de verdade quando existe (valores/datas), texto nos demais casos.
function cellValue(cell){
  if(!cell || cell.qIsNull) return null;
  const hasNum = typeof cell.qNum === "number" && isFinite(cell.qNum);
  return { text: cell.qText != null ? cell.qText : null, num: hasNum ? cell.qNum : null };
}

// O Engine devolve as colunas do qMatrix na ordem de qColumnOrder (a ordem
// em que a tabela aparece na planilha), não "dimensões e depois medidas".
// Se a tabela foi reordenada no Qlik e os cabeçalhos não acompanharem, os
// valores caem na coluna errada (ex.: Data Cadastro gravada como Data
// Inativação).
function orderedHeaders(hc){
  const base = (hc.qDimensionInfo || []).map(d => d.qFallbackTitle)
    .concat((hc.qMeasureInfo || []).map(m => m.qFallbackTitle));
  const order = hc.qColumnOrder;
  const valid = Array.isArray(order) && order.length === base.length
    && order.every(i => Number.isInteger(i) && i >= 0 && i < base.length)
    && new Set(order).size === base.length;
  return valid ? order.map(i => base[i]) : base;
}

async function readAllPages(obj, layout){
  const hc = layout.qHyperCube;
  const width = hc.qSize.qcx;
  const total = hc.qSize.qcy;
  const pageHeight = Math.max(1, Math.floor(PAGE_CELLS / width));
  const rows = [];
  for(let top = 0; top < total; top += pageHeight){
    const pages = await obj.getHyperCubeData("/qHyperCubeDef", [
      { qTop: top, qLeft: 0, qWidth: width, qHeight: Math.min(pageHeight, total - top) }
    ]);
    for(const r of pages[0].qMatrix) rows.push(r.map(cellValue));
  }
  return rows;
}

// Retorna { headers: [..], rows: [[{text,num}|null, ...], ...] }
async function fetchTable(cfg, log = console.log){
  // Guarda o motivo real quando o Qlik recusa/fecha a conexão, para o log
  // não mostrar só "Socket closed".
  const diag = { http: null, code: null, reason: "" };
  const url = buildSocketUrl(cfg);
  const session = enigma.create({
    schema,
    url,
    createSocket: (u) => {
      const ws = new WebSocket(u, buildSocketOptions(cfg));
      ws.on("close", (code, reason) => { diag.code = diag.code || code; diag.reason = diag.reason || String(reason || ""); });
      return ws;
    }
  });
  try{
    const global = await session.open();
    const app = await global.openDoc(cfg.appId); // abre o app com os dados carregados
    let obj, headers;
    if(cfg.objectId){
      // Opção 1: ler uma tabela já existente no app (ID do objeto).
      obj = await app.getObject(cfg.objectId);
      const layout = await obj.getLayout();
      const hc = layout.qHyperCube;
      if(!hc) throw new Error(`O objeto ${cfg.objectId} não é uma tabela/gráfico com hipercubo.`);
      headers = orderedHeaders(hc);
      log(`Qlik: objeto ${cfg.objectId} com ${hc.qSize.qcy} linhas x ${hc.qSize.qcx} colunas.`);
      log(`Qlik: qColumnOrder = ${JSON.stringify(hc.qColumnOrder || [])}; colunas na ordem lida: ${headers.join(" | ")}`);
      const rows = await readAllPages(obj, layout);
      return { headers, rows };
    }
    // Opção 2: montar a tabela na hora a partir de uma lista de campos.
    const fields = cfg.fields;
    if(!fields || !fields.length) throw new Error("Defina QLIK_OBJECT_ID ou QLIK_FIELDS no .env.");
    obj = await app.createSessionObject({
      qInfo: { qType: "pipeline-sync" },
      qHyperCubeDef: {
        qDimensions: fields.map(f => ({ qDef: { qFieldDefs: [f], qFieldLabels: [f] }, qNullSuppression: false })),
        qMeasures: [],
        qSuppressZero: false,
        qSuppressMissing: false,
        qInitialDataFetch: []
      }
    });
    const layout = await obj.getLayout();
    headers = fields.slice();
    log(`Qlik: tabela montada com ${layout.qHyperCube.qSize.qcy} linhas x ${fields.length} campos.`);
    const rows = await readAllPages(obj, layout);
    return { headers, rows };
  }catch(err){
    // Erros de conexão (chave recusada, sem acesso ao app etc.) viram uma
    // mensagem clara; demais erros (ex.: objeto inexistente) seguem como estão.
    const m = /Unexpected server response: (\d+)/.exec(err && err.message || "");
    if(m) diag.http = Number(m[1]);
    if(diag.http || diag.code || /socket|ECONN|ENOTFOUND|ETIMEDOUT/i.test(err && err.message || "")){
      throw new Error(explainSocketError(err, diag, url));
    }
    throw err;
  }finally{
    try{ await session.close(); }catch(e){ /* ignora */ }
  }
}

function explainSocketError(err, d, url){
  const parts = [`Não foi possível conectar ao Qlik (${url}).`];
  if(d.http) parts.push(`Resposta HTTP ${d.http}.`);
  if(d.code) parts.push(`Código de fechamento ${d.code}.`);
  if(d.reason) parts.push(`Motivo: ${d.reason}`);
  if(!d.http && err && err.message) parts.push(`Detalhe: ${err.message}.`);
  const c = d.http || d.code;
  if(c === 401 || c === 403 || c === 4401 || c === 4403)
    parts.push("→ A chave de API (QLIK_JWT) foi recusada: confira se foi colada inteira, sem espaços, e se não expirou.");
  else if(c === 404 || c === 4204 || c === 4205)
    parts.push("→ App não encontrado ou sem acesso: confira o QLIK_APP_ID e se o dono da chave tem acesso a esse app (espaço compartilhado/gerenciado).");
  else if(c === 1006 || c === 4202 || c === 4203)
    parts.push("→ O Qlik encerrou a conexão: geralmente é chave sem permissão para o app, ou o usuário da chave não tem o papel de acesso ao espaço do app.");
  return parts.join(" ");
}

module.exports = { fetchTable, buildSocketUrl, cellValue, readAllPages, orderedHeaders };
