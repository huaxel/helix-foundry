import { z } from "zod";

// General data-catalog format (v1): any catalog can be imported to help Helix
// name entities, link tables, assert keys and flag quality. Helix never assumes
// a specific upstream catalog; converters live outside this repo.
export const CatalogTableSchema = z.object({
  // Physical table name (e.g. ZST_PERSON, DFKKOP). Matching to datasets is by
  // normalized name (case/path/extension/domain-insensitive).
  table: z.string().min(1),
  businessName: z.string().optional(),
  definition: z.string().optional(),
  owner: z.string().optional(),
  // Asserted keys (each a column or composite). Trusted on import; used where
  // Helix cannot prove uniqueness itself (e.g. composite SAP keys).
  keys: z.array(z.array(z.string().min(1)).min(1)).optional(),
  quality: z.enum(["canonical", "draft", "deprecated"]).optional(),
});
export const CatalogJoinSchema = z.object({
  leftTable: z.string().min(1),
  leftKey: z.string().min(1),
  rightTable: z.string().min(1),
  rightKey: z.string().min(1),
  cardinality: z.string().optional(),
  note: z.string().optional(),
});
export const CatalogDomainSchema = z.object({
  name: z.string().min(1),
  definition: z.string().optional(),
  tables: z.array(z.string().min(1)).optional(),
});
export const CatalogSchema = z.object({
  version: z.literal(1),
  name: z.string().optional(),
  tables: z.array(CatalogTableSchema).default([]),
  joins: z.array(CatalogJoinSchema).default([]),
  domains: z.array(CatalogDomainSchema).default([]),
});
export type Catalog = z.infer<typeof CatalogSchema>;
export type CatalogTable = z.infer<typeof CatalogTableSchema>;
export type CatalogJoin = z.infer<typeof CatalogJoinSchema>;
