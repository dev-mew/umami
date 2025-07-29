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

async function fixMissingRegionColumn() {
  try {
    console.log('🔄 Checking for missing region column...');

    // Check if region column exists in session table
    const regionExists = await prisma.$queryRaw`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'session' 
        AND column_name = 'region'
      ) as exists
    `;

    const regionCol = regionExists[0]?.exists;
    console.log(`   Region column exists: ${regionCol}`);

    if (!regionCol) {
      console.log('   Adding region column to session table...');
      await prisma.$executeRaw`
        ALTER TABLE "session" 
        ADD COLUMN "region" VARCHAR(20)
      `;
      success('Region column added successfully!');
    } else {
      console.log('   ✅ Region column already exists, skipping...');
    }

    return true;
  } catch (error) {
    console.error('❌ Error adding region column:', error.message);

    // If column already exists, that's fine
    if (error.message.includes('already exists') || error.message.includes('duplicate column')) {
      success('Region column already exists');
      return true;
    }

    // For other errors, log but don't fail the deployment
    console.log('   ⚠️  Could not add region column, but continuing...');
    return false;
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
    fixMissingRegionColumn,
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
