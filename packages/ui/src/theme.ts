export type ThemeChoice = 'system' | 'light' | 'dark';

const KEY = 'siq.theme';

export function storedTheme(): ThemeChoice {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

/** Follows the system unless forced; the desktop app also tells nativeTheme so window chrome matches. */
export function applyTheme(t: ThemeChoice): void {
  if (t === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
  try {
    localStorage.setItem(KEY, t);
  } catch {
    // storage can be unavailable; the choice then lasts for this window only
  }
  void window.siq?.setTheme(t);
}
