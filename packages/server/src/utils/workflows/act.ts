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
	/**
	 * The machine's runner images and action cache are refreshed by Dokploy, so act uses them as they
	 * are instead of checking Docker Hub and GitHub for every job.
	 */
	managedCache?: boolean;
	/** Runs in the background while the repository is fetched; the run fails if it does. */
	prepareScript?: string;
	/** Remote actions to seed into act's cache while the repository is fetched (with `managedCache`). */
	seedActions?: string[];
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
	if (input.managedCache) {
		args.push("--pull=false", "--action-offline-mode");
	}
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
	const backgroundTasks = [
		input.prepareScript,
		// act clones actions from a GitHub Enterprise instance under a different URL than the seeds'.
		input.managedCache && !input.githubInstance && input.seedActions?.length
			? buildSeedActionsScript(input.seedActions)
			: undefined,
	].filter((task) => task !== undefined);
	return [
		"set -e",
		`if ! command -v act >/dev/null 2>&1; then echo "act is not installed on this server. Run Setup Server from the server settings to install it." >&2; exit 127; fi`,
		`rm -rf ${quote([dir])} && mkdir -p ${quote([repoDir])} && chmod 700 ${quote([dir])}`,
		...backgroundTasks.flatMap((task, index) => [
			`(\n${task}\n) > ${quote([`${dir}/background-${index}.log`])} 2>&1 &`,
			`BACKGROUND_${index}=$!`,
		]),
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
		...backgroundTasks.flatMap((_, index) => {
			const log = quote([`${dir}/background-${index}.log`]);
			return [
				`if ! wait $BACKGROUND_${index}; then cat ${log} >&2; echo "Preparing the machine failed" >&2; exit 1; fi`,
				`cat ${log}`,
			];
		}),
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
export const buildActCancelScript = (runId: string, baseDir?: string) => {
	const pidFile = `${runDirectory(runId, baseDir)}/act.pid`;
	return [
		`if [ -f ${quote([pidFile])} ]; then`,
		`  PID=$(cat ${quote([pidFile])})`,
		"  kill -TERM $PID 2>/dev/null || true",
		"  for i in $(seq 1 15); do kill -0 $PID 2>/dev/null || exit 0; sleep 1; done",
		"  kill -KILL $PID 2>/dev/null || true",
		"fi",
	].join("\n");
};

// The two newest major versions of widely used actions, so most `uses:` steps start from the cache.
// actions/checkout isn't here: act copies the local checkout instead of cloning it.
export const WARM_ACTIONS = [
	"actions/setup-node@v6",
	"actions/setup-node@v7",
	"actions/setup-python@v6",
	"actions/setup-python@v7",
	"actions/setup-go@v6",
	"actions/setup-go@v7",
	"actions/setup-java@v5",
	"actions/setup-java@v6",
	"actions/cache@v5",
	"actions/cache@v6",
	"actions/upload-artifact@v6",
	"actions/upload-artifact@v7",
	"actions/download-artifact@v7",
	"actions/download-artifact@v8",
	"actions/github-script@v9",
	"pnpm/action-setup@v6",
	"oven-sh/setup-bun@v2",
	"docker/setup-buildx-action@v3",
	"docker/setup-buildx-action@v4",
	"docker/setup-qemu-action@v3",
	"docker/setup-qemu-action@v4",
	"docker/login-action@v3",
	"docker/login-action@v4",
	"docker/metadata-action@v5",
	"docker/metadata-action@v6",
	"docker/build-push-action@v6",
	"docker/build-push-action@v7",
];

// act's own name for an action's cache directory (safeFilename in pkg/runner/step_action_remote.go).
const actionCacheDirName = (uses: string) => uses.replace(/[<>:"/\\|?*]/g, "-");

/**
 * Seeds act's action cache with shallow clones of the given `owner/repo[/path]@ref` actions,
 * skipping ones already there. With --action-offline-mode act uses an existing clone as is, and a
 * shallow one is a few MB where act's own clone pulls the whole history (around 100MB). act only
 * reuses a clone whose origin is exactly https://github.com/owner/repo, and resolves a ref as a
 * tag, then a remote branch, then a commit, which is what `clone --branch` and a fetch by SHA leave.
 */
export const buildSeedActionsScript = (actions: string[]) => {
	const lines = [
		'ACT_CACHE="${XDG_CACHE_HOME:-$HOME/.cache}/act"',
		'mkdir -p "$ACT_CACHE"',
		"seed_action() {",
		'  dir="$ACT_CACHE/$1"',
		'  [ -e "$dir" ] && return 0',
		'  tmp="$dir.seeding.$$"',
		'  rm -rf "$tmp"',
		'  if printf "%s" "$2" | grep -Eq "^[0-9a-f]{40}$"; then',
		'    git init -q "$tmp" && git -C "$tmp" remote add origin "$3" && git -C "$tmp" fetch -q --depth 1 origin "$2" && git -C "$tmp" -c advice.detachedHead=false checkout -q FETCH_HEAD',
		"  else",
		'    git clone -q -c advice.detachedHead=false --depth 1 --branch "$2" "$3" "$tmp"',
		'  fi >/dev/null 2>&1 && mv "$tmp" "$dir" && return 0',
		'  rm -rf "$tmp"',
		'  echo "Couldn\'t cache $4"',
		"}",
	];
	for (const uses of new Set(actions)) {
		const match = uses.match(/^([^/@]+)\/([^/@]+)(?:\/[^@]*)?@(.+)$/);
		if (!match) continue;
		const [, owner, repository, ref] = match;
		lines.push(
			`seed_action ${quote([actionCacheDirName(uses), ref!, `https://github.com/${owner}/${repository}`, uses])} &`,
		);
	}
	lines.push("wait");
	return lines.join("\n");
};

export const buildWarmActionCacheScript = () =>
	buildSeedActionsScript(WARM_ACTIONS);

/**
 * Runs with `managedCache` skip act's own freshness checks, so workflow servers re-pull their
 * runner images and rebuild the action cache on a schedule instead.
 */
export const buildRefreshRunnerCacheScript = () =>
	[
		"set -u",
		"for image in $(docker images catthehacker/ubuntu --format '{{.Repository}}:{{.Tag}}' | grep -v '<none>'); do",
		`  old=$(docker image inspect --format '{{.Id}}' "$image")`,
		'  docker pull -q "$image" >/dev/null || { echo "Couldn\'t pull $image"; continue; }',
		// The old image would otherwise stay on disk untagged, gigabytes a week.
		`  [ "$old" = "$(docker image inspect --format '{{.Id}}' "$image")" ] || docker rmi "$old" >/dev/null 2>&1 || true`,
		"done",
		'rm -rf "${XDG_CACHE_HOME:-$HOME/.cache}/act"',
		buildWarmActionCacheScript(),
	].join("\n");

export const buildActCleanupScript = (runId: string, baseDir?: string) =>
	`rm -rf ${quote([runDirectory(runId, baseDir)])}`;
