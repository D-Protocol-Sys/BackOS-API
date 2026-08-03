import * as dotenv from 'dotenv';
import * as path from 'path';

// Chargé AVANT que Nest ne bootstrap quoi que ce soit, pour garantir que
// process.env.DATABASE_URL pointe sur la DB de test dès la construction
// de PrismaService (qui lit process.env directement dans son constructeur).
dotenv.config({ path: path.resolve(__dirname, '../.env.test') });