/**
 * Whether a query failed on the given unique constraint. Drizzle wraps driver
 * errors in a "Failed query" error, so the constraint name is on its `cause`.
 */
export const isUniqueConstraintViolation = (
	error: unknown,
	constraint: string,
) => {
	for (
		let current: unknown = error, depth = 0;
		current && depth < 5;
		current = (current as { cause?: unknown }).cause, depth++
	) {
		const { code, constraint_name, message } = current as {
			code?: string;
			constraint_name?: string;
			message?: string;
		};
		if (code === "23505" && constraint_name === constraint) return true;
		if (typeof message === "string" && message.includes(constraint)) {
			return true;
		}
	}
	return false;
};
