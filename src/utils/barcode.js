// Product barcodes are EAN-13, the format every retail scanner reads. Prefix "20" is GS1's
// restricted in-store range, so internally issued codes can never collide with a manufacturer's
// real EAN. Layout: "20" + 10-digit sequence + check digit, e.g. 2000000000015.
// Same scheme as the ERP frontend (lib/barcode.ts), so codes printed by either agree.

export const INTERNAL_PREFIX = "20";

export function ean13CheckDigit(first12) {
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(first12[i]) * (i % 2 === 0 ? 1 : 3);
  return (10 - (sum % 10)) % 10;
}

export function isValidEan13(code) {
  return typeof code === "string" && /^\d{13}$/.test(code) && ean13CheckDigit(code.slice(0, 12)) === Number(code[12]);
}

export function internalBarcode(sequence) {
  const first12 = INTERNAL_PREFIX + String(sequence).padStart(10, "0");
  return first12 + ean13CheckDigit(first12);
}

/** Sequence number of one of our internal codes, or 0 for anything else. */
export function barcodeSequence(code) {
  return typeof code === "string" && code.startsWith(INTERNAL_PREFIX) && isValidEan13(code) ? Number(code.slice(2, 12)) : 0;
}
