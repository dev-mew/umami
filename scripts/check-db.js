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

async function fixMigrationState() {
  try {
    console.log('🔄 Starting migration state fix...');

    // Step 1: Check for confused migration records
    console.log('1️⃣ Checking migration state...');
    const existingMigrations = await prisma.$queryRaw`
      SELECT * FROM _prisma_migrations 
      WHERE migration_name = '09_update_hostname_region'
      ORDER BY started_at DESC
    `;

    console.log(`   Found ${existingMigrations.length} existing migration records`);

    // Step 2: Check if hostname column exists
    console.log('2️⃣ Checking if hostname column exists...');
    const columnExists = await prisma.$queryRaw`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'website_event' 
        AND column_name = 'hostname'
      ) as exists
    `;

    const exists = columnExists[0]?.exists;
    console.log(`   Column exists: ${exists}`);

    // Step 3: Determine if we need to fix anything
    const hasValidMigration = existingMigrations.some(
      m => m.finished_at && m.applied_steps_count > 0 && !m.rolled_back_at,
    );

    if (exists && hasValidMigration) {
      console.log('✅ Migration state is already correct, skipping fix');
      return true;
    }

    // Step 4: Clear confused migration records
    if (existingMigrations.length > 0) {
      console.log('3️⃣ Clearing confused migration records...');
      await prisma.$executeRaw`
        DELETE FROM _prisma_migrations 
        WHERE migration_name = '09_update_hostname_region'
      `;
      console.log('   ✓ Cleared migration records');
    }

    // Step 5: Add column if it doesn't exist
    if (!exists) {
      console.log('4️⃣ Adding hostname column...');
      await prisma.$executeRaw`
        ALTER TABLE "website_event" 
        ADD COLUMN "hostname" VARCHAR(100)
      `;
      console.log('   ✓ Hostname column added successfully');
    } else {
      console.log('4️⃣ Hostname column already exists, skipping...');
    }

    // Step 6: Mark migration as properly applied
    console.log('5️⃣ Marking migration as applied...');
    await prisma.$executeRaw`
      INSERT INTO _prisma_migrations (
        id, 
        checksum, 
        finished_at, 
        migration_name, 
        logs, 
        rolled_back_at, 
        started_at, 
        applied_steps_count
      ) VALUES (
        gen_random_uuid(),
        'e94d9993b17ac5c330ae3f872fd5869fb8095a3f3a7d31d2aaade73dc45fbe9c',
        NOW(),
        '09_update_hostname_region',
        '',
        NULL,
        NOW(),
        1
      )
    `;
    console.log('   ✓ Migration marked as successfully applied');

    success('Migration state fix completed successfully!');
    return true;
  } catch (error) {
    console.error('❌ Error during migration fix:', error.message);

    // If we get a "column already exists" error, that's actually good
    if (error.message.includes('already exists') || error.message.includes('duplicate column')) {
      console.log('   ℹ️  Column already exists, attempting to mark migration as applied...');
      try {
        // Clear any existing records first
        await prisma.$executeRaw`
          DELETE FROM _prisma_migrations 
          WHERE migration_name = '09_update_hostname_region'
        `;

        // Mark as applied
        await prisma.$executeRaw`
          INSERT INTO _prisma_migrations (
            id, checksum, finished_at, migration_name, logs, 
            rolled_back_at, started_at, applied_steps_count
          ) VALUES (
            gen_random_uuid(),
            'e94d9993b17ac5c330ae3f872fd5869fb8095a3f3a7d31d2aaade73dc45fbe9c',
            NOW(), '09_update_hostname_region', '', NULL, NOW(), 1
          )
        `;
        success('Migration marked as applied despite existing column');
        return true;
      } catch (secondError) {
        error('Failed to mark migration as applied: ' + secondError.message);
        // Don't throw - let the normal migration process handle it
        return false;
      }
    }

    // For other errors, log but don't fail the entire process
    console.log('   ⚠️  Migration fix failed, but continuing with normal migration process...');
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
