import { describe, expect, test } from "bun:test";
import { generateMigrationSql } from "./import-clerk-users";

describe("Clerk to Better-Auth user importer", () => {
  test("generates valid SQL inserts from clerk user objects", () => {
    const clerkUsers = [
      {
        id: "user_2test123",
        first_name: "Alice",
        last_name: "Smith",
        email_addresses: [
          { id: "idn_1", email_address: "alice@example.com", verification: { status: "verified" } },
        ],
        public_metadata: { onboardingComplete: true },
        created_at: 1715000000000,
        updated_at: 1715000000000,
      },
      {
        id: "user_2test456",
        first_name: null,
        last_name: null,
        username: "bobbie",
        email: "bob@example.com",
        public_metadata: {},
        created_at: 1715000000,
      },
    ];

    const { sql, stats } = generateMigrationSql(clerkUsers, { ownerEmail: "owner@example.com" });
    expect(stats.valid).toBe(2);
    expect(stats.skippedOwner).toBe(0);
    expect(sql).toContain("INSERT INTO \"user\"");
    expect(sql).toContain("'user_2test123'");
    expect(sql).toContain("'alice@example.com'");
    expect(sql).toContain("'Alice Smith'");
    expect(sql).toContain("'user_2test456'");
    expect(sql).toContain("'bob@example.com'");
    expect(sql).toContain("'bobbie'");
    // Alice's Clerk address is verified; Bob's legacy string-only export is not.
    expect(sql).toContain("'alice@example.com', 1,");
    expect(sql).toContain("'bob@example.com', 0,");
  });

  test("does not mark an unverified Clerk address as verified", () => {
    const { sql } = generateMigrationSql([
      {
        id: "user_unverified",
        first_name: "Una",
        email_addresses: [
          {
            id: "idn_unverified",
            email_address: "una@example.com",
            verification: { status: "unverified" },
          },
        ],
        primary_email_address_id: "idn_unverified",
      },
    ]);

    expect(sql).toContain("'una@example.com', 0,");
  });

  test("skips owner email when specified", () => {
    const clerkUsers = [
      {
        id: "user_owner",
        first_name: "Owner",
        email: "owner@example.com",
      },
      {
        id: "user_other",
        first_name: "Other",
        email: "other@example.com",
      },
    ];

    const { sql, stats } = generateMigrationSql(clerkUsers, { ownerEmail: "owner@example.com" });
    expect(stats.valid).toBe(1);
    expect(stats.skippedOwner).toBe(1);
    expect(sql).not.toContain("'user_owner'");
    expect(sql).toContain("'user_other'");
  });
});
