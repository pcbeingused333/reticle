### Fixed

- **`@reticlehq/engine` — A `changed` or `unchanged` text check gets a baseline on a page whose SDK is older than 3.7.0 or reports no version.** Such a page refuses an element query that carries `matchCase`, and the reading taken before the action gave up on that refusal, so the check had nothing to compare against and never graded. The before-reading now goes through the same retry as the verdict: it asks the page once more without `matchCase` and checks the case on the text that comes back. Any other refusal still gives no baseline.
