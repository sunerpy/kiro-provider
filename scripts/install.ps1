$ErrorActionPreference = "Stop"

$Repo = "sunerpy/kiro-provider"
$Bin = "kiro-provider"

function Fail([string]$Message) {
  throw $Message
}

$architecture = if ($env:PROCESSOR_ARCHITEW6432) {
  $env:PROCESSOR_ARCHITEW6432
} else {
  $env:PROCESSOR_ARCHITECTURE
}

switch ($architecture) {
  "AMD64" { $arch = "x64" }
  default { Fail "unsupported Windows architecture: $architecture (supported: AMD64)" }
}

$asset = "$Bin-windows-$arch.exe"
$installDir = if ($env:KIRO_PROVIDER_INSTALL_DIR) {
  $env:KIRO_PROVIDER_INSTALL_DIR
} else {
  Join-Path $HOME ".local\bin"
}

# KIRO_PROVIDER_VERSION pins a release tag (with or without the leading "v").
# Without it the script follows releases/latest; pin it for reproducible installs.
if ($env:KIRO_PROVIDER_VERSION) {
  $version = $env:KIRO_PROVIDER_VERSION -replace '^v', ''
  $tag = "v$version"
  $baseUrl = "https://github.com/$Repo/releases/download/$tag"
} else {
  $tag = "latest"
  $baseUrl = "https://github.com/$Repo/releases/latest/download"
}
$url = "$baseUrl/$asset"
$sumsUrl = "$baseUrl/SHA256SUMS"

$temporaryDirectory = Join-Path ([System.IO.Path]::GetTempPath()) ([System.Guid]::NewGuid().ToString())
New-Item -ItemType Directory -Force -Path $temporaryDirectory | Out-Null

try {
  $downloadPath = Join-Path $temporaryDirectory $asset
  $sumsPath = Join-Path $temporaryDirectory "SHA256SUMS"
  Write-Host "Installing $Bin (windows-$arch, $tag)"
  Write-Host "  from: $url"
  Write-Host "  to:   $(Join-Path $installDir "$Bin.exe")"

  # Fetch the checksum manifest first so a release published mid-install cannot
  # pair a newer binary with an older manifest without failing verification.
  Invoke-WebRequest -Uri $sumsUrl -OutFile $sumsPath -UseBasicParsing
  $pattern = '^([0-9a-fA-F]{64})\s+\*?' + [regex]::Escape($asset) + '$'
  $entry = Get-Content -LiteralPath $sumsPath | Where-Object { $_ -match $pattern } | Select-Object -First 1
  if (-not $entry) {
    Fail "SHA256SUMS for $tag has no entry for $asset"
  }
  $expected = [regex]::Match($entry, $pattern).Groups[1].Value.ToLowerInvariant()

  Invoke-WebRequest -Uri $url -OutFile $downloadPath -UseBasicParsing
  if ((Get-Item $downloadPath).Length -eq 0) {
    Fail "downloaded asset is empty: $url"
  }

  $actual = (Get-FileHash -LiteralPath $downloadPath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -ne $expected) {
    Fail "checksum mismatch for $asset ($tag): expected $expected, got $actual. Refusing to install; retry, or pin a release with `$env:KIRO_PROVIDER_VERSION = '<version>'."
  }
  Write-Host "  sha256: $actual (verified against SHA256SUMS)"

  New-Item -ItemType Directory -Force -Path $installDir | Out-Null
  Move-Item -Force -Path $downloadPath -Destination (Join-Path $installDir "$Bin.exe")
  Write-Host "Installed $Bin to $(Join-Path $installDir "$Bin.exe")"

  $pathEntries = $env:Path -split ';'
  if ($pathEntries -notcontains $installDir) {
    Write-Host "NOTE: $installDir is not on PATH. Add it with:"
    Write-Host "  [Environment]::SetEnvironmentVariable('Path', `"$installDir;`$([Environment]::GetEnvironmentVariable('Path', 'User'))`", 'User')"
  }

  Write-Host "Quick start:"
  Write-Host "  $Bin --help"
  Write-Host "  $Bin login"
  Write-Host "  $Bin serve"
} finally {
  Remove-Item -Recurse -Force $temporaryDirectory -ErrorAction SilentlyContinue
}
