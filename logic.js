// ARQUIVO GERADO por tools/extract-logic.py a partir do HTML da pipeline.
// Não edite à mão: altere o HTML e rode o extrator de novo (npm run extract).
"use strict";
// Datas numéricas (Excel/Qlik usam o mesmo serial: dias desde 30/12/1899).
function serialToYMD(n){
  if(typeof n!=="number" || !isFinite(n)) return null;
  const ms = Math.round((Math.floor(n) - 25569) * 86400000);
  const d = new Date(ms);
  return {y:d.getUTCFullYear(), m:d.getUTCMonth()+1, d:d.getUTCDate()};
}
const TEAM_MAP = {
  "Supervisor Yghor - Boinas Azuis": ["HOEPFNER E HOEPFNER LTDA","PALOMA TABOAS REPRESENTACOES LTDA","PATRICIA DE OLIVEIRA ARRUDA","A.B.R. SERVICOS E REPRESENTACOES LTDA","MASTER VS REPRESENTACAO E COMERCIO DEPRODUTOS ORTOPEDICOS E COSMETICOS LTDAVSV MASTER","EQUIPMED REPRESENTACOES LTDASOMBRA DA ACACIA","REPMED REPRESENTACOES DE MATERIAL MEDICOLTDAREPMED REPRESENTACOES","VALENTE REPRESENTACOES LTDA","JOAO VITOR PADILHA - VENDAS EXTERNAS","CONEXXAO SUL ATACADO, VAREJO, ASSESSORIAE INTERMEDIACOES DE ARTIGOS ESPORTIVOS EMATERIAIS HOSPITALARES EIRELI","ANDELVAN RANGEL"],
  "Gerente Tamires - Licitações": ["CHEILA DOS SANTOS","FERNANDA WALESCA GARCIA"],
  "Instituições - Representante": ["GBE REPRESENTACAO DE PRODUTOS PARA SAUDELTDA"],
  "Líder de Vendas Leonardo": ["MARSEILLY ALVES FERREIRA","RILARI ANTONIA DA SILVA MARTINS","LEONARDO DE VARGAS DALPUBEL","ARTUR QUADRI GETTERT"],
  "Líder de Vendas Sandro": ["IURI SOARES BOENO","MARIA EDUARDA DE VARGAS WALTER","LUEZER DE VALERIO DELFIM","NICOLE AZEVEDO","SANDRO DANIEL THOMAZONI JUNIOR","TABITA DANIELI BORGES","MAIARA BOSCHETTI","EDUARDA RADATZ DA SILVA"],
  "Líder de Vendas Jessica": ["LUANA FERREIRA FIGUEREDO","MATHEUS RODRIGUES SOUSA","JESSICA SOARES PORTO","ESTEPHANY VICTORIA CAMARGO LUCEIRO","JULIANA VIEIRA DUARTE DE OLIVEIRA"],
  "Supervisor - Marvin": ["RIBEIRO REPRESENTACAO COMERCIAL LTDA","MARVIN DE CAMPOS","MEDICAL CARE REPRESENTACOES LTDA","SJN REPRESENTACAO COMERCIAL LTDA","KAREN ALVES CARDOSOKAS REPRESENTACOES","METAVENDAS SOLUCOES EM VENDAS LTDA","EDMAR CRUZ DA COSTA","M. IZABEL PIRES VIEIRA LTDA","CAN REPRESENTACAO COMERCIAL LTDA","A. DE L. WESEN LTDA -WM REPRESENTACOES","ALARCAO E MEIRELES REPRESENTACOES COMERC","B. B. DOS SANTOS REPRESENTACAO COMERCIAL","BARUCH APOIO ADMINISTRATIVO LTDA","CLEBER GOMES DE SOUZA","ENZ REPRESENTACOES LTDA","FORTPRIME REPRESENTACOES LTDAFORTPRIME","H. MED REPRESENTACOES LTDA","LIMA E REPRESENTACOES LTDA","RECOM REPRESENTACOES E SERVICOS LTDA","T C SOARES DOS SANTOS - I9 REPRESENTACOES","WK SERVICE LTDAWK PHARMA REPRESENTACOES"],
  "Líder de Vendas Sandriane": ["STEFANY DA ROSA BRANDAO SALDANHA","ISADORA KIMBERLY DA COSTA","KELLY VIEIRA DOS SANTOS","HELOISA GARCIA COLLING","ALESSANDRA ALVES DE SOUZA"],
  "Líder de Vendas Fabio": ["MILENA DA SILVA","FABIO JUNIOR RODRIGUES","THAIS DE SOUZA PORTES","NAUANY DE OLVEIRA RODRIGUES DE OLVEIRA RODRIGUES","LUCAS PRESTES DE SOUZA","VITOR DOS SANTOS RAMOS"],
  "Líder de Novos Canais - Patrícia": ["IMPACTO III REPRESENTACOES LTDA","H J TOLENTINO REPRESENTACOES"],
  "Líder de Vendas Luisa Tiscoski Abreu": ["LUISA TISCOSKI ABREU","LOHRANA RODRIGUES FERNANDES"],
  "Lider de Vendas - Raphael": ["C A DE A ALVES LTDA","ABSMED REPRESENTACOES COMERCIAIS LTDA","ALVES SIQUEIRA REPRESENTACOES E COMERCIO","C AGUIAR REPRESENTACOES E COMERCIO DEALIMENTOS LTDA","MALCA REPRESENTACOES LTDA","MENDES E GALINDO REPRESENTAÇÕESCOMERCIAIS LTDA","PAULO REPRESENTACOES LTDA","SOLUCOES REPRESENTACOES LTDA","NATUMED JS REPRESENTACOES LTDA"],
  "Supervisor Fasoli - Turbon 3P": ["LOUISE DE OLIVEIRA GESTEIRA","FELIPE FASOLI HORN","IMPACTO III REPRESENTACOES LTDA","ROBERTA SUAREZ GOMES"],
  "Key Account - Turbon 1P": ["ROBERTA SUAREZ GOMES"],
  "Líder de Vendas Marco - Inativos": [],
  "Líder de Vendas Sandro - Inativos": [],
  "Lider de Vendas - Raphael - Inativos": []
};
const TEAM_MEMBER_LOOKUP = {}; // normalized member name -> team label
Object.entries(TEAM_MAP).forEach(([team, members])=>{
  members.forEach(m=>{ const k = norm(m); if(!(k in TEAM_MEMBER_LOOKUP)) TEAM_MEMBER_LOOKUP[k] = team; });
});
function lookupTeam(name){ if(!name) return null; return TEAM_MEMBER_LOOKUP[norm(name)] || null; }

const STATUS_OPTIONS = [
  {key:"inativam", label:"Inativam no mês"},
  {key:"inativo", label:"Inativado"},
  {key:"proposta", label:"Proposta enviada"},
  {key:"negociando", label:"Negociando"},
  {key:"ganho", label:"Ganho"},
  {key:"perdido", label:"Negociação Perdida"}
];

const STATUS_LABEL = Object.fromEntries(STATUS_OPTIONS.map(s=>[s.key,s.label]));

function stripAccents(s){ return (s||"").normalize("NFD").replace(/\p{Diacritic}/gu,""); }
function norm(s){ return stripAccents(String(s||"")).toLowerCase().trim(); }
function todayLocal(){ const d=new Date(); d.setHours(0,0,0,0); return d; }
function parseISODate(s){ if(!s) return null; const [y,m,d]=s.split("-").map(Number); if(!y) return null; return new Date(y,(m||1)-1,d||1); }
// Calendar-correct "add N months" — clamps the day to the last day of the
// target month instead of letting JS Date overflow into the month after
// (e.g. 31/jan + 1 mês vira 28/fev, não 03/mar).
function addMonthsSafe(d, months){
  const y = d.getFullYear();
  const mTotal = d.getMonth() + months;
  const targetY = y + Math.floor(mTotal/12);
  const targetM = ((mTotal%12)+12)%12;
  const daysInTarget = new Date(targetY, targetM+1, 0).getDate();
  return new Date(targetY, targetM, Math.min(d.getDate(), daysInTarget));
}
// Nova Regra de Inativação (playbook Dellamed): prazo de meses sem comprar até
// o cliente ser considerado inativo, por segmento. Usada para conferir se a
// Data de Inativação vinda do ERP está condizente com a Data Último
// Faturamento, ao processar o status "Recuperado com faturamento" na
// importação. Nomes de segmento são comparados de forma tolerante a acento/
// caixa/pontuação e a truncamentos do export (ex.: "DISTRIBUIDOR CIRÚRGI...").
const SEG_MESES_INATIVAR_RAW = {
  3:  ["LOJISTA OFF CIRURGIC","FARMA INDEPENDENTE","LOJISTA ON","DISTRIBUIDOR CIRURGI","FARMA REDES","FARMA DISTRIBUIDOR","FARMA ASSO-ECONOMIZE","REDE VAREJISTA OFF"],
  6:  ["HOSPITAIS/CLINICAS","PUBLICO INSTITUIÇÃO","POSTOS AUTORIZADOS","FUNERÁRIA","LOJISTA OFF NÃO CIRÚ"],
  12: ["LOJ. LICITAÇÃO","PUBLICO LICITAÇÃO","COMPRADOR OCASIONAL","COMPRADOR TERCEIRO","ORG. FILANTRÓPICA"]
};
function normSeg(s){ return norm(s).replace(/[.\-\/]/g," ").replace(/\s+/g," ").trim(); }
const SEG_MESES_LOOKUP = (()=>{
  const arr = [];
  Object.entries(SEG_MESES_INATIVAR_RAW).forEach(([meses, list])=>{
    list.forEach(s=> arr.push({meses:Number(meses), norm:normSeg(s)}));
  });
  arr.sort((a,b)=> b.norm.length - a.norm.length); // entradas mais específicas primeiro
  return arr;
})();
function mesesInativarPorSegmento(segRaw){
  if(!segRaw) return null;
  const s = normSeg(segRaw);
  if(!s) return null;
  let hit = SEG_MESES_LOOKUP.find(e=>e.norm===s);
  if(!hit) hit = SEG_MESES_LOOKUP.find(e=> s.startsWith(e.norm) || e.norm.startsWith(s));
  return hit ? hit.meses : null;
}
function fmtDate(s){ const d=parseISODate(s); if(!d) return "—"; return d.toLocaleDateString("pt-BR"); }

function nowISO(){ return new Date().toISOString(); }

const HIST_MAX = 5;
function pushHist(lead, text){
  lead.hist = [{d: nowISO(), t: text}].concat(lead.hist||[]).slice(0, HIST_MAX);
}

function deriveVendedor(fresh){
  // Priority order per the retention playbook: Vendedor Interno (VE) → Key
  // Account (Z3) → Prospect (Z5) → Representante (Z1) → Sucesso do Cliente
  // (Z6) as a last resort, since a client is sometimes only tagged there.
  return fresh.vendInt || fresh.keyAcc || fresh.prospect || fresh.rep || fresh.sucCli || null;
}
function applyImportToLead(existing, fresh, monthKey){
  const now = nowISO();
  if(!existing){
    const derivedVendedor = deriveVendedor(fresh);
    const derivedTime = lookupTeam(derivedVendedor);
    const stageInicial = stageByDtInat(fresh.dtInat);
    return Object.assign({}, fresh, {
      stage: stageInicial,
      status: stageInicial,
      acao: null, time: derivedTime, vendedor: derivedVendedor, vendedorAuto: true, ofensor: null, ofensorDetalhe: null, notes: "",
      dtUltimoContato: null, dtProximoContato: null, horaProximoContato: null, valorProposta: null, linhasPositivadas: [],
      contatoDecisor: null, whatsapp: null, whatsappIndisponivel: false,
      baselineUltFat: fresh.dtUltFat,
      monthKey, createdAt: now, lastTouched: now, dataUpdatedAt: now,
      hist: [{d:now, t:"Importado"}]
    });
  }
  const derivedVendedor = deriveVendedor(fresh);
  const derivedTime = lookupTeam(derivedVendedor);
  // Only refresh Time/Vendedor automatically when they were auto-derived (or
  // never set) — a manual choice by the sales team is never overwritten by a
  // later import.
  const keepAuto = existing.vendedorAuto !== false;
  const merged = Object.assign({}, existing, fresh, {
    acao: existing.acao,
    time: keepAuto ? (derivedTime || existing.time) : existing.time,
    vendedor: keepAuto ? (derivedVendedor || existing.vendedor) : existing.vendedor,
    vendedorAuto: keepAuto,
    ofensor: existing.ofensor, ofensorDetalhe: existing.ofensorDetalhe || null,
    notes: existing.notes, baselineUltFat: existing.baselineUltFat,
    dtUltimoContato: existing.dtUltimoContato || null, dtProximoContato: existing.dtProximoContato || null,
    horaProximoContato: existing.horaProximoContato || null,
    valorProposta: existing.valorProposta || null, linhasPositivadas: existing.linhasPositivadas || [],
    contatoDecisor: existing.contatoDecisor || null, whatsapp: existing.whatsapp || null,
    whatsappIndisponivel: existing.whatsappIndisponivel || false,
    monthKey, createdAt: existing.createdAt, lastTouched: existing.lastTouched,
    dataUpdatedAt: now, stage: existing.stage
  });
  // Valor do pedido digitado pelo vendedor, ou vindo de pedido identificado no
  // Qlik, não é trocado pelo valor da base.
  if(existing.valorPedidoManual || existing.pedidoIdentificado) merged.valorPedido = existing.valorPedido;
  const computed = computeStatusStage(merged);
  merged.status = computed.status;
  merged.stage = computed.stage;
  merged.hist = existing.hist || [];
  pushHist(merged, "Atualizado via importação (status: "+STATUS_LABEL[computed.status]+")");
  if(computed.note) pushHist(merged, computed.note);
  return merged;
}

const STATUS_ERP_RECUPERADO_FATURAMENTO = "recuperado com faturamento";
const STATUS_ERP_RECUPERADO_PEDIDO = "recuperado com pedido";
// Regra da Data de Inativação: enquanto o lead está num estágio automático
// ("Inativam no mês" ou "Inativado"), quem define o estágio é a data:
// data já atingida (hoje ou antes) = Inativado; data futura = Inativam no mês.
// Estágios trabalhados pelo vendedor (Contato, Proposta, Negociando, Ganho,
// Negociação Perdida) nunca são mexidos por esta regra.
function stageByDtInat(dtInat){
  const d = parseISODate(dtInat);
  if(!d) return "inativam";
  return d.getTime() <= todayLocal().getTime() ? "inativo" : "inativam";
}
function computeStatusStage(lead){
  let status = lead.status || "inativam";
  let stage = lead.stage || "inativam";
  let note = null;
  const statusErpNorm = norm(lead.statusErp || "");

  if(lead.statusErp === "Inativo"){
    return {status:"perdido", stage:"inativo", note:null};
  }

  if(statusErpNorm === STATUS_ERP_RECUPERADO_FATURAMENTO){
    const meses = mesesInativarPorSegmento(lead.seg);
    const dtUltFat = parseISODate(lead.dtUltFat);
    const dtInat = parseISODate(lead.dtInat);
    if(meses!=null && dtUltFat && dtInat){
      const esperado = addMonthsSafe(dtUltFat, meses);
      const condizente = esperado.getFullYear()===dtInat.getFullYear() && esperado.getMonth()===dtInat.getMonth();
      if(condizente){
        status = "ganho"; stage = "ganho";
        note = `Recuperado com faturamento: Data de Inativação (${fmtDate(lead.dtInat)}) condizente com o prazo do segmento "${lead.seg||"—"}" (${meses} meses a partir do último faturamento em ${fmtDate(lead.dtUltFat)}) — movido automaticamente para Ganho.`;
      }else{
        const esperadoIso = esperado.getFullYear()+"-"+String(esperado.getMonth()+1).padStart(2,"0")+"-"+String(esperado.getDate()).padStart(2,"0");
        note = `Status ERP "Recuperado com faturamento" recebido, mas a Data de Inativação (${fmtDate(lead.dtInat)}) não bate com o prazo do segmento "${lead.seg||"—"}" (${meses} meses a partir de ${fmtDate(lead.dtUltFat)}, esperado ~${fmtDate(esperadoIso)}) — não movido automaticamente, revisar manualmente.`;
      }
    }else{
      const motivo = meses==null ? `segmento "${lead.seg||"—"}" não reconhecido na Nova Regra de Inativação` : "Data Último Faturamento ou Data de Inativação ausente";
      note = `Status ERP "Recuperado com faturamento" recebido, mas não foi possível conferir a regra (${motivo}) — não movido automaticamente, revisar manualmente.`;
    }
  }else if(statusErpNorm === STATUS_ERP_RECUPERADO_PEDIDO){
    const dtInat = parseISODate(lead.dtInat);
    const t = todayLocal();
    const condizente = dtInat && dtInat.getFullYear()===t.getFullYear() && dtInat.getMonth()===t.getMonth();
    if(condizente){
      status = "ganho"; stage = "ganho";
      note = `Recuperado com pedido: Data de Inativação (${fmtDate(lead.dtInat)}) dentro do mês atual — movido automaticamente para Ganho.`;
    }else{
      note = `Status ERP "Recuperado com pedido" recebido, mas a Data de Inativação (${fmtDate(lead.dtInat)}) não está no mês atual — não movido automaticamente, revisar manualmente.`;
    }
  }
  // Qualquer outro Status Atual (ERP) não movimenta o lead para Ganho. Se ele
  // continua num estágio automático, vale a regra da Data de Inativação.
  const AUTO = ["inativam", "inativo"];
  if(AUTO.includes(stage) && AUTO.includes(status)){
    status = stage = stageByDtInat(lead.dtInat);
  }
  return {status, stage, note};
}

const HEADER_ALIASES = {
  "cliente":"cli", "cod cliente":"cod","codigo cliente":"cod", "cod grupo":"codGrupo",
  "grupo de cliente":"grp","telefone":"tel","email":"email","uf":"uf","cidade":"cid","segmento":"seg",
  "tem carteira":"temCarteira","total pedidos pendentes":"pedPend","inadimplente":"inad","valor vencido":"valVenc",
  "data cadastro":"dtCad","data 1 faturamento":"dt1Fat","data ultimo faturamento":"dtUltFat","data inativacao":"dtInat",
  "status atual":"statusErp","data ultimo pedido aberto":"dtUltPedAberto",
  "valor de pedido":"valorPedidoExplicit","valor do pedido":"valorPedidoExplicit","valor pedido":"valorPedidoExplicit","vlr pedido":"valorPedidoExplicit","vlr de pedido":"valorPedidoExplicit",
  "representante (z1)":"rep","vendedor interno (ve)":"vendInt","key account (z3)":"keyAcc","prospect (z5)":"prospect",
  "sucesso do cliente (z6)":"sucCli","cnpj":"cnpj","razao social":"cli"
};
// Fallback keyword rules, tried when a header doesn't match HEADER_ALIASES
// exactly (e.g. slightly different spacing/punctuation around "(Z1)" etc. in
// a real ERP export). Order matters: first matching rule wins. This keeps
// Vendedor/Time derivation working even if a future export's header text
// drifts a little from the original file we built HEADER_ALIASES from.
const HEADER_KEYWORD_RULES = [
  ["representante","rep"],
  ["vendedor interno","vendInt"],
  ["key account","keyAcc"],
  ["prospect","prospect"],
  ["sucesso do cliente","sucCli"],
  ["razao social","cli"],
  ["cnpj","cnpj"],
  ["cod cliente","cod"],["codigo cliente","cod"],
  ["data inativ","dtInat"],
  ["data ultimo faturamento","dtUltFat"],
  ["status atual","statusErp"],
  // "Valor de Pedido" — cobre variações como "Valor Pedido", "Valor do
  // Pedido", "Vlr Pedido" etc. que a base ERP possa usar. NÃO deve ser
  // confundido com "Total Pedidos Pendentes" (pedPend), que é outro campo.
  ["valor de pedido","valorPedidoExplicit"],["valor do pedido","valorPedidoExplicit"],
  ["valor pedido","valorPedidoExplicit"],["vlr pedido","valorPedidoExplicit"]
];
function aliasHeader(h){
  const n = norm(h).replace(/[º°]/g,"").replace(/\s+/g," ").trim();
  if(HEADER_ALIASES[n]) return HEADER_ALIASES[n];
  for(const [kw, key] of HEADER_KEYWORD_RULES){
    if(n.includes(kw)) return key;
  }
  return null;
}
function excelDateToISO(v){
  if(v==null || v==="" || v==="-") return null;
  if(v instanceof Date) return v.toISOString().slice(0,10);
  if(typeof v === "number"){
    const d = serialToYMD(v);
    if(d) return `${d.y}-${String(d.m).padStart(2,"0")}-${String(d.d).padStart(2,"0")}`;
  }
  const s = String(v).trim();
  let m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if(m) return `${m[3]}-${m[2]}-${m[1]}`;
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if(m) return m[0].slice(0,10);
  return null;
}
function cleanTxt(v){
  if(v==null) return null;
  const s = String(v).trim();
  return (s==="" || s==="-") ? null : s;
}
// Corrige um bug real: quando o Excel já entrega um NÚMERO de verdade para a
// célula (a maioria dos exports numéricos), tratá-lo como texto no formato
// BR (milhar com ponto, decimal com vírgula) e tirar todos os pontos
// corrompia o valor — ex: 1105.84 virava "110584" (o ponto decimal também
// era removido), inflando o faturamento em 100x. Agora só aplicamos a
// conversão de formato BR quando o valor realmente chega como texto; um
// número que o Excel já entregou pronto é usado como está.
function cleanNum(v){
  if(v==null || v==="") return 0;
  if(typeof v === "number") return isFinite(v) ? v : 0;
  const s = String(v).trim();
  if(!s) return 0;
  // Só há formato BR (milhar "." + decimal ",") para desfazer quando existe
  // vírgula no texto; sem vírgula, tratamos o ponto como decimal normal
  // (ou o texto já é um número puro), em vez de arriscar removê-lo.
  const normalized = s.includes(",") ? s.replace(/\./g,"").replace(",", ".") : s;
  const n = Number(normalized);
  return isNaN(n) ? 0 : n;
}

module.exports = {
  TEAM_MAP, STATUS_OPTIONS, STATUS_LABEL, norm, lookupTeam, deriveVendedor,
  applyImportToLead, computeStatusStage, aliasHeader, excelDateToISO,
  cleanTxt, cleanNum, mesesInativarPorSegmento, pushHist, nowISO
};
