import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { PlayCountService } from "./play-count.service";
import { TrackPlay } from "./track-play.entity";
import { Track } from "../tracks/entities/track.entity";

describe("PlayCountService deduplication", () => {
  let service: PlayCountService;
  let trackPlayRepo: jest.Mocked<any>;

  beforeEach(async () => {
    trackPlayRepo = {
      create: jest.fn(),
      save: jest.fn(),
      findOne: jest.fn(),
      count: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PlayCountService,
        { provide: getRepositoryToken(TrackPlay), useValue: trackPlayRepo },
        {
          provide: getRepositoryToken(Track),
          useValue: {
            findOne: jest.fn(),
            update: jest.fn(),
            findOneOrFail: jest.fn(),
          },
        },
        { provide: DataSource, useValue: { transaction: jest.fn() } },
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
      ],
    }).compile();

    service = module.get(PlayCountService);
  });

  it("deduplicates by user id first", async () => {
    trackPlayRepo.findOne.mockResolvedValueOnce({ id: "play-1" });

    await expect(
      service.isDuplicate("track-1", "user-1", "session-1", "hash-1"),
    ).resolves.toBe(true);
  });

  it("falls back to session and ip hash for anonymous plays", async () => {
    trackPlayRepo.findOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: "play-2" });

    await expect(
      service.isDuplicate("track-1", null, "session-2", "hash-2"),
    ).resolves.toBe(true);
    expect(trackPlayRepo.findOne).toHaveBeenCalledTimes(2);
  });
});
