/** Íconos de línea propios (SVG inline, sin dependencias). */
const PATHS = {
  overview: 'M3 13h8V3H3zm10 8h8V11h-8zM3 21h8v-6H3zm10-18v6h8V3z',
  radar: 'M12 12l6-6M21 12a9 9 0 1 1-9-9M16 12a4 4 0 1 1-4-4',
  catalog: 'M4 7l8-4 8 4-8 4zM4 7v10l8 4 8-4V7M12 11v10',
  suppliers: 'M3 21V8l9-5 9 5v13M9 21v-6h6v6M3 21h18',
  inventory: 'M4 4h16v5H4zM6 9v11h12V9M10 13h4',
  listings: 'M4 5h16M4 12h16M4 19h10',
  orders: 'M6 3h12l1 18H5zM9 7a3 3 0 0 0 6 0',
  shipments:
    'M3 7h11v9H3zM14 10h4l3 3v3h-7M7 19a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM17 19a2 2 0 1 0 0-4 2 2 0 0 0 0 4z',
  customers:
    'M16 20v-1a4 4 0 0 0-8 0v1M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM20 20v-1a3 3 0 0 0-3-3M4 20v-1a3 3 0 0 1 3-3',
  affiliates:
    'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
  finance: 'M12 2v20M17 6H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6',
  automation: 'M12 8v4l3 2M12 21a9 9 0 1 1 0-18 9 9 0 0 1 0 18z',
  agents: 'M9 3h6M12 3v3M5 9h14v10H5zM9 14h.01M15 14h.01M9 18h6',
  integrations: 'M9 3v4M15 3v4M7 7h10v4a5 5 0 0 1-10 0zM12 16v5',
  rules: 'M12 3l8 4v5c0 5-3.5 8-8 9-4.5-1-8-4-8-9V7zM9 12l2 2 4-4',
  audit: 'M9 4h6l1 2h3v15H5V6h3zM9 12h6M9 16h4',
  settings:
    'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2V21a2 2 0 0 1-4 0v-.1A1.7 1.7 0 0 0 8.9 19.4a1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.7 1.7 0 0 0 3.1 14H3a2 2 0 0 1 0-4h.1A1.7 1.7 0 0 0 4.6 8.9a1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.7 1.7 0 0 0 10 3.1V3a2 2 0 0 1 4 0v.1a1.7 1.7 0 0 0 2.9 1.2l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V10a1.7 1.7 0 0 0 1.5 1H21a2 2 0 0 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  menu: 'M4 6h16M4 12h16M4 18h16',
  close: 'M6 6l12 12M18 6L6 18',
} as const;

export type IconName = keyof typeof PATHS;

export const Icon = ({ name, title }: { name: IconName; title?: string }) => (
  <svg
    className="icon"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.7}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden={title ? undefined : true}
    role={title ? 'img' : undefined}
  >
    {title && <title>{title}</title>}
    <path d={PATHS[name]} />
  </svg>
);
