"use strict";
// Leitura de uma tabela do Qlik Sense Enterprise (on-premise) pela Engine API.
// Suporta dois tipos de autenticação:
//   • JWT  — virtual proxy configurado com autenticação JWT (token no header).
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
  const session = enigma.create({
    schema,
    url: buildSocketUrl(cfg),
    createSocket: (url) => new WebSocket(url, buildSocketOptions(cfg))
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
      headers = hc.qDimensionInfo.map(d => d.qFallbackTitle)
        .concat(hc.qMeasureInfo.map(m => m.qFallbackTitle));
      log(`Qlik: objeto ${cfg.objectId} com ${hc.qSize.qcy} linhas x ${hc.qSize.qcx} colunas.`);
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
  }finally{
    try{ await session.close(); }catch(e){ /* ignora */ }
  }
}

module.exports = { fetchTable, buildSocketUrl, cellValue, readAllPages };
