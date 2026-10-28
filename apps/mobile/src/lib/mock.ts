import { ApiError, type Method, type Transport } from "./api";
import type {
	Container,
	Deployment,
	Domain,
	Project,
	RunStatus,
	Server,
	ServiceKind,
	ServiceStatus,
	WorkflowRepository,
	WorkflowRun,
} from "./types";

const now = Date.now();
const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
let seq = 1000;
const uid = (p: string) => `${p}_${(seq++).toString(36)}`;

interface MockService {
	kind: ServiceKind;
	id: string;
	name: string;
	appName: string;
	status: ServiceStatus;
	environmentId: string;
	serverId: string | null;
	description: string | null;
	env: string;
	repository?: string;
	owner?: string;
	branch?: string;
	buildType?: string;
	dockerImage?: string;
	composeType?: string;
	databaseName?: string;
	databaseUser?: string;
	externalPort?: number | null;
	domains: Domain[];
	createdAt: string;
}

const organizations = [
	{ id: "org_riley", name: "Riley Studio", logo: null },
	{ id: "org_lab", name: "Personal Lab", logo: null },
];
let activeOrganizationId = organizations[0]!.id;

const servers: Server[] = [
	{
		serverId: "srv_prod",
		name: "hel1-prod-01",
		description: "Primary deploy node · CCX33",
		ipAddress: "95.217.42.18",
		port: 22,
		username: "root",
		serverStatus: "active",
		serverRoles: ["deploy"],
		enableDockerCleanup: true,
		createdAt: ago(60 * 24 * 210),
	},
	{
		serverId: "srv_build",
		name: "hel1-build-01",
		description: "Dedicated builder · CPX51",
		ipAddress: "95.217.42.77",
		port: 22,
		username: "root",
		serverStatus: "active",
		serverRoles: ["build"],
		enableDockerCleanup: true,
		createdAt: ago(60 * 24 * 120),
	},
	{
		serverId: "srv_ci",
		name: "fsn1-runner",
		description: "Workflow runner for CI",
		ipAddress: "49.12.201.4",
		port: 22,
		username: "dokploy",
		serverStatus: "active",
		serverRoles: ["workflow", "build"],
		enableDockerCleanup: false,
		createdAt: ago(60 * 24 * 40),
	},
	{
		serverId: "srv_edge",
		name: "ash-edge-02",
		description: "US edge node",
		ipAddress: "5.161.88.230",
		port: 22,
		username: "root",
		serverStatus: "inactive",
		serverRoles: ["deploy"],
		enableDockerCleanup: true,
		createdAt: ago(60 * 24 * 12),
	},
];

const dom = (host: string, port = 3000): Domain => ({
	domainId: uid("dom"),
	host,
	https: true,
	port,
	path: "/",
	certificateType: "letsencrypt",
});

const projects: {
	projectId: string;
	name: string;
	description: string;
	createdAt: string;
	envs: { environmentId: string; name: string; isDefault: boolean }[];
}[] = [
	{
		projectId: "prj_studio",
		name: "Riley Studio",
		description: "Client sites, API and background workers",
		createdAt: ago(60 * 24 * 300),
		envs: [
			{ environmentId: "env_studio_prod", name: "production", isDefault: true },
			{ environmentId: "env_studio_stg", name: "staging", isDefault: false },
		],
	},
	{
		projectId: "prj_marketing",
		name: "Marketing System",
		description: "Set-and-forget cyclical social posting",
		createdAt: ago(60 * 24 * 90),
		envs: [
			{ environmentId: "env_mkt_prod", name: "production", isDefault: true },
		],
	},
	{
		projectId: "prj_infra",
		name: "Infrastructure",
		description: "Self-hosted tooling",
		createdAt: ago(60 * 24 * 400),
		envs: [{ environmentId: "env_infra", name: "production", isDefault: true }],
	},
	{
		projectId: "prj_lab",
		name: "Lab",
		description: "Experiments and side projects",
		createdAt: ago(60 * 24 * 20),
		envs: [{ environmentId: "env_lab", name: "production", isDefault: true }],
	},
];

const svc = (
	s: Omit<MockService, "createdAt" | "domains" | "env" | "description"> &
		Partial<MockService>,
): MockService => ({
	createdAt: ago(60 * 24 * 60),
	domains: [],
	env: "NODE_ENV=production\nLOG_LEVEL=info",
	description: null,
	...s,
});

const services: MockService[] = [
	svc({
		kind: "application",
		id: "app_web",
		name: "web",
		appName: "studio-web-x8k2",
		status: "done",
		environmentId: "env_studio_prod",
		serverId: "srv_prod",
		repository: "studio-web",
		owner: "joshuariley",
		branch: "main",
		buildType: "nixpacks",
		description: "Next.js marketing site",
		domains: [dom("rileystudio.co.uk"), dom("www.rileystudio.co.uk")],
		env: "NODE_ENV=production\nNEXT_PUBLIC_SITE_URL=https://rileystudio.co.uk\nDATABASE_URL=postgres://studio:••••@main-db:5432/studio\nREDIS_URL=redis://cache:6379\nSENTRY_DSN=https://••••@o12.ingest.sentry.io/44",
	}),
	svc({
		kind: "application",
		id: "app_api",
		name: "api",
		appName: "studio-api-p3m9",
		status: "running",
		environmentId: "env_studio_prod",
		serverId: "srv_prod",
		repository: "studio-api",
		owner: "joshuariley",
		branch: "main",
		buildType: "dockerfile",
		description: "Hono REST API",
		domains: [dom("api.rileystudio.co.uk", 8080)],
	}),
	svc({
		kind: "application",
		id: "app_worker",
		name: "worker",
		appName: "studio-worker-a1c4",
		status: "done",
		environmentId: "env_studio_prod",
		serverId: "srv_prod",
		repository: "studio-api",
		owner: "joshuariley",
		branch: "main",
		buildType: "dockerfile",
		description: "BullMQ job processor",
	}),
	svc({
		kind: "compose",
		id: "cmp_plausible",
		name: "plausible",
		appName: "plausible-q9z1",
		status: "done",
		environmentId: "env_studio_prod",
		serverId: "srv_prod",
		composeType: "docker-compose",
		description: "Privacy-friendly analytics",
		domains: [dom("stats.rileystudio.co.uk", 8000)],
	}),
	svc({
		kind: "postgres",
		id: "pg_main",
		name: "main-db",
		appName: "studio-db-k2l0",
		status: "done",
		environmentId: "env_studio_prod",
		serverId: "srv_prod",
		databaseName: "studio",
		databaseUser: "studio",
		dockerImage: "postgres:17",
		externalPort: null,
		env: "",
	}),
	svc({
		kind: "redis",
		id: "rd_cache",
		name: "cache",
		appName: "studio-cache-v7b3",
		status: "done",
		environmentId: "env_studio_prod",
		serverId: "srv_prod",
		dockerImage: "redis:7.4",
		env: "",
	}),
	svc({
		kind: "application",
		id: "app_web_stg",
		name: "web",
		appName: "studio-web-stg-77aa",
		status: "done",
		environmentId: "env_studio_stg",
		serverId: "srv_prod",
		repository: "studio-web",
		owner: "joshuariley",
		branch: "develop",
		buildType: "nixpacks",
		domains: [dom("staging.rileystudio.co.uk")],
	}),
	svc({
		kind: "postgres",
		id: "pg_stg",
		name: "staging-db",
		appName: "studio-db-stg-m1n2",
		status: "idle",
		environmentId: "env_studio_stg",
		serverId: "srv_prod",
		databaseName: "studio",
		databaseUser: "studio",
		dockerImage: "postgres:17",
		env: "",
	}),
	svc({
		kind: "application",
		id: "app_mkt",
		name: "marketing-web",
		appName: "marketing-web-c3d4",
		status: "done",
		environmentId: "env_mkt_prod",
		serverId: "srv_prod",
		repository: "marketing-system",
		owner: "joshuariley",
		branch: "main",
		buildType: "railpack",
		domains: [dom("social.joshuariley.co.uk")],
	}),
	svc({
		kind: "application",
		id: "app_sched",
		name: "scheduler",
		appName: "marketing-sched-e5f6",
		status: "error",
		environmentId: "env_mkt_prod",
		serverId: "srv_prod",
		repository: "marketing-system",
		owner: "joshuariley",
		branch: "main",
		buildType: "railpack",
		description: "Cron publisher",
	}),
	svc({
		kind: "postgres",
		id: "pg_mkt",
		name: "marketing-db",
		appName: "marketing-db-g7h8",
		status: "done",
		environmentId: "env_mkt_prod",
		serverId: "srv_prod",
		databaseName: "marketing",
		databaseUser: "marketing",
		dockerImage: "postgres:16",
		env: "",
	}),
	svc({
		kind: "compose",
		id: "cmp_infisical",
		name: "infisical",
		appName: "infisical-r4s5",
		status: "done",
		environmentId: "env_infra",
		serverId: "srv_prod",
		composeType: "docker-compose",
		domains: [dom("vault.joshuariley.co.uk", 8080)],
	}),
	svc({
		kind: "compose",
		id: "cmp_forgejo",
		name: "forgejo",
		appName: "forgejo-t6u7",
		status: "done",
		environmentId: "env_infra",
		serverId: "srv_prod",
		composeType: "docker-compose",
		domains: [dom("git.joshuariley.co.uk")],
	}),
	svc({
		kind: "compose",
		id: "cmp_uptime",
		name: "uptime-kuma",
		appName: "uptime-w8x9",
		status: "done",
		environmentId: "env_infra",
		serverId: "srv_edge",
		composeType: "docker-compose",
		domains: [dom("status.joshuariley.co.uk", 3001)],
	}),
	svc({
		kind: "mongo",
		id: "mg_logs",
		name: "log-store",
		appName: "logstore-y1z2",
		status: "done",
		environmentId: "env_infra",
		serverId: "srv_prod",
		databaseName: "logs",
		databaseUser: "admin",
		dockerImage: "mongo:8",
		env: "",
	}),
	svc({
		kind: "application",
		id: "app_blog",
		name: "blog",
		appName: "blog-b2c3",
		status: "idle",
		environmentId: "env_lab",
		serverId: null,
		repository: "blog",
		owner: "joshuariley",
		branch: "main",
		buildType: "static",
		domains: [dom("blog.joshuariley.co.uk", 80)],
	}),
	svc({
		kind: "application",
		id: "app_llm",
		name: "llm-playground",
		appName: "llm-d4e5",
		status: "done",
		environmentId: "env_lab",
		serverId: "srv_prod",
		repository: "llm-playground",
		owner: "joshuariley",
		branch: "main",
		buildType: "nixpacks",
	}),
];

const commitTitles = [
	"feat: pricing page refresh",
	"fix: handle expired sessions on refresh",
	"chore(deps): bump next to 16.2",
	"perf: cache OG images at the edge",
	"feat(api): webhook retries with backoff",
	"fix: timezone drift in scheduler",
	"Rebuild with latest base image",
	"feat: dark mode for dashboard",
];

const deployments: (Deployment & { ownerId: string })[] = [];
for (const s of services.filter(
	(x) => x.kind === "application" || x.kind === "compose",
)) {
	const count = s.id === "app_web" ? 8 : 4;
	for (let i = 0; i < count; i++) {
		const start =
			(i + 1) * (s.id === "app_web" ? 95 : 260) + (s.id.length % 5) * 13;
		let status: Deployment["status"] = "done";
		if (i === 0 && s.status === "error") status = "error";
		if (i === 0 && s.status === "running") status = "running";
		if (i === 2 && s.id === "app_web") status = "error";
		if (i === 3 && s.id === "app_api") status = "cancelled";
		const startedAt = status === "running" ? ago(2) : ago(start);
		deployments.push({
			deploymentId: uid("dep"),
			ownerId: s.id,
			title: commitTitles[(i + s.name.length) % commitTitles.length],
			description: `Commit ${Math.random().toString(16).slice(2, 9)} on ${s.branch ?? "main"}`,
			status,
			logPath: `/etc/dokploy/logs/${s.appName}/${s.appName}-${i}.log`,
			serverId: s.serverId,
			createdAt: startedAt,
			startedAt,
			finishedAt:
				status === "running"
					? null
					: new Date(
							new Date(startedAt).getTime() + (70 + ((i * 37) % 160)) * 1000,
						).toISOString(),
			errorMessage:
				status === "error"
					? 'Build failed: exit code 1 at step "pnpm build"'
					: null,
		});
	}
}

const repos: WorkflowRepository[] = [
	{
		workflowRepositoryId: "wfr_dokploy",
		owner: "joshuariley",
		repository: "dokploy",
		defaultBranch: "fork",
		runDokployWorkflows: true,
		runGithubWorkflows: false,
		lastSyncedAt: ago(4),
		syncError: null,
		definitions: [
			{
				workflowDefinitionId: "wfd_ci",
				path: ".dokploy/workflows/ci.yml",
				name: "CI",
				enabled: true,
			},
			{
				workflowDefinitionId: "wfd_rel",
				path: ".dokploy/workflows/release.yml",
				name: "Release image",
				enabled: true,
			},
		],
	},
	{
		workflowRepositoryId: "wfr_mkt",
		owner: "joshuariley",
		repository: "marketing-system",
		defaultBranch: "main",
		runDokployWorkflows: true,
		runGithubWorkflows: true,
		lastSyncedAt: ago(30),
		syncError: null,
		definitions: [
			{
				workflowDefinitionId: "wfd_mkt_test",
				path: ".dokploy/workflows/test.yml",
				name: "Test",
				enabled: true,
			},
			{
				workflowDefinitionId: "wfd_mkt_e2e",
				path: ".github/workflows/e2e.yml",
				name: "E2E",
				enabled: false,
			},
		],
	},
	{
		workflowRepositoryId: "wfr_studio",
		owner: "joshuariley",
		repository: "studio-web",
		defaultBranch: "main",
		runDokployWorkflows: true,
		runGithubWorkflows: false,
		lastSyncedAt: ago(180),
		syncError: null,
		definitions: [
			{
				workflowDefinitionId: "wfd_studio_lint",
				path: ".dokploy/workflows/lint.yml",
				name: "Lint & typecheck",
				enabled: true,
			},
		],
	},
];

const runTemplates: {
	repo: string;
	name: string;
	path: string;
	title: string;
	status: RunStatus;
	event: string;
	branch: string;
	mins: number;
	jobs: [string, RunStatus][];
}[] = [
	{
		repo: "wfr_dokploy",
		name: "CI",
		path: ".dokploy/workflows/ci.yml",
		title: "feat(mobile): Expo app with Liquid Glass",
		status: "in_progress",
		event: "push",
		branch: "t3/446eaf0c",
		mins: 1,
		jobs: [
			["lint", "success"],
			["typecheck", "in_progress"],
			["test", "queued"],
		],
	},
	{
		repo: "wfr_dokploy",
		name: "CI",
		path: ".dokploy/workflows/ci.yml",
		title: "feat(servers): Docker cleanup on build servers",
		status: "success",
		event: "push",
		branch: "fork",
		mins: 42,
		jobs: [
			["lint", "success"],
			["typecheck", "success"],
			["test", "success"],
		],
	},
	{
		repo: "wfr_dokploy",
		name: "Release image",
		path: ".dokploy/workflows/release.yml",
		title: "v0.26.6-fork.29",
		status: "success",
		event: "workflow_dispatch",
		branch: "fork",
		mins: 55,
		jobs: [
			["build", "success"],
			["push", "success"],
		],
	},
	{
		repo: "wfr_mkt",
		name: "Test",
		path: ".dokploy/workflows/test.yml",
		title: "fix: timezone drift in scheduler",
		status: "failure",
		event: "push",
		branch: "main",
		mins: 75,
		jobs: [
			["unit", "success"],
			["integration", "failure"],
		],
	},
	{
		repo: "wfr_dokploy",
		name: "CI",
		path: ".dokploy/workflows/ci.yml",
		title: "feat(api): run commands on a server",
		status: "success",
		event: "pull_request",
		branch: "feat/server-commands",
		mins: 190,
		jobs: [
			["lint", "success"],
			["typecheck", "success"],
			["test", "success"],
		],
	},
	{
		repo: "wfr_studio",
		name: "Lint & typecheck",
		path: ".dokploy/workflows/lint.yml",
		title: "perf: cache OG images at the edge",
		status: "success",
		event: "push",
		branch: "main",
		mins: 240,
		jobs: [["lint", "success"]],
	},
	{
		repo: "wfr_mkt",
		name: "Test",
		path: ".dokploy/workflows/test.yml",
		title: "chore: bump drizzle",
		status: "cancelled",
		event: "push",
		branch: "main",
		mins: 600,
		jobs: [
			["unit", "cancelled"],
			["integration", "skipped"],
		],
	},
	{
		repo: "wfr_dokploy",
		name: "CI",
		path: ".dokploy/workflows/ci.yml",
		title: "fix(servers): restore Docker cleanup button",
		status: "success",
		event: "push",
		branch: "fork",
		mins: 1300,
		jobs: [
			["lint", "success"],
			["typecheck", "success"],
			["test", "success"],
		],
	},
];

const runs: WorkflowRun[] = runTemplates.map((t, i) => {
	const startedAt = ago(t.mins);
	const finished = t.status !== "in_progress" && t.status !== "queued";
	return {
		workflowRunId: `wrun_${i}`,
		workflowRepositoryId: t.repo,
		workflowName: t.name,
		workflowPath: t.path,
		runNumber: 140 - i * 3,
		attempt: 1,
		event: t.event,
		branch: t.branch,
		sha: Math.random().toString(16).slice(2, 12),
		title: t.title,
		actor: "joshuariley",
		status: t.status,
		createdAt: startedAt,
		startedAt,
		finishedAt: finished
			? new Date(
					new Date(startedAt).getTime() + (90 + i * 23) * 1000,
				).toISOString()
			: null,
		jobs: t.jobs.map(([name, status], j) => ({
			workflowJobId: `wjob_${i}_${j}`,
			jobId: name,
			name,
			status,
			startedAt,
			finishedAt:
				status === "in_progress" || status === "queued" ? null : startedAt,
			steps: [
				{
					name: "Set up job",
					status: status === "queued" ? "queued" : "success",
				},
				{
					name: "actions/checkout@v4",
					status: status === "queued" ? "queued" : "success",
				},
				{
					name: "pnpm install",
					status: status === "queued" ? "queued" : "success",
				},
				{ name: `pnpm ${name}`, status },
			],
		})),
	};
});

function buildLog(
	title: string,
	appName: string,
	status: Deployment["status"],
) {
	const lines = [
		`Initializing deployment: ${title}`,
		`Cloning github.com/joshuariley/${appName.split("-")[0]} (branch main)`,
		"Cloning into '/etc/dokploy/applications/code'...",
		"✅ Repository cloned in 2.1s",
		"Build type: nixpacks",
		"╔══════════ Nixpacks v1.39.0 ══════════╗",
		"║ setup      │ nodejs_22, pnpm-9_x      ║",
		"║ install    │ pnpm i --frozen-lockfile ║",
		"║ build      │ pnpm run build           ║",
		"║ start      │ pnpm run start           ║",
		"╚══════════════════════════════════════╝",
		"#5 [stage-0  1/11] FROM ghcr.io/railwayapp/nixpacks:ubuntu-1745885067",
		"#8 [stage-0  4/11] RUN nix-env -if .nixpacks/nixpkgs.nix && nix-collect-garbage -d",
		"#11 [stage-0  7/11] RUN pnpm i --frozen-lockfile",
		"#11 4.211 Lockfile is up to date, resolution step is skipped",
		"#11 9.874 Packages: +812",
		"#11 18.02 Done in 17.6s",
		"#12 [stage-0  8/11] RUN pnpm run build",
		"#12 2.418 ▲ Next.js 16.2.1",
		"#12 6.903    Creating an optimized production build ...",
		"#12 41.77  ✓ Compiled successfully in 33.1s",
		"#12 44.10  ✓ Generating static pages (48/48)",
	];
	if (status === "error") {
		lines.push(
			"#12 44.31 Type error: Property 'locale' does not exist on type 'Params'.",
			'#12 ERROR: process "/bin/bash -ol pipefail -c pnpm run build" did not complete successfully: exit code: 1',
			"❌ Build failed",
		);
	} else {
		lines.push(
			"#14 exporting to image",
			`#14 naming to docker.io/library/${appName}:latest done`,
			"Starting service update...",
			`Service ${appName} converged`,
			"✅ Docker deployed: done",
		);
	}
	return lines;
}

const runtimeLog = (appName: string) =>
	Array.from({ length: 40 }, (_, i) => {
		const t = new Date(now - (40 - i) * 7_000).toISOString();
		const routes = [
			"GET /",
			"GET /api/health",
			"POST /api/webhooks/stripe",
			"GET /pricing",
			"GET /_next/static/chunks/main.js",
			"GET /api/posts?limit=20",
		];
		const r = routes[(i * 7) % routes.length];
		const code = i % 17 === 0 ? 500 : i % 9 === 0 ? 304 : 200;
		return `${t} ${appName} ${code === 500 ? "ERROR" : "INFO "} ${r} ${code} ${12 + ((i * 13) % 180)}ms`;
	}).join("\n");

const commandOutputs: Record<string, string> = {
	uptime:
		" 11:42:07 up 38 days,  4:16,  1 user,  load average: 0.41, 0.52, 0.47\n",
	"df -h":
		"Filesystem      Size  Used Avail Use% Mounted on\n/dev/sda1       226G  118G   99G  55% /\n/dev/sdb        500G  212G  288G  43% /mnt/HC_Volume_101\ntmpfs            16G     0   16G   0% /dev/shm\n",
	"docker ps":
		"CONTAINER ID   IMAGE                      STATUS          NAMES\n3f9a1c2d4e5b   studio-web-x8k2:latest     Up 2 hours      studio-web-x8k2.1\n7b8c9d0e1f2a   studio-api-p3m9:latest     Up 3 minutes    studio-api-p3m9.1\n1a2b3c4d5e6f   postgres:17                Up 38 days      studio-db-k2l0.1\n9e8d7c6b5a4f   redis:7.4                  Up 38 days      studio-cache-v7b3.1\n4c5d6e7f8a9b   traefik:v3.5               Up 38 days      dokploy-traefik\n",
	"free -h":
		"               total        used        free      shared  buff/cache   available\nMem:            31Gi        12Gi       3.1Gi       412Mi        16Gi        18Gi\nSwap:          4.0Gi       128Mi       3.9Gi\n",
};

const commands: {
	serverCommandId: string;
	serverId: string;
	command: string;
	status: "running" | "success" | "error" | "cancelled";
	exitCode: number | null;
	errorMessage: string | null;
	createdAt: string;
	finishedAt: string | null;
	output: string;
}[] = [];

function envRow(environmentId: string, name: string, isDefault: boolean) {
	const inEnv = services.filter((s) => s.environmentId === environmentId);
	const pick = (k: ServiceKind) => inEnv.filter((s) => s.kind === k);
	const db = (k: ServiceKind) =>
		pick(k).map((s) => ({
			[`${k}Id`]: s.id,
			name: s.name,
			applicationStatus: s.status,
		}));
	return {
		environmentId,
		name,
		isDefault,
		applications: pick("application").map((s) => ({
			applicationId: s.id,
			name: s.name,
			applicationStatus: s.status,
		})),
		compose: pick("compose").map((s) => ({
			composeId: s.id,
			name: s.name,
			composeStatus: s.status,
		})),
		postgres: db("postgres"),
		mysql: db("mysql"),
		mariadb: db("mariadb"),
		mongo: db("mongo"),
		redis: db("redis"),
		libsql: db("libsql"),
	};
}

function projectFor(environmentId: string) {
	const p = projects.find((x) =>
		x.envs.some((e) => e.environmentId === environmentId),
	)!;
	const e = p.envs.find((x) => x.environmentId === environmentId)!;
	return {
		environmentId,
		name: e.name,
		project: { projectId: p.projectId, name: p.name },
	};
}

function serviceDetail(s: MockService) {
	const server = servers.find((x) => x.serverId === s.serverId);
	const statusKey =
		s.kind === "compose" ? "composeStatus" : "applicationStatus";
	return {
		...s,
		[statusKey]: s.status,
		[`${s.kind}Id`]: s.id,
		sourceType: s.repository ? "github" : "docker",
		autoDeploy: true,
		replicas: 1,
		server: server
			? {
					serverId: server.serverId,
					name: server.name,
					ipAddress: server.ipAddress,
				}
			: null,
		environment: projectFor(s.environmentId),
		deployments: deployments.filter((d) => d.ownerId === s.id),
	};
}

function centralized(d: Deployment & { ownerId: string }) {
	const s = services.find((x) => x.id === d.ownerId)!;
	const server = servers.find((x) => x.serverId === s.serverId);
	const owner = {
		name: s.name,
		appName: s.appName,
		[`${s.kind}Id`]: s.id,
		environment: projectFor(s.environmentId),
		server: server ? { serverId: server.serverId, name: server.name } : null,
	};
	return {
		...d,
		application: s.kind === "application" ? owner : null,
		compose: s.kind === "compose" ? owner : null,
	};
}

function findService(kind: string, input: Record<string, unknown>) {
	const id = input[`${kind}Id`];
	const s = services.find((x) => x.id === id);
	if (!s) throw new ApiError("Service not found", 404);
	return s;
}

const logListeners = new Map<string, Set<(line: string) => void>>();

function simulateDeployment(s: MockService, title: string) {
	for (const d of deployments)
		if (d.ownerId === s.id && d.status === "running") d.status = "cancelled";
	const startedAt = new Date().toISOString();
	const dep = {
		deploymentId: uid("dep"),
		ownerId: s.id,
		title,
		description: "Manual deployment from Dokploy mobile",
		status: "running" as Deployment["status"],
		logPath: `/etc/dokploy/logs/${s.appName}/${s.appName}-${seq}.log`,
		serverId: s.serverId,
		createdAt: startedAt,
		startedAt,
		finishedAt: null as string | null,
		errorMessage: null,
	};
	deployments.unshift(dep);
	s.status = "running";
	const lines = buildLog(title, s.appName, "done");
	liveLogs.set(dep.logPath, []);
	lines.forEach((line, i) => {
		setTimeout(
			() => {
				liveLogs.get(dep.logPath)?.push(line);
				for (const fn of logListeners.get(dep.logPath) ?? []) fn(line);
				if (i === lines.length - 1) {
					dep.status = "done";
					dep.finishedAt = new Date().toISOString();
					s.status = "done";
				}
			},
			350 + i * 330,
		);
	});
}

const liveLogs = new Map<string, string[]>();

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function handle(
	method: Method,
	path: string,
	input: Record<string, unknown> = {},
): Promise<unknown> {
	await delay(140 + Math.random() * 160);
	const [router, proc] = path.split(".");

	switch (path) {
		case "user.get":
			return {
				role: "owner",
				user: {
					id: "usr_1",
					email: "joshua@joshuariley.co.uk",
					firstName: "Joshua",
					lastName: "Riley",
					image: null,
				},
			};
		case "organization.all":
			return organizations;
		case "organization.active":
			return organizations.find((o) => o.id === activeOrganizationId);
		case "organization.setActive":
			activeOrganizationId = String(input.organizationId);
			return true;
		case "settings.getDokployVersion":
			return "v0.26.6-fork.29";
		case "project.all":
			return projects.map((p) => ({
				projectId: p.projectId,
				name: p.name,
				description: p.description,
				createdAt: p.createdAt,
				environments: p.envs.map((e) =>
					envRow(e.environmentId, e.name, e.isDefault),
				),
			})) as Project[];
		case "project.update": {
			const p = projects.find((x) => x.projectId === input.projectId);
			if (!p) throw new ApiError("Project not found", 404);
			if (typeof input.name === "string") p.name = input.name;
			if (typeof input.description === "string")
				p.description = input.description;
			return true;
		}
		case "project.one": {
			const p = projects.find((x) => x.projectId === input.projectId);
			if (!p) throw new ApiError("Project not found", 404);
			return {
				...p,
				environments: p.envs.map((e) =>
					envRow(e.environmentId, e.name, e.isDefault),
				),
			};
		}
		case "deployment.allCentralized":
			return [...deployments]
				.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
				.slice(0, 40)
				.map(centralized);
		case "deployment.all":
			return deployments.filter((d) => d.ownerId === input.applicationId);
		case "deployment.allByCompose":
			return deployments.filter((d) => d.ownerId === input.composeId);
		case "deployment.readLogs": {
			const d = deployments.find((x) => x.deploymentId === input.deploymentId)!;
			const s = services.find((x) => x.id === d.ownerId)!;
			const full =
				liveLogs.get(d.logPath) ?? buildLog(d.title, s.appName, d.status);
			// Seeded in-progress builds have no live buffer; show them stopped partway.
			return (
				d.status === "running" && !liveLogs.has(d.logPath)
					? full.slice(0, 19)
					: full
			).join("\n");
		}
		case "server.all":
			return servers;
		case "server.one":
			return servers.find((s) => s.serverId === input.serverId);
		case "server.storage": {
			const big =
				input.serverId === "srv_build"
					? 0.81
					: input.serverId === "srv_ci"
						? 0.34
						: 0.55;
			const total = 226 * 1024 ** 3;
			return {
				status: "ok",
				error: null,
				sample: {
					checkedAt: Date.now(),
					dockerRoot: "/var/lib/docker",
					volumes: [
						{
							mount: "/",
							filesystem: "/dev/sda1",
							totalBytes: total,
							usedBytes: total * big,
							availableBytes: total * (1 - big),
							usedPercent: Math.round(big * 100),
						},
						...(input.serverId === "srv_prod"
							? [
									{
										mount: "/mnt/HC_Volume_101",
										filesystem: "/dev/sdb",
										totalBytes: 500 * 1024 ** 3,
										usedBytes: 212 * 1024 ** 3,
										availableBytes: 288 * 1024 ** 3,
										usedPercent: 43,
									},
								]
							: []),
					],
				},
				history: Array.from({ length: 36 }, (_, i) => ({
					t: Date.now() - (36 - i) * 100_000,
					usedBytes: total * (big - 0.06 + Math.sin(i / 4) * 0.02 + i * 0.0018),
					totalBytes: total,
				})),
			};
		}
		case "docker.getContainers": {
			const onServer = services.filter(
				(s) =>
					(s.serverId ?? null) === (input.serverId ?? "srv_prod") &&
					s.status !== "idle",
			);
			return [
				...onServer.map<Container>((s) => ({
					containerId: Math.random().toString(16).slice(2, 14),
					name: `${s.appName}.1.${Math.random().toString(36).slice(2, 8)}`,
					image: s.dockerImage ?? `${s.appName}:latest`,
					ports: s.domains[0]?.port ? `${s.domains[0].port}/tcp` : "No ports",
					state: s.status === "error" ? "exited" : "running",
					status:
						s.status === "error"
							? "Exited (1) 12 minutes ago"
							: s.status === "running"
								? "Up 2 minutes"
								: `Up ${3 + (s.name.length % 30)} days`,
				})),
				{
					containerId: "a1b2c3d4e5f6",
					name: "dokploy-traefik",
					image: "traefik:v3.5",
					ports: "80/tcp, 443/tcp",
					state: "running",
					status: "Up 38 days",
				},
			];
		}
		case "server.getServices": {
			return services
				.filter((s) => s.serverId === input.serverId)
				.map((s) => ({ ...serviceDetail(s), type: s.kind, id: s.id }));
		}
		case "workflow.allRepositories":
			return repos;
		case "workflow.oneRepository":
			return repos.find(
				(r) => r.workflowRepositoryId === input.workflowRepositoryId,
			);
		case "workflow.runs": {
			const list = runs.filter(
				(r) =>
					!input.workflowRepositoryId ||
					r.workflowRepositoryId === input.workflowRepositoryId,
			);
			return list.map((r) => ({
				...r,
				repository: repos.find(
					(x) => x.workflowRepositoryId === r.workflowRepositoryId,
				),
			}));
		}
		case "workflow.oneRun": {
			const r = runs.find((x) => x.workflowRunId === input.workflowRunId)!;
			return {
				...r,
				repository: repos.find(
					(x) => x.workflowRepositoryId === r.workflowRepositoryId,
				),
			};
		}
		case "workflow.readLogs": {
			const r = runs.find((x) => x.workflowRunId === input.workflowRunId)!;
			return {
				workflowRunId: r.workflowRunId,
				status: r.status,
				runLog: null,
				jobs: (r.jobs ?? []).map((j) => ({
					workflowJobId: j.workflowJobId,
					name: j.name,
					status: j.status,
					failedSteps: j.status === "failure" ? [`pnpm ${j.name}`] : [],
					log: [
						`[${r.workflowName}/${j.name}] 🚀  Start image=catthehacker/ubuntu:act-22.04`,
						`[${r.workflowName}/${j.name}]   🐳  docker pull image=catthehacker/ubuntu:act-22.04`,
						`[${r.workflowName}/${j.name}] ⭐ Run Main actions/checkout@v4`,
						`[${r.workflowName}/${j.name}]   ✅  Success - Main actions/checkout@v4`,
						`[${r.workflowName}/${j.name}] ⭐ Run Main pnpm install`,
						`[${r.workflowName}/${j.name}]   | Packages: +1342`,
						`[${r.workflowName}/${j.name}]   | Done in 21.4s`,
						`[${r.workflowName}/${j.name}]   ✅  Success - Main pnpm install`,
						`[${r.workflowName}/${j.name}] ⭐ Run Main pnpm ${j.name}`,
						...(j.status === "failure"
							? [
									`[${r.workflowName}/${j.name}]   | ✗ scheduler › publishes at local midnight (41 ms)`,
									`[${r.workflowName}/${j.name}]   | Expected: 2026-10-28T00:00:00Z  Received: 2026-10-27T23:00:00Z`,
									`[${r.workflowName}/${j.name}]   ❌  Failure - Main pnpm ${j.name}`,
								]
							: j.status === "success"
								? [
										`[${r.workflowName}/${j.name}]   | ✓ 214 passed`,
										`[${r.workflowName}/${j.name}]   ✅  Success - Main pnpm ${j.name}`,
										`[${r.workflowName}/${j.name}] 🏁  Job succeeded`,
									]
								: [`[${r.workflowName}/${j.name}]   | running…`]),
					].join("\n"),
				})),
			};
		}
		case "workflow.rerun":
		case "workflow.cancelRun": {
			const r = runs.find((x) => x.workflowRunId === input.workflowRunId)!;
			r.status = path === "workflow.rerun" ? "queued" : "cancelled";
			if (path === "workflow.rerun")
				setTimeout(() => (r.status = "in_progress"), 1500);
			return { ok: true };
		}
		case "workflow.dispatch":
			return { ok: true };
		case "serverCommand.run": {
			const command = String(input.command).trim();
			const output = commandOutputs[command] ?? `$ ${command}\nok\n`;
			const c = {
				serverCommandId: uid("cmd"),
				serverId: String(input.serverId),
				command,
				status: "running" as const,
				exitCode: null,
				errorMessage: null,
				createdAt: new Date().toISOString(),
				finishedAt: null,
				output,
			};
			commands.unshift(c as (typeof commands)[number]);
			setTimeout(() => {
				const found = commands.find(
					(x) => x.serverCommandId === c.serverCommandId,
				)!;
				found.status = "success";
				found.exitCode = 0;
				found.finishedAt = new Date().toISOString();
			}, 900);
			return c;
		}
		case "serverCommand.all":
			return commands.filter((c) => c.serverId === input.serverId);
		case "serverCommand.logs": {
			const c = commands.find(
				(x) => x.serverCommandId === input.serverCommandId,
			)!;
			const offset = Number(input.offset ?? 0);
			const visible =
				c.status === "running"
					? c.output.slice(0, Math.floor(c.output.length / 2))
					: c.output;
			return {
				...c,
				data: visible.slice(offset),
				nextOffset: visible.length,
				size: visible.length,
			};
		}
		case "settings.cleanUnusedImages":
		case "settings.cleanUnusedVolumes":
		case "settings.cleanStoppedContainers":
		case "settings.cleanDockerBuilder":
		case "settings.cleanAll":
		case "settings.reloadTraefik":
		case "docker.restartContainer":
			await delay(700);
			return true;
	}

	if (proc === "one") return serviceDetail(findService(router, input));
	if (proc === "readLogs")
		return runtimeLog(findService(router, input).appName);
	if (proc === "saveEnvironment") {
		findService(router, input).env = String(input.env ?? "");
		return true;
	}
	if (["deploy", "redeploy", "rebuild"].includes(proc)) {
		const s = findService(router, input);
		if (s.kind === "application" || s.kind === "compose")
			simulateDeployment(
				s,
				String(
					input.title ??
						(proc === "redeploy" ? "Redeploy" : "Manual deployment"),
				),
			);
		else {
			s.status = "running";
			setTimeout(() => (s.status = "done"), 2500);
		}
		return true;
	}
	if (proc === "start" || proc === "reload") {
		const s = findService(router, input);
		s.status = "running";
		setTimeout(() => (s.status = "done"), 1800);
		return true;
	}
	if (proc === "stop") {
		findService(router, input).status = "idle";
		return true;
	}
	if (proc === "cancelDeployment") {
		const s = findService(router, input);
		for (const d of deployments)
			if (d.ownerId === s.id && d.status === "running") d.status = "cancelled";
		s.status = "idle";
		return true;
	}
	throw new ApiError(`Demo mode does not implement ${method} ${path}`, 501);
}

export const demoTransport: Transport = {
	request: <T>(method: Method, path: string, input?: Record<string, unknown>) =>
		handle(method, path, input) as Promise<T>,
	streamDeploymentLog(deployment, onLine, onClose) {
		const existing = liveLogs.get(deployment.logPath);
		if (!existing) {
			onClose();
			return () => {};
		}
		existing.forEach(onLine);
		const set = logListeners.get(deployment.logPath) ?? new Set();
		set.add(onLine);
		logListeners.set(deployment.logPath, set);
		return () => set.delete(onLine);
	},
};
