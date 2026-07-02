# Release Run Report - 2026-07-01

## Summary
Installer build and artifact generation succeeded.
Backend source build/test gate was not runnable in this packaged snapshot.

## Checklist Results
- Preflight artifact check: PASS
- Installer metadata check: PASS
- API build/test gate: SKIPPED (requires full monorepo workspace catalogs)
- Inno Setup compile: PASS
- Installer artifact presence: PASS
- SHA256 generation: PASS

## Produced Artifact
- Output/ReliableShopSystemsHub-Setup-1.0.0.exe
- Size: 180,730,166 bytes

## SHA256
- 02E59A82B4A8766810F9D23D22CAA933699C89C8279ADF61771294C60F6849DC

## Notes
- Legacy artifact also present: Output/mysetup.exe
- In this environment, ISCC was found at:
  C:\Users\secon\AppData\Local\Programs\Inno Setup 6\ISCC.exe

## Runtime Smoke Test Update
- Initial launch failure due to missing runtime modules: stripe-replit-sync, @electric-sql/pglite, drizzle-orm, zod.
- Remediation applied: rebuilt runtime dependencies in resources/api-server/.runtime-install and restored resources/api-server/node_modules.
- Post-remediation result: desktop app process starts and stays alive.
- API traffic observed from the running app (multiple /api/* requests completed).

## Current Functional Blocker
- Some API calls return 500 due to data validation mismatch in work-order status values.
- Observed Zod enum expects: open, in_progress, awaiting_parts, completed, invoiced.
- Observed persisted values include: paid, sent.
- Impact: /api/work-orders can fail with HTTP 500 until status normalization or enum compatibility handling is added.
