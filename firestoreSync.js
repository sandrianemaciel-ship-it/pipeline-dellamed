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
  let novos = 0, atualizados = 0;
  for(const fresh of incomingRows){
    const hit = byCod[fresh.cod];
    const merged = L.applyImportToLead(hit ? hit.lead : null, fresh, monthKey);
    if(hit){
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
  return { meta, chunks, touched, novos, atualizados };
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
    for(const ci of res.touched){
      tx.set(monthRef.collection("chunks").doc("c" + ci), res.chunks[ci]);
    }
    tx.set(monthRef, res.meta);
    return { monthKey, novos: res.novos, atualizados: res.atualizados, total: incomingRows.length };
  });
}

module.exports = { groupByMonth, mergeMonth, commitMonth, CHUNK_SIZE };
