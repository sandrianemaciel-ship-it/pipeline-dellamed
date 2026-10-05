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

// Lógica pura (sem Firestore) — espelha commitMonthImport() do HTML.
function mergeMonth(monthKey, meta, chunks, incomingRows, sourceLabel){
  meta = meta ? JSON.parse(JSON.stringify(meta)) : {
    monthKey, importedAt: L.nowISO(), sourceFilename: "", totalLeads: 0, chunkCount: 0, codToChunk: {}
  };
  meta.codToChunk = meta.codToChunk || {};
  const touched = new Set();
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
  return { meta, chunks, touched, novos, atualizados, semMudanca };
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

async function commitMonth(db, monthKey, incomingRows, sourceLabel){
  const monthRef = db.doc("months/" + monthKey);
  return db.runTransaction(async (tx) => {
    const metaSnap = await tx.get(monthRef);
    const meta = metaSnap.exists ? metaSnap.data() : null;
    const chunkCount = meta ? meta.chunkCount || 0 : 0;
    const chunks = [];
    if(chunkCount){
      const refs = Array.from({ length: chunkCount }, (_, i) => monthRef.collection("chunks").doc("c" + i));
      const snaps = await tx.getAll(...refs);
      snaps.forEach((s, i) => { chunks[i] = s.exists ? { ...s.data(), leads: s.data().leads || [] } : { leads: [] }; });
    }
    const res = mergeMonth(monthKey, meta, chunks, incomingRows, sourceLabel);
    if(!res.touched.size && metaSnap.exists){
      return { monthKey, novos: 0, atualizados: 0, semMudanca: res.semMudanca, total: incomingRows.length };
    }
    for(const ci of res.touched){
      tx.set(monthRef.collection("chunks").doc("c" + ci), res.chunks[ci]);
    }
    tx.set(monthRef, res.meta);
    return { monthKey, novos: res.novos, atualizados: res.atualizados, semMudanca: res.semMudanca, total: incomingRows.length };
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

function isUntouched(l){
  return ["inativam", "inativo"].includes(l.stage)
    && ["inativam", "inativo"].includes(l.status)
    && !l.notes && !l.acao && !l.ofensor && !l.ofensorDetalhe
    && !l.dtUltimoContato && !l.dtProximoContato && !l.valorProposta
    && !(l.linhasPositivadas && l.linhasPositivadas.length)
    && !l.contatoDecisor && !l.whatsapp && l.vendedorAuto !== false
    && (!l.lastTouched || !l.createdAt || l.lastTouched === l.createdAt);
}

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
        revisar.push({ cod: l.cod, motivo });
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

module.exports = { groupByMonth, mergeMonth, commitMonth, cleanMonth, cleanupMonth, CHUNK_SIZE };
