param(
  [int]$Iterations = 120,
  [int]$PollSeconds = 180,
  [int]$MinToolCalls = 301,
  [int]$AppendCooldownSeconds = 600,
  [int]$MaxRounds = 12
)

$ErrorActionPreference = 'Stop'
$BaseUrl = 'https://sd8a11ch62e4kq5onetdg.apigateway-cn-shanghai.volceapi.com'
$Cookie = 'username=KzZd1nlyoi'
$TaskIds = @('K7SH2XS', 'UIVTKK0')
$StatePath = Join-Path $PSScriptRoot 'crowdtest34-monitor-state.json'
$LogPath = Join-Path $PSScriptRoot 'crowdtest34-monitor-v2.log'

function Write-MonitorLog([string]$Message) {
  $line = "$(Get-Date -Format o) $Message"
  Add-Content -Path $LogPath -Encoding utf8 -Value $line
  Write-Output $line
}

function Invoke-CrowdtestCurl([string[]]$Arguments) {
  $result = & curl.exe --max-time 60 --silent --show-error @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "curl failed with exit code ${LASTEXITCODE}: $result"
  }
  return $result
}

function Get-TaskDetails([string]$TaskId) {
  $url = "$BaseUrl/api/task_details/$TaskId`?_ts=$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())"
  $raw = Invoke-CrowdtestCurl @('-H', "Cookie: $Cookie", $url)
  if ([string]::IsNullOrWhiteSpace($raw)) {
    throw 'Task details response was empty'
  }
  return $raw | ConvertFrom-Json
}

function Get-RunSummary($Run) {
  $rounds = @($Run.rounds)
  if ($rounds.Count -eq 0) { $rounds = @($Run) }
  $latest = @($rounds | Where-Object { $_.isLatestRound } | Select-Object -First 1)
  if ($latest.Count -eq 0) { $latest = @($rounds | Select-Object -Last 1) }
  $latest = $latest[0]
  $total = 0
  foreach ($round in $rounds) {
    if ($null -ne $round.stats -and $null -ne $round.stats.toolCounts) {
      foreach ($property in $round.stats.toolCounts.PSObject.Properties) {
        $total += [int]$property.Value
      }
    }
  }
  return [PSCustomObject]@{
    Model = $Run.displayName
    ModelId = $Run.modelId
    TaskId = $latest.taskId
    Round = [int]$latest.roundNo
    Status = [string]$latest.status
    TotalToolCalls = $total
  }
}

function Get-ContinuationPrompt([string]$TaskId, [int]$Round) {
  if ($TaskId -eq 'K7SH2XS') {
    $topics = @(
      'Audit real chat, stream, task, pipeline, image, and video call sites for endpoint capability routing. Repair missing integration paths and add focused regression tests.',
      'Use fault injection to verify bounded fallback: retryable transport and 5xx failures may fall back, while auth, validation, policy, and safety failures must not. Check candidate de-duplication, loop protection, audit correlation, and safe errors.',
      'Review migration compatibility, audit query API authorization and pagination, endpoint and fallback visibility in Settings/Ops, and usage attribution. Repair concrete gaps and run focused verification.',
      'Perform final delivery hardening with unavailable candidates, explicit incompatible endpoints, all-fallback failure, long context, stream/tool constraints, and audit write failures. Fix only scope-relevant issues and document verification.'
    )
    return "Continue the same Woohoo Studio multi-endpoint routing, controlled fallback, and audit delivery. Review the prior round before changing code. $($topics[($Round - 2) % $topics.Count]) Implement the findings in the real React/Rust codebase, add or update offline tests, run relevant validation, and report exact files and results. Do not broaden scope or expose sensitive data."
  }

  $topics = @(
    'Review AI task and pipeline cursor semantics, Last-Event-ID or query-cursor replay, and explicit resync behavior. Repair real server and client integration paths and tests.',
    'Harden fragmented multi-line SSE parsing, duplicate and out-of-order events, terminal state monotonicity, duplicate refresh/toast suppression, and bounded reconnect behavior.',
    'Exercise disconnect completion, expired cursor, scope mismatch, 401 refresh, API-versus-SSE races, and restart after in-memory event loss. Repair observable error semantics and offline mock-stream tests.',
    'Perform final compatibility and delivery review: migration/backfill behavior, persistence or database resync fallback, request/run/task correlation, and completed/cancelled/blocked/failed/missing user-visible errors.'
  )
  return "Continue the same Woohoo Studio AI Task and Pipeline SSE disconnect recovery, replay, out-of-order idempotency, and visible-error delivery. Review the prior round before changing code. $($topics[($Round - 2) % $topics.Count]) Implement the findings in real integration paths, add focused regression tests, run relevant validation, and report exact files and results. Do not broaden scope or expose sensitive data."
}

function Start-Continuation([string]$ParentTaskId, $Run) {
  $task = @{
    baseDir = "INCREMENTAL_FROM_$ParentTaskId`_$($Run.ModelId)"
    title = 'Continue existing implementation'
    prompt = Get-ContinuationPrompt $ParentTaskId ($Run.Round + 1)
    taskBackground = ''
    taskOrigin = 'work'
    taskId = ([guid]::NewGuid().ToString('N').Substring(0, 8)).ToUpperInvariant()
    evaluationTaskId = $null
    harness = 'hermes'
    models = @($Run.ModelId)
    srcTaskId = $ParentTaskId
    srcModelName = $Run.ModelId
    appendToTaskId = $ParentTaskId
    appendModelId = $Run.ModelId
    userId = 6
    enableAgentTeams = $false
  }
  $payload = @{ task = $task } | ConvertTo-Json -Depth 8 -Compress
  return Invoke-CrowdtestCurl @('-X', 'POST', '-H', "Cookie: $Cookie", '-H', 'Content-Type: application/json; charset=utf-8', '--data-raw', $payload, "$BaseUrl/api/tasks")
}

$state = @{}
if (Test-Path $StatePath) {
  $loaded = Get-Content -Raw $StatePath | ConvertFrom-Json -AsHashtable
  if ($null -ne $loaded) { $state = $loaded }
}

for ($iteration = 1; $iteration -le $Iterations; $iteration += 1) {
  foreach ($parentTaskId in $TaskIds) {
    try {
      $details = Get-TaskDetails $parentTaskId
    } catch {
      Write-MonitorLog "$parentTaskId details failed: $($_.Exception.Message)"
      continue
    }

    foreach ($run in @($details.runs | ForEach-Object { Get-RunSummary $_ })) {
      $key = "$parentTaskId/$($run.ModelId)"
      Write-MonitorLog "$key round=$($run.Round) status=$($run.Status) calls=$($run.TotalToolCalls)"
      if ($run.TotalToolCalls -ge $MinToolCalls) { continue }
      if ($run.Round -ge $MaxRounds) {
        Write-MonitorLog "$key reached configured round limit $MaxRounds before call target"
        continue
      }
      if ($run.Status -notin @('completed', 'stopped', 'failed', 'error', 'evaluated')) { continue }

      $lastAttempt = $null
      if ($state.ContainsKey($key)) { $lastAttempt = [DateTimeOffset]::Parse($state[$key]) }
      if ($null -ne $lastAttempt -and (([DateTimeOffset]::UtcNow - $lastAttempt).TotalSeconds -lt $AppendCooldownSeconds)) {
        Write-MonitorLog "$key append cooldown active"
        continue
      }

      # Record first: the platform can accept a request while its gateway drops the response.
      $state[$key] = [DateTimeOffset]::UtcNow.ToString('o')
      $state | ConvertTo-Json | Set-Content -Encoding utf8 $StatePath
      try {
        $response = Start-Continuation $parentTaskId $run
        Write-MonitorLog "$key requested round $($run.Round + 1), response bytes=$($response.Length)"
      } catch {
        Write-MonitorLog "$key append request failed: $($_.Exception.Message)"
      }
    }
  }
  if ($iteration -lt $Iterations) { Start-Sleep -Seconds $PollSeconds }
}
