// Small inline stroke icons (paths from the design mockups).
const P: Record<string, string> = {
  browser: 'M3 5h18v14H3z M3 9h18 M6 7h.01',
  history: 'M4 6h16 M4 12h16 M4 18h16',
  timeline: 'M4 6h8 M8 12h11 M6 18h6',
  replay: 'M4 12a8 8 0 1 0 2.3-5.6 M4 4v4h4',
  race: 'M4 6h9 M4 12h13 M4 18h6 M20 4v16',
  h3: 'M3 6h7 M13 6h8 M3 12h12 M18 12h3 M3 18h4 M10 18h11',
  rules: 'M4 7h10 M18 7h2 M4 17h4 M12 17h8 M14 5v4 M8 15v4',
  codecs: 'M8 7l-4 5 4 5 M16 7l4 5-4 5 M13 5l-2 14',
  cookies: 'M12 3a9 9 0 1 0 9 9 3 3 0 0 1-3-3 3 3 0 0 1-3-3 3 3 0 0 1-3-3z M9 10h.01 M14 15h.01 M9 15h.01',
  streams: 'M4 9c4.5-4 11.5-4 16 0 M7 13c3-2.5 7-2.5 10 0 M10 17c1.2-1 2.8-1 4 0',
  scripts: 'M5 4h10l4 4v12H5z M10 12l-2 2 2 2 M14 12l2 2-2 2',
  settings: 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z M12 2v3 M12 19v3 M2 12h3 M19 12h3 M5 5l2 2 M17 17l2 2 M5 19l2-2 M17 7l2-2',
  filter: 'M4 5h16l-6 8v5l-4 2v-7z',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14z M20 20l-3.5-3.5',
  chevron: 'M6 9l6 6 6-6',
  close: 'M6 6l12 12 M18 6L6 18',
  up: 'M12 19V5 M5 12l7-7 7 7',
  down: 'M12 5v14 M5 12l7 7 7-7',
  trash: 'M4 7h16 M9 7V4h6v3 M6 7l1 13h10l1-13',
  plus: 'M12 5v14 M5 12h14',
  logo: 'M11 5a6 6 0 1 0 0 12 6 6 0 0 0 0-12z M20 20l-4.2-4.2 M8.5 11h5',
};

export function Icon({ name, size = 16, stroke = 1.8, color }: { name: keyof typeof P | string; size?: number; stroke?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color ?? 'currentColor'} strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={P[name] ?? ''} />
    </svg>
  );
}
