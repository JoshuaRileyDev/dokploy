import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/** Where Dokploy installs the runner on Boat machines. */
export const BOAT_RUNNER_DIR = "/home/user/dokploy-runner";
export const BOAT_RUNNER_CLI = `node ${BOAT_RUNNER_DIR}/dist/cli.js`;

/** The built runner package: `runner/` next to the server in the image, `apps/runner` in development. */
const runnerBundleDir = () => {
	const candidates = [
		process.env.DOKPLOY_RUNNER_DIR,
		path.join(process.cwd(), "runner"),
		path.join(process.cwd(), "..", "runner"),
	].filter((dir): dir is string => !!dir);
	const found = candidates.find((dir) =>
		existsSync(path.join(dir, "dist", "cli.js")),
	);
	if (!found) {
		throw new Error(
			"This Dokploy build doesn't include the workflow runner. In development, run `pnpm --filter=./apps/runner build` first.",
		);
	}
	return found;
};

const writeFileCommand = (target: string, contents: Buffer) =>
	`echo '${contents.toString("base64")}' | base64 -d > ${target}`;

/** Shell commands that write the runner package to BOAT_RUNNER_DIR. */
export const installRunnerBundleScript = () => {
	const bundle = runnerBundleDir();
	const distFiles = readdirSync(path.join(bundle, "dist"))
		.filter((file) => file.endsWith(".js"))
		.sort();
	return [
		`rm -rf ${BOAT_RUNNER_DIR} && mkdir -p ${BOAT_RUNNER_DIR}/dist`,
		writeFileCommand(
			`${BOAT_RUNNER_DIR}/package.json`,
			readFileSync(path.join(bundle, "package.json")),
		),
		...distFiles.map((file) =>
			writeFileCommand(
				`${BOAT_RUNNER_DIR}/dist/${file}`,
				readFileSync(path.join(bundle, "dist", file)),
			),
		),
	].join("\n");
};
