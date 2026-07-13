param(
    [Parameter(Mandatory = $true)]
    [string[]] $Artifacts
)

Add-Type -AssemblyName System.Drawing

$Root = Resolve-Path (Join-Path $PSScriptRoot '..')

function Wrap-Line {
    param([string] $Text, [int] $Width)
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

foreach ($Artifact in $Artifacts) {
    $ReportPath = Join-Path $Root "eval-results\${Artifact}_light_validation.txt"
    $OutputPath = Join-Path $Root "eval-results\${Artifact}_validation.png"

    if (-not (Test-Path -LiteralPath $ReportPath)) {
        Write-Output "Missing report for $Artifact"
        continue
    }

    $report = Get-Content -LiteralPath $ReportPath
    $summaryStart = [Array]::IndexOf($report, '===== SUMMARY =====')
    $inspectionStart = [Array]::IndexOf($report, '===== IMPLEMENTATION INSPECTION =====')

    $summaryLines = if ($summaryStart -ge 0) {
        $report[$summaryStart..([Math]::Min($summaryStart + 8, $report.Length - 1))]
    } else {
        @($report | Where-Object { $_ -match 'download/extract|File count|PASS|FAIL' })
    }

    $inspectionLines = if ($inspectionStart -ge 0) {
        $report[$inspectionStart..([Math]::Min($inspectionStart + 34, $report.Length - 1))]
    } else {
        @()
    }

    $lines = New-Object System.Collections.Generic.List[string]
    $lines.Add("Agent artifact validation - $Artifact")
    $lines.Add("Generated: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')")
    $lines.Add("")
    $lines.AddRange([string[]]($report | Select-Object -First 4))
    $lines.Add("")
    $lines.AddRange([string[]]$summaryLines)
    if ($inspectionLines.Count -gt 0) {
        $lines.Add("")
        $lines.AddRange([string[]]$inspectionLines)
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
    $height = [Math]::Max(760, 80 + ($wrapped.Count * $lineHeight))
    $bitmap = New-Object System.Drawing.Bitmap($width, $height)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.Clear([System.Drawing.Color]::FromArgb(248, 250, 252))
    $graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::ClearTypeGridFit

    $titleFont = New-Object System.Drawing.Font('Consolas', 18, [System.Drawing.FontStyle]::Bold)
    $font = New-Object System.Drawing.Font('Consolas', 12, [System.Drawing.FontStyle]::Regular)
    $brush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(15, 23, 42))
    $mutedBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(71, 85, 105))
    $failBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(185, 28, 28))
    $passBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(22, 101, 52))

    $y = 28
    for ($i = 0; $i -lt $wrapped.Count; $i++) {
        $line = $wrapped[$i]
        $lineBrush = if ($line -match 'FAIL|download/extract') {
            $failBrush
        } elseif ($line -match 'PASS|Generated|Full report|=====') {
            $passBrush
        } elseif ($line -match 'File count|Artifact') {
            $mutedBrush
        } else {
            $brush
        }
        $lineFont = if ($i -eq 0) { $titleFont } else { $font }
        $graphics.DrawString($line, $lineFont, $lineBrush, 32, $y)
        $y += if ($i -eq 0) { 34 } else { $lineHeight }
    }

    $bitmap.Save($OutputPath, [System.Drawing.Imaging.ImageFormat]::Png)
    $graphics.Dispose()
    $bitmap.Dispose()
    Write-Output "Rendered $OutputPath"
}
