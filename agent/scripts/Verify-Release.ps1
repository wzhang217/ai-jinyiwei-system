[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateScript({ Test-Path -LiteralPath $_ -PathType Leaf })]
  [string]$MsiPath,

  [Parameter(Mandatory = $true)]
  [ValidateScript({ Test-Path -LiteralPath $_ -PathType Leaf })]
  [string]$ManifestPath,

  [string]$ExpectedVersion,

  [switch]$RequireSignature
)

$ErrorActionPreference = "Stop"

function Read-JsonFile([string]$Path) {
  try {
    return Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
  } catch {
    throw "Release manifest is not valid JSON: $Path"
  }
}

$resolvedMsi = (Resolve-Path -LiteralPath $MsiPath).Path
$manifest = Read-JsonFile -Path $ManifestPath
$fileName = Split-Path -Leaf $resolvedMsi

if ($manifest.product -ne "AI锦衣卫 Agent") {
  throw "Unexpected release product: $($manifest.product)"
}

$manifestVersion = [string]$manifest.agent_version
if ([string]::IsNullOrWhiteSpace($manifestVersion)) {
  throw "Release manifest is missing agent_version"
}
if ($ExpectedVersion -and $manifestVersion -ne $ExpectedVersion.Trim()) {
  throw "Agent version mismatch: expected $ExpectedVersion, manifest contains $manifestVersion"
}

$artifact = @($manifest.artifacts) | Where-Object { [string]$_.file -eq $fileName }
if ($artifact.Count -ne 1) {
  throw "Manifest must contain exactly one artifact named $fileName"
}

$expectedHash = ([string]$artifact[0].sha256).Trim().ToUpperInvariant()
if ($expectedHash -notmatch '^[A-F0-9]{64}$') {
  throw "Manifest contains an invalid SHA-256 for $fileName"
}

$actualHash = (Get-FileHash -LiteralPath $resolvedMsi -Algorithm SHA256).Hash.ToUpperInvariant()
if ($actualHash -ne $expectedHash) {
  throw "MSI SHA-256 mismatch: expected $expectedHash, actual $actualHash"
}

$signature = Get-AuthenticodeSignature -LiteralPath $resolvedMsi
$manifestSignatureStatus = [string]$artifact[0].signature_status
if (-not [string]::IsNullOrWhiteSpace($manifestSignatureStatus) -and $signature.Status.ToString() -ne $manifestSignatureStatus) {
  throw "MSI signature status differs from manifest: manifest=$manifestSignatureStatus, actual=$($signature.Status)"
}

$releaseChannel = [string]$manifest.release_channel
$signatureRequired = $RequireSignature -or $releaseChannel -eq "stable"
if ($signatureRequired -and $signature.Status -ne "Valid") {
  throw "A signed release is required, but Authenticode status is $($signature.Status)"
}
if ($signatureRequired -and $manifestSignatureStatus -ne "Valid") {
  throw "A signed release is required, but manifest signature_status is $manifestSignatureStatus"
}

$manifestSigner = [string]$artifact[0].signer
$actualSigner = if ($signature.SignerCertificate) { [string]$signature.SignerCertificate.Subject } else { "" }
if ($signatureRequired -and ([string]::IsNullOrWhiteSpace($manifestSigner) -or $manifestSigner -ne $actualSigner)) {
  throw "MSI signer differs from manifest"
}

[pscustomobject]@{
  ok = $true
  product = [string]$manifest.product
  version = $manifestVersion
  release_channel = $releaseChannel
  file = $fileName
  sha256 = $actualHash
  signature_status = $signature.Status.ToString()
  signer = if ($actualSigner) { $actualSigner } else { $null }
} | ConvertTo-Json -Compress
