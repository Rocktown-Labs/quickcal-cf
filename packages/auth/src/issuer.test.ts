import { describe, expect, test } from "bun:test";
import { authIssuerFor } from "./index";

describe("authIssuerFor", () => {
  test("appends Better-Auth's default base path to a bare origin", () => {
    expect(authIssuerFor("https://api.example.com")).toBe("https://api.example.com/api/auth");
    expect(authIssuerFor("https://api.example.com/")).toBe("https://api.example.com/api/auth");
  });

  test("keeps an explicit path", () => {
    expect(authIssuerFor("https://api.example.com/api/auth")).toBe(
      "https://api.example.com/api/auth",
    );
    expect(authIssuerFor("http://localhost:3000/auth")).toBe("http://localhost:3000/auth");
  });
});
