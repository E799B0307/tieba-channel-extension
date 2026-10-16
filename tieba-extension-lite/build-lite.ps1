# Build lite variant (pure chat, no bot)
# Usage: powershell -File build-lite.ps1  (run from project root)
# Output: dist/tieba-extension-lite/

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$dst = Join-Path $root "dist\tieba-extension-lite"

Write-Host "== Build lite variant =="
Write-Host "src:  $root"
Write-Host "dst:  $dst"

# 1. Clean old output
if (Test-Path $dst) { Remove-Item $dst -Recurse -Force }

# 2. Copy project (exclude dist/variants/docs/proxy/test/build script)
$exclude = @("dist", "variants", "docs", "proxy", "test", ".git", "build-lite.ps1")
New-Item -ItemType Directory -Force -Path $dst | Out-Null
Get-ChildItem $root -Force | Where-Object { $_.Name -notin $exclude } | ForEach-Object {
  Copy-Item $_.FullName -Destination $dst -Recurse -Force
}

# 3. Remove bot-only + unused files
$botFiles = @("bot.js", "keyword.js", "bilibili.js", "settings.html", "settings.js", "settings.css", "storage.js", "diag.mjs")
foreach ($f in $botFiles) {
  $p = Join-Path $dst $f
  if (Test-Path $p) { Remove-Item $p -Force }
}

# 4. Override with lite-specific files
Copy-Item (Join-Path $root "variants\lite\manifest.json") (Join-Path $dst "manifest.json") -Force
Copy-Item (Join-Path $root "variants\lite\background.js") (Join-Path $dst "background.js") -Force
Copy-Item (Join-Path $root "variants\lite\panel.html")  (Join-Path $dst "panel.html") -Force
Copy-Item (Join-Path $root "variants\lite\panel.js")    (Join-Path $dst "panel.js") -Force
Copy-Item (Join-Path $root "variants\lite\README.md")   (Join-Path $dst "README.md") -Force

# 5. Copy proxy exe next to the lite folder (sibling, for the release package)
$proxyExe = Join-Path $root "proxy\proxy.exe"
$releaseDir = Join-Path $root "dist"
if (Test-Path $proxyExe) {
  Copy-Item $proxyExe (Join-Path $releaseDir "tieba-proxy.exe") -Force
  Write-Host "proxy exe: $(Join-Path $releaseDir 'tieba-proxy.exe')"
} else {
  Write-Warning "proxy.exe not found (run 'pkg' in proxy/ first). Release package will lack the proxy."
}

Write-Host "== Done =="
Write-Host "Release folder: $releaseDir"
Write-Host "  - $dst  (load this folder in browser)"
Write-Host "  - tieba-proxy.exe  (double-click to run, keep it open while chatting)"
