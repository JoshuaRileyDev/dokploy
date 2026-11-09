import { isUniqueConstraintViolation } from "@dokploy/server/db/errors";
import { describe, expect, it } from "vitest";

const pgError = (constraint: string) =>
	Object.assign(
		new Error(`duplicate key value violates unique constraint "${constraint}"`),
		{
			code: "23505",
			constraint_name: constraint,
		},
	);

describe("isUniqueConstraintViolation", () => {
	it("finds the constraint on the driver error Drizzle wraps", () => {
		const wrapped = new Error(
			'Failed query: insert into "cloud_provider_account" …',
			{
				cause: pgError("cloud_provider_account_org_name_idx"),
			},
		);

		expect(
			isUniqueConstraintViolation(
				wrapped,
				"cloud_provider_account_org_name_idx",
			),
		).toBe(true);
		expect(
			isUniqueConstraintViolation(wrapped, "dns_provider_org_name_idx"),
		).toBe(false);
	});

	it("ignores other failures", () => {
		expect(
			isUniqueConstraintViolation(
				new Error("Failed query", { cause: new Error("connection refused") }),
				"cloud_provider_account_org_name_idx",
			),
		).toBe(false);
		expect(isUniqueConstraintViolation(undefined, "x")).toBe(false);
	});
});
