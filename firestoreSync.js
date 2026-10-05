"use strict";
// Grava os registros no Firestore no MESMO formato da página:
//   months/{AAAA-MM}                -> meta {monthKey, importedAt, sourceFilename, totalLeads, chunkCount, codToChunk}
//   months/{AAAA-MM}/chunks/c{n}    -> {leads:[...]}  (até CHUNK_SIZE leads por documento)
// Cada mês é gravado numa transação: se alguém salvar um card na página
// durante a sincronização, o Firestore repete a transação com os dados novos,
// então a edição do vendedor não é perdida.
const L = require("./logic");

const CHUNK_SIZE = 140; // igual ao HTML

function groupByMonth(records, fromMonth){
  const byMonth = {};
  for(const r of records){
    const mk = r.dtInat.slice(0, 7);
    if(fromMonth && mk < fromMonth) continue;
    (byMonth[mk] = byMonth[mk] || []).push(r);
  }
  return byMonth;
}

// Clientes que a regra antiga do Status ERP ("Recuperado com faturamento/
// pedido") colocou em Ganho durante o mês. Pela regra Dellamed só o vendedor
// move para Ganho durante o mês (o automático é só no fechamento), então eles
// voltam para "Inativam no mês"/"Inativado" pela data. Quem o vendedor moveu
// (histórico "Movido de ...") fica como está.
const NOTA_GANHO_ERP = /^Recuperado com (faturamento|pedido): Data de Inativação/;
function isGanhoPeloErp(l){
  const hist = l.hist || [];
  return l.stage === "ganho" && !l.fechamentoAuto
    && hist.some(h => NOTA_GANHO_ERP.test(h.t || ""))
    && !hist.some(h => /^Movido de "/.test(h.t || ""));
}
function revertGanhoErp(chunks){
  const touched = new Set();
  let revertidos = 0;
  chunks.forEach((c, ci) => (c.leads || []).forEach(l => {
    if(!isGanhoPeloErp(l)) return;
    l.stage = l.status = "inativam";
    const r = L.computeStatusStage(l);
    l.stage = r.stage; l.status = r.status;
    L.pushHist(l, `Voltou de "Ganho" para "${STAGE_LABEL[l.stage]}": o Status ERP não move mais o cliente durante o mês — Ganho só pelo vendedor ou no fechamento do mês.`);
    touched.add(ci); revertidos++;
  }));
  return { touched, revertidos };
}

// Lógica pura (sem Firestore) — espelha commitMonthImport() do HTML.
function mergeMonth(monthKey, meta, chunks, incomingRows, sourceLabel){
  meta = meta ? JSON.parse(JSON.stringify(meta)) : {
    monthKey, importedAt: L.nowISO(), sourceFilename: "", totalLeads: 0, chunkCount: 0, codToChunk: {}
  };
  meta.codToChunk = meta.codToChunk || {};
  const rev = revertGanhoErp(chunks);
  const touched = new Set(rev.touched);
  const byCod = {};
  chunks.forEach((c, ci) => (c.leads || []).forEach(l => { byCod[l.cod] = { lead: l, ci }; }));

  let lastIdx = meta.chunkCount > 0 ? meta.chunkCount - 1 : -1;
  const ensureRoom = () => {
    if(lastIdx < 0 || chunks[lastIdx].leads.length >= CHUNK_SIZE){
      lastIdx = meta.chunkCount;
      chunks[lastIdx] = { leads: [] };
      meta.chunkCount = lastIdx + 1;
    }
  };
  let novos = 0, atualizados = 0, semMudanca = 0;
  for(const fresh of incomingRows){
    const hit = byCod[fresh.cod];
    const merged = L.applyImportToLead(hit ? hit.lead : null, fresh, monthKey);
    if(hit){
      // Rodando de hora em hora, não podemos regravar o cliente nem encher o
      // histórico (só guarda 5 entradas) com "Atualizado via importação" se
      // nada mudou — isso apagaria as observações reais dos vendedores.
      const old = hit.lead;
      if(sameData(old, merged)){ semMudanca++; continue; }
      merged.hist = (old.hist || []).slice();
      if(old.status !== merged.status || old.stage !== merged.stage){
        L.pushHist(merged, "Atualizado via importação (status: " + L.STATUS_LABEL[merged.status] + ")");
      }
      const nota = L.computeStatusStage(Object.assign({}, merged, { status: old.status, stage: old.stage })).note;
      if(nota && !merged.hist.some(h => h.t === nota)) L.pushHist(merged, nota);
      const chunk = chunks[hit.ci];
      const idx = chunk.leads.findIndex(x => x.cod === fresh.cod);
      if(idx >= 0) chunk.leads[idx] = merged; else chunk.leads.push(merged);
      byCod[fresh.cod] = { lead: merged, ci: hit.ci };
      touched.add(hit.ci);
      atualizados++;
    }else{
      ensureRoom();
      chunks[lastIdx].leads.push(merged);
      meta.codToChunk[fresh.cod] = lastIdx;
      byCod[fresh.cod] = { lead: merged, ci: lastIdx };
      touched.add(lastIdx);
      novos++;
    }
  }
  meta.totalLeads = Object.keys(meta.codToChunk).length;
  meta.importedAt = L.nowISO();
  meta.sourceFilename = sourceLabel;
  return { meta, chunks, touched, novos, atualizados, semMudanca, revertidosErp: rev.revertidos };
}

// Compara o cliente antes/depois ignorando campos que mudam a cada execução.
const VOLATEIS = new Set(["dataUpdatedAt", "hist"]);
function sameData(a, b){
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for(const k of keys){
    if(VOLATEIS.has(k)) continue;
    if(JSON.stringify(a[k] ?? null) !== JSON.stringify(b[k] ?? null)) return false;
  }
  return true;
}

// baseBI (opcional): {total, de, ate} = quantos clientes o BI tem com Data
// de Inativação dentro do mês; fica no meta para a página mostrar.
async function commitMonth(db, monthKey, incomingRows, sourceLabel, baseBI = null){
  const monthRef = db.doc("months/" + monthKey);
  return db.runTransaction(async (tx) => {
    const metaSnap = await tx.get(monthRef);
    const meta = metaSnap.exists ? metaSnap.data() : null;
    if(meta && meta.fechado){
      return { monthKey, novos: 0, atualizados: 0, semMudanca: 0, total: incomingRows.length, congelado: true };
    }
    const chunkCount = meta ? meta.chunkCount || 0 : 0;
    const chunks = [];
    if(chunkCount){
      const refs = Array.from({ length: chunkCount }, (_, i) => monthRef.collection("chunks").doc("c" + i));
      const snaps = await tx.getAll(...refs);
      snaps.forEach((s, i) => { chunks[i] = s.exists ? { ...s.data(), leads: s.data().leads || [] } : { leads: [] }; });
    }
    const res = mergeMonth(monthKey, meta, chunks, incomingRows, sourceLabel);
    const baseMudou = baseBI && !(meta && meta.baseBI && meta.baseBI.total === baseBI.total);
    if(baseBI) res.meta.baseBI = baseMudou ? { ...baseBI, em: L.nowISO() } : meta.baseBI;
    if(!res.touched.size && metaSnap.exists && !baseMudou){
      return { monthKey, novos: 0, atualizados: 0, semMudanca: res.semMudanca, total: incomingRows.length };
    }
    for(const ci of res.touched){
      tx.set(monthRef.collection("chunks").doc("c" + ci), res.chunks[ci]);
    }
    tx.set(monthRef, res.meta);
    return { monthKey, novos: res.novos, atualizados: res.atualizados, semMudanca: res.semMudanca, total: incomingRows.length, revertidosErp: res.revertidosErp };
  });
}

// ---------------------------------------------------------------------------
// Limpeza dos clientes gravados com colunas trocadas (antes da correção do
// qColumnOrder em qlik.js). Compara o que está no Firestore com a leitura
// correta do Qlik. Só REMOVE clientes que ninguém trabalhou (estágio
// automático e nada preenchido pelo vendedor); a sincronização que roda logo
// em seguida recria os que existem no Qlik, com os dados certos e no mês
// certo. Clientes já trabalhados nunca são apagados: vão para a lista de
// revisão no log.

// Campos que não mudam com o tempo: se diferem do Qlik, a gravação veio de
// colunas trocadas (e não de uma atualização normal, como Data Último Faturamento).
const CAMPOS_FIXOS = ["cli", "cnpj", "uf", "dtCad", "dt1Fat"];

// Devolve null quando ninguém trabalhou o cliente, ou o primeiro sinal de
// trabalho do vendedor encontrado.
function workedReason(l){
  if(!["inativam", "inativo"].includes(l.stage)) return "estágio " + l.stage;
  if(!["inativam", "inativo"].includes(l.status)) return "status " + l.status;
  for(const k of ["notes", "acao", "ofensor", "ofensorDetalhe", "dtUltimoContato", "dtProximoContato",
    "valorProposta", "contatoDecisor", "whatsapp"]){
    if(l[k]) return "preencheu " + k;
  }
  if(l.linhasPositivadas && l.linhasPositivadas.length) return "preencheu linhasPositivadas";
  if(l.vendedorAuto === false) return "vendedor escolhido à mão";
  // lastTouched NÃO serve de sinal: a página o atualiza sozinha ao mover
  // para Inativado os clientes com data vencida (applyAutoInativoTransitions).
  return null;
}
function isUntouched(l){ return !workedReason(l); }

// Formato dos códigos de cliente do Qlik (ex.: só dígitos, de 3 a 6 casas),
// para reconhecer um "código" que na verdade é outra coluna (nome, CNPJ, valor).
function codPattern(freshByCod){
  const cods = Object.keys(freshByCod);
  const nums = cods.filter(c => /^\d+$/.test(c));
  if(!cods.length || nums.length / cods.length < 0.95) return null;
  const lens = nums.map(c => c.length);
  const min = Math.min(...lens), max = Math.max(...lens);
  return (cod) => /^\d+$/.test(String(cod)) && String(cod).length >= min && String(cod).length <= max;
}

const txt = (v) => v == null || v === "" ? null : String(v).trim().toUpperCase();

function diagnoseLead(l, monthKey, freshByCod, codOk){
  const fresh = freshByCod[l.cod];
  if(!fresh){
    const ufRuim = l.uf != null && !/^[A-Z]{2}$/i.test(String(l.uf));
    if((codOk && !codOk(l.cod)) || ufRuim) return "código/UF com formato de outra coluna";
    return null; // pode ser cliente que só saiu da tabela do Qlik: não mexe
  }
  if(fresh.dtInat.slice(0, 7) !== monthKey) return `no mês errado (Qlik: ${fresh.dtInat})`;
  const dif = CAMPOS_FIXOS.filter(k => fresh[k] != null && txt(fresh[k]) !== txt(l[k]));
  if(dif.length) return "campos diferentes do Qlik: " + dif.join(", ");
  return null;
}

// Lógica pura (sem Firestore). Remove os leads trocados sem reorganizar os
// blocos (codToChunk dos demais clientes continua valendo).
function cleanMonth(monthKey, meta, chunks, freshByCod){
  meta = JSON.parse(JSON.stringify(meta));
  meta.codToChunk = meta.codToChunk || {};
  const codOk = codPattern(freshByCod);
  const removidos = [], revisar = [], touched = new Set();
  chunks.forEach((c, ci) => {
    const keep = [];
    for(const l of c.leads || []){
      const motivo = diagnoseLead(l, monthKey, freshByCod, codOk);
      if(!motivo){ keep.push(l); continue; }
      if(isUntouched(l)){
        removidos.push({ cod: l.cod, motivo });
        if(meta.codToChunk[l.cod] === ci) delete meta.codToChunk[l.cod];
        touched.add(ci);
      }else{
        revisar.push({ cod: l.cod, motivo, trabalhado: workedReason(l) });
        keep.push(l);
      }
    }
    chunks[ci] = { ...c, leads: keep };
  });
  meta.totalLeads = Object.keys(meta.codToChunk).length;
  return { meta, chunks, touched, removidos, revisar };
}

async function cleanupMonth(db, monthKey, freshByCod, { dryRun = false } = {}){
  const monthRef = db.doc("months/" + monthKey);
  return db.runTransaction(async (tx) => {
    const metaSnap = await tx.get(monthRef);
    if(!metaSnap.exists) return { monthKey, removidos: [], revisar: [] };
    const meta = metaSnap.data();
    if(meta.fechado) return { monthKey, removidos: [], revisar: [], congelado: true };
    const chunkCount = meta.chunkCount || 0;
    const refs = Array.from({ length: chunkCount }, (_, i) => monthRef.collection("chunks").doc("c" + i));
    const snaps = chunkCount ? await tx.getAll(...refs) : [];
    const chunks = snaps.map(s => s.exists ? { ...s.data(), leads: s.data().leads || [] } : { leads: [] });
    const res = cleanMonth(monthKey, meta, chunks, freshByCod);
    const out = { monthKey, removidos: res.removidos, revisar: res.revisar };
    if(dryRun || !res.touched.size) return out;
    if(res.meta.totalLeads === 0){
      // Mês que só tinha clientes trocados: apaga o mês inteiro.
      refs.forEach(r => tx.delete(r));
      tx.delete(monthRef);
      out.mesApagado = true;
      return out;
    }
    for(const ci of res.touched) tx.set(refs[ci], res.chunks[ci]);
    tx.set(monthRef, res.meta);
    return out;
  });
}

// ---------------------------------------------------------------------------
// Pedidos identificados no Qlik e fechamento do mês.
//
// Pedido identificado: o BP do cliente tem pedido na pasta Pedidos do Qlik
// emitido dentro do mês da pipeline (VL_TOTAL > 0, já descontados os
// cancelamentos). O cliente recebe a tag "PEDIDO IDENTIFICADO, MOVA PARA
// GANHO" (lead.pedidoIdentificado) e o Valor de pedido passa a ser o total dos
// pedidos, a menos que o vendedor tenha digitado outro valor.
//
// Fechamento (dia 01 do mês seguinte): quem tem pedido identificado e não foi
// movido vai para Ganho; quem não está em Ganho nem em Negociação Perdida vai
// para Negociação Perdida. Os dois ficam marcados em lead.fechamentoAuto
// (indicador de "movido sem ação do vendedor"). Depois disso o mês fica
// congelado (meta.fechado) e nada mais é gravado nele.

const TAG_PEDIDO_IDENTIFICADO = "PEDIDO IDENTIFICADO, MOVA PARA GANHO";
const normCod = (c) => String(c == null ? "" : c).trim().replace(/^0+(?=\d)/, "");
const fmtBRL = (v) => "R$ " + Number(v || 0).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtBR = (iso) => iso ? iso.split("-").reverse().join("/") : "—";

// pedidos: [{cod, pedido, valor, data}] -> { codNormalizado: [pedidos...] }
function indexPedidos(pedidos){
  const by = {};
  for(const p of pedidos){ (by[normCod(p.cod)] = by[normCod(p.cod)] || []).push(p); }
  return by;
}

function pedidoInfo(lista, monthKey){
  const doMes = (lista || []).filter(p => p.valor > 0 && p.data && p.data.slice(0, 7) === monthKey);
  if(!doMes.length) return null;
  return {
    pedidos: [...new Set(doMes.map(p => p.pedido))].sort(),
    valor: Math.round(doMes.reduce((s, p) => s + p.valor, 0) * 100) / 100,
    dtPrimeiro: doMes.map(p => p.data).sort()[0]
  };
}

// Lógica pura: marca/atualiza/remove pedidoIdentificado nos leads do mês.
function applyPedidosMonth(monthKey, chunks, pedidosByCod){
  const touched = new Set();
  let identificados = 0, novos = 0, removidos = 0;
  chunks.forEach((c, ci) => (c.leads || []).forEach(l => {
    const info = pedidoInfo(pedidosByCod[normCod(l.cod)], monthKey);
    const old = l.pedidoIdentificado || null;
    if(info) identificados++;
    const igual = old && info && old.valor === info.valor && old.dtPrimeiro === info.dtPrimeiro
      && JSON.stringify(old.pedidos) === JSON.stringify(info.pedidos);
    if(igual || (!old && !info)) return;
    if(info){
      l.pedidoIdentificado = { ...info, em: old && old.em || L.nowISO() };
      if(!l.valorPedidoManual) l.valorPedido = info.valor;
      if(!old){
        novos++;
        L.pushHist(l, `${TAG_PEDIDO_IDENTIFICADO}: pedido(s) ${info.pedidos.join(", ")} emitido(s) a partir de ${fmtBR(info.dtPrimeiro)} — ${fmtBRL(info.valor)} (Qlik).`);
      }
    }else{
      l.pedidoIdentificado = null;
      removidos++;
      L.pushHist(l, "Pedido não consta mais no Qlik neste mês (cancelado?) — tag de pedido identificado removida.");
    }
    l.dataUpdatedAt = L.nowISO();
    touched.add(ci);
  }));
  return { touched, identificados, novos, removidos };
}

const STAGE_LABEL = { inativam: "Inativam no mês", inativo: "Inativado", contato: "Contato feito",
  proposta: "Proposta enviada", negociando: "Negociando", ganho: "Ganho", perdido: "Negociação Perdida" };

// Lógica pura: fecha o mês.
function closeMonthLogic(monthKey, meta, chunks){
  const now = L.nowISO();
  const touched = new Set();
  let ganhoAuto = 0, perdidoAuto = 0;
  chunks.forEach((c, ci) => (c.leads || []).forEach(l => {
    if(l.stage === "ganho" || l.stage === "perdido") return;
    const de = STAGE_LABEL[l.stage] || l.stage;
    if(l.pedidoIdentificado){
      l.stage = "ganho"; l.status = "ganho"; l.fechamentoAuto = "ganho"; ganhoAuto++;
      L.pushHist(l, `Movido automaticamente de "${de}" para "Ganho" no fechamento do mês — pedido identificado no Qlik e não movido pelo vendedor (sem ação do vendedor).`);
    }else{
      l.stage = "perdido"; l.status = "perdido"; l.fechamentoAuto = "perdido"; perdidoAuto++;
      L.pushHist(l, `Movido automaticamente de "${de}" para "Negociação Perdida" no fechamento do mês — sem pedido e sem ação do vendedor.`);
    }
    l.fechamentoAutoEm = now;
    l.dataUpdatedAt = now;
    touched.add(ci);
  }));
  meta = { ...meta, fechado: true, fechadoEm: now, fechamento: { ganhoAuto, perdidoAuto, em: now } };
  return { meta, chunks, touched, ganhoAuto, perdidoAuto };
}

async function loadMonthTx(tx, monthRef){
  const metaSnap = await tx.get(monthRef);
  if(!metaSnap.exists) return null;
  const meta = metaSnap.data();
  const refs = Array.from({ length: meta.chunkCount || 0 }, (_, i) => monthRef.collection("chunks").doc("c" + i));
  const snaps = refs.length ? await tx.getAll(...refs) : [];
  const chunks = snaps.map(s => s.exists ? { ...s.data(), leads: s.data().leads || [] } : { leads: [] });
  return { meta, refs, chunks };
}

async function commitPedidosMonth(db, monthKey, pedidosByCod, { dryRun = false } = {}){
  const monthRef = db.doc("months/" + monthKey);
  return db.runTransaction(async (tx) => {
    const m = await loadMonthTx(tx, monthRef);
    if(!m) return { monthKey, identificados: 0, novos: 0, removidos: 0 };
    if(m.meta.fechado) return { monthKey, identificados: 0, novos: 0, removidos: 0, congelado: true };
    const r = applyPedidosMonth(monthKey, m.chunks, pedidosByCod);
    if(!dryRun) for(const ci of r.touched) tx.set(m.refs[ci], m.chunks[ci]);
    return { monthKey, identificados: r.identificados, novos: r.novos, removidos: r.removidos };
  });
}

// pedidosByCod (opcional): aplica os pedidos mais recentes antes de fechar.
async function closeMonth(db, monthKey, { dryRun = false, pedidosByCod = null } = {}){
  const monthRef = db.doc("months/" + monthKey);
  return db.runTransaction(async (tx) => {
    const m = await loadMonthTx(tx, monthRef);
    if(!m || m.meta.fechado) return { monthKey, jaFechado: !!m };
    if(pedidosByCod) applyPedidosMonth(monthKey, m.chunks, pedidosByCod);
    const r = closeMonthLogic(monthKey, m.meta, m.chunks);
    r.chunks.forEach((_, ci) => r.touched.add(ci));
    if(!dryRun){
      for(const ci of r.touched) tx.set(m.refs[ci], r.chunks[ci]);
      tx.set(monthRef, r.meta);
    }
    return { monthKey, ganhoAuto: r.ganhoAuto, perdidoAuto: r.perdidoAuto };
  });
}

// Meses depois do mês vigente: a pipeline trabalha um mês por vez, então
// meses futuros gravados antes desta regra são apagados — só se ninguém
// trabalhou nenhum cliente deles (senão ficam e vão para o log).
async function removeFutureMonth(db, monthKey, { dryRun = false } = {}){
  const monthRef = db.doc("months/" + monthKey);
  return db.runTransaction(async (tx) => {
    const m = await loadMonthTx(tx, monthRef);
    if(!m) return { monthKey, apagado: false, total: 0, trabalhados: [] };
    const leads = m.chunks.flatMap(c => c.leads || []);
    const trabalhados = leads.filter(l => workedReason(l)).map(l => ({ cod: l.cod, motivo: workedReason(l) }));
    if(trabalhados.length || m.meta.fechado) return { monthKey, apagado: false, total: leads.length, trabalhados };
    if(!dryRun){ m.refs.forEach(r => tx.delete(r)); tx.delete(monthRef); }
    return { monthKey, apagado: true, total: leads.length, trabalhados };
  });
}

module.exports = {
  removeFutureMonth,
  groupByMonth, mergeMonth, commitMonth, cleanMonth, cleanupMonth, CHUNK_SIZE,
  indexPedidos, applyPedidosMonth, closeMonthLogic, commitPedidosMonth, closeMonth, TAG_PEDIDO_IDENTIFICADO
};
