# Reliable Shop Systems Hub Release Checklist

## Scope
This checklist is for shipping a Windows installer from this workspace using the packaged app in win-unpacked and Inno Setup script rss.iss.

## 1) Preflight
Run these commands in PowerShell from the workspace root.

```powershell
Set-Location "c:\Users\secon\Dropbox\ReliableShopSystemsHub-Install-Package-1.0.0\win-unpacked"
Test-Path ".\Reliable Shop Systems Hub.exe"
Test-Path ".\resources\app.asar"
Test-Path ".\rss.iss"
```

Expected:
- All commands return True.

## 2) Version + Branding Gate
- Confirm version in installer script matches release version.
- Confirm publisher and URL are correct.
- Confirm output filename includes version.

Quick check:

```powershell
Select-String -Path ".\rss.iss" -Pattern "MyAppName|MyAppVersion|MyAppPublisher|MyAppURL|OutputBaseFilename"
```

## 3) Build / Refresh API bundle (if backend changed)
Only required if you edited api-server source AND you are in the full monorepo
with workspace catalogs configured.

Gate check:

```powershell
Set-Location "c:\Users\secon\Dropbox\ReliableShopSystemsHub-Install-Package-1.0.0\win-unpacked"
Test-Path ".\pnpm-workspace.yaml"
```

If True (full source monorepo), run from monorepo root:

```powershell
pnpm install
pnpm --filter @workspace/api-server run build
pnpm --filter @workspace/api-server run test
```

If False (packaged snapshot like this win-unpacked folder), skip this step and
validate the installed app via smoke tests instead.

## 4) Compile Installer
Requires Inno Setup 6 (ISCC.exe) installed.

Use auto-detect command (works for per-user installs from winget):

```powershell
Set-Location "c:\Users\secon\Dropbox\ReliableShopSystemsHub-Install-Package-1.0.0\win-unpacked"
$paths = @(
	"C:\Users\$env:USERNAME\AppData\Local\Programs\Inno Setup 6\ISCC.exe",
	"C:\Program Files (x86)\Inno Setup 6\ISCC.exe",
	"C:\Program Files\Inno Setup 6\ISCC.exe"
)
$iscc = $paths | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $iscc) { throw "ISCC.exe not found" }
& $iscc ".\rss.iss"
```

Expected output artifact:
- .\Output\ReliableShopSystemsHub-Setup-<version>.exe

## 5) Installer Smoke Test
Run on a clean Windows user profile or VM.

Install + launch:

```powershell
Start-Process ".\Output\ReliableShopSystemsHub-Setup-1.0.0.exe"
```

Smoke checklist:
- App installs to Program Files\Reliable Shop Systems Hub
- Desktop shortcut optional task works
- App launches without crash
- Local server starts and app UI loads
- Public pages load: /, /welcome, /book
- Login/setup flow reachable
- Create one test appointment and one test invoice

## 6) Uninstall Smoke Test
- Uninstall from Apps & Features
- Confirm app directory is removed (except expected user data)
- Confirm shortcuts are removed

## 7) Release Package
Prepare:
- Installer exe
- Release notes (what changed, known issues)
- SHA256 checksum

Generate checksum:

```powershell
$file = Get-ChildItem ".\Output\ReliableShopSystemsHub-Setup-*.exe" |
	Sort-Object LastWriteTime -Descending |
	Select-Object -First 1
Get-FileHash $file.FullName -Algorithm SHA256 | Format-List Path,Algorithm,Hash
```

## 8) Go/No-Go Criteria
Go only if:
- Installer compiles cleanly
- Install, launch, and core flows pass
- No blocker bugs in booking, work order, estimate/invoice
- Checksum generated and release notes prepared

## 9) Rollback Plan
- Keep previous stable installer available for immediate re-distribution.
- If severe production defect appears, pull current installer and publish previous stable build while patch is prepared.
