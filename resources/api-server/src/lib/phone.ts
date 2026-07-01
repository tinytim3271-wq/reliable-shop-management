// Phone-number normalization toward E.164 (e.g. +15551234567).
//
// Real outbound texts go out through Twilio, which requires the recipient in
// E.164 format. Loosely-entered numbers like "(555) 123-4567" or "555-1234"
// are rejected by the provider and the text silently never arrives, so customer
// and shop-owner numbers are normalized on save and again before sending.
//
// The shop is North-American, so a number with no country code is assumed to be
// NANP (+1). Already-international numbers (leading "+") are accepted as-is when
// they fall within the E.164 length bounds.

// Human-readable error surfaced when a number cannot be normalized.
export const INVALID_PHONE_MESSAGE =
  "Enter a valid phone number (e.g. (555) 123-4567 or +15551234567).";

// Normalize a loosely-entered phone string to E.164, or return null when it
// cannot be (too short, too long, or otherwise not a dialable number). Pure
// function (no I/O) so it is trivial to unit test.
export function normalizeToE164(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const hasPlus = trimmed.startsWith("+");
  const digits = trimmed.replace(/\D/g, "");
  if (!digits) return null;

  if (hasPlus) {
    // Already international: E.164 allows up to 15 digits and a country code
    // never starts with 0.
    if (digits.length < 8 || digits.length > 15 || digits.startsWith("0")) {
      return null;
    }
    return `+${digits}`;
  }

  // No country code: assume North-American (+1).
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;

  return null;
}
