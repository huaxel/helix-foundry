// Facade preserving the original discovery.js contract. The implementation
// lives in focused modules under ./discovery/: names (pure SQL/name helpers),
// keys (key analysis), suggest (deterministic suggestion engine), columns
// (entity output columns), confirm (user-review application), and bundle
// (publication bundle + overview dashboard). Existing importers are unchanged.
export { q, lit, plural, sourceLabel, tableName, entityName } from "./discovery/names.js";
export { type SuggestStage, suggestOntology } from "./discovery/suggest.js";
export { entityColumns, entityColumn } from "./discovery/columns.js";
export { confirmOntology, ontologyGoal } from "./discovery/confirm.js";
export { ontologyBundle, overviewDashboard } from "./discovery/bundle.js";
