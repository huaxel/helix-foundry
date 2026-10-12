import {
  type OntologyConfirm,
  type SuggestedOntology,
} from "../../../../packages/shared/src/index.js";
import { assert } from "../security.js";
import { summarize } from "./suggest.js";
import { list, lowerFirst, plural } from "./names.js";

export function confirmOntology(
  s: SuggestedOntology,
  edits: OntologyConfirm,
): SuggestedOntology {
  const ids = new Set(s.entities.map((e) => e.id));
  for (const id of [...edits.excluded, ...Object.keys(edits.names)])
    assert(ids.has(id), "Unknown entity in the suggested ontology");
  const excluded = new Set(edits.excluded);
  const entities = s.entities
    .filter((e) => !excluded.has(e.id))
    .map((e) => {
      const name = edits.names[e.id]?.trim();
      return name === undefined ? e : { ...e, name };
    });
  assert(
    entities.every((e) => e.name.length > 0),
    "Entity names cannot be empty",
  );
  assert(
    new Set(entities.map((e) => e.name.toLowerCase())).size === entities.length,
    "Entity names must be unique",
  );
  // Data without a recognisable key still builds dashboards, so setup never stalls.
  assert(
    entities.some((e) => e.kind === "record") ||
      !s.entities.some((e) => e.kind === "record"),
    "Keep at least one entity to build records from",
  );
  const links = s.links.filter(
    (l) => !excluded.has(l.from) && !excluded.has(l.to),
  );
  const kept = new Set(links.map((l) => l.id));
  const renamed = Object.keys(edits.names).length > 0;
  const members = entities.flatMap((e) => e.members);
  return {
    ...s,
    summary:
      excluded.size || (renamed && !s.described)
        ? summarize(
            entities,
            new Set(members.map((m) => m.datasetId)).size + s.unplaced.length,
            new Set(members.map((m) => m.source)).size,
          )
        : s.summary,
    entities,
    links,
    notes: s.notes.filter(
      (n) =>
        !n.entities?.some((id) => excluded.has(id)) &&
        !n.links?.some((id) => !kept.has(id)),
    ),
  };
}
export const ontologyGoal = (o: SuggestedOntology) =>
  `Give an overview of ${list(o.entities.map((e) => plural(lowerFirst(e.name))))}, and how they connect.`.slice(
    0,
    4000,
  );

// Bundle definitions for a confirmed ontology: a pipeline per merged entity (the
// anchor LEFT JOIN its merged datasets), object types, and relationships. Links that
// match only ignoring case, or across column types, join on lower()-normalized key
// columns added by pipelines; a link that cannot be expressed is left out.
