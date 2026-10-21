import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

// Merges class names and resolves Tailwind conflicts (the last one wins). Used by components/ui.
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
