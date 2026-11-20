# Chatcap native host installer for Windows (Chrome + Edge).
# Usage: .\native-host\install.ps1 -ExtensionId <32-letter-id>
param(
    [Parameter(Mandatory = $true)][string]$ExtensionId,
    [string]$Python = "",
    [switch]$SkipDeps
)

$ErrorActionPreference = "Stop"
$installer = Join-Path $PSScriptRoot "install_host.py"

# Use the Python that has the chatcap dependencies (venv if present).
if (-not $Python) {
    $venv = Join-Path (Split-Path -Parent $PSScriptRoot) ".venv\Scripts\python.exe"
    if (-not (Test-Path $venv)) {
        $venv = Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) ".venv\Scripts\python.exe"
    }
    $Python = if (Test-Path $venv) { $venv } else { "python" }
}

$argsList = @($installer, $ExtensionId)
if ($SkipDeps) { $argsList += "--skip-deps" }

& $Python @argsList
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
