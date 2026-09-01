import * as path from 'path';
import * as dotenv from 'dotenv';

// Runs once per test FILE (Jest `setupFiles`), before any imports in the spec files that
// depend on process.env being populated (env.validation.ts, ConfigModule, PrismaClient's
// datasource URL, ...). Deliberately loads `.env.test`, never `.env`/`.env.production` - an e2e
// run must never be able to touch dev or prod data even if someone forgets to start the test
// Postgres/Redis containers and DATABASE_URL falls back to something else.
dotenv.config({ path: path.resolve(__dirname, '..', '.env.test') });
