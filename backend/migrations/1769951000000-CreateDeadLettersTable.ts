import { MigrationInterface, QueryRunner, Table } from "typeorm";

export class CreateDeadLettersTable1769951000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: "dead_letters",
        columns: [
          {
            name: "id",
            type: "uuid",
            isPrimary: true,
            generationStrategy: "uuid",
            isGenerated: true,
          },
          { name: "jobType", type: "varchar" },
          { name: "jobId", type: "varchar", isNullable: true },
          { name: "payload", type: "jsonb", isNullable: true },
          { name: "lastError", type: "text", isNullable: true },
          { name: "retryCount", type: "integer", default: "0" },
          { name: "recoveryMetadata", type: "jsonb", isNullable: true },
          {
            name: "exhaustedAt",
            type: "timestamp",
            default: "CURRENT_TIMESTAMP",
          },
        ],
      }),
      true,
    );

    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS IDX_dead_letters_job_type ON dead_letters ("jobType")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS IDX_dead_letters_exhausted_at ON dead_letters ("exhaustedAt")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable("dead_letters");
  }
}
