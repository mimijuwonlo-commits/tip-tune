import { Test } from "@nestjs/testing";
import { TypeOrmModule } from "@nestjs/typeorm";
import { ScheduledReleasesService } from "../src/scheduled-releases/scheduled-releases.service";
import { ScheduledRelease } from "../src/scheduled-releases/entities/scheduled-release.entity";
import { Track } from "../src/tracks/entities/track.entity";
import { DeadLetter } from "../src/queue/entities/dead-letter.entity";
import { DlqService } from "../src/queue/dlq.service";
import { Repository } from "typeorm";
import { getRepositoryToken } from "@nestjs/typeorm";

describe("Scheduled Releases -> DLQ (integration)", () => {
  let service: ScheduledReleasesService;
  let dlqRepo: Repository<DeadLetter>;
  let releaseRepo: Repository<ScheduledRelease>;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot({
          type: "sqlite",
          database: ":memory:",
          entities: [ScheduledRelease, Track, DeadLetter],
          synchronize: true,
        }),
        TypeOrmModule.forFeature([ScheduledRelease, Track, DeadLetter]),
      ],
      providers: [ScheduledReleasesService, DlqService],
    }).compile();

    service = moduleRef.get(ScheduledReleasesService);
    dlqRepo = moduleRef.get<Repository<DeadLetter>>(
      getRepositoryToken(DeadLetter),
    );
    releaseRepo = moduleRef.get<Repository<ScheduledRelease>>(
      getRepositoryToken(ScheduledRelease),
    );
  });

  it("moves exhausted scheduled release to DLQ with recovery metadata", async () => {
    // create a scheduled release that is due and already at retry threshold
    const release = releaseRepo.create({
      trackId: "missing-track",
      releaseDate: new Date(Date.now() - 1000),
      isReleased: false,
      status: "pending",
      retryCount: 3, // equals maxRetries in service
    } as any);

    const saved = await releaseRepo.save(release);

    // Run the cron handler which should pick up the release and move to DLQ
    await service.handleScheduledReleases();

    // Ensure DLQ entry created
    const entries = await dlqRepo.find({
      where: { jobType: "scheduled_release" },
    });
    expect(entries.length).toBeGreaterThanOrEqual(1);

    const entry = entries.find((e) => e.jobId === saved.id);
    expect(entry).toBeDefined();
    expect(entry.recoveryMetadata).toBeDefined();
    expect(entry.recoveryMetadata.statusBefore).toBe("pending");
  });
});
