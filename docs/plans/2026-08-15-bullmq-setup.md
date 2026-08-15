# Instalação e configuração — BullMQ (fila de forward para Chatwoot)

Guia prático de instalação/config para a fila implementada em [2026-08-15-chatwoot-forward-queue.md](2026-08-15-chatwoot-forward-queue.md). Não introduz infraestrutura nova — reaproveita o Redis que já roda no `docker-compose.dev.yaml`.

## 1. Pré-requisito: Redis ativo

A fila usa o mesmo Redis já configurado para cache (`CACHE_REDIS_*`). Confirme que está ligado:

```bash
grep CACHE_REDIS_ENABLED .env
```

Deve retornar `CACHE_REDIS_ENABLED=true`. Se estiver `false`, a fila **não inicializa** — o código volta automaticamente para o modo síncrono antigo (sem quebrar nada, só sem o ganho de performance). Pra ativar a fila de verdade, precisa `true` aqui.

No ambiente dev, o serviço `redis` do `docker-compose.dev.yaml:29-48` já sobe isso. Confirme que está rodando:

```bash
docker compose -f docker-compose.dev.yaml ps redis
```

Em produção, aponte `CACHE_REDIS_URI` pro Redis já usado pela aplicação — não precisa instância separada só pra fila.

## 2. Instalar as dependências

```bash
npm install bullmq ioredis
```

Por quê `ioredis` além do `bullmq`: o projeto já usa Redis via pacote `redis` (node-redis v4) pro cache (`src/cache/rediscache.client.ts`), mas **BullMQ exige especificamente `ioredis`** — não funciona com o client `redis`. São duas conexões separadas com o mesmo servidor Redis, isso é normal e esperado, não é redundância.

## 3. Variáveis de ambiente

Adicione no `.env` (e documente no `env.example`, já coberto no Task 2 do plano):

```bash
# Fila de forward Baileys -> Chatwoot (BullMQ)
CHATWOOT_FORWARD_QUEUE_ENABLED=true      # liga/desliga a fila — kill-switch independente do Redis/cache
CHATWOOT_FORWARD_QUEUE_CONCURRENCY=5     # quantos jobs em paralelo o worker processa
CHATWOOT_FORWARD_QUEUE_ATTEMPTS=5        # tentativas antes de desistir do job (backoff exponencial)
CHATWOOT_FORWARD_QUEUE_TIMEOUT_MS=30000  # timeout por tentativa (protege contra Chatwoot travado)
```

Não existe `CHATWOOT_FORWARD_QUEUE_REDIS_URI` separado — a conexão do BullMQ reusa `CACHE_REDIS_URI` diretamente (ver `src/queues/bullmq-connection.ts` no plano). Menos uma variável pra desalinhar em produção.

### Como calibrar cada valor

- **`ENABLED`**: default `true` — fila liga sozinha assim que sobe (é o fix do bug relatado). Setar `false` força o comportamento síncrono antigo mesmo com Redis ligado — é o botão de rollback rápido se algo der errado em produção, sem precisar mexer em `CACHE_REDIS_ENABLED` (que afeta outras partes do sistema).
- **`CONCURRENCY`**: quantas mensagens forwarded pro Chatwoot em paralelo, por processo. Comece em 5. Suba se tiver muitas instâncias ativas simultâneas e o Chatwoot aguentar o tráfego; desça se começar a bater rate-limit do Chatwoot (HTTP 429 nos logs do worker).
- **`ATTEMPTS`**: 5 tentativas com backoff exponencial (2s, 4s, 8s, 16s, 32s) cobre bem instabilidade transitória de rede/Chatwoot. Não recomendo baixar — abaixo de 3 perde mensagem por qualquer soluço momentâneo.
- **`TIMEOUT_MS`**: 30s é generoso o bastante pra upload de mídia grande pro Chatwoot, mas curto o bastante pra não travar o worker indefinidamente caso o Chatwoot trave a conexão sem responder nem cair. Se seus anexos costumam ser grandes (vídeos longos), considere subir pra 60000.

## 4. Onde o worker sobe

Não precisa serviço/container novo. O worker BullMQ roda **dentro do mesmo processo** da API (`src/api/server.module.ts`, Task 7 do plano) — sobe automaticamente no boot quando `CHATWOOT_ENABLED=true` e Redis disponível. Não precisa `pm2`, processo separado, nem entrada nova no `docker-compose.dev.yaml`.

Se no futuro o volume justificar escalar o worker independente da API (processo/container dedicado), isso é extensão do que já foi construído — não precisa refazer nada, só extrair `startChatwootForwardWorker(...)` pra um entrypoint próprio.

## 5. Verificando que subiu certo

```bash
npm run dev:server
```

Procure no log de boot:

```
Chatwoot:ForwardQueue - ON
```

Se aparecer:

```
Chatwoot:ForwardQueue - OFF (CACHE_REDIS_ENABLED is false, falling back to synchronous forwarding)
```

Redis está desligado — fila não ativa, comportamento volta ao síncrono de antes (funciona, só sem o ganho).

## 6. Teste rápido fim-a-fim

1. Envie mensagem WhatsApp pra instância com Chatwoot configurado.
2. Log deve mostrar o job entrando na fila quase instantaneamente (sem esperar resposta do Chatwoot).
3. Mensagem aparece no inbox do Chatwoot em poucos segundos.
4. Confira no banco que os campos `chatwootMessageId` / `chatwootConversationId` da linha em `Message` foram preenchidos (o worker atualiza depois que o Chatwoot responde):

```bash
psql "$DATABASE_CONNECTION_URI" -c "select \"chatwootMessageId\", \"chatwootConversationId\" from \"Message\" order by \"createdAt\" desc limit 1;"
```

Roteiro completo de teste (incluindo simular Chatwoot lento/indisponível pra confirmar que não trava mais o fluxo Baileys) está no Task 8 do [plano de implementação](2026-08-15-chatwoot-forward-queue.md).

## 7. Troubleshooting

| Sintoma | Causa provável | Ação |
|---|---|---|
| `Chatwoot:ForwardQueue - OFF` no boot | `CHATWOOT_FORWARD_QUEUE_ENABLED=false` ou `CACHE_REDIS_ENABLED=false` | Checar as duas vars, ajustar, reiniciar |
| Jobs acumulando, nunca processam | Worker não subiu (erro silencioso no boot) | Checar log de erro do `ChatwootForwardWorker`/`BullMQConnection` |
| Mensagens demoram mas não travam mais outras | Comportamento esperado — job individual lento (Chatwoot lento), mas fila continua fluindo pros outros | Ajustar `TIMEOUT_MS`/investigar lentidão do lado do Chatwoot |
| Job falha e não tenta de novo | `ATTEMPTS` esgotado (5 tentativas) | Ver `worker.on('failed', ...)` no log — mensagem específica de erro |
| `Cannot find module 'ioredis'` ao rodar | Dependência não instalada | `npm install` |
| Uso de memória do Redis subindo | Fila entupindo (Chatwoot fora do ar por muito tempo) | `removeOnFail` já limita retenção a 24h — se persistir, investigar causa raiz do Chatwoot indisponível, não só a fila |
