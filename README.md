# Pipeline de Retenção Dellamed: sincronização com o Qlik

Este pacote liga a Pipeline de Retenção ao **Qlik Sense Enterprise**. Com ele, os clientes que vão inativar passam a vir direto do Qlik e ninguém precisa importar a planilha do ERP.

## Como funciona

```
Qlik Sense Enterprise ──(Engine API)──> serviço qlik-sync ──> Firestore ──> página da Pipeline
                                            ▲                                 │
                                            └──── botão "Sincronizar Qlik" ───┘
```

- **Automático:** o serviço busca os dados no horário configurado (padrão: 7h, de segunda a sexta).
- **Pelo botão:** quem tem permissão de importação clica em **Sincronizar Qlik** e a página grava um pedido no Firestore. O serviço atende o pedido na hora, e a página recarrega sozinha quando a sincronização termina.
- **Mesmas regras da página:** o arquivo `src/logic.js` é **extraído do próprio HTML**. Por isso valem exatamente as mesmas regras de hoje: Vendedor e Time pelo TEAM_MAP, regra de inativação por segmento, "Recuperado com faturamento/pedido" e "Inativo". O que o vendedor preencheu (estágio, ação, ofensor, observações, agenda) **nunca é sobrescrito**.
- **Chave do Qlik protegida:** a chave fica só no servidor onde o serviço roda, e não aparece no HTML.
- **Importação por planilha:** continua funcionando como alternativa.

## Onde instalar

Instale numa máquina que **enxergue o servidor do Qlik** (rede interna ou VPN) e fique ligada, por exemplo um servidor Windows da empresa ou o próprio servidor do Qlik. É preciso ter o **Node.js 18 ou mais recente**.

## Passo a passo

1. Copie esta pasta para a máquina e rode `npm install`.
2. Copie `.env.example` para `.env` e preencha:
   - `QLIK_HOST`: endereço do servidor do Qlik.
   - `QLIK_APP_ID`: ID do app, que aparece na URL `/sense/app/<ID>`.
   - `QLIK_OBJECT_ID`: ID da tabela com os clientes. Para achar, abra a planilha no Qlik, clique com o botão direito na tabela e procure o ID em *Compartilhar* ou *Incorporar*. No Dev Hub ele também aparece.
     - Se preferir, deixe o `QLIK_OBJECT_ID` vazio e liste os campos em `QLIK_FIELDS`.
   - **Autenticação** (confirme com o TI qual das duas o servidor usa):
     - `QLIK_AUTH=jwt`: preencha `QLIK_VIRTUAL_PROXY` (prefixo do virtual proxy JWT) e `QLIK_JWT` (o token).
     - `QLIK_AUTH=cert`: use os certificados exportados no QMC (`root.pem`, `client.pem`, `client_key.pem`) e um usuário de serviço.
3. **Chave do Firebase:** no Console do Firebase (projeto *pipeline-dellamed*), abra Configurações do projeto → Contas de serviço → **Gerar nova chave privada**. Salve o arquivo como `config/firebase-service-account.json`.
4. **Teste sem gravar nada:** `npm run dry-run`. O comando mostra quantos clientes vieram por mês, um exemplo de registro e quais colunas do Qlik ficaram sem correspondência.
5. Se alguma coluna tiver nome diferente do export do ERP, copie `config/column-map.example.json` para `config/column-map.json` e faça a correspondência.
6. **Primeira sincronização real:** `npm run once`.
7. **Deixe rodando:** `npm start`. Para iniciar junto com o Windows, instale como serviço, por exemplo com [NSSM](https://nssm.cc/): `nssm install PipelineQlikSync "C:\Program Files\nodejs\node.exe" "C:\caminho\qlik-sync\src\index.js"`. Se preferir, `pm2` também funciona.
8. Publique o HTML atualizado (`web/Pipeline de Retencao Dellamed.html`) no lugar do atual.

## Regra da Data de Inativação

Enquanto o cliente está em **Inativam no mês** ou **Inativado** (ninguém mexeu nele ainda), quem decide o estágio é a Data Inativação:

- **Data já atingida** (hoje ou antes): **Inativado**.
- **Data futura**: **Inativam no mês**.

A sincronização de hora em hora aplica a regra, então o cliente passa sozinho para Inativado quando a data chega. Clientes que o vendedor já trabalhou (Contato, Proposta, Negociando, Ganho, Negociação Perdida) não são mexidos.

## Ordem das colunas do Qlik

A leitura segue a ordem em que as colunas aparecem na tabela do Qlik (`qColumnOrder`). Antes, se a tabela tivesse sido reordenada na planilha, os valores caíam na coluna errada.

### Limpeza dos clientes gravados com colunas trocadas

Rode uma vez: aba **Actions** → **Sincronizar Qlik** → **Run workflow**, marcando **Limpar clientes gravados com colunas trocadas**. Se quiser ver antes o que vai acontecer, marque também **Só simular**. Na máquina local, o equivalente é `node index.js --once --limpar` (ou `--dry-run --limpar` para simular).

A limpeza compara o que está no Firestore com a leitura correta do Qlik:

- **Remove** o cliente quando ele está no mês errado, quando Razão Social/CNPJ/UF/Data Cadastro/Data 1º Faturamento não batem com o Qlik, ou quando o "código" tem formato de outra coluna. Só remove se **ninguém trabalhou** o cliente. A sincronização que roda logo depois recria os clientes certos, no mês certo.
- **Mantém** os clientes suspeitos que o vendedor já trabalhou e lista cada um no log para revisão manual. Os dados vindos do Qlik são corrigidos na sincronização, e o que o vendedor preencheu continua lá.
- Um mês que só tinha clientes trocados é apagado.

## Nomes de coluna reconhecidos automaticamente

São os mesmos do export do ERP: Cód Cliente, Razão Social/Cliente, CNPJ, UF, Cidade, Segmento, Telefone, Email, Tem Carteira, Total Pedidos Pendentes, Inadimplente, Valor Vencido, Data Cadastro, Data 1º Faturamento, Data Último Faturamento, **Data Inativação**, Status Atual, Data Último Pedido Aberto, Valor de Pedido, Representante (Z1), Vendedor Interno (VE), Key Account (Z3), Prospect (Z5), Sucesso do Cliente (Z6).

**Cód Cliente** e **Data Inativação** são obrigatórios. Linhas sem esses dois campos são ignoradas, igual acontece na importação por planilha.

## Configurações úteis (`.env`)

| Variável | Para que serve |
|---|---|
| `SYNC_CRON` | Horário automático, no formato cron e no horário de Brasília. `0 7 * * 1-5` = 7h de segunda a sexta. `0 7,13 * * *` = 7h e 13h todos os dias. |
| `SYNC_FROM_MONTH` | Ignora meses de inativação anteriores a este. Padrão: `2026-09`, início da pipeline. |
| `QLIK_REJECT_UNAUTHORIZED` | Use `false` só se o Qlik tiver certificado interno ou autoassinado. |

## Se algo der errado

- **O indicador "Qlik: falha…" aparece no topo da página:** passe o mouse sobre ele para ver a mensagem de erro. O log completo fica na janela ou no serviço onde o `npm start` roda.
- **Aviso "O serviço de sincronização do Qlik não respondeu":** o serviço está desligado.
- **Muitos clientes sem Vendedor ou Time:** as colunas Z1/VE/Z3/Z5 não foram reconhecidas. Veja o resultado do `dry-run` e ajuste o `column-map.json`.
- **Mudou alguma regra no HTML** (TEAM_MAP, segmentos etc.): rode `npm run extract -- "caminho/do/Pipeline.html"` para atualizar o `src/logic.js`.

## Testes

`npm test` testa o mapeamento, as regras e a gravação com dados simulados, sem precisar do Qlik nem do Firebase.
