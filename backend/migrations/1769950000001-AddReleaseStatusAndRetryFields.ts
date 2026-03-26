import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

export class AddReleaseStatusAndRetryFields1769950000001 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // Add status column
    await queryRunner.addColumn(
      'scheduled_releases',
      new TableColumn({
        name: 'status',
        type: 'enum',
        enum: ['pending', 'publishing', 'published', 'failed_permanently'],
        default: "'pending'",
      }),
    );

    // Add retry_count column
    await queryRunner.addColumn(
      'scheduled_releases',
      new TableColumn({
        name: 'retry_count',
        type: 'integer',
        default: 0,
      }),
    );

    // Add last_error column
    await queryRunner.addColumn(
      'scheduled_releases',
      new TableColumn({
        name: 'last_error',
        type: 'text',
        isNullable: true,
      }),
    );

    // Add last_attempt_at column
    await queryRunner.addColumn(
      'scheduled_releases',
      new TableColumn({
        name: 'last_attempt_at',
        type: 'timestamp',
        isNullable: true,
      }),
    );

    // Add next_retry_at column
    await queryRunner.addColumn(
      'scheduled_releases',
      new TableColumn({
        name: 'next_retry_at',
        type: 'timestamp',
        isNullable: true,
      }),
    );

    // Add published_at column
    await queryRunner.addColumn(
      'scheduled_releases',
      new TableColumn({
        name: 'published_at',
        type: 'timestamp',
        isNullable: true,
      }),
    );

    // Add failed_at column
    await queryRunner.addColumn(
      'scheduled_releases',
      new TableColumn({
        name: 'failed_at',
        type: 'timestamp',
        isNullable: true,
      }),
    );

    // Add updated_at column
    await queryRunner.addColumn(
      'scheduled_releases',
      new TableColumn({
        name: 'updated_at',
        type: 'timestamp',
        default: 'CURRENT_TIMESTAMP',
      }),
    );

    // Create index on status and retry_count
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_scheduled_releases_status_retry" 
      ON scheduled_releases (status, retry_count)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Drop index
    await queryRunner.query(`
      DROP INDEX IF EXISTS "IDX_scheduled_releases_status_retry"
    `);

    // Drop columns in reverse order
    await queryRunner.dropColumn('scheduled_releases', 'updated_at');
    await queryRunner.dropColumn('scheduled_releases', 'failed_at');
    await queryRunner.dropColumn('scheduled_releases', 'published_at');
    await queryRunner.dropColumn('scheduled_releases', 'next_retry_at');
    await queryRunner.dropColumn('scheduled_releases', 'last_attempt_at');
    await queryRunner.dropColumn('scheduled_releases', 'last_error');
    await queryRunner.dropColumn('scheduled_releases', 'retry_count');
    await queryRunner.dropColumn('scheduled_releases', 'status');
  }
}
