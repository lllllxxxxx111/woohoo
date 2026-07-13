param(
    [Parameter(Mandatory = $true)]
    [string[]] $Artifacts
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
    Add-Content -LiteralPath $ReportPath -Value ("Started: " + (Get-Date).ToString("yyyy-MM-dd HH:mm:ss"))

    try {
        $output = & $Command 2>&1
        $exitCode = $LASTEXITCODE
        if ($null -eq $exitCode) { $exitCode = 0 }
        $output | ForEach-Object { Add-Content -LiteralPath $ReportPath -Value $_ }
    } catch {
        $exitCode = 1
        Add-Content -LiteralPath $ReportPath -Value $_.Exception.Message
    }

    Add-Content -LiteralPath $ReportPath -Value ("Ended: " + (Get-Date).ToString("yyyy-MM-dd HH:mm:ss"))
    Add-Content -LiteralPath $ReportPath -Value "EXIT_CODE=$exitCode"
    return [int]$exitCode
}

foreach ($Artifact in $Artifacts) {
    $ArtifactDir = Join-Path $Root ".eval-artifacts\$Artifact"
    $ReportPath = Join-Path $Root "eval-results\${Artifact}_validation.txt"

    Set-Content -LiteralPath $ReportPath -Value "Validation report for $Artifact"
    Add-Content -LiteralPath $ReportPath -Value ("Generated: " + (Get-Date).ToString("yyyy-MM-dd HH:mm:ss"))

    if (-not (Test-Path -LiteralPath $ArtifactDir)) {
        Add-Content -LiteralPath $ReportPath -Value "Artifact directory missing: $ArtifactDir"
        Add-Content -LiteralPath $ReportPath -Value "===== SUMMARY ====="
        Add-Content -LiteralPath $ReportPath -Value "download/extract: FAIL"
        Write-Output "DONE $Artifact FAIL missing"
        continue
    }

    $fileCount = (Get-ChildItem -LiteralPath $ArtifactDir -Recurse -File -ErrorAction SilentlyContinue | Measure-Object).Count
    Add-Content -LiteralPath $ReportPath -Value ("Artifact: " + (Resolve-Path $ArtifactDir))
    Add-Content -LiteralPath $ReportPath -Value "File count: $fileCount"
    Add-Content -LiteralPath $ReportPath -Value "Dependency note: quick packages were validated with workspace node_modules on PATH."

    if ($fileCount -eq 0) {
        Add-Content -LiteralPath $ReportPath -Value "Artifact directory is empty; platform download returned invalid zip or no package."
        Add-Content -LiteralPath $ReportPath -Value ""
        Add-Content -LiteralPath $ReportPath -Value "===== SUMMARY ====="
        Add-Content -LiteralPath $ReportPath -Value "download/extract: FAIL"
        Write-Output "DONE $Artifact FAIL empty"
        continue
    }

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
        Write-Output "DONE $Artifact FAIL $($failed -join ', ')"
    } else {
        Write-Output "DONE $Artifact PASS"
    }
}

$env:Path = $OriginalPath
