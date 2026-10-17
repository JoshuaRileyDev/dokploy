import { Download, Loader2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { AlertBlock } from "@/components/shared/alert-block";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { api } from "@/utils/api";

const SOURCE_LABELS = {
	env: "Environment",
	buildArgs: "Build arg",
	buildSecrets: "Build secret",
} as const;

interface Props {
	workflowRepositoryId: string;
}

export const ImportServiceEnvDialog = ({ workflowRepositoryId }: Props) => {
	const utils = api.useUtils();
	const [open, setOpen] = useState(false);
	const [selectedService, setSelectedService] = useState("");
	const [selectedNames, setSelectedNames] = useState<Set<string>>(new Set());
	const [kind, setKind] = useState<"secret" | "variable">("secret");
	const [overwrite, setOverwrite] = useState(false);

	const { data: services, isPending: loadingServices } =
		api.workflow.linkedServices.useQuery(
			{ workflowRepositoryId },
			{ enabled: open },
		);
	const service = services?.find(
		(s) => `${s.serviceType}:${s.serviceId}` === selectedService,
	);
	const {
		data: entries,
		isFetching: loadingNames,
		error: namesError,
	} = api.workflow.linkedServiceEnvNames.useQuery(
		{
			workflowRepositoryId,
			serviceType: service?.serviceType ?? "application",
			serviceId: service?.serviceId ?? "",
		},
		{ enabled: open && !!service, retry: false },
	);
	const importEnv = api.workflow.importLinkedServiceEnv.useMutation();

	const importable = useMemo(
		() => (entries ?? []).filter((entry) => !entry.problem),
		[entries],
	);

	useEffect(() => {
		setSelectedNames(new Set(importable.map((entry) => entry.name)));
	}, [importable]);

	useEffect(() => {
		if (open && services?.length === 1 && !selectedService) {
			const [only] = services;
			if (only) setSelectedService(`${only.serviceType}:${only.serviceId}`);
		}
	}, [open, services, selectedService]);

	const toggle = (name: string, checked: boolean) =>
		setSelectedNames((current) => {
			const next = new Set(current);
			if (checked) next.add(name);
			else next.delete(name);
			return next;
		});

	const submit = () => {
		if (!service) return;
		importEnv
			.mutateAsync({
				workflowRepositoryId,
				serviceType: service.serviceType,
				serviceId: service.serviceId,
				names: [...selectedNames],
				kind,
				overwrite,
			})
			.then(({ imported, skipped }) => {
				toast.success(
					`Imported ${imported.length} ${kind === "secret" ? "secret" : "variable"}${imported.length === 1 ? "" : "s"}`,
					skipped.length
						? {
								description: `Skipped: ${skipped.map((s) => `${s.name} (${s.reason})`).join(", ")}`,
							}
						: undefined,
				);
				setOpen(false);
				return utils.workflow.env.invalidate();
			})
			.catch((error) => toast.error(error.message));
	};

	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				setOpen(next);
				if (!next) {
					setSelectedService("");
					setOverwrite(false);
					setKind("secret");
				}
			}}
		>
			<DialogTrigger asChild>
				<Button variant="outline">
					<Download className="size-4" />
					Import from application
				</Button>
			</DialogTrigger>
			<DialogContent className="sm:max-w-xl">
				<DialogHeader>
					<DialogTitle>Import from an application</DialogTitle>
					<DialogDescription>
						Copy variables from an application or compose service that deploys
						this repository. Values are resolved the same way as during a
						deployment, including project, environment and vault references.
					</DialogDescription>
				</DialogHeader>

				{loadingServices ? (
					<div className="flex justify-center py-6">
						<Loader2 className="size-5 animate-spin text-muted-foreground" />
					</div>
				) : !services?.length ? (
					<AlertBlock type="info">
						No applications or compose services you can access deploy this
						repository from the same GitHub account.
					</AlertBlock>
				) : (
					<div className="grid gap-4">
						<div className="space-y-2">
							<Label>Service</Label>
							<Select
								value={selectedService}
								onValueChange={setSelectedService}
							>
								<SelectTrigger>
									<SelectValue placeholder="Select a service" />
								</SelectTrigger>
								<SelectContent>
									{services.map((s) => (
										<SelectItem
											key={`${s.serviceType}:${s.serviceId}`}
											value={`${s.serviceType}:${s.serviceId}`}
										>
											{s.name}{" "}
											<span className="text-muted-foreground">
												({s.projectName} / {s.environmentName}, {s.serviceType})
											</span>
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>

						{namesError && (
							<AlertBlock type="error">{namesError.message}</AlertBlock>
						)}

						{service && !namesError && (
							<div className="space-y-2">
								<div className="flex items-center justify-between">
									<Label>Variables</Label>
									{importable.length > 0 && (
										<button
											type="button"
											className="text-sm text-muted-foreground hover:text-foreground"
											onClick={() =>
												setSelectedNames(
													selectedNames.size === importable.length
														? new Set()
														: new Set(importable.map((entry) => entry.name)),
												)
											}
										>
											{selectedNames.size === importable.length
												? "Select none"
												: "Select all"}
										</button>
									)}
								</div>
								{loadingNames ? (
									<div className="flex justify-center py-6">
										<Loader2 className="size-5 animate-spin text-muted-foreground" />
									</div>
								) : !entries?.length ? (
									<p className="rounded-md border p-4 text-center text-sm text-muted-foreground">
										This service has no variables.
									</p>
								) : (
									<ScrollArea className="max-h-64 rounded-md border">
										<div className="flex flex-col gap-1 p-2">
											{entries.map((entry) => (
												<label
													key={`${entry.source}:${entry.name}`}
													className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 hover:bg-muted"
												>
													<Checkbox
														disabled={!!entry.problem}
														checked={
															!entry.problem && selectedNames.has(entry.name)
														}
														onCheckedChange={(checked) =>
															toggle(entry.name, checked === true)
														}
													/>
													<span className="flex-1 truncate font-mono text-sm">
														{entry.name}
													</span>
													{entry.problem ? (
														<span className="text-xs text-muted-foreground">
															{entry.problem}
														</span>
													) : (
														<Badge variant="outline" className="font-normal">
															{SOURCE_LABELS[entry.source]}
														</Badge>
													)}
												</label>
											))}
										</div>
									</ScrollArea>
								)}
							</div>
						)}

						<div className="grid grid-cols-2 gap-4">
							<div className="space-y-2">
								<Label>Import as</Label>
								<Select
									value={kind}
									onValueChange={(value) => setKind(value as typeof kind)}
								>
									<SelectTrigger>
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										<SelectItem value="secret">Secrets</SelectItem>
										<SelectItem value="variable">Variables</SelectItem>
									</SelectContent>
								</Select>
							</div>
							<div className="flex items-end justify-between gap-2 pb-2">
								<Label htmlFor="import-overwrite">Overwrite existing</Label>
								<Switch
									id="import-overwrite"
									checked={overwrite}
									onCheckedChange={setOverwrite}
								/>
							</div>
						</div>
					</div>
				)}

				<DialogFooter>
					<Button
						onClick={submit}
						disabled={!service || selectedNames.size === 0}
						isLoading={importEnv.isPending}
					>
						Import {selectedNames.size > 0 ? selectedNames.size : ""}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
};
