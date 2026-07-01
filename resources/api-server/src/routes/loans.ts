import { Router, type IRouter } from "express";
import { eq, desc } from "drizzle-orm";
import { db, loansTable, mechanicsTable } from "@workspace/db";
import {
  ListLoansQueryParams,
  ListLoansResponse,
  CreateLoanBody,
  UpdateLoanParams,
  UpdateLoanBody,
  UpdateLoanResponse,
  DeleteLoanParams,
  RepayLoanParams,
  RepayLoanBody,
  RepayLoanResponse,
} from "@workspace/api-zod";
import { round2 } from "../lib/ledger";

const router: IRouter = Router();

type LoanRow = {
  id: number;
  mechanicId: number;
  mechanicName: string | null;
  date: string;
  amountBorrowed: number;
  amountRepaid: number;
  repaymentTerms: string | null;
  notes: string | null;
  createdAt: string;
};

const withBalance = (loan: LoanRow) => ({
  ...loan,
  remainingBalance: round2(loan.amountBorrowed - loan.amountRepaid),
});

const loanColumns = {
  id: loansTable.id,
  mechanicId: loansTable.mechanicId,
  mechanicName: mechanicsTable.name,
  date: loansTable.date,
  amountBorrowed: loansTable.amountBorrowed,
  amountRepaid: loansTable.amountRepaid,
  repaymentTerms: loansTable.repaymentTerms,
  notes: loansTable.notes,
  createdAt: loansTable.createdAt,
};

router.get("/loans", async (req, res): Promise<void> => {
  const query = ListLoansQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }

  const rows = await db
    .select(loanColumns)
    .from(loansTable)
    .leftJoin(mechanicsTable, eq(loansTable.mechanicId, mechanicsTable.id))
    .orderBy(desc(loansTable.date), desc(loansTable.id));

  const filtered = query.data.mechanicId
    ? rows.filter((r) => r.mechanicId === query.data.mechanicId)
    : rows;

  res.json(ListLoansResponse.parse(filtered.map(withBalance)));
});

router.post("/loans", async (req, res): Promise<void> => {
  const parsed = CreateLoanBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [created] = await db
    .insert(loansTable)
    .values({
      mechanicId: parsed.data.mechanicId,
      date: parsed.data.date,
      amountBorrowed: parsed.data.amountBorrowed,
      amountRepaid: parsed.data.amountRepaid ?? 0,
      repaymentTerms: parsed.data.repaymentTerms ?? null,
      notes: parsed.data.notes ?? null,
    })
    .returning();

  const [loan] = await db
    .select(loanColumns)
    .from(loansTable)
    .leftJoin(mechanicsTable, eq(loansTable.mechanicId, mechanicsTable.id))
    .where(eq(loansTable.id, created.id));

  res.status(201).json(UpdateLoanResponse.parse(withBalance(loan)));
});

router.patch("/loans/:id", async (req, res): Promise<void> => {
  const params = UpdateLoanParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const parsed = UpdateLoanBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [updated] = await db
    .update(loansTable)
    .set(parsed.data)
    .where(eq(loansTable.id, params.data.id))
    .returning();

  if (!updated) {
    res.status(404).json({ error: "Loan not found" });
    return;
  }

  const [loan] = await db
    .select(loanColumns)
    .from(loansTable)
    .leftJoin(mechanicsTable, eq(loansTable.mechanicId, mechanicsTable.id))
    .where(eq(loansTable.id, updated.id));

  res.json(UpdateLoanResponse.parse(withBalance(loan)));
});

router.post("/loans/:id/repay", async (req, res): Promise<void> => {
  const params = RepayLoanParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const parsed = RepayLoanBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [existing] = await db
    .select()
    .from(loansTable)
    .where(eq(loansTable.id, params.data.id));

  if (!existing) {
    res.status(404).json({ error: "Loan not found" });
    return;
  }

  const newRepaid = round2(existing.amountRepaid + parsed.data.amount);

  await db
    .update(loansTable)
    .set({ amountRepaid: newRepaid })
    .where(eq(loansTable.id, params.data.id));

  const [loan] = await db
    .select(loanColumns)
    .from(loansTable)
    .leftJoin(mechanicsTable, eq(loansTable.mechanicId, mechanicsTable.id))
    .where(eq(loansTable.id, params.data.id));

  res.json(RepayLoanResponse.parse(withBalance(loan)));
});

router.delete("/loans/:id", async (req, res): Promise<void> => {
  const params = DeleteLoanParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [loan] = await db
    .delete(loansTable)
    .where(eq(loansTable.id, params.data.id))
    .returning();

  if (!loan) {
    res.status(404).json({ error: "Loan not found" });
    return;
  }

  res.sendStatus(204);
});

export default router;
