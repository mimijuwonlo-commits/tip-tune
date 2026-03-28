import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { PlayCountService, MINIMUM_LISTEN_SECONDS } from "./play-count.service";
import { TrackPlay, PlaySource } from "./track-play.entity";
import { Track } from "../tracks/entities/track.entity";

describe("PlayCountService", () => {
  let service: PlayCountService;
  let trackPlayRepo: jest.Mocked<any>;
  let trackRepo: jest.Mocked<any>;
  let dataSource: jest.Mocked<any>;
  let eventEmitter: jest.Mocked<any>;

  beforeEach(async () => {
    trackPlayRepo = {
      create: jest.fn((value) => ({ id: "play-1", ...value })),
      save: jest.fn(),
      findOne: jest.fn(),
      count: jest.fn(),
      createQueryBuilder: jest.fn(),
    };

    trackRepo = {
      findOne: jest.fn(),
      update: jest.fn(),
      findOneOrFail: jest.fn(),
    };

    dataSource = {
      transaction: jest.fn(),
      createQueryBuilder: jest.fn(),
    };

    eventEmitter = {
      emit: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PlayCountService,
        { provide: getRepositoryToken(TrackPlay), useValue: trackPlayRepo },
        { provide: getRepositoryToken(Track), useValue: trackRepo },
        { provide: DataSource, useValue: dataSource },
        { provide: EventEmitter2, useValue: eventEmitter },
      ],
    }).compile();

    service = module.get(PlayCountService);
  });

  it("skips low-duration events but still stores the raw play event", async () => {
    trackPlayRepo.save.mockResolvedValue(undefined);

    const result = await service.recordPlay(
      {
        trackId: "track-1",
        userId: "user-1",
        sessionId: "session-1",
        listenDuration: MINIMUM_LISTEN_SECONDS - 1,
        completedFull: false,
        source: PlaySource.DIRECT,
      },
      "127.0.0.1",
    );

    expect(result.counted).toBe(false);
    expect(trackPlayRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ countedAsPlay: false }),
    );
    expect(dataSource.transaction).not.toHaveBeenCalled();
  });

  it("counts a qualifying play, updates track totals, and emits a play event", async () => {
    trackPlayRepo.findOne.mockResolvedValue(null);
    dataSource.transaction.mockImplementation(async (callback) =>
      callback({
        save: jest.fn(),
        createQueryBuilder: jest.fn(() => ({
          update: jest.fn().mockReturnThis(),
          set: jest.fn().mockReturnThis(),
          where: jest.fn().mockReturnThis(),
          returning: jest.fn().mockReturnThis(),
          execute: jest.fn().mockResolvedValue({
            raw: [{ artistId: "artist-1" }],
          }),
        })),
      }),
    );

    const result = await service.recordPlay(
      {
        trackId: "track-1",
        userId: "user-1",
        sessionId: "session-1",
        listenDuration: 60,
        completedFull: true,
        source: PlaySource.SEARCH,
      },
      "127.0.0.1",
    );

    expect(result.counted).toBe(true);
    expect(dataSource.transaction).toHaveBeenCalled();
    expect(eventEmitter.emit).toHaveBeenCalledWith(
      "track.played",
      expect.objectContaining({
        trackId: "track-1",
        artistId: "artist-1",
        listenerId: "user-1",
      }),
    );
  });

  it("rebuilds track.plays from counted play events", async () => {
    trackRepo.findOne.mockResolvedValue({ id: "track-1", plays: 2 });
    trackPlayRepo.count.mockResolvedValue(7);
    trackRepo.update.mockResolvedValue(undefined);
    trackRepo.findOneOrFail.mockResolvedValue({ id: "track-1", plays: 7 });

    const track = await service.rebuildTrackPlayTotal("track-1");

    expect(trackPlayRepo.count).toHaveBeenCalledWith({
      where: { trackId: "track-1", countedAsPlay: true },
    });
    expect(trackRepo.update).toHaveBeenCalledWith(
      "track-1",
      expect.objectContaining({ plays: 7 }),
    );
    expect(track).toEqual({ id: "track-1", plays: 7 });
  });
});
