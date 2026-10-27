/** Vendor console noise that is never an app bug. Learned noise (M7) is handled through `suppressed` signatures. */
export const CONSOLE_NOISE: RegExp[] = [/favicon\.ico/, /Download the React DevTools/, /\[HMR\]/, /ResizeObserver loop/];

export function isConsoleNoise(text: string, location?: string): boolean {
  return CONSOLE_NOISE.some((re) => re.test(text) || (location !== undefined && re.test(location)));
}
