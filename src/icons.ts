const paths: Record<string, string> = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  arrow: '<path d="M12 19V5m-6 6 6-6 6 6"/>',
  chevron: '<path d="m9 5 7 7-7 7"/>',
  download: '<path d="M12 3v12m-5-5 5 5 5-5M5 16v4h14v-4"/>',
  lock: '<rect x="5" y="10" width="14" height="11" rx="3"/><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 5v2"/>',
  chip: '<rect x="6" y="6" width="12" height="12" rx="3"/><path d="M9 2v4m6-4v4M9 18v4m6-4v4M2 9h4m-4 6h4m12-6h4m-4 6h4"/><rect x="9" y="9" width="6" height="6" rx="1"/>',
  settings: '<path d="m9 3-1 3-3 1-2 3 2 2-1 3 3 2 2-1 3 2 3-1 1-3 3-1 2-3-2-2 1-3-3-2-2 1Z"/><circle cx="11" cy="11" r="3"/>',
  chat: '<path d="M20 11a8 8 0 0 1-8 8H5l-3 3V11a9 9 0 0 1 18 0Z"/><path d="M7 9h8m-8 4h5"/>',
  trash: '<path d="M3 6h18M9 6V3h6v3m-9 0 1 15h10l1-15M10 10v7m4-7v7"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  copy: '<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M15 8V3H3v13h5"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  book: '<path d="M12 5c-3-2-7-2-10-1v15c4-1 7 0 10 2 3-2 6-3 10-2V4c-3-1-7-1-10 1Zm0 0v16"/>',
  bulb: '<path d="M9 18h6m-5 3h4M8 14a7 7 0 1 1 8 0c-1 1-1 2-1 4H9c0-2 0-3-1-4Z"/>',
  code: '<path d="m8 7-5 5 5 5m8-10 5 5-5 5M14 3l-4 18"/>',
  leaf: '<path d="M20 3C10 1 3 6 4 13c1 6 11 9 15-2 1-3 1-6 1-8ZM4 21l11-12"/>',
  warning: '<path d="m12 3 10 18H2L12 3Zm0 6v5m0 3v1"/>',
};
export const icon = (name: string, cls = '') => `<svg class="icon ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.chat}</svg>`;
export const spark = (cls = '') => `<svg class="spark ${cls}" viewBox="0 0 48 48" fill="currentColor" aria-hidden="true"><path d="M24 2c0 14-8 22-22 22 14 0 22 8 22 22 0-14 8-22 22-22C32 24 24 16 24 2Z"/></svg>`;
