import { ExternalLink, PenBoxIcon, PlusIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { CloudProviderIcon } from "@/components/icons/cloud-provider-icons";
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
import { api, type RouterInputs } from "@/utils/api";

type ProviderType = RouterInputs["cloudProvider"]["create"]["providerType"];

const NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;

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

export const HandleCloudProvider = ({
	cloudProviderAccountId,
	providerType: fixedProviderType,
	onConnected,
	children,
}: Props) => {
	const utils = api.useUtils();
	const [isOpen, setIsOpen] = useState(false);
	const isEdit = !!cloudProviderAccountId;

	const { data: providers } = api.cloudProvider.providers.useQuery(undefined, {
		enabled: isOpen,
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

	useEffect(() => {
		if (!isOpen) return;
		create.reset();
		update.reset();
		form.reset({
			name: account?.name ?? "",
			providerType:
				account?.providerType ??
				fixedProviderType ??
				providers?.[0]?.type ??
				"",
			credentials: {},
		});
	}, [
		account,
		providers,
		fixedProviderType,
		isOpen,
		form,
		create.reset,
		update.reset,
	]);

	// Untouched inputs are undefined; send every field so blanks mean "keep".
	const credentialsOf = (values: FormValues) =>
		Object.fromEntries(
			(provider?.credentialFields ?? []).map((field) => [
				field.name,
				values.credentials[field.name] ?? "",
			]),
		);

	const validate = (values: FormValues) => {
		let valid = true;
		if (!values.name.trim()) {
			form.setError("name", { message: "Name is required" });
			valid = false;
		} else if (!NAME_PATTERN.test(values.name)) {
			form.setError("name", {
				message: "Only letters, numbers, dashes and underscores",
			});
			valid = false;
		}
		// When editing, a blank field keeps the stored value.
		if (!isEdit) {
			for (const field of provider?.credentialFields ?? []) {
				if (!values.credentials[field.name]?.trim()) {
					form.setError(`credentials.${field.name}`, {
						message: `${field.label} is required`,
					});
					valid = false;
				}
			}
		}
		return valid;
	};

	const onSubmit = async (values: FormValues) => {
		if (!validate(values)) return;
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

	const onTestConnection = async () => {
		const values = form.getValues();
		await testConnection({
			providerType: values.providerType as ProviderType,
			credentials: credentialsOf(values),
			...(isEdit && { cloudProviderAccountId }),
		})
			.then(() => toast.success(`Connected to ${provider?.label}`))
			.catch((err) =>
				toast.error("Connection failed", { description: err.message }),
			);
	};

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
			<DialogContent className="max-h-screen overflow-y-auto sm:max-w-lg">
				<DialogHeader>
					<div className="flex items-center gap-3">
						<CloudProviderIcon
							providerType={providerType}
							className="size-9 shrink-0"
						/>
						<div className="flex flex-col gap-1">
							<DialogTitle>
								{isEdit
									? "Update Cloud Provider"
									: `Connect ${provider?.label ?? "a cloud provider"}`}
							</DialogTitle>
							<DialogDescription>
								Dokploy uses these credentials to create servers in your account
								and remove them when you ask it to.
							</DialogDescription>
						</div>
					</div>
				</DialogHeader>
				{mutation.isError && (
					<AlertBlock type="error">{mutation.error?.message}</AlertBlock>
				)}
				<Form {...form}>
					<form
						onSubmit={form.handleSubmit(onSubmit)}
						className="grid w-full gap-4"
					>
						<FormField
							control={form.control}
							name="providerType"
							render={({ field }) => (
								<FormItem>
									<FormLabel>Provider</FormLabel>
									<Select
										value={field.value}
										onValueChange={(value) => {
											field.onChange(value);
											form.setValue("credentials", {});
										}}
										disabled={isEdit || !!fixedProviderType}
									>
										<FormControl>
											<SelectTrigger>
												<SelectValue placeholder="Select a provider" />
											</SelectTrigger>
										</FormControl>
										<SelectContent>
											{providers?.map((p) => (
												<SelectItem key={p.type} value={p.type}>
													<div className="flex flex-row items-center gap-2">
														<CloudProviderIcon
															providerType={p.type}
															className="size-4 shrink-0"
														/>
														{p.label}
													</div>
												</SelectItem>
											))}
										</SelectContent>
									</Select>
									{provider && (
										<FormDescription>{provider.description}</FormDescription>
									)}
								</FormItem>
							)}
						/>
						<FormField
							control={form.control}
							name="name"
							render={({ field }) => (
								<FormItem>
									<FormLabel>Name</FormLabel>
									<FormControl>
										<Input placeholder="production" {...field} />
									</FormControl>
									<FormDescription>
										Usually the name of the project or team the credentials
										belong to.
									</FormDescription>
									<FormMessage />
								</FormItem>
							)}
						/>
						{provider?.credentialFields.map((credentialField, index) => {
							const hint = account?.credentialHints[credentialField.name];
							const isLast = index === provider.credentialFields.length - 1;
							return (
								<FormField
									key={`${provider.type}-${credentialField.name}`}
									control={form.control}
									name={`credentials.${credentialField.name}`}
									render={({ field }) => (
										<FormItem>
											<FormLabel>{credentialField.label}</FormLabel>
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
													value={field.value ?? ""}
												/>
											</FormControl>
											{(credentialField.description || isLast) && (
												<FormDescription>
													{credentialField.description}
													{isLast && (
														<>
															{credentialField.description && " "}
															{provider.credentialsHelp}{" "}
															{provider.credentialsHelpUrl && (
																<a
																	href={provider.credentialsHelpUrl}
																	target="_blank"
																	rel="noreferrer"
																	className="inline-flex items-center gap-1 text-primary underline-offset-4 hover:underline"
																>
																	Docs
																	<ExternalLink className="size-3" />
																</a>
															)}
															{isEdit &&
																" Leave blank to keep the saved value."}
														</>
													)}
												</FormDescription>
											)}
											<FormMessage />
										</FormItem>
									)}
								/>
							);
						})}
						<DialogFooter className="flex w-full flex-row justify-between gap-2 sm:justify-between">
							<Button
								type="button"
								variant="secondary"
								isLoading={isTesting}
								disabled={!provider}
								onClick={onTestConnection}
							>
								Test Connection
							</Button>
							<Button
								type="submit"
								isLoading={mutation.isPending}
								disabled={!provider}
							>
								{isEdit ? "Update" : "Connect"}
							</Button>
						</DialogFooter>
					</form>
				</Form>
			</DialogContent>
		</Dialog>
	);
};
