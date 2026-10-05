"use strict";
// Testes sem Qlik e sem Firestore reais (dados simulados). Rode: npm test
process.env.TZ = "America/Sao_Paulo";
const assert = require("assert");
const { mapRows } = require("./mapping");
const { mergeMonth, commitMonth, groupByMonth, cleanMonth, cleanupMonth, CHUNK_SIZE,
  indexPedidos, applyPedidosMonth, closeMonthLogic, commitPedidosMonth, closeMonth, removeFutureMonth } = require("./firestoreSync");
const { readAllPages, orderedHeaders } = require("./qlik");
const L = require("./logic");

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
    assert.strictEqual(lead.stage, "inativo"); // 10/09/2026 já passou
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
  const ymd = (offsetDias) => { const d = new Date(); d.setDate(d.getDate() + offsetDias);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
  await t("Data de Inativação já atingida = Inativado; futura = Inativam no mês", () => {
    const base = { ...byMonth["2026-09"][0], statusErp: "Ativo" };
    assert.strictEqual(L.applyImportToLead(null, { ...base, dtInat: ymd(-1) }, "x").stage, "inativo");
    assert.strictEqual(L.applyImportToLead(null, { ...base, dtInat: ymd(0) }, "x").stage, "inativo");
    const futuro = L.applyImportToLead(null, { ...base, dtInat: ymd(1) }, "x");
    assert.strictEqual(futuro.stage, "inativam");
    assert.strictEqual(futuro.status, "inativam");
    // a data chega: na próxima sincronização o cliente passa para Inativado
    const depois = L.applyImportToLead(futuro, { ...base, dtInat: ymd(-2) }, "x");
    assert.strictEqual(depois.stage, "inativo");
    assert.strictEqual(depois.status, "inativo");
    // e se a data for adiada no ERP, volta para Inativam no mês
    assert.strictEqual(L.applyImportToLead(depois, { ...base, dtInat: ymd(20) }, "x").stage, "inativam");
  });
  await t("regra da data não mexe em cliente que o vendedor já trabalhou", () => {
    const base = { ...byMonth["2026-09"][0], statusErp: "Ativo", dtInat: ymd(-3) };
    const lead = L.applyImportToLead(null, { ...base, dtInat: ymd(5) }, "x");
    Object.assign(lead, { stage: "negociando", status: "negociando" });
    const r = L.applyImportToLead(lead, base, "x");
    assert.strictEqual(r.stage, "negociando");
    assert.strictEqual(r.status, "negociando");
  });
  await t(`quebra em blocos de ${CHUNK_SIZE} clientes, como a página`, () => {
    const many = Array.from({ length: 300 }, (_, i) => ({ ...byMonth["2026-09"][0], cod: "C" + i }));
    const r = mergeMonth("2026-09", null, [], many, "Qlik");
    assert.strictEqual(r.meta.chunkCount, 3);
    assert.deepStrictEqual(r.chunks.map(c => c.leads.length), [140, 140, 20]);
    assert.strictEqual(r.meta.codToChunk.C299, 2);
    // segunda rodada: só atualiza, sem duplicar
    const r2 = mergeMonth("2026-09", r.meta, r.chunks, many.slice(0, 10).map(x => ({ ...x, uf: "PR" })), "Qlik");
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
    const out2 = await commitMonth(db, "2026-09", byMonth["2026-09"].map(x => ({ ...x, uf: "PR" })), "Qlik app/obj");
    assert.strictEqual(out2.atualizados, 1);
    const out3 = await commitMonth(db, "2026-09", byMonth["2026-09"].map(x => ({ ...x, uf: "PR" })), "Qlik app/obj");
    assert.strictEqual(out3.atualizados, 0); // sem mudança, não regrava
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

  await t("cabeçalhos seguem o qColumnOrder da tabela do Qlik", () => {
    const hc = {
      qDimensionInfo: [{ qFallbackTitle: "Cód Cliente" }, { qFallbackTitle: "Data Cadastro" }, { qFallbackTitle: "Data Inativação" }],
      qMeasureInfo: [{ qFallbackTitle: "Valor Vencido" }],
      qColumnOrder: [0, 2, 3, 1]
    };
    assert.deepStrictEqual(orderedHeaders(hc), ["Cód Cliente", "Data Inativação", "Valor Vencido", "Data Cadastro"]);
    assert.deepStrictEqual(orderedHeaders({ ...hc, qColumnOrder: [] }), ["Cód Cliente", "Data Cadastro", "Data Inativação", "Valor Vencido"]);
    assert.deepStrictEqual(orderedHeaders({ ...hc, qColumnOrder: [0, 0, 1, 2] }), ["Cód Cliente", "Data Cadastro", "Data Inativação", "Valor Vencido"]);
    // coluna oculta (condição de exibição falsa) não vem nos dados
    const oculta = { ...hc, qDimensionInfo: hc.qDimensionInfo.map((d, i) => i === 1 ? { ...d, qError: { qErrorCode: 7005 } } : d) };
    assert.deepStrictEqual(orderedHeaders(oculta), ["Cód Cliente", "Data Inativação", "Valor Vencido"]);
  });

  console.log("Limpeza de clientes gravados com colunas trocadas");
  {
    const freshRec = (cod, dtInat, extra = {}) => ({ ...byMonth["2026-09"][0], cod, dtInat, cli: "CLIENTE " + cod, uf: "RS", dtCad: "2020-01-01", ...extra });
    const fresh = [freshRec("1001", "2026-10-10"), freshRec("1002", "2026-10-12"), freshRec("1003", "2026-11-03"), freshRec("1004", "2026-10-20")];
    const freshByCod = Object.fromEntries(fresh.map(r => [r.cod, r]));
    // Gravação errada: códigos certos com campos trocados, cliente no mês
    // errado, "código" que era outra coluna e um cliente já trabalhado.
    const gravados = [
      freshRec("1001", "2026-10-10"),                                       // ok
      freshRec("1002", "2026-10-12", { cli: "RS", uf: "CLIENTE 1002" }),    // trocado, intocado
      freshRec("1003", "2026-10-15"),                                       // mês errado, intocado
      freshRec("CLINICA X", "2026-10-01", { uf: "2020-01-01" }),            // código era outra coluna
      freshRec("1004", "2026-10-20", { dtCad: "2026-10-20" }),              // trocado, mas trabalhado
      freshRec("9999", "2026-10-05")                                        // saiu do Qlik, formato ok
    ];
    const first = mergeMonth("2026-10", null, [], gravados, "Qlik");
    const l1004 = first.chunks[0].leads.find(l => l.cod === "1004");
    Object.assign(l1004, { stage: "negociando", status: "negociando", notes: "ligar" });
    // a página move sozinha para Inativado e atualiza lastTouched: continua "não trabalhado"
    const l1003 = first.chunks[0].leads.find(l => l.cod === "1003");
    Object.assign(l1003, { stage: "inativo", status: "inativo", lastTouched: "2026-10-01T10:00:00.000Z" });

    await t("remove só os trocados que ninguém trabalhou", () => {
      const r = cleanMonth("2026-10", first.meta, JSON.parse(JSON.stringify(first.chunks)), freshByCod);
      assert.deepStrictEqual(r.removidos.map(x => x.cod).sort(), ["1002", "1003", "CLINICA X"]);
      assert.deepStrictEqual(r.revisar.map(x => x.cod), ["1004"]);
      assert.deepStrictEqual(r.chunks[0].leads.map(l => l.cod).sort(), ["1001", "1004", "9999"]);
      assert.strictEqual(r.meta.totalLeads, 3);
      assert.strictEqual(r.meta.codToChunk["1002"], undefined);
    });
    await t("limpeza + sincronização deixam cada cliente certo no mês certo", async () => {
      const db = fakeFirestore();
      db.store["months/2026-10"] = first.meta;
      db.store["months/2026-10/chunks/c0"] = first.chunks[0];
      const sim = await cleanupMonth(db, "2026-10", freshByCod, { dryRun: true });
      assert.strictEqual(sim.removidos.length, 3);
      assert.strictEqual(db.store["months/2026-10/chunks/c0"].leads.length, 6); // simulação não grava
      await cleanupMonth(db, "2026-10", freshByCod);
      const byM = groupByMonth(fresh, "2026-09");
      for(const mk of Object.keys(byM)) await commitMonth(db, mk, byM[mk], "Qlik");
      const out = db.store["months/2026-10/chunks/c0"].leads;
      assert.deepStrictEqual(out.map(l => l.cod).sort(), ["1001", "1002", "1004", "9999"]);
      const l1002 = out.find(l => l.cod === "1002");
      assert.strictEqual(l1002.cli, "CLIENTE 1002");
      assert.strictEqual(l1002.uf, "RS");
      assert.strictEqual(out.find(l => l.cod === "1004").notes, "ligar");
      assert.deepStrictEqual(db.store["months/2026-11/chunks/c0"].leads.map(l => l.cod), ["1003"]);
      // rodar de novo não remove mais nada
      const again = await cleanupMonth(db, "2026-10", freshByCod);
      assert.deepStrictEqual(again.removidos, []);
    });
    await t("mês que só tinha clientes trocados é apagado", async () => {
      const db = fakeFirestore();
      const m = mergeMonth("2027-03", null, [], [freshRec("1001", "2027-03-01")], "Qlik");
      db.store["months/2027-03"] = m.meta;
      db.store["months/2027-03/chunks/c0"] = m.chunks[0];
      const r = await cleanupMonth(db, "2027-03", freshByCod);
      assert.strictEqual(r.mesApagado, true);
      assert.ok(!("months/2027-03" in db.store));
      assert.ok(!("months/2027-03/chunks/c0" in db.store));
    });
  }

  console.log("Pedidos identificados e fechamento do mês");
  {
    const base = { ...byMonth["2026-09"][0], statusErp: "Ativo" };
    const mk = (cod, extra = {}) => ({ ...L.applyImportToLead(null, { ...base, cod, dtInat: "2026-09-20", valorPedido: 0 }, "2026-09"), ...extra });
    const pedidos = indexPedidos([
      { cod: "0000002001", pedido: "P1", valor: 1500.5, data: "2026-09-12" },   // BP com zeros à esquerda
      { cod: "2001", pedido: "P2", valor: 499.5, data: "2026-09-25" },
      { cod: "2002", pedido: "P3", valor: 800, data: "2026-10-02" },            // fora do mês
      { cod: "2003", pedido: "P4", valor: 300, data: "2026-09-03" }
    ]);
    const chunks = () => [{ leads: [
      mk("2001"), mk("2002"),
      mk("2003", { valorPedido: 999, valorPedidoManual: true }),
      mk("2004", { stage: "negociando", status: "negociando" }),
      mk("2005", { stage: "ganho", status: "ganho" }),
      mk("2006", { stage: "perdido", status: "perdido" })
    ] }];

    await t("pedido do BP no mês vira tag PEDIDO IDENTIFICADO e preenche o valor", () => {
      const c = chunks();
      const r = applyPedidosMonth("2026-09", c, pedidos);
      const [l1, l2, l3] = c[0].leads;
      assert.strictEqual(r.identificados, 2);
      assert.deepStrictEqual(l1.pedidoIdentificado.pedidos, ["P1", "P2"]);
      assert.strictEqual(l1.pedidoIdentificado.valor, 2000);
      assert.strictEqual(l1.pedidoIdentificado.dtPrimeiro, "2026-09-12");
      assert.strictEqual(l1.valorPedido, 2000);
      assert.ok(l1.hist[0].t.startsWith("PEDIDO IDENTIFICADO, MOVA PARA GANHO"));
      assert.ok(!l2.pedidoIdentificado); // pedido de outubro não conta para setembro
      assert.strictEqual(l3.valorPedido, 999); // valor digitado pelo vendedor fica
      // rodar de novo sem mudança não regrava
      assert.strictEqual(applyPedidosMonth("2026-09", c, pedidos).touched.size, 0);
      // pedido cancelado some do Qlik: tag removida
      const r2 = applyPedidosMonth("2026-09", c, indexPedidos([{ cod: "2003", pedido: "P4", valor: 300, data: "2026-09-03" }]));
      assert.strictEqual(r2.removidos, 1);
      assert.strictEqual(c[0].leads[0].pedidoIdentificado, null);
    });
    await t("importação não troca o valor do pedido digitado ou identificado", () => {
      const c = chunks();
      applyPedidosMonth("2026-09", c, pedidos);
      const again = L.applyImportToLead(c[0].leads[0], { ...base, cod: "2001", dtInat: "2026-09-20", valorPedido: 10 }, "2026-09");
      assert.strictEqual(again.valorPedido, 2000);
      const manual = L.applyImportToLead(c[0].leads[2], { ...base, cod: "2003", dtInat: "2026-09-20", valorPedido: 10 }, "2026-09");
      assert.strictEqual(manual.valorPedido, 999);
    });
    await t("fechamento: tag vira Ganho, resto vira Perdido automático, Ganho/Perdido ficam", () => {
      const c = chunks();
      applyPedidosMonth("2026-09", c, pedidos);
      const r = closeMonthLogic("2026-09", { monthKey: "2026-09" }, c);
      const by = Object.fromEntries(c[0].leads.map(l => [l.cod, l]));
      assert.strictEqual(r.meta.fechado, true);
      assert.strictEqual(by["2001"].stage, "ganho"); assert.strictEqual(by["2001"].fechamentoAuto, "ganho");
      assert.strictEqual(by["2003"].stage, "ganho");
      assert.strictEqual(by["2002"].stage, "perdido"); assert.strictEqual(by["2002"].fechamentoAuto, "perdido");
      assert.strictEqual(by["2004"].stage, "perdido"); assert.strictEqual(by["2004"].fechamentoAuto, "perdido");
      assert.ok(by["2004"].hist[0].t.includes("sem ação do vendedor"));
      assert.strictEqual(by["2005"].fechamentoAuto, undefined);
      assert.strictEqual(by["2006"].fechamentoAuto, undefined);
      assert.strictEqual(r.ganhoAuto, 2); assert.strictEqual(r.perdidoAuto, 2);
    });
    await t("mês fechado fica congelado: sincronização, pedidos, limpeza e novo fechamento não mexem", async () => {
      const db = fakeFirestore();
      const m = mergeMonth("2026-09", null, [], [{ ...base, cod: "2001", dtInat: "2026-09-20" }], "Qlik");
      db.store["months/2026-09"] = m.meta;
      db.store["months/2026-09/chunks/c0"] = m.chunks[0];
      await commitPedidosMonth(db, "2026-09", pedidos);
      const f = await closeMonth(db, "2026-09");
      assert.strictEqual(f.ganhoAuto, 1);
      const congelado = JSON.stringify(db.store);
      const s1 = await commitMonth(db, "2026-09", [{ ...base, cod: "2001", dtInat: "2026-09-20", uf: "PR" }, { ...base, cod: "2999", dtInat: "2026-09-21" }], "Qlik");
      assert.strictEqual(s1.congelado, true);
      assert.strictEqual((await commitPedidosMonth(db, "2026-09", indexPedidos([]))).congelado, true);
      assert.strictEqual((await cleanupMonth(db, "2026-09", {})).congelado, true);
      assert.strictEqual((await closeMonth(db, "2026-09")).jaFechado, true);
      assert.strictEqual(JSON.stringify(db.store), congelado);
    });
  }

  console.log("Um mês por vez");
  {
    const base = { ...byMonth["2026-09"][0], statusErp: "Ativo" };
    await t("base do BI do mês fica no meta e só regrava quando muda", async () => {
      const db = fakeFirestore();
      const rows = [{ ...base, cod: "3001", dtInat: "2026-10-03" }, { ...base, cod: "3002", dtInat: "2026-10-30" }];
      await commitMonth(db, "2026-10", rows, "Qlik", { total: 2, de: "2026-10-01", ate: "2026-10-31" });
      assert.strictEqual(db.store["months/2026-10"].baseBI.total, 2);
      assert.strictEqual(db.store["months/2026-10"].baseBI.ate, "2026-10-31");
      const em = db.store["months/2026-10"].baseBI.em;
      const r = await commitMonth(db, "2026-10", rows, "Qlik", { total: 2, de: "2026-10-01", ate: "2026-10-31" });
      assert.strictEqual(r.atualizados, 0);
      assert.strictEqual(db.store["months/2026-10"].baseBI.em, em);
      await commitMonth(db, "2026-10", rows.concat([{ ...base, cod: "3003", dtInat: "2026-10-15" }]), "Qlik", { total: 3, de: "2026-10-01", ate: "2026-10-31" });
      assert.strictEqual(db.store["months/2026-10"].baseBI.total, 3);
    });
    await t("mês futuro sem cliente trabalhado é removido; com cliente trabalhado fica", async () => {
      const db = fakeFirestore();
      const put = (mk, leads) => { const m = mergeMonth(mk, null, [], leads, "Qlik"); db.store["months/" + mk] = m.meta; db.store[`months/${mk}/chunks/c0`] = m.chunks[0]; };
      put("2026-11", [{ ...base, cod: "4001", dtInat: "2026-11-10" }]);
      put("2026-12", [{ ...base, cod: "4002", dtInat: "2026-12-10" }]);
      db.store["months/2026-12/chunks/c0"].leads[0].notes = "ligar dia 2";
      const sim = await removeFutureMonth(db, "2026-11", { dryRun: true });
      assert.strictEqual(sim.apagado, true);
      assert.ok("months/2026-11" in db.store);
      assert.strictEqual((await removeFutureMonth(db, "2026-11")).apagado, true);
      assert.ok(!("months/2026-11" in db.store) && !("months/2026-11/chunks/c0" in db.store));
      const dez = await removeFutureMonth(db, "2026-12");
      assert.strictEqual(dez.apagado, false);
      assert.deepStrictEqual(dez.trabalhados.map(x => x.cod), ["4002"]);
    });
  }

  console.log("Movimentação só pelo vendedor durante o mês");
  {
    const base = { ...byMonth["2026-09"][0] };
    const hoje = new Date(); const futuro = new Date(hoje.getFullYear(), hoje.getMonth(), hoje.getDate() + 3);
    const isoF = `${futuro.getFullYear()}-${String(futuro.getMonth() + 1).padStart(2, "0")}-${String(futuro.getDate()).padStart(2, "0")}`;
    await t("Status ERP 'Recuperado...' ou 'Inativo' não move para Ganho/Perdido", () => {
      for(const st of ["Recuperado com faturamento", "Recuperado com pedido", "Inativo"]){
        const novo = L.applyImportToLead(null, { ...base, cod: "5001", dtInat: isoF, statusErp: "Ativo" }, "x");
        const r = L.applyImportToLead(novo, { ...base, cod: "5001", dtInat: isoF, statusErp: st }, "x");
        assert.strictEqual(r.stage, "inativam", st);
        assert.strictEqual(r.status, "inativam", st);
      }
    });
    await t("Ganho dado pela regra antiga do ERP volta; Ganho do vendedor fica", () => {
      const m = mergeMonth("2026-10", null, [], [{ ...base, cod: "5101", dtInat: isoF }, { ...base, cod: "5102", dtInat: isoF }], "Qlik");
      const [erp, vend] = m.chunks[0].leads;
      Object.assign(erp, { stage: "ganho", status: "ganho" });
      erp.hist.unshift({ d: "x", t: "Recuperado com faturamento: Data de Inativação (10/10/2026) condizente com o prazo — movido automaticamente para Ganho." });
      Object.assign(vend, { stage: "ganho", status: "ganho" });
      vend.hist.unshift({ d: "y", t: "Recuperado com pedido: Data de Inativação (10/10/2026) dentro do mês atual — movido automaticamente para Ganho." });
      vend.hist.unshift({ d: "z", t: 'Movido de "Inativam no mês" para "Ganho" — fechou pedido' });
      const r = mergeMonth("2026-10", m.meta, m.chunks, [], "Qlik");
      assert.strictEqual(r.revertidosErp, 1);
      assert.strictEqual(erp.stage, "inativam");
      assert.ok(erp.hist[0].t.startsWith('Voltou de "Ganho"'));
      assert.strictEqual(vend.stage, "ganho");
      assert.strictEqual(mergeMonth("2026-10", r.meta, r.chunks, [], "Qlik").revertidosErp, 0);
    });
  }

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
        set: (r, data) => writes.push([r.path, data]),
        delete: (r) => writes.push([r.path, undefined])
      };
      const result = await fn(tx);
      writes.forEach(([p, d]) => { if(d === undefined) delete store[p]; else store[p] = JSON.parse(JSON.stringify(d)); });
      return result;
    }
  };
}
