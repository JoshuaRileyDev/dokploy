import type { GetServerSidePropsContext } from "next";
import { useRouter } from "next/router";
import type { ReactElement } from "react";
import { ShowWorkflowRun } from "@/components/dashboard/workflows/show-workflow-run";
import { DashboardLayout } from "@/components/layouts/dashboard-layout";
import { getWorkflowPageProps } from "@/server/utils/workflow-page";

const WorkflowRunPage = () => {
	const { query } = useRouter();
	return <ShowWorkflowRun workflowRunId={query.workflowRunId as string} />;
};

export default WorkflowRunPage;

WorkflowRunPage.getLayout = (page: ReactElement) => (
	<DashboardLayout>{page}</DashboardLayout>
);

export const getServerSideProps = (ctx: GetServerSidePropsContext) =>
	getWorkflowPageProps(ctx);
