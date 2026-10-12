# Arquitetura e trade-offs

## Domínio e valores monetários

`Money` é um objeto de valor imutável, baseado em `decimal.js`. Ele aceita somente strings decimais, normaliza a saída para duas casas decimais e verifica a compatibilidade entre moedas. `Wallet` controla as transições de saldo e versão. Os DTOs HTTP validam o formato dos dados; as validações do domínio continuam sendo a autoridade final.

## Concorrência

O caso de uso de transação bloqueia a linha da carteira de destino com `SELECT ... FOR UPDATE` no PostgreSQL. Isso serializa alterações em uma mesma carteira, permitindo que carteiras diferentes sejam processadas em paralelo. As restrições `UNIQUE` do PostgreSQL continuam sendo a autoridade final para a identidade da carteira, a identidade da transação no provedor, as chaves de idempotência e a existência de apenas uma linha no ledger por transação/carteira. A restrição `CHECK` do banco impede saldos negativos, e o gatilho do ledger proíbe alterações e exclusões.

## Idempotência

O payload da requisição é canonicalizado pela ordenação das chaves dos objetos e recebe um hash SHA-256. A chave de idempotência persistida é única. Uma repetição idêntica retorna a transação armazenada e o saldo resultante; um hash diferente gera um conflito. O registro de idempotência e os efeitos financeiros fazem parte da mesma transação do banco de dados.

## Ledger e reconciliação

Cada transação que altera o saldo cria uma linha imutável no ledger dentro da mesma transação SQL que atualiza a carteira. Transações `LOSS` e rejeitadas não criam linhas no ledger. A reconciliação reconstrói o saldo a partir de todas as entradas do ledger e informa qualquer diferença, sem corrigi-la silenciosamente.

## Inbox/outbox

As linhas da inbox são persistidas no PostgreSQL. Para mensagens SQS de solicitação de aposta, a linha da inbox é inserida e marcada como processada na mesma transação que executa o caso de uso. Os eventos da outbox são inseridos junto com as alterações financeiras, e um worker os publica somente após o commit. O publicador reivindica as linhas com `FOR UPDATE SKIP LOCKED`, usa um lease temporário para tentativas e marca a publicação após o SQS aceitar a mensagem. A entrega continua sendo *at-least-once*; os consumidores dos eventos precisam deduplicar usando `eventId`.

Reversões não resolvidas mantêm uma contagem persistente de tentativas e uma data/hora para a próxima tentativa. Uma consulta agendada ao banco reivindica as linhas vencidas com `SKIP LOCKED`, tenta novamente usando backoff exponencial limitado a 256 segundos e rejeita a solicitação após 12 tentativas, com `REFERENCE_NOT_FOUND` ou `REFERENCE_NOT_PROCESSED`. Falhas transitórias do SQS usam backoff exponencial de visibilidade; mensagens malformadas ou não suportadas são encaminhadas diretamente para a DLQ configurada, e outras falhas são enviadas para a dead-letter queue após `SQS_MAX_RECEIVE_COUNT` tentativas (5 por padrão). Rejeições por regras de negócio são terminais e confirmadas.

Durante o encerramento do Nest, a aplicação aguarda a conclusão da long poll ativa do SQS e do lote em andamento. As solicitações já confirmadas na inbox podem ser entregues novamente com segurança, pois o registro na inbox e o caso de uso financeiro compartilham uma transação SQL.

## Autenticação

Não implementada, conforme permitido explicitamente pelo desafio. `ProviderIdentityGuard` é o ponto de extensão explícito e sem implementação, e permite todas as requisições deliberadamente. Antes de disponibilizar o serviço publicamente, substitua-o pela verificação de identidade do provedor via OIDC (por exemplo, com Keycloak). Esse guard não autentica os endpoints de saúde.

## Limitações restantes

- As métricas são contadores e medidores Prometheus locais ao processo; agregue-as entre réplicas no backend de monitoramento. Os logs são JSON para falhas dos workers e não incluem payloads financeiros completos.
- A suíte de integração usa PostgreSQL real e LocalStack, incluindo três processos do sistema operacional, o roteamento de mensagens malformadas para a DLQ, entregas SQS repetidas, recuperação de referências pendentes e publicadores concorrentes da outbox. Ela ainda não encerra um worker exatamente entre o commit SQL e a confirmação da mensagem, nem testa o esgotamento de tentativas após falhas transitórias de recebimento.
- A suíte de integração ainda não automatiza uma recuperação completa após reiniciar a aplicação com uma mensagem SQS em andamento.
- O serviço publica eventos de integração na fila de eventos; os consumidores de negócio específicos de cada evento estão fora do escopo deste processador.
- Um rollback e um reembolso podem, cada um, reverter a mesma referência uma vez, conforme a regra por tipo. O índice único parcial e o bloqueio da carteira garantem isso entre instâncias.
- O TypeORM é usado porque é explicitamente aceito pela especificação. A migração pode ser revertida, e as restrições do esquema são criadas explicitamente.
