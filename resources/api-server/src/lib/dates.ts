// Date helpers shared by reporting and ledger code. Kept dependency-free so
// both accounting.ts and ledger.ts can import them without a circular reference.

// All stored dates start with an ISO `YYYY-MM-DD` prefix (date columns and
// timestamp strings alike), so a 10-char slice gives a comparable day key.
export const dayOf = (s: string): string => s.slice(0, 10);
export const monthOf = (s: string): string => s.slice(0, 7);

export const inRange = (dateStr: string, start?: string, end?: string): boolean => {
  const d = dayOf(dateStr);
  if (start && d < dayOf(start)) return false;
  if (end && d > dayOf(end)) return false;
  return true;
};
