import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { ForbiddenException } from "@nestjs/common";
import { EmbedService } from "./embed.service";
import { EmbedView } from "./entities/embed-view.entity";
import { Track } from "../tracks/entities/track.entity";

describe("EmbedService", () => {
  let service: EmbedService;
  let embedRepo: jest.Mocked<any>;
  let trackRepo: jest.Mocked<any>;

  beforeEach(async () => {
    embedRepo = {
      create: jest.fn((value) => value),
      save: jest.fn(),
      count: jest.fn(),
      createQueryBuilder: jest.fn(() => ({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        select: jest.fn().mockReturnThis(),
        groupBy: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        getRawMany: jest.fn().mockResolvedValue([]),
      })),
    };

    trackRepo = {
      findOne: jest.fn().mockResolvedValue({
        id: "track-1",
        title: "Track One",
        artistId: "artist-1",
        isPublic: true,
        duration: 120,
        audioUrl: "https://cdn.test/audio.mp3",
        streamingUrl: "https://cdn.test/stream.m3u8",
        coverArtUrl: "https://cdn.test/cover.jpg",
        genre: "Afrobeats",
        mimeType: "audio/mpeg",
        artist: { artistName: "Artist One" },
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EmbedService,
        { provide: getRepositoryToken(EmbedView), useValue: embedRepo },
        { provide: getRepositoryToken(Track), useValue: trackRepo },
      ],
    }).compile();

    service = module.get(EmbedService);
  });

  it("generates verifiable time-bound embed tokens", () => {
    const token = service.generateEmbedToken("track-1", 60);
    expect(service.validateEmbedToken("track-1", token)).toBe(true);
    expect(service.validateEmbedToken("track-2", token)).toBe(false);
  });

  it("returns schema-aligned player data for valid tokens", async () => {
    const token = service.generateEmbedToken("track-1", 60);

    await expect(service.getPlayerData("track-1", token)).resolves.toEqual(
      expect.objectContaining({
        trackId: "track-1",
        coverArtUrl: "https://cdn.test/cover.jpg",
        artist: "Artist One",
      }),
    );
  });

  it("rejects invalid tokens", async () => {
    await expect(
      service.getPlayerData("track-1", "bad-token"),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("records views using the database-backed rate limiter", async () => {
    embedRepo.count.mockResolvedValue(0);
    embedRepo.save.mockResolvedValue(undefined);

    await service.recordView(
      "track-1",
      "https://blog.example/posts/1",
      "https://blog.example",
    );

    expect(embedRepo.count).toHaveBeenCalled();
    expect(embedRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        trackId: "track-1",
        referrerDomain: "blog.example",
      }),
    );
  });
});
