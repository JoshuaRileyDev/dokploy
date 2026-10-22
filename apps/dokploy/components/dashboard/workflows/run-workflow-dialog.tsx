import type {
	WorkflowDispatchInput,
	WorkflowTrigger,
} from "@dokploy/server/utils/workflows/parser";
import { Play } from "lucide-react";
import { useRouter } from "next/router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { AlertBlock } from "@/components/shared/alert-block";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { api } from "@/utils/api";

interface Props {
	workflowRepositoryId: string;
	defaultBranch: string;
	definition: {
		workflowDefinitionId: string;
		name: string;
		triggers: WorkflowTrigger[];
	};
	job?: { id: string; name: string; needs: string[] };
}

const defaultValue = (input: WorkflowDispatchInput) =>
	input.default !== undefined
		? String(input.default)
		: input.type === "boolean"
			? "false"
			: "";

export const RunWorkflowDialog = ({
	workflowRepositoryId,
	defaultBranch,
	definition,
	job,
}: Props) => {
	const router = useRouter();
	const [open, setOpen] = useState(false);
	const [branch, setBranch] = useState(defaultBranch);
	const dispatchTrigger = definition.triggers.find(
		(t) => t.event === "workflow_dispatch",
	);
	const inputs = dispatchTrigger?.inputs ?? {};
	const [values, setValues] = useState<Record<string, string>>({});
	const { data: branches } = api.workflow.branches.useQuery(
		{ workflowRepositoryId },
		{ enabled: open },
	);
	const dispatch = api.workflow.dispatch.useMutation();

	useEffect(() => {
		if (open) {
			setBranch(defaultBranch);
			setValues(
				Object.fromEntries(
					Object.entries(inputs).map(([name, input]) => [
						name,
						defaultValue(input),
					]),
				),
			);
		}
	}, [open]);

	const submit = () =>
		dispatch
			.mutateAsync({
				workflowDefinitionId: definition.workflowDefinitionId,
				branch,
				inputs: dispatchTrigger ? values : {},
				jobId: job?.id,
			})
			.then((run) => {
				setOpen(false);
				router.push(`/dashboard/workflows/runs/${run.workflowRunId}`);
			})
			.catch((error) => toast.error(error.message));

	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogTrigger asChild>
				{job ? (
					<Button variant="ghost" size="icon" title={`Run ${job.name}`}>
						<Play className="size-3.5" />
					</Button>
				) : (
					<Button variant="outline" size="sm">
						<Play className="size-3.5" />
						Run
					</Button>
				)}
			</DialogTrigger>
			<DialogContent className="sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>
						Run {job ? `${job.name} from ${definition.name}` : definition.name}
					</DialogTitle>
					<DialogDescription>
						{dispatchTrigger
							? "Starts the workflow_dispatch trigger"
							: "Runs as a push to the selected branch, since this workflow has no workflow_dispatch trigger,"}{" "}
						using the workflow file on the selected branch.
						{job
							? job.needs.length > 0
								? " Only this job runs, along with the jobs it needs. Disabled jobs are ignored."
								: " Only this job runs. Disabled jobs are ignored."
							: " Disabled jobs are skipped."}
					</DialogDescription>
				</DialogHeader>
				{dispatch.isError && (
					<AlertBlock type="error">{dispatch.error.message}</AlertBlock>
				)}
				<div className="grid gap-4">
					<div className="space-y-2">
						<Label>Branch</Label>
						<Select value={branch} onValueChange={setBranch}>
							<SelectTrigger>
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{(branches ?? [defaultBranch]).map((name) => (
									<SelectItem key={name} value={name}>
										{name}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</div>
					{Object.entries(inputs).map(([name, input]) => (
						<div key={name} className="space-y-2">
							<Label htmlFor={`input-${name}`}>
								{name}
								{input.required && <span className="text-destructive"> *</span>}
							</Label>
							{input.type === "boolean" ? (
								<Switch
									id={`input-${name}`}
									checked={values[name] === "true"}
									onCheckedChange={(checked) =>
										setValues((v) => ({ ...v, [name]: String(checked) }))
									}
								/>
							) : input.type === "choice" ? (
								<Select
									value={values[name] ?? ""}
									onValueChange={(value) =>
										setValues((v) => ({ ...v, [name]: value }))
									}
								>
									<SelectTrigger id={`input-${name}`}>
										<SelectValue placeholder="Select an option" />
									</SelectTrigger>
									<SelectContent>
										{input.options?.map((option) => (
											<SelectItem key={option} value={option}>
												{option}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							) : (
								<Input
									id={`input-${name}`}
									type={input.type === "number" ? "number" : "text"}
									value={values[name] ?? ""}
									onChange={(e) =>
										setValues((v) => ({ ...v, [name]: e.target.value }))
									}
								/>
							)}
							{input.description && (
								<p className="text-sm text-muted-foreground">
									{input.description}
								</p>
							)}
						</div>
					))}
				</div>
				<DialogFooter>
					<Button onClick={submit} isLoading={dispatch.isPending}>
						{job ? "Run job" : "Run workflow"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
};
