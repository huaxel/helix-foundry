# Data catalogs (general import)

Helix Foundry speaks one general catalog format (v1). Any catalog — maintained
anywhere, in any upstream system — can be imported to help discovery: business
names replace slugs, curated joins become links, asserted keys place keyless
tables. Helix never assumes a specific upstream catalog; converters live with
their catalogs, outside this repo.

## Format (JSON, `version: 1`)

```json
{
  "version": 1,
  "name": "Example catalog",
  "tables": [
    {
      "table": "BUT000",
      "businessName": "Business partner",
      "definition": "Master record of a taxpayer.",
      "owner": "data-team",
      "keys": [["PARTNER"], ["CLIENT", "BIRTHDATE"]],
      "quality": "canonical"
    }
  ],
  "joins": [
    {
      "leftTable": "BUT000",
      "leftKey": "PARTNER",
      "rightTable": "DFKKOP",
      "rightKey": "GPART",
      "cardinality": "1:N",
      "note": "Taxpayer master to open items."
    }
  ],
  "domains": [{ "name": "FICA", "tables": ["BUT000", "DFKKOP"] }]
}
```

- **Matching is name-based and forgiving**: table matching is
  case/path/extension/domain-insensitive (`stg_pers/ZST_PERSON.parquet`,
  `ZST_PERSON`, and `DOMAIN.ZST_PERSON` are the same table). Key matching tries
  exact, then `Label_KEY` suffixes (`Partenaire_GPART` resolves `GPART`), then
  leading dotted labels (`Taxpayer.return_z019` resolves `TAXPAYER`).
- **`keys` are trusted on import**, including composites (`["A", "B"]`
  displays as `A + B`). They place tables Helix cannot prove unique itself.
  Only assert keys you can defend; a wrong key mislabels an entity.
- **`quality`** is advisory today (`canonical` / `draft` / `deprecated`);
  deprecated tables are not auto-hidden (curate by excluding them in Review).
- Unknown tables/joins are ignored (an estate-wide catalog imports cleanly
  into a workspace holding a subset).

## Import (replaces)

`POST /api/v1/workspaces/:id/catalog/import` with `{ "catalog": {…} }`
(workspace editor session). Returns `{ tables, joins, domains }` counts.
`GET /api/v1/workspaces/:id/catalog` fetches the current one. Re-importing
replaces it; the previous import is not versioned (keep your source YAML/JSON
under version control where it lives).

## How discovery uses it

- **Names**: `businessName` wins; strict `Reference table: X` / `Code table: X`
  definitions deterministically derive `X` (anything else keeps its slug for a
  human). Explicit names always beat derived ones.
- **Links**: curated joins whose tables are in scope and whose keys resolve
  become links (`evidence: "declared"`, name `references`). Unresolvable joins
  are skipped, never fabricated. Statistical value-matching is skipped while a
  catalog covers links; without one, discovery falls back to it unchanged.
- **Keys**: asserted keys place keyless tables as entities.
- **Descriptions**: catalogued entities keep their definitions; the model only
  describes gaps (in small batches). Fully covered suggestions need no model
  call at all.
- **Audit**: every suggestion records `N of M catalog joins applied as links
  (… out of scope, … unresolvable keys, … same-entity or duplicate)` in its
  summary, so coverage is visible.
- Importing or replacing a catalog changes the input signature, so the next
  visit to the Ontology step recomputes the suggestion with the new semantics.
  Nothing is ever deleted: excluded, unplaced, and out-of-scope tables stay
  available as tables.
