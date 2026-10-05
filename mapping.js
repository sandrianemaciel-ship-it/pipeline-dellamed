"use strict";
// Converte a tabela do Qlik no mesmo formato de registro que a importação
// .xlsx da página produz (parseWorkbook), para reaproveitar as mesmas regras.
const L = require("./logic");

const NUM_FIELDS = new Set(["pedPend", "valVenc", "valorPedidoExplicit"]);
const DATE_FIELDS = new Set(["dtCad", "dt1Fat", "dtUltFat", "dtInat", "dtUltPedAberto"]);

// columnMap (opcional, do config/column-map.json): { "Rótulo no Qlik": "chaveInterna" }
function buildColMap(headers, columnMap = {}){
  const custom = {};
  Object.entries(columnMap).forEach(([k, v]) => { custom[L.norm(k)] = v; });
  return headers.map(h => custom[L.norm(h)] || L.aliasHeader(h));
}

function asText(c){ return c == null ? null : (c.text != null ? c.text : (c.num != null ? String(c.num) : null)); }
function asNum(c){ if(c == null) return 0; return c.num != null ? c.num : L.cleanNum(c.text); }
function asDate(c){
  if(c == null) return null;
  return L.excelDateToISO(c.text) || (c.num != null ? L.excelDateToISO(c.num) : null);
}

function mapRows({ headers, rows }, columnMap){
  const colMap = buildColMap(headers, columnMap);
  const unmapped = headers.filter((h, i) => !colMap[i]);
  const out = [];
  let semData = 0;
  for(const row of rows){
    const rec = {};
    colMap.forEach((key, idx) => {
      if(!key) return;
      const c = row[idx];
      if(NUM_FIELDS.has(key)) rec[key] = asNum(c);
      else if(DATE_FIELDS.has(key)) rec[key] = asDate(c);
      else rec[key] = L.cleanTxt(asText(c));
    });
    if(!rec.cod) continue;
    if(!rec.dtInat){ semData++; continue; } // igual à página: sem Data Inativação não entra
    const hasExplicit = colMap.includes("valorPedidoExplicit");
    out.push({
      cod: rec.cod, cli: rec.cli || null, cnpj: rec.cnpj || null,
      uf: rec.uf || null, cid: rec.cid || null, seg: rec.seg || null,
      tel: rec.tel || null, email: rec.email || null,
      temCarteira: rec.temCarteira || null, pedPend: rec.pedPend || 0,
      inad: rec.inad || null, valVenc: rec.valVenc || 0,
      dtCad: rec.dtCad || null, dt1Fat: rec.dt1Fat || null,
      dtUltFat: rec.dtUltFat || null, dtInat: rec.dtInat, statusErp: rec.statusErp || null,
      valorPedido: hasExplicit ? (rec.valorPedidoExplicit || 0) : (rec.pedPend || 0),
      dtUltPedAberto: rec.dtUltPedAberto || null,
      rep: rec.rep || null, vendInt: rec.vendInt || null, keyAcc: rec.keyAcc || null,
      prospect: rec.prospect || null, sucCli: rec.sucCli || null
    });
  }
  return { records: out, colMap, unmapped, semData };
}

module.exports = { mapRows, buildColMap };
