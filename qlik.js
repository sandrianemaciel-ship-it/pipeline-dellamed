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

// "identity" abre uma sessão só do serviço. Sem ela, o Engine reaproveita a
// sessão do usuário dono da chave e a tabela vem filtrada pelas seleções que
// ele estiver fazendo no Qlik naquele momento.
function buildSocketUrl(cfg){
  const appPath = "app/" + encodeURIComponent(cfg.appId) + "/identity/" + encodeURIComponent(cfg.identity || "pipeline-sync");
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
// valores caem na coluna errada (ex.: Data Último Faturamento gravada como
// Data Inativação). Colunas ocultas na tabela (condição de exibição falsa)
// continuam em qColumnOrder, mas não vêm nos dados: o Engine as marca com
// qError e elas são puladas aqui.
function orderedHeaders(hc){
  const cols = (hc.qDimensionInfo || []).concat(hc.qMeasureInfo || [])
    .map(c => ({ title: c.qFallbackTitle, hidden: !!c.qError }));
  const order = hc.qColumnOrder;
  const valid = Array.isArray(order) && order.length === cols.length
    && order.every(i => Number.isInteger(i) && i >= 0 && i < cols.length)
    && new Set(order).size === cols.length;
  const idx = valid ? order : cols.map((_, i) => i);
  return idx.filter(i => !cols[i].hidden).map(i => cols[i].title);
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
  return withApp(cfg, (app) => readClientTable(app, cfg, log));
}

// Abre o app numa sessão isolada e sem seleções, roda fn(app) e fecha.
async function withApp(cfg, fn){
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
    // Lê a base inteira: limpa as seleções (só desta sessão isolada).
    await app.clearAll(true);
    return await fn(app);
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

async function readClientTable(app, cfg, log){
    let obj, headers;
    if(cfg.objectId){
      // Opção 1: ler uma tabela já existente no app (ID do objeto).
      obj = await app.getObject(cfg.objectId);
      const layout = await obj.getLayout();
      const hc = layout.qHyperCube;
      if(!hc) throw new Error(`O objeto ${cfg.objectId} não é uma tabela/gráfico com hipercubo.`);
      headers = orderedHeaders(hc);
      log(`Qlik: objeto ${cfg.objectId} com ${hc.qSize.qcy} linhas x ${hc.qSize.qcx} colunas.`);
      log(`Qlik: colunas na ordem lida: ${headers.join(" | ")}`);
      // Trava de segurança: se o número de cabeçalhos não bate com o de
      // colunas dos dados, os valores cairiam na coluna errada. Melhor parar
      // do que gravar clientes trocados.
      if(headers.length !== hc.qSize.qcx){
        const info = (hc.qDimensionInfo || []).concat(hc.qMeasureInfo || [])
          .map(c => c.qFallbackTitle + (c.qError ? ` (erro ${c.qError.qErrorCode})` : ""));
        throw new Error(`A tabela do Qlik tem ${hc.qSize.qcx} colunas de dados, mas ${headers.length} cabeçalhos ` +
          `(qColumnOrder ${JSON.stringify(hc.qColumnOrder || [])}; colunas: ${info.join(" | ")}). ` +
          "Nada foi gravado. Confira colunas ocultas ou condicionais na tabela do Qlik.");
      }
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
}

// Reconhecimento (só leitura): lista as pastas do app e, na pasta "Pedidos",
// os objetos com seus campos e fórmulas, além das medidas mestras e dos
// campos com nome de pedido/cliente/data/valor. Serve para montar a busca
// de pedidos com os mesmos campos e fórmulas da pasta.
async function discoverApp(cfg, log = console.log){
  return withApp(cfg, async (app) => {
    const props = await app.getAppProperties().catch(() => ({}));
    log(`Qlik [reconhecimento]: app "${props.qTitle || "?"}" (${cfg.appId})`);
    const listObj = async (def) => {
      const o = await app.createSessionObject(def);
      return o.getLayout();
    };
    const sheets = (await listObj({ qInfo: { qType: "SheetList" }, qAppObjectListDef: { qType: "sheet",
      qData: { title: "/qMetaDef/title", cells: "/cells" } } })).qAppObjectList.qItems;
    log("Pastas:", sheets.map(sh => sh.qData.title).join(" | "));
    for(const sh of sheets.filter(x => /pedido/i.test(x.qData.title || ""))){
      log(`Pasta "${sh.qData.title}" (${sh.qInfo.qId}): ${(sh.qData.cells || []).length} objetos`);
      for(const c of sh.qData.cells || []){
        try{
          const o = await app.getObject(c.name);
          const p = await o.getProperties();
          const hc = p.qHyperCubeDef || (p.qListObjectDef ? { qDimensions: [p.qListObjectDef] } : null);
          const dims = hc ? (hc.qDimensions || []).map(d => (d.qDef && d.qDef.qFieldDefs || []).join("+") + (d.qLibraryId ? `[lib ${d.qLibraryId}]` : "")) : [];
          const meas = hc ? (hc.qMeasures || []).map(m => `${(m.qDef && m.qDef.qLabel) || ""}=${(m.qDef && m.qDef.qDef) || ""}${m.qLibraryId ? `[lib ${m.qLibraryId}]` : ""}`) : [];
          const title = (p.title && (p.title.qStringExpression ? p.title.qStringExpression.qExpr : p.title)) || "";
          log(`  - ${c.type} ${c.name} "${typeof title === "string" ? title : JSON.stringify(title)}" dims=[${dims.join(" | ")}] medidas=[${meas.join(" | ")}]`);
          if(p.qChildListDef || c.type === "filterpane"){
            const lay = await o.getLayout();
            const kids = (lay.qChildList && lay.qChildList.qItems || []).map(k => (k.qData && k.qData.title) || k.qInfo.qId);
            if(kids.length) log(`      filtros: ${kids.join(" | ")}`);
          }
        }catch(e){ log(`  - ${c.type} ${c.name}: erro ${e.message}`); }
      }
    }
    const measures = (await listObj({ qInfo: { qType: "MeasureList" }, qMeasureListDef: { qType: "measure",
      qData: { title: "/qMetaDef/title", expr: "/qMeasure/qDef" } } })).qMeasureList.qItems;
    log(`Medidas mestras (${measures.length}):`);
    measures.filter(m => /pedido|fatur|valor|canc/i.test(m.qData.title || "")).forEach(m => log(`  - ${m.qInfo.qId} "${m.qData.title}" = ${m.qData.expr}`));
    const fields = (await listObj({ qInfo: { qType: "FieldList" }, qFieldListDef: { qShowSystem: false } })).qFieldList.qItems;
    const rel = fields.filter(f => /pedido|cliente|bp|emiss|cancel|valor|situa|data|nf|ov|fatur/i.test(f.qName));
    log(`Campos (${fields.length} no total; ${rel.length} relacionados): ${rel.map(f => f.qName).join(" | ")}`);
  });
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

module.exports = { fetchTable, withApp, discoverApp, buildSocketUrl, cellValue, readAllPages, orderedHeaders };
