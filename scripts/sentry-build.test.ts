import { expect, test } from "bun:test";
import { stripEffects } from "../packages/infra/node_modules/alchemy/src/Diff.ts";
import { RuntimeBuildPlugin } from "../packages/infra/runtime-plugin";

test("Alchemy planning omits runtime plugins without leaving broken hook objects", () => {
  const handler = () => "hook ran";
  const runtime = new RuntimeBuildPlugin({
    name: "sentry",
    generateBundle: { order: "pre", handler },
  });
  const planned = stripEffects({ build: { output: { plugins: [runtime] } } });
  expect(planned.build.output.plugins[0]).toBeUndefined();
  expect((runtime.generateBundle as { handler: () => string }).handler()).toBe("hook ran");
});
