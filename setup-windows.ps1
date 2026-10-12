$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

function Find-BunExecutable {
  $command = Get-Command bun.exe -ErrorAction SilentlyContinue
  if ($command) {
    return $command.Source
  }

  $packageRoot = Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Packages'
  $installed = Get-ChildItem (Join-Path $packageRoot 'Oven-sh.Bun_*\bun-windows-x64\bun.exe') -ErrorAction SilentlyContinue |
    Select-Object -First 1
  if ($installed) {
    $env:PATH = "$($installed.DirectoryName);$env:PATH"
    return $installed.FullName
  }

  return $null
}

function Invoke-CheckedCommand {
  param(
    [Parameter(Mandatory = $true)][string]$FilePath,
    [Parameter(Mandatory = $true)][string[]]$ArgumentList,
    [Parameter(Mandatory = $true)][string]$Description
  )

  & $FilePath @ArgumentList
  if ($LASTEXITCODE -ne 0) {
    throw "$Description failed with exit code $LASTEXITCODE."
  }
}

function Test-DockerEngine {
  docker info *> $null
  return $LASTEXITCODE -eq 0
}

Write-Host '== Checking Bun =='
$bun = Find-BunExecutable
if (-not $bun) {
  $winget = Get-Command winget.exe -ErrorAction SilentlyContinue
  if (-not $winget) {
    throw 'Bun is not installed and winget is unavailable. Install Bun from https://bun.sh, then run setup again.'
  }
  Invoke-CheckedCommand -FilePath $winget.Source -ArgumentList @(
    'install', '--id', 'Oven-sh.Bun', '-e', '--accept-package-agreements', '--accept-source-agreements'
  ) -Description 'Bun installation'
  $bun = Find-BunExecutable
}
if (-not $bun) {
  throw 'Bun installation completed, but bun.exe was not found. Restart Windows or install Bun, then run setup again.'
}
& $bun --version
if ($LASTEXITCODE -ne 0) {
  throw 'Bun was found but could not run.'
}

Write-Host '== Checking Docker Desktop =='
if (-not (Get-Command docker.exe -ErrorAction SilentlyContinue)) {
  $winget = Get-Command winget.exe -ErrorAction SilentlyContinue
  if (-not $winget) {
    throw 'Docker is not installed and winget is unavailable. Install Docker Desktop, then run setup again.'
  }
  Invoke-CheckedCommand -FilePath $winget.Source -ArgumentList @(
    'install', '--id', 'Docker.DockerDesktop', '-e', '--accept-package-agreements', '--accept-source-agreements'
  ) -Description 'Docker Desktop installation'
}

if (-not (Test-DockerEngine)) {
  $desktopCandidates = @(
    (Join-Path $env:ProgramFiles 'Docker\Docker\Docker Desktop.exe'),
    (Join-Path $env:LOCALAPPDATA 'Programs\Docker\Docker\Docker Desktop.exe')
  )
  $desktop = $desktopCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
  if (-not $desktop) {
    throw 'Docker Desktop is installed, but its executable was not found. Open Docker Desktop manually and run setup again.'
  }

  Write-Host 'Starting Docker Desktop; first startup can take a few minutes...'
  Start-Process -FilePath $desktop
  $engineReady = $false
  for ($attempt = 0; $attempt -lt 60; $attempt++) {
    Start-Sleep -Seconds 5
    if (Test-DockerEngine) {
      $engineReady = $true
      break
    }
  }
  if (-not $engineReady) {
    throw 'Docker Desktop did not become ready. Finish its first-run setup (including WSL 2 or a restart if requested), then run setup-windows.bat again.'
  }
}

Write-Host '== Preparing environment =='
if (-not (Test-Path '.env')) {
  Copy-Item '.env.example' '.env'
  Write-Host 'Created .env from .env.example.'
} else {
  Write-Host 'Keeping existing .env.'
}

Write-Host '== Installing project packages =='
Invoke-CheckedCommand -FilePath $bun -ArgumentList @('install') -Description 'bun install'

Write-Host '== Starting PostgreSQL and LocalStack =='
Invoke-CheckedCommand -FilePath 'docker' -ArgumentList @('compose', 'up', '-d', 'postgres', 'localstack') -Description 'Starting Docker services'

$postgresReady = $false
for ($attempt = 0; $attempt -lt 30; $attempt++) {
  docker compose exec -T postgres pg_isready -U wager -d wagering *> $null
  if ($LASTEXITCODE -eq 0) {
    $postgresReady = $true
    break
  }
  Start-Sleep -Seconds 2
}
if (-not $postgresReady) {
  throw 'PostgreSQL did not become ready. Check its status with: docker compose ps'
}

$localstackReady = $false
for ($attempt = 0; $attempt -lt 30; $attempt++) {
  docker compose exec -T localstack awslocal sqs list-queues *> $null
  if ($LASTEXITCODE -eq 0) {
    $localstackReady = $true
    break
  }
  Start-Sleep -Seconds 2
}
if (-not $localstackReady) {
  throw 'LocalStack did not become ready. Check its status with: docker compose ps'
}

Write-Host '== Creating SQS queues =='
$queueCommands = @(
  @('wager-transactions-dlq.fifo', 'FifoQueue=true,ContentBasedDeduplication=true'),
  @('wager-transactions.fifo', 'FifoQueue=true,ContentBasedDeduplication=true,VisibilityTimeout=30'),
  @('wager-events.fifo', 'FifoQueue=true,ContentBasedDeduplication=true')
)
foreach ($queue in $queueCommands) {
  Invoke-CheckedCommand -FilePath 'docker' -ArgumentList @(
    'compose', 'exec', '-T', 'localstack', 'awslocal', 'sqs', 'create-queue',
    '--queue-name', $queue[0], '--attributes', $queue[1]
  ) -Description "Creating SQS queue $($queue[0])"
}

Write-Host '== Running database migrations =='
Invoke-CheckedCommand -FilePath $bun -ArgumentList @('run', 'migration:run') -Description 'Database migrations'

Write-Host ''
Write-Host 'All requirements are ready.'
Write-Host 'Start the API with: bun run start'
Write-Host 'Then open another terminal and visit: http://localhost:3000/health/ready'
