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

if ($env:KIRO_PROVIDER_VERSION) {
  $version = $env:KIRO_PROVIDER_VERSION -replace '^v', ''
  $tag = "v$version"
  $url = "https://github.com/$Repo/releases/download/$tag/$asset"
} else {
  $tag = "latest"
  $url = "https://github.com/$Repo/releases/latest/download/$asset"
}

$temporaryDirectory = Join-Path ([System.IO.Path]::GetTempPath()) ([System.Guid]::NewGuid().ToString())
New-Item -ItemType Directory -Force -Path $temporaryDirectory | Out-Null

try {
  $downloadPath = Join-Path $temporaryDirectory $asset
  Write-Host "Installing $Bin (windows-$arch, $tag)"
  Write-Host "  from: $url"
  Write-Host "  to:   $(Join-Path $installDir "$Bin.exe")"

  Invoke-WebRequest -Uri $url -OutFile $downloadPath -UseBasicParsing
  if ((Get-Item $downloadPath).Length -eq 0) {
    Fail "downloaded asset is empty: $url"
  }

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
