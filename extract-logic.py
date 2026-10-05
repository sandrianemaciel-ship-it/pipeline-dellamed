"""Extrai as regras de negócio do HTML da pipeline para src/logic.js.
Assim o serviço usa exatamente as mesmas regras da página (sem reescrever à mão).
Uso: python3 tools/extract-logic.py "caminho/Pipeline.html"
"""
import sys, re, pathlib
html = pathlib.Path(sys.argv[1]).read_text(encoding="utf-8")

def block(start, end, include_end=False):
    i = html.index(start)
    j = html.index(end, i)
    if include_end:
        j += len(end)
    return html[i:j].rstrip() + "\n"

parts = [
  block("const TEAM_MAP = {", "// Cronograma semanal"),
  block("const STATUS_OPTIONS = [", "const STAGES = ["),
  "const STATUS_LABEL = Object.fromEntries(STATUS_OPTIONS.map(s=>[s.key,s.label]));\n",
  block("function stripAccents(s)", "// Formata um Date local"),
  "function nowISO(){ return new Date().toISOString(); }\n",
  block("const HIST_MAX = 5;", "function escapeHtml("),
  block("function deriveVendedor(fresh){", "// One-time migration"),
  block("const STATUS_ERP_RECUPERADO_FATURAMENTO", "// Classificação por estágio"),
  block("const HEADER_ALIASES = {", "function parseWorkbook(buffer){"),
]
# excelDateToISO usa XLSX.SSF (biblioteca do navegador) para datas numéricas;
# no servidor trocamos por uma conversão de número serial equivalente.
src = "\n".join(parts)
src = src.replace("const d = XLSX.SSF.parse_date_code(v);", "const d = serialToYMD(v);")
header = '''// ARQUIVO GERADO por tools/extract-logic.py a partir do HTML da pipeline.
// Não edite à mão: altere o HTML e rode o extrator de novo (npm run extract).
"use strict";
// Datas numéricas (Excel/Qlik usam o mesmo serial: dias desde 30/12/1899).
function serialToYMD(n){
  if(typeof n!=="number" || !isFinite(n)) return null;
  const ms = Math.round((Math.floor(n) - 25569) * 86400000);
  const d = new Date(ms);
  return {y:d.getUTCFullYear(), m:d.getUTCMonth()+1, d:d.getUTCDate()};
}
'''
footer = '''
module.exports = {
  TEAM_MAP, STATUS_OPTIONS, STATUS_LABEL, norm, lookupTeam, deriveVendedor,
  applyImportToLead, computeStatusStage, aliasHeader, excelDateToISO,
  cleanTxt, cleanNum, mesesInativarPorSegmento, pushHist, nowISO
};
'''
out = pathlib.Path(__file__).resolve().parent.parent / "src" / "logic.js"
out.write_text(header + src + footer, encoding="utf-8")
print("OK ->", out, len(src), "chars")
