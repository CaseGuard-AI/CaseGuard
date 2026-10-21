// Up to two letters for an avatar: the first letter of the first two words of the name.
export function initials(name: string): string {
  const letters = name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => Array.from(word)[0] ?? "");
  return letters.join("").toLocaleUpperCase();
}
