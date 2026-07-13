param(
    [Parameter(Mandatory = $true)]
    [string[]] $Models
)

$ErrorActionPreference = 'Continue'

$Root = Resolve-Path (Join-Path $PSScriptRoot '..')
$BinPath = Join-Path $Root 'node_modules\.bin'
$OriginalPath = $env:Path
$env:Path = "$BinPath;$OriginalPath"

function Invoke-ValidationStep {
    param(
        [Parameter(Mandatory = $true)]
        [string] $Label,
        [Parameter(Mandatory = $true)]
        [scriptblock] $Command,
        [Parameter(Mandatory = $true)]
        [string] $ReportPath
    )

    Add-Content -LiteralPath $ReportPath -Value ""
    Add-Content -LiteralPath $ReportPath -Value "===== $Label ====="
    $started = Get-Date
    Add-Content -LiteralPath $ReportPath -Value ("Started: " + $started.ToString("yyyy-MM-dd HH:mm:ss"))

    try {
        $output = & $Command 2>&1
        $exitCode = $LASTEXITCODE
        if ($null -eq $exitCode) { $exitCode = 0 }
        $output | ForEach-Object { Add-Content -LiteralPath $ReportPath -Value $_ }
    } catch {
        $exitCode = 1
        Add-Content -LiteralPath $ReportPath -Value $_.Exception.Message
    }

    $ended = Get-Date
    Add-Content -LiteralPath $ReportPath -Value ("Ended: " + $ended.ToString("yyyy-MM-dd HH:mm:ss"))
    Add-Content -LiteralPath $ReportPath -Value "EXIT_CODE=$exitCode"
    return [int]$exitCode
}

foreach ($Model in $Models) {
    $ArtifactDir = Join-Path $Root ".eval-artifacts\KQG0SD_$Model"
    $ReportPath = Join-Path $Root "eval-results\KQG0SD_${Model}_validation.txt"

    if (-not (Test-Path -LiteralPath $ArtifactDir)) {
        "Missing artifact directory: $ArtifactDir" | Set-Content -LiteralPath $ReportPath
        Write-Output "MISSING $Model"
        continue
    }

    Set-Content -LiteralPath $ReportPath -Value "Validation report for KQG0SD / $Model"
    Add-Content -LiteralPath $ReportPath -Value ("Artifact: " + (Resolve-Path $ArtifactDir))
    Add-Content -LiteralPath $ReportPath -Value ("Generated: " + (Get-Date).ToString("yyyy-MM-dd HH:mm:ss"))
    Add-Content -LiteralPath $ReportPath -Value "Dependency note: quick packages were validated with workspace node_modules on PATH."

    Push-Location $ArtifactDir
    try {
        $results = [ordered]@{}
        $results['npm run typecheck'] = Invoke-ValidationStep -Label 'npm run typecheck' -Command { npm.cmd run typecheck } -ReportPath $ReportPath
        $results['npm run test'] = Invoke-ValidationStep -Label 'npm run test' -Command { npm.cmd run test } -ReportPath $ReportPath
        $results['npm run build'] = Invoke-ValidationStep -Label 'npm run build' -Command { npm.cmd run build } -ReportPath $ReportPath
        $results['cargo check'] = Invoke-ValidationStep -Label 'cargo check --manifest-path server\Cargo.toml' -Command { cargo.exe check --manifest-path server\Cargo.toml } -ReportPath $ReportPath
    } finally {
        Pop-Location
    }

    Add-Content -LiteralPath $ReportPath -Value ""
    Add-Content -LiteralPath $ReportPath -Value "===== SUMMARY ====="
    foreach ($key in $results.Keys) {
        $status = if ($results[$key] -eq 0) { 'PASS' } else { 'FAIL' }
        Add-Content -LiteralPath $ReportPath -Value "${key}: $status (exit $($results[$key]))"
    }

    $failed = @($results.Keys | Where-Object { $results[$_] -ne 0 })
    if ($failed.Count -gt 0) {
        Write-Output "DONE $Model FAIL $($failed -join ', ')"
    } else {
        Write-Output "DONE $Model PASS"
    }
}

$env:Path = $OriginalPath
