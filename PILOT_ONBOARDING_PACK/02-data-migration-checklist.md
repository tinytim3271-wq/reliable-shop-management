# Pilot Data Migration Checklist

## A) Discovery
- Confirm source systems (DMS, spreadsheets, POS exports).
- Collect sample export files for each data type.
- Confirm required fields and format per entity.
- Define data freeze window for cutover.

## B) Mapping
- Map customer fields: name, phone, email, address.
- Map vehicle fields: VIN, make/model/year, plate, mileage.
- Map appointments/work orders: status, dates, labor lines.
- Map estimates/invoices: totals, taxes, line-item details.
- Map inventory/parts: sku, qty, cost, sell price, vendor.

## C) Cleansing Rules
- Deduplicate customers by phone/email.
- Normalize phone format to E.164 where possible.
- Validate VIN length/character set.
- Remove blank rows and invalid totals.
- Flag missing mandatory fields for manual review.

## D) Trial Import
- Import a small pilot batch first.
- Validate random records with shop owner.
- Verify totals and tax math on migrated invoices.
- Verify appointment dates and timezone handling.
- Verify part quantities and cost/sell values.

## E) Full Import
- Take backup snapshot before final import.
- Run final import during agreed cutover window.
- Verify record counts by entity against source.
- Spot-check critical records with staff.
- Confirm no blocker errors remain.

## F) Post-Migration Validation
- Create one test appointment.
- Create one estimate and convert to invoice.
- Confirm customer/vehicle search works.
- Confirm inventory deductions on sold parts.
- Confirm reporting totals match expected baseline.

## G) Sign-Off
- Owner sign-off completed.
- Known data gaps documented.
- Follow-up cleanup tasks scheduled.
