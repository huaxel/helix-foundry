// Facade preserving the original assistant.js contract. The implementation
// lives in focused modules under ./assistant/: context (analyst dataset
// focus and resource/thread helpers), provider (provider settings and
// dataset inputs), validate (bundle validation), proposals (proposal and
// publication lifecycle), and build (workspace build orchestrator and run
// queue). Existing importers are unchanged.
export {
  focusDatasets,
  assistantResource,
  threadOf,
  pipelineId,
} from "./assistant/context.js";
export { proposalHash, providerSettings, inputsFor } from "./assistant/provider.js";
export { validateBundle } from "./assistant/validate.js";
export {
  saveProposal,
  retried,
  publishProposal,
  currentBundle,
} from "./assistant/proposals.js";
export { enqueue, buildWorkspace } from "./assistant/build.js";
