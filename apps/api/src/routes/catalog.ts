import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { CatalogSchema } from "../../../../packages/shared/src/index.js";
import { resource, transaction, type Store } from "../store.js";
import type { RequestSchemas, RouteDeps } from "./deps.js";

// General data-catalog import (v1): any catalog that helps Helix name entities,
// link tables, assert keys and flag quality. Converters for specific upstreams
// live outside this repo; Helix only speaks this format.
export const catalogSchemas: RequestSchemas = {
  "POST /api/v1/workspaces/:w/catalog/import": z.object({
    catalog: CatalogSchema,
  }),
};

export function registerCatalogRoutes(
  app: FastifyInstance,
  store: Store,
  deps: RouteDeps,
) {
  const { access } = deps;
  app.post("/api/v1/workspaces/:w/catalog/import", async (req) => {
    const a = await access(req, "editor");
    const b = z.object({ catalog: CatalogSchema }).parse(req.body);
    const data = {
      ...b.catalog,
      importedAt: new Date().toISOString(),
      importedBy: a.user.id,
    };
    await transaction(store, a.scope, async (tx) => {
      const existing = await tx.get("catalog");
      if (existing) tx.update(existing, data);
      else
        tx.put(
          resource(
            a.scope,
            "catalog",
            b.catalog.name || "Data catalog",
            data,
            "catalog",
          ),
        );
    });
    return {
      tables: b.catalog.tables.length,
      joins: b.catalog.joins.length,
      domains: b.catalog.domains.length,
    };
  });
  app.get("/api/v1/workspaces/:w/catalog", async (req) => {
    const a = await access(req);
    const catalog = await store.get(a.scope, "catalog");
    return catalog
      ? {
          name: catalog.name,
          ...catalog.data,
          secret: undefined,
        }
      : null;
  });
}
