import { dbUrl } from "@dokploy/server/db";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

const sql = postgres(dbUrl, { max: 1 });
const db = drizzle(sql);

await migrate(db, { migrationsFolder: "drizzle" })
	// Fork-only migrations are tracked separately so upstream's journal stays untouched.
	.then(() =>
		migrate(db, {
			migrationsFolder: "drizzle-fork",
			migrationsTable: "__drizzle_fork_migrations",
		}),
	)
	.then(() => {
		console.log("Migration complete");
		sql.end();
	})
	.catch((error) => {
		console.log("Migration failed", error);
	})
	.finally(() => {
		sql.end();
	});
