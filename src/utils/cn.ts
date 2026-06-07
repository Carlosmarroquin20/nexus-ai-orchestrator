import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Conditional class composer. `clsx` resolves conditionals/arrays; `twMerge`
 * then collapses conflicting Tailwind utilities so the last-declared wins
 * (e.g. `px-2 px-4` -> `px-4`). Use for every dynamic `className` in the UI layer.
 */
export const cn = (...inputs: ClassValue[]): string => twMerge(clsx(inputs));
