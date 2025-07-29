/* eslint-disable no-console */
require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const chalk = require('chalk');
const { execSync } = require('child_process');
const semver = require('semver');

if (process.env.SKIP_DB_CHECK) {
  console.log('Skipping database check.');
  process.exit(0);
}

function getDatabaseType(url = process.env.DATABASE_URL) {
  const type = url && url.split(':')[0];

  if (type === 'postgres') {
    return 'postgresql';
  }

  return type;
}

const prisma = new PrismaClient();

function success(msg) {
  console.log(chalk.greenBright(`✓ ${msg}`));
}

function error(msg) {
  console.log(chalk.redBright(`✗ ${msg}`));
}

async function checkEnv() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is not defined.');
  } else {
    success('DATABASE_URL is defined.');
  }
}

async function checkConnection() {
  try {
    await prisma.$connect();

    success('Database connection successful.');
  } catch (e) {
    throw new Error('Unable to connect to the database: ' + e.message);
  }
}

async function checkDatabaseVersion() {
  const query = await prisma.$queryRaw`select version() as version`;
  const version = semver.valid(semver.coerce(query[0].version));

  const databaseType = getDatabaseType();
  const minVersion = databaseType === 'postgresql' ? '9.4.0' : '5.7.0';

  if (semver.lt(version, minVersion)) {
    throw new Error(
      `Database version is not compatible. Please upgrade ${databaseType} version to ${minVersion} or greater`,
    );
  }

  success('Database version check successful.');
}

async function checkV1Tables() {
  try {
    // check for v1 migrations before v2 release date
    const record =
      await prisma.$queryRaw`select * from _prisma_migrations where started_at < '2023-04-17'`;

    if (record.length > 0) {
      error(
        'Umami v1 tables detected. For how to upgrade from v1 to v2 go to https://umami.is/docs/migrate-v1-v2.',
      );
      process.exit(1);
    }
  } catch (e) {
    // Ignore
  }
}

// Add this function before your migrate deploy
// async function resolveMigration() {
//   try {
//     console.log('🔧 Checking for failed migrations...');
//     execSync('npx prisma migrate resolve --applied 09_update_hostname_region', {
//       stdio: 'inherit',
//       cwd: process.cwd(),
//     });
//     console.log('✅ Migration resolved successfully');
//   } catch (error) {
//     console.log('ℹ️ Migration resolve not needed or failed, continuing...');
//     // Don't throw - let it continue to migrate deploy
//   }
// }

async function fixMigrationState() {
  try {
    // Check if column exists
    const columnExists = await prisma.$queryRaw`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'website_event' 
        AND column_name = 'hostname'
      );
    `;

    console.log('Hostname column exists:', columnExists[0].exists);

    // Check migration status
    const migration = await prisma.$queryRaw`
      SELECT * FROM _prisma_migrations 
      WHERE migration_name = '09_update_hostname_region';
    `;

    console.log('Migration status:', migration);

    if (columnExists[0].exists && migration.length === 0) {
      console.log('Column exists but migration not recorded. This is the issue!');
      // You could manually insert the migration record here if needed
    }
  } catch (error) {
    console.error('Error:', error);
  } finally {
    await prisma.$disconnect();
  }
}

async function applyMigration() {
  if (!process.env.SKIP_DB_MIGRATION) {
    console.log(execSync('prisma migrate deploy').toString());

    success('Database is up to date.');
  }
}

(async () => {
  let err = false;
  for (let fn of [
    checkEnv,
    checkConnection,
    checkDatabaseVersion,
    checkV1Tables,
    // resolveMigration,
    fixMigrationState,
    applyMigration,
  ]) {
    try {
      await fn();
    } catch (e) {
      error(e.message);
      err = true;
    } finally {
      await prisma.$disconnect();
      if (err) {
        process.exit(1);
      }
    }
  }
})();
