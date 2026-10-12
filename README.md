# Distributed Wagering Processor

Implementação do desafio técnico Jungle Gaming usando Bun 1.x, TypeScript strict, NestJS, PostgreSQL, TypeORM e AWS SQS via LocalStack. A autenticação fica fora do escopo: o ponto de extensão deve ser protegido por um Identity Provider (OIDC/Keycloak) antes de expor o serviço publicamente.

## Requisitos

- Bun 1.x
- Docker + Docker Compose

### Windows: escolha uma forma de preparar o projeto

Execute os comandos na pasta do projeto: `C:\Users\<seu-usuario>\Downloads\backend-challenge-solution\backend-challenge-solution`.

#### Opção 1 — instalador automático (recomendado)

Dê duplo clique em [`setup-windows.bat`](./setup-windows.bat). Ele verifica Bun e Docker Desktop, tenta instalá-los com WinGet se estiverem ausentes, cria `.env` sem substituir um existente, instala as dependências, inicia PostgreSQL e LocalStack, cria as filas SQS e executa as migrations.

Requisitos para esta opção:

- Windows com PowerShell e WinGet disponíveis.
- Conexão com a internet para baixar dependências e, se necessário, instalar Bun/Docker Desktop.
- Docker Desktop aberto e funcionando. Se a instalação exigir WSL 2, configuração inicial ou reinicialização, conclua essa etapa e execute o instalador de novo.

Quando o instalador informar `All requirements are ready`, pule para **Iniciar e testar a API** abaixo.

#### Opção 2 — configuração manual pelo PowerShell

Se Bun e Docker Desktop já estiverem instalados, abra o PowerShell na pasta do projeto. Se `bun` não for reconhecido, este bloco procura a instalação WinGet e adiciona o executável ao `PATH` apenas nesta janela:

```powershell
if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
  $bunExe = Get-ChildItem "$env:LOCALAPPDATA\Microsoft\WinGet\Packages\Oven-sh.Bun_*\bun-windows-x64\bun.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($bunExe) {
    $env:PATH = "$($bunExe.DirectoryName);$env:PATH"
  } else {
    throw "Bun não encontrado. Instale com: winget install --id Oven-sh.Bun -e; depois abra um novo terminal."
  }
}
bun --version
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
docker compose up -d postgres localstack
bun install
bun run migration:run
```

Crie as filas (é seguro repetir estes comandos; o LocalStack retorna a URL da fila existente):

```bash
docker compose exec localstack awslocal sqs create-queue --queue-name wager-transactions-dlq.fifo --attributes FifoQueue=true,ContentBasedDeduplication=true
docker compose exec localstack awslocal sqs create-queue --queue-name wager-transactions.fifo --attributes FifoQueue=true,ContentBasedDeduplication=true,VisibilityTimeout=30
docker compose exec localstack awslocal sqs create-queue --queue-name wager-events.fifo --attributes FifoQueue=true,ContentBasedDeduplication=true
```

#### Opção 3 — configuração manual pelo CMD

Se `bun` já funciona no CMD, prepare os arquivos e serviços assim:

```cmd
if not exist .env copy .env.example .env
docker compose up -d postgres localstack
bun install
bun run migration:run
```

Se o CMD disser que `bun` não é reconhecido e Bun foi instalado pelo WinGet, localize-o para a janela atual:

```cmd
for /d %I in ("%LOCALAPPDATA%\Microsoft\WinGet\Packages\Oven-sh.Bun_*") do set "PATH=%PATH%;%I\bun-windows-x64"
bun --version
```

Execute também os três comandos `docker compose exec ... create-queue` da opção PowerShell para criar as filas.

#### Iniciar e testar a API

Depois de qualquer uma das opções de preparação, inicie o servidor na pasta do projeto:

```text
bun run start
```

Deixe essa janela aberta e use outra para acessar `http://localhost:3000/health/ready`. O `.env.example` configura as URLs necessárias para as filas. A API HTTP processa as operações pelo mesmo use case que a entrada da fila; eventos financeiros são gravados na outbox dentro da transação SQL e publicados posteriormente.

Se Bun ou Docker Desktop ainda não estiverem instalados e você não usar o instalador automático, instale-os separadamente:

```text
winget install --id Oven-sh.Bun -e
winget install --id Docker.DockerDesktop -e
```

Após instalar Bun, abra um novo terminal. Inicie o Docker Desktop e conclua sua configuração inicial antes de executar `docker compose`.

## Endpoints

- `POST /wallets`
- `GET /wallets/:walletId`
- `GET /wallets/:walletId/ledger?cursor=...&limit=50`
- `POST /wallets/:walletId/reconciliation`
- `POST /wagering/transactions` (header obrigatório `Idempotency-Key`)
- `GET /wagering/transactions/:transactionId`
- `GET /providers/:providerId/wagering/transactions/:externalTransactionId`
- `GET /health/live`
- `GET /health/ready`
- `GET /metrics` (Prometheus text format)

Dinheiro entra e sai como string decimal com duas casas; nunca use `number` para valores monetários. Repetições idênticas retornam a transação persistida; uma idempotency key reutilizada com payload divergente é conflito.

## Decisões arquiteturais

Veja [`ARCHITECTURE.md`](./ARCHITECTURE.md) para locking, idempotência, ledger, outbox/inbox e limitações conhecidas.

## Validar

No Windows, execute os comandos abaixo em PowerShell ou CMD, a partir da pasta do projeto:

```bash
bun run test
bun run typecheck
bun run lint
bun run build
```

`bun run test` executa os testes unitários. A suíte de integração usa PostgreSQL e LocalStack reais, exige um banco dedicado cujo nome contenha `test` e não apaga dados. Inicie os containers e crie o banco de teste apenas se ainda não existir. Os comandos abaixo consultam o PostgreSQL antes de criá-lo, então podem ser repetidos sem erro:

```powershell
docker compose up -d postgres localstack
$testDatabaseExists = docker compose exec -T postgres psql -U wager -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='wagering_test'"
if ($testDatabaseExists.Trim() -ne "1") { docker compose exec -T postgres createdb -U wager wagering_test }
$env:TEST_DATABASE_URL = "postgres://wager:wager@localhost:5432/wagering_test"
$env:SQS_ENDPOINT = "http://localhost:4566"
bun run test:integration
```

No CMD, configure as variáveis no mesmo terminal antes de rodar os testes:

```cmd
docker compose up -d postgres localstack
docker compose exec -T postgres psql -U wager -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='wagering_test'" | findstr /x "1" >nul || docker compose exec -T postgres createdb -U wager wagering_test
set "TEST_DATABASE_URL=postgres://wager:wager@localhost:5432/wagering_test"
set "SQS_ENDPOINT=http://localhost:4566"
bun run test:integration
```

A suíte cria suas próprias filas FIFO no LocalStack, aplica as migrations no banco de teste e cobre idempotência concorrente em três conexões PostgreSQL, disputa de saldo, operações em três processos Bun, reprocessamento de referência, inbox/outbox e consumo com DLQ. Para encerrar os containers: `docker compose down`.
