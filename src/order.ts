/** Locale-independent ordering by JavaScript UTF-16 code units. */
export function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
