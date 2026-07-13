param(
  [string]$BaseUrl = "https://sd8a11ch62e4kq5onetdg.apigateway-cn-shanghai.volceapi.com",
  [string]$Cookie = $env:CROWDTEST_COOKIE
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($Cookie)) {
  throw "Set CROWDTEST_COOKIE before running this script."
}

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$downloadDir = Join-Path $repoRoot "eval-results\downloads"
$artifactRoot = Join-Path $repoRoot ".eval-artifacts"
New-Item -ItemType Directory -Force -Path $downloadDir | Out-Null
New-Item -ItemType Directory -Force -Path $artifactRoot | Out-Null

$artifacts = @(
  @{ Name = "JVZUMA_tempest"; Url = "/api/download_zip_jobs/artifact__JVZUMA__WIUGIG__967KC__r22__a8__run2716__quick__v4__8cf86cff2b0265a8/file" },
  @{ Name = "JVZUMA_raptor"; Url = "/api/download_zip_jobs/artifact__JVZUMA__HQE0OA__D7YWL__r35__a2__run3056__quick__v4__2a75dbc672127b1d/file" },
  @{ Name = "JVZUMA_umbra"; Url = "/api/download_zip_jobs/artifact__JVZUMA__VCNZDG__H7ADN__r55__a1__run3413__quick__v4__be61068df5c62052/file" },
  @{ Name = "JVZUMA_saber"; Url = "/api/download_zip_jobs/artifact__JVZUMA__MR54OA__Z9KCY__r33__a4__run2922__quick__v4__66e14371bb3dcc57/file" },
  @{ Name = "MMLIPQ_tempest"; Url = "/api/download_zip_jobs/artifact__MMLIPQ__4YFMVQ__967KC__r31__a6__run3064__quick__v4__09e6ea9ef6e985f3/file" },
  @{ Name = "MMLIPQ_raptor"; Url = "/api/download_zip_jobs/artifact__MMLIPQ__OMKO8G__D7YWL__r23__a5__run2785__quick__v4__a2d60e550f225609/file" },
  @{ Name = "MMLIPQ_umbra"; Url = "/api/download_zip_jobs/artifact__MMLIPQ__IABDVA__H7ADN__r29__a5__run2928__quick__v4__94da19dfd4e5c4c6/file" },
  @{ Name = "MMLIPQ_saber"; Url = "/api/download_zip_jobs/artifact__MMLIPQ__O07VLA__Z9KCY__r26__a4__run2796__quick__v4__eb836fc93e29bfe7/file" }
)

foreach ($artifact in $artifacts) {
  $name = $artifact.Name
  $zipPath = Join-Path $downloadDir "$name`_quick.zip"
  $extractPath = Join-Path $artifactRoot $name
  $url = "$BaseUrl$($artifact.Url)"

  Write-Host "Downloading $name"
  Invoke-WebRequest -Uri $url -Headers @{ Cookie = $Cookie } -OutFile $zipPath -TimeoutSec 600

  if (Test-Path -LiteralPath $extractPath) {
    Remove-Item -LiteralPath $extractPath -Recurse -Force
  }
  New-Item -ItemType Directory -Force -Path $extractPath | Out-Null
  Expand-Archive -LiteralPath $zipPath -DestinationPath $extractPath -Force

  $fileCount = (Get-ChildItem -LiteralPath $extractPath -Recurse -File | Measure-Object).Count
  Write-Host "$name extracted files=$fileCount"
}
