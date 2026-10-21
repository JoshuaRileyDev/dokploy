import type { GetServerSidePropsContext } from "next";
import { useRouter } from "next/router";
import type { ReactElement } from "react";
import { ShowWorkflowRepository } from "@/components/dashboard/workflows/show-workflow-repository";
import { DashboardLayout } from "@/components/layouts/dashboard-layout";
import { getWorkflowPageProps } from "@/server/utils/workflow-page";

const WorkflowRepositoryPage = () => {
	const { query } = useRouter();
	return (
		<ShowWorkflowRepository
			workflowRepositoryId={query.workflowRepositoryId as string}
		/>
	);
};

export default WorkflowRepositoryPage;

WorkflowRepositoryPage.getLayout = (page: ReactElement) => (
	<DashboardLayout>{page}</DashboardLayout>
);

export const getServerSideProps = (ctx: GetServerSidePropsContext) =>
	getWorkflowPageProps(ctx);
