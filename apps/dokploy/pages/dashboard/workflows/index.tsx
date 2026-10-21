import type { GetServerSidePropsContext } from "next";
import type { ReactElement } from "react";
import { ShowWorkflows } from "@/components/dashboard/workflows/show-workflows";
import { DashboardLayout } from "@/components/layouts/dashboard-layout";
import { getWorkflowPageProps } from "@/server/utils/workflow-page";

const WorkflowsPage = () => <ShowWorkflows />;

export default WorkflowsPage;

WorkflowsPage.getLayout = (page: ReactElement) => (
	<DashboardLayout>{page}</DashboardLayout>
);

export const getServerSideProps = (ctx: GetServerSidePropsContext) =>
	getWorkflowPageProps(ctx);
