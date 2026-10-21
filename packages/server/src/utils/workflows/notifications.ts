import { db } from "@dokploy/server/db";
import {
	notifications,
	workflowNotifications,
	workflowRuns,
} from "@dokploy/server/db/schema";
import { format } from "date-fns";
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { getDokployUrl } from "../../services/admin";
import {
	escapeHtml,
	sendCustomNotification,
	sendDiscordNotification,
	sendEmailNotification,
	sendGotifyNotification,
	sendLarkNotification,
	sendMattermostNotification,
	sendNtfyNotification,
	sendPushoverNotification,
	sendResendNotification,
	sendSlackNotification,
	sendTeamsNotification,
	sendTelegramNotification,
} from "../notifications/utils";
import { matchesFilter } from "./triggers";

export type WorkflowRunSummary = {
	status: "success" | "failure";
	repository: string;
	workflow: string;
	runNumber: number;
	attempt: number;
	event: string;
	branch: string | null;
	sha: string;
	commitTitle: string;
	actor: string | null;
	errorMessage: string | null;
	durationSeconds: number | null;
	runUrl: string;
	date: Date;
};

export const buildWorkflowCustomPayload = (run: WorkflowRunSummary) => ({
	title: run.status === "failure" ? "Workflow failed" : "Workflow succeeded",
	message: `${run.workflow} #${run.runNumber} ${run.status === "failure" ? "failed" : "succeeded"} on ${run.repository}`,
	type: "workflow",
	status: run.status === "failure" ? "error" : "success",
	repository: run.repository,
	workflow: run.workflow,
	runNumber: run.runNumber,
	attempt: run.attempt,
	event: run.event,
	branch: run.branch,
	sha: run.sha,
	commitTitle: run.commitTitle,
	actor: run.actor,
	errorMessage: run.errorMessage,
	durationSeconds: run.durationSeconds,
	runUrl: run.runUrl,
	timestamp: run.date.toISOString(),
	date: run.date.toLocaleString(),
});

/** Selects rules for this run: matching repository (or all), matching branch filter, and the run's outcome. */
export const ruleMatches = (
	rule: { branches: string[]; onFailure: boolean; onSuccess: boolean },
	run: { status: "success" | "failure"; branch: string | null },
) => {
	if (run.status === "failure" ? !rule.onFailure : !rule.onSuccess)
		return false;
	if (rule.branches.length === 0) return true;
	return !!run.branch && matchesFilter(rule.branches, run.branch);
};

const lines = (run: WorkflowRunSummary) =>
	[
		["Repository", run.repository],
		[
			"Workflow",
			`${run.workflow} #${run.runNumber}${run.attempt > 1 ? ` (attempt ${run.attempt})` : ""}`,
		],
		["Branch", run.branch ?? "—"],
		["Commit", `${run.sha.slice(0, 7)} ${run.commitTitle}`],
		["Triggered by", run.actor ?? "—"],
	] as const;

const sendToNotification = async (
	notification: NonNullable<
		Awaited<ReturnType<typeof loadNotifications>>
	>[number],
	run: WorkflowRunSummary,
) => {
	const failed = run.status === "failure";
	const title = failed ? "Workflow failed" : "Workflow succeeded";
	const icon = failed ? "❌" : "✅";
	const summary = lines(run);
	const error = run.errorMessage?.slice(0, 800);
	const plain = [
		...summary.map(([label, value]) => `${label}: ${value}`),
		...(error ? [`Error: ${error}`] : []),
		`Run: ${run.runUrl}`,
	].join("\n");
	const {
		email,
		resend,
		discord,
		telegram,
		slack,
		gotify,
		ntfy,
		mattermost,
		custom,
		lark,
		pushover,
		teams,
	} = notification;

	if (email || resend) {
		const html = `<h2>${icon} ${title}</h2><table>${summary
			.map(
				([label, value]) =>
					`<tr><td><b>${label}</b></td><td>${escapeHtml(value)}</td></tr>`,
			)
			.join(
				"",
			)}</table>${error ? `<pre>${escapeHtml(error)}</pre>` : ""}<p><a href="${run.runUrl}">View run</a></p>`;
		const subject = `${title}: ${run.repository} ${run.workflow} #${run.runNumber}`;
		if (email) await sendEmailNotification(email, subject, html);
		if (resend) await sendResendNotification(resend, subject, html);
	}
	if (discord) {
		await sendDiscordNotification(discord, {
			title: `${icon} ${title}`,
			color: failed ? 0xed4245 : 0x57f287,
			fields: [
				...summary.map(([name, value]) => ({ name, value, inline: true })),
				...(error ? [{ name: "Error", value: `\`\`\`${error}\`\`\`` }] : []),
				{ name: "Run", value: `[View run](${run.runUrl})` },
			],
			timestamp: run.date.toISOString(),
			footer: { text: "Dokploy Workflows" },
		});
	}
	if (telegram) {
		await sendTelegramNotification(
			telegram,
			`<b>${icon} ${title}</b>\n\n${summary
				.map(([label, value]) => `<b>${label}:</b> ${escapeHtml(value)}`)
				.join("\n")}${error ? `\n\n<pre>${escapeHtml(error)}</pre>` : ""}`,
			[[{ text: "View run", url: run.runUrl }]],
		);
	}
	if (slack) {
		await sendSlackNotification(slack, {
			channel: slack.channel,
			attachments: [
				{
					color: failed ? "#FF0000" : "#00FF00",
					pretext: `${failed ? ":x:" : ":white_check_mark:"} *${title}*`,
					fields: [
						...summary.map(([label, value]) => ({
							title: label,
							value,
							short: true,
						})),
						...(error
							? [
									{
										title: "Error",
										value: `\`\`\`${error}\`\`\``,
										short: false,
									},
								]
							: []),
						{ title: "Run", value: `<${run.runUrl}|View run>`, short: false },
					],
					mrkdwn_in: ["fields"],
				},
			],
		});
	}
	if (gotify) await sendGotifyNotification(gotify, `${icon} ${title}`, plain);
	if (ntfy) {
		await sendNtfyNotification(
			ntfy,
			title,
			failed ? "x" : "white_check_mark",
			`view, View run, ${run.runUrl}, clear=true;`,
			plain,
		);
	}
	if (mattermost) {
		await sendMattermostNotification(mattermost, {
			text: `${icon} **${title}**\n\n${summary
				.map(([label, value]) => `**${label}:** ${value}`)
				.join(
					"\n",
				)}${error ? `\n\n\`\`\`\n${error}\n\`\`\`` : ""}\n\n[View run](${run.runUrl})`,
			channel: mattermost.channel,
			username: mattermost.username || "Dokploy Bot",
		});
	}
	if (custom)
		await sendCustomNotification(custom, buildWorkflowCustomPayload(run));
	if (lark) {
		await sendLarkNotification(lark, {
			msg_type: "text",
			content: { text: `${icon} ${title}\n${plain}` },
		});
	}
	if (pushover) await sendPushoverNotification(pushover, title, plain);
	if (teams) {
		await sendTeamsNotification(teams, {
			title: `${icon} ${title}`,
			facts: [
				...summary.map(([name, value]) => ({ name, value })),
				{ name: "Date", value: format(run.date, "PP pp") },
				...(error ? [{ name: "Error", value: error }] : []),
			],
			potentialAction: {
				type: "Action.OpenUrl",
				title: "View run",
				url: run.runUrl,
			},
		});
	}
};

const loadNotifications = (notificationIds: string[]) =>
	db.query.notifications.findMany({
		where: inArray(notifications.notificationId, notificationIds),
		with: {
			email: true,
			discord: true,
			telegram: true,
			slack: true,
			resend: true,
			gotify: true,
			ntfy: true,
			mattermost: true,
			custom: true,
			lark: true,
			pushover: true,
			teams: true,
		},
	});

/** Sends the run's outcome to every notification channel with a matching workflow rule. Cancelled and skipped runs aren't notified. */
export const sendWorkflowRunNotifications = async (workflowRunId: string) => {
	const run = await db.query.workflowRuns.findFirst({
		where: eq(workflowRuns.workflowRunId, workflowRunId),
		with: { repository: true },
	});
	if (!run || (run.status !== "success" && run.status !== "failure")) return;

	const rules = await db.query.workflowNotifications.findMany({
		where: and(
			eq(workflowNotifications.organizationId, run.repository.organizationId),
			or(
				isNull(workflowNotifications.workflowRepositoryId),
				eq(
					workflowNotifications.workflowRepositoryId,
					run.workflowRepositoryId,
				),
			),
		),
	});
	const notificationIds = [
		...new Set(
			rules
				.filter((rule) =>
					ruleMatches(rule, {
						status: run.status as "success" | "failure",
						branch: run.branch,
					}),
				)
				.map((rule) => rule.notificationId),
		),
	];
	if (notificationIds.length === 0) return;

	const summary: WorkflowRunSummary = {
		status: run.status,
		repository: `${run.repository.owner}/${run.repository.repository}`,
		workflow: run.workflowName,
		runNumber: run.runNumber,
		attempt: run.attempt,
		event: run.event,
		branch: run.branch,
		sha: run.sha,
		commitTitle: run.title,
		actor: run.actor,
		errorMessage: run.errorMessage,
		durationSeconds:
			run.startedAt && run.finishedAt
				? Math.round(
						(Date.parse(run.finishedAt) - Date.parse(run.startedAt)) / 1000,
					)
				: null,
		runUrl: `${await getDokployUrl()}/dashboard/workflows/runs/${run.workflowRunId}`,
		date: new Date(run.finishedAt ?? Date.now()),
	};

	for (const notification of await loadNotifications(notificationIds)) {
		try {
			await sendToNotification(notification, summary);
		} catch (error) {
			console.error(
				`Failed to send workflow notification ${notification.name}`,
				error,
			);
		}
	}
};
