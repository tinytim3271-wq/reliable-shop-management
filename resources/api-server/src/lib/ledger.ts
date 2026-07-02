import { eq } from "drizzle-orm";
import {
  db,
  mechanicsTable,
  timeEntriesTable,
  advancesTable,
  loansTable,
  type Mechanic,
} from "@workspace/db";
import { inRange } from "./dates";

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

export interface MechanicBalance {
  mechanicId: number;
  mechanicName: string;
  status: string;
  totalHours: number;
  grossPay: number;
  totalAdvances: number;
  deductibleAdvances: number;
  totalBorrowed: number;
  totalRepaid: number;
  outstandingLoanBalance: number;
  netPay: number;
}

function buildBalance(
  mechanic: Mechanic,
  timeEntries: { hours: number; totalPay: number }[],
  advances: { amount: number; deductFromPay: boolean }[],
  loans: { amountBorrowed: number; amountRepaid: number }[],
): MechanicBalance {
  const totalHours = timeEntries.reduce((sum, t) => sum + t.hours, 0);
  const grossPay = timeEntries.reduce((sum, t) => sum + t.totalPay, 0);
  const totalAdvances = advances.reduce((sum, a) => sum + a.amount, 0);
  const deductibleAdvances = advances
    .filter((a) => a.deductFromPay)
    .reduce((sum, a) => sum + a.amount, 0);
  const totalBorrowed = loans.reduce((sum, l) => sum + l.amountBorrowed, 0);
  const totalRepaid = loans.reduce((sum, l) => sum + l.amountRepaid, 0);
  const outstandingLoanBalance = totalBorrowed - totalRepaid;
  const netPay = grossPay - deductibleAdvances;

  return {
    mechanicId: mechanic.id,
    mechanicName: mechanic.name,
    status: mechanic.status,
    totalHours: round2(totalHours),
    grossPay: round2(grossPay),
    totalAdvances: round2(totalAdvances),
    deductibleAdvances: round2(deductibleAdvances),
    totalBorrowed: round2(totalBorrowed),
    totalRepaid: round2(totalRepaid),
    outstandingLoanBalance: round2(outstandingLoanBalance),
    netPay: round2(netPay),
  };
}

export async function computeMechanicBalance(
  mechanicId: number,
): Promise<MechanicBalance | null> {
  const [mechanic] = await db
    .select()
    .from(mechanicsTable)
    .where(eq(mechanicsTable.id, mechanicId));

  if (!mechanic) return null;

  const [timeEntries, advances, loans] = await Promise.all([
    db.select().from(timeEntriesTable).where(eq(timeEntriesTable.mechanicId, mechanicId)),
    db.select().from(advancesTable).where(eq(advancesTable.mechanicId, mechanicId)),
    db.select().from(loansTable).where(eq(loansTable.mechanicId, mechanicId)),
  ]);

  return buildBalance(mechanic, timeEntries, advances, loans);
}

export async function computeAllBalances(range?: {
  startDate?: string;
  endDate?: string;
}): Promise<MechanicBalance[]> {
  const [mechanics, timeEntries, advances, loans] = await Promise.all([
    db.select().from(mechanicsTable).orderBy(mechanicsTable.name),
    db.select().from(timeEntriesTable),
    db.select().from(advancesTable),
    db.select().from(loansTable),
  ]);

  // Payroll figures honor an optional pay-period window. Loans are NOT scoped:
  // a loan's amountRepaid accumulates on the row dated at borrowing time, so
  // date-filtering it would misreport balances (and payday ignores loans).
  const start = range?.startDate;
  const end = range?.endDate;
  const scopedTime =
    start || end ? timeEntries.filter((t) => inRange(t.date, start, end)) : timeEntries;
  const scopedAdvances =
    start || end ? advances.filter((a) => inRange(a.date, start, end)) : advances;

  return mechanics.map((mechanic) =>
    buildBalance(
      mechanic,
      scopedTime.filter((t) => t.mechanicId === mechanic.id),
      scopedAdvances.filter((a) => a.mechanicId === mechanic.id),
      loans.filter((l) => l.mechanicId === mechanic.id),
    ),
  );
}

export { round2 };
