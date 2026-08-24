[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateScript({ Test-Path -LiteralPath $_ -PathType Leaf })]
  [string]$MsiPath,

  [string]$ExpectedSha256,

  [ValidateScript({ Test-Path -LiteralPath $_ -PathType Leaf })]
  [string]$RollbackMsiPath,

  [switch]$VerifyOnly
)

$ErrorActionPreference = "Stop"

function Get-VerifiedMsi([string]$Path, [string]$ExpectedHash) {
  $resolved = (Resolve-Path -LiteralPath $Path).Path
  $hash = (Get-FileHash -LiteralPath $resolved -Algorithm SHA256).Hash.ToUpperInvariant()
  if ($ExpectedHash -and $hash -ne $ExpectedHash.Trim().ToUpperInvariant()) {
    throw "MSI SHA-256 mismatch: expected $ExpectedHash, actual $hash"
  }

  $signature = Get-AuthenticodeSignature -LiteralPath $resolved
  if ($signature.Status -ne "Valid") {
    throw "MSI Authenticode signature is not valid: $($signature.Status)"
  }

  return [pscustomobject]@{ Path = $resolved; Sha256 = $hash; Signer = $signature.SignerCertificate.Subject }
}

function Invoke-MsiInstall([string]$Path) {
  $arguments = "/i `"$Path`" /norestart /qn"
  $process = Start-Process -FilePath "msiexec.exe" -Verb RunAs -ArgumentList $arguments -Wait -PassThru
  if ($process.ExitCode -ne 0) {
    throw "msiexec failed with exit code $($process.ExitCode)"
  }
}

$target = Get-VerifiedMsi -Path $MsiPath -ExpectedHash $ExpectedSha256
Write-Host "Verified MSI: $($target.Path)"
Write-Host "SHA-256: $($target.Sha256)"
Write-Host "Signer: $($target.Signer)"

if ($VerifyOnly) {
  exit 0
}

try {
  Get-Process -Name "ai-jinyiwei-agent" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Invoke-MsiInstall -Path $target.Path
  Write-Host "Agent upgrade completed. Existing registration, Windows credential, and local queue were not removed."
} catch {
  $upgradeError = $_
  if (-not $RollbackMsiPath) {
    throw
  }

  Write-Warning "Upgrade failed; verifying and installing rollback MSI."
  $rollback = Get-VerifiedMsi -Path $RollbackMsiPath
  Invoke-MsiInstall -Path $rollback.Path
  Write-Warning "Rollback completed with MSI SHA-256 $($rollback.Sha256). Original error: $($upgradeError.Exception.Message)"
  exit 1
}
