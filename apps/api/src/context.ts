import type { Store } from "./store.js";

// A readable name for a record: a person's name, a name or title, an email;
// otherwise its type and a shortened key.
const blank = (v: unknown) =>
  v == null || ["", "None", "null", "NaN"].includes(String(v).trim());
export function recordLabel(name: string, type: string, values: object) {
  const entries = Object.entries(values).filter(([, v]) => !blank(v));
  const find = (test: RegExp) => entries.find(([k]) => test.test(k))?.[1];
  const first = find(/(^|_)first_?name$/i),
    last = find(/(^|_)last_?name$/i);
  if (first || last) return [first, last].filter(Boolean).join(" ");
  const named =
    find(/^(name|full_?name|display_?name|title|subject|company(_?name)?)$/i) ??
    find(/(^|_)(name|title)$/i) ??
    // Only the record's own email: requester_email names someone else.
    find(/^e-?mail$/i);
  if (named) return String(named).slice(0, 80);
  const key = name.startsWith(type + " ") ? name.slice(type.length + 1) : name;
  return `${type} ${key.length > 14 ? key.slice(0, 12) + "…" : key}`;
}

// Ontology-owned: an object with its workspace edits applied.
export async function effectiveObject(store: Store, scope: string, r: any) {
  const overlay = await store.get(scope, "overlay_" + r.data.logicalId);
  return applyOverlay(r, overlay);
}
// Batch variant for list paths: one HelixDB round trip for all overlays
// instead of one get() per object.
export async function effectiveObjects(
  store: Store,
  scope: string,
  rows: any[],
) {
  const overlays = await store.getMany(
    scope,
    rows.map((r) => "overlay_" + r.data.logicalId),
  );
  return rows.map((r) =>
    applyOverlay(r, overlays.get("overlay_" + r.data.logicalId)),
  );
}
function applyOverlay(r: any, overlay: any) {
  return {
    ...r,
    data: {
      ...r.data,
      effective: { ...r.data.base, ...overlay?.data.values },
      edits: overlay?.data.values || {},
    },
  };
}
