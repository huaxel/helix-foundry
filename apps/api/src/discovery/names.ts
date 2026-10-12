const labels: Record<string, string> = {
  planetscale: "PlanetScale",
  workos: "WorkOS",
  posthog: "PostHog",
  stripe: "Stripe",
  s3: "S3",
  local: "Local",
  postgres: "PostgreSQL",
  mysql: "MySQL",
  rest: "REST",
  upload: "Upload",
};
const acronyms = new Set(
  "sso api url crm sku ip utm mrr arr kpi csv s3 sms vat ssn id".split(" "),
);
// Qualifiers that name a department or staging layer rather than the thing itself.
const qualifiers = new Set("marketing raw stg dim fact tbl app".split(" "));
export const q = (s: string) => '"' + s.replaceAll('"', '""') + '"';
// Code-point order, so results do not depend on the server's locale.
export const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
export const lit = (s: string) => "'" + s.replaceAll("'", "''") + "'";
export const words = (s: string) =>
  s
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
const irregular: Record<string, string> = {
  movies: "movie",
  cookies: "cookie",
  ties: "tie",
  pies: "pie",
  calories: "calorie",
  selfies: "selfie",
  zombies: "zombie",
  rookies: "rookie",
  series: "series",
  species: "species",
  news: "news",
  people: "person",
  children: "child",
  statuses: "status",
  buses: "bus",
  analyses: "analysis",
  campuses: "campus",
  bonuses: "bonus",
  viruses: "virus",
};
export const singular = (w: string) =>
  irregular[w] ??
  (/[^aeiou]ies$/.test(w)
    ? w.slice(0, -3) + "y"
    : /(ss|us|is|ics)$/.test(w)
      ? w
      : /(x|ch|sh|ss)es$/.test(w)
        ? w.slice(0, -2)
        : /s$/.test(w)
          ? w.slice(0, -1)
          : w);
const plurals = Object.fromEntries(
  Object.entries(irregular).map(([many, one]) => [one, many]),
);
export const plural = (phrase: string) =>
  phrase.replace(/(\w+)$/, (w) =>
    plurals[w.toLowerCase()]
      ? w.charAt(0) + plurals[w.toLowerCase()].slice(1)
      : /[^aeiou]y$/.test(w)
        ? w.slice(0, -1) + "ies"
        : /(s|x|ch|sh)$/.test(w)
          ? w + "es"
          : w + "s",
  );
export const count = (n: number, one: string) =>
  `${n.toLocaleString("en-US")} ${n === 1 ? one : plural(one)}`;
export const human = (ws: string[]) =>
  ws.map((w) => (acronyms.has(w) ? w.toUpperCase() : w)).join(" ");
export const lowerFirst = (s: string) =>
  /^[A-Z]{2}/.test(s) ? s : s.charAt(0).toLowerCase() + s.slice(1);
export const slug = (s: string) => words(s).join("_") || "entity";
export const list = (items: string[]) =>
  items.length < 2
    ? items.join("")
    : items.slice(0, -1).join(", ") + " and " + items.at(-1);
export const sourceLabel = (source: string) =>
  labels[source] || source.charAt(0).toUpperCase() + source.slice(1);
const databases = new Set(
  "planetscale postgres postgresql mysql neon supabase".split(" "),
);
// "S3 · exports/2024/orders.csv" -> orders. Database tables may be schema-qualified
// (public.orders); in a file name the later dots are part of the name.
export const tableName = (name: string, source = "") => {
  const file = name.split(" · ").at(-1)!.split("/").at(-1)!;
  const base = file.replace(
    /\.(csv|tsv|txt|jsonl?|ndjson|parquet)(\.gz)?$/i,
    "",
  );
  const parts = base.split(".").filter(Boolean);
  return (
    (databases.has(source)
      ? parts.at(-1)
      : parts.find((p) => /[a-z]/i.test(p))) ||
    base ||
    file
  );
};
export function entityName(table: string) {
  let ws = words(table);
  if (ws.length > 1 && qualifiers.has(ws[0])) ws = ws.slice(1);
  if (!ws.length) return "Record";
  ws[ws.length - 1] = singular(ws[ws.length - 1]);
  const name = human(ws);
  return (name.charAt(0).toUpperCase() + name.slice(1)).slice(0, 60);
}
// "WorkOS organizations"; uploads have no system to name.
export const datasetLabel = (x: { source: string; table: string }, n = 2) => {
  const ws = words(x.table);
  if (n === 1 && ws.length) ws[ws.length - 1] = singular(ws[ws.length - 1]);
  const table = human(ws);
  return x.source === "upload" ? table : `${sourceLabel(x.source)} ${table}`;
};
