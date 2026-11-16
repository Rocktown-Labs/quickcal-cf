import { expect, test } from "bun:test";
import { hash } from "bcryptjs";
import { password } from "./password";

test("accepts Clerk bcrypt passwords and rejects incorrect passwords", async () => {
  const digest = await hash("legacy-password", 4);
  expect(await password.verify({ hash: digest, password: "legacy-password" })).toBe(true);
  expect(await password.verify({ hash: digest, password: "wrong-password" })).toBe(false);
});

test("new and reset passwords keep Better Auth's scrypt format", async () => {
  const digest = await password.hash("new-password");
  expect(digest.startsWith("$2")).toBe(false);
  expect(await password.verify({ hash: digest, password: "new-password" })).toBe(true);
  expect(await password.verify({ hash: digest, password: "wrong-password" })).toBe(false);
});
