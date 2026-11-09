import {
	ArrowLeft,
	CheckCircle2,
	ChevronRight,
	ExternalLink,
	PenBoxIcon,
	PlusIcon,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { CloudProviderIcon } from "@/components/icons/cloud-provider-icons";
import { AlertBlock } from "@/components/shared/alert-block";
import { Badge } from "@/components/ui/badge";
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
import {
	Form,
	FormControl,
	FormDescription,
	FormField,
	FormItem,
	FormLabel,
	FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { api, type RouterInputs, type RouterOutputs } from "@/utils/api";

type ProviderType = RouterInputs["cloudProvider"]["create"]["providerType"];
type ProviderDefinition = RouterOutputs["cloudProvider"]["providers"][number];
type CredentialField = ProviderDefinition["credentialFields"][number];

const NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;

type Step = "provider" | "credentials" | "name";

const STEPS: { id: Step; label: string }[] = [
	{ id: "provider", label: "Provider" },
	{ id: "credentials", label: "Credentials" },
	{ id: "name", label: "Name" },
];

interface FormValues {
	name: string;
	providerType: string;
	credentials: Record<string, string>;
}

interface Props {
	cloudProviderAccountId?: string;
	/** Preselects and locks the provider when connecting a new account. */
	providerType?: string;
	onConnected?: (cloudProviderAccountId: string) => void;
	children?: React.ReactNode;
}

const StepIndicator = ({
	steps,
	current,
}: {
	steps: typeof STEPS;
	current: Step;
}) => {
	const currentIndex = steps.findIndex((step) => step.id === current);
	return (
		<ol className="flex items-center gap-2 text-xs">
			{steps.map((step, index) => (
				<li key={step.id} className="flex items-center gap-2">
					<span
						className={cn(
							"flex items-center gap-1.5",
							index === currentIndex
								? "font-medium text-foreground"
								: "text-muted-foreground",
						)}
					>
						<span
							className={cn(
								"flex size-5 items-center justify-center rounded-full border text-[10px] tabular-nums",
								index < currentIndex &&
									"border-primary bg-primary text-primary-foreground",
								index === currentIndex && "border-foreground",
							)}
						>
							{index + 1}
						</span>
						{step.label}
					</span>
					{index < steps.length - 1 && (
						<span className="h-px w-6 bg-border" aria-hidden />
					)}
				</li>
			))}
		</ol>
	);
};

const CredentialInput = ({
	credentialField,
	value,
	onChange,
	hint,
	isEdit,
	field,
}: {
	credentialField: CredentialField;
	value: string | undefined;
	onChange: (value: string) => void;
	hint?: string;
	isEdit: boolean;
	field: object;
}) =>
	credentialField.options ? (
		<Select
			value={value || (isEdit ? hint : credentialField.options[0]?.value) || ""}
			onValueChange={onChange}
		>
			<FormControl>
				<SelectTrigger>
					<SelectValue />
				</SelectTrigger>
			</FormControl>
			<SelectContent>
				{credentialField.options.map((option) => (
					<SelectItem key={option.value} value={option.value}>
						{option.label}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	) : (
		<FormControl>
			<Input
				type={credentialField.secret ? "password" : "text"}
				autoComplete="off"
				placeholder={
					isEdit && hint
						? credentialField.secret
							? `Saved value ending ${hint}`
							: hint
						: credentialField.placeholder
				}
				{...field}
				value={value ?? ""}
			/>
		</FormControl>
	);

export const HandleCloudProvider = ({
	cloudProviderAccountId,
	providerType: fixedProviderType,
	onConnected,
	children,
}: Props) => {
	const utils = api.useUtils();
	const [isOpen, setIsOpen] = useState(false);
	const [step, setStep] = useState<Step>("provider");
	const [verifyError, setVerifyError] = useState<string | null>(null);
	const isEdit = !!cloudProviderAccountId;

	const { data: providers } = api.cloudProvider.providers.useQuery(undefined, {
		enabled: isOpen,
	});
	const { data: accounts } = api.cloudProvider.all.useQuery(undefined, {
		enabled: isOpen && !isEdit,
	});
	const { data: account } = api.cloudProvider.one.useQuery(
		{ cloudProviderAccountId: cloudProviderAccountId || "" },
		{ enabled: isEdit && isOpen },
	);

	const create = api.cloudProvider.create.useMutation();
	const update = api.cloudProvider.update.useMutation();
	const mutation = isEdit ? update : create;
	const { mutateAsync: testConnection, isPending: isTesting } =
		api.cloudProvider.testConnection.useMutation();

	const form = useForm<FormValues>({
		defaultValues: { name: "", providerType: "", credentials: {} },
	});

	const providerType = form.watch("providerType");
	const provider = providers?.find((p) => p.type === providerType);

	const steps = useMemo(
		() =>
			fixedProviderType ? STEPS.filter((s) => s.id !== "provider") : STEPS,
		[fixedProviderType],
	);

	useEffect(() => {
		if (!isOpen) return;
		create.reset();
		update.reset();
		setVerifyError(null);
		setStep(isEdit || fixedProviderType ? "credentials" : "provider");
		form.reset({
			name: account?.name ?? "",
			providerType: account?.providerType ?? fixedProviderType ?? "",
			credentials: {},
		});
	}, [
		account,
		fixedProviderType,
		isEdit,
		isOpen,
		form,
		create.reset,
		update.reset,
	]);

	// A new account starts on a select's first option; an edit keeps the saved one.
	const credentialValue = (field: CredentialField, values: FormValues) =>
		values.credentials[field.name] ||
		(!isEdit && field.options?.[0]?.value) ||
		"";

	// Untouched inputs are undefined; send every field so blanks mean "keep".
	const credentialsOf = (values: FormValues) =>
		Object.fromEntries(
			(provider?.credentialFields ?? []).map((field) => [
				field.name,
				credentialValue(field, values),
			]),
		);

	const suggestName = (type: string) => {
		const taken = new Set(accounts?.map((a) => a.name));
		if (!taken.has(type)) return type;
		let index = 2;
		while (taken.has(`${type}-${index}`)) index++;
		return `${type}-${index}`;
	};

	const validateName = (values: FormValues) => {
		if (!values.name.trim()) {
			form.setError("name", { message: "Name is required" });
			return false;
		}
		if (!NAME_PATTERN.test(values.name)) {
			form.setError("name", {
				message: "Only letters, numbers, dashes and underscores",
			});
			return false;
		}
		return true;
	};

	const validateCredentials = (values: FormValues) => {
		// When editing, a blank field keeps the stored value.
		if (isEdit) return true;
		let valid = true;
		for (const field of provider?.credentialFields ?? []) {
			if (!credentialValue(field, values).trim()) {
				form.setError(`credentials.${field.name}`, {
					message: `${field.label} is required`,
				});
				valid = false;
			}
		}
		return valid;
	};

	const chooseProvider = (type: string) => {
		form.setValue("providerType", type);
		form.setValue("credentials", {});
		form.clearErrors();
		setVerifyError(null);
		setStep("credentials");
	};

	const verifyAndContinue = async () => {
		const values = form.getValues();
		if (!validateCredentials(values)) return;
		setVerifyError(null);
		await testConnection({
			providerType: values.providerType as ProviderType,
			credentials: credentialsOf(values),
		})
			.then(() => {
				if (!form.getValues("name")) {
					form.setValue("name", suggestName(values.providerType));
				}
				setStep("name");
			})
			.catch((error) => setVerifyError(error.message));
	};

	const save = async (values: FormValues) => {
		if (!validateName(values)) return;
		if (isEdit && !validateCredentials(values)) return;
		const request = isEdit
			? update.mutateAsync({
					cloudProviderAccountId: cloudProviderAccountId as string,
					name: values.name,
					credentials: credentialsOf(values),
				})
			: create.mutateAsync({
					name: values.name,
					providerType: values.providerType as ProviderType,
					credentials: credentialsOf(values),
				});
		await request
			.then((saved) => {
				onConnected?.(saved.cloudProviderAccountId);
				toast.success(
					isEdit ? "Account updated" : `${provider?.label} connected`,
				);
				utils.cloudProvider.all.invalidate();
				setIsOpen(false);
			})
			.catch(() => {});
	};

	const onSubmit = (values: FormValues) =>
		!isEdit && step === "credentials" ? verifyAndContinue() : save(values);

	const onTestConnection = async () => {
		const values = form.getValues();
		await testConnection({
			providerType: values.providerType as ProviderType,
			credentials: credentialsOf(values),
			cloudProviderAccountId,
		})
			.then(() => toast.success(`Connected to ${provider?.label}`))
			.catch((err) =>
				toast.error("Connection failed", { description: err.message }),
			);
	};

	const canGoBack =
		!isEdit &&
		(step === "name" || (step === "credentials" && !fixedProviderType));
	const goBack = () => setStep(step === "name" ? "credentials" : "provider");

	const connectedCount = (type: string) =>
		accounts?.filter((a) => a.providerType === type).length ?? 0;

	const nameField = (
		<FormField
			control={form.control}
			name="name"
			render={({ field }) => (
				<FormItem>
					<FormLabel>Account name</FormLabel>
					<FormControl>
						<Input placeholder="production" autoComplete="off" {...field} />
					</FormControl>
					<FormDescription>
						Shown when picking an account, e.g. the project or team the
						credentials belong to.
					</FormDescription>
					<FormMessage />
				</FormItem>
			)}
		/>
	);

	return (
		<Dialog open={isOpen} onOpenChange={setIsOpen}>
			{children ? (
				<DialogTrigger asChild>{children}</DialogTrigger>
			) : isEdit ? (
				<Tooltip>
					<TooltipTrigger asChild>
						<DialogTrigger asChild>
							<Button
								variant="ghost"
								size="icon"
								className="text-muted-foreground"
							>
								<PenBoxIcon className="size-4" />
								<span className="sr-only">Edit account</span>
							</Button>
						</DialogTrigger>
					</TooltipTrigger>
					<TooltipContent>Edit account</TooltipContent>
				</Tooltip>
			) : (
				<DialogTrigger asChild>
					<Button>
						<PlusIcon className="size-4" />
						Add Provider
					</Button>
				</DialogTrigger>
			)}
			<DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-lg">
				<DialogHeader className="gap-3">
					<div className="flex items-center gap-3">
						{canGoBack && (
							<Button
								type="button"
								variant="ghost"
								size="icon"
								className="size-8 shrink-0"
								onClick={goBack}
							>
								<ArrowLeft className="size-4" />
								<span className="sr-only">Back</span>
							</Button>
						)}
						{provider && step !== "provider" && (
							<CloudProviderIcon
								providerType={provider.type}
								className="size-9 shrink-0"
							/>
						)}
						<div className="flex min-w-0 flex-col gap-1">
							<DialogTitle>
								{isEdit
									? `Update ${account?.name ?? "account"}`
									: step === "provider"
										? "Connect a cloud provider"
										: `Connect ${provider?.label ?? ""}`}
							</DialogTitle>
							<DialogDescription>
								{step === "provider"
									? "Dokploy creates servers in the account you connect and removes them when you ask it to."
									: step === "credentials"
										? isEdit
											? "Leave a field blank to keep its saved value."
											: provider?.description
										: "The credentials work. Give the account a name."}
							</DialogDescription>
						</div>
					</div>
					{!isEdit && <StepIndicator steps={steps} current={step} />}
				</DialogHeader>

				{step === "provider" && (
					<ul className="flex flex-col gap-2">
						{providers?.map((p) => {
							const connected = connectedCount(p.type);
							return (
								<li key={p.type}>
									<button
										type="button"
										onClick={() => chooseProvider(p.type)}
										className="group flex w-full items-center gap-3 rounded-lg border bg-background px-3 py-2.5 text-left transition-colors duration-150 ease-out hover:border-foreground/20 hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
									>
										<CloudProviderIcon
											providerType={p.type}
											className="size-8 shrink-0"
										/>
										<span className="flex min-w-0 flex-1 flex-col gap-0.5">
											<span className="flex items-center gap-2 text-sm font-medium">
												{p.label}
												{connected > 0 && (
													<Badge variant="secondary">
														{connected} connected
													</Badge>
												)}
											</span>
											<span className="text-xs text-muted-foreground">
												{p.description}
											</span>
										</span>
										<ChevronRight className="size-4 shrink-0 text-muted-foreground transition-colors group-hover:text-foreground" />
									</button>
								</li>
							);
						})}
					</ul>
				)}

				{step !== "provider" && provider && (
					<Form {...form}>
						<form
							onSubmit={form.handleSubmit(onSubmit)}
							className="grid w-full gap-3"
						>
							{mutation.isError && (
								<AlertBlock type="error">{mutation.error?.message}</AlertBlock>
							)}

							{step === "credentials" && (
								<>
									<details className="group rounded-lg border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
										<summary className="flex cursor-pointer list-none items-center gap-2 font-medium text-foreground [&::-webkit-details-marker]:hidden">
											<ChevronRight className="size-3.5 shrink-0 transition-transform group-open:rotate-90" />
											Where to find these
											{provider.credentialsHelpUrl && (
												<a
													href={provider.credentialsHelpUrl}
													target="_blank"
													rel="noreferrer"
													onClick={(event) => event.stopPropagation()}
													className="ml-auto inline-flex items-center gap-1 font-normal text-primary underline-offset-4 hover:underline"
												>
													Open guide
													<ExternalLink className="size-3" />
												</a>
											)}
										</summary>
										<p className="mt-2 pl-5.5 leading-relaxed">
											{provider.credentialsHelp}
										</p>
									</details>

									{isEdit && nameField}

									{provider.credentialFields.map((credentialField) => (
										<FormField
											key={`${provider.type}-${credentialField.name}`}
											control={form.control}
											name={`credentials.${credentialField.name}`}
											render={({ field }) => (
												<FormItem>
													<FormLabel>{credentialField.label}</FormLabel>
													<CredentialInput
														credentialField={credentialField}
														value={field.value}
														onChange={field.onChange}
														hint={
															account?.credentialHints[credentialField.name]
														}
														isEdit={isEdit}
														field={field}
													/>
													{credentialField.description && (
														<FormDescription>
															{credentialField.description}
														</FormDescription>
													)}
													<FormMessage />
												</FormItem>
											)}
										/>
									))}

									{verifyError && (
										<AlertBlock type="error">{verifyError}</AlertBlock>
									)}
								</>
							)}

							{step === "name" && (
								<>
									<div className="flex items-center gap-2 rounded-lg border border-green-600/30 bg-green-600/10 px-3 py-2.5 text-sm text-green-700 dark:text-green-400">
										<CheckCircle2 className="size-4 shrink-0" />
										Dokploy can create and remove servers with these
										credentials.
									</div>
									{nameField}
								</>
							)}

							<DialogFooter className="flex w-full flex-row justify-between gap-2 sm:justify-between">
								{isEdit ? (
									<Button
										type="button"
										variant="secondary"
										isLoading={isTesting}
										onClick={onTestConnection}
									>
										Test Connection
									</Button>
								) : (
									<span />
								)}
								<Button
									type="submit"
									isLoading={
										step === "credentials" && !isEdit
											? isTesting
											: mutation.isPending
									}
								>
									{isEdit
										? "Update"
										: step === "credentials"
											? "Verify and continue"
											: "Connect"}
								</Button>
							</DialogFooter>
						</form>
					</Form>
				)}
			</DialogContent>
		</Dialog>
	);
};
