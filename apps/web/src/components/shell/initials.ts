// Up to two characters for an avatar: the first letter or digit of each of the first two words
// that have one, so "Admin (screenshots)" gives "AS", not "A(".
export function initials(name: string): string {
  const letters = name
    .trim()
    .split(/\s+/)
    .map((word) => word.match(/[\p{L}\p{N}]/u)?.[0] ?? "")
    .filter(Boolean)
    .slice(0, 2);
  return letters.join("").toLocaleUpperCase();
}
