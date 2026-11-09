import { reviewConfig as configure } from "../src/review-config.js";

/** Review-engine tests explicitly opt into the gates exercised by their fixtures. */
export function reviewConfig(input: Parameters<typeof configure>[0] = {}) {
  return configure({ enabled: true, ...input,
    mandatory: { local: true, publish: true, merge: true, ...input.mandatory } });
}
