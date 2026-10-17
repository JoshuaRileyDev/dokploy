export type ExpressionContext = Record<string, unknown>;

export class UnsupportedExpressionError extends Error {}

type Token =
	| { type: "string" | "identifier"; value: string }
	| { type: "number"; value: number }
	| { type: "operator"; value: string };

const tokenize = (source: string): Token[] => {
	const tokens: Token[] = [];
	let i = 0;
	while (i < source.length) {
		const char = source[i] as string;
		if (/\s/.test(char)) {
			i++;
		} else if (char === "'") {
			// GitHub escapes a single quote inside a string literal by doubling it.
			let value = "";
			i++;
			while (i < source.length) {
				if (source[i] === "'" && source[i + 1] === "'") {
					value += "'";
					i += 2;
				} else if (source[i] === "'") {
					break;
				} else {
					value += source[i++];
				}
			}
			if (source[i] !== "'")
				throw new UnsupportedExpressionError("Unterminated string");
			i++;
			tokens.push({ type: "string", value });
		} else if (/[0-9]/.test(char)) {
			const match = source.slice(i).match(/^[0-9]+(\.[0-9]+)?/);
			tokens.push({ type: "number", value: Number(match?.[0]) });
			i += match?.[0].length ?? 1;
		} else if (/[A-Za-z_]/.test(char)) {
			const match = source.slice(i).match(/^[A-Za-z_][A-Za-z0-9_-]*/);
			tokens.push({ type: "identifier", value: match?.[0] ?? char });
			i += match?.[0].length ?? 1;
		} else {
			const op =
				["||", "&&", "==", "!="].find((o) => source.startsWith(o, i)) ?? char;
			if (
				!["||", "&&", "==", "!=", "!", ".", "[", "]", "(", ")"].includes(op)
			) {
				throw new UnsupportedExpressionError(`Unsupported character "${char}"`);
			}
			tokens.push({ type: "operator", value: op });
			i += op.length;
		}
	}
	return tokens;
};

const isTruthy = (value: unknown) =>
	value !== null &&
	value !== undefined &&
	value !== false &&
	value !== 0 &&
	value !== "";

const looseEquals = (a: unknown, b: unknown) => {
	if (typeof a === "string" && typeof b === "string") {
		return a.toLowerCase() === b.toLowerCase();
	}
	return a === b;
};

/** Evaluates the subset of GitHub Actions expressions Dokploy needs server-side: context lookups, literals and logical operators. */
export const evaluateExpression = (
	source: string,
	context: ExpressionContext,
): unknown => {
	const tokens = tokenize(source);
	let position = 0;
	const peek = () => tokens[position];
	const isOperator = (value: string) => {
		const token = peek();
		return token?.type === "operator" && token.value === value;
	};
	const expectOperator = (value: string) => {
		if (!isOperator(value))
			throw new UnsupportedExpressionError(`Expected "${value}"`);
		position++;
	};

	const primary = (): unknown => {
		const token = tokens[position++];
		if (!token)
			throw new UnsupportedExpressionError("Unexpected end of expression");
		if (token.type === "string" || token.type === "number") return token.value;
		if (token.type === "operator" && token.value === "(") {
			const value = or();
			expectOperator(")");
			return value;
		}
		if (token.type === "operator" && token.value === "!")
			return !isTruthy(primary());
		if (token.type !== "identifier") {
			throw new UnsupportedExpressionError(`Unexpected "${token.value}"`);
		}
		if (token.value === "true") return true;
		if (token.value === "false") return false;
		if (token.value === "null") return null;
		if (isOperator("(")) {
			throw new UnsupportedExpressionError(
				`Function ${token.value}() isn't supported`,
			);
		}
		let value: unknown = context[token.value];
		while (isOperator(".") || isOperator("[")) {
			if (isOperator(".")) {
				position++;
				const property = tokens[position++];
				if (property?.type !== "identifier") {
					throw new UnsupportedExpressionError("Expected a property name");
				}
				value = (value as Record<string, unknown> | undefined)?.[
					property.value
				];
			} else {
				position++;
				const key = or();
				expectOperator("]");
				value = (value as Record<string, unknown> | undefined)?.[String(key)];
			}
		}
		return value ?? null;
	};

	const equality = (): unknown => {
		let left = primary();
		while (isOperator("==") || isOperator("!=")) {
			const negate = (peek() as { value: string }).value === "!=";
			position++;
			const right = primary();
			left = negate ? !looseEquals(left, right) : looseEquals(left, right);
		}
		return left;
	};

	const and = (): unknown => {
		let left = equality();
		while (isOperator("&&")) {
			position++;
			const right = equality();
			left = isTruthy(left) ? right : left;
		}
		return left;
	};

	const or = (): unknown => {
		let left = and();
		while (isOperator("||")) {
			position++;
			const right = and();
			left = isTruthy(left) ? left : right;
		}
		return left;
	};

	const result = or();
	if (position < tokens.length) {
		throw new UnsupportedExpressionError("Unexpected trailing tokens");
	}
	return result;
};

const stringify = (value: unknown) =>
	value === null || value === undefined
		? ""
		: typeof value === "object"
			? JSON.stringify(value)
			: String(value);

/** Replaces each `${{ expression }}` in a template; returns null if any expression is unsupported. */
export const evaluateTemplate = (
	template: string,
	context: ExpressionContext,
): string | null => {
	try {
		return template.replace(/\$\{\{([\s\S]*?)\}\}/g, (_, expression: string) =>
			stringify(evaluateExpression(expression, context)),
		);
	} catch (error) {
		if (error instanceof UnsupportedExpressionError) return null;
		throw error;
	}
};
