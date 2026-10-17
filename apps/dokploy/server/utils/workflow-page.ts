import { IS_CLOUD } from "@dokploy/server/constants";
import { validateRequest } from "@dokploy/server/lib/auth";
import { createServerSideHelpers } from "@trpc/react-query/server";
import type { GetServerSidePropsContext } from "next";
import superjson from "superjson";
import { appRouter } from "@/server/api/root";

const redirectHome = {
	redirect: { permanent: false, destination: "/" },
} as const;

export const getWorkflowPageProps = async (ctx: GetServerSidePropsContext) => {
	if (IS_CLOUD) return redirectHome;

	const { user, session } = await validateRequest(ctx.req);
	if (!user) return redirectHome;

	const helpers = createServerSideHelpers({
		router: appRouter,
		ctx: {
			req: ctx.req as any,
			res: ctx.res as any,
			db: null as any,
			session: session as any,
			user: user as any,
		},
		transformer: superjson,
	});

	try {
		const permissions = await helpers.user.getPermissions.fetch();
		if (!permissions?.workflow.read) return redirectHome;
		return { props: { trpcState: helpers.dehydrate() } };
	} catch {
		return redirectHome;
	}
};
