import type { Store } from "./store.js";

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
