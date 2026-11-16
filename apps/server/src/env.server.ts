/// <reference types="@cloudflare/workers-types" />
/// <reference path="../cloudflare-env.d.ts" />
// For Cloudflare Workers, env is accessed via cloudflare:workers module
// Types are defined in env.d.ts based on your alchemy.run.ts bindings
import { env } from "cloudflare:workers";
import { AsyncLocalStorage } from "node:async_hooks";

// Use Sentry's instrumented bindings, isolated between concurrent requests.
const requestEnv = new AsyncLocalStorage<typeof env>();
export const ENV = new Proxy(env, {
  get(target, key) {
    return Reflect.get(requestEnv.getStore() ?? target, key);
  },
});
export function withRequestEnv<T>(bindings: typeof env, callback: () => T): T {
  return requestEnv.run(bindings, callback);
}
