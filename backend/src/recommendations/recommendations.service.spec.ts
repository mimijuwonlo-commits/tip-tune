import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import { RecommendationsService } from "./recommendations.service";
import { RecommendationFeedback } from "./entities/recommendation-feedback.entity";

describe("RecommendationsService", () => {
  let service: RecommendationsService;
  let feedbackRepo: jest.Mocked<any>;
  let dataSource: jest.Mocked<any>;

  beforeEach(async () => {
    feedbackRepo = {
      findOne: jest.fn(),
      create: jest.fn((value) => value),
      save: jest.fn(),
    };

    dataSource = {
      query: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RecommendationsService,
        {
          provide: getRepositoryToken(RecommendationFeedback),
          useValue: feedbackRepo,
        },
        { provide: DataSource, useValue: dataSource },
      ],
    }).compile();

    service = module.get(RecommendationsService);
  });

  it("uses popularity fallback for cold-start users", async () => {
    dataSource.query
      .mockResolvedValueOnce([{ count: 1 }])
      .mockResolvedValueOnce([
        {
          id: "track-1",
          title: "Popular Track",
          audioUrl: "audio",
          coverArtUrl: "cover",
          genre: "Afrobeats",
          artistId: "artist-1",
          artistName: "Artist One",
          score: 9,
        },
      ]);

    const result = await service.getTrackRecommendations("user-1", 5);

    expect(result).toEqual([
      expect.objectContaining({ id: "track-1", source: "popular" }),
    ]);
  });

  it("merges collaborative and content-based recommendations for users with history", async () => {
    dataSource.query
      .mockResolvedValueOnce([{ count: 5 }])
      .mockResolvedValueOnce([
        {
          id: "track-1",
          title: "Collaborative Pick",
          audioUrl: "audio",
          coverArtUrl: "cover",
          genre: "Afrobeats",
          artistId: "artist-1",
          artistName: "Artist One",
          score: 12,
        },
      ])
      .mockResolvedValueOnce([
        {
          id: "track-2",
          title: "Content Pick",
          audioUrl: "audio",
          coverArtUrl: "cover",
          genre: "Afrobeats",
          artistId: "artist-2",
          artistName: "Artist Two",
          score: 7,
        },
      ]);

    const result = await service.getTrackRecommendations("user-1", 5);

    expect(result.map((track) => track.id)).toEqual(["track-1", "track-2"]);
  });

  it("updates existing feedback instead of creating duplicates", async () => {
    feedbackRepo.findOne.mockResolvedValue({
      id: "feedback-1",
      userId: "user-1",
      trackId: "track-1",
      feedback: "up",
    });
    feedbackRepo.save.mockImplementation(async (value) => value);

    const result = await service.recordFeedback("user-1", "track-1", "down");

    expect(result.feedback).toBe("down");
    expect(feedbackRepo.create).not.toHaveBeenCalled();
  });
});
