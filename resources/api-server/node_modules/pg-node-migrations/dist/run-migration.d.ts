import { Logger, Migration, BasicPgClient } from "./types";
export declare const runMigration: (migrationTableName: string | undefined, migrationSchemaName: string | undefined, client: BasicPgClient, log?: Logger) => (migration: Migration) => Promise<Migration>;
