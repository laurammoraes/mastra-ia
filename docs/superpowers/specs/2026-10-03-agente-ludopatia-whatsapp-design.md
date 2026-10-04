# Agente de atendimento WhatsApp — ações de ludopatia contra bets

**Data:** 2026-10-03
**Status:** design aprovado em conversa; aguardando revisão desta spec
**Base de código:** `~/dev/mastra-lab` (Mastra `@mastra/core` 1.63, Anthropic)

## 1. Objetivo

Construir um agente de atendimento no WhatsApp para um escritório de advocacia que atua em ações de
ludopatia contra casas de apostas (bets). O agente conduz o lead do primeiro contato até o cliente
fechado e entregue à advogada:

```
lead chega → consentimento LGPD → qualificação → proposta → contrato (ZapSign)
  → pagamento da entrada (Mercado Pago) → coleta de documentos → handoff para a advogada
```

Dois propósitos: (1) aprendizado aprofundado de Mastra + WhatsApp; (2) colocar em **produção** para
um escritório real.

### Critérios de sucesso

- Um lead real percorre o funil completo sem intervenção humana, e a advogada recebe o handoff com
  tudo o que precisa para iniciar o processo.
- O agente responde dúvidas, rajadas de mensagens e áudios a qualquer momento sem perder o estágio do funil.
- Nenhuma etapa sensível (contrato, cobrança, valores, qualificação) depende de decisão do LLM.
- Todos os cenários de eval (seção 9) passam antes de cada deploy.

### Fora de escopo

- Captação ativa (o agente nunca inicia conversa com quem não procurou o escritório).
- Negociação de honorários, parecer jurídico individual e acompanhamento processual após o handoff.
- Painel web próprio, CRM e multi-escritório.

## 2. Decisões tomadas

| Tema | Decisão |
|---|---|
| Canal | WhatsApp **Cloud API oficial** (Meta), número que já está no WhatsApp Business app, em **modo coexistência** |
| Honorários | **Entrada fixa + % de êxito**, valores tabelados em config; o agente não negocia |
| Contrato | **ZapSign** (modelo do escritório, link de assinatura enviado no WhatsApp) |
| Pagamento | **Mercado Pago** (PIX, boleto, cartão) |
| Ordem | Contrato → pagamento → **coleta de documentos depois do pagamento** |
| Handoff | Notificação no **WhatsApp da advogada**; ela assume a conversa pelo app no mesmo número |
| Documentos | Coletados pelo agente via WhatsApp, guardados em Storage privado |
| Arquitetura | **Um agente + ficha do caso com máquina de estágios controlada por código** (alternativas descartadas: workflow com suspend/resume, rígido demais para conversa livre; multiagente, complexo demais para um funil linear) |
| Modelo | Claude Sonnet (conversa); modelo leve para a checagem de risco |
| Infra | Supabase (Postgres + Storage privado); Railway ou Render para o servidor Mastra |

## 3. Arquitetura

```
WhatsApp (Cloud API, coexistência)
        │ webhook
        ▼
┌─ Servidor Mastra (Hono) ─────────────────────────────┐
│ /webhooks/whatsapp → normaliza (texto/áudio/doc)      │
│        → transcreve áudio → buffer 8s → fila por tel. │
│        → Agente "Atendente" (Claude Sonnet)           │
│             ├ lê/atualiza Ficha do Caso               │
│             ├ tools liberadas pelo estágio            │
│             └ responde via Cloud API                  │
│ /webhooks/zapsign      → contrato assinado → estágio  │
│ /webhooks/mercadopago  → pagamento aprovado → estágio │
│   (webhooks disparam mensagem proativa ao cliente)    │
│ echo da advogada (coexistência) → estágio = humano    │
└───────────────────────────────────────────────────────┘
        │
        ▼
Supabase: Postgres (fichas, memória Mastra, auditoria)
          Storage privado (documentos do cliente)
```

### Componentes (`src/`)

Cada módulo tem uma única responsabilidade e não conhece os internos dos outros.

| Módulo | Responsabilidade | Não faz |
|---|---|---|
| `whatsapp/` | Recebe e valida webhooks da Meta, baixa mídia (e salva documentos no Storage), envia mensagens e templates, detecta echo da advogada | Nada de regra de vendas |
| `ingest/` | Transcrição de áudio, buffer de rajadas (8s de silêncio), fila serial por telefone | Não chama integrações |
| `caso/` | Ficha do caso, máquina de estágios (**único** lugar que muda estágio, valida transições), critérios de qualificação | Não fala com o cliente |
| `config/` | Valores de honorários, critérios de qualificação, checklist de documentos, retenção, versão do aviso de privacidade | — |
| `mastra/agents/atendente` | Instruções, memória, montagem do contexto por turno, filtro de tools por estágio | Não muda estágio diretamente |
| `mastra/tools/` | Tools da seção 5 | — |
| `integracoes/zapsign` | Criar documento a partir do modelo, webhook de assinatura | — |
| `integracoes/mercadopago` | Criar cobrança, webhook de pagamento (confirmado via API) | — |
| `handoff/` | Montar resumo e notificar a advogada | — |
| `seguranca/` | Detecção de risco, mascaramento de PII em logs e traces, rotinas de retenção | — |

### Processamento de uma mensagem do cliente

1. `whatsapp/` valida a assinatura do webhook e descarta duplicatas (pelo id da mensagem).
2. Áudio → transcrição (OpenAI gpt-4o-transcribe/Whisper ou Groq), marcado como `[áudio transcrito]`.
   Documento ou imagem → salvo no Storage e repassado como `[arquivo recebido: <tipo>, <nome>]`.
3. `ingest/` acumula as mensagens até 8s de silêncio e entrega um único turno à fila daquele telefone.
4. Checagem de risco (seção 7). Se disparar, o turno não vai para o agente.
5. Se o estágio é `humano`, o turno é registrado e o agente **não** responde.
6. O agente recebe: a ficha do caso (estágio, campos coletados, pendências), as tools do estágio e o histórico.
7. A resposta é enviada pela Cloud API. Tudo fica registrado na trilha de auditoria.

## 4. Ficha do caso e estágios

**Ficha do caso** (uma por telefone ativo): id, telefone, nome, cidade/UF, consentimento (aceite,
data/hora, versão do aviso), campos de qualificação, estágio, motivo de desqualificação ou
transferência, id do documento ZapSign, id da cobrança Mercado Pago, checklist de documentos (item →
arquivo), timestamps, contador de lembretes.

| Estágio | Comportamento do agente | Transição → | Gatilho |
|---|---|---|---|
| `novo` | Apresenta-se como **assistente virtual** do escritório e pede consentimento para tratar dados de saúde (com link para o aviso) | `qualificando` / `encerrado` | tool `registrar_consentimento` |
| `qualificando` | Acolhe e coleta os campos um a um | `proposta` / `desqualificado` / `humano` | tool `salvar_qualificacao` (critérios aplicados por código) |
| `proposta` | Explica entrada + % de êxito, sem prometer resultado; tira dúvidas | `aguardando_assinatura` | tool `gerar_contrato` |
| `aguardando_assinatura` | Acompanha a assinatura e tira dúvidas sobre o contrato | `aguardando_pagamento` | **webhook ZapSign** |
| `aguardando_pagamento` | Envia a cobrança e acompanha | `coletando_docs` | **webhook Mercado Pago** (confirmado via API) |
| `coletando_docs` | Pede o checklist e confere o que já chegou | `entregue` | tool `finalizar_coleta` |
| `entregue` | Avisa que a Dra. vai assumir; dispara o handoff | — | código |
| `humano` | **Silêncio total** | volta só por comando da advogada | echo, risco, pedido do cliente, tool `transferir_para_humano` |
| `desqualificado` | Agradece com gentileza, sem cobrança; motivo registrado | — | código |
| `encerrado` | Recusou o consentimento; nenhum dado de caso é coletado | — | código |

**Campos de qualificação (placeholder até a validação da advogada):** nome, cidade/UF, plataformas
de aposta, período em que apostou, valor perdido aproximado, diagnóstico ou acompanhamento
(sim/não/em andamento), meios de pagamento usados (PIX/cartão/outros).

**Critérios de qualificação:** definidos em `config/` pela advogada (por exemplo, valor mínimo e
período não prescrito). O LLM coleta os dados; o código decide.

**Checklist de documentos (placeholder):** RG/CPF, comprovante de residência, extratos ou
comprovantes de PIX e cartão para as bets, laudo ou relatório médico (opcional).

**Silêncio do cliente:** um lembrete por template aprovado em ~24h e outro em ~72h, e depois nenhum
contato. Os templates são necessários fora da janela de 24h da Meta.

**Saídas transversais (qualquer estágio):** risco de vida, pedido de humano, cliente agressivo,
pedido de parecer jurídico e echo da advogada levam a `humano`.

## 5. Tools

O conjunto de tools é **filtrado por estágio a cada turno**: o agente não enxerga uma tool fora do
estágio dela.

| Tool | Estágios | O que faz | Garantias |
|---|---|---|---|
| `registrar_consentimento` | `novo` | Grava aceite ou recusa com data/hora e versão do aviso | Idempotente |
| `salvar_qualificacao` | `qualificando` | Salva campos (parcial ou completo); quando completo, o código decide o próximo estágio | O LLM não decide a qualificação |
| `consultar_base` | todos exceto `humano` | Busca na base de FAQ aprovada pela advogada | Só conteúdo revisado |
| `gerar_contrato` | `proposta` | Cria o documento na ZapSign a partir do modelo com dados da ficha e envia o link | Uma vez por caso; valores vêm da config |
| `reenviar_link` | `aguardando_assinatura`, `aguardando_pagamento` | Reenvia o link existente | Não cria um novo |
| `gerar_cobranca` | `aguardando_pagamento` | Cria a cobrança no Mercado Pago com o valor da config | Uma por caso; `external_reference` = id do caso |
| `registrar_documento` | `coletando_docs` | Classifica o arquivo já salvo e marca o item do checklist | O LLM só classifica; o upload é do código |
| `finalizar_coleta` | `coletando_docs` | Encerra a coleta e dispara o handoff | Exige os obrigatórios ou confirmação explícita do cliente |
| `transferir_para_humano` | todos | Muda para `humano` com motivo e notifica a advogada | Sempre disponível |

**Fora do alcance do LLM:** mudar estágio diretamente, confirmar assinatura ou pagamento, alterar
valores, enviar mensagens à advogada fora do handoff.

**Uso da cobrança:** `gerar_cobranca` roda automaticamente quando o webhook da ZapSign confirma a
assinatura (mensagem proativa). A tool fica disponível ao agente apenas para o caso de falha no envio.

## 6. Handoff

Disparado ao entrar em `entregue`. A advogada recebe no WhatsApp dela:

- Resumo do caso: dados da qualificação, plataformas, período e valores.
- Link do contrato assinado (ZapSign) e comprovante de pagamento.
- Lista de documentos com links temporários do Storage (expiram em 7 dias).
- Link `wa.me` para a conversa com o cliente.

O estágio vira `humano` de fato quando ela responde pelo app (echo de coexistência).

## 7. Segurança, LGPD e OAB

> Isto é o desenho técnico das salvaguardas, **não é parecer jurídico**. O aviso de privacidade e os
> textos do agente devem ser revisados pela advogada.

### LGPD (dados de saúde, art. 11)

- Consentimento específico e destacado antes de qualquer pergunta sobre o caso; aviso versionado.
- Transferência internacional (LLM e transcrição) declarada no aviso (art. 33); usar ZDR/DPA dos fornecedores quando disponível.
- Minimização: só os campos dos critérios. **Documentos não passam pelo LLM.**
- Retenção configurável: desqualificados, encerrados e abandonados apagados após 90 dias (padrão).
- Direitos do titular: comando da advogada que exporta ou apaga todos os dados de um telefone.

### Segurança técnica

- Validação de assinatura em todos os webhooks; pagamento confirmado via API do Mercado Pago, nunca só pelo payload.
- Storage privado com links temporários; segredos apenas em variáveis de ambiente.
- PII mascarada em logs e traces de observabilidade.
- Prompt injection: valores, estágios e decisões vêm de código e config, então o texto do cliente não tem onde agir.
- Idempotência em webhooks (id do evento) e tools (uma cobrança e um contrato por caso).

### OAB (Código de Ética + Provimento 205/2021)

- Identificação como assistente virtual; atendimento só receptivo; no máximo dois lembretes.
- Sem promessa de resultado e sem pressão; lista de frases proibidas verificada nos evals.
- Honorários apresentados de forma informativa, nunca como "promoção".
- Nenhum parecer individual: o caso vai para `humano` ou a resposta é "a Dra. avaliará no seu caso".

### Público vulnerável

- Detecção de risco em duas camadas: palavras-chave em código + modelo leve a cada turno.
- Ao disparar: resposta fixa (CVV 188, SAMU 192), estágio `humano` e alerta urgente para a advogada.
- Tom acolhedor e sem culpabilizar.

## 8. Tratamento de erros

| Situação | Comportamento |
|---|---|
| Falha na API do LLM | Retry com backoff; se persistir, mensagem curta ("tive um problema, já te respondo") e alerta |
| Falha na transcrição | Pedir ao cliente que escreva ou reenvie o áudio |
| Falha ZapSign / Mercado Pago | Retry; se persistir, `humano` com motivo e alerta |
| Webhook duplicado ou fora de ordem | Ignorado por idempotência; transição inválida rejeitada e registrada |
| Arquivo grande ou tipo não suportado | Pedir outro formato (PDF/JPG) |
| Mensagem durante processamento | Entra na fila daquele telefone, nunca em paralelo |

## 9. Testes

1. **Unitários:** transições de estágio (válidas e inválidas), critérios de qualificação, filtro de
   tools por estágio, idempotência, validação de assinatura de webhooks, mascaramento de PII,
   detecção de risco por palavras-chave.
2. **Integração (sandbox):** número de teste da Meta, ZapSign sandbox, Mercado Pago em modo teste.
   Funil completo até o handoff.
3. **Evals de conversa** (cliente simulado por LLM). Cada cenário verifica o **estado final da
   ficha** (objetivo) e passa por um juiz LLM de tom e frases proibidas:
   - caminho feliz;
   - dúvidas durante a cobrança;
   - rajada de mensagens;
   - áudio confuso;
   - sumiço e retorno após 3 dias;
   - pedido de desconto ou prompt injection;
   - pedido de parecer jurídico;
   - sinal de risco de vida;
   - recusa de consentimento;
   - desqualificação;
   - a advogada assume no meio.

## 10. Entregas

| Marco | Entrega | Definição de pronto |
|---|---|---|
| **M1. Núcleo** | Ficha do caso, máquina de estágios, agente com tools e FAQ, testável no Mastra Studio | Evals de conversa passam no Studio (sem WhatsApp) |
| **M2. WhatsApp** | Webhook da Cloud API (número de teste), buffer, fila, transcrição, recebimento de documentos | Conversa real no celular até a proposta |
| **M3. Fechamento** | ZapSign + Mercado Pago (sandbox), coleta de documentos, handoff | Funil completo no sandbox, handoff chega no WhatsApp da advogada |
| **M4. Salvaguardas** | Detecção de risco, coexistência/echo, templates de lembrete, retenção, mascaramento | Todos os cenários de eval passam |
| **M5. Produção** | Supabase em produção, deploy (Railway/Render), número real em coexistência, chaves de produção | Piloto com a advogada acompanhando as primeiras conversas |

## 11. Dependências externas (começar já)

- Verificação do negócio na Meta e aprovação dos templates (lembretes, mensagens proativas).
- Conta ZapSign com o modelo de contrato de honorários do escritório.
- Conta Mercado Pago do escritório.
- Da advogada: critérios de qualificação, valor da entrada, % de êxito, checklist de documentos,
  base de FAQ, aviso de privacidade revisado e prazo de retenção.

## 12. Notas de implementação

- Conforme o `AGENTS.md`: carregar a skill `mastra` antes de qualquer código e consultar a
  documentação da versão instalada (APIs mudam entre versões); registrar agentes e tools em
  `src/mastra/index.ts`; usar os scripts `dev`/`build` do `package.json`.
- Em desenvolvimento: LibSQL local já configurado, túnel (ngrok/Cloudflare) para webhooks. Em
  produção: Postgres do Supabase para a memória do Mastra e as fichas.
- Os agentes de exemplo existentes (`agent.ts`, `solar-agent.ts`) permanecem e não são afetados.
