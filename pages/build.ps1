$ErrorActionPreference = "Stop"

$appRoot = Split-Path -Parent $PSScriptRoot
$output = Join-Path $PSScriptRoot "dist"

New-Item -ItemType Directory -Path $output -Force | Out-Null
Copy-Item -Path (Join-Path $appRoot "index.html") -Destination $output -Force

foreach ($directory in @("assets", "css", "js")) {
  Copy-Item -Path (Join-Path $appRoot $directory) -Destination $output -Recurse -Force
}

Copy-Item -Path (Join-Path $PSScriptRoot "_worker.js") -Destination (Join-Path $output "_worker.js") -Force
Write-Output "Pages build ready: $output"
