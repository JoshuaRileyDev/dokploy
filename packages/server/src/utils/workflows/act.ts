import { quote } from "shell-quote";

export const ACT_VERSION = "0.2.89";
export const WORKFLOW_RUNS_PATH = "/etc/dokploy/workflows/runs";

// catthehacker images are the ones act recommends for GitHub-hosted runner compatibility.
export const DEFAULT_PLATFORM_IMAGES: Record<string, string> = {
	"ubuntu-latest": "catthehacker/ubuntu:act-latest",
	"ubuntu-24.04": "catthehacker/ubuntu:act-24.04",
	"ubuntu-22.04": "catthehacker/ubuntu:act-22.04",
	"ubuntu-20.04": "catthehacker/ubuntu:act-20.04",
	"self-hosted": "catthehacker/ubuntu:act-latest",
};

export type ActRunScriptInput = {
	runId: string;
	/** Authenticated clone URL; only used for the fetch and never left in the checkout. */
	cloneUrl: string;
	/** Token-free remote URL act reads to work out the repository. */
	remoteUrl: string;
	githubInstance?: string;
	sha: string;
	/** The ref the run was triggered for, e.g. refs/heads/main or refs/tags/v1. */
	ref: string;
	/** Checked out as a local branch when set; otherwise HEAD is detached at the commit. */
	branch?: string;
	event: string;
	workflowPath: string;
	/** Runs only this job and the jobs it needs. */
	targetJob?: string;
	/** Replaces the checked-out workflow file, e.g. to skip disabled jobs. */
	workflowOverride?: string;
	defaultBranch: string;
	actor: string;
	eventPayload: Record<string, unknown>;
	secrets: Record<string, string>;
	variables: Record<string, string>;
	inputs: Record<string, string>;
	/** Untrusted runs (fork pull requests) get no Docker socket inside job containers. */
	trusted: boolean;
	platformImages?: Record<string, string>;
	/** Where run directories are created; defaults to the workflow server path. */
	baseDir?: string;
};

export const runDirectory = (runId: string, baseDir = WORKFLOW_RUNS_PATH) =>
	`${baseDir}/${runId}`;

const toBase64 = (value: string) =>
	Buffer.from(value, "utf8").toString("base64");

/** Serializes values in the dotenv format act's --secret-file/--var-file/--input-file expect. */
export const toDotenv = (values: Record<string, string>) =>
	Object.entries(values)
		.map(([key, value]) => `${key}=${JSON.stringify(value)}`)
		.join("\n");

const writeFile = (path: string, content: string, mode = "600") =>
	`printf '%s' '${toBase64(content)}' | base64 -d > ${quote([path])} && chmod ${mode} ${quote([path])}`;

export const buildActArgs = (input: ActRunScriptInput, dir: string) => {
	const platforms = { ...DEFAULT_PLATFORM_IMAGES, ...input.platformImages };
	const args = [
		"act",
		input.event,
		"-W",
		input.workflowPath,
		"--eventpath",
		`${dir}/event.json`,
		"--secret-file",
		`${dir}/secrets.env`,
		"--var-file",
		`${dir}/vars.env`,
		"--input-file",
		`${dir}/inputs.env`,
		"--actor",
		input.actor,
		"--defaultbranch",
		input.defaultBranch,
		"--artifact-server-path",
		`${dir}/artifacts`,
		"--json",
		"--rm",
	];
	if (input.targetJob) {
		args.push("-j", input.targetJob);
	}
	if (input.githubInstance) {
		args.push("--github-instance", input.githubInstance);
	}
	if (!input.trusted) {
		args.push("--container-daemon-socket", "-");
	}
	for (const [label, image] of Object.entries(platforms)) {
		args.push("-P", `${label}=${image}`);
	}
	return args;
};

export const buildActRunScript = (input: ActRunScriptInput) => {
	const dir = runDirectory(input.runId, input.baseDir);
	const repoDir = `${dir}/repo`;
	return [
		"set -e",
		`if ! command -v act >/dev/null 2>&1; then echo "act is not installed on this server. Run Setup Server from the server settings to install it." >&2; exit 127; fi`,
		`rm -rf ${quote([dir])} && mkdir -p ${quote([repoDir])} && chmod 700 ${quote([dir])}`,
		`cd ${quote([repoDir])}`,
		"git init -q",
		`git remote add origin ${quote([input.cloneUrl])}`,
		`echo "Fetching ${input.sha.slice(0, 7)}"`,
		`git fetch -q --depth 1 origin ${quote([input.sha])}`,
		// act copies the checkout into the job container without empty directories, and git
		// doesn't recognise a .git with no refs/ as a repository, so there has to be a ref file.
		...(input.branch
			? [`git checkout -q -B ${quote([input.branch])} FETCH_HEAD`]
			: [
					`git update-ref ${quote([input.ref])} FETCH_HEAD`,
					"git checkout -q FETCH_HEAD",
				]),
		`git remote set-url origin ${quote([input.remoteUrl])}`,
		...(input.workflowOverride === undefined
			? []
			: [
					writeFile(
						`${repoDir}/${input.workflowPath}`,
						input.workflowOverride,
						"644",
					),
				]),
		writeFile(`${dir}/event.json`, JSON.stringify(input.eventPayload)),
		writeFile(`${dir}/secrets.env`, toDotenv(input.secrets)),
		writeFile(`${dir}/vars.env`, toDotenv(input.variables)),
		writeFile(`${dir}/inputs.env`, toDotenv(input.inputs)),
		"set +e",
		`${quote(buildActArgs(input, dir))} &`,
		"ACT_PID=$!",
		`echo $ACT_PID > ${quote([`${dir}/act.pid`])}`,
		"wait $ACT_PID",
		"ACT_EXIT=$?",
		`rm -f ${quote([`${dir}/secrets.env`])}`,
		"exit $ACT_EXIT",
	].join("\n");
};

/** Stops a running act process; act cancels its jobs and removes their containers on SIGTERM. */
export const buildActCancelScript = (runId: string) => {
	const pidFile = `${runDirectory(runId)}/act.pid`;
	return [
		`if [ -f ${quote([pidFile])} ]; then`,
		`  PID=$(cat ${quote([pidFile])})`,
		"  kill -TERM $PID 2>/dev/null || true",
		"  for i in $(seq 1 15); do kill -0 $PID 2>/dev/null || exit 0; sleep 1; done",
		"  kill -KILL $PID 2>/dev/null || true",
		"fi",
	].join("\n");
};

export const buildActCleanupScript = (runId: string) =>
	`rm -rf ${quote([runDirectory(runId)])}`;
