import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

export class AddEventStatusAndLifecycleFields1769950000002 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // Add status column
    await queryRunner.addColumn(
      'artist_events',
      new TableColumn({
        name: 'status',
        type: 'enum',
        enum: ['upcoming', 'live', 'ended', 'cancelled'],
        default: "'upcoming'",
      }),
    );

    // Add went_live_at column
    await queryRunner.addColumn(
      'artist_events',
      new TableColumn({
        name: 'went_live_at',
        type: 'timestamptz',
        isNullable: true,
      }),
    );

    // Add ended_at column
    await queryRunner.addColumn(
      'artist_events',
      new TableColumn({
        name: 'ended_at',
        type: 'timestamptz',
        isNullable: true,
      }),
    );

    // Create index on status and start_time
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_artist_events_status_start" 
      ON artist_events (status, start_time)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Drop index
    await queryRunner.query(`
      DROP INDEX IF EXISTS "IDX_artist_events_status_start"
    `);

    // Drop columns in reverse order
    await queryRunner.dropColumn('artist_events', 'ended_at');
    await queryRunner.dropColumn('artist_events', 'went_live_at');
    await queryRunner.dropColumn('artist_events', 'status');
  }
}
