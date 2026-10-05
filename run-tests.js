"use strict";
// Testes sem Qlik e sem Firestore reais (dados simulados). Rode: npm test
process.env.TZ = "America/Sao_Paulo";
const assert = require("assert");
const { mapRows } = require("../src/mapping");
const { mergeMonth, commitMonth, groupByMonth, CHUNK_SIZE } = require("../src/firestoreSync");
const { readAllPages } = require("../src/qlik");

let passed = 0;
async function t(name, fn){ await fn(); passed++; console.log("  ✓", name); }
const T = (text, num) => ({ text, num: num == null ? null : num });

(async () => {
  console.log("Mapeamento de colunas do Qlik");
  const table = {
    headers: ["Cód Cliente", "Razão Social", "UF", "Segmento", "Data Último Faturamento", "Data Inativação",
      "Status Atual", "Vendedor Interno (VE)", "Representante (Z1)", "Total Pedidos Pendentes", "Coluna Extra"],
    rows: [
      [T("1001"), T("CLINICA A"), T("RS"), T("FARMA INDEPENDENTE"), T("10/06/2026", 46183), T("10/09/2026", 46275),
        T("Ativo"), T("KELLY VIEIRA DOS SANTOS"), null, T("R$ 1.105,84", 1105.84), T("x")],
      [T("1002"), T("HOSPITAL B"), T("SC"), T("HOSPITAIS/CLINICAS"), T("-", 46100), T(null, 46300),
        null, null, T("MARVIN DE CAMPOS"), T("0", 0), T("y")],
      [T("1003"), T("SEM DATA"), T("SP"), null, null, null, null, null, null, null, null],
      [null, T("SEM CODIGO"), null, null, null, T("01/10/2026"), null, null, null, null, null]
    ]
  };
  const res = mapRows(table, { "Coluna Extra": null });
  await t("ignora linhas sem código e sem Data Inativação", () => {
    assert.strictEqual(res.records.length, 2);
    assert.strictEqual(res.semData, 1);
  });
  await t("datas em texto dd/mm/aaaa e em número serial viram AAAA-MM-DD", () => {
    assert.strictEqual(res.records[0].dtInat, "2026-09-10");
    assert.strictEqual(res.records[0].dtUltFat, "2026-06-10");
    assert.strictEqual(res.records[1].dtInat, "2026-10-05");
    assert.strictEqual(res.records[1].dtUltFat, "2026-03-19");
  });
  await t("valores numéricos usam o número do Qlik (sem inflar 100x)", () => {
    assert.strictEqual(res.records[0].pedPend, 1105.84);
    assert.strictEqual(res.records[0].valorPedido, 1105.84);
  });
  await t("coluna desconhecida é listada como ignorada", () => {
    assert.deepStrictEqual(res.unmapped, ["Coluna Extra"]);
  });
  await t("column-map.json permite renomear colunas", () => {
    const r = mapRows({ headers: ["Código do Cliente", "Dt Inativ Prevista"], rows: [[T("9"), T("15/11/2026")]] },
      { "Código do Cliente": "cod", "Dt Inativ Prevista": "dtInat" });
    assert.strictEqual(r.records[0].cod, "9");
    assert.strictEqual(r.records[0].dtInat, "2026-11-15");
  });

  console.log("Regras de negócio (mesmas do HTML)");
  const byMonth = groupByMonth(res.records, "2026-09");
  await t("agrupa por mês de inativação", () => {
    assert.deepStrictEqual(Object.keys(byMonth).sort(), ["2026-09", "2026-10"]);
  });
  await t("lead novo recebe Vendedor e Time pelo TEAM_MAP", () => {
    const r = mergeMonth("2026-09", null, [], byMonth["2026-09"], "Qlik");
    const lead = r.chunks[0].leads[0];
    assert.strictEqual(lead.vendedor, "KELLY VIEIRA DOS SANTOS");
    assert.strictEqual(lead.time, "Líder de Vendas Sandriane");
    assert.strictEqual(lead.stage, "inativam");
    assert.strictEqual(r.meta.totalLeads, 1);
    assert.strictEqual(r.novos, 1);
  });
  await t("atualização preserva o que o vendedor preencheu", () => {
    const first = mergeMonth("2026-09", null, [], byMonth["2026-09"], "Qlik");
    const lead = first.chunks[0].leads[0];
    Object.assign(lead, { stage: "negociando", status: "negociando", notes: "ligar sexta", ofensor: "Preço",
      acao: "Promoção", vendedor: "OUTRA PESSOA", vendedorAuto: false });
    const again = mergeMonth("2026-09", first.meta, first.chunks, [{ ...byMonth["2026-09"][0], uf: "PR" }], "Qlik");
    const l2 = again.chunks[0].leads[0];
    assert.strictEqual(again.atualizados, 1);
    assert.strictEqual(l2.uf, "PR");
    assert.strictEqual(l2.stage, "negociando");
    assert.strictEqual(l2.notes, "ligar sexta");
    assert.strictEqual(l2.ofensor, "Preço");
    assert.strictEqual(l2.vendedor, "OUTRA PESSOA");
  });
  await t("Status Atual 'Inativo' move para Inativado", () => {
    const first = mergeMonth("2026-09", null, [], byMonth["2026-09"], "Qlik");
    const again = mergeMonth("2026-09", first.meta, first.chunks, [{ ...byMonth["2026-09"][0], statusErp: "Inativo" }], "Qlik");
    assert.strictEqual(again.chunks[0].leads[0].stage, "inativo");
  });
  await t(`quebra em blocos de ${CHUNK_SIZE} clientes, como a página`, () => {
    const many = Array.from({ length: 300 }, (_, i) => ({ ...byMonth["2026-09"][0], cod: "C" + i }));
    const r = mergeMonth("2026-09", null, [], many, "Qlik");
    assert.strictEqual(r.meta.chunkCount, 3);
    assert.deepStrictEqual(r.chunks.map(c => c.leads.length), [140, 140, 20]);
    assert.strictEqual(r.meta.codToChunk.C299, 2);
    // segunda rodada: só atualiza, sem duplicar
    const r2 = mergeMonth("2026-09", r.meta, r.chunks, many.slice(0, 10), "Qlik");
    assert.strictEqual(r2.meta.totalLeads, 300);
    assert.deepStrictEqual([...r2.touched], [0]);
  });

  console.log("Gravação no Firestore (simulado)");
  await t("grava meta e blocos no formato months/{mês}/chunks/c{n}", async () => {
    const db = fakeFirestore();
    const out = await commitMonth(db, "2026-09", byMonth["2026-09"], "Qlik app/obj");
    assert.strictEqual(out.novos, 1);
    assert.strictEqual(db.store["months/2026-09"].chunkCount, 1);
    assert.strictEqual(db.store["months/2026-09"].sourceFilename, "Qlik app/obj");
    assert.strictEqual(db.store["months/2026-09/chunks/c0"].leads[0].cod, "1001");
    const out2 = await commitMonth(db, "2026-09", byMonth["2026-09"], "Qlik app/obj");
    assert.strictEqual(out2.atualizados, 1);
    assert.strictEqual(db.store["months/2026-09/chunks/c0"].leads.length, 1);
  });

  console.log("Leitura paginada do Qlik (simulado)");
  await t("lê todas as páginas do hipercubo (limite de 10.000 células)", async () => {
    const W = 25, H = 1234;
    const obj = { async getHyperCubeData(_p, [pg]){
      const m = [];
      for(let r = pg.qTop; r < pg.qTop + pg.qHeight; r++) m.push(Array.from({ length: W }, (_, c) => ({ qText: `${r}-${c}`, qNum: "NaN" })));
      return [{ qMatrix: m }];
    } };
    const rows = await readAllPages(obj, { qHyperCube: { qSize: { qcx: W, qcy: H } } });
    assert.strictEqual(rows.length, H);
    assert.strictEqual(rows[H - 1][W - 1].text, `${H - 1}-${W - 1}`);
    assert.strictEqual(rows[0][0].num, null);
  });

  console.log(`\n${passed} testes passaram.`);
})().catch(e => { console.error("\n✗ FALHOU:", e.message); console.error(e.stack); process.exit(1); });

function fakeFirestore(){
  const store = {};
  const ref = (p) => ({ path: p, collection: (c) => ({ doc: (d) => ref(`${p}/${c}/${d}`) }) });
  const snap = (p) => ({ exists: p in store, data: () => JSON.parse(JSON.stringify(store[p])) });
  return {
    store,
    doc: ref,
    async runTransaction(fn){
      const writes = [];
      const tx = {
        get: async (r) => snap(r.path),
        getAll: async (...rs) => rs.map(r => snap(r.path)),
        set: (r, data) => writes.push([r.path, data])
      };
      const result = await fn(tx);
      writes.forEach(([p, d]) => { store[p] = JSON.parse(JSON.stringify(d)); });
      return result;
    }
  };
}
