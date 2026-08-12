// Stage-1 naming: mechanical PascalCase names. Semantic renaming is Stage-2 (AI).

const GATEWAY = new Set(['2m', '2b', '2c']);

export function pascal(input: string): string {
  const words = (input || '')
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return '';
  return words
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join('');
}

// Derive a base type name from the API url, dropping gateway + version segments.
// e.g. /2m/v1.0/hostingVehicle/page -> HostingVehiclePage
export function pascalFromUrl(url: string, fallback: string): string {
  const segs = (url || '')
    .split('/')
    .filter(Boolean)
    .filter((s) => !GATEWAY.has(s.toLowerCase()))
    .filter((s) => !/^v\d/i.test(s));
  const tail = segs.slice(-2).map(pascal).join('');
  return tail || pascal(fallback) || 'Api';
}

// Best-effort singularization for array item type names.
export function singularize(name: string): string {
  if (/List$/.test(name)) return name.slice(0, -4);
  if (/ies$/.test(name)) return `${name.slice(0, -3)}y`;
  if (/ss$/.test(name)) return name;
  if (/s$/.test(name)) return name.slice(0, -1);
  return name;
}
