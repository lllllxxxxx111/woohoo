param(
    [Parameter(Mandatory = $true)]
    [string[]] $Models
)

Add-Type -AssemblyName System.Drawing

$Root = Resolve-Path (Join-Path $PSScriptRoot '..')

function Wrap-Line {
    param(
        [string] $Text,
        [int] $Width
    )
    if ($Text.Length -le $Width) { return @($Text) }

    $lines = New-Object System.Collections.Generic.List[string]
    $remaining = $Text
    while ($remaining.Length -gt $Width) {
        $breakAt = $remaining.LastIndexOf(' ', [Math]::Min($Width, $remaining.Length - 1))
        if ($breakAt -lt 20) { $breakAt = $Width }
        $lines.Add($remaining.Substring(0, $breakAt))
        $remaining = $remaining.Substring($breakAt).TrimStart()
    }
    if ($remaining.Length -gt 0) { $lines.Add($remaining) }
    return $lines
}

foreach ($Model in $Models) {
    $ReportPath = Join-Path $Root "eval-results\KQG0SD_${Model}_validation.txt"
    $OutputPath = Join-Path $Root "eval-results\KQG0SD_${Model}_validation.png"

    if (-not (Test-Path -LiteralPath $ReportPath)) {
        Write-Output "Missing report for $Model"
        continue
    }

    $report = Get-Content -LiteralPath $ReportPath
    $summaryStart = [Array]::IndexOf($report, '===== SUMMARY =====')
    $summaryLines = if ($summaryStart -ge 0) { $report[$summaryStart..([Math]::Min($summaryStart + 5, $report.Length - 1))] } else { @() }
    $errorLines = $report | Where-Object {
        $_ -match '^error(\[|:)' -or
        $_ -match '^\s*-->' -or
        $_ -match '^\s*\d+\s*\|' -or
        $_ -match 'could not compile'
    } | Select-Object -First 18

    $lines = New-Object System.Collections.Generic.List[string]
    $lines.Add("KQG0SD validation - $Model")
    $lines.Add("Generated: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')")
    $lines.Add("")
    $lines.AddRange([string[]]$summaryLines)
    $lines.Add("")
    $lines.Add("Key Rust failure:")
    if ($errorLines.Count -gt 0) {
        $lines.AddRange([string[]]$errorLines)
    } else {
        $lines.Add("No Rust error line found in report.")
    }
    $lines.Add("")
    $lines.Add("Full report: $ReportPath")

    $wrapped = New-Object System.Collections.Generic.List[string]
    foreach ($line in $lines) {
        foreach ($wrappedLine in (Wrap-Line -Text $line -Width 132)) {
            $wrapped.Add($wrappedLine)
        }
    }

    $width = 1500
    $lineHeight = 22
    $height = [Math]::Max(720, 80 + ($wrapped.Count * $lineHeight))
    $bitmap = New-Object System.Drawing.Bitmap($width, $height)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.Clear([System.Drawing.Color]::FromArgb(248, 250, 252))
    $graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::ClearTypeGridFit

    $titleFont = New-Object System.Drawing.Font('Consolas', 18, [System.Drawing.FontStyle]::Bold)
    $font = New-Object System.Drawing.Font('Consolas', 12, [System.Drawing.FontStyle]::Regular)
    $brush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(15, 23, 42))
    $mutedBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(71, 85, 105))
    $failBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(185, 28, 28))

    $y = 28
    for ($i = 0; $i -lt $wrapped.Count; $i++) {
        $line = $wrapped[$i]
        $lineBrush = if ($line -match 'FAIL|error|could not compile') { $failBrush } elseif ($line -match 'PASS|Generated|Full report|=====') { $mutedBrush } else { $brush }
        $lineFont = if ($i -eq 0) { $titleFont } else { $font }
        $graphics.DrawString($line, $lineFont, $lineBrush, 32, $y)
        $y += if ($i -eq 0) { 34 } else { $lineHeight }
    }

    $bitmap.Save($OutputPath, [System.Drawing.Imaging.ImageFormat]::Png)
    $graphics.Dispose()
    $bitmap.Dispose()
    Write-Output "Rendered $OutputPath"
}
