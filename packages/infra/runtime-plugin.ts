// Alchemy beta.79 strips functions recursively from plain props while planning.
// A runtime-only class instance is omitted as a whole, so Rolldown sees an
// optional plugin instead of a generateBundle hook with a missing handler.
// Apply still receives the original instance and runs source-map upload hooks.
export class RuntimeBuildPlugin {
  [key: string]: unknown;
  constructor(plugin: Record<string, unknown>) {
    Object.assign(this, plugin);
  }
}
